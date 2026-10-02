import { allowsBatch003DateException, hasBatch003HistoricalEvidence } from './batch003-quote-date-exception.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, readJson } from './files.mjs';
import { verifyAppPack } from './verify-app-pack.mjs';
import { verifyAppDailyQuotes } from './app-quotes.mjs';
import { englishCardCopy } from './english-card-copy.mjs';
import { calculateCnCardSalePrice } from '../collaboration/pakra-projects-handoff/scripts/lib/cn-card-pricing-policy.mjs';
import { calculateOrderMarginPrices } from './order-margin-pricing.mjs';
import { usesOrderNetMargin40, ORDER_NET_MARGIN_40_POLICY } from './pricing.mjs';

const LANGUAGES = { 'zh-Hans': ['SC', 'Simplified Chinese'], ja: ['JP', 'Japanese'], en: ['EN', 'English'] };
const date = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const contextKeys = ['language', 'languageLabel', 'setId', 'setCode', 'packName', 'cardName', 'originalName', 'cardNumber', 'shareUrl'];

export function listingPrice(quote, identity, now = new Date(), { pricingModel, historicalEvidence } = {}) {
  const orderMargin40 = usesOrderNetMargin40(pricingModel);
  if (!quote) return { price: null, reason: 'today_price_required' };
  if (quote.identity !== identity || quote.quoteEligible !== true || quote.sourceKind !== 'official_app_ui'
    || quote.metric !== 'lowest_asking' || quote.currency !== 'CNY' || quote.available !== true
    || !quote.evidence || typeof quote.amountCny !== 'string' || !/^\d+\.\d{2}$/.test(quote.amountCny) || Number(quote.amountCny) <= 0
    || !Number.isSafeInteger(Number(quote.amountCny.replace('.', '')))) {
    return { price: null, reason: 'verified_lowest_asking_required' };
  }
  const observed = new Date(quote.observedAt), age = now - observed;
  const historical = historicalEvidence !== undefined && hasBatch003HistoricalEvidence(quote, identity, now, historicalEvidence);
  if (historicalEvidence !== undefined && (!orderMargin40 || !historical)) return { price: null, reason: 'historical_evidence_required' };
  if (!Number.isFinite(age) || age < 0 || !historical && (age > 4 * 3_600_000 || date(observed) !== date(now)
    && !allowsBatch003DateException(quote, identity, now, pricingModel))) {
    return { price: null, reason: 'stale_or_future_price' };
  }
  let sale;
  if (orderMargin40) {
    try {
      sale = calculateOrderMarginPrices({ procurementCny: quote.amountCny }).reference40.saleUsd;
    } catch { return { price: null, reason: 'invalid_calculated_price' }; }
  } else {
    sale = calculateCnCardSalePrice({ costCny: Number(quote.amountCny), usdCnyRate: 6.5,
      listingMode: 'single_variant_product' }).saleUsd;
  }
  if (sale === null || !Number.isSafeInteger(Number(sale)) || Number(sale) <= 0) return { price: null, reason: 'invalid_calculated_price' };
  return { price: Number(sale).toFixed(2), reason: null };
}

