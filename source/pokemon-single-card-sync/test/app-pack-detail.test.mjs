import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePackCardTargets, discoverAppDetailIdentity } from '../app-pack-detail.mjs';

const CONTEXT = { language: 'en', setId: '100236', setCode: '30C', packName: '30周年庆典' };
const CARDS = [
  { cardName: '耿鬼', cardNumber: 'TRIU-94(30C)', rarity: 'Prime' },
  { cardName: '皮卡丘', cardNumber: 'BASE-58(30C)', rarity: null },
];
function builder() {
  const nodes = [];
  const add = (parentIndex, bounds, text = '', description = '', className = 'android.view.ViewGroup', extra = {}) => {
    nodes.push({ parentIndex, bounds, text, 'content-desc': description, class: className,
      package: 'com.jihuanshe.pro', selected: 'false', clickable: 'false', password: 'false', ...extra });
    return nodes.length - 1;
  };
  const text = (parent, bounds, value) => add(parent, bounds, value, '', 'android.widget.TextView');
  const button = (parent, bounds, label) => add(parent, bounds, '', label, 'android.widget.Button', { clickable: 'true' });
  return { nodes, add, text, button };
}
function packFixture({ current = false, scrolled = false } = {}) {
  const { nodes, add, text } = builder();
  const root = add(null, '[0,0][720,1280]');
  text(root, '[196,76][350,116]', CONTEXT.packName);
  if (!scrolled) {
    text(root, '[224,306][692,340]', CONTEXT.setCode);
    add(root, '[344,540][499,608]', '', '卡牌, 2');
  }
  add(root, '[32,648][108,688]', '', 'RAW', 'android.view.View', { selected: 'true' });
  add(root, '[399,640][515,696]', '', '最低价');
  CARDS.forEach((card, i) => {
    const left = 28 + i * 228;
    const right = left + 204;
    const label = current
      ? [card.cardName, ...(card.rarity ? [card.rarity] : []), card.cardNumber, 'RAW', '英文', '¥2500起']
      : [card.cardName, card.cardNumber, ...(card.rarity ? [card.rarity] : []), 'RAW', '¥2500起'];
    const row = add(root, `[${left},728][${right},1139]`, '', label.join(', '), 'android.view.ViewGroup', { clickable: 'true' });
    const image = add(row, `[${left},728][${right},1011]`);
    add(image, `[${left + 160},735][${right},779]`, '', '选择', 'android.widget.Button', { clickable: 'true' });
    text(row, `[${left},1025][${right},1061]`, card.cardName);
    text(row, `[${left},1067][${right},1095]`, card.cardNumber);
  });
  return nodes;
}
function detailFixture({ language = 'en', originalName = 'Gengar' } = {}) {
  const { nodes, add, text, button } = builder();
  const root = add(null, '[0,0][720,1280]');
  const toolbar = add(root, '[0,48][720,144]');
  button(toolbar, '[0,56][80,136]', '返回');
  const header = add(root, '[0,144][720,528]');
  add(header, '[320,170][688,228]', CARDS[0].cardName, '', 'android.widget.EditText');
  if (originalName) add(header, '[320,235][688,269]', originalName, '', 'android.widget.EditText');
  text(header, '[336,293][408,321]', '宝可梦');
  text(header, '[433,293][481,321]', { en: '英文', ja: '日文', 'zh-Hans': '简中' }[language]);
  add(header, '[336,351][486,383]', CARDS[0].cardNumber, '', 'android.widget.EditText');
  button(header, '[320,405][600,501]', `查看系列 ${CONTEXT.packName}`);
  const bar = add(root, '[0,1087][720,1232]');
  button(bar, '[32,1120][162,1216]', '出售');
  button(bar, '[186,1120][688,1216]', '立即加购');
  return nodes;
}

test('pack targets accept both observed label orders and omit all price fields', () => {
  for (const current of [false, true]) {
    const nodes = packFixture({ current });
    const before = structuredClone(nodes);
    const parsed = parsePackCardTargets(nodes, CONTEXT, CARDS);
    assert.equal(parsed.headerVerified, true);
    assert.equal(parsed.controlsBottom, 696);
    assert.deepEqual(parsed.targets.map(({ cardName, cardNumber, rarity }) => ({ cardName, cardNumber, rarity })), CARDS);
    assert.deepEqual(parsed.targets[0].tap, { x: 130, y: 869 });
    assert.ok(!JSON.stringify(parsed).includes('2500'));
    assert.deepEqual(nodes, before);
  }
});

