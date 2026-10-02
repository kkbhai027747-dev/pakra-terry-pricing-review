import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local order calculation only. Shipping is charged once for one procurement
// order and one international shipment, regardless of the number of cards.
export const ORDER_MARGIN_POLICY = Object.freeze({
  version: '2026-09-28-net-margin-fee7',
  usdCnyRate: 6.5,
  paymentFeeRate: 0.07,
  procurementShippingCny: 15,
  minimumInternationalShippingCny: 70,
  minimumNetMarginPercent: 30,
  maximumNetMarginPercent: 50,
  referenceNetMarginPercent: 40,
  selectedNetMarginPercent: null,
  formula: '(procurementCny + 15 + internationalShippingCny + otherCostsCny) / (6.5 * (1 - 0.07 - netMargin))',
  marginDefinition: 'netProfitCny / grossRevenueCny',
});

function cents(value, label) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    throw new Error(`${label} must be nonnegative money with at most two decimal places`);
  }
  const [whole, fraction = ''] = String(value).split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the supported precision`);
  return result;
}

function costs({ procurementCny, internationalShippingCny = 70, otherCostsCny = 0 }) {
  const procurement = cents(procurementCny, 'procurementCny');
  const international = cents(internationalShippingCny, 'internationalShippingCny');
  const other = cents(otherCostsCny, 'otherCostsCny');
  if (international < 7000) throw new Error('internationalShippingCny must be at least 70');
  const total = procurement + 1500 + international + other;
  if (!Number.isSafeInteger(total * 1000)) throw new Error('Order cost exceeds the supported precision');
  return {
    policyVersion: ORDER_MARGIN_POLICY.version,
    procurementCny: procurement / 100,
    procurementShippingCny: 15,
    internationalShippingCny: international / 100,
    otherCostsCny: other / 100,
    totalCostCny: total / 100,
    totalCostCents: total,
  };
}

export function calculateOrderProfit({ saleUsd, ...input }) {
  const { totalCostCents, ...cost } = costs(input);
  const saleCents = cents(saleUsd, 'saleUsd');
  // One unit is 0.00001 CNY: each USD cent yields 6500 units of revenue,
  // incurs 455 units of fee (7%), and leaves 6045 units before order costs.
  const revenueUnits = saleCents * 6500;
  const feeUnits = saleCents * 455;
  const profitUnits = saleCents * 6045 - totalCostCents * 1000;
  if (![revenueUnits, feeUnits, profitUnits].every(Number.isSafeInteger)) {
    throw new Error('Sale value exceeds the supported precision');
  }
  return {
    ...cost,
    saleUsd: saleCents / 100,
    grossRevenueCny: revenueUnits / 100000,
    feeCny: feeUnits / 100000,
    netProfitCny: profitUnits / 100000,
    netMarginPercent: revenueUnits === 0 ? null : profitUnits / revenueUnits * 100,
    scope: 'one_procurement_order_one_international_shipment',
    approved: false,
    executable: false,
  };
}

export function calculateOrderMarginPrices(input) {
  const { totalCostCents, ...cost } = costs(input);
  const numerator = totalCostCents * 10;
  const ceilRatio = denominator => Math.floor((numerator + denominator - 1) / denominator);
  const lowerUsd = ceilRatio(4095); // 6.5 * (1 - 0.07 - 0.30), in milli-CNY.
  const middleUsd = ceilRatio(3445);
  const upperUsd = Math.floor(numerator / 2795);
  const scenario = (saleUsd, targetMarginPercent, rounding) => ({
    ...calculateOrderProfit({ ...input, saleUsd }), targetMarginPercent, rounding,
  });
  const lower30 = scenario(lowerUsd, 30, 'ceil_whole_usd_minimum');
  const reference40 = scenario(middleUsd, 40, 'ceil_whole_usd_reference');
  const upper50 = scenario(upperUsd, 50, 'floor_whole_usd_maximum');
  assert(lower30.netMarginPercent >= 30 && upper50.netMarginPercent <= 50);
  assert(lowerUsd <= middleUsd && middleUsd <= upperUsd);
  return {
    ...cost,
    referenceUnroundedUsd: { margin30: numerator / 4095, margin40: numerator / 3445, margin50: numerator / 2795 },
    lower30, reference40, upper50,
    selectedPriceUsd: null,
    approved: false,
    executable: false,
  };
}

// Examples:
// node order-margin-pricing.mjs --cost-cny 79
// node order-margin-pricing.mjs --cost-cny 79 --sale-usd 48 --international-cny 70 --other-cny 0
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = new Map();
    const allowed = new Set(['--cost-cny', '--sale-usd', '--international-cny', '--other-cny']);
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const [key, value] = args.slice(index, index + 2);
      if (!allowed.has(key) || value === undefined || options.has(key)) throw new Error('Invalid or duplicate option');
      options.set(key, value);
    }
    if (!options.has('--cost-cny')) throw new Error('Required: --cost-cny <total procurement CNY>');
    const input = {
      procurementCny: options.get('--cost-cny'),
      internationalShippingCny: options.get('--international-cny') ?? 70,
      otherCostsCny: options.get('--other-cny') ?? 0,
    };
    const result = options.has('--sale-usd')
      ? calculateOrderProfit({ ...input, saleUsd: options.get('--sale-usd') })
      : calculateOrderMarginPrices(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
