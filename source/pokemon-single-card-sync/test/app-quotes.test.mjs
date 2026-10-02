import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../files.mjs';
import { verifyAppDailyQuotes } from '../app-quotes.mjs';
import { summarizeAppDetail } from '../summarize-app-detail.mjs';
import { main as syncMain } from '../sync.mjs';
import { ShopifyClient, LISTED_VARIANTS_QUERY } from '../shopify.mjs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = join(PROJECT, 'output');
const NOW = new Date('2026-09-26T12:05:00.000Z');
const CONTEXT = { language: 'zh-Hans', setId: '100143', setCode: '30thC', packName: '30周年庆典',
  cardName: '耿鬼', cardNumber: '30thC-150/103', languageLabel: '简中',
  shareUrl: 'https://api.jihuanshe.com/pro/cards/01a08652-8a3f-76fd-ac02-ad75ebe919d7' };
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function nodes(context, minimumLabel) {
  const result = [];
  const add = (parentIndex, bounds, value = '', type = 'view') => {
    result.push({ parentIndex, bounds, package: 'com.jihuanshe.pro', selected: 'false',
      class: { view: 'android.view.ViewGroup', button: 'android.widget.Button', text: 'android.widget.TextView', input: 'android.widget.EditText' }[type],
      text: ['text', 'input'].includes(type) ? value : '', 'content-desc': ['view', 'button'].includes(type) ? value : '' });
    return result.length - 1;
  };
  const root = add(null, '[0,0][720,1280]');
  if (minimumLabel !== undefined) {
    add(root, '[0,0][720,1280]', '关闭全部版本列表', 'button');
    const panel = add(root, '[16,84][704,1232]', '全部语言版本');
    add(panel, '[608,116][672,180]', '收起', 'button');
    const row = add(panel, '[48,426][672,645]', `${context.cardName}, 当前, ${context.cardNumber}, 无标记, ¥118.29, ${minimumLabel}`, 'button');
    add(row, '[206,462][266,496]', context.cardName, 'text');
    add(row, '[290,467][335,491]', '当前', 'text');
    add(row, '[206,503][496,531]', context.cardNumber, 'text');
    add(row, '[520,570][672,598]', minimumLabel, 'text');
    return result;
  }
  const toolbar = add(root, '[0,42][720,138]');
  add(toolbar, '[0,50][80,130]', '返回', 'button');
  const bar = add(root, '[0,1087][720,1280]');
  add(bar, '[32,1120][162,1216]', '出售', 'button');
  add(bar, '[186,1120][688,1216]', '立即加购', 'button');
  const head = add(root, '[0,144][720,636]');
  add(head, '[320,159][688,217]', context.cardName, 'input');
  add(head, '[336,310][503,342]', context.cardNumber, 'input');
  add(head, '[336,252][408,280]', '宝可梦', 'text');
  add(head, '[433,252][481,280]', context.languageLabel, 'text');
  add(head, '[320,424][600,520]', `查看系列 ${context.packName}`, 'button');
  const controls = add(root, '[32,650][688,800]');
  for (const label of ['单卡', '评级卡', '一口价, 925', '流通品相', '有瑕疵', '有损伤']) add(controls, '[32,660][688,710]', label, 'button');
  return result;
}

