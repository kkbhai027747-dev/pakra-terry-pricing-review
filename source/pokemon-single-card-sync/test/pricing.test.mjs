import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPricePlan, ORDER_NET_MARGIN_40_MODEL } from '../pricing.mjs';

const IDENTITY = 'pokemon:zh-Hans:101:202';
const PRODUCT = 'gid://shopify/Product/100';
const VARIANT = 'gid://shopify/ProductVariant/200';

function input() {
  return {
    config: { store: 'example.myshopify.com', shipping: { mode: 'fixed', fixedCny: '2.00' } },
    cards: [{ identity: IDENTITY, ip: 'pokemon', language: 'zh-Hans', setId: '101', versionId: '202', name: 'Example card' }],
    quotes: [{ identity: IDENTITY, amountCny: '10.00', currency: 'CNY', metric: 'lowest_asking', observedAt: '2026-09-22T00:00:00.000Z', available: true, sourceUrl: 'https://example.com/card/202' }],
    mapping: [{ identity: IDENTITY, productGid: PRODUCT, variantGid: VARIANT, sku: 'PKM-CN-101-202', enabled: true }],
    live: { currencyCode: 'USD', products: [{ id: PRODUCT, status: 'ACTIVE', onlineStoreUrl: 'https://example.com/products/card', variants: [{ id: VARIANT, sku: 'PKM-CN-101-202', price: '5.00' }] }] },
    now: new Date('2026-09-22T01:00:00.000Z'),
  };
}

function blocked(mutator, reason) {
  const data = input();
  mutator(data);
  const result = buildPricePlan(data);
  assert.equal(result.changes.length, 0);
  assert.ok(result.blocked.length > 0);
  assert.ok(result.blocked.every((row) => row.reason === reason), JSON.stringify(result.blocked));
}

test('existing single-card formula gives USD 4 for CNY 10 plus CNY 2', () => {
  const result = buildPricePlan(input());
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].oldPrice, '5.00');
  assert.equal(result.changes[0].newPrice, '4.00');
  assert.equal(result.changes[0].shippingCny, '2.00');
  assert.equal(result.pricingPolicy.version, '2026-09-15.1');
  assert.equal(result.date, '2026-09-22');
  assert.equal(result.blocked.length, 0);
  assert.ok(!Object.keys(result.changes[0]).some((key) => /inventory/i.test(key)));
});

test('already matching prices are reported without writes', () => {
  const data = input();
  data.live.products[0].variants[0].price = '4.00';
  const result = buildPricePlan(data);
  assert.equal(result.changes.length, 0);
  assert.equal(result.unchanged.length, 1);
});

test('verified App quotes retain their unfiltered scope and evidence in review rows', () => {
  const data = input();
  Object.assign(data.quotes[0], { sourceKind: 'official_app_ui',
    conditionScope: 'app_unfiltered_version_minimum', evidence: { reportSha256: 'a'.repeat(64) } });
  const row = buildPricePlan(data).changes[0];
  assert.equal(row.conditionScope, 'app_unfiltered_version_minimum');
  assert.deepEqual(row.evidence, data.quotes[0].evidence);
});

test('Shanghai day is used at UTC date boundaries', () => {
  const data = input();
  data.now = new Date('2026-09-21T17:30:00.000Z');
  data.quotes[0].observedAt = '2026-09-21T17:00:00.000Z';
  assert.equal(buildPricePlan(data).date, '2026-09-22');
  data.quotes[0].observedAt = '2026-09-21T15:59:59.000Z';
  assert.equal(buildPricePlan(data).blocked[0].reason, 'stale_quote');
});

test('old, future and malformed quotes cannot change prices', () => {
  blocked((data) => { data.quotes[0].observedAt = '2026-09-21T20:59:59.000Z'; }, 'stale_quote');
  blocked((data) => { data.quotes[0].observedAt = '2026-09-22T01:00:01.000Z'; }, 'future_quote');
  blocked((data) => { data.quotes[0].observedAt = ''; }, 'invalid_quote_timestamp');
  blocked((data) => { data.quotes[0].observedAt = '2026-09-22'; }, 'invalid_quote_timestamp');
  blocked((data) => { data.quotes[0].observedAt = '2026-09-22T00:00:00'; }, 'invalid_quote_timestamp');
});

test('zero, negative, missing and nonfinite source values are blocked', () => {
  for (const amount of ['0.00', '-1', '', null, Infinity, NaN, '1e2']) {
    blocked((data) => { data.quotes[0].amountCny = amount; }, 'invalid_source_price');
  }
  blocked((data) => { data.live.products[0].variants[0].price = '0.00'; }, 'invalid_current_price');
});

