import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readJson, sha256 } from './files.mjs';
import { ShopifyClient, readListedVariants, UPDATE_PRICES_MUTATION, planDigest } from './shopify.mjs';
import { ListingShopifyClient } from './listing-shopify.mjs';
import { verifyAppDailyQuotes } from './app-quotes.mjs';
import { buildPricePlan, ORDER_NET_MARGIN_40_MODEL, ORDER_NET_MARGIN_40_POLICY } from './pricing.mjs';

const PROJECT = dirname(fileURLToPath(import.meta.url)), WORKSPACE = resolve(PROJECT, '..');
const STORE = 'egk2fq-va.myshopify.com', PUBLICATION = 'gid://shopify/Publication/173264044220';
export const PRICE_RULES = Object.freeze({ maxDropPercent: 25, maxIncreasePercent: 100, maxQuoteAgeHours: 4,
  formula: ORDER_NET_MARGIN_40_POLICY.formula, maxBatchSize: 10,
  shipping: { mode: 'independent_order_per_listing', procurementOrderCny: 15, internationalCny: 70 } });
// This proposal covers only the 100 actually completed products in the reviewed mapping snapshot.
export const COMPLETED_MAPPING_REPORT_SHA = 'd21d32a48444485246d240f75c5a07646678be67c53da76dfb83930926ce59a0';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const gid = (type, value) => typeof value === 'string' && new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(value);
function local(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('policy_absolute_path_required');
  const path = resolve(value), child = relative(WORKSPACE, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('policy_workspace_path_required');
  for (let cursor = path; cursor !== dirname(cursor); cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('policy_symlink_refused');
  }
  return path;
}
const hashFile = path => sha256(readFileSync(local(path)));
export function policyDigest(policy) {
  const { enabled, authorization, ...body } = policy;
  return planDigest(body);
}
function cents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) fail('invalid_live_price');
  const [whole, decimal = ''] = value.split('.'), result = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0) fail('invalid_live_price');
  return result;
}
function validatePolicy(policy) {
  if (policy.kind !== 'standing_pokemon_price_policy' || policy.schemaVersion !== 1 || policy.store !== STORE
    || policy.currency !== 'USD' || !isDeepStrictEqual(policy.rules, PRICE_RULES)
    || !Array.isArray(policy.targets) || policy.targets.length !== 100) fail('invalid_standing_policy');
  for (const field of ['identity', 'productGid', 'variantGid', 'sku', 'handle']) {
    if (policy.targets.some(row => typeof row[field] !== 'string' || !row[field])
      || new Set(policy.targets.map(row => row[field])).size !== policy.targets.length) fail('policy_target_collision');
  }
  for (const row of policy.targets) {
    if (!gid('Product', row.productGid) || !gid('ProductVariant', row.variantGid)
      || !['zh-Hans', 'ja', 'en'].includes(row.language) || !/^\d+$/.test(row.setId)
      || !/^[a-f0-9-]{36}$/.test(row.sourceUuid) || row.identity !== `pokemon:${row.language}:${row.setId}:${row.sourceUuid}`
      || !/^pokemon-single-(sc|jp|en)-\d+-[a-f0-9-]{36}$/.test(row.handle)) fail('invalid_policy_target');
  }
  for (const name of ['config', 'mapping', 'catalog', 'sourceManifest']) {
    if (!/^[a-f0-9]{64}$/.test(policy[`${name}Sha256`] ?? '')
      || hashFile(policy[`${name}Path`]) !== policy[`${name}Sha256`]) fail('policy_input_changed');
  }
  local(policy.auditDir);
  if (local(policy.revocationPath) !== join(local(policy.auditDir), 'stop.requested')) fail('invalid_revocation_path');
  const config = readJson(policy.configPath), mapping = readJson(policy.mappingPath), catalog = readJson(policy.catalogPath);
  if (config.store !== STORE || config.maxDropPercent !== 25 || config.maxIncreasePercent !== 100 || config.maxQuoteAgeHours !== 4
    || config.pricingModel !== ORDER_NET_MARGIN_40_MODEL || !isDeepStrictEqual(config.shipping, PRICE_RULES.shipping)
    || !Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 10
    || resolve(dirname(policy.configPath), config.mappingFile) !== local(policy.mappingPath)
    || resolve(dirname(policy.configPath), config.outputDir, 'catalog.json') !== local(policy.catalogPath)) fail('policy_config_mismatch');
  if (!Array.isArray(mapping) || mapping.length !== policy.targets.length || !sameSet(mapping.map(row => row.identity), policy.targets.map(row => row.identity))
    || !Array.isArray(catalog.cards)) fail('policy_mapping_mismatch');
  for (const target of policy.targets) {
    const row = mapping.find(item => item.identity === target.identity), cards = catalog.cards.filter(item => item.identity === target.identity);
    if (row.enabled !== true || ['productGid', 'variantGid', 'sku'].some(key => row[key] !== target[key]) || cards.length !== 1
      || cards[0].ip !== 'pokemon' || cards[0].language !== target.language || cards[0].setId !== target.setId
      || cards[0].versionId !== target.sourceUuid) fail('policy_mapping_mismatch');
  }
  const completed = completedSource(policy.sourceManifestPath);
  if (policy.mappingSha256 !== completed.mappingSha256 || !isDeepStrictEqual(policy.targets, completed.targets)) fail('completed_whitelist_changed');
  return { config, mapping, cards: catalog.cards };
}