function fixture(t, labels = ['最低价 ¥90起']) {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = mkdtempSync(join(TEST_ROOT, 'app-quotes-test-'));
  t.after(() => { assert.equal(dirname(directory), TEST_ROOT); rmSync(directory, { recursive: true, force: true }); });
  const captures = [], catalog = [], rows = [];
  for (const [index, label] of labels.entries()) {
    const context = { ...CONTEXT, ...(index ? { cardName: `合成卡${index}`, cardNumber: `30thC-${index}/103`,
      shareUrl: `https://api.jihuanshe.com/pro/cards/00000000-0000-0000-0000-${String(index).padStart(12, '0')}` } : {}) };
    const cardDirectory = join(directory, `card-${String(index + 1).padStart(6, '0')}`), capture = join(cardDirectory, 'capture');
    mkdirSync(capture, { recursive: true });
    write(join(cardDirectory, 'context.json'), context);
    const frame = (stem, nodeData, capturedAt) => {
      const parts = { xml: `<hierarchy synthetic="${stem}"/>`, png: `synthetic-png-${stem}`, 'nodes.json': JSON.stringify(nodeData) };
      for (const [extension, content] of Object.entries(parts)) writeFileSync(join(capture, `${stem}.${extension}`), content);
      return { capturedAt, xmlSha256: sha256(parts.xml), pngSha256: sha256(parts.png), nodesSha256: sha256(parts['nodes.json']) };
    };
    const session = { status: 'public_detail_evidence_only', context,
      pages: [{ ...frame('page-001', nodes(context), '2026-09-26T12:00:00.000Z'), page: 1, previousXmlSha256: null,
        headerChecked: true, continuity: 'exact_header_after_known_deeplink' }],
      ...(label === null ? {} : { minimumEvidence: frame('minimum', nodes(context, label), '2026-09-26T12:00:30.000Z') }) };
    write(join(capture, 'session.json'), session);
    const observation = summarizeAppDetail(capture);
    write(join(cardDirectory, 'observation.json'), observation);
    rows.push({ index, sourceUrl: context.shareUrl, cardNumber: context.cardNumber, language: context.language,
      status: observation.status, amountCny: observation.minimum.amountCny, quoteEligible: false });
    const uuid = context.shareUrl.split('/').at(-1);
    catalog.push({ identity: `pokemon:${context.language}:${context.setId}:${uuid}`, ip: 'pokemon', sourceKind: 'official_app_ui',
      versionIdKind: 'jihuanshe_pro_card_uuid', versionId: uuid, sourceUrl: context.shareUrl, language: context.language,
      setId: context.setId, setCode: context.setCode, packName: context.packName, name: context.cardName, number: context.cardNumber, originalName: '' });
    captures.push({ cardDirectory, capture, context, session });
  }
  const report = { kind: 'app_daily_public_observations', status: 'observations_only', quoteEligible: false,
    startedAt: '2026-09-26T11:59:00.000Z', completedAt: '2026-09-26T12:01:00.000Z',
    selection: { offset: 0, limit: labels.length, selected: labels.length, inputCount: labels.length }, cards: rows,
    attempted: rows.length, observed: rows.filter((row) => row.status === 'observed').length,
    notExactMinimum: rows.filter((row) => row.status === 'not_exact_minimum').length };
  const reportPath = join(directory, 'report.json');
  write(reportPath, report);
  return { directory, reportPath, report, captures, catalog, verify: (now = NOW) => verifyAppDailyQuotes(directory, catalog, { now }) };
}

test('independently recomputes quotes and retains original capture times and unfiltered condition scope', (t) => {
  const data = fixture(t);
  data.report.cards[0].amountCny = '0.01';
  write(data.reportPath, data.report);
  write(join(data.captures[0].cardDirectory, 'observation.json'), { amountCny: '0.01', quoteEligible: true });
  const before = readFileSync(data.reportPath);
  const result = data.verify();
  assert.equal(result.quotes.length, 1);
  const quote = result.quotes[0];
  assert.equal(quote.amountCny, '90.00');
  assert.equal(quote.available, true);
  assert.equal(quote.quoteEligible, true);
  assert.equal(quote.sourceKind, 'official_app_ui');
  assert.equal(quote.conditionScope, 'app_unfiltered_version_minimum');
  assert.equal(quote.observedAt, '2026-09-26T12:00:30.000Z');
  assert.equal(quote.identity, data.catalog[0].identity);
  assert.deepEqual(result.targetIdentities, [data.catalog[0].identity]);
  assert.match(quote.evidence.sessionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(data.reportPath), before);
  assert.equal(read(data.reportPath).quoteEligible, false);
  const historical = data.verify(new Date('2026-09-28T12:00:00.000Z'));
  assert.equal(historical.quotes[0].observedAt, quote.observedAt, 'verification must not turn old evidence into today’s quote');
});

test('unknown, missing and abbreviated minima are unquoted, never zero or no-stock offers', (t) => {
  const data = fixture(t, ['最低价 暂无', '最低价 ¥1.2万起', null]);
  const result = data.verify();
  assert.deepEqual(result.quotes, []);
  assert.equal(result.unquoted.length, 3);
  assert.equal(result.targetIdentities.length, 3);
  assert.ok(result.unquoted.every((row) => !('available' in row) && !('amountCny' in row) && row.quoteEligible === false));
});

