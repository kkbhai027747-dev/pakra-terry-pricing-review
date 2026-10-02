import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppDetail, parseAppVersionMinimum } from '../app-detail.mjs';

const CONTEXT = { language: 'zh-Hans', setId: '100143', setCode: '30thC', packName: '30周年庆典',
  cardName: '耿鬼', cardNumber: '30thC-150/103',
  shareUrl: 'https://api.jihuanshe.com/pro/cards/01a08652-8a3f-76fd-ac02-ad75ebe919d7' };

function fixture({ header = false, compact = false } = {}) {
  const nodes = [];
  const add = (parentIndex, bounds, text = '', description = '', className = 'android.view.ViewGroup') => {
    nodes.push({ parentIndex, bounds, text, 'content-desc': description, class: className,
      package: 'com.jihuanshe.pro', selected: 'false', password: 'false' });
    return nodes.length - 1;
  };
  const text = (parent, bounds, value) => add(parent, bounds, value, '', 'android.widget.TextView');
  const button = (parent, bounds, value) => add(parent, bounds, '', value, 'android.widget.Button');
  const root = add(null, '[0,0][720,1280]');
  const toolbar = add(root, '[0,42][720,138]');
  button(toolbar, '[0,50][80,130]', '返回');
  const bar = add(root, '[0,1087][720,1280]');
  button(bar, '[32,1120][162,1216]', '出售');
  button(bar, '[186,1120][688,1216]', '立即加购');
  if (header) {
    const head = add(root, '[0,144][720,636]');
    add(head, '[320,159][688,217]', CONTEXT.cardName, '', 'android.widget.EditText');
    add(head, '[336,310][503,342]', CONTEXT.cardNumber, '', 'android.widget.EditText');
    text(head, '[336,252][408,280]', '宝可梦');
    text(head, '[433,252][481,280]', '简中');
    button(head, '[320,424][600,520]', `查看系列 ${CONTEXT.packName}`);
  }
  const shift = header ? 621 : 0;
  const bounds = (top, bottom) => `[32,${top + shift}][688,${bottom + shift}]`;
  const controls = add(root, bounds(137, 287));
  button(controls, bounds(144, 196), '单卡');
  button(controls, bounds(144, 196), '评级卡');
  button(controls, bounds(137, 203), '一口价, 925');
  if (compact) {
    const condition = button(controls, bounds(215, 267), '评级筛选：流通品相，点击选择');
    text(condition, bounds(224, 258), '流通品相');
  } else for (const label of ['流通品相', '有瑕疵', '有损伤']) button(controls, bounds(215, 267), label);
  const market = button(root, bounds(303, 347), '查看行情, 流通品相 ￥118.29');
  text(market, bounds(303, 347), '118.29');
  const offer = (top, amount, stock, seller = '公开卖家') => {
    const row = button(root, `[32,${top}][688,${top + 192}]`, `耿鬼, ${seller}, ¥${amount}/张, 库存 ${stock}`);
    text(row, `[170,${top + 14}][500,${top + 48}]`, '耿鬼');
    text(row, `[531,${top + 31}][688,${top + 85}]`, `¥${amount}/张`);
    text(row, `[621,${top + 93}][688,${top + 128}]`, `库存 ${stock}`);
    text(row, `[220,${top + 60}][500,${top + 95}]`, seller);
  };
  if (header) offer(1036, '139.8', 9, '集换仓');
  else {
    offer(415, '139.8', 9, '集换仓');
    offer(638, '90', 1);
    offer(862, '95', 1);
    offer(1085, '95', 1);
  }
  return nodes;
}

test('verifies the exact public header and excludes the initial covered warehouse row', () => {
  const nodes = fixture({ header: true });
  const original = structuredClone(nodes);
  const result = parseAppDetail(nodes, CONTEXT);
  assert.equal(result.headerVerified, true);
  assert.deepEqual(result.header, { cardName: '耿鬼', cardNumber: '30thC-150/103',
    languageLabel: '简中', packName: '30周年庆典' });
  assert.deepEqual(result.observations, []);
  assert.equal(result.lowestAskingVerified, false);
  assert.deepEqual(nodes, original);
});

