import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppListing } from '../app-listing.mjs';

const CONTEXT = { language: 'zh-Hans', setId: '100143', setCode: '30thC', packName: '30周年庆典' };
const node = (text, description, bounds, selected = 'false') => ({ text, 'content-desc': description, bounds, selected });
const CARD = '梦幻, 30thC-G/RGB, 无标记, RAW, ¥8888起';
function fixture() {
  return [
    node('30周年庆典', '', '[196,76][350,116]'),
    node('30thC', '', '[224,306][692,340]'),
    node('', '卡牌, 176', '[344,540][499,608]'),
    node('', 'RAW', '[32,648][108,688]', 'true'),
    node('', '最低价', '[399,640][515,696]'),
    node('', CARD, '[28,728][232,1139]'),
    node('¥8888起', '', '[80,1103][232,1139]'),
    node('', '喷火龙, 30thC-137/103, 无标记', '[28,1163][232,1280]'),
  ];
}

test('records only visible list observations and never certifies a quote or version', () => {
  const nodes = fixture();
  const before = structuredClone(nodes);
  const result = parseAppListing(nodes, CONTEXT);
  assert.deepEqual(result, {
    kind: 'app_listing_observations', context: CONTEXT, displayedCardCount: 176,
    lowestAskingVerified: false, observations: [{ cardName: '梦幻', cardNumber: '30thC-G/RGB',
      rarity: '无标记', displayedFromCny: '8888.00', pricePrecision: 'full',
      rawLabel: CARD, bounds: '[28,728][232,1139]' }],
  });
  assert.deepEqual(nodes, before);
  assert.ok(!/identity|versionId|imageUrl|available|sourceUrl|amountCny/.test(JSON.stringify(result)));
});

test('requires pack context, matching header, readable count, selected RAW and price control', () => {
  for (const change of [
    (rows) => { rows[0].text = '另一个卡包'; },
    (rows) => { rows[1].text = 'M6a'; },
    (rows) => { rows[2]['content-desc'] = '卡牌'; },
    (rows) => { rows[3].selected = 'false'; },
    (rows) => { rows[4]['content-desc'] = '集换价'; },
    (rows) => { rows.push(node('', '卡牌, 177', '[344,540][499,608]')); },
    (rows) => { rows.push(node('登录/注册', '', '[0,74][720,118]')); },
    (rows) => { rows.push(node('', 'PSA10', '[112,648][207,688]', true)); },
  ]) {
    const rows = fixture();
    change(rows);
    assert.throws(() => parseAppListing(rows, CONTEXT));
  }
  for (const context of [null, { ...CONTEXT, language: 'sc' }, { ...CONTEXT, setId: '' },
    { ...CONTEXT, setCode: '' }, { ...CONTEXT, packName: '' }]) {
    assert.throws(() => parseAppListing(fixture(), context), /Explicit pack context/);
  }
});

test('skips other packs, ambiguous labels, missing prices and clipped prices without declaring no stock', () => {
  for (const change of [
    (rows) => { rows[5]['content-desc'] = CARD.replace('30thC-', 'M6a-'); },
    (rows) => { rows[5]['content-desc'] = CARD.replace('梦幻,', '梦幻, 歧义,'); },
    (rows) => { rows[5]['content-desc'] = '梦幻, 30thC-G/RGB, 无标记, RAW'; },
    (rows) => { rows[5]['content-desc'] = CARD.replace('¥8888起', '暂无价格'); },
    (rows) => { rows[5]['content-desc'] = CARD.replace('无标记', '原包'); },
    (rows) => { rows[5]['content-desc'] = CARD.replace('RAW', 'PSA10'); },
    (rows) => { rows[5].bounds = '[28,728][232,1100]'; },
    (rows) => { rows.splice(6, 1); },
  ]) {
    const rows = fixture();
    change(rows);
    const result = parseAppListing(rows, CONTEXT);
    assert.deepEqual(result.observations, []);
    assert.equal(result.lowestAskingVerified, false);
  }
});

test('normalizes displayed decimals and rejects conflicting repeated numbers', () => {
  const rows = fixture();
  rows[3].selected = true;
  rows[5]['content-desc'] = CARD.replace('8888', '12.5');
  rows[6].text = '¥12.5起';
  assert.equal(parseAppListing(rows, CONTEXT).observations[0].displayedFromCny, '12.50');
  rows.push({ ...rows[5] });
  assert.throws(() => parseAppListing(rows, CONTEXT), /Ambiguous repeated card number/);
});

test('preserves abbreviated price displays without converting rounded UI text into an exact price', () => {
  const rows = fixture().map((row) => ({ ...row, text: row.text.replaceAll('30thC', 'M6a'),
    'content-desc': row['content-desc'].replaceAll('30thC', 'M6a') }));
  const abbreviatedLabel = '梦幻, M6a-B/RGB, 无标记, RAW, ¥49.9万起';
  rows[2]['content-desc'] = '卡牌, 177';
  rows[5]['content-desc'] = abbreviatedLabel;
  rows[6].text = '¥49.9万起';
  rows.push(node('', '梦幻, M6a-R/RGB, 无标记, RAW, ¥31000起', '[256,728][460,1139]'),
    node('¥31000起', '', '[308,1103][460,1139]'));
  const result = parseAppListing(rows, { ...CONTEXT, language: 'ja', setId: '100145', setCode: 'M6a' });
  assert.equal(result.lowestAskingVerified, false);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].rawLabel, abbreviatedLabel);
  assert.equal(result.observations[0].displayedFromCny, null);
  assert.equal(result.observations[0].pricePrecision, 'abbreviated');
  assert.equal(result.observations[1].displayedFromCny, '31000.00');
  assert.equal(result.observations[1].pricePrecision, 'full');
  rows.splice(6, 1);
  assert.equal(parseAppListing(rows, { ...CONTEXT, language: 'ja', setId: '100145', setCode: 'M6a' })
    .observations.length, 1);
});