function completedSource(manifestPath) {
  if (hashFile(manifestPath) !== COMPLETED_MAPPING_REPORT_SHA) fail('completed_mapping_report_not_reviewed');
  const manifest = readJson(manifestPath);
  if (manifest.kind !== 'completed_listing_daily_mapping_candidate' || manifest.mappingCount !== 100 || manifest.catalogCards !== 100
    || manifest.completedNewProducts?.length !== 60 || !Array.isArray(manifest.sourceBindings)) fail('completed_hundred_sources_required');
  const historicalBoundary = new Set(['progress.json', 'journal.jsonl'].map(name => resolve(WORKSPACE, 'output/pokemon-margin40-listing-20260928/remaining503-worker-state', name)));
  // The pinned report records this historical boundary; worker heartbeats are not immutable completed-product evidence.
  for (const ref of manifest.sourceBindings) {
    if (historicalBoundary.has(local(ref.path))) continue;
    if (hashFile(ref.path) !== ref.sha256) fail('final_source_changed');
  }
  if (hashFile(manifest.mapping.path) !== manifest.mapping.sha256) fail('final_source_changed');
  const initialBinding = manifest.sourceBindings.find(ref => ref.path.replaceAll('\\', '/').endsWith('/final40-sources.json'));
  if (!initialBinding) fail('completed_initial_sources_missing');
  const initial = readJson(initialBinding.path), products = [];
  for (const source of initial.sources) {
    if (hashFile(source.readbackPath) !== source.readbackSha256) fail('final_source_changed');
    products.push(...readJson(source.readbackPath).products);
  }
  for (const source of manifest.completedNewProducts) {
    if (hashFile(source.readback.path) !== source.readback.sha256) fail('final_source_changed');
    products.push(...readJson(source.readback.path).products);
  }
  const mapping = readJson(manifest.mapping.path);
  if (products.length !== 100 || !sameSet(products.map(row => row.identity), mapping.map(row => row.identity))) fail('final_source_identity_mismatch');
  return { mappingSha256: manifest.mapping.sha256, targets: mapping.map(record => {
    const row = products.find(item => item.identity === record.identity);
    if (record.enabled !== true || row.productId !== record.productGid || row.variantId !== record.variantGid || row.sku !== record.sku
      || row.availableForSale !== false || row.inventoryTracked !== true || row.inventoryPolicy !== 'DENY') fail('final_source_identity_mismatch');
    return { identity: row.identity, productGid: row.productId, variantGid: row.variantId, sku: row.sku, handle: row.handle,
      sourceUuid: row.sourceUuid, language: row.language, setId: row.setId };
  }) };
}