test('explicit current no-offer observations are skipped and retain the old price', () => {
  for (const amountCny of [null, undefined, '10.00']) {
    const data = input();
    data.quotes[0].available = false;
    data.quotes[0].amountCny = amountCny;
    data.config.shipping = { mode: 'unconfirmed' };
    const result = buildPricePlan(data);
    assert.equal(result.changes.length, 0);
    assert.equal(result.blocked.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'no_available_offer');
    assert.equal(result.skipped[0].oldPrice, '5.00');
    assert.equal(result.skipped[0].sourceObservedAt, data.quotes[0].observedAt);
    assert.ok(!('newPrice' in result.skipped[0]));
  }
});

test('unknown availability is blocked rather than treated as an observed no-offer', () => {
  for (const available of [undefined, null, '', 'false', 'true', 0, 1]) {
    blocked((data) => { data.quotes[0].available = available; }, 'invalid_quote_availability');
  }
});

test('no-offer observations must pass identity, timestamp, currency and amount validation', () => {
  const cases = [
    [(data) => { data.quotes[0].observedAt = '2026-09-21T20:59:59.000Z'; }, 'stale_quote'],
    [(data) => { data.quotes[0].observedAt = '2026-09-21T15:59:59.000Z'; }, 'stale_quote'],
    [(data) => { data.quotes[0].observedAt = '2026-09-22T01:00:01.000Z'; }, 'future_quote'],
    [(data) => { data.quotes[0].observedAt = '2026-09-22T00:00:00'; }, 'invalid_quote_timestamp'],
    [(data) => { data.quotes[0].language = 'ja'; }, 'quote_identity_mismatch'],
    [(data) => { data.quotes[0].versionId = '999'; }, 'quote_identity_mismatch'],
    [(data) => { data.quotes[0].currency = 'USD'; }, 'unsupported_quote_currency_or_metric'],
    [(data) => { data.quotes[0].metric = 'last_sold'; }, 'unsupported_quote_currency_or_metric'],
    [(data) => { data.live.products[0].variants[0].sku = 'WRONG'; }, 'live_sku_mismatch'],
    [(data) => { data.quotes.push({ ...data.quotes[0] }); }, 'quote_identity_collision'],
    [(data) => { data.quotes = []; }, 'missing_quote'],
  ];
  for (const amountCny of ['', '0.00', '-1.00', '1e2', NaN, Infinity]) {
    cases.push([(data) => { data.quotes[0].amountCny = amountCny; }, 'invalid_source_price']);
  }
  for (const [modify, reason] of cases) {
    const data = input();
    data.quotes[0].available = false;
    data.quotes[0].amountCny = null;
    modify(data);
    const result = buildPricePlan(data);
    assert.equal(result.changes.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.blocked[0].reason, reason);
  }
});

test('unsupported price metrics and currency remain blocked', () => {
  blocked((data) => { data.quotes[0].metric = 'last_sold'; }, 'unsupported_quote_currency_or_metric');
  blocked((data) => { data.quotes[0].currency = 'JPY'; }, 'unsupported_quote_currency_or_metric');
  blocked((data) => { data.live.currencyCode = 'CNY'; }, 'shop_currency_not_usd');
});

test('duplicate card, quote, identity and variant mappings are blocked', () => {
  blocked((data) => { data.cards.push({ ...data.cards[0] }); }, 'card_identity_collision');
  blocked((data) => { data.quotes.push({ ...data.quotes[0] }); }, 'quote_identity_collision');
  blocked((data) => { data.mapping.push({ ...data.mapping[0] }); }, 'mapping_identity_or_variant_collision');
  blocked((data) => { data.mapping.push({ ...data.mapping[0], identity: 'pokemon:ja:101:202' }); }, 'mapping_identity_or_variant_collision');
});

test('language, set, version and exact Shopify identifiers cannot be guessed', () => {
  blocked((data) => { data.cards[0].language = 'ja'; }, 'card_identity_mismatch');
  blocked((data) => { data.cards[0].setId = '999'; }, 'card_identity_mismatch');
  blocked((data) => { data.cards[0].versionId = '999'; }, 'card_identity_mismatch');
  blocked((data) => { data.quotes[0].language = 'en'; }, 'quote_identity_mismatch');
  blocked((data) => { data.live.products[0].variants[0].sku = 'SAME-NAME-DIFFERENT-SKU'; }, 'live_sku_mismatch');
  blocked((data) => { data.live.products[0].variants[0].id = 'gid://shopify/ProductVariant/999'; }, 'missing_live_variant');
  blocked((data) => { data.live.products[0].id = 'gid://shopify/Product/999'; }, 'missing_live_product');
});