test('only explicitly continued views may omit the expanded header', () => {
  const nodes = packFixture({ scrolled: true });
  assert.throws(() => parsePackCardTargets(nodes, CONTEXT, CARDS), /pack_header_mismatch/);
  assert.equal(parsePackCardTargets(nodes, CONTEXT, CARDS, { requireHeader: false }).targets.length, 2);
  nodes[1].text = '另一系列';
  assert.throws(() => parsePackCardTargets(nodes, CONTEXT, CARDS, { requireHeader: false }), /pack_header_mismatch/);
});

test('pack count accepts both exact observed comma and parenthesis labels', () => {
  for (const current of [false, true]) {
    for (const label of ['卡牌, 2', '卡牌(2)']) {
      const nodes = packFixture({ current });
      nodes.find((node) => node['content-desc'] === '卡牌, 2')['content-desc'] = label;
      assert.equal(parsePackCardTargets(nodes, CONTEXT, CARDS).targets.length, 2);
    }
  }
  for (const label of ['卡牌(1)', '卡牌(02)', '卡牌(2)其他', '其他卡牌(2)', '卡牌 2', '卡牌(2', '卡牌(0)']) {
    const nodes = packFixture();
    nodes.find((node) => node['content-desc'] === '卡牌, 2')['content-desc'] = label;
    assert.throws(() => parsePackCardTargets(nodes, CONTEXT, CARDS), /pack_header_mismatch/);
  }
});

test('unknown, sealed, clipped, mislabeled and small-action targets are never returned', () => {
  for (const change of [
    (nodes) => { nodes.find((n) => n['content-desc'].startsWith('耿鬼,')).bounds = '[28,728][232,1300]'; },
    (nodes) => { nodes.find((n) => n.text === 'TRIU-94(30C)').bounds = '[28,1067][232,1080]'; },
    (nodes) => { nodes.find((n) => n['content-desc'].startsWith('耿鬼,'))['content-desc'] = '耿鬼, TRIU-94(30C), 原盒, RAW, ¥2500起'; },
    (nodes) => { nodes.find((n) => n['content-desc'].startsWith('耿鬼,'))['content-desc'] = '耿鬼, TRIU-95(30C), Prime, RAW, ¥2500起'; },
    (nodes) => { nodes.find((n) => n['content-desc'] === '选择').bounds = '[50,800][200,950]'; },
  ]) {
    const nodes = packFixture();
    change(nodes);
    assert.deepEqual(parsePackCardTargets(nodes, CONTEXT, CARDS).targets.map((row) => row.cardNumber), [CARDS[1].cardNumber]);
  }
  assert.throws(() => parsePackCardTargets(packFixture(), CONTEXT, [{ ...CARDS[0], rarity: '原盒' }]), /invalid_expected_card/);
});

test('private fields, foreign packages and malformed trees stop pack parsing', () => {
  for (const extra of [
    { class: 'android.widget.EditText', text: 'private' },
    { password: 'true' }, { package: 'com.android.settings' }, { parentIndex: 999 },
  ]) {
    const nodes = packFixture();
    nodes.push({ ...nodes[0], parentIndex: 0, ...extra });
    assert.throws(() => parsePackCardTargets(nodes, CONTEXT, CARDS));
  }
});

test('detail identity discovers observed original names for the three public language headers', () => {
  for (const [language, originalName] of [['en', 'Gengar'], ['ja', 'ゲンガー'], ['zh-Hans', null]]) {
    const parsed = discoverAppDetailIdentity(detailFixture({ language, originalName }), { ...CONTEXT, language }, CARDS[0]);
    assert.equal(parsed.context.originalName, originalName || undefined);
    assert.equal(parsed.context.cardName, '耿鬼');
    assert.equal(parsed.context.cardNumber, 'TRIU-94(30C)');
    assert.equal(parsed.headerVerified, true);
    assert.equal(parsed.context.shareUrl, undefined);
  }
});

