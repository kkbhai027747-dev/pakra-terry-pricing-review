import { BATCH003_PLAN_SHA, hasBatch003HistoricalEvidence } from './batch003-quote-date-exception.mjs';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './files.mjs';
import { ORDER_NET_MARGIN_40_POLICY } from './pricing.mjs';
import { listingPrice } from './prepare-listings.mjs';
import { inspectQueueQuoteRefresh, resolveQueueExecutionRow } from './queue-quote-refresh.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REMAINING_QUEUE_PATH = resolve(WORKSPACE, 'output/pokemon-margin40-listing-20260928/remaining250-queue.json');
export const REMAINING_QUEUE_SHA256 = 'c273be8a2074273f98f4c4ed12c8adcfda24820d83639f1787bae6825ede6cfd';
export const REMAINING503_QUEUE_PATH = resolve(WORKSPACE, 'output/pokemon-margin40-listing-20260928/remaining503-single-card-queue.json');
export const REMAINING503_QUEUE_SHA256 = 'ece88600b814061e1a8257b432143d4fea118926a44aeb86dbfea085b87059b4';
const QUEUES = Object.freeze([
  Object.freeze({ key: 'remaining250', path: REMAINING_QUEUE_PATH, sha256: REMAINING_QUEUE_SHA256, count: 250 }),
  Object.freeze({ key: 'remaining503', path: REMAINING503_QUEUE_PATH, sha256: REMAINING503_QUEUE_SHA256, count: 503 }),
]);
const EXCLUDED_CARD_SET = 'pokemon:ja:100145:01a08998-5d7c-75bb-bafb-b9fcd4f6e1dd';
const ORIGINALS_PATH = resolve(WORKSPACE, 'pokemon-single-card-sync/output/card-originals/manifest.json');
const ORIGINALS_SHA256 = 'aad039584ccac2a239c37525399511b1f0359c06ff39976f625492b74ac2e5a7';
const ORIGINAL_AUDIT_PATH = resolve(WORKSPACE, 'pokemon-single-card-sync/output/original-image-audit-20260927/manifest.json');
const ORIGINAL_AUDIT_SHA256 = 'a9ae3d22a09e1586700ba6054071890c20ed6e414c9c72ce4f967e4d1d23f9df';
export const QUEUE_PRICING = Object.freeze({ pricingModel: 'order_net_margin_40_fee_7', usdCnyRate: 6.5,
  paymentFeeRate: 0.07, selectedNetMarginPercent: 40, procurementOrderShippingCny: 15, internationalShippingCny: 70,
  otherCostsCny: 0, maxQuoteAgeHours: 4, quoteBusinessTimezone: 'Asia/Shanghai', quoteMetric: 'lowest_asking',
  shippingMode: 'independent_order_per_listing' });
export const QUEUE_THEME = Object.freeze({ id: '158535483580', requiredRole: 'unpublished',
  candidateFiles: ['assets/p10-pokemon-single-card-catalog.json'], firstBaselineMinCards: 40, preserveAllExistingCards: true });
