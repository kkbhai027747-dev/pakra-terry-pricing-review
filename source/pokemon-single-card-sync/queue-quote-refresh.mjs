import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readCompletedCreationReceipt } from './creation-receipts.mjs';
import { verifyAppDailyQuotes } from './app-quotes.mjs';
import { listingPrice } from './prepare-listings.mjs';

const WORKSPACE = 'D:/CODEX', ROOT = path.join(WORKSPACE, 'output/pokemon-margin40-listing-20260928');
const PRICE_REFRESH_PLAN = '834a2a620e859038037856a73ab7fb311a0cefb001c9f3c9ad4ce0b4109aa967';
const inspectedRows = new WeakMap();
const STORE = 'egk2fq-va.myshopify.com', MODEL = 'order_net_margin_40_fee_7';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
const need = (value, code = 'queue_quote_refresh_invalid') => {
  if (!value) throw Object.assign(new Error(code), { code });
};
function local(file) {
  need(typeof file === 'string' && path.isAbsolute(file));
  const full = path.resolve(file), relative = path.relative(WORKSPACE, full);
  need(relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
  for (let cursor = full; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) need(!fs.lstatSync(cursor).isSymbolicLink());
  need(fs.statSync(full).isFile()); return full;
}

/** Binds fresh suffix quotes to an unchanged approved plan; never grants new authorization. */
export function inspectQueueQuoteRefresh({ refreshPath, planPath, planSha256, authorization, receiptDirectory, now = new Date(), checkBinding },
  { verifyQuotes = verifyAppDailyQuotes } = {}) {
  const bindings = new Map();
  const check = binding => {
    need(binding && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
    const file = local(binding.path), bytes = fs.readFileSync(file); need(sha(bytes) === binding.sha256, 'queue_quote_refresh_evidence_changed');
    need(!bindings.has(file) || bindings.get(file) === binding.sha256); bindings.set(file, binding.sha256); checkBinding?.({ path: file, sha256: binding.sha256 }); return bytes;
  };
  const json = binding => JSON.parse(check(binding).toString('utf8').replace(/^\uFEFF/, ''));
  const events = binding => check(binding).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  const refreshFile = local(refreshPath), refreshBinding = { path: refreshFile, sha256: sha(fs.readFileSync(refreshFile)) };
  const refresh = json(refreshBinding), planBinding = { path: local(planPath), sha256: planSha256 }, plan = json(planBinding);
  const changesPrices = refresh.kind === 'reviewed_price_update_queue_quote_refresh';
  need((changesPrices || refresh.kind === 'reviewed_same_price_queue_quote_refresh') && refresh.schemaVersion === 1
    && refresh.createsAuthorization === false && refresh.changesPlan === false && refresh.changesPrices === changesPrices
    && same(refresh.authorization, authorization) && same(refresh.plan, planBinding)
    && authorization?.queueKey === 'remaining503' && authorization.queueCount === 503
    && Number.isSafeInteger(authorization.listingBatchNumber) && authorization.listingBatchNumber >= 1 && authorization.listingBatchNumber <= 26
    && plan.store === STORE && plan.pricing?.pricingModel === MODEL && Array.isArray(plan.records)
    && plan.records.length === (authorization.listingBatchNumber === 26 ? 3 : 20));
  const batchDir = path.join(ROOT, 'remaining503-worker-state', `batch-${String(authorization.listingBatchNumber).padStart(3, '0')}`);
  need(path.resolve(planBinding.path) === path.resolve(batchDir, 'prepared/listing-plan.json')
    && path.resolve(receiptDirectory) === path.resolve(ROOT, 'remaining250-control/creation-receipts'));
  need(Array.isArray(refresh.completed) && refresh.completed.length > 0 && refresh.completed.length < plan.records.length);
  if (changesPrices) need(planSha256 === PRICE_REFRESH_PLAN && authorization.listingBatchNumber === 4
    && refresh.completed.length === 13 && Array.isArray(refresh.priceChanges) && refresh.priceChanges.length === 7);
  const historicalIdentities = plan.records.slice(0, refresh.completed.length).map(row => row.identity);
  const remainingIdentities = plan.records.slice(refresh.completed.length).map(row => row.identity);
  need(new Set(plan.records.map(row => row.identity)).size === plan.records.length
    && same(refresh.completed.map(entry => entry.identity), historicalIdentities)
    && same(refresh.remainingIdentities, remainingIdentities));
  for (const [index, entry] of refresh.completed.entries()) {
    const row = plan.records[index], report = json(entry.readback), journal = events(entry.journal);
    const directory = path.dirname(local(entry.readback.path));
    need(path.dirname(directory) === path.resolve(batchDir)
      && new RegExp(`^card-${String(index + 1).padStart(2, '0')}(?:-resumed-[a-f0-9]{12})?$`).test(path.basename(directory))
      && path.basename(entry.readback.path) === 'v9-verified-products.json'
      && path.resolve(entry.journal.path) === path.join(directory, 'journal.jsonl')
      && path.resolve(entry.receipt.path) === path.resolve(receiptDirectory, `${sha(row.identity)}.jsonl`));
    const product = report.products?.[0];
    need(report.kind === 'verified_display_only_pokemon_products' && report.store === STORE
      && report.planSha256 === planSha256 && report.products?.length === 1
      && product?.identity === row.identity && product.handle === row.handle && product.sku === row.sku
      && product.price === row.fields.price && product.availableForSale === false && product.inventoryTracked === true && product.inventoryPolicy === 'DENY'
      && journal.at(-1)?.status === 'completed' && journal.filter(event => event.status === 'product_completed').length === 1
      && journal.every(event => event.planSha256 === planSha256 && same(event.authorization, authorization))
      && journal.every(event => event.queueQuoteRefresh === undefined));
    const completed = journal.find(event => event.status === 'product_completed');
    need(completed.identity === row.identity && ['productId', 'variantId', 'mediaId'].every(key => completed[key] === product[key]));
    check(entry.receipt);
    readCompletedCreationReceipt({ receiptPath: entry.receipt.path, identity: row.identity, planSha256, authorization, product, checkBinding: check });
  }
  const snapshot = json({ path: plan.snapshotPath, sha256: plan.snapshotSha256 });
  const catalog = snapshot.cards.map(card => ({ identity: `pokemon:${card.language}:${card.setId}:${card.uuid}`, ip: 'pokemon',
    language: card.language, setId: card.setId, setCode: card.setCode, packName: card.packName, name: card.cardName,
    originalName: card.originalName || undefined, number: card.cardNumber, sourceKind: 'official_app_ui',
    versionIdKind: 'jihuanshe_pro_card_uuid', versionId: card.uuid, sourceUrl: card.shareUrl }));
  const supplied = json(refresh.verifiedQuotes);
  const verify = time => {
    const checkedAt = new Date(time); need(Number.isFinite(checkedAt.getTime()));
    for (const [file, digest] of bindings) check({ path: file, sha256: digest });
    const actual = verifyQuotes(supplied.directory, catalog, { now: checkedAt });
    for (const key of ['kind', 'source', 'metric', 'sourceKind', 'conditionScope', 'directory', 'reportSha256', 'selection', 'targetIdentities', 'quotes', 'unquoted']) {
      need(same(supplied[key], actual[key]), 'queue_quote_refresh_evidence_changed');
    }
    need(actual.kind === 'verified_app_quotes' && actual.unquoted?.length === 0
      && same(actual.targetIdentities, remainingIdentities) && same(actual.quotes.map(quote => quote.identity), remainingIdentities));
    for (const row of plan.records.slice(refresh.completed.length)) {
      const quote = actual.quotes.find(quote => quote.identity === row.identity);
      const observed = new Date(quote?.observedAt), age = checkedAt - observed;
      need(Number.isFinite(age) && age >= 0 && age <= 4 * 3600000 && day(observed) === day(checkedAt),
        'queue_quote_refresh_fresh_price_required');
      const price = listingPrice(quote, row.identity, checkedAt, { pricingModel: MODEL });
      need(!price.reason, 'queue_quote_refresh_fresh_price_required');
      if (!changesPrices) need(price.price === row.fields.price, 'queue_quote_refresh_price_changed');
    }
    if (changesPrices) need(same(refresh.priceChanges, plan.records.slice(refresh.completed.length).map(row => ({
      identity: row.identity, originalPrice: row.fields.price, executionPrice: listingPrice(
        actual.quotes.find(quote => quote.identity === row.identity), row.identity, checkedAt, { pricingModel: MODEL }).price,
    }))), 'queue_quote_refresh_price_review_mismatch');
    return actual;
  };
  const verified = verify(now);
  const executionRows = plan.records.slice(refresh.completed.length).map(row => {
    const quote = verified.quotes.find(item => item.identity === row.identity);
    return { ...structuredClone(row), quote: structuredClone(quote), fields: { ...row.fields,
      price: listingPrice(quote, row.identity, new Date(now), { pricingModel: MODEL }).price } };
  });
  const result = { executionRows: structuredClone(executionRows), refreshBinding, verifiedQuotesBinding: refresh.verifiedQuotes, historicalIdentities, remainingIdentities,
    quotes: structuredClone(verified.quotes), guard: ({ now: time = new Date() } = {}) => verify(time) };
  inspectedRows.set(result, { original: plan.records, executionRows });
  return result;
}

/** Uses only rows produced by this module's successful inspection. */
export function resolveQueueExecutionRow({ originalRow, inspectedRefresh }) {
  const known = inspectedRows.get(inspectedRefresh);
  need(known && same(known.original.find(row => row.identity === originalRow?.identity), originalRow));
  return structuredClone(known.executionRows.find(row => row.identity === originalRow.identity) ?? originalRow);
}

/** Historical evidence only: uses the recorded preflight instant, never the current write clock. */
export function resolveHistoricalQueueExecutionRow({ originalRow, planPath, planSha256, authorization,
  receiptDirectory, journalPath, journalSha256, checkBinding }, { verifyQuotes = verifyAppDailyQuotes } = {}) {
  const checked = (file, digest) => {
    need(/^[a-f0-9]{64}$/.test(digest ?? ''));
    const full = local(file), bytes = fs.readFileSync(full);
    need(sha(bytes) === digest, 'queue_quote_refresh_evidence_changed');
    checkBinding?.({ path: full, sha256: digest }); return bytes;
  };
  const journal = checked(journalPath, journalSha256).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  if (journal.every(event => event.queueQuoteRefresh === undefined)) return originalRow;
  const preflights = journal.filter(event => event.status === 'preflight_verified');
  const completed = journal.filter(event => event.status === 'product_completed');
  need(preflights.length === 1 && completed.length === 1 && journal.at(-1)?.status === 'completed'
    && completed[0].identity === originalRow?.identity
    && journal.every(event => event.planSha256 === planSha256 && same(event.authorization, authorization)));
  const preflight = preflights[0];
  need(preflight.queueQuoteRefresh !== undefined);
  const plan = JSON.parse(checked(planPath, planSha256).toString('utf8').replace(/^\uFEFF/, ''));
  need(same(plan.records.find(row => row.identity === originalRow.identity), originalRow));
  const binding = preflight.queueQuoteRefresh;
  need(binding && same(Object.keys(binding).sort(), ['path', 'sha256']));
  checked(binding.path, binding.sha256);
  const started = new Date(preflight.at), finished = new Date(completed[0].at), ended = new Date(journal.at(-1).at);
  need(Number.isFinite(started.getTime()) && finished >= started && ended >= finished
    && preflight.count === 1 && Array.isArray(preflight.quotes) && preflight.quotes.length === 1);
  const inspected = inspectQueueQuoteRefresh({ refreshPath: binding.path, planPath, planSha256, authorization,
    receiptDirectory, now: started, checkBinding }, { verifyQuotes });
  need(inspected.refreshBinding.sha256 === binding.sha256 && inspected.remainingIdentities.includes(originalRow.identity));
  const row = resolveQueueExecutionRow({ originalRow, inspectedRefresh: inspected });
  need(same(preflight.quotes[0], { identity: row.identity, observedAt: row.quote.observedAt,
    amountCny: row.quote.amountCny, approvedPrice: row.fields.price }), 'queue_quote_refresh_preflight_mismatch');
  return row;
}