test('original-name discovery requires all independent markers and exact expected identity', () => {
  for (const change of [
    (nodes) => { nodes.find((n) => n.text === '宝可梦').text = '其他'; },
    (nodes) => { nodes.find((n) => n.text === '英文').text = '日文'; },
    (nodes) => { nodes.find((n) => n.text === CARDS[0].cardNumber).text = 'TRIU-95(30C)'; },
    (nodes) => { nodes.find((n) => n['content-desc'].startsWith('查看系列'))['content-desc'] = '查看系列 其他'; },
    (nodes) => { nodes.find((n) => n.text === 'Gengar').parentIndex = 0; },
    (nodes) => { nodes.find((n) => n.text === 'Gengar').bounds = '[320,400][688,434]'; },
    (nodes) => { nodes.find((n) => n.text === 'Gengar').password = 'true'; },
    (nodes) => { nodes.push({ ...nodes.find((n) => n.text === 'Gengar'), text: '请输入手机号' }); },
  ]) {
    const nodes = detailFixture();
    change(nodes);
    assert.throws(() => discoverAppDetailIdentity(nodes, CONTEXT, CARDS[0]));
  }
});

test('CLI emits stable errors without echoing private or malformed input', () => {
  const cli = fileURLToPath(new URL('../app-pack-detail.mjs', import.meta.url));
  const nodes = detailFixture();
  nodes.push({ ...nodes[0], parentIndex: 0, class: 'android.widget.EditText', text: '验证码 private-value' });
  const result = spawnSync(process.execPath, [cli], { windowsHide: true, shell: false, encoding: 'utf8',
    input: JSON.stringify({ mode: 'detail', context: CONTEXT, expectedCard: CARDS[0], nodes }) });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'private_or_login_screen' });
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('private-value'));
});

test('unexpected original-name layout reports only lengths and geometry', () => {
  const cli = fileURLToPath(new URL('../app-pack-detail.mjs', import.meta.url));
  const nodes = detailFixture({ originalName: 'sensitive-test-marker' });
  nodes.find((node) => node.text === 'sensitive-test-marker').bounds = '[320,220][688,269]';
  const result = spawnSync(process.execPath, [cli], { windowsHide: true, shell: false, encoding: 'utf8',
    input: JSON.stringify({ mode: 'detail', context: CONTEXT, expectedCard: CARDS[0], nodes }) });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.error, 'unexpected_public_input');
  assert.equal(report.diagnostic.originalNameLength, 21);
  assert.equal(report.diagnostic.originalNameEmpty, false);
  assert.deepEqual(report.diagnostic.originalNameBounds, { left: 320, top: 220, right: 688, bottom: 269 });
  assert.ok(!result.stdout.includes('sensitive-test-marker'));
  assert.equal(result.stderr, '');
});

test('observed multiline title accepts only aligned original-name padding overlap up to four pixels', () => {
  const observed = () => {
    const nodes = detailFixture({ language: 'ja', originalName: 'ダークライ＆クレセリアLEGEND' });
    nodes.find((node) => node.text === CARDS[0].cardName).bounds = '[320,144][688,209]';
    nodes.find((node) => node.text === 'ダークライ＆クレセリアLEGEND').bounds = '[320,205][688,239]';
    nodes.find((node) => node.text === CARDS[0].cardNumber).bounds = '[336,321][610,353]';
    return nodes;
  };
  const context = { ...CONTEXT, language: 'ja' };
  assert.equal(discoverAppDetailIdentity(observed(), context, CARDS[0]).context.originalName, 'ダークライ＆クレセリアLEGEND');
  for (const bounds of ['[320,204][688,239]', '[319,205][688,239]', '[320,205][687,239]',
    '[320,143][688,239]', '[320,205][688,208]', '[320,205][688,354]']) {
    const nodes = observed();
    nodes.find((node) => node.text === 'ダークライ＆クレセリアLEGEND').bounds = bounds;
    assert.throws(() => discoverAppDetailIdentity(nodes, context, CARDS[0]));
  }
});
