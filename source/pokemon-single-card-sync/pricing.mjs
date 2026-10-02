// Reuse the captured single-card policy from the existing MLP system. Its original
// H:\\Codex\\Shopify_CCG_Agent source is unavailable on this workstation.
import {
  calculateCnCardSalePrice,
  CN_CARD_PRICING_POLICY,
} from '../collaboration/pakra-projects-handoff/scripts/lib/cn-card-pricing-policy.mjs';
import { calculateOrderMarginPrices, ORDER_MARGIN_POLICY } from './order-margin-pricing.mjs';

export const ORDER_NET_MARGIN_40_MODEL = 'order_net_margin_40_fee_7';
export const ORDER_NET_MARGIN_40_POLICY = Object.freeze({
  pricingModel: ORDER_NET_MARGIN_40_MODEL,
  version: ORDER_MARGIN_POLICY.version,
  usdCnyRate: ORDER_MARGIN_POLICY.usdCnyRate,
  paymentFeeRate: ORDER_MARGIN_POLICY.paymentFeeRate,
  selectedNetMarginPercent: 40,
  marginDefinition: ORDER_MARGIN_POLICY.marginDefinition,
  listingMode: 'single_variant_product',
  shippingMode: 'independent_order_per_listing',
  procurementOrderShippingCny: 15,
  internationalShippingCny: 70,
  shippingAccounting: 'one_procurement_order_one_international_shipment_per_listing',
  formula: 'ceil((sourceAmountCny + 15 + 70) / (6.5 * (1 - 0.07 - 0.40)))',
});

export function usesOrderNetMargin40(pricingModel) {
  if (pricingModel === undefined) return false;
  if (pricingModel !== ORDER_NET_MARGIN_40_MODEL) throw new Error('unsupported_pricing_model');
  return true;
}

const LANGUAGES = new Set(['zh-Hans', 'ja', 'en']);
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function businessDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function cents(value, allowZero = false) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, decimal = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && (allowZero ? amount >= 0 : amount > 0) ? amount : null;
}

const money = (amount) => (amount / 100).toFixed(2);
const identityOf = (row) => row?.identity ?? row?.id;

function indexBy(rows, keyOf) {
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return index;
}