/** Local preparation only: reverify images, identities and fresh quote evidence before producing a review. */
export function prepareListings({ snapshotPath, originalsPath, outputDir, quoteRuns = [], saleMode = 'pending', pricingModel, now = new Date() }) {
  const orderMargin40 = usesOrderNetMargin40(pricingModel);
  if (!['pending', 'procure_to_order', 'display_only'].includes(saleMode)) throw new Error('invalid_sale_mode');
  const snapshot = readJson(snapshotPath), originals = readJson(originalsPath);
  if (snapshot.kind !== 'app_card_preview' || !snapshot.cards?.length || !Array.isArray(snapshot.packs)) throw new Error('invalid_verified_snapshot');
  const verified = new Map();
  for (const pack of snapshot.packs) {
    const actual = verifyAppPack(pack.directory, pack.listingPath);
    if (actual.referenceSha256 !== pack.referenceSha256) throw new Error('changed_pack_reference');
    const listing = readJson(pack.listingPath);
    const rarities = new Map(listing.observations.map(row => [row.cardNumber, row.rarity ?? null]));
    for (const row of actual.cards) verified.set(row.uuid, { ...row, rarity: rarities.get(row.cardNumber), directory: resolve(pack.directory, row.uuid) });
  }
  const auditBytes = readFileSync(originals.auditPath);
  if (sha256(auditBytes) !== originals.auditSha256) throw new Error('original_audit_hash_mismatch');
  const audit = JSON.parse(auditBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const auditIndex = new Map((audit.cards ?? []).map(card => [card.uuid, card]));
  const identities = new Set(), originalIndex = new Map();
  for (const image of originals.cards ?? []) {
    if (originalIndex.has(image.uuid)) throw new Error('duplicate_original_image');
    const audited = auditIndex.get(image.uuid), actual = verified.get(image.uuid);
    const fields = ['language', 'setId', 'setCode', 'number', 'name', 'rarity', 'sha256', 'width', 'height', 'sourceImageUrl', 'sourceKind', 'imageMatch'];
    if (!audited || !actual || fields.some(key => image[key] !== audited[key])
      || JSON.stringify(image.appEvidence) !== JSON.stringify(audited.appEvidence)
      || image.appEvidence?.screenshotCropSha256 !== actual.image.sha256
      || image.appEvidence.contextSha256 !== sha256(readFileSync(resolve(actual.directory, 'context.json')))
      || image.appEvidence.evidenceSha256 !== sha256(readFileSync(resolve(actual.directory, 'evidence.json')))) throw new Error('original_audit_binding_mismatch');
    originalIndex.set(image.uuid, image);
  }
  const catalog = snapshot.cards.map(card => {
    const actual = verified.get(card.uuid);
    if (!LANGUAGES[card.language] || !actual || actual.image.sha256 !== card.imageSha256 || actual.rarity !== card.rarity
      || contextKeys.some(key => (actual.context[key] ?? '') !== (card[key] ?? ''))) throw new Error('snapshot_identity_changed');
    const identity = `pokemon:${card.language}:${card.setId}:${card.uuid}`;
    if (identities.has(identity)) throw new Error('duplicate_listing_identity');
    identities.add(identity);
    return { identity, ip: 'pokemon', language: card.language, setId: card.setId, setCode: card.setCode,
      packName: card.packName, name: card.cardName, originalName: card.originalName, number: card.cardNumber,
      sourceKind: 'official_app_ui', versionIdKind: 'jihuanshe_pro_card_uuid', versionId: card.uuid, sourceUrl: card.shareUrl };
  });
  const quotes = new Map();
  for (const run of quoteRuns) {
    for (const quote of verifyAppDailyQuotes(resolve(run), catalog, { now }).quotes) {
      const previous = quotes.get(quote.identity);
      if (!previous || Date.parse(quote.observedAt) > Date.parse(previous.observedAt)) quotes.set(quote.identity, quote);
      else if (quote.observedAt === previous.observedAt && quote.amountCny !== previous.amountCny) throw new Error('conflicting_price_evidence');
    }
  }
  const records = snapshot.cards.map((card, index) => {
    const identity = catalog[index].identity, [languageCode, languageName] = LANGUAGES[card.language];
    const original = originalIndex.get(card.uuid);
    let image = { path: card.imagePath, sha256: card.imageSha256, width: card.imageWidth, height: card.imageHeight,
      sourceKind: 'app_screenshot_crop', originalImage: false };
    if (original) {
      if (original.language !== card.language || original.setId !== card.setId || original.number !== card.cardNumber
        || original.imageMatch !== 'verified_by_exact_public_metadata_and_visual_comparison'
        || original.originalDownloadedBytes !== true) throw new Error('original_identity_mismatch');
      image = { path: original.archivePath, sha256: original.sha256, width: original.width, height: original.height,
        sourceKind: original.sourceKind, originalImage: true, sourceUrl: original.sourceImageUrl };
    }
    if (sha256(readFileSync(image.path)) !== image.sha256) throw new Error('listing_image_hash_mismatch');
    const quote = quotes.get(identity), priceResult = listingPrice(quote, identity, now, { pricingModel });
    const bundle = /(?:\(\d*set\)|\d+~\d+)/i.test(card.cardNumber);
    const format = bundle ? 'Card Set' : 'Single Card';
    const englishCopy = englishCardCopy(card, { strict: false });
    const displayName = englishCopy.cardName ?? 'Translation pending';
    const blockers = [priceResult.reason, !englishCopy.ready && 'english_copy_required', saleMode === 'pending' && 'sale_mode_confirmation_required', bundle && saleMode !== 'display_only' && 'bundle_unit_review_required'].filter(Boolean);
    const title = `Pokémon ${displayName} ${card.cardNumber} — ${languageName} ${format}`;
    const description = `<p>${escapeHtml(displayName)} · ${escapeHtml(card.cardNumber)}</p><ul><li>Language: ${languageName}</li><li>Set: ${escapeHtml(englishCopy.packName ?? 'Translation pending')} (${escapeHtml(card.setCode)})</li><li>Rarity: ${escapeHtml(englishCopy.rarity ?? 'Translation pending')}</li><li>Format: ${format}</li></ul>${saleMode === 'procure_to_order' ? '<p>Procured after ordering. The image represents the card design.</p>' : '<p>For display only. Purchasing is currently unavailable.</p>'}`;
    return { identity, productId: null, variantId: null, oldValue: null,
      handle: `pokemon-single-${languageCode.toLowerCase()}-${card.setId}-${card.uuid}`,
      sku: `PKM-${languageCode}-${card.setId}-${card.uuid.toUpperCase()}`, title,
      language: card.language, setId: card.setId, sourceUuid: card.uuid, cardNumber: card.cardNumber,
      cardName: card.cardName, originalName: card.originalName ?? null, rarity: card.rarity, englishCopy,
      fields: { title, descriptionHtml: description, vendor: 'Pokémon', productType: bundle ? 'Single Card Bundle' : 'Single Card',
        category: 'gid://shopify/TaxonomyCategory/ae-2-2-3-3',
        tags: [...new Set(['Pokémon', 'Pokemon', bundle ? 'Single Card Bundle' : 'Single Card', languageName, card.setCode, englishCopy.packName, englishCopy.cardName].filter(Boolean))],
        finalStatus: 'ACTIVE', publicationId: 'gid://shopify/Publication/173264044220', price: priceResult.price,
        collections: ['gid://shopify/Collection/333313114300', 'gid://shopify/Collection/333313278140'],
        newCollectionHandle: 'pokemon-single-cards',
        inventory: saleMode === 'pending' ? null : { tracked: saleMode === 'display_only', inventoryPolicy: saleMode === 'procure_to_order' ? 'CONTINUE' : 'DENY', quantityWrite: false } },
      image, quote: quote ?? null, sourceUrl: card.shareUrl, evidenceDirectory: card.evidenceDirectory,
      saleMode, blockers, readyForReview: blockers.length === 0,
      publicationReadbackRequired: ['exact_identity_and_sku', 'ready_media_bound_to_variant', 'approved_price',
        ...(saleMode === 'display_only' ? ['inventory_tracked_true', 'inventory_policy_deny', 'available_for_sale_false'] : [])],
      impact: 'Create one exact-language card product, bind its image and single variant, add to Pokémon and single-card collections, publish to Online Store after readback.' };
  });
  const plan = { kind: 'pokemon_listing_preparation', createdAt: now.toISOString(), store: 'egk2fq-va.myshopify.com', currency: 'USD',
    shopifyWritesPerformed: false, snapshotPath: resolve(snapshotPath), snapshotSha256: sha256(readFileSync(snapshotPath)),
    pricing: orderMargin40 ? { ...ORDER_NET_MARGIN_40_POLICY, shippingIncludedPerCard: 85, maxQuoteAgeHours: 4 } : {
      formula: 'ceil(lowestAskingCny * 2 / 0.94 / 6.5)', shippingIncludedPerCard: 0,
      procurementOrderShippingCny: 15, shippingAccounting: 'procurement_order_only', maxQuoteAgeHours: 4 },
    collection: { id: null, oldValue: null, title: 'Pokémon Single Cards', handle: 'pokemon-single-cards', type: 'manual',
      publicationId: 'gid://shopify/Publication/173264044220', publicationName: '在线商店' },
    saleMode, counts: { total: records.length, originals: records.filter(r => r.image.originalImage).length,
      crops: records.filter(r => !r.image.originalImage).length, freshPrices: records.filter(r => r.fields.price !== null).length,
      readyForReview: records.filter(r => r.readyForReview).length }, records };
  const pilotUrls = new Set(readJson(resolve(dirname(fileURLToPath(import.meta.url)), 'pilot-contexts.json')).map(c => c.shareUrl));
  const firstPerLanguage = Object.keys(LANGUAGES).map(language => snapshot.cards.find(c => c.language === language && pilotUrls.has(c.shareUrl))
    ?? snapshot.cards.find(c => c.language === language)).filter(Boolean);
  const firstUrls = new Set(firstPerLanguage.map(c => c.shareUrl));
  const ordered = [...firstPerLanguage, ...snapshot.cards.filter(c => !firstUrls.has(c.shareUrl))];
  const contexts = ordered.map(card => Object.fromEntries(contextKeys.filter(key => card[key] !== undefined
    && (key !== 'originalName' || card[key].trim())).map(key => [key, card[key]])));
  const out = resolve(outputDir); mkdirSync(out, { recursive: true });
  for (const [name, value] of Object.entries({ 'listing-plan.json': plan, 'quote-contexts.json': contexts,
    'first-20-quote-contexts.json': contexts.slice(0, 20), 'quote-catalog.json': { cards: catalog } })) {
    writeFileSync(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  }
  const priceDescription = orderMargin40
    ? '售价：ceil((最低在售价 + 国内采购运费15 + 国际运费70) ÷ (6.5 × (1 − 7% − 40%)))。每张按独立采购、独立发货计算，批次内不摊分运费。'
    : '售价：ceil(最低在售价 × 2 ÷ 0.94 ÷ 6.5)。每次采购运费 ¥15 只计订单成本。';
  const lines = ['# 宝可梦单卡上架准备', '', `共 ${records.length} 张；原图 ${plan.counts.originals} 张，已批准裁切图 ${plan.counts.crops} 张。`,
    `当前新鲜报价 ${plan.counts.freshPrices} 张，可提交写入确认 ${plan.counts.readyForReview} 张。尚未写入 Shopify。`, '',
    priceDescription, '',
    '新商品与变体尚无 ID；逐项 handle、SKU、字段原值 null、新值、图片哈希及证据见 listing-plan.json。',
    '新集合：Pokémon Single Cards / pokemon-single-cards；现有 ip-pokemon 和 type-single-cards 只新增本批商品成员。', '',
    '|卡号|语言|商品名称|新售价 USD|待完成|', '|---|---|---|---|---|',
    ...records.map(r => `|${r.cardNumber}|${r.language}|${r.title.replaceAll('|', '\\|')}|${r.fields.price ?? '待今日采价'}|${r.blockers.join(', ') || '待最终写入批准'}|`)];
  writeFileSync(resolve(out, '上架准备清单.md'), lines.join('\n') + '\n');
  const cardsHtml = records.map(r => `<article><img loading="lazy" src="${escapeHtml(pathToFileURL(r.image.path).href)}" alt="${escapeHtml(r.title)}"><div><small>${escapeHtml(LANGUAGES[r.language][1])} · ${escapeHtml(r.cardNumber)}</small><h2>${escapeHtml(r.title)}</h2><p class="price">${r.fields.price ? '$' + r.fields.price : '等待今日报价'}</p><p>仅展示 · 暂不开放购买</p><details><summary>核对来源</summary><p>${r.image.originalImage ? '源站下载 JPG' : '已核验 App 裁切图'} · ${r.image.width} × ${r.image.height}</p><p>${escapeHtml(r.sku)}</p><a href="${escapeHtml(r.sourceUrl)}">集换社来源</a></details></div></article>`).join('');
  writeFileSync(resolve(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; base-uri 'none'"><title>宝可梦单卡上架预览</title><style>body{margin:0;background:#f7f6fa;color:#24212b;font:15px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:28px 20px}h1{font-size:28px;margin:0}h2{font-size:16px;margin:8px 0}.notice{padding:16px;background:#eee9f4;border-left:4px solid #72538e;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}article{background:white;border:1px solid #ddd5e5;border-radius:10px;overflow:hidden}article>img{display:block;width:calc(100% - 24px);height:auto;margin:12px}article>div{padding:0 16px 18px}p{margin:6px 0}.price{font-weight:700;font-size:18px}small,details{color:#655c6e;font-size:12px}details p{overflow-wrap:anywhere}a{color:#60417c}</style><main><h1>宝可梦单卡上架预览</h1><div class="notice"><strong>本地审核预览，尚未写入 Shopify</strong><p>${records.length} 张卡牌 · ${plan.counts.originals} 张原图 · ${plan.counts.crops} 张核验裁切图 · ${plan.counts.freshPrices} 张已取得今日报价</p><p>${escapeHtml(priceDescription)}</p></div><p><a href="上架准备清单.md">逐项修改清单</a> · <a href="listing-plan.json">完整数据与证据</a></p><section class="grid">${cardsHtml}</section></main></html>\n`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, options: { snapshot: { type: 'string' }, originals: { type: 'string' },
    output: { type: 'string' }, 'quote-run': { type: 'string', multiple: true }, 'sale-mode': { type: 'string', default: 'pending' },
    'pricing-model': { type: 'string' } } });
  if (!values.snapshot || !values.originals || !values.output) throw new Error('snapshot_originals_output_required');
  const plan = prepareListings({ snapshotPath: values.snapshot, originalsPath: values.originals, outputDir: values.output,
    quoteRuns: values['quote-run'] ?? [], saleMode: values['sale-mode'], pricingModel: values['pricing-model'] });
  console.log(JSON.stringify({ ...plan.counts, saleMode: plan.saleMode, shopifyWritesPerformed: false }));
}
