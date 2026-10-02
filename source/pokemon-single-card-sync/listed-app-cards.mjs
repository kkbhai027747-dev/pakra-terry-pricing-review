import { posix, win32 } from 'node:path';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const IDENTITY = /^pokemon:(zh-Hans|ja|en):([1-9]\d*):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;
const HASH = /^[a-f0-9]{64}$/;
const LABELS = { 'zh-Hans': '简中', ja: '日文', en: '英文' };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const text = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= 300 && !/[\r\n\u0000]/.test(value);
const exactMapping = (row) => Object.fromEntries(['identity', 'productGid', 'variantGid', 'sku', 'enabled'].map((key) => [key, row[key]]));

function evidenceShape(card) {
  const evidence = card.evidence, image = card.image;
  if (evidence?.kind !== 'verified_app_pack' || !['referenceSha256', 'contextSha256', 'evidenceSha256', 'imageMetadataSha256']
    .every((key) => typeof evidence[key] === 'string' && HASH.test(evidence[key]))) fail('invalid_app_card_evidence');
  const paths = [evidence.directory, evidence.packDirectory, evidence.listingPath, image?.path];
  if (!paths.every((value) => typeof value === 'string' && value.length > 0 && !/[\r\n\u0000]/.test(value))) fail('invalid_app_card_evidence');
  const path = /^[A-Za-z]:[\\/]/.test(evidence.directory) ? win32 : posix;
  if (!paths.every((value) => path.isAbsolute(value))
    || path.normalize(evidence.directory) !== path.join(evidence.packDirectory, card.versionId)
    || path.normalize(image.path) !== path.join(evidence.directory, 'image', 'card.png')) fail('invalid_app_card_evidence');
  if (image.sourceKind !== 'app_screenshot_crop' || image.originalImage !== false || !HASH.test(image.sha256 || '')
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 200 || image.width > 720 || image.height < 280 || image.height > 1280
    || image.width / image.height < 0.66 || image.width / image.height > 0.76) fail('invalid_app_card_image');
}

function contextOf(card, identity) {
  if (card.ip !== 'pokemon' || !Object.hasOwn(LABELS, card.language) || typeof card.setId !== 'string'
    || !/^[1-9]\d*$/.test(card.setId) || typeof card.versionId !== 'string' || !UUID.test(card.versionId)
    || card.identity !== identity || identity !== `pokemon:${card.language}:${card.setId}:${card.versionId}`
    || (card.id !== undefined && card.id !== identity) || card.sourceKind !== 'official_app_ui'
    || card.versionIdKind !== 'jihuanshe_pro_card_uuid' || card.sourceId !== null || card.imageUrl !== null
    || card.sourceUrl !== `https://api.jihuanshe.com/pro/cards/${card.versionId}`) fail('invalid_app_card_identity');
  if (!['setCode', 'packName', 'name', 'number'].every((key) => text(card[key]))
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(card.setCode) || card.languageLabel !== LABELS[card.language]
    || (card.originalName !== undefined && card.originalName !== '' && !text(card.originalName))
    || (card.rarity !== null && !text(card.rarity))
    || /原包|原盒|整盒|卡包|sealed/i.test(`${card.name} ${card.rarity || ''}`)
    || typeof card.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(card.capturedAt)
    || !Number.isFinite(Date.parse(card.capturedAt))) fail('invalid_app_card_metadata');
  evidenceShape(card);
  return { identity, language: card.language, setId: card.setId, setCode: card.setCode, packName: card.packName,
    cardName: card.name, cardNumber: card.number, shareUrl: card.sourceUrl, languageLabel: card.languageLabel,
    ...(card.originalName ? { originalName: card.originalName } : {}) };
}

/** Select exact, published variants only. Pure structural validation; evidence files must be reverified by the caller. */
export function selectListedAppCards(catalogCards, mapping, live) {
  if (!Array.isArray(mapping)) fail('invalid_mapping');
  const enabled = mapping.filter((row) => row?.enabled === true);
  if (!enabled.length) return { cards: [], mapping: [], skipped: [] };
  const identities = new Set(), variantIds = new Set();
  for (const row of enabled) {
    if (typeof row.identity !== 'string' || !IDENTITY.test(row.identity) || !PRODUCT.test(row.productGid || '')
      || !VARIANT.test(row.variantGid || '') || !text(row.sku)) fail('invalid_exact_mapping');
    if (identities.has(row.identity)) fail('mapping_identity_collision');
    if (variantIds.has(row.variantGid)) fail('mapping_variant_collision');
    identities.add(row.identity); variantIds.add(row.variantGid);
  }
  if (!Array.isArray(catalogCards)) fail('invalid_catalog');
  const catalog = new Map();
  for (const card of catalogCards) {
    if (!card || typeof card.identity !== 'string' || !card.identity) fail('invalid_catalog');
    if (catalog.has(card.identity)) fail('catalog_identity_collision');
    catalog.set(card.identity, card);
  }
  const contexts = new Map(), urls = new Set();
  for (const row of enabled) {
    const card = catalog.get(row.identity);
    if (!card) fail('mapped_card_missing');
    const context = contextOf(card, row.identity);
    if (urls.has(context.shareUrl)) fail('catalog_uuid_collision');
    urls.add(context.shareUrl); contexts.set(row.identity, context);
  }
  if (!live || !Array.isArray(live.products)) fail('invalid_live_products');
  const products = new Map(), variants = new Map();
  for (const product of live.products) {
    if (!product || !PRODUCT.test(product.id || '') || !Array.isArray(product.variants)
      || !['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(product.status)
      || (product.onlineStoreUrl !== null && product.onlineStoreUrl !== undefined && typeof product.onlineStoreUrl !== 'string')) fail('invalid_live_products');
    if (products.has(product.id)) fail('live_product_collision');
    products.set(product.id, product);
    for (const variant of product.variants) {
      if (!variant || !VARIANT.test(variant.id || '')) fail('invalid_live_variants');
      if (variants.has(variant.id)) fail('live_variant_collision');
      variants.set(variant.id, { variant, product });
    }
  }
  const selected = { cards: [], mapping: [], skipped: [] };
  for (const row of enabled) {
    const target = variants.get(row.variantGid);
    const skip = (reason) => selected.skipped.push({ ...exactMapping(row), reason });
    if (!target) { skip(products.has(row.productGid) ? 'variant_not_found' : 'product_or_variant_not_found'); continue; }
    if (target.product.id !== row.productGid) fail('variant_product_mismatch');
    if (target.variant.sku !== row.sku) fail('variant_sku_mismatch');
    if (target.product.status !== 'ACTIVE') { skip('product_not_active'); continue; }
    if (typeof target.product.onlineStoreUrl !== 'string' || !target.product.onlineStoreUrl.trim()) { skip('product_not_published'); continue; }
    selected.cards.push(contexts.get(row.identity));
    selected.mapping.push(exactMapping(row));
  }
  return selected;
}