test('only explicitly enabled and online ACTIVE mapped cards are considered', () => {
  blocked((data) => { data.live.products[0].status = 'DRAFT'; }, 'product_not_listed_online');
  blocked((data) => { data.live.products[0].onlineStoreUrl = null; }, 'product_not_listed_online');
  const data = input();
  data.mapping[0].enabled = false;
  assert.deepEqual(buildPricePlan(data).changes, []);
});

test('missing shipping confirmation or actual shipping blocks changes', () => {
  blocked((data) => { data.config.shipping = { mode: 'unconfirmed' }; }, 'shipping_policy_unconfirmed');
  blocked((data) => { data.config.shipping = { mode: 'actual' }; }, 'missing_or_invalid_shipping');
  const data = input();
  data.config.shipping = { mode: 'actual' };
  data.quotes[0].shippingCny = 2;
  assert.equal(buildPricePlan(data).changes[0].newPrice, '4.00');
  data.config.shipping = { mode: 'excluded' };
  assert.equal(buildPricePlan(data).changes[0].shippingCny, '0.00');
});

test('current project policy prices CNY 90 at USD 51 including CNY85 logistics', () => {
  const data = input();
  const projectConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  data.config = { ...data.config, ...projectConfig };
  data.quotes[0].amountCny = '90.00';
  data.live.products[0].variants[0].price = '40.00';
  const result = buildPricePlan(data);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].newPrice, '51.00');
  assert.equal(result.changes[0].shippingCny, '85.00');
  assert.equal(result.pricingPolicy.formula, 'ceil((sourceAmountCny + 15 + 70) / (6.5 * (1 - 0.07 - 0.40)))');
  assert.equal(result.pricingPolicy.procurementOrderShippingCny, 15);
  assert.equal(result.pricingPolicy.internationalShippingCny, 70);
  assert.equal(result.pricingPolicy.selectedNetMarginPercent, 40);
  assert.ok(!('procurement' in data.quotes[0]));
  assert.ok(!('procurement' in result.changes[0]));
});

test('order-only procurement cost is recorded once in policy and never allocated to cards', () => {
  const data = input();
  data.config.shipping = { mode: 'excluded', orderCny: 15, accounting: 'procurement_order_only' };
  data.quotes[0].amountCny = '90.00';
  data.live.products[0].variants[0].price = '40.00';
  const secondIdentity = 'pokemon:zh-Hans:101:203';
  const secondVariant = 'gid://shopify/ProductVariant/201';
  data.cards.push({ ...data.cards[0], identity: secondIdentity, versionId: '203' });
  data.quotes.push({ ...data.quotes[0], identity: secondIdentity, amountCny: '60.00' });
  data.mapping.push({ ...data.mapping[0], identity: secondIdentity, variantGid: secondVariant, sku: 'PKM-CN-101-203' });
  data.live.products[0].variants.push({ id: secondVariant, sku: 'PKM-CN-101-203', price: '25.00' });
  const result = buildPricePlan(data);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.changes.map((row) => row.newPrice), ['30.00', '20.00']);
  assert.ok(result.changes.every((row) => row.shippingCny === '0.00'
    && !['procurement', 'orderCny', 'accounting'].some((key) => key in row)));
  assert.equal(result.pricingPolicy.shippingMode, 'excluded');
  assert.equal(result.pricingPolicy.orderCny, 15);
  assert.equal(result.pricingPolicy.accounting, 'procurement_order_only');
  assert.equal(JSON.stringify(result).match(/"orderCny":15/g).length, 1);
  assert.ok(data.quotes.every((quote) => !('procurement' in quote)));
});

test('one CNY 15 charge is shared by all purchased units in the same order', () => {
  const data = input();
  data.config.shipping = { mode: 'per_order', orderCny: 15, allocation: 'per_unit' };
  data.quotes[0].procurement = { orderId: 'purchase-1', totalUnits: 3, units: 2 };
  data.live.products[0].variants[0].price = '6.00';
  const secondIdentity = 'pokemon:zh-Hans:101:203';
  const secondVariant = 'gid://shopify/ProductVariant/201';
  data.cards.push({ ...data.cards[0], identity: secondIdentity, versionId: '203' });
  data.quotes.push({ ...data.quotes[0], identity: secondIdentity,
    procurement: { orderId: 'purchase-1', totalUnits: 3, units: 1 } });
  data.mapping.push({ ...data.mapping[0], identity: secondIdentity, variantGid: secondVariant, sku: 'PKM-CN-101-203' });
  data.live.products[0].variants.push({ id: secondVariant, sku: 'PKM-CN-101-203', price: '6.00' });
  const result = buildPricePlan(data);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.changes.length, 2);
  for (const row of result.changes) {
    assert.equal(row.shippingCny, '5.00');
    assert.equal(row.newPrice, '5.00');
    assert.equal(row.procurement.orderShippingCny, '15.00');
  }
  assert.equal(result.changes.reduce((sum, row) => sum + Number(row.shippingCny) * row.procurement.units, 0), 15);
});

