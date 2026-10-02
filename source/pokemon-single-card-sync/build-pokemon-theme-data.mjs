import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson, sha256 } from './files.mjs';
import { englishCardCopy, englishPackTitle } from './english-card-copy.mjs';
import { resolveHistoricalQueueExecutionRow } from './queue-quote-refresh.mjs';

const tail = (value, type) => {
  const match = new RegExp(`^gid://shopify/${type}/([1-9]\\d*)$`).exec(value ?? '');
  if (!match) throw new Error('invalid_verified_shopify_id');
  return match[1];
};

/** Build V9 assets only from completed Shopify readbacks and their exact approved plan. */
export function buildPokemonThemeData({ planPath, readbackPaths, themePath, queueHistory }) {
  const plan = readJson(planPath), digest = sha256(readFileSync(planPath));
  if (plan.kind !== 'pokemon_listing_preparation' || plan.saleMode !== 'display_only' || plan.currency !== 'USD'
    || plan.store !== 'egk2fq-va.myshopify.com') throw new Error('invalid_theme_listing_plan');
  const rows = new Map(plan.records.map(row => [row.identity, row]));
  if (rows.size !== plan.records.length) throw new Error('duplicate_theme_plan_identity');
  const cards = [], seen = new Set(), historyBindings = new Map();
  for (const path of readbackPaths) {
    const report = readJson(path);
    if (report.kind !== 'verified_display_only_pokemon_products' || report.store !== plan.store || report.planSha256 !== digest
      || !Array.isArray(report.products) || !report.products.length) throw new Error('unverified_theme_readback');
    for (const product of report.products) {
      const originalRow = rows.get(product.identity);
      const journalPath = resolve(dirname(path), 'journal.jsonl');
      const row = originalRow && queueHistory ? resolveHistoricalQueueExecutionRow({ originalRow, planPath, planSha256: digest,
        authorization: queueHistory.authorization, receiptDirectory: queueHistory.receiptDirectory, journalPath,
        journalSha256: sha256(readFileSync(journalPath)), checkBinding: binding => historyBindings.set(resolve(binding.path), binding) }) : originalRow;
      if (!row || seen.has(product.identity) || product.handle !== row.handle || product.price !== row.fields.price
        || product.productHandle !== row.handle || product.sku !== row.sku || product.sourceUuid !== row.sourceUuid
        || product.setId !== row.setId || product.imageURL !== product.imageUrl
        || product.cardNumber !== row.cardNumber || product.language !== row.language
        || product.availableForSale !== false || product.inventoryTracked !== true || product.inventoryPolicy !== 'DENY'
        || product.collectionId !== report.collectionId || product.originalImage !== row.image.originalImage
        || product.imageSourceKind !== row.image.sourceKind) throw new Error('theme_product_identity_mismatch');
      const url = new URL(product.imageUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || url.username || url.password) throw new Error('invalid_public_card_image');
      const copy = englishCardCopy(row);
      seen.add(product.identity);
      cards.push({ productId: tail(product.productId, 'Product'), productHandle: row.handle,
        variantId: tail(product.variantId, 'ProductVariant'), sku: row.sku, imageId: tail(product.imageId, 'ProductImage'),
        imageURL: url.href, sourceUuid: row.sourceUuid, language: row.language, setId: row.setId,
        cardName: copy.cardName, cardNumber: row.cardNumber, rarity: copy.rarity, purchaseMode: 'display_only' });
    }
  }
  if (!cards.length) throw new Error('no_verified_theme_products');
  const root = resolve(themePath), catalogPath = resolve(root, 'assets/p10-pokemon-single-card-catalog.json');
  const boxesPath = resolve(root, 'assets/p10-pokemon-single-card-boxes.json');
  const ipPath = resolve(root, 'assets/p10-single-card-boxes.json');
  const boxes = readJson(boxesPath), ips = readJson(ipPath);
  if (boxes.catalogIp !== 'pokemon' || !Array.isArray(boxes.boxes) || !Array.isArray(ips.ips)) throw new Error('invalid_pokemon_theme_assets');
  const cover = cards.find(card => card.language === 'zh-Hans') ?? cards[0];
  const ip = ips.ips.find(item => item.key === 'pokemon');
  if (!ip) throw new Error('pokemon_ip_entry_missing');
  if (!ip.image) { ip.image = cover.imageURL; ip.imageAlt = `${cover.cardName} · ${cover.cardNumber}`; }
  else if (ip.imageAlt) ip.imageAlt = englishPackTitle(ip.imageAlt);
  const pokemonIp = boxes.ips?.find(item => item.key === 'pokemon');
  if (pokemonIp) { pokemonIp.image = ip.image; pokemonIp.imageAlt = ip.imageAlt; }
  for (const box of boxes.boxes) {
    const card = cards.find(item => `${item.language.toLowerCase()}-${item.setId}` === box.waveKey);
    if (card) { box.image = card.imageURL; box.imageAlt = `${card.cardName} · ${card.cardNumber}`; }
    if (card || box.seriesKey === 'pokemon') {
      if (box.title !== undefined) box.title = englishPackTitle(box.title);
      if (box.imageAlt) box.imageAlt = englishPackTitle(box.imageAlt);
    }
  }
  const catalog = { schemaVersion: 1, catalogIp: 'pokemon', currency: 'USD', purchaseMode: 'display_only', cards,
    groups: [], spotlightCards: [], shelves: {} };
  const outputs = [[catalogPath, catalog], [boxesPath, boxes], [ipPath, ips]];
  for (const binding of historyBindings.values()) {
    if (sha256(readFileSync(binding.path)) !== binding.sha256) throw new Error('theme_price_history_changed');
  }
  for (const [path, value] of outputs) writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return { cards: cards.length, sourcePlanSha256: digest, files: outputs.map(([path]) => ({ path, sha256: sha256(readFileSync(path)) })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, options: { plan: { type: 'string' }, readback: { type: 'string', multiple: true }, theme: { type: 'string' } } });
  if (!values.plan || !values.readback?.length || !values.theme) throw new Error('plan_readbacks_theme_required');
  console.log(JSON.stringify(buildPokemonThemeData({ planPath: resolve(values.plan), readbackPaths: values.readback.map(path => resolve(path)), themePath: resolve(values.theme) })));
}
