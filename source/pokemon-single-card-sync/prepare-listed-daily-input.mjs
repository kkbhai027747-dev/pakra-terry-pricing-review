import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readJson, sha256 } from './files.mjs';
import { verifyCapturedCard } from './verify-app-pack.mjs';
import { selectListedAppCards } from './listed-app-cards.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)), WORKSPACE = resolve(ROOT, '..');
const STORE = 'egk2fq-va.myshopify.com';
const fail = code => { throw new Error(code); };
const id = (value, type) => typeof value === 'string' && new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(value);
const keysEqual = (a, b, keys) => keys.every(key => a?.[key] === b?.[key]);
function local(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('daily_input_absolute_path_required');
  const path = resolve(value), child = relative(WORKSPACE, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('daily_input_workspace_path_required');
  for (let cursor = path; cursor !== dirname(cursor); cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('daily_input_symlink');
  }
  return path;
}
function unique(rows, key, reason) {
  if (!Array.isArray(rows) || rows.some(row => typeof row?.[key] !== 'string' || !row[key])) fail(reason);
  const index = new Map(rows.map(row => [row[key], row]));
  if (index.size !== rows.length) fail(reason);
  return index;
}
function publicUrl(value, { handle, image = false } = {}) {
  let url; try { url = new URL(value); } catch { fail('invalid_listing_readback_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (image && url.hostname !== 'cdn.shopify.com') || (handle && url.pathname !== `/products/${handle}`)) fail('invalid_listing_readback_url');
}
function catalogCard(row, snapshot) {
  const matches = snapshot.cards.filter(card => card.uuid === row.sourceUuid);
  if (matches.length !== 1) fail('listed_snapshot_identity_missing');
  const card = matches[0], packs = snapshot.packs.filter(pack => pack.context.language === row.language && pack.context.setId === row.setId);
  if (packs.length !== 1 || !keysEqual(card, row, ['language', 'setId', 'cardName', 'cardNumber', 'rarity']) ||
      (card.originalName ?? '') !== (row.originalName ?? '') || card.shareUrl !== row.sourceUrl) fail('listed_snapshot_identity_mismatch');
  const pack = packs[0], directory = local(card.evidenceDirectory), packDirectory = local(pack.directory), listingPath = local(pack.listingPath);
  if (directory !== resolve(packDirectory, row.sourceUuid) || directory !== local(row.evidenceDirectory) ||
      sha256(readFileSync(listingPath)) !== pack.referenceSha256) fail('listed_pack_reference_changed');
  const listing = readJson(listingPath), references = listing.observations.filter(item => item.cardNumber === row.cardNumber);
  if (references.length !== 1 || (references[0].rarity ?? null) !== row.rarity) fail('listed_card_reference_mismatch');
  const verified = verifyCapturedCard(directory, listing.context, references[0]), context = verified.context;
  if (verified.uuid !== row.sourceUuid || verified.image.sha256 !== card.imageSha256 || verified.image.path !== local(card.imagePath) ||
      context.shareUrl !== row.sourceUrl || !keysEqual(context, card, ['language', 'languageLabel', 'setId', 'setCode', 'packName', 'cardName', 'cardNumber']) ||
      (context.originalName ?? '') !== (card.originalName ?? '')) fail('listed_card_evidence_mismatch');
  const evidence = readJson(resolve(directory, 'evidence.json'));
  return { identity: row.identity, ip: 'pokemon', language: context.language, setId: context.setId, setCode: context.setCode,
    packName: context.packName, sourceKind: 'official_app_ui', versionIdKind: 'jihuanshe_pro_card_uuid', sourceId: null,
    versionId: verified.uuid, number: context.cardNumber, rarity: row.rarity, name: context.cardName,
    originalName: context.originalName ?? '', languageLabel: context.languageLabel, sourceUrl: context.shareUrl,
    imageUrl: null, image: verified.image, capturedAt: new Date(evidence.header.capturedAt).toISOString(),
    evidence: { kind: 'verified_app_pack', directory, packDirectory, listingPath, referenceSha256: pack.referenceSha256,
      contextSha256: sha256(readFileSync(resolve(directory, 'context.json'))), evidenceSha256: sha256(readFileSync(resolve(directory, 'evidence.json'))),
      imageMetadataSha256: sha256(readFileSync(resolve(directory, 'image/image.json'))) } };
}

/** Prepare a separate daily-preview bundle. Never modifies the source catalog, mappings, approval or Shopify. */
export function prepareListedDailyInput({ planPath, approvalPath, executionDirs, configPath = resolve(ROOT, 'config.json'), outputDir }) {
  for (const value of [planPath, approvalPath, configPath, outputDir, ...(executionDirs ?? [])]) local(value);
  if (existsSync(outputDir)) fail('daily_bundle_output_must_be_new');
  const plan = readJson(planPath), digest = sha256(readFileSync(planPath)), approval = readJson(approvalPath), config = readJson(configPath);
  if (plan.kind !== 'pokemon_listing_preparation' || plan.store !== STORE || plan.currency !== 'USD' || plan.saleMode !== 'display_only' ||
      config.store !== STORE || approval.approved !== true || approval.planSha256 !== digest ||
      !Array.isArray(approval.identities) || approval.identities.length < 1 || approval.identities.length > 20 ||
      new Set(approval.identities).size !== approval.identities.length) fail('invalid_daily_listing_approval');
  const rows = unique(plan.records, 'identity', 'duplicate_listing_plan_identity'), allowed = new Set(approval.identities);
  if ([...allowed].some(identity => !rows.has(identity))) fail('approved_listing_identity_missing');
  const snapshotPath = local(plan.snapshotPath);
  if (sha256(readFileSync(snapshotPath)) !== plan.snapshotSha256) fail('listed_snapshot_hash_mismatch');
  const snapshot = readJson(snapshotPath);
  if (snapshot.kind !== 'app_card_preview' || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.packs)) fail('invalid_listing_snapshot');
  const mappings = [], products = [], seen = new Set(), productIds = new Set(), variantIds = new Set(), sources = [];
  if (!Array.isArray(executionDirs) || !executionDirs.length) fail('completed_listing_execution_required');
  for (const directory of executionDirs) {
    const readbackPath = local(resolve(directory, 'v9-verified-products.json')), mappingPath = local(resolve(directory, 'mapping-candidates.json'));
    const report = readJson(readbackPath), candidates = readJson(mappingPath), byIdentity = unique(candidates, 'identity', 'invalid_listing_mapping_candidates');
    if (report.kind !== 'verified_display_only_pokemon_products' || report.store !== STORE || report.planSha256 !== digest ||
        !id(report.collectionId, 'Collection') || !Array.isArray(report.products) || !report.products.length || report.products.length !== candidates.length) fail('unverified_listing_execution');
    for (const product of report.products) {
      const row = rows.get(product.identity), mapping = byIdentity.get(product.identity);
      if (!allowed.has(product.identity) || seen.has(product.identity) || !mapping || !keysEqual(product, row, ['identity', 'sku', 'sourceUuid', 'language', 'setId', 'cardNumber']) ||
          product.handle !== row.handle || product.productHandle !== row.handle || product.price !== row.fields.price ||
          product.collectionId !== report.collectionId || product.availableForSale !== false || product.inventoryTracked !== true || product.inventoryPolicy !== 'DENY' ||
          product.imageURL !== product.imageUrl || product.originalImage !== row.image.originalImage || product.imageSourceKind !== row.image.sourceKind ||
          !keysEqual(mapping, product, ['identity', 'sku', 'sourceUuid', 'language', 'setId']) || mapping.enabled !== true ||
          mapping.productGid !== product.productId || mapping.variantGid !== product.variantId) fail('listing_mapping_readback_mismatch');
      for (const [key, type] of [['productId', 'Product'], ['variantId', 'ProductVariant'], ['mediaId', 'MediaImage'], ['imageId', 'ProductImage'], ['imageSourceId', 'ImageSource']]) {
        if (!id(product[key], type)) fail('invalid_listing_shopify_id');
      }
      if (productIds.has(product.productId) || variantIds.has(product.variantId)) fail('listing_shopify_id_collision');
      publicUrl(product.productUrl, { handle: row.handle }); publicUrl(product.imageUrl, { image: true });
      seen.add(product.identity); productIds.add(product.productId); variantIds.add(product.variantId);
      mappings.push(mapping); products.push(product);
    }
    sources.push({ readbackPath, readbackSha256: sha256(readFileSync(readbackPath)), mappingPath, mappingSha256: sha256(readFileSync(mappingPath)) });
  }
  if (seen.size !== allowed.size) fail('approved_listings_not_all_completed');
  const oldMappingPath = local(resolve(dirname(configPath), config.mappingFile)), oldCatalogPath = local(resolve(dirname(configPath), config.outputDir, 'catalog.json'));
  const oldMapping = readJson(oldMappingPath), oldCatalog = readJson(oldCatalogPath);
  const mappingIndex = unique(oldMapping, 'identity', 'existing_mapping_identity_collision'), catalogIndex = unique(oldCatalog.cards, 'identity', 'existing_catalog_identity_collision');
  const catalog = { ...oldCatalog, cards: [...oldCatalog.cards] }, mergedMapping = [...oldMapping];
  const stable = ['ip', 'language', 'setId', 'setCode', 'packName', 'sourceKind', 'versionIdKind', 'sourceId', 'versionId', 'number', 'rarity', 'name', 'originalName', 'languageLabel', 'sourceUrl', 'imageUrl'];
  for (const mapping of mappings) {
    const previous = mappingIndex.get(mapping.identity);
    if (previous && !keysEqual(previous, mapping, ['identity', 'productGid', 'variantGid', 'sku', 'enabled'])) fail('existing_mapping_conflict');
    if (oldMapping.some(item => item.identity !== mapping.identity && (item.variantGid === mapping.variantGid || item.productGid === mapping.productGid || item.sku === mapping.sku))) fail('existing_mapping_target_collision');
    if (!previous) mergedMapping.push(mapping);
    const card = catalogCard(rows.get(mapping.identity), snapshot), existing = catalogIndex.get(card.identity);
    if (existing && (!keysEqual(existing, card, stable) || !isDeepStrictEqual(existing.image, card.image) ||
        !isDeepStrictEqual(existing.evidence, card.evidence))) fail('existing_catalog_identity_conflict');
    if (!existing) catalog.cards.push(card);
  }
  const live = { products: products.map(product => ({ id: product.productId, status: 'ACTIVE', onlineStoreUrl: product.productUrl,
    variants: [{ id: product.variantId, sku: product.sku, price: product.price }] })) };
  const selected = selectListedAppCards(catalog.cards, mappings, live);
  if (selected.cards.length !== allowed.size || selected.skipped.length) fail('listed_daily_selection_incomplete');
  const dailyConfig = { ...config, outputDir: 'output', mappingFile: 'mapping.json', shopifyCliPath: resolve(dirname(configPath), config.shopifyCliPath) };
  if (dailyConfig.android?.adbPath) dailyConfig.android = { ...dailyConfig.android, adbPath: resolve(dirname(configPath), dailyConfig.android.adbPath) };
  const manifest = { kind: 'prepared_verified_listed_daily_input', preparedAt: new Date().toISOString(), store: STORE,
    approvedPlanSha256: digest, mappedProducts: mappings.length, catalogCards: catalog.cards.length,
    previousCatalogCards: oldCatalog.cards.length, previousMappings: oldMapping.length, mergedMappings: mergedMapping.length,
    sourceCatalogPath: oldCatalogPath, sourceCatalogSha256: sha256(readFileSync(oldCatalogPath)),
    sourceMappingPath: oldMappingPath, sourceMappingSha256: sha256(readFileSync(oldMappingPath)), sources,
    shopifyWritesPerformed: false, sourceFilesModified: false, scheduledTaskRegistered: false };
  mkdirSync(resolve(outputDir, 'output'), { recursive: true });
  for (const [path, value] of [['config.json', dailyConfig], ['mapping.json', mappings], ['mapping.merged-candidate.json', mergedMapping],
    ['output/catalog.json', catalog], ['listed-contexts.json', selected.cards.map(({ identity, ...context }) => context)], ['preparation.json', manifest]]) {
    writeFileSync(resolve(outputDir, path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return { ...manifest, configPath: resolve(outputDir, 'config.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, options: { plan: { type: 'string' }, approval: { type: 'string' },
    execution: { type: 'string', multiple: true }, config: { type: 'string' }, output: { type: 'string' } } });
  console.log(JSON.stringify(prepareListedDailyInput({ planPath: values.plan, approvalPath: values.approval,
    executionDirs: values.execution, configPath: values.config, outputDir: values.output })));
}