test('per-order shipping requires complete and consistent positive procurement quantities', () => {
  const cases = [
    [undefined, 'missing_or_invalid_procurement_group'],
    [{ orderId: '', totalUnits: 1, units: 1 }, 'missing_or_invalid_procurement_group'],
    [{ orderId: 'purchase-1', totalUnits: 3, units: 2 }, 'inconsistent_procurement_group'],
    [{ orderId: 'purchase-1', totalUnits: 0, units: 0 }, 'inconsistent_procurement_group'],
    [{ orderId: 'purchase-1', totalUnits: 2.5, units: 2.5 }, 'inconsistent_procurement_group'],
    [{ orderId: 'purchase-1', totalUnits: '2', units: 2 }, 'inconsistent_procurement_group'],
  ];
  for (const [procurement, reason] of cases) {
    blocked((data) => {
      data.config.shipping = { mode: 'per_order', orderCny: 15, allocation: 'per_unit' };
      data.quotes[0].procurement = procurement;
    }, reason);
  }
  const data = input();
  data.config.shipping = { mode: 'per_order', orderCny: 15, allocation: 'per_unit' };
  data.quotes[0].procurement = { orderId: 'purchase-1', totalUnits: 3, units: 2 };
  data.quotes.push({ ...data.quotes[0], identity: 'pokemon:zh-Hans:101:203',
    procurement: { orderId: 'purchase-1', totalUnits: 4, units: 1 } });
  assert.equal(buildPricePlan(data).blocked[0].reason, 'inconsistent_procurement_group');
});

test('fractional-cent allocation is not rounded before calculating the final USD price', () => {
  const data = input();
  data.config.shipping = { mode: 'per_order', orderCny: 15, allocation: 'per_unit' };
  data.quotes[0].amountCny = '3.97';
  data.quotes[0].procurement = { orderId: 'purchase-1', totalUnits: 7, units: 7 };
  data.live.products[0].variants[0].price = '4.00';
  const row = buildPricePlan(data).changes[0];
  assert.equal(row.shippingCny, '2.14');
  assert.equal(row.newPrice, '3.00');
  assert.equal(row.procurement.totalUnits, 7);
});

test('large changes are held for review with exact old and proposed prices', () => {
  blocked((data) => { data.live.products[0].variants[0].price = '10.00'; }, 'price_drop_exceeds_limit');
  blocked((data) => { data.quotes[0].amountCny = '100.00'; }, 'price_increase_exceeds_limit');
  const data = input();
  data.live.products[0].variants[0].price = '10.00';
  const row = buildPricePlan(data).blocked[0];
  assert.equal(row.oldPrice, '10.00');
  assert.equal(row.newPrice, '4.00');
  assert.equal(row.changePercent, -60);
});

test('missing records fail closed and input data is not mutated', () => {
  blocked((data) => { data.cards = []; }, 'missing_card');
  blocked((data) => { data.quotes = []; }, 'missing_quote');
  const data = input();
  const snapshot = structuredClone(data);
  buildPricePlan(data);
  assert.deepEqual(data, snapshot);
});

test('explicit order-margin40 model uses 7% of revenue and one CNY85 shipment per listing', () => {
  for (const [amountCny, price] of [['0.50', '25.00'], ['79.00', '48.00'], ['290.00', '109.00'], ['2900.00', '867.00']]) {
    const data = input();
    data.config.pricingModel = ORDER_NET_MARGIN_40_MODEL;
    data.quotes[0].amountCny = amountCny;
    data.live.products[0].variants[0].price = (Number(price) - 1).toFixed(2);
    const before = structuredClone(data), plan = buildPricePlan(data);
    assert.deepEqual(plan.blocked, []);
    assert.equal(plan.changes[0].newPrice, price);
    assert.equal(plan.changes[0].shippingCny, '85.00');
    assert.equal(plan.pricingPolicy.pricingModel, ORDER_NET_MARGIN_40_MODEL);
    assert.equal(plan.pricingPolicy.paymentFeeRate, 0.07);
    assert.equal(plan.pricingPolicy.selectedNetMarginPercent, 40);
    assert.equal(plan.pricingPolicy.procurementOrderShippingCny, 15);
    assert.equal(plan.pricingPolicy.internationalShippingCny, 70);
    assert.match(plan.pricingPolicy.formula, /1 - 0\.07 - 0\.40/);
    assert.doesNotMatch(plan.pricingPolicy.formula, /0\.94/);
    assert.deepEqual(data, before);
  }
});

