/**
 * Procurement evidence acceptance, priority, freshness, and personal fallback.
 * Consumes supplied capture records; does not fetch prices or change inventory.
 * Used by pricing/policy.mjs and the stable cn-card-pricing-policy.mjs entry.
 */

import { round2 } from "../pricing/money.mjs";

const QIANDAO_PRICE_SOURCE_PRIORITY = Object.freeze({
  qiandao_flash_pass_condition: 1,
  qiandao_flash_ccg_9_5_condition: 2,
  qiandao_flash_ccg_10_condition: 2,
  qiandao_flash_ccg_9_plus_condition: 2,
  qiandao_flash_ccg_9_0_condition: 2,
  qiandao_personal_pass_condition: 3,
  qiandao_personal_ccg_9_5_condition: 4,
  qiandao_personal_ccg_10_condition: 4,
  qiandao_personal_ccg_9_plus_condition: 4,
  qiandao_personal_ccg_9_0_condition: 4,
});

export const QIANDAO_ACCEPTED_PROCUREMENT_SOURCES = Object.freeze(
  Object.keys(QIANDAO_PRICE_SOURCE_PRIORITY),
);

export function isAcceptedQiandaoProcurementSource(source) {
  return QIANDAO_ACCEPTED_PROCUREMENT_SOURCES.includes(String(source || ""));
}

const QIANDAO_PERSONAL_SELLER_EVIDENCE_FIELDS = Object.freeze([
  "personalSpuId",
  "flashSpuId",
  "flashCaptureSpuId",
  "flashEvidence",
  "flashExactSpuMatched",
  "flashNuxtDataFound",
  "flashNuxtDataParsed",
  "flashExchangePayloadFound",
  "flashExchangeRowsFieldFound",
  "flashExchangeRowsRawCount",
  "flashCaptureStatus",
  "flashCaptureError",
  "flashTradeCandidateNodes",
  "flashTradeRows",
  "flashTradeRowsChecked",
  "flashPriceCaptureDate",
  "priceCaptureDate",
  "personalSellerFallbackEligible",
  "personalSellerFallbackReason",
  "personalFallbackStatus",
  "fixedPricePages",
  "fixedPriceListingsChecked",
  "rejectionReasonCounts",
  "condition",
  "conditionScore",
  "stock",
  "exactSpuMatched",
]);

/**
 * Preserve evidence fields needed by downstream personal-offer checks.
 * @param {object} [evidence] Capture record, optionally containing a nested row.
 * @returns {object} Evidence fields, or an empty object for non-personal sources.
 */
export function qiandaoPersonalSellerEvidence(evidence = {}) {
  const priceSource = stringEvidenceField(evidence, ["qiandaoPriceSource", "priceSource", "source"]);
  if (!priceSource.startsWith("qiandao_personal_")) return {};
  const containers = evidenceContainers(evidence);
  const output = {};
  for (const field of QIANDAO_PERSONAL_SELLER_EVIDENCE_FIELDS) {
    const value = firstOwnEvidenceValue(containers, [field]);
    if (value !== undefined) output[field] = value;
  }

  for (const [canonicalField, aliases] of Object.entries({
    qiandaoSellerShippingCny: ["qiandaoSellerShippingCny", "sellerShippingCny", "shippingCny"],
    qiandaoTotalPayableCny: ["qiandaoTotalPayableCny", "totalPayableCny"],
    qiandaoPersonalListingId: ["qiandaoPersonalListingId", "listingId"],
    qiandaoPersonalListingUrl: ["qiandaoPersonalListingUrl", "listingUrl"],
  })) {
    const value = firstOwnEvidenceValue(containers, aliases);
    if (value !== undefined) output[canonicalField] = value;
  }
  return output;
}

const PERSONAL_FALLBACK_FLASH_STATUSES = Object.freeze([
  "exchange_empty_confirmed",
  "current_no_stock",
  "exchange_rows_no_accepted_offer",
]);

export const QIANDAO_CAPTURE_REPORT_POLICY = Object.freeze({
  acceptedConditionsInPriorityOrder: Object.freeze([
    "通行品相",
    "CCG/保粹评分 >= 9.0（同优先级取最低价）",
  ]),
  rejectedConditions: Object.freeze([
    "PCG",
    "CCG/保粹评分 < 9.0",
    "未明确评分的评级卡",
    "瑕疵/问题品相",
  ]),
  personalFallbackEligibleFlashStatuses: PERSONAL_FALLBACK_FLASH_STATUSES,
  personalFallbackEvidenceRequirements: Object.freeze([
    "exact_spu_match",
    "flash_nuxt_data_parsed",
    "flash_exchange_payload_found",
    "flash_exchange_rows_field_found",
    "confirmed_no_eligible_flash_stock_status",
  ]),
  technicalFailureMutationPolicy: "freeze",
});