/** Constructs a disabled proposal from completed real readbacks. Never grants authorization. */
export function createDisabledPricePolicy({ manifestPath, configPath, auditDir }) {
  const completed = completedSource(local(manifestPath));
  const config = readJson(local(configPath)), mappingPath = resolve(dirname(configPath), config.mappingFile);
  const catalogPath = resolve(dirname(configPath), config.outputDir, 'catalog.json');
  const policy = { kind: 'standing_pokemon_price_policy', schemaVersion: 1, enabled: false, store: STORE, currency: 'USD',
    sourceManifestPath: local(manifestPath), sourceManifestSha256: hashFile(manifestPath), configPath: local(configPath), configSha256: hashFile(configPath),
    mappingPath: local(mappingPath), mappingSha256: hashFile(mappingPath), catalogPath: local(catalogPath), catalogSha256: hashFile(catalogPath),
    targets: completed.targets, rules: structuredClone(PRICE_RULES), auditDir: local(auditDir), revocationPath: join(local(auditDir), 'stop.requested'),
    authorization: { approved: false, approvedAt: null, policySha256: null, statement: null } };
  validatePolicy(policy);
  return policy;
}

function displayOnly(data, target, expectedPrice) {
  const p = data?.productByIdentifier, variants = p?.variants;
  if (!p || p.id !== target.productGid || p.handle !== target.handle || p.status !== 'ACTIVE'
    || p.onlineStoreUrl !== `https://pakracards.com/products/${target.handle}`
    || variants?.pageInfo?.hasNextPage !== false || variants.nodes?.length !== 1) fail('live_display_identity_changed');
  const v = variants.nodes[0], publications = p.resourcePublicationsV2;
  if (v.id !== target.variantGid || v.sku !== target.sku || cents(v.price) !== cents(expectedPrice)
    || v.availableForSale !== false || v.inventoryPolicy !== 'DENY' || v.inventoryQuantity !== 0 || v.inventoryItem?.tracked !== true
    || publications?.pageInfo?.hasNextPage !== false || !sameSet(publications.nodes.filter(x => x.isPublished === true).map(x => x.publication?.id), [PUBLICATION])) fail('live_display_or_price_changed');
}
function livePrice(live, target) {
  if (live?.currencyCode !== 'USD') fail('live_currency_changed');
  const products = live.products?.filter(p => p.id === target.productGid);
  if (products?.length !== 1 || products[0].status !== 'ACTIVE' || products[0].onlineStoreUrl !== `https://pakracards.com/products/${target.handle}`) fail('live_product_changed');
  const variants = products[0].variants.filter(v => v.id === target.variantGid);
  if (variants.length !== 1 || variants[0].sku !== target.sku) fail('live_variant_changed');
  cents(variants[0].price); return variants[0].price;
}
function exactFormula(plan) {
  if (!isDeepStrictEqual(plan.pricingPolicy, ORDER_NET_MARGIN_40_POLICY)
    || [...plan.changes, ...plan.unchanged].some(row => row.shippingCny !== '85.00'
      || BigInt(cents(row.newPrice)) !== ((2n * (BigInt(cents(row.sourceAmountCny)) + 8500n) + 688n) / 689n) * 100n)) fail('fixed_formula_mismatch');
  return plan;
}
export function exactPriceMutationPlan(plan, targets) {
  exactFormula(plan);
  if (plan.store !== STORE || plan.currency !== 'USD' || plan.blocked.length || plan.skipped.length
    || !sameSet([...plan.changes, ...plan.unchanged].map(row => row.identity), targets.map(row => row.identity))
    || targets.length < 1 || targets.length > 10) fail('price_plan_blocked');
  const changes = plan.changes.map(row => {
    const target = targets.find(item => item.identity === row.identity);
    if (['productGid', 'variantGid', 'sku'].some(key => row[key] !== target[key])) fail('price_mutation_identity_changed');
    return { identity: row.identity, object: 'ProductVariant', objectId: row.variantGid, productId: row.productGid,
      sku: row.sku, field: 'price', oldValue: row.oldPrice, newValue: row.newPrice, currency: 'USD',
      sourceObservedAt: row.sourceObservedAt, impact: 'Update only this listed variant price; remains display-only and unavailable.' };
  });
  return { kind: 'exact_price_mutation_plan', planSha256: planDigest(plan), selected: targets.length,
    unchanged: plan.unchanged.length, changes, approved: false };
}
function saveReview(policy, plan, evidence, appRun, runId, digest) {
  const directory = join(policy.auditDir, runId);
  mkdirSync(directory);
  const metadata = { runId, standingPolicySha256: digest, sourceDirectory: appRun, sourceReportSha256: evidence.reportSha256,
    sourceObservedAt: evidence.quotes.map(row => ({ identity: row.identity, observedAt: row.observedAt })) };
  const planPath = join(directory, 'plan.json'), reviewPath = join(directory, 'review.md');
  const exactPriceMutationPlanPath = join(directory, 'exact-price-mutation-plan.json');
  const selected = policy.targets.filter(target => [...plan.changes, ...plan.unchanged].some(row => row.identity === target.identity));
  writeFileSync(exactPriceMutationPlanPath, JSON.stringify(exactPriceMutationPlan(plan, selected), null, 2) + '\n', { flag: 'wx', flush: true });
  writeFileSync(planPath, JSON.stringify({ ...metadata, plan }, null, 2) + '\n', { flag: 'wx', flush: true });
  const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const rows = plan.changes.map(row => `| ProductVariant | ${cell(row.variantGid)} | ${cell(row.sku)} | price | ${row.oldPrice} USD | ${row.newPrice} USD | ${cell(row.sourceObservedAt)} |`);
  writeFileSync(reviewPath, [`# 每日售价变更清单`, '', `持续授权政策 SHA-256：${digest}`, `本次运行：${runId}`,
    `真实报价报告 SHA-256：${evidence.reportSha256}`, `原始证据目录：${appRun}`, '',
    `固定白名单 ${policy.targets.length} 个；本批 ${selected.length} 个，本次改变 ${plan.changes.length} 个，价格相同 ${plan.unchanged.length} 个。`,
    '预计影响：仅更新下列已上架变体的美元售价。商品保持仅展示、不可购买；库存、成本、划线价、图片及商品内容不写入。',
    '公式：ceil((最低在售价 CNY + 15 + 70) / (6.5 × (1 - 7% - 40%)))，向上取整美元。', '',
    '| 对象 | 对象 ID | SKU | 修改字段 | 原值 | 新值 | 报价观察时间 |', '|---|---|---|---|---:|---:|---|', ...rows, '',
    '此文件是本次完整审计清单；其摘要不代表新的人工批准。实际写入须符合独立持续授权政策，且每项写入前再次核验。', ''].join('\n'), { flag: 'wx', flush: true });
  return { planPath, reviewPath, planSha256: planDigest(plan), exactPriceMutationPlanPath };
}
async function notifyLocal(event) {
  const message = event.status === 'completed' ? `今日售价已更新并回读${event.applied}张。` : `每日售价同步已停止：${event.reason}。请检查D盘审计记录。`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned',
    '-File', join(PROJECT, 'notify-pack-status.ps1'), '-Title', '宝可梦每日售价', '-Message', message,
    '-Level', event.status === 'completed' ? 'Info' : 'Warning'], { windowsHide: true, shell: false, timeout: 25_000, stdio: 'ignore' });
  return { status: result.status === 0 ? 'requested' : 'failed', displayConfirmed: false };
}