test('parses visible stocked offers, distinguishes warehouse and never certifies the lowest ask', () => {
  const result = parseAppDetail(fixture(), CONTEXT, { requireHeader: false });
  assert.deepEqual(result.observations.map(({ priceCny, stock, offerKind }) => ({ priceCny, stock, offerKind })), [
    { priceCny: '139.80', stock: 9, offerKind: 'warehouse' },
    { priceCny: '90.00', stock: 1, offerKind: 'seller' },
    { priceCny: '95.00', stock: 1, offerKind: 'seller' },
  ]);
  assert.equal(result.visibleArea.bottom, 1087);
  assert.equal(result.headerVerified, false);
  assert.equal(result.lowestAskingVerified, false);
  assert.deepEqual(result.controls, { singleCardSelected: null, fixedPriceSelected: null, conditionSelected: null });
  assert.ok(!JSON.stringify(result).includes('118.29'));
  assert.ok(!JSON.stringify(result).includes('公开卖家'));
});

test('observed capped listing count identifies the fixed-price control without becoming a price', () => {
  const nodes = fixture({ header: true });
  nodes.find((node) => node['content-desc'] === '一口价, 925')['content-desc'] = '一口价, 999+';
  const result = parseAppDetail(nodes, CONTEXT);
  assert.equal(result.headerVerified, true);
  assert.deepEqual(result.observations, []);
  assert.ok(!JSON.stringify(result).includes('999'));
  for (const label of ['一口价, 99+', '一口价, 999++', '一口价, 999元', '一口价, 999+extra']) {
    nodes.find((node) => node['content-desc'].startsWith('一口价'))['content-desc'] = label;
    assert.throws(() => parseAppDetail(nodes, CONTEXT), /fixed-price listing control/);
  }
});

const LUGIA = { language: 'en', languageLabel: '英文', setId: '100236', setCode: '30C',
  packName: '30周年庆典', cardName: '洛奇亚', originalName: 'Lugia', cardNumber: 'AQUA-149/147(30C)',
  shareUrl: 'https://api.jihuanshe.com/pro/cards/01a0684e-2984-7761-b825-5fa30c94b87a' };

function lugiaFixture() {
  const nodes = fixture({ header: true, compact: true }).map((node) => ({ ...node,
    text: node.text.replaceAll(CONTEXT.cardName, LUGIA.cardName).replace(CONTEXT.cardNumber, LUGIA.cardNumber).replace('简中', '英文'),
    'content-desc': node['content-desc'].replaceAll(CONTEXT.cardName, LUGIA.cardName).replace('一口价, 925', '一口价, 4') }));
  const name = nodes.find((node) => node.text === LUGIA.cardName);
  nodes.push({ ...name, text: LUGIA.originalName, bounds: '[320,220][688,254]' });
  return nodes;
}

test('accepts the observed English compact condition filter without inferring selection or a price', () => {
  const nodes = lugiaFixture(), original = structuredClone(nodes);
  const result = parseAppDetail(nodes, LUGIA);
  assert.equal(result.headerVerified, true);
  assert.equal(result.header.originalName, 'Lugia');
  assert.equal(result.header.cardNumber, LUGIA.cardNumber);
  assert.equal(result.context.shareUrl, LUGIA.shareUrl);
  assert.equal(result.controls.conditionSelected, null);
  assert.equal(result.lowestAskingVerified, false);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(nodes, original);
});

test('rejects ambiguous, altered, clipped and misplaced compact condition filters', () => {
  for (const change of [
    (nodes, button, label) => { label.text = '有瑕疵'; },
    (nodes, button, label) => { label.class = 'android.view.ViewGroup'; },
    (nodes, button, label) => { label.bounds = '[32,845][688,850]'; },
    (nodes, button, label) => { label.bounds = '[32,830][688,860]'; },
    (nodes, button, label) => { label.parentIndex = 0; },
    (nodes, button, label) => { nodes.push({ ...label }); },
    (nodes, button) => { nodes.push({ ...button }); },
    (nodes, button) => { nodes.push({ ...button, 'content-desc': '流通品相' }); },
    (nodes, button) => { button['content-desc'] = '评级筛选：有瑕疵，点击选择'; },
    (nodes, button) => { button['content-desc'] += '其他'; },
    (nodes, button) => { button.parentIndex = 0; },
    (nodes, button) => { button.bounds = '[32,1100][688,1152]'; },
  ]) {
    const nodes = lugiaFixture();
    const button = nodes.find((node) => node['content-desc'].startsWith('评级筛选'));
    const label = nodes.find((node) => node.parentIndex === nodes.indexOf(button) && node.text === '流通品相');
    change(nodes, button, label);
    assert.throws(() => parseAppDetail(nodes, LUGIA), /compact condition controls/);
  }
});