const STORE = 'egk2fq-va.myshopify.com';
const COLLECTION = 'gid://shopify/Collection/522669424956';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = isDeepStrictEqual;
const includesFields = (actual, expected) => Object.entries(expected).every(([key, value]) => same(actual?.[key], value));
function pathInWorkspace(value, { file = false } = {}) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('queue_policy_invalid_path');
  const path = resolve(value), child = relative(WORKSPACE, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('queue_policy_path_outside_workspace');
  for (let cursor = path; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('queue_policy_path_symlink');
  }
  if (file && (!existsSync(path) || !lstatSync(path).isFile())) fail('queue_policy_file_missing');
  return path;
}
function jsonFile(path) {
  const bytes = readFileSync(pathInWorkspace(path, { file: true }));
  return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), digest: sha256(bytes) };
}
function identity(card) { return `pokemon:${card.language}:${card.setId}:${card.uuid}`; }
function validateQueue(queue, binding) {
  if (queue.records?.length !== binding.count || new Set(queue.records.map(row => row.identity)).size !== binding.count
    || !Array.isArray(queue.listingBatches) || queue.listingBatches.length !== Math.ceil(binding.count / 20)
    || queue.listingBatches.some((batch, index) => batch.number !== index + 1
      || batch.count !== Math.min(20, binding.count - index * 20) || batch.identities?.length !== batch.count)
    || !same(queue.listingBatches.flatMap(batch => batch.identities), queue.records.map(row => row.identity))) fail('queue_policy_queue_changed');
  if (binding.key === 'remaining503') {
    const legacy = jsonFile(REMAINING_QUEUE_PATH);
    if (legacy.digest !== REMAINING_QUEUE_SHA256
      || !same(queue.records.slice(0, 250).map(row => row.identity), legacy.value.records.map(row => row.identity))
      || queue.records.some(row => row.unitKind !== 'single_card' || row.identity === EXCLUDED_CARD_SET || /(?:\(\d*set\)|\d+~\d+)/i.test(row.cardNumber))
      || queue.records.filter(row => row.proposedImage.originalImage === true).length !== 7) fail('queue_policy_queue_changed');
  }
  if (!Array.isArray(queue.captureBatches) || queue.captureBatches.length !== Math.ceil(binding.count / 10)
    || queue.captureBatches.some((batch, index) => batch.number !== index + 1
      || batch.count !== Math.min(10, binding.count - index * 10) || batch.limit !== batch.count
      || batch.identities?.length !== batch.count)
    || !same(queue.captureBatches.flatMap(batch => batch.identities), queue.records.map(row => row.identity))) fail('queue_policy_queue_changed');
}

function validatePlanImage(row, frozen, card, queueKey) {
  const originalImage = queueKey === 'remaining503' && frozen.proposedImage.originalImage === true;
  const expected = { path: frozen.proposedImage.path, sha256: frozen.proposedImage.sha256,
    width: frozen.proposedImage.width ?? card.imageWidth, height: frozen.proposedImage.height ?? card.imageHeight,
    sourceKind: frozen.proposedImage.sourceKind, originalImage };
  if (originalImage) expected.sourceUrl = frozen.proposedImage.sourceUrl;
  if (!row.image || !same(Object.keys(row.image).sort(), Object.keys(expected).sort())
    || !includesFields(row.image, { ...expected, path: row.image.path })
    || resolve(row.image.path) !== resolve(expected.path)
    || !Number.isInteger(expected.width) || !Number.isInteger(expected.height) || expected.width < 1 || expected.height < 1
    || sha256(readFileSync(pathInWorkspace(row.image.path, { file: true }))) !== expected.sha256) fail('queue_policy_image_changed');
  if (!originalImage) {
    if (expected.sourceKind !== 'app_screenshot_crop' || resolve(expected.path) !== resolve(card.imagePath)
      || expected.sha256 !== card.imageSha256 || expected.width !== card.imageWidth || expected.height !== card.imageHeight
      || frozen.proposedImage.originalDownloadedBytes !== false) fail('queue_policy_image_changed');
    return;
  }
  const manifest = jsonFile(ORIGINALS_PATH), audit = jsonFile(ORIGINAL_AUDIT_PATH);
  if (manifest.digest !== ORIGINALS_SHA256 || audit.digest !== ORIGINAL_AUDIT_SHA256
    || resolve(manifest.value.auditPath) !== ORIGINAL_AUDIT_PATH || manifest.value.auditSha256 !== ORIGINAL_AUDIT_SHA256
    || manifest.value.cards?.length !== 8 || audit.value.cards?.length !== 8) fail('queue_policy_original_evidence_changed');
  const originals = manifest.value.cards.filter(item => item.uuid === frozen.sourceUuid);
  const audited = audit.value.cards.filter(item => item.uuid === frozen.sourceUuid);
  if (originals.length !== 1 || audited.length !== 1) fail('queue_policy_original_evidence_changed');
  const original = originals[0], { archivePath, ...originalAuditFields } = original, app = original.appEvidence;
  if (!same(originalAuditFields, audited[0]) || original.language !== frozen.language || original.setId !== frozen.setId
    || original.number !== frozen.cardNumber || original.name !== frozen.sourceRawFields.cardName || original.rarity !== frozen.sourceRawFields.rarity
    || original.shareUrl !== frozen.sourceContext.shareUrl || original.setCode !== card.setCode
    || resolve(archivePath) !== resolve(expected.path) || original.sha256 !== expected.sha256
    || original.width !== expected.width || original.height !== expected.height || original.sourceImageUrl !== expected.sourceUrl
    || original.sourceKind !== expected.sourceKind || original.sourceKind !== 'public_api_image_download'
    || original.originalDownloadedBytes !== true || original.upscaled !== false
    || original.imageMatch !== 'verified_by_exact_public_metadata_and_visual_comparison'
    || frozen.proposedImage.originalDownloadedBytes !== true || frozen.proposedImage.publisherMasterResolutionEstablished !== false
    || app?.headerVerified !== true || app.imageVerified !== true || resolve(app.directory) !== resolve(frozen.sourceEvidenceDirectory)
    || resolve(app.screenshotCropPath) !== resolve(card.imagePath) || app.screenshotCropSha256 !== card.imageSha256
    || resolve(frozen.reviewedCrop.path) !== resolve(card.imagePath) || frozen.reviewedCrop.sha256 !== card.imageSha256
    || sha256(readFileSync(pathInWorkspace(app.screenshotCropPath, { file: true }))) !== app.screenshotCropSha256) fail('queue_policy_original_evidence_changed');
  for (const [name, expectedSha] of [['context.json', app.contextSha256], ['evidence.json', app.evidenceSha256]]) {
    const file = resolve(app.directory, name), bound = frozen.evidenceFiles?.find(item => resolve(item.path) === file);
    if (bound?.sha256 !== expectedSha || sha256(readFileSync(pathInWorkspace(file, { file: true }))) !== expectedSha) fail('queue_policy_original_evidence_changed');
  }
  const context = jsonFile(resolve(app.directory, 'context.json')).value;
  if (!includesFields(context, frozen.sourceContext)
    || Object.hasOwn(context, 'rarity') && context.rarity !== original.contextRarity) fail('queue_policy_original_evidence_changed');
}

