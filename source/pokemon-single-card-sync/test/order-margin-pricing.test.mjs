import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderMarginPrices, calculateOrderProfit, ORDER_MARGIN_POLICY } from '../order-margin-pricing.mjs';

test('fee is 7% of gross sale revenue, and net margin uses the same gross denominator', () => {
  const result = calculateOrderProfit({ saleUsd: 100, procurementCny: 100 });
  assert.equal(result.grossRevenueCny, 650);
  assert.equal(result.feeCny, 45.5);
  assert.equal(result.totalCostCny, 185);
  assert.equal(result.netProfitCny, 419.5);
  assert.equal(result.netMarginPercent, 419.5 / 650 * 100);
  assert.equal(ORDER_MARGIN_POLICY.paymentFeeRate, 0.07);
});

test('whole-dollar endpoints stay within 30–50%, and one dollar beyond either fails', () => {
  for (const procurementCny of [0, 0.5, 8.5, 10, 79, 290, 2900, 12345.67]) {
    const range = calculateOrderMarginPrices({ procurementCny });
    assert(range.lower30.netMarginPercent >= 30);
    assert(range.reference40.netMarginPercent >= 40 && range.reference40.netMarginPercent <= 50);
    assert(range.upper50.netMarginPercent <= 50);
    assert(calculateOrderProfit({ procurementCny, saleUsd: range.lower30.saleUsd - 1 }).netMarginPercent < 30);
    assert(calculateOrderProfit({ procurementCny, saleUsd: range.upper50.saleUsd + 1 }).netMarginPercent > 50);
    assert.equal(range.selectedPriceUsd, null);
    assert.equal(range.executable, false);
  }
});

test('shipping is included once for a combined procurement and shipment', () => {
  const bundle = calculateOrderMarginPrices({ procurementCny: '8.50' });
  assert.equal(bundle.totalCostCny, 93.5);
  assert.equal(bundle.procurementShippingCny, 15);
  assert.equal(bundle.internationalShippingCny, 70);
  const single = calculateOrderMarginPrices({ procurementCny: 0.5 });
  assert.equal(single.totalCostCny, 85.5);
  assert.notEqual(bundle.totalCostCny, 17 * single.totalCostCny);
});

test('higher actual shipping and other expenses reduce profit by their actual amount', () => {
  const standard = calculateOrderProfit({ saleUsd: 48, procurementCny: 79 });
  const actual = calculateOrderProfit({ saleUsd: 48, procurementCny: 79, internationalShippingCny: 90, otherCostsCny: 5.25 });
  assert.equal(standard.netProfitCny - actual.netProfitCny, 25.25);
  assert.equal(calculateOrderProfit({ saleUsd: 0, procurementCny: 79 }).netMarginPercent, null);
});

test('reject invalid, under-budget, fractional-cent or unsafe amounts', () => {
  for (const procurementCny of [null, undefined, NaN, Infinity, -1, '', true, '1.001', '1e2', '9007199254740991']) {
    assert.throws(() => calculateOrderMarginPrices({ procurementCny }));
  }
  assert.throws(() => calculateOrderMarginPrices({ procurementCny: 79, internationalShippingCny: 69.99 }));
  assert.throws(() => calculateOrderProfit({ saleUsd: -1, procurementCny: 79 }));
  assert.throws(() => calculateOrderMarginPrices({ procurementCny: 79, otherCostsCny: -1 }));
});