test('order-margin40 never divides shipping by batch size or a procurement group', () => {
  const data = input();
  data.config.pricingModel = ORDER_NET_MARGIN_40_MODEL;
  data.config.shipping = { mode: 'per_order', orderCny: 15, allocation: 'per_unit' };
  data.quotes[0].amountCny = '0.50';
  data.quotes[0].procurement = { orderId: 'same-batch', totalUnits: 2, units: 1 };
  data.live.products[0].variants[0].price = '24.00';
  const identity = 'pokemon:zh-Hans:101:203', variantGid = 'gid://shopify/ProductVariant/201';
  data.cards.push({ ...data.cards[0], identity, versionId: '203' });
  data.quotes.push({ ...data.quotes[0], identity });
  data.mapping.push({ ...data.mapping[0], identity, variantGid, sku: 'PKM-CN-101-203' });
  data.live.products[0].variants.push({ id: variantGid, sku: 'PKM-CN-101-203', price: '24.00' });
  const plan = buildPricePlan(data);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.changes.map(row => row.newPrice), ['25.00', '25.00']);
  assert.ok(plan.changes.every(row => row.shippingCny === '85.00' && !('procurement' in row)));
  assert.equal(plan.pricingPolicy.shippingMode, 'independent_order_per_listing');
});

test('unknown pricing models and new-model quote ages exceeding4 hours fail closed', () => {
  for (const pricingModel of ['', null, 'order_net_margin_40_fee_6', 'legacy']) {
    const data = input(); data.config.pricingModel = pricingModel;
    assert.throws(() => buildPricePlan(data), /unsupported_pricing_model/);
  }
  const data = input(); data.config.pricingModel = ORDER_NET_MARGIN_40_MODEL;
  data.config.maxQuoteAgeHours = 4.001;
  assert.throws(() => buildPricePlan(data), /invalid_price_safety_limits/);
});

test('order-margin40 preserves quote, mapping and source-price guards', () => {
  const cases = [
    [data => { data.quotes[0].observedAt = '2026-09-21T20:59:59.999Z'; }, 'stale_quote'],
    [data => { data.now = new Date('2026-09-22T16:00:01.000Z'); data.quotes[0].observedAt = '2026-09-22T15:59:59.000Z'; }, 'stale_quote'],
    [data => { data.quotes[0].observedAt = '2026-09-22T01:00:00.001Z'; }, 'future_quote'],
    [data => { data.quotes[0].language = 'ja'; }, 'quote_identity_mismatch'],
    [data => { data.live.products[0].variants[0].sku = 'WRONG'; }, 'live_sku_mismatch'],
    [data => { data.mapping.push({ ...data.mapping[0] }); }, 'mapping_identity_or_variant_collision'],
    [data => { data.quotes[0].amountCny = '0.00'; }, 'invalid_source_price'],
    [data => { data.quotes[0].currency = 'USD'; }, 'unsupported_quote_currency_or_metric'],
    [data => { data.quotes[0].amountCny = '1000000000000.00'; }, 'invalid_calculated_price'],
  ];
  for (const [modify, reason] of cases) {
    const data = input(); data.config.pricingModel = ORDER_NET_MARGIN_40_MODEL; modify(data);
    const plan = buildPricePlan(data);
    assert.equal(plan.changes.length, 0); assert.equal(plan.blocked[0].reason, reason);
  }
});

test('order-margin40 retains old price for no offer and keeps large migration changes blocked', () => {
  const data = input(); data.config.pricingModel = ORDER_NET_MARGIN_40_MODEL;
  data.quotes[0].amountCny = '0.50'; data.live.products[0].variants[0].price = '1.00';
  const plan = buildPricePlan(data);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.blocked[0].reason, 'price_increase_exceeds_limit');
  assert.equal(plan.blocked[0].newPrice, '25.00');
  data.quotes[0].available = false; data.quotes[0].amountCny = null;
  const unavailable = buildPricePlan(data);
  assert.equal(unavailable.blocked.length, 0); assert.equal(unavailable.skipped[0].oldPrice, '1.00');
  assert.equal(unavailable.skipped[0].reason, 'no_available_offer');
});