// This reads an external authorization record. It never creates or enables one.
export function inspectQueuePolicy({ policyPath, now = new Date() } = {}) {
  const path = pathInWorkspace(policyPath, { file: true }), { value: policy, digest } = jsonFile(path);
  if (policy.enabled !== true) fail('queue_policy_disabled');
  if (policy.kind !== 'one_off_pokemon_listing_policy' || policy.schemaVersion !== 1
    || policy.authorization?.approved !== true
    || policy.authorization.instruction !== '都按照40%上架吧，然后把剩余没上架的逐步补齐'
    || !Number.isFinite(Date.parse(policy.authorization.recordedAt))
    || Date.parse(policy.authorization.recordedAt) > new Date(now).getTime()
    || policy.store !== STORE || policy.saleMode !== 'display_only' || policy.newProductsOnly !== true
    || policy.maxBatchSize !== 20 || policy.existingCollectionId !== COLLECTION
    || !includesFields(policy.pricing, QUEUE_PRICING) || !includesFields(policy.targetTheme, QUEUE_THEME)
    || !same(Object.keys(policy.pricing).sort(), Object.keys(QUEUE_PRICING).sort())
    || !same(Object.keys(policy.targetTheme).sort(), Object.keys(QUEUE_THEME).sort())) fail('queue_policy_scope_invalid');
  const queuePath = pathInWorkspace(policy.queue?.path, { file: true });
  const binding = QUEUES.find(value => value.path === queuePath && value.sha256 === policy.queue?.sha256);
  if (!binding) fail('queue_policy_queue_binding_invalid');
  const stopFile = pathInWorkspace(policy.stopFile), revokeFile = pathInWorkspace(policy.revokeFile);
  const receiptDirectory = pathInWorkspace(policy.receiptDirectory);
  if (new Set([path, stopFile, revokeFile, receiptDirectory, queuePath]).size !== 5
    || existsSync(receiptDirectory) && !lstatSync(receiptDirectory).isDirectory()) fail('queue_policy_invalid_control_paths');
  if (existsSync(stopFile)) fail('queue_policy_stop_requested');
  if (existsSync(revokeFile)) fail('queue_policy_revoked');
  const { value: queue, digest: queueDigest } = jsonFile(queuePath);
  if (queueDigest !== binding.sha256) fail('queue_policy_queue_changed');
  validateQueue(queue, binding);
  const authorization = { kind: 'one_off_queue_policy', policyPath: path, policySha256: digest,
    queueSha256: queueDigest, queueKey: binding.key, queueCount: binding.count,
    listingBatchCount: queue.listingBatches.length, captureBatchCount: queue.captureBatches.length,
    instructionRecordedAt: policy.authorization.recordedAt };
  const guard = ({ now: checkTime = new Date() } = {}) => {
    const current = inspectQueuePolicy({ policyPath: path, now: checkTime });
    if (current.authorization.policySha256 !== digest) fail('queue_policy_changed');
    return current;
  };
  return { policy, queue, authorization, guard, stopFile, revokeFile, receiptDirectory };
}