/** Separate standing authorization; never fabricates a per-run manual approval SHA. */
export async function runAuthorizedPriceSync({ policyPath, appRun, batchIdentities, collect = false, previewOnly = false,
  expectedPolicySha256, reviewedPlanPath, expectedPlanSha256 }, dependencies = {}) {
  policyPath = local(policyPath);
  const initial = readJson(policyPath);
  if (!previewOnly && initial.enabled !== true) return { status: 'disabled', shopifyWrites: 0 };
  const now = dependencies.now ?? (() => new Date()), digest = policyDigest(initial), runId = randomUUID();
  let lock, lockPath, audit, reviewPath, requested = false, applied = 0, writes = 0;
  const notify = dependencies.notify ?? notifyLocal;
  const guard = () => {
    const p = readJson(policyPath), time = now(), auth = p.authorization;
    if ((!previewOnly && p.enabled !== true) || policyDigest(p) !== digest || existsSync(local(p.revocationPath))) fail('standing_authorization_revoked');
    if (!previewOnly && (expectedPolicySha256 !== digest || auth?.approved !== true || auth.policySha256 !== digest || typeof auth.statement !== 'string' || !auth.statement.trim()
      || !Number.isFinite(Date.parse(auth.approvedAt)) || Date.parse(auth.approvedAt) > time.getTime())) fail('standing_policy_not_approved');
    return { policy: p, ...validatePolicy(p) };
  };
  const journal = (status, values = {}) => {
    if (audit) appendFileSync(audit, JSON.stringify({ at: now().toISOString(), runId, standingPolicySha256: digest, status, ...values }) + '\n', { flush: true });
  };
  try {
    const { policy, config, mapping: allMappings, cards } = guard();
    if (collect) fail('collect_all_then_write_forbidden');
    if (!Array.isArray(batchIdentities) || batchIdentities.length < 1 || batchIdentities.length > 10
      || new Set(batchIdentities).size !== batchIdentities.length
      || batchIdentities.some(identity => !policy.targets.some(target => target.identity === identity))) fail('invalid_batch_selection');
    const targets = batchIdentities.map(identity => policy.targets.find(target => target.identity === identity));
    const mapping = batchIdentities.map(identity => allMappings.find(row => row.identity === identity));
    let reviewedPlan;
    if (!previewOnly) {
      if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256 ?? '')) fail('reviewed_plan_required');
      const document = readJson(local(reviewedPlanPath)); reviewedPlan = document.plan ?? document;
      if (planDigest(reviewedPlan) !== expectedPlanSha256 || !Number.isFinite(Date.parse(reviewedPlan.createdAt))
        || Date.parse(reviewedPlan.createdAt) > now().getTime()) fail('reviewed_plan_changed');
      exactPriceMutationPlan(reviewedPlan, targets);
    }
    mkdirSync(local(policy.auditDir), { recursive: true });
    audit = join(policy.auditDir, 'journal.jsonl'); reviewPath = join(policy.auditDir, 'review-required.json');
    if (existsSync(reviewPath)) fail('previous_write_requires_review');
    lockPath = resolve(dirname(policy.configPath), config.outputDir, 'apply-journal.jsonl.lock');
    mkdirSync(dirname(local(lockPath)), { recursive: true });
    try { lock = openSync(lockPath, 'wx'); } catch { fail('price_sync_locked'); }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId, standingPolicySha256: digest }));
    const client = dependencies.readLive && dependencies.writePrice ? null : new ShopifyClient({ store: STORE, cliPath: config.shopifyCliPath });
    const listing = dependencies.readDisplay ? null : new ListingShopifyClient({ store: STORE, cliPath: config.shopifyCliPath });
    const readLive = dependencies.readLive ?? (rows => readListedVariants(client, rows));
    const readDisplay = dependencies.readDisplay ?? (target => listing.execute('verify', { identifier: { handle: target.handle } }));
    const writePrice = dependencies.writePrice ?? ((productId, variantId, price) => client.execute(UPDATE_PRICES_MUTATION,
      { productId, variants: [{ id: variantId, price }] }, { allowMutations: true }));
    appRun = local(appRun);
    const verify = dependencies.verifyQuotes ?? verifyAppDailyQuotes;
    const quotes = () => {
      guard();
      const result = verify(appRun, cards, { now: now() });
      if (result.kind !== 'verified_app_quotes' || result.quotes?.length !== mapping.length || result.unquoted?.length !== 0
        || !sameSet(result.targetIdentities, mapping.map(row => row.identity))
        || !sameSet(result.quotes.map(q => q.identity), result.targetIdentities)
        || result.quotes.some(q => q.quoteEligible !== true || q.sourceKind !== 'official_app_ui')) fail('exact_batch_verified_quotes_required');
      return result;
    };
    const evidence = quotes(), evidenceDigest = planDigest({ quotes: evidence.quotes, reportSha256: evidence.reportSha256 });
    const live = structuredClone(await readLive(mapping));
    for (const target of targets) displayOnly(await readDisplay(target), target, livePrice(live, target));
    const freshPlan = exactFormula(buildPricePlan({ config, cards, mapping, quotes: evidence.quotes, live, now: now() }));
    exactPriceMutationPlan(freshPlan, targets);
    const withoutCreationTime = ({ createdAt, ...body }) => body;
    if (reviewedPlan && !isDeepStrictEqual(withoutCreationTime(freshPlan), withoutCreationTime(reviewedPlan))) fail('reviewed_plan_expired_or_changed');
    const plan = reviewedPlan ?? freshPlan;
    const review = saveReview(policy, plan, evidence, appRun, runId, digest);
    journal('preflight_verified', { plannedChanges: plan.changes.length, sourceReportSha256: evidence.reportSha256, ...review });
    if (previewOnly) return { status: 'preview_only', selected: targets.length, changes: plan.changes.length, unchanged: plan.unchanged.length,
      shopifyWrites: 0, standingPolicySha256: digest, journalPath: audit, ...review };
    for (const change of plan.changes) {
      const fresh = quotes();
      if (planDigest({ quotes: fresh.quotes, reportSha256: fresh.reportSha256 }) !== evidenceDigest) fail('quote_evidence_changed');
      const checked = exactFormula(buildPricePlan({ config, cards, mapping, quotes: fresh.quotes, live, now: now() }));
      if (checked.blocked.length || !isDeepStrictEqual(checked.changes, plan.changes)) fail('price_plan_expired_or_changed');
      const target = policy.targets.find(row => row.identity === change.identity), current = await readLive([mapping.find(row => row.identity === target.identity)]);
      if (cents(livePrice(current, target)) !== cents(change.oldPrice)) fail('live_price_drift');
      displayOnly(await readDisplay(target), target, change.oldPrice);
      guard();
      const finalQuotes = quotes();
      const finalPlan = exactFormula(buildPricePlan({ config, cards, mapping, quotes: finalQuotes.quotes, live, now: now() }));
      if (planDigest({ quotes: finalQuotes.quotes, reportSha256: finalQuotes.reportSha256 }) !== evidenceDigest
        || finalPlan.blocked.length || !isDeepStrictEqual(finalPlan.changes, plan.changes)) fail('price_plan_expired_or_changed');
      const details = { identity: target.identity, productGid: target.productGid, variantGid: target.variantGid, sku: target.sku,
        oldPrice: change.oldPrice, newPrice: change.newPrice, sourceObservedAt: change.sourceObservedAt };
      journal('price_write_requested', details); requested = true; writes += 1;
      const response = await writePrice(target.productGid, target.variantGid, change.newPrice), payload = response?.productVariantsBulkUpdate;
      const returned = payload?.productVariants;
      if (!Array.isArray(payload?.userErrors) || payload.userErrors.length || returned?.length !== 1 || returned[0].id !== target.variantGid
        || returned[0].product?.id !== target.productGid || returned[0].sku !== target.sku || cents(returned[0].price) !== cents(change.newPrice)) fail('price_write_result_unverified');
      if (cents(livePrice(await readLive([mapping.find(row => row.identity === target.identity)]), target)) !== cents(change.newPrice)) fail('price_readback_failed');
      displayOnly(await readDisplay(target), target, change.newPrice);
      journal('price_write_verified', details); requested = false; applied += 1;
    }
    journal('completed', { applied, unchanged: plan.unchanged.length });
    const result = { status: 'completed', applied, unchanged: plan.unchanged.length, shopifyWrites: writes, standingPolicySha256: digest, journalPath: audit, ...review };
    if (applied) { try { await notify(result); } catch { journal('notification_failed'); } }
    return result;
  } catch (error) {
    const reason = /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'authorized_price_sync_failed';
    if (requested && reviewPath && !existsSync(reviewPath)) writeFileSync(reviewPath, JSON.stringify({ runId, standingPolicySha256: digest, reason, applied,
      status: 'uncertain_write_review_required', at: now().toISOString() }) + '\n', { flag: 'wx' });
    journal('stopped', { reason, applied, shopifyWrites: writes, uncertainWrite: requested });
    const result = { status: 'stopped', reason, applied, shopifyWrites: writes, uncertainWrite: requested, journalPath: audit ?? null };
    if (!previewOnly) { try { await notify(result); } catch { journal('notification_failed'); } }
    return result;
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

/** Interface for the existing capture -> preview batch loop; never collects or writes. */
export function prepareDailyPriceBatch(options, dependencies = {}) {
  return runAuthorizedPriceSync({ ...options, previewOnly: true }, dependencies);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, options: { policy: { type: 'string' } } });
  if (!values.policy) fail('policy_path_required');
  const p = readJson(local(resolve(values.policy))); validatePolicy(p);
  const result = { status: 'check_only', enabled: p.enabled === true, approved: p.authorization?.approved === true,
    standingPolicySha256: policyDigest(p), targets: p.targets.length, writes: 0 };
  console.log(JSON.stringify(result));
  if (result.status === 'stopped') process.exitCode = 1;
}