test('rejects failed, incomplete and unattempted runs and missing sessions', (t) => {
  for (const mutate of [
    (data) => { data.report.status = 'stopped'; },
    (data) => { data.report.cards[0].status = 'not_attempted'; },
    (data) => { data.report.attempted = 0; },
    (data) => { data.report.selection.offset = -1; },
  ]) {
    const data = fixture(t); mutate(data); write(data.reportPath, data.report);
    assert.throws(() => data.verify(), /incomplete_app_daily_report/);
  }
  const missing = fixture(t);
  rmSync(join(missing.captures[0].capture, 'session.json'));
  assert.throws(() => missing.verify(), /invalid_app_evidence_json/);
  const failed = fixture(t);
  write(join(failed.captures[0].capture, 'failure.json'), {});
  assert.throws(() => failed.verify(), /app_capture_evidence_invalid/);
});

test('rejects duplicate UUIDs, foreign catalog identities and mismatched daily contexts', (t) => {
  const duplicate = fixture(t, ['最低价 ¥90起', '最低价 ¥91起']);
  duplicate.report.cards[1] = { ...duplicate.report.cards[0], index: 1 };
  write(duplicate.reportPath, duplicate.report);
  assert.throws(() => duplicate.verify(), /duplicate_daily_uuid/);
  for (const field of ['language', 'setId', 'setCode', 'number', 'name', 'versionId']) {
    const data = fixture(t); data.catalog[0][field] = 'wrong';
    assert.throws(() => data.verify(), /identity_mismatch|invalid_app_catalog_identity/);
  }
  const context = fixture(t);
  write(join(context.captures[0].cardDirectory, 'context.json'), { ...CONTEXT, cardName: '另一张卡' });
  assert.throws(() => context.verify(), /daily_context_identity_mismatch/);
  const session = fixture(t);
  session.captures[0].session.context = { ...CONTEXT, shareUrl: 'https://api.jihuanshe.com/pro/cards/00000000-0000-0000-0000-000000000001' };
  write(join(session.captures[0].capture, 'session.json'), session.captures[0].session);
  assert.throws(() => session.verify(), /session_context_identity_mismatch/);
});

test('rejects swapped card directories, changed evidence and invalid time sequences', (t) => {
  const swapped = fixture(t, ['最低价 ¥90起', '最低价 ¥91起']);
  const holding = join(swapped.directory, 'temporary');
  renameSync(swapped.captures[0].cardDirectory, holding);
  renameSync(swapped.captures[1].cardDirectory, swapped.captures[0].cardDirectory);
  renameSync(holding, swapped.captures[1].cardDirectory);
  assert.throws(() => swapped.verify(), /daily_context_identity_mismatch/);
  for (const name of ['page-001.xml', 'page-001.png', 'minimum.nodes.json']) {
    const data = fixture(t); writeFileSync(join(data.captures[0].capture, name), 'tampered');
    assert.throws(() => data.verify(), /app_capture_evidence_invalid/);
  }
  const sequence = fixture(t);
  sequence.captures[0].session.minimumEvidence.capturedAt = '2026-09-26T11:00:00.000Z';
  write(join(sequence.captures[0].capture, 'session.json'), sequence.captures[0].session);
  assert.throws(() => sequence.verify(), /app_capture_evidence_invalid/);
  const outside = fixture(t); outside.report.completedAt = '2026-09-26T12:00:01.000Z'; write(outside.reportPath, outside.report);
  assert.throws(() => outside.verify(), /app_capture_outside_run/);
  const future = fixture(t);
  assert.throws(() => future.verify(new Date('2026-09-26T11:00:00.000Z')), /invalid_app_run_sequence/);
});

test('rejects workspace escape and linked evidence paths without following them', (t) => {
  const data = fixture(t);
  assert.throws(() => verifyAppDailyQuotes(resolve(PROJECT, '..', '..'), data.catalog, { now: NOW }), /app_evidence_path_escape/);
  const original = data.captures[0].capture, moved = join(data.directory, 'linked-capture-target');
  renameSync(original, moved);
  symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => data.verify(), /app_evidence_symlink/);
  assert.ok(existsSync(join(moved, 'session.json')));
});