test('accepts observed English 30C reprint numbers without accepting another set suffix', () => {
  const context = { ...CONTEXT, language: 'en', setId: '100236', setCode: '30C' };
  function rowsWith(number) {
    const rows = fixture();
    rows[1].text = '30C';
    rows[2]['content-desc'] = '卡牌, 191';
    rows[5]['content-desc'] = CARD.replace('30thC-G/RGB', number);
    return rows;
  }
  for (const number of ['BASE-4(30C)', 'AQUA-149/147(30C)', 'TRIU-94(30C)', '30C-001/103']) {
    const result = parseAppListing(rowsWith(number), context);
    assert.equal(result.observations[0].cardNumber, number);
    assert.equal(result.lowestAskingVerified, false);
  }
  for (const number of ['BASE-4(M6a)', 'BASE-4(30thC)', 'BASE-4(30C)extra', 'BASE-4(30C',
    'BASE-4((30C))', 'BASE-4(30C)(M6a)', '30C-001(M6a)', 'BASE-4']) {
    assert.deepEqual(parseAppListing(rowsWith(number), context).observations, []);
  }
  assert.deepEqual(parseAppListing(rowsWith('BASE-4(30C)'), { ...context, language: 'ja' }).observations, []);
});

test('preserves four-part card labels with unknown rarity without accepting a truncated price row', () => {
  const rows = fixture();
  const context = { ...CONTEXT, language: 'en', setId: '100236', setCode: '30C' };
  rows[1].text = '30C';
  rows[2]['content-desc'] = '卡牌, 191';
  const rawLabel = '皮卡丘, 30C-033/128, RAW, ¥50起';
  rows[5]['content-desc'] = rawLabel;
  rows[6].text = '¥50起';
  const result = parseAppListing(rows, context);
  assert.deepEqual(result.observations[0], { cardName: '皮卡丘', cardNumber: '30C-033/128', rarity: null,
    displayedFromCny: '50.00', pricePrecision: 'full', rawLabel, bounds: '[28,728][232,1139]' });
  for (const invalid of ['皮卡丘, 30C-033/128, RAW', '皮卡丘, 30C-033/128, 无标记, RAW',
    '皮卡丘, 30C-033/128, , RAW, ¥50起', '皮卡丘, M6a-033/128, RAW, ¥50起']) {
    rows[5]['content-desc'] = invalid;
    assert.deepEqual(parseAppListing(rows, context).observations, []);
  }
  rows[5]['content-desc'] = rawLabel;
  rows.splice(6, 1);
  assert.deepEqual(parseAppListing(rows, context).observations, []);
});

test('records the visible 暂无 label without interpreting it as a verified no-offer quote', () => {
  const rows = fixture();
  rows[5]['content-desc'] = CARD.replace('¥8888起', '暂无');
  rows[6].text = '暂无';
  const result = parseAppListing(rows, CONTEXT);
  assert.equal(result.lowestAskingVerified, false);
  assert.equal(result.observations[0].displayedFromCny, null);
  assert.equal(result.observations[0].pricePrecision, 'unavailable_display');
  assert.equal(result.observations[0].rarity, '无标记');
  assert.equal(result.observations[0].rawLabel, rows[5]['content-desc']);
  assert.ok(!('available' in result.observations[0]));
  rows[6].bounds = '[80,1140][232,1176]';
  assert.deepEqual(parseAppListing(rows, CONTEXT).observations, []);
});

test('preserves the observed Japanese M6a LEGEND combination number as one literal observation', () => {
  const rows = fixture();
  const context = { ...CONTEXT, language: 'ja', setId: '100145', setCode: 'M6a' };
  rows[1].text = 'M6a';
  rows[2]['content-desc'] = '卡牌, 177';
  const number = 'M6a-151~152/103(1Set)';
  const label = `达克莱伊&克雷色利亚LEGEND, ${number}, LEGEND, RAW, ¥120起`;
  rows[5]['content-desc'] = label;
  rows[6].text = '¥120起';
  const result = parseAppListing(rows, context);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].cardNumber, number);
  assert.equal(result.observations[0].cardName, '达克莱伊&克雷色利亚LEGEND');
  assert.equal(result.observations[0].displayedFromCny, '120.00');
  assert.equal(result.observations[0].rawLabel, label);
  assert.ok(!('identity' in result.observations[0]));
  for (const invalid of ['M6a-151~152/103(2Set)', 'M6a-151/103(1Set)',
    'M6a-151~152/103(1Set)extra', 'M6a-151~152/103(30C)', '30C-151~152/103(1Set)']) {
    rows[5]['content-desc'] = label.replace(number, invalid);
    assert.deepEqual(parseAppListing(rows, context).observations, []);
  }
  rows[5]['content-desc'] = label;
  assert.deepEqual(parseAppListing(rows, { ...context, language: 'en' }).observations, []);
});
