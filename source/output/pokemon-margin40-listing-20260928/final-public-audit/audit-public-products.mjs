import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STORE = 'egk2fq-va.myshopify.com';
const ORIGIN = 'https://pakracards.com';
const CATALOG = 'assets/p10-pokemon-single-card-catalog.json';
const EXPECTED = 543;
const PINS = {
  'final40-sources.json': '75e360bae4996c23b4dfb94cd35351675e6754d9dc5667340d264cc1778d47f3',
  'forty-price-ledger.json': 'f4f77dfb9a10fc1d8d29d9146178adc05746054a40b8b165dc3bf0d2cc1662ff',
  'final40-independent-audit.json': 'e6cd8e01dbc6109e465588676b6d9ae1cf485c37cb08d2434299b637f6d129ac',
  'remaining503-single-card-queue.json': 'ece88600b814061e1a8257b432143d4fea118926a44aeb86dbfea085b87059b4',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => String(value).split('/').at(-1);
const parse = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ''));
const jsonl = bytes => String(bytes).slice(0, String(bytes).lastIndexOf('\n')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const imagePath = value => new URL(value, ORIGIN).pathname;
const checkpoint = state => ({ status: state.status, verifiedProducts: state.verifiedProducts, catalogAdded: state.catalogAdded,
  completedBatches: state.completedBatches });

export function cents(value) {
  assert.match(String(value), /^(0|[1-9]\d*)(?:\.\d{1,2})?$/, 'Invalid monetary decimal');
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function priceCents(cost) {
  const result = ((2n * (cents(cost) + 8500n) + 688n) / 689n) * 100n;
  assert.ok(result <= BigInt(Number.MAX_SAFE_INTEGER), 'Unsafe price'); return Number(result);
}
function safeString(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (all, n) => {
    const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}
export function cjkFindings(value, pointer = '', found = []) {
  if (typeof value === 'string' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(safeString(value))) found.push(pointer);
  else if (Array.isArray(value)) value.forEach((item, i) => cjkFindings(item, `${pointer}/${i}`, found));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) cjkFindings(item, `${pointer}/${key}`, found);
  return found;
}
export function quoteAge(observedAt, checkedAt) {
  const observed = Date.parse(observedAt), checked = Date.parse(checkedAt);
  assert.ok(Number.isFinite(observed) && Number.isFinite(checked), 'Invalid evidence timestamp');
  const shanghaiDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  const ageHours = (checked - observed) / 3600000;
  return { observedAt, ageHours, sameShanghaiDay: shanghaiDay(observed) === shanghaiDay(checked),
    freshForNewListing: ageHours >= 0 && ageHours <= 4 && shanghaiDay(observed) === shanghaiDay(checked), renewed: false };
}
export function chooseSample(rows, perLanguage = 0) {
  if (!perLanguage) return rows;
  assert.ok(Number.isInteger(perLanguage) && perLanguage > 0);
  return ['zh-Hans', 'ja', 'en'].flatMap(language => {
    const group = rows.filter(row => row.language === language), count = Math.min(perLanguage, group.length);
    return Array.from({ length: count }, (_, i) => group[count === 1 ? 0 : Math.round(i * (group.length - 1) / (count - 1))]);
  });
}

export function prepareInputs() {
  const statePath = path.join(ROOT, 'remaining503-worker-state/progress.json');
  const journalPath = path.join(ROOT, 'remaining503-worker-state/journal.jsonl');
  for (let attempt = 0; attempt < 3; attempt++) {
    const bindings = new Map();
    const read = (file, expectedSha) => {
      const absolute = path.resolve(file), relative = path.relative('D:/CODEX', absolute);
      assert.ok(!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..', 'Source outside workspace');
      const bytes = fs.readFileSync(absolute), digest = sha(bytes);
      if (expectedSha) same(digest, expectedSha, `Source SHA mismatch: ${path.basename(absolute)}`);
      bindings.set(absolute, { path: absolute, sha256: digest }); return parse(bytes);
    };
    const pinned = name => read(path.join(ROOT, name), PINS[name]);
    const stateBytes = fs.readFileSync(statePath), journalBytes = fs.readFileSync(journalPath), state = parse(stateBytes);
    same(state.scopeKey, 'remaining503'); same(state.queueCount, 503); same(state.listingBatchCount, 26);
    const source = pinned('final40-sources.json'), ledger = pinned('forty-price-ledger.json'), queue = pinned('remaining503-single-card-queue.json');
    pinned('final40-independent-audit.json');
    same(source.store, STORE); same(source.count, 40); same(ledger.currency, 'USD'); same(ledger.rows.length, 40); same(queue.records.length, 503);
    const initial = source.sources.flatMap(ref => {
      const report = read(ref.readbackPath, ref.readbackSha256); same(report.store, STORE); return report.products;
    });
    same(initial.length, 40);
    const latest = read(source.first20LatestPriceReadback.path, source.first20LatestPriceReadback.sha256);
    const next = read(source.newPlan.path, source.newPlan.sha256);
    const oldPlan = read(source.existingPricePlan.path, source.existingPricePlan.sha256);
    same(latest.allChecksPassed, true); same(latest.records.length, 20); same(next.records.length, 20); same(oldPlan.changes.length, 20);
    const targets = initial.map(product => {
      const row = ledger.rows.find(item => item.identity === product.identity); assert.ok(row, 'Initial identity absent from ledger');
      same(row.productId, product.productId); same(row.variantId, product.variantId);
      const old = oldPlan.changes.find(item => item.identity === row.identity);
      const fresh = next.records.find(item => item.identity === row.identity);
      assert.ok(Boolean(old) !== Boolean(fresh), 'Initial price source ambiguous');
      same(row.saleUsd, old ? old.newPrice : fresh.fields.price);
      same(cents(row.costCny), cents(old ? old.sourceAmountCny : fresh.quote.amountCny));
      same(row.observedAt, old ? old.sourceObservedAt : fresh.quote.observedAt);
      const current = old ? latest.records.find(item => item.identity === row.identity)?.data?.productByIdentifier : null;
      if (old) { assert.ok(current); same(current.id, row.productId); same(current.variants.nodes[0].price, row.saleUsd); }
      const title = current ? current.title : fresh.fields.title;
      same(cjkFindings(title), [], 'Initial English title required');
      same(Number(cents(row.saleUsd)), priceCents(row.costCny));
      return { ...product, title, expectedPriceCents: priceCents(row.costCny), procurementCny: row.costCny, observedAt: row.observedAt, priceSource: 'initial40_approved_ledger' };
    });
    const completedReadbacks = new Map();
    for (const [index, batch] of state.completedBatches.entries()) {
      same(batch.number, index + 1); same(batch.count, index === 25 ? 3 : 20); same(batch.readbacks.length, batch.count);
      for (const ref of batch.readbacks) {
        assert.ok(!completedReadbacks.has(path.resolve(ref.path)), 'Duplicate completed readback');
        completedReadbacks.set(path.resolve(ref.path), ref.sha256);
      }
    }
    same(completedReadbacks.size, state.catalogAdded); assert.ok(state.catalogAdded >= 0 && state.catalogAdded <= state.verifiedProducts);
    const events = jsonl(journalBytes).filter(event => event.stage === 'product_verified');
    for (const [i, event] of events.entries()) {
      const completedSha = completedReadbacks.get(path.resolve(event.lastReadbackPath));
      if (i < state.catalogAdded) assert.ok(completedSha, 'Completed batch lacks matching product readback');
      const report = read(event.lastReadbackPath, completedSha), product = report.products?.[0];
      same(report.kind, 'verified_display_only_pokemon_products'); same(report.store, STORE); same(report.products.length, 1);
      same(product.identity, queue.records[i]?.identity, 'Frozen queue prefix mismatch');
      const planPath = path.join(path.dirname(path.dirname(event.lastReadbackPath)), 'prepared/listing-plan.json');
      const plan = read(planPath, report.planSha256), row = plan.records.find(item => item.identity === product.identity);
      assert.ok(row); same(plan.currency, 'USD'); same(plan.store, STORE); same(row.saleMode, 'display_only'); same(row.blockers, []);
      for (const field of ['title', 'handle', 'sku', 'sourceUuid', 'language', 'setId', 'cardNumber']) same(product[field], row[field], `New product ${field}`);
      same(product.price, row.fields.price); same(Number(cents(product.price)), priceCents(row.quote.amountCny));
      same(cjkFindings([row.fields.title, row.fields.descriptionHtml, row.fields.tags]), [], 'New English fields required');
      targets.push({ ...product, expectedPriceCents: priceCents(row.quote.amountCny), procurementCny: row.quote.amountCny,
        observedAt: row.quote.observedAt, priceSource: planPath, planSha256: report.planSha256 });
    }
    if (!stateBytes.equals(fs.readFileSync(statePath)) || !journalBytes.equals(fs.readFileSync(journalPath))) continue;
    same(events.length, state.verifiedProducts); assert.ok(targets.length <= EXPECTED);
    for (const key of ['identity', 'productId', 'variantId', 'imageId', 'sku', 'productHandle']) same(new Set(targets.map(row => row[key])).size, targets.length, `Duplicate ${key}`);
    for (const row of targets) { same(row.availableForSale, false); same(row.inventoryTracked, true); same(row.inventoryPolicy, 'DENY'); }
    const last = state.completedBatches.at(-1), catalogPath = last ? path.join(last.themeReadbackPath, CATALOG) : path.join(ROOT, 'v9-final40-readback', CATALOG);
    const catalog = read(catalogPath, last?.catalogSha256 || '8b60155da0d04deac77525cc0c77be112c85dac6aabe13564fd9eee1fd5a71e4');
    same(catalog.cards.length, 40 + state.catalogAdded); same(catalog.catalogIp, 'pokemon'); same(catalog.currency, 'USD'); same(catalog.purchaseMode, 'display_only');
    same(new Set(catalog.cards.map(card => card.sourceUuid)).size, catalog.cards.length); same(cjkFindings(catalog.cards.map(card => [card.cardName, card.rarity])), []);
    for (const target of targets.slice(0, catalog.cards.length)) {
      const card = catalog.cards.find(item => item.sourceUuid === target.sourceUuid); assert.ok(card);
      for (const field of ['productId', 'variantId', 'imageId']) same(card[field], id(target[field]));
      for (const field of ['productHandle', 'sku', 'language', 'setId', 'cardNumber']) same(card[field], target[field]);
      same(card.imageURL, target.imageURL); same(card.purchaseMode, 'display_only'); same(Object.hasOwn(card, 'price'), false);
    }
    const listingComplete = state.status === 'completed' && targets.length === EXPECTED && catalog.cards.length === EXPECTED && state.completedBatches.length === 26;
    const languages = Object.fromEntries(['zh-Hans', 'ja', 'en'].map(language => [language, targets.filter(row => row.language === language).length]));
    if (listingComplete) same(languages, { 'zh-Hans': 176, ja: 176, en: 191 });
    return { capturedAt: new Date().toISOString(), state: checkpoint(state), statePath, stateSha256: sha(stateBytes), journalSha256: sha(journalBytes),
      listingComplete, expectedSingles: EXPECTED, verifiedProducts: targets.length, catalogCards: catalog.cards.length, heldCardSets: 1,
      languages, bindings: [...bindings.values()], targets };
  }
  throw new Error('Progress changed during all three snapshot attempts; retry later');
}

export function verifyPublicProduct(product, target) {
  const failures = [];
  const check = (name, condition) => { if (!condition) failures.push(name); };
  check('product_id', id(product?.id) === id(target.productId));
  check('handle', product?.handle === target.productHandle); check('title', product?.title === target.title);
  check('description_present', typeof product?.description === 'string' && product.description.trim().length > 0);
  check('text_fields_present', Array.isArray(product?.tags) && Array.isArray(product?.options) && Array.isArray(product?.media));
  check('single_variant', Array.isArray(product?.variants) && product.variants.length === 1);
  const variants = Array.isArray(product?.variants) ? product.variants : [], variant = variants[0];
  check('variant_id', id(variant?.id) === id(target.variantId)); check('sku', variant?.sku === target.sku);
  check('product_price', product?.price === target.expectedPriceCents);
  check('variant_price', variant?.price === target.expectedPriceCents);
  check('product_unavailable', product?.available === false); check('variant_unavailable', variant?.available === false);
  check('inventory_managed', variant?.inventory_management === 'shopify');
  check('image_id', id(variant?.featured_image?.id) === id(target.imageId));
  check('image_product_id', id(variant?.featured_image?.product_id) === id(target.productId));
  check('media_id', id(variant?.featured_media?.id) === id(target.mediaId));
  const matchesImage = value => { try { return new URL(value, ORIGIN).hostname === 'cdn.shopify.com' && imagePath(value) === imagePath(target.imageURL); } catch { return false; } };
  check('variant_image', matchesImage(variant?.featured_image?.src));
  check('product_image', Array.isArray(product?.images) && product.images.some(image => matchesImage(typeof image === 'string' ? image : image.src)));
  check('featured_image', matchesImage(product?.featured_image));
  const englishFindings = cjkFindings({ title: product?.title, description: product?.description, tags: product?.tags,
    vendor: product?.vendor, type: product?.type, options: product?.options,
    variants: variants.map(row => ({ title: row?.title, name: row?.name, public_title: row?.public_title, options: row?.options,
      imageAlt: row?.featured_image?.alt, mediaAlt: row?.featured_media?.alt })),
    mediaAlts: Array.isArray(product?.media) ? product.media.map(row => row?.alt) : [] });
  check('no_cjk_web_fields', englishFindings.length === 0);
  return { passed: failures.length === 0, failures, englishFindings, priceCents: variant?.price ?? null,
    productAvailable: product?.available ?? null, variantAvailable: variant?.available ?? null };
}

export async function getPublicProduct(target, { fetchImpl = fetch, sleepImpl = sleep, timeoutMs = 20000 } = {}) {
  assert.match(target.productHandle, /^pokemon-single-(sc|jp|en)-[0-9]+-[0-9a-f-]+$/);
  const url = `${ORIGIN}/products/${target.productHandle}.js`, attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = new Date().toISOString(); let retry = false;
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
      const entry = { attempt, startedAt, finishedAt: null, httpStatus: response.status }; attempts.push(entry);
      if (response.status !== 200) {
        await response.body?.cancel(); entry.finishedAt = new Date().toISOString();
        retry = response.status === 429 || response.status >= 500;
        if (!retry || attempt === 3) return { status: 'unavailable', reason: `http_${response.status}`, url, attempts };
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Object.assign(new Error(), { code: 'body_too_large' }); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks); entry.finishedAt = new Date().toISOString();
        let product; try { product = parse(bytes); } catch { return { status: 'unavailable', reason: 'invalid_json', url, attempts }; }
        const age = response.headers.get('age'), ageSeconds = age !== null && /^\d+$/.test(age) ? Number(age) : null;
        return { status: 'received', url, attempts, receivedAt: entry.finishedAt, responseSha256: sha(bytes), product,
          cache: { date: response.headers.get('date'), ageSeconds, freshness: ageSeconds === null ? 'unknown' : ageSeconds <= 300 ? 'within_300s' : 'older_than_300s',
            cacheControl: response.headers.get('cache-control') } };
      }
    } catch (error) {
      const code = error.code === 'body_too_large' ? error.code : ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'network_error';
      if (attempts.at(-1)?.attempt === attempt) Object.assign(attempts.at(-1), { finishedAt: new Date().toISOString(), error: code });
      else attempts.push({ attempt, startedAt, finishedAt: new Date().toISOString(), error: code });
      retry = code !== 'body_too_large';
      if (!retry || attempt === 3) return { status: 'unavailable', reason: code, url, attempts };
    }
    if (retry) await sleepImpl(attempt === 1 ? 1000 : 3000);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'boolean', default: false },
    'allow-in-progress': { type: 'boolean', default: false }, 'sample-per-language': { type: 'string', default: '0' } } });
  const sample = Number(values['sample-per-language']); assert.ok(Number.isInteger(sample) && sample >= 0 && sample <= EXPECTED);
  const inputs = prepareInputs(), targets = chooseSample(inputs.targets, sample);
  if (values.run && !values['allow-in-progress']) assert.ok(inputs.listingComplete, 'Full listing is not complete; use --allow-in-progress only for an explicitly partial audit');
  const output = path.join(HERE, 'runs', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(output, { recursive: true });
  const expectedPath = path.join(output, 'expected-products.json');
  const expectedBytes = JSON.stringify({ kind: 'verified_thirtieth_expected_product_mapping', capturedAt: inputs.capturedAt,
    expectedSingles: EXPECTED, verifiedProducts: inputs.targets.length, catalogCards: inputs.catalogCards, listingComplete: inputs.listingComplete,
    rows: inputs.targets.map(row => ({ identity: row.identity, title: row.title, language: row.language, cardNumber: row.cardNumber,
      procurementCny: row.procurementCny, sourceObservedAt: row.observedAt, priceUsd: (row.expectedPriceCents / 100).toFixed(2),
      url: `${ORIGIN}/products/${row.productHandle}`, productId: row.productId, variantId: row.variantId, sku: row.sku,
      imageId: row.imageId, mediaId: row.mediaId, imageUrl: row.imageURL, priceSource: row.priceSource, planSha256: row.planSha256 || null,
      selectedForPublicAudit: targets.some(target => target.identity === row.identity) })), sourceBindings: inputs.bindings }, null, 2) + '\n';
  fs.writeFileSync(expectedPath, expectedBytes, { flag: 'wx' });
  const report = { kind: 'thirtieth_public_product_audit', startedAt: new Date().toISOString(), finishedAt: null,
    status: values.run ? 'running' : 'prepared', mode: values.run ? 'public_get_only' : 'local_preflight', store: STORE,
    origin: ORIGIN, themeId: '158535483580', output, selectedProducts: targets.length, samplePerLanguage: sample,
    inputs: { ...inputs, targets: undefined }, expectedMapping: { path: expectedPath, sha256: sha(expectedBytes) }, expected: targets, results: [], networkConcurrency: 2,
    writes: 0, browserStarted: false, deviceActions: 0,
    limitations: ['Checks public product JSON and saved V9 catalog mappings; does not render or freshly fetch V9 theme assets.',
      'No-CJK checks cover listed web fields, not printed card images; absence of CJK is not semantic translation review.',
      'Public availability is freshly checked; tracked/DENY and exact inventory zero rely on prior Admin readbacks.',
      'Public JSON prices use the shop base USD context; this endpoint does not return an explicit currency code.',
      'Compares approved listing prices. Quote age is reported separately; this audit does not refresh procurement prices.',
      'HTTP GET completion is timestamped; upstream cache freshness and actual image bytes are not independently proven.'] };
  const save = () => { const temporary = path.join(output, 'report.json.tmp'); fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(temporary, path.join(output, 'report.json')); };
  save();
  if (values.run) {
    fs.mkdirSync(path.join(output, 'products')); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
      for (;;) {
        const index = cursor++; if (index >= targets.length) break;
        const target = targets[index], fetched = await getPublicProduct(target);
        const proof = { identity: target.identity, expectedPriceCents: target.expectedPriceCents,
          quote: quoteAge(target.observedAt, new Date().toISOString()), ...fetched };
        if (fetched.status === 'received') {
          Object.assign(proof, verifyPublicProduct(fetched.product, target));
          if (fetched.cache.freshness === 'older_than_300s') { proof.passed = false; proof.failures.push('public_cache_older_than_300s'); }
        }
        const proofPath = path.join(output, 'products', `${id(target.variantId)}.json`), bytes = JSON.stringify(proof, null, 2) + '\n';
        fs.writeFileSync(proofPath, bytes, { flag: 'wx' });
        report.results.push({ index, identity: target.identity, status: proof.status, passed: proof.passed === true,
          reason: proof.reason || null, failures: proof.failures || [], receivedAt: proof.receivedAt || null,
          quote: proof.quote, proofPath, proofSha256: sha(bytes) }); save(); await sleep(250);
      }
    }));
    report.results.sort((a, b) => a.index - b.index);
    try { report.checkpointUnchanged = JSON.stringify(checkpoint(parse(fs.readFileSync(inputs.statePath)))) === JSON.stringify(inputs.state); }
    catch { report.checkpointUnchanged = false; report.checkpointReadFailure = 'checkpoint_unreadable'; }
    report.changedSourceBindings = inputs.bindings.filter(ref => { try { return sha(fs.readFileSync(ref.path)) !== ref.sha256; } catch { return true; } }).map(ref => ref.path);
    report.counts = { selected: targets.length, received: report.results.filter(row => row.status === 'received').length,
      passed: report.results.filter(row => row.passed).length, failed: report.results.filter(row => row.status === 'received' && !row.passed).length,
      unavailable: report.results.filter(row => row.status === 'unavailable').length,
      oldProcurementQuotes: report.results.filter(row => !row.quote.freshForNewListing).length };
    const successful = report.counts.passed === targets.length && report.changedSourceBindings.length === 0;
    report.fullPublicProductAuditComplete = successful && inputs.listingComplete && targets.length === EXPECTED && report.checkpointUnchanged;
    report.status = !successful ? 'failed_or_unavailable' : report.fullPublicProductAuditComplete ? 'passed_all_543_public_products' : 'passed_partial_snapshot';
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, selectedProducts: targets.length, listingComplete: inputs.listingComplete,
    fullPublicProductAuditComplete: report.fullPublicProductAuditComplete || false, counts: report.counts, output }));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await main(); if (result.status === 'failed_or_unavailable') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ status: 'preflight_or_audit_error', message: error.message })); process.exitCode = 1; }
}