test('compact layout retains exact language, card number, original name, pack and public context guards', () => {
  for (const change of [
    (nodes) => { nodes.find((node) => node.text === '英文').text = '日文'; },
    (nodes) => { nodes.find((node) => node.text === LUGIA.cardNumber).text = 'AQUA-148/147(30C)'; },
    (nodes) => { nodes.find((node) => node.text === 'Lugia').text = 'Gengar'; },
    (nodes) => { nodes.find((node) => node['content-desc'].startsWith('查看系列'))['content-desc'] = '查看系列 其他'; },
    (nodes) => { nodes.find((node) => node['content-desc'] === '单卡')['content-desc'] = '其他'; },
    (nodes) => { nodes.find((node) => node['content-desc'] === '一口价, 4')['content-desc'] = '一口价, ?'; },
  ]) {
    const nodes = lugiaFixture(); change(nodes);
    assert.throws(() => parseAppDetail(nodes, LUGIA));
  }
  assert.throws(() => parseAppDetail(lugiaFixture(), { ...LUGIA, shareUrl: 'https://other.test/card' }));
  assert.throws(() => parseAppDetail(lugiaFixture(), { ...LUGIA, setId: '' }));
});

test('requires exact header identity and explicit observed labels for other languages', () => {
  for (const change of [
    (nodes) => { nodes.find((node) => node.text === '耿鬼').text = '皮卡丘'; },
    (nodes) => { nodes.find((node) => node.text === '30thC-150/103').text = '30thC-151/103'; },
    (nodes) => { nodes.find((node) => node.text === '简中').text = '日文'; },
    (nodes) => { nodes.find((node) => node['content-desc'].startsWith('查看系列')).bounds = '[320,424][600,426]';
      nodes.find((node) => node['content-desc'].startsWith('查看系列'))['content-desc'] = '查看系列 其他'; },
  ]) {
    const nodes = fixture({ header: true });
    change(nodes);
    assert.throws(() => parseAppDetail(nodes, CONTEXT));
  }
  assert.throws(() => parseAppDetail(fixture(), CONTEXT));
  const nodes = fixture({ header: true });
  nodes.find((node) => node.text === '简中').text = '英文';
  assert.throws(() => parseAppDetail(nodes, { ...CONTEXT, language: 'en' }), /header/);
  assert.equal(parseAppDetail(nodes, { ...CONTEXT, language: 'en', languageLabel: '英文' }).header.languageLabel, '英文');
});

test('rejects private input, login screens, foreign app content and invalid ancestry', () => {
  for (const extra of [
    { class: 'android.widget.EditText', text: 'unrelated input' },
    { class: 'android.widget.TextView', text: '请输入验证码' },
    { password: 'true' },
    { package: 'com.android.settings' },
    { parentIndex: 9999 },
  ]) {
    const nodes = fixture();
    nodes.push({ ...nodes[0], parentIndex: 0, ...extra });
    assert.throws(() => parseAppDetail(nodes, CONTEXT, { requireHeader: false }));
  }
  assert.throws(() => parseAppDetail(fixture(), { ...CONTEXT, shareUrl: 'https://other.test/card' }));
});

test('requires visible matching child prices and stocks rather than an accessibility label alone', () => {
  for (const change of [
    (nodes) => { nodes.find((node) => node.text === '¥90/张').bounds = '[589,669][688,680]'; },
    (nodes) => { nodes.find((node) => node.text === '¥90/张').text = '¥91/张'; },
    (nodes) => { nodes.find((node) => node.text === '¥90/张').parentIndex = 0; },
    (nodes) => { nodes.find((node) => node.text === '¥90/张').bounds = '[589,1070][688,1124]'; },
    (nodes) => { nodes.find((node) => node['content-desc'].includes('¥90/张'))['content-desc'] = '耿鬼, 公开卖家, ¥90/张, 库存 0'; },
  ]) {
    const nodes = fixture();
    change(nodes);
    assert.equal(parseAppDetail(nodes, CONTEXT, { requireHeader: false }).observations.some((row) => row.priceCny === '90.00'), false);
  }
});