function configNumber(value, fallback) {
  const number = value === undefined ? fallback : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function identityMatches(card, identity) {
  return card?.ip === 'pokemon'
    && LANGUAGES.has(card.language)
    && String(card.setId ?? '').length > 0
    && String(card.versionId ?? '').length > 0
    && identity === `pokemon:${card.language}:${card.setId}:${card.versionId}`
    && (!card.identity || card.identity === identity)
    && (!card.id || card.id === identity);
}

function perOrderShipping(quotes, shipping) {
  const result = new Map();
  const orderCents = cents(shipping.orderCny);
  if (orderCents === null || shipping.allocation !== 'per_unit') {
    for (const quote of quotes) result.set(quote, { reason: 'invalid_order_shipping_policy' });
    return result;
  }
  const groups = new Map();
  for (const quote of quotes) {
    const purchase = quote.procurement;
    const validOrderId = typeof purchase?.orderId === 'string'
      && purchase.orderId.trim() !== '' && purchase.orderId === purchase.orderId.trim();
    if (!validOrderId) {
      result.set(quote, { reason: 'missing_or_invalid_procurement_group' });
      continue;
    }
    if (!groups.has(purchase.orderId)) groups.set(purchase.orderId, []);
    groups.get(purchase.orderId).push(quote);
  }
  for (const rows of groups.values()) {
    const totalUnits = rows[0].procurement.totalUnits;
    const identities = new Set();
    let countedUnits = 0;
    const valid = rows.every((quote) => {
      const purchase = quote.procurement;
      const identity = identityOf(quote);
      if (!Number.isSafeInteger(totalUnits) || totalUnits <= 0
        || purchase.totalUnits !== totalUnits
        || !Number.isSafeInteger(purchase.units) || purchase.units <= 0
        || purchase.units > totalUnits || typeof identity !== 'string' || !identity
        || identities.has(identity) || quote.available !== true) return false;
      identities.add(identity);
      countedUnits += purchase.units;
      return Number.isSafeInteger(countedUnits);
    }) && countedUnits === totalUnits;
    for (const quote of rows) {
      result.set(quote, valid ? {
        cents: orderCents / totalUnits,
        procurement: {
          orderId: quote.procurement.orderId, totalUnits, units: quote.procurement.units,
          orderShippingCny: money(orderCents), allocation: 'per_unit',
        },
      } : { reason: 'inconsistent_procurement_group' });
    }
  }
  return result;
}

/** Build a local, price-only review plan; this function never calls Shopify. */
export function buildPricePlan({ config, cards, quotes, mapping, live, now = new Date() }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid_current_time');
  if (!config || typeof config.store !== 'string' || !config.store.trim()) throw new Error('missing_store');
  if (![cards, quotes, mapping].every(Array.isArray)) throw new Error('invalid_plan_inputs');
  const orderMargin40 = usesOrderNetMargin40(config.pricingModel);
  const maxDrop = configNumber(config.maxDropPercent, 25);
  const maxIncrease = configNumber(config.maxIncreasePercent, 100);
  const maxAge = configNumber(config.maxQuoteAgeHours, 4);
  if (maxDrop === null || maxIncrease === null || maxAge === null || maxAge === 0 || orderMargin40 && maxAge > 4) {
    throw new Error('invalid_price_safety_limits');
  }

  const plan = {
    schemaVersion: 1,
    store: config.store,
    currency: 'USD',
    date: businessDate(now),
    createdAt: now.toISOString(),
    pricingPolicy: orderMargin40 ? { ...ORDER_NET_MARGIN_40_POLICY } : {
      version: CN_CARD_PRICING_POLICY.version,
      usdCnyRate: CN_CARD_PRICING_POLICY.defaultUsdCnyRate,
      paymentFeeRate: CN_CARD_PRICING_POLICY.paymentFeeRate,
      singleProfitRate: CN_CARD_PRICING_POLICY.singleProfitRate,
      listingMode: 'single_variant_product',
      shippingMode: config.shipping?.mode ?? 'unconfirmed',
      ...(config.shipping?.mode === 'per_order' ? {
        shippingOrderCny: config.shipping.orderCny,
        shippingAllocation: config.shipping.allocation,
      } : {}),
      ...(config.shipping?.mode === 'excluded' && config.shipping.accounting === 'procurement_order_only' ? {
        orderCny: config.shipping.orderCny,
        accounting: config.shipping.accounting,
      } : {}),
      formula: config.shipping?.mode === 'excluded'
        ? 'ceil(sourceAmountCny * 2 / 0.94 / 6.5)'
        : 'ceil((sourceAmountCny + shippingCny) * 2 / 0.94 / 6.5)',
    },
    changes: [],
    blocked: [],
    unchanged: [],
    skipped: [],
  };
  const cardIndex = indexBy(cards, identityOf);
  const quoteIndex = indexBy(quotes, identityOf);
  const activeMappings = mapping.filter((row) => row?.enabled === true);
  const mappingIndex = indexBy(activeMappings, identityOf);
  const mappedVariants = indexBy(activeMappings, (row) => row.variantGid);
  const products = Array.isArray(live?.products) ? live.products : [];
  const productIndex = indexBy(products, (row) => row?.id);
  const orderShipping = !orderMargin40 && config.shipping?.mode === 'per_order' ? perOrderShipping(quotes, config.shipping) : null;

  for (const target of activeMappings) {
    const identity = identityOf(target);
    const base = {
      identity: identity ?? null,
      productGid: target.productGid,
      variantGid: target.variantGid,
      sku: target.sku,
    };
    const block = (reason) => plan.blocked.push({ ...base, reason });
    if (live?.currencyCode !== 'USD') { block('shop_currency_not_usd'); continue; }
    if (typeof identity !== 'string' || !identity || !PRODUCT_GID.test(target.productGid)
      || !VARIANT_GID.test(target.variantGid) || typeof target.sku !== 'string' || !target.sku.trim()) {
      block('invalid_exact_mapping'); continue;
    }
    if (mappingIndex.get(identity).length !== 1 || mappedVariants.get(target.variantGid).length !== 1) {
      block('mapping_identity_or_variant_collision'); continue;
    }
    const matchingCards = cardIndex.get(identity) ?? [];
    if (matchingCards.length !== 1) { block(matchingCards.length ? 'card_identity_collision' : 'missing_card'); continue; }
    const card = matchingCards[0];
    if (!identityMatches(card, identity)) { block('card_identity_mismatch'); continue; }
    const matchingQuotes = quoteIndex.get(identity) ?? [];
    if (matchingQuotes.length !== 1) { block(matchingQuotes.length ? 'quote_identity_collision' : 'missing_quote'); continue; }
    const quote = matchingQuotes[0];
    if ((quote.language && quote.language !== card.language)
      || (quote.setId !== undefined && String(quote.setId) !== String(card.setId))
      || (quote.versionId !== undefined && String(quote.versionId) !== String(card.versionId))) {
      block('quote_identity_mismatch'); continue;
    }
    if (typeof quote.available !== 'boolean') { block('invalid_quote_availability'); continue; }
    if (quote.currency !== 'CNY' || quote.metric !== 'lowest_asking') { block('unsupported_quote_currency_or_metric'); continue; }
    const amount = cents(quote.amountCny);
    if (amount === null && (quote.available || quote.amountCny !== null && quote.amountCny !== undefined)) {
      block('invalid_source_price'); continue;
    }
    const observedAt = new Date(quote.observedAt);
    if (typeof quote.observedAt !== 'string' || !TIMESTAMP.test(quote.observedAt)
      || !Number.isFinite(observedAt.getTime())) {
      block('invalid_quote_timestamp'); continue;
    }
    const age = now.getTime() - observedAt.getTime();
    if (age < 0) { block('future_quote'); continue; }
    if (businessDate(observedAt) !== plan.date || age > maxAge * 3_600_000) { block('stale_quote'); continue; }

    const matchingProducts = productIndex.get(target.productGid) ?? [];
    if (matchingProducts.length !== 1) {
      block(matchingProducts.length ? 'live_product_collision' : 'missing_live_product'); continue;
    }
    const product = matchingProducts[0];
    if (product.status !== 'ACTIVE' || typeof product.onlineStoreUrl !== 'string'
      || !/^https:\/\//i.test(product.onlineStoreUrl)) { block('product_not_listed_online'); continue; }
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const matchingVariants = variants.filter((variant) => variant?.id === target.variantGid);
    if (matchingVariants.length !== 1) {
      block(matchingVariants.length ? 'live_variant_collision' : 'missing_live_variant'); continue;
    }
    const variant = matchingVariants[0];
    if (variant.sku !== target.sku) { block('live_sku_mismatch'); continue; }
    const oldAmount = cents(variant.price);
    if (oldAmount === null) { block('invalid_current_price'); continue; }
    if (quote.available === false) {
      plan.skipped.push({ ...base, oldPrice: money(oldAmount), sourceObservedAt: observedAt.toISOString(),
        sourceUrl: typeof quote.sourceUrl === 'string' ? quote.sourceUrl : '', reason: 'no_available_offer' });
      continue;
    }

    let shipping;
    let procurement;
    if (orderMargin40) shipping = 8500;
    else if (config.shipping?.mode === 'excluded') shipping = 0;
    else if (config.shipping?.mode === 'fixed') shipping = cents(config.shipping.fixedCny, true);
    else if (config.shipping?.mode === 'actual') shipping = cents(quote.shippingCny, true);
    else if (config.shipping?.mode === 'per_order') {
      const allocation = orderShipping.get(quote);
      if (allocation.reason) { block(allocation.reason); continue; }
      shipping = allocation.cents;
      procurement = allocation.procurement;
    }
    else { block('shipping_policy_unconfirmed'); continue; }
    if (shipping === null) { block('missing_or_invalid_shipping'); continue; }
    if (!Number.isSafeInteger(amount + Math.ceil(shipping))) { block('invalid_procurement_cost'); continue; }
    let saleUsd;
    if (orderMargin40) {
      try {
        saleUsd = calculateOrderMarginPrices({ procurementCny: money(amount) }).reference40.saleUsd;
      } catch { block('invalid_calculated_price'); continue; }
    } else {
      saleUsd = calculateCnCardSalePrice({
        costCny: (amount + shipping) / 100,
        usdCnyRate: CN_CARD_PRICING_POLICY.defaultUsdCnyRate,
        listingMode: 'single_variant_product',
      }).saleUsd;
    }
    const newAmount = cents(saleUsd);
    if (newAmount === null) { block('invalid_calculated_price'); continue; }
    const row = {
      ...base,
      oldPrice: money(oldAmount),
      newPrice: money(newAmount),
      sourceObservedAt: observedAt.toISOString(),
      sourceAmountCny: money(amount),
      shippingCny: money(shipping),
      ...(procurement ? { procurement } : {}),
      sourceUrl: typeof quote.sourceUrl === 'string' ? quote.sourceUrl : '',
      ...(quote.sourceKind === 'official_app_ui' ? { sourceKind: quote.sourceKind,
        conditionScope: quote.conditionScope, evidence: quote.evidence } : {}),
      impact: 'Update this listed variant price only; inventory and catalog content remain unchanged.',
    };
    if (newAmount === oldAmount) { plan.unchanged.push(row); continue; }
    const deltaPercent = (newAmount - oldAmount) / oldAmount * 100;
    if (deltaPercent < -maxDrop || deltaPercent > maxIncrease) {
      plan.blocked.push({
        ...row,
        reason: deltaPercent < 0 ? 'price_drop_exceeds_limit' : 'price_increase_exceeds_limit',
        changePercent: Math.round(deltaPercent * 100) / 100,
      });
      continue;
    }
    plan.changes.push(row);
  }
  return plan;
}