/**
 * Allow personal fallback only after successful exact-SPU Flash capture proves no eligible stock.
 * Technical failures and inconsistent capture payloads fail closed.
 * @param {object} [evidence] Fields on the record, row, or flashEvidence.
 * @returns {{ok: boolean, reason: string}} Gate result; no remote calls.
 */
export function validateQiandaoPersonalSellerFallbackEvidence(evidence = {}) {
  const personalSpuId = stringEvidenceField(evidence, ["personalSpuId", "qiandaoSpuId", "spuId"]);
  if (!personalSpuId) return { ok: false, reason: "exact_spu_missing" };

  const flashSpuId = stringEvidenceField(evidence, ["flashSpuId", "flashCaptureSpuId"])
    || stringFlashEvidenceField(evidence, ["spuId", "qiandaoSpuId"]);
  if (!flashSpuId) return { ok: false, reason: "flash_exact_spu_missing" };
  if (personalSpuId !== flashSpuId) return { ok: false, reason: "exact_spu_mismatch" };

  const exactSpuMatched = booleanEvidenceField(evidence, "flashExactSpuMatched");
  const nuxtParsed = booleanEvidenceField(evidence, "flashNuxtDataParsed");
  const exchangePayloadFound = booleanEvidenceField(evidence, "flashExchangePayloadFound");
  const rowsFieldFound = booleanEvidenceField(evidence, "flashExchangeRowsFieldFound");
  if (exactSpuMatched !== true || nuxtParsed !== true || exchangePayloadFound !== true || rowsFieldFound !== true) {
    return { ok: false, reason: "flash_capture_not_technically_successful" };
  }

  const status = stringEvidenceField(evidence, ["flashCaptureStatus"])
    || stringFlashEvidenceField(evidence, ["flashCaptureStatus"]);
  if (!PERSONAL_FALLBACK_FLASH_STATUSES.includes(status)) {
    return { ok: false, reason: "flash_status_not_fallback_eligible" };
  }

  const rawCount = numberEvidenceField(evidence, "flashExchangeRowsRawCount");
  if (!Number.isInteger(rawCount) || rawCount < 0) {
    return { ok: false, reason: "flash_rows_count_missing" };
  }
  if (status === "exchange_empty_confirmed" && rawCount !== 0) {
    return { ok: false, reason: "flash_status_payload_inconsistent" };
  }
  if (status !== "exchange_empty_confirmed" && rawCount === 0) {
    return { ok: false, reason: "flash_status_payload_inconsistent" };
  }
  return { ok: true, reason: "confirmed_no_eligible_flash_stock" };
}

/**
 * Order valid evidence by source priority, then payable cost including shipping.
 * @param {object} [candidate]
 * @param {object} [current]
 * @returns {-1|0|1} Negative means the candidate is preferred.
 */
export function compareQiandaoPriceEvidence(candidate = {}, current = {}) {
  const candidatePrice = qiandaoEvidencePrice(candidate);
  const currentPrice = qiandaoEvidencePrice(current);
  const candidatePriced = candidatePrice != null;
  const currentPriced = currentPrice != null;
  if (candidatePriced !== currentPriced) return candidatePriced ? -1 : 1;
  if (!candidatePriced) return 0;

  const candidatePriority = qiandaoPriceSourcePriority(qiandaoEvidenceSource(candidate));
  const currentPriority = qiandaoPriceSourcePriority(qiandaoEvidenceSource(current));
  if (candidatePriority !== currentPriority) return candidatePriority < currentPriority ? -1 : 1;
  if (candidatePrice !== currentPrice) return candidatePrice < currentPrice ? -1 : 1;
  return 0;
}

export function qiandaoPriceSourcePriority(source) {
  const normalized = String(source || "");
  const matched = Object.entries(QIANDAO_PRICE_SOURCE_PRIORITY)
    .find(([key]) => normalized === key || normalized.startsWith(`${key}_`));
  return matched?.[1] ?? Number.MAX_SAFE_INTEGER;
}