test('App preview revalidates captured evidence and scopes Shopify reads to this batch', async (t) => {
  const data = fixture(t);
  const now = Date.now(), stamp = (seconds) => new Date(now - seconds * 1000).toISOString();
  data.report.startedAt = stamp(90); data.report.completedAt = stamp(10);
  write(data.reportPath, data.report);
  const session = data.captures[0].session;
  session.pages[0].capturedAt = stamp(60); session.minimumEvidence.capturedAt = stamp(30);
  write(join(data.captures[0].capture, 'session.json'), session);
  const configPath = join(data.directory, 'config.json');
  const outputDir = join(data.directory, 'prices'); mkdirSync(outputDir);
  write(configPath, { store: 'example.myshopify.com', batchSize: 25, requestDelayMs: 0,
    outputDir: 'prices', mappingFile: 'mapping.json',
    shipping: { mode: 'per_order', orderCny: 15, allocation: 'per_unit' } });
  write(join(outputDir, 'catalog.json'), { cards: data.catalog });
  const target = { identity: data.catalog[0].identity, productGid: 'gid://shopify/Product/100',
    variantGid: 'gid://shopify/ProductVariant/200', sku: 'SYNTHETIC-ONLY', enabled: true };
  write(join(data.directory, 'mapping.json'), [target, { ...target, identity: 'pokemon:en:100236:other-batch',
    variantGid: 'gid://shopify/ProductVariant/201' }]);
  const procurementPath = join(data.directory, 'allocations.json');
  write(procurementPath, [{ identity: target.identity, orderId: 'synthetic-purchase', totalUnits: 5, units: 5 }]);
  const shopify = t.mock.method(ShopifyClient.prototype, 'execute', async (query, variables, permissions) => {
    assert.equal(query, LISTED_VARIANTS_QUERY); assert.equal(permissions?.allowMutations, undefined);
    assert.deepEqual(variables.ids, [target.variantGid]);
    return { shop: { currencyCode: 'USD' }, nodes: [{ id: target.variantGid, sku: target.sku, price: '30.00',
      product: { id: target.productGid, status: 'ACTIVE', title: 'Synthetic test card', onlineStoreUrl: 'https://example.com/products/test' } }] };
  });
  t.mock.method(console, 'log', () => {});
  const result = await syncMain(['daily', '--config', configPath, '--app-run', data.directory, '--procurement', procurementPath]);
  const plan = read(join(outputDir, 'latest-plan.json'));
  assert.equal(result.changes, 1); assert.equal(result.blocked, 0); assert.equal(shopify.mock.callCount(), 1);
  assert.equal(plan.changes[0].sourceAmountCny, '90.00'); assert.equal(plan.changes[0].shippingCny, '3.00');
  assert.equal(plan.sourceScope, 'app_unfiltered_version_minimum');
  assert.equal(plan.changes[0].newPrice, '31.00');
  assert.equal(read(data.reportPath).quoteEligible, false);
});

function stoppedFixture(t, prefix = 18) {
  const data = fixture(t, Array(20).fill('最低价 ¥90起'));
  for (const [i, capture] of data.captures.entries()) {
    if (i < prefix) {
      capture.session.pages[0].capturedAt = new Date(Date.parse('2026-09-26T12:00:00Z') + i * 2000).toISOString();
      capture.session.minimumEvidence.capturedAt = new Date(Date.parse('2026-09-26T12:00:01Z') + i * 2000).toISOString();
      write(join(capture.capture, 'session.json'), capture.session);
      continue;
    }
    assert.equal(dirname(capture.cardDirectory), data.directory);
    rmSync(capture.cardDirectory, { recursive: true });
    data.report.cards[i] = { ...data.report.cards[i], status: i === prefix ? 'capture_stopped' : 'not_attempted',
      amountCny: null, observedAt: null, conditionScope: null,
      ...(i === prefix ? { stage: 'validate_public_detail', reason: 'device_command_failed' } : {}) };
    if (i === prefix) {
      mkdirSync(capture.capture, { recursive: true });
      write(join(capture.cardDirectory, 'context.json'), capture.context);
      write(join(capture.capture, 'failure.json'), { status: 'capture_stopped', stage: 'validate_public_detail',
        reason: 'device_command_failed', observedAt: '2026-09-26T12:00:40.000Z' });
      write(join(capture.cardDirectory, 'observation.json'), { status: 'capture_stopped', stage: 'validate_public_detail',
        reason: 'device_command_failed', amountCny: null, observedAt: null, quoteEligible: false });
    }
  }
  Object.assign(data.report, { status: 'stopped', attempted: prefix + 1, observed: prefix, notExactMinimum: 0 });
  write(data.reportPath, data.report);
  data.partial = () => verifyAppDailyQuotes(data.directory, data.catalog, { now: NOW, allowStoppedPrefix: true });
  return data;
}

