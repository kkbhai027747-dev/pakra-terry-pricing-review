/**
 * Storefront pricing formulas and fixed policy defaults.
 * Consumes normalized costs and procurement evidence; returns values only.
 * No files, network, environment configuration, or store writes.
 */

import { validateQiandaoPersonalSellerFallbackEvidence } from "../qiandao/price-evidence.mjs";
import { ceilUsd, round2 } from "./money.mjs";

export const CN_CARD_PRICING_POLICY = Object.freeze({
  version: "2026-09-15.1",
  paymentFeeRate: 0.06,
  singleProfitRate: 1,
  bundleProfitRate: 2,
  defaultUsdCnyRate: 6.5,
  flashDispatchFeeCny: 2,
  lowProcurementPriceMaxCny: 20,
  bundleDefaultMinimumUsd: 15,
  bundleGradeMinimumUsd: Object.freeze({
    N: 10,
    R: 10,
    SR: 12,
    SSR: 15,
    UR: 18,
    LSR: 19,
  }),
});

/**
 * Return the fixed rate unless a positive explicit override is supplied; no live lookup.
 * @param {{explicitRate?: number|string|null}} [options]
 * @returns {number}
 * @throws {Error} If an explicit override is not finite and positive.
 */
export function resolveUsdCnyRate({
  explicitRate = null,
} = {}) {
  const hasExplicitRate = explicitRate !== null
    && explicitRate !== undefined
    && String(explicitRate).trim() !== "";
  if (hasExplicitRate) {
    const rate = Number(explicitRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid explicit USD/CNY pricing rate: ${explicitRate}`);
    }
    return rate;
  }
  return CN_CARD_PRICING_POLICY.defaultUsdCnyRate;
}

export function cnCardPricingPolicySnapshot(usdCnyRate = CN_CARD_PRICING_POLICY.defaultUsdCnyRate) {
  return { policyVersion: CN_CARD_PRICING_POLICY.version, usdCnyRate, flashDispatchFeeCny: CN_CARD_PRICING_POLICY.flashDispatchFeeCny };
}

/**
 * Reject an outdated policy snapshot before a caller makes a store request.
 * @param {object} snapshot Policy fields saved with a proposed plan.
 * @throws {Error} If the version, fixed defaults, or supplied parameters differ.
 */
export function assertCurrentCnCardPricingPolicy(snapshot) {
  const current = cnCardPricingPolicySnapshot();
  const optionalParameters = { domesticShippingCny: CN_CARD_PRICING_POLICY.flashDispatchFeeCny, paymentFeeRate: CN_CARD_PRICING_POLICY.paymentFeeRate, singleProfitRate: CN_CARD_PRICING_POLICY.singleProfitRate, bundleProfitRate: CN_CARD_PRICING_POLICY.bundleProfitRate };
  if (!snapshot || Object.entries(current).some(([key, value]) => snapshot[key] !== value)
    || Object.entries(optionalParameters).some(([key, value]) => snapshot[key] !== undefined && snapshot[key] !== value)) {
    throw new Error('pricing_policy_snapshot_stale: regenerate the evidence-backed plan with the current 6.5/2 policy before any Shopify request; never relabel an old report.');
  }
}

/**
 * Sum card costs, charging Flash dispatch once and evidenced personal shipping per card.
 * Personal offers must pass the exact-SPU fallback gate.
 * @param {{cards?: object[], flashDispatchFeeCny?: number}} [options]
 * @returns {number|null} CNY cost, or null for missing/invalid procurement evidence.
 */
export function calculateCnCardBundleProcurementCostCny({ cards = [], flashDispatchFeeCny = CN_CARD_PRICING_POLICY.flashDispatchFeeCny } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  let costCny = 0;
  let hasFlashCard = false;
  for (const card of cards) {
    const priceCny = Number(card?.priceCny ?? card?.cardPriceCny);
    const source = String(card?.priceSource ?? card?.qiandaoPriceSource ?? "");
    if (!Number.isFinite(priceCny) || priceCny <= 0) return null;
    costCny += priceCny;
    if (source.startsWith("qiandao_flash_")) {
      hasFlashCard = true;
      continue;
    }
    if (source.startsWith("qiandao_personal_")) {
      if (!validateQiandaoPersonalSellerFallbackEvidence(card).ok) return null;
      const shippingCny = Number(card?.shippingCny ?? card?.sellerShippingCny ?? card?.qiandaoSellerShippingCny);
      if (!Number.isFinite(shippingCny) || shippingCny < 0) return null;
      costCny += shippingCny;
      continue;
    }
    return null;
  }
  if (hasFlashCard) {
    const dispatchFee = Number(flashDispatchFeeCny);
    if (!Number.isFinite(dispatchFee) || dispatchFee < 0) return null;
    costCny += dispatchFee;
  }
  return Math.round(costCny * 100) / 100;
}

export function isCnCardListingPriceReady({ cards = [], missingPriceCount = 0 } = {}) {
  if (Number(missingPriceCount) > 0 || !Array.isArray(cards) || cards.length === 0) return false;
  return cards.every((card) => (
    String(card?.priceStatus || "") === "priced"
    && Number.isFinite(Number(card?.saleUsd))
    && Number(card.saleUsd) > 0
  ));
}

export function sumTcgFinalSingleCardPricesUsd(prices = []) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  let total = 0;
  for (const value of prices) {
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) return null;
    total += price;
  }
  return round2(total);
}

export function getCnCardBundleMinimumUsd(
  cardGrade,
  {
    bundleDefaultMinimumUsd = CN_CARD_PRICING_POLICY.bundleDefaultMinimumUsd,
    bundleGradeMinimumUsd = CN_CARD_PRICING_POLICY.bundleGradeMinimumUsd,
  } = {},
) {
  const grade = String(cardGrade || "").trim().toUpperCase();
  const configured = Number(bundleGradeMinimumUsd?.[grade]);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : Number(bundleDefaultMinimumUsd);
}

/**
 * Calculate a proposed single/bundle USD price without applying it to a store.
 * Listing mode is mandatory; bundle floors and whole-dollar ceiling remain intact.
 * @param {object} [options] CNY cost, USD/CNY rate, listing mode, and policy overrides.
 * @returns {object} Price fields and pricingRule; missing cost/rate/mode gives null prices.
 * @throws {Error} For a non-positive fee denominator or invalid profit rate.
 */
export function calculateCnCardSalePrice({
  costCny,
  usdCnyRate,
  paymentFeeRate = CN_CARD_PRICING_POLICY.paymentFeeRate,
  singleProfitRate = CN_CARD_PRICING_POLICY.singleProfitRate,
  bundleProfitRate = CN_CARD_PRICING_POLICY.bundleProfitRate,
  listingMode = "",
  cardGrade = "",
  bundleDefaultMinimumUsd = CN_CARD_PRICING_POLICY.bundleDefaultMinimumUsd,
  bundleGradeMinimumUsd = CN_CARD_PRICING_POLICY.bundleGradeMinimumUsd,
} = {}) {
  const cost = Number(costCny);
  const rate = Number(usdCnyRate);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return {
      saleCny: null,
      saleUsd: null,
      legacySaleCny: null,
      legacySaleUsd: null,
      rawSaleCny: null,
      rawSaleUsd: null,
      bundleMinimumUsd: null,
      bundleMinimumApplied: false,
      pricingRule: "missing_cost_or_rate",
    };
  }

  const netRevenueDenominator = 1 - Number(paymentFeeRate);
  if (netRevenueDenominator <= 0) throw new Error(`Invalid payment fee rate ${paymentFeeRate}.`);

  const normalizedMode = String(listingMode || "").trim();
  const isBundle = normalizedMode === "bundle_single_sku_product";
  const isSingle = normalizedMode === "single_variant_product";
  if (!isBundle && !isSingle) {
    return {
      saleCny: null,
      saleUsd: null,
      legacySaleCny: null,
      legacySaleUsd: null,
      rawSaleCny: null,
      rawSaleUsd: null,
      bundleMinimumUsd: null,
      bundleMinimumApplied: false,
      pricingRule: "missing_or_invalid_listing_mode",
    };
  }
  const profitRate = isBundle ? Number(bundleProfitRate) : Number(singleProfitRate);
  if (!Number.isFinite(profitRate) || profitRate < 0) {
    throw new Error(`Invalid profit rate ${profitRate} for ${normalizedMode}.`);
  }
  const rawSaleCny = (cost * (1 + profitRate)) / netRevenueDenominator;
  const rawSaleUsd = rawSaleCny / rate;
  const bundleMinimumUsd = isBundle
    ? getCnCardBundleMinimumUsd(cardGrade, { bundleDefaultMinimumUsd, bundleGradeMinimumUsd })
    : null;
  const bundleMinimumApplied = Number.isFinite(bundleMinimumUsd) && rawSaleUsd < bundleMinimumUsd;
  const adjustedSaleUsd = bundleMinimumApplied ? bundleMinimumUsd : rawSaleUsd;
  const saleUsd = ceilUsd(adjustedSaleUsd);
  const basePricingRule = isBundle
    ? "bundle_profit_200_of_procurement_cost"
    : "single_profit_100_of_procurement_cost";
  const pricingRule = [
    basePricingRule,
    bundleMinimumApplied ? `bundle_minimum_${bundleMinimumUsd}_usd` : "",
    "ceil_to_integer_usd",
  ].filter(Boolean).join("+");

  return {
    saleCny: round2(saleUsd * rate),
    saleUsd,
    rawSaleCny: round2(rawSaleCny),
    rawSaleUsd: round2(rawSaleUsd),
    profitRate,
    listingMode: normalizedMode,
    // Compatibility fields for existing report readers. They now mirror the
    // mode-based raw price and are never used to choose a pricing branch.
    legacySaleCny: round2(rawSaleCny),
    legacySaleUsd: round2(rawSaleUsd),
    bundleMinimumUsd,
    bundleMinimumApplied,
    pricingRule,
  };
}

export function cnCardPricingFormulaSummary({
  paymentFeeRate = CN_CARD_PRICING_POLICY.paymentFeeRate,
  singleProfitRate = CN_CARD_PRICING_POLICY.singleProfitRate,
  bundleProfitRate = CN_CARD_PRICING_POLICY.bundleProfitRate,
  bundleDefaultMinimumUsd = CN_CARD_PRICING_POLICY.bundleDefaultMinimumUsd,
  bundleGradeMinimumUsd = CN_CARD_PRICING_POLICY.bundleGradeMinimumUsd,
  usdCnyRate = null,
} = {}) {
  return {
    policy: "Formula primitives: singles use 100% profit; all-low bundles use 200% aggregate procurement profit and existing grade floors. New high or mixed bundles sum final single prices. Purchase-option classification uses raw per-card procurement price (<=20 CNY low), never rarity or listing mode; use auditPurchaseOptions for the new scheme.",
    policyVersion: CN_CARD_PRICING_POLICY.version,
    flashDispatchFeeCny: CN_CARD_PRICING_POLICY.flashDispatchFeeCny,
    singleSaleCny: "singleCostCny * (1 + singleProfitRate) / (1 - paymentFeeRate)",
    bundleSaleCny: "bundleCostCny * (1 + bundleProfitRate) / (1 - paymentFeeRate)",
    saleUsd: "ceil(max(rawSaleCny / usdCnyRate, applicableBundleMinimumUsd))",
    paymentFeeRate,
    singleProfitRate,
    bundleProfitRate,
    bundleDefaultMinimumUsd,
    bundleGradeMinimumUsd,
    usdCnyRate,
    usdCnyRatePolicy: "operator_fixed_default_with_explicit_override",
    // Compatibility alias for existing report readers. This value is now the
    // storefront pricing rate and is not necessarily a live Wise market rate.
    wiseUsdCnyRate: usdCnyRate,
  };
}
