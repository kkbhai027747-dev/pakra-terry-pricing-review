/**
 * Qiandao condition parsing and in-memory Flash offer selection.
 * Used by pricing and capture consumers through cn-card-pricing-policy.mjs.
 * Inspects supplied text/rows only; does not crawl or contact Qiandao.
 */

/**
 * Rank accepted conditions: pass first, then accepted CCG/BaoCui scores 9–10.
 * @param {unknown} value Raw condition label/description.
 * @returns {0|1|null} null means the condition is not accepted.
 */
export function qiandaoConditionRank(value) {
  const text = normalizeQiandaoConditionText(value);
  if (!text) return null;
  const hasExplicitStatusPassLabel = /(?:^|\s)状态\s*通行品相(?:\s|$)/.test(text);
  if (hasExplicitStatusPassLabel) return 0;
  if (/PCG/i.test(text) || /瑕疵|问题|破损|折痕|划伤|损角|缺损/.test(text)) return null;
  if (/^通行品相(?:\s|$)/.test(text)) return 0;
  if (!/(CCG|保粹)/i.test(text)) return null;
  const score = qiandaoConditionScore(text);
  return score != null && score >= 9 && score <= 10 ? 1 : null;
}

/**
 * Read an explicit grading score while ignoring amounts labelled as prices.
 * @param {unknown} value Raw condition label/description.
 * @returns {number|null} Highest contextual score, or null when absent/unscored.
 */
export function qiandaoConditionScore(value) {
  const text = normalizeQiandaoConditionText(value);
  if (/未\s*(?:标\s*)?分|未\s*评\s*分|无\s*评\s*分/.test(text)) return null;

  const scores = [];
  for (const match of text.matchAll(/(?:^|[^\d.])(10(?:\.0+)?|9(?:\.\d+)?)(?![\d.])/gi)) {
    const scoreText = match[1];
    const scoreOffset = match[0].lastIndexOf(scoreText);
    const scoreStart = match.index + scoreOffset;
    const scoreEnd = scoreStart + scoreText.length;
    const before = text.slice(Math.max(0, scoreStart - 32), scoreStart);
    const after = text.slice(scoreEnd, scoreEnd + 16);

    const isCurrencyAmount = /^\s*(?:元|块|圆|[￥¥]|RMB|CNY)/i.test(after);
    const hasPriceLabel = /(?:售价|价格|市场价|现价|原价|到手价|卖价)\s*[:：]?\s*$/i.test(before);
    if (isCurrencyAmount || hasPriceLabel) continue;

    const hasScoreUnit = /^\s*分/.test(after);
    const hasAdjacentGradingContext = /(?:CCG|保粹)\s*(?:(?:官方)?(?:评级卡?|评分|分数|等级|认证|品相)\s*)?[:：]?\s*$/i.test(before);
    const hasGemMintGradingContext = /(?:CCG|保粹)\s*(?:GEM\s*MINT)\s*[:：]?\s*$/i.test(before);
    if (!hasScoreUnit && !hasAdjacentGradingContext && !hasGemMintGradingContext) continue;

    const score = Number(scoreText);
    if (Number.isFinite(score) && score >= 0 && score <= 10) scores.push(score);
  }
  return scores.length > 0 ? Math.max(...scores) : null;
}

export function qiandaoConditionSource(value, channel = "flash") {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!new Set(["flash", "personal"]).has(normalizedChannel)) return "";
  const rank = qiandaoConditionRank(value);
  if (rank === 0) return `qiandao_${normalizedChannel}_pass_condition`;
  if (rank === 1) return `qiandao_${normalizedChannel}_ccg_9_plus_condition`;
  return "";
}

/**
 * Choose a stocked Flash offer by condition tier, price, then stable row ID.
 * @param {object[]} [rows] Supplied trade rows; the input array is not sorted in place.
 * @returns {object|null} A selected row with normalized fields, or null.
 */
export function selectQiandaoAcceptedFlashTradeRow(rows = []) {
  const accepted = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const hasStock = row?.hasStock === true || (
      row?.hasStock == null
      && (Number(row?.sellingAmount) > 0 || Number(row?.stockOrderCount) > 0)
    );
    if (String(row?.ownerName || "") !== "千岛闪购卡牌" || !hasStock) continue;
    const priceCny = Number(row?.priceCny);
    if (!(priceCny > 0)) continue;
    const conditionRank = qiandaoConditionRank(row?.conditionText);
    if (conditionRank == null) continue;
    accepted.push({
      ...row,
      priceCny,
      conditionRank,
      conditionScore: qiandaoConditionScore(row?.conditionText),
      priceSource: qiandaoConditionSource(row?.conditionText, "flash"),
    });
  }
  accepted.sort((left, right) => left.conditionRank - right.conditionRank
    || left.priceCny - right.priceCny
    || String(left.id || "").localeCompare(String(right.id || ""), "en", { numeric: true }));
  return accepted[0] || null;
}

function normalizeQiandaoConditionText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