test('explicit transport-prefix verification preserves eighteen completed quotes and the original stopped report', t => {
  const data = stoppedFixture(t), before = readFileSync(data.reportPath);
  assert.throws(() => data.verify(), /incomplete_app_daily_report/);
  const result = data.partial();
  assert.equal(result.partial, true); assert.equal(result.originalStatus, 'stopped');
  assert.equal(result.verifiedPrefixCount, 18); assert.equal(result.quotes.length, 18);
  assert.equal(result.unquoted.length, 0); assert.equal(result.targetIdentities.length, 18);
  assert.deepEqual(result.excluded.map(row => row.status), ['capture_stopped', 'not_attempted']);
  assert.deepEqual(result.targetIdentities, data.catalog.slice(0, 18).map(card => card.identity));
  assert.deepEqual(result.selection, data.report.selection);
  assert.equal(result.reportSha256, sha256(before));
  assert.equal(result.quotes.at(-1).observedAt, '2026-09-26T12:00:35.000Z');
  assert.equal(result.quotes.at(-1).evidence.dailyReportSha256, sha256(before));
  assert.ok(result.excluded.every(row => row.quoteEligible === false && !('amountCny' in row)));
  assert.deepEqual(readFileSync(data.reportPath), before);
});

test('transport-prefix rejects other causes, stages, noncontiguous rows and count truncation', t => {
  for (const mutate of [
    d => { d.report.cards[18].reason = 'unexpected_public_input'; },
    d => { d.report.cards[18].reason = 'user_stop_requested'; },
    d => { d.report.cards[18].stage = 'verify_card_identity'; },
    d => { d.report.cards[19].status = 'observed'; d.report.observed++; },
    d => { d.report.cards[2].status = 'not_attempted'; d.report.observed--; },
    d => { d.report.attempted = 18; },
    d => { d.report.cards.pop(); },
    d => { d.report.selection.inputCount = 19; d.report.selection.selected = 19; d.report.cards.pop(); },
    d => { d.report.observed = 17; },
    d => { d.report.cards[18].amountCny = '0.01'; },
    d => { d.report.cards[19].observedAt = '2026-09-26T12:00:30.000Z'; },
  ]) {
    const data = stoppedFixture(t); mutate(data); write(data.reportPath, data.report);
    assert.throws(() => data.partial(), /app_/);
  }
  const empty = stoppedFixture(t, 0);
  assert.throws(() => empty.partial(), /unsupported_app_stopped_prefix/);
  assert.throws(() => verifyAppDailyQuotes(empty.directory, empty.catalog, { allowStoppedPrefix: 'true' }), /invalid_app_partial_option/);
});

test('failed and unattempted identities must match the catalog and failed context exactly', t => {
  for (const position of [18, 19]) {
    for (const field of ['sourceUrl', 'cardNumber', 'language']) {
      const data = stoppedFixture(t); data.report.cards[position][field] = data.report.cards[0][field];
      if (field === 'language') data.report.cards[position][field] = 'ja';
      write(data.reportPath, data.report);
      assert.throws(() => data.partial(), /duplicate_daily_uuid|daily_catalog_identity_mismatch/);
    }
  }
  const data = stoppedFixture(t);
  write(join(data.captures[18].cardDirectory, 'context.json'), data.captures[0].context);
  assert.throws(() => data.partial(), /daily_context_identity_mismatch/);
});

test('transport-prefix cannot hide modified successful evidence or contradictory failure artifacts', t => {
  for (const mutate of [
    d => writeFileSync(join(d.captures[0].capture, 'minimum.png'), 'modified'),
    d => { const p = join(d.captures[18].capture, 'failure.json'); write(p, { ...read(p), reason: 'identity_mismatch' }); },
    d => { const p = join(d.captures[18].capture, 'failure.json'); write(p, { ...read(p), observedAt: '2026-09-26T12:00:00Z' }); },
    d => { const p = join(d.captures[18].cardDirectory, 'observation.json'); write(p, { ...read(p), quoteEligible: true }); },
    d => write(join(d.captures[18].capture, 'session.json'), d.captures[17].session),
    d => mkdirSync(d.captures[19].cardDirectory),
    d => { d.captures[1].session.pages[0].capturedAt = '2026-09-26T12:00:00Z'; write(join(d.captures[1].capture, 'session.json'), d.captures[1].session); },
  ]) {
    const data = stoppedFixture(t); mutate(data);
    assert.throws(() => data.partial(), /app_/);
  }
});