export function isQiandaoPriceEvidenceCurrent(evidence = {}, targetDate = new Date().toISOString().slice(0, 10)) {
  const expectedDate = String(targetDate || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
  if (!expectedDate) return false;
  const evidenceDates = [
    evidence.priceCaptureDate,
    evidence.qiandaoPriceCaptureDate,
    evidence.flashPriceCaptureDate,
    evidence.priceCapturedAt,
    evidence.qiandaoPriceCapturedAt,
    evidence.priceSourceFile,
    evidence.qiandaoPriceSourceFile,
    evidence.sourceFile,
  ].map((value) => String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean);
  return evidenceDates.includes(expectedDate);
}

/**
 * Read a price captured on the target day; personal offers require full fallback/payment evidence.
 * @param {object} [evidence]
 * @param {string} [targetDate] Defaults to the current UTC date.
 * @returns {number|null} Item price in CNY, excluding shipping, or null.
 */
export function currentQiandaoPriceCny(evidence = {}, targetDate = new Date().toISOString().slice(0, 10)) {
  if (!isQiandaoPriceEvidenceCurrent(evidence, targetDate)) return null;
  const value = Number(evidence.priceCny ?? evidence.qiandaoPriceCny);
  if (!Number.isFinite(value) || value <= 0) return null;
  const source = String(evidence.priceSource || evidence.qiandaoPriceSource || "");
  if (source.startsWith("qiandao_personal_")) {
    const fallback = validateQiandaoPersonalSellerFallbackEvidence(evidence);
    const shipping = Number(evidence.shippingCny ?? evidence.qiandaoSellerShippingCny);
    const total = Number(evidence.totalPayableCny ?? evidence.qiandaoTotalPayableCny);
    const listingId = String(evidence.listingId || evidence.qiandaoPersonalListingId || "").trim();
    const listingUrl = String(evidence.listingUrl || evidence.qiandaoPersonalListingUrl || "").trim();
    if (!fallback.ok || !Number.isFinite(shipping) || shipping < 0 || !listingId || !listingUrl) return null;
    if (!Number.isFinite(total) || total <= 0 || round2(value + shipping) !== round2(total)) return null;
  }
  return value;
}

/**
 * Check supplied price evidence for an accepted inventory-capture status.
 * @param {object} [evidence]
 * @param {string} [targetDate] Defaults to the current UTC date.
 * @returns {boolean} Eligibility only; does not read or write store inventory.
 */
export function isCurrentAcceptedQiandaoInventoryEvidence(
  evidence = {},
  targetDate = new Date().toISOString().slice(0, 10),
) {
  const source = String(evidence.priceSource || evidence.qiandaoPriceSource || "");
  if (!isAcceptedQiandaoProcurementSource(source)) return false;
  if (currentQiandaoPriceCny(evidence, targetDate) == null) return false;
  if (source.startsWith("qiandao_flash_")) {
    return String(evidence.flashCaptureStatus || "") === "accepted_offer";
  }
  if (source.startsWith("qiandao_personal_")) {
    return String(evidence.personalFallbackStatus || "") === "accepted_personal_listing_found"
      && validateQiandaoPersonalSellerFallbackEvidence(evidence).ok;
  }
  return false;
}

function qiandaoEvidenceSource(evidence) {
  return String(
    evidence?.source
    || evidence?.priceSource
    || evidence?.qiandaoPriceSource
    || evidence?.row?.priceSource
    || evidence?.row?.qiandaoPriceSource
    || "",
  );
}

function qiandaoEvidencePrice(evidence) {
  const source = qiandaoEvidenceSource(evidence);
  const value = Number(
    evidence?.price
    ?? evidence?.priceCny
    ?? evidence?.qiandaoPriceCny
    ?? evidence?.row?.priceCny
    ?? evidence?.row?.qiandaoPriceCny,
  );
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!source.startsWith("qiandao_personal_")) return value;
  if (!validateQiandaoPersonalSellerFallbackEvidence(evidence).ok) return null;
  const shipping = numberEvidenceField(evidence, "shippingCny")
    ?? numberEvidenceField(evidence, "sellerShippingCny")
    ?? numberEvidenceField(evidence, "qiandaoSellerShippingCny");
  return Number.isFinite(shipping) && shipping >= 0 ? value + shipping : null;
}

function evidenceContainers(evidence) {
  return [evidence, evidence?.row].filter((entry) => entry && typeof entry === "object");
}

function firstOwnEvidenceValue(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
  }
  return undefined;
}

function flashEvidenceContainers(evidence) {
  return [evidence?.flashEvidence, evidence?.row?.flashEvidence]
    .filter((entry) => entry && typeof entry === "object");
}

function rawEvidenceField(evidence, keys) {
  for (const container of evidenceContainers(evidence)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
  }
  for (const container of flashEvidenceContainers(evidence)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
  }
  return undefined;
}

function rawFlashEvidenceField(evidence, keys) {
  for (const container of flashEvidenceContainers(evidence)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
  }
  return undefined;
}

function stringEvidenceField(evidence, keys) {
  return String(rawEvidenceField(evidence, keys) ?? "").trim();
}

function stringFlashEvidenceField(evidence, keys) {
  return String(rawFlashEvidenceField(evidence, keys) ?? "").trim();
}

function booleanEvidenceField(evidence, key) {
  return rawEvidenceField(evidence, [key]);
}

function numberEvidenceField(evidence, key) {
  const value = rawEvidenceField(evidence, [key]);
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