export function inspectQueuePolicyPlan({ policyPath, planPath, identities, queueQuoteRefresh, now = new Date() } = {}) {
  const inspected = inspectQueuePolicy({ policyPath, now });
  const { policy, queue } = inspected, { value: plan, digest } = jsonFile(planPath);
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > 20
    || new Set(identities).size !== identities.length) fail('queue_policy_invalid_selection');
  const batch = queue.listingBatches.find(item => identities.every(id => item.identities.includes(id)));
  if (!batch || plan.kind !== 'pokemon_listing_preparation' || plan.store !== STORE || plan.currency !== 'USD'
    || plan.saleMode !== 'display_only' || plan.shopifyWritesPerformed !== false
    || !Array.isArray(plan.records) || plan.records.length < identities.length || plan.records.length > 20
    || new Set(plan.records.map(row => row.identity)).size !== plan.records.length
    || plan.records.some(row => !batch.identities.includes(row.identity))
    || identities.some(id => !plan.records.some(row => row.identity === id))) fail('queue_policy_plan_scope_invalid');
  if (!includesFields(plan.pricing, ORDER_NET_MARGIN_40_POLICY)
    || plan.pricing.shippingIncludedPerCard !== 85 || plan.pricing.maxQuoteAgeHours !== 4
    || !same(Object.keys(plan.pricing).sort(), [...Object.keys(ORDER_NET_MARGIN_40_POLICY),
      'shippingIncludedPerCard', 'maxQuoteAgeHours'].sort())) fail('queue_policy_pricing_invalid');
  const { value: frozenSnapshot, digest: frozenDigest } = jsonFile(batch.snapshotSource.path);
  if (frozenDigest !== batch.snapshotSource.sha256) fail('queue_policy_snapshot_changed');
  const { value: subset, digest: subsetDigest } = jsonFile(plan.snapshotPath);
  if (subsetDigest !== plan.snapshotSha256 || !Array.isArray(subset.cards)
    || subset.cards.length !== plan.records.length || new Set(subset.cards.map(identity)).size !== subset.cards.length
    || subset.cards.some(card => !plan.records.some(row => row.identity === identity(card))
      || !same(card, frozenSnapshot.cards.find(original => identity(original) === identity(card))))) fail('queue_policy_snapshot_mismatch');
  const byIdentity = new Map(queue.records.map(row => [row.identity, row]));
  const authorization = { ...inspected.authorization, listingBatchNumber: batch.number };
  let quoteRefresh;
  if (queueQuoteRefresh !== undefined) {
    if (!queueQuoteRefresh || !same(Object.keys(queueQuoteRefresh).sort(), ['path', 'sha256'])
      || !/^[a-f0-9]{64}$/.test(queueQuoteRefresh.sha256 ?? '')) fail('queue_policy_quote_refresh_binding_invalid');
    const refreshPath = pathInWorkspace(queueQuoteRefresh.path, { file: true });
    if (sha256(readFileSync(refreshPath)) !== queueQuoteRefresh.sha256) fail('queue_policy_quote_refresh_changed');
    quoteRefresh = inspectQueueQuoteRefresh({ refreshPath, planPath, planSha256: digest, authorization,
      receiptDirectory: inspected.receiptDirectory, now });
    if (quoteRefresh.refreshBinding.sha256 !== queueQuoteRefresh.sha256) fail('queue_policy_quote_refresh_changed');
  }
  for (const row of plan.records) {
    const frozen = byIdentity.get(row.identity), copy = frozen?.proposedDisplayFields;
    const expectedFields = { title: copy?.title, descriptionHtml: copy?.descriptionHtml, tags: copy?.tags,
      vendor: 'Pokémon', productType: 'Single Card', category: 'gid://shopify/TaxonomyCategory/ae-2-2-3-3',
      finalStatus: 'ACTIVE', publicationId: 'gid://shopify/Publication/173264044220',
      collections: ['gid://shopify/Collection/333313114300', 'gid://shopify/Collection/333313278140'],
      newCollectionHandle: 'pokemon-single-cards', inventory: { tracked: true, inventoryPolicy: 'DENY', quantityWrite: false } };
    if (!frozen || row.language !== frozen.language || row.setId !== frozen.setId || row.sourceUuid !== frozen.sourceUuid
      || row.cardNumber !== frozen.cardNumber || row.handle !== frozen.proposedHandle || row.sku !== frozen.proposedSku
      || row.title !== copy.title || row.title !== copy.imageAlt || !same(row.englishCopy, frozen.englishCopy)
      || row.cardName !== frozen.sourceRawFields.cardName || row.originalName !== (frozen.sourceRawFields.originalName ?? null)
      || row.rarity !== frozen.sourceRawFields.rarity || row.sourceUrl !== frozen.sourceContext.shareUrl
      || resolve(row.evidenceDirectory ?? '') !== resolve(frozen.sourceEvidenceDirectory)
      || row.productId !== null || row.variantId !== null || row.oldValue !== null || row.saleMode !== 'display_only'
      || row.readyForReview !== true || !same(row.blockers, []) || !includesFields(row.fields, expectedFields)
      || !same(Object.keys(row.fields ?? {}).sort(), [...Object.keys(expectedFields), 'price'].sort())) fail('queue_policy_frozen_record_mismatch');
    validatePlanImage(row, frozen, frozenSnapshot.cards.find(card => identity(card) === row.identity), inspected.authorization.queueKey);
    if (quoteRefresh?.historicalIdentities.includes(row.identity)) continue;
    const executionRow = quoteRefresh ? resolveQueueExecutionRow({ originalRow: row, inspectedRefresh: quoteRefresh }) : row;
    const quote = executionRow.quote;
    const historical = !quoteRefresh && digest === BATCH003_PLAN_SHA && hasBatch003HistoricalEvidence(row.quote, row.identity, now, digest);
    const price = listingPrice(quote, row.identity, new Date(now), { pricingModel: policy.pricing.pricingModel,
      ...(historical ? { historicalEvidence: digest } : {}) });
    if (price.reason || price.price !== executionRow.fields.price) fail('queue_policy_fresh_price_required');
  }
  const guard = ({ now: checkTime = new Date() } = {}) => {
    inspected.guard({ now: checkTime });
    const current = inspectQueuePolicyPlan({ policyPath, planPath, identities,
      queueQuoteRefresh: quoteRefresh?.refreshBinding, now: checkTime });
    if (current.digest !== digest) fail('queue_policy_plan_changed');
    return current;
  };
  return { ...inspected, plan, digest, records: identities.map(id => { const row = plan.records.find(row => row.identity === id);
    return quoteRefresh ? resolveQueueExecutionRow({ originalRow: row, inspectedRefresh: quoteRefresh }) : row; }), authorization, guard,
    ...(quoteRefresh ? { quoteRefresh } : {}) };
}