function versionsFixture() {
  const node = (parentIndex, className, bounds, text = '', description = '') => ({ parentIndex,
    class: className, bounds, text, 'content-desc': description, package: 'com.jihuanshe.pro' });
  return [
    node(null, 'android.view.ViewGroup', '[0,0][720,1280]'),
    node(0, 'android.widget.Button', '[0,0][720,1280]', '', '关闭全部版本列表'),
    node(0, 'android.view.ViewGroup', '[16,84][704,1232]', '', '全部语言版本'),
    node(2, 'android.widget.Button', '[608,116][672,180]', '', '收起'),
    node(2, 'android.widget.TextView', '[48,220][672,292]', '全部语言版本'),
    node(2, 'android.widget.Button', '[48,426][672,645]', '', '耿鬼, 当前, 30thC-150/103, 无标记, 2026-09-16, ¥118.29, 最低价 ¥90起'),
    node(5, 'android.widget.TextView', '[206,462][266,496]', '耿鬼'),
    node(5, 'android.widget.TextView', '[290,467][335,491]', '当前'),
    node(5, 'android.widget.TextView', '[206,503][496,531]', '30thC-150/103'),
    node(5, 'android.widget.TextView', '[520,516][672,562]', '¥118.29'),
    node(5, 'android.widget.TextView', '[520,570][672,598]', '最低价 ¥90起'),
  ];
}

test('reads the official current-version minimum rather than the separate market reference', () => {
  const result = parseAppVersionMinimum(versionsFixture(), CONTEXT);
  assert.equal(result.amountCny, '90.00');
  assert.equal(result.sourceMetricLabel, '最低价');
  assert.equal(result.sourceDisplayLabel, '最低价 ¥90起');
  assert.equal(result.conditionScope, 'app_unfiltered_version_minimum');
  assert.equal(result.quoteEligible, false);
  assert.ok(!JSON.stringify(result).includes('118.29'));
});

test('rejects ambiguous, clipped, rounded, mismatched and absent current-version minima', () => {
  for (const change of [
    (nodes) => { nodes[5]['content-desc'] = nodes[5]['content-desc'].replace('当前', '其他'); },
    (nodes) => { nodes[5]['content-desc'] = nodes[5]['content-desc'].replace('150/103', '151/103'); },
    (nodes) => { nodes[5].bounds = '[48,426][672,1250]'; },
    (nodes) => { nodes[10].bounds = '[520,570][672,580]'; },
    (nodes) => { nodes[10].parentIndex = 2; },
    (nodes) => { nodes[10].text = '最低价 ¥95起'; },
    (nodes) => { nodes[5]['content-desc'] = nodes[5]['content-desc'].replace('最低价 ¥90起', '最低价 ¥1.2万起'); nodes[10].text = '最低价 ¥1.2万起'; },
    (nodes) => { nodes[5]['content-desc'] = nodes[5]['content-desc'].replace('最低价 ¥90起', '最低价 暂无'); nodes[10].text = '最低价 暂无'; },
    (nodes) => { nodes.push({ ...nodes[5] }); },
    (nodes) => { nodes[2]['content-desc'] = '其他面板'; },
  ]) {
    const nodes = versionsFixture();
    change(nodes);
    assert.throws(() => parseAppVersionMinimum(nodes, CONTEXT));
  }
});

test('accepts exact observed Japanese original names and correctly grouped prices', () => {
  const context = { ...CONTEXT, language: 'ja', originalName: 'ゲンガー', cardNumber: 'M6a-150/103', setCode: 'M6a', setId: '100145' };
  const nodes = fixture({ header: true });
  const name = nodes.find((node) => node.text === '耿鬼');
  nodes.push({ ...name, text: 'ゲンガー', bounds: '[320,220][688,254]' });
  nodes.find((node) => node.text === '简中').text = '日文';
  nodes.find((node) => node.text === CONTEXT.cardNumber).text = context.cardNumber;
  assert.equal(parseAppDetail(nodes, context).header.originalName, 'ゲンガー');
  assert.throws(() => parseAppDetail(nodes, { ...context, originalName: '別名' }));
  const offers = fixture().map((node) => ({ ...node, text: node.text.replaceAll('耿鬼', 'ゲンガー').replaceAll('¥90/张', '¥1,500/张'),
    'content-desc': node['content-desc'].replaceAll('耿鬼', 'ゲンガー').replaceAll('¥90/张', '¥1,500/张') }));
  const result = parseAppDetail(offers, context, { requireHeader: false });
  assert.equal(result.observations[1].priceCny, '1500.00');
  assert.equal(result.observations[1].cardName, 'ゲンガー');
  for (const malformed of ['15,00', '1,50,000', '1500,000', '0,000']) {
    const bad = offers.map((node) => ({ ...node, text: node.text.replace('1,500', malformed),
      'content-desc': node['content-desc'].replace('1,500', malformed) }));
    assert.equal(parseAppDetail(bad, context, { requireHeader: false }).observations.length, 2);
  }
});
