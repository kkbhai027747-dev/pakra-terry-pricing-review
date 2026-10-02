const LANGUAGES = new Set(['zh-Hans', 'ja', 'en']);

function rectangle(value) {
  const match = typeof value === 'string' && /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function within(inner, outer) {
  return inner && inner.left >= outer.left && inner.top >= outer.top
    && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

function displayedPrice(label) {
  const match = /^¥(\d+)(?:\.(\d{1,2}))?起$/.exec(label);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0
    ? `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : null;
}

/** Parse observed list labels only. Caller context is not a verified card identity. */
export function parseAppListing(nodes, context) {
  if (!Array.isArray(nodes) || !LANGUAGES.has(context?.language)
    || typeof context.setId !== 'string' || !/^[1-9]\d*$/.test(context.setId)
    || typeof context.setCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(context.setCode)
    || typeof context.packName !== 'string' || !context.packName.trim()) {
    throw new Error('Explicit pack context and flat UI nodes are required.');
  }
  const visible = nodes.filter((node) => node && rectangle(node.bounds));
  const labelIs = (node, label) => node.text === label || node['content-desc'] === label;
  if (visible.some((node) => labelIs(node, '登录/注册') || labelIs(node, '请输入手机号'))) {
    throw new Error('Login page is not card-list evidence.');
  }
  const firstText = visible.filter((node) => typeof node.text === 'string' && node.text.trim())
    .sort((a, b) => rectangle(a.bounds).top - rectangle(b.bounds).top)[0];
  const countNodes = visible.filter((node) => /^卡牌,\s*[1-9]\d*$/.test(node['content-desc'] || ''));
  const counts = new Set(countNodes.map((node) => Number(node['content-desc'].split(',')[1].trim())));
  if (counts.size !== 1 || !Number.isSafeInteger([...counts][0])) {
    throw new Error('One unambiguous displayed card count is required.');
  }
  const countTop = Math.min(...countNodes.map((node) => rectangle(node.bounds).top));
  if (firstText?.text !== context.packName || !visible.some((node) => node.text === context.setCode
    && rectangle(node.bounds).bottom <= countTop)) {
    throw new Error('Visible pack header does not match the explicit pack context.');
  }
  const rawControls = visible.filter((node) => labelIs(node, 'RAW')
    && (node.selected === true || node.selected === 'true'));
  const minimumControls = visible.filter((node) => node['content-desc'] === '最低价');
  if (rawControls.length !== 1 || !minimumControls.length
    || visible.some((node) => labelIs(node, 'PSA10') && (node.selected === true || node.selected === 'true'))) {
    throw new Error('Selected RAW and the lowest-price control are required.');
  }
  const controlsBottom = Math.max(rectangle(rawControls[0].bounds).bottom,
    ...minimumControls.map((node) => rectangle(node.bounds).bottom));
  const observations = [];
  const seenNumbers = new Set();
  for (const node of visible) {
    const rawLabel = node['content-desc'];
    if (typeof rawLabel !== 'string' || rectangle(node.bounds).top < controlsBottom) continue;
    const parts = rawLabel.split(',').map((part) => part.trim());
    if (![4, 5].includes(parts.length) || parts.some((part) => !part) || parts.at(-2) !== 'RAW') continue;
    const [cardName, cardNumber] = parts;
    const rarity = parts.length === 5 ? parts[2] : null;
    const priceLabel = parts.at(-1);
    const prefixedNumber = cardNumber.startsWith(`${context.setCode}-`)
      && cardNumber.length > context.setCode.length + 1 && !/[\s()]/.test(cardNumber);
    const anniversaryNumber = context.language === 'en' && context.setCode === '30C'
      && /^[A-Z][A-Z0-9]*-\d+(?:\/\d+)?\(30C\)$/.test(cardNumber);
    const legendSetNumber = context.language === 'ja' && context.setCode === 'M6a'
      && /^M6a-\d+~\d+\/\d+\(1Set\)$/.test(cardNumber);
    if ((!prefixedNumber && !anniversaryNumber && !legendSetNumber) || /原包|原盒|整盒|卡包|sealed/i.test(rarity)) continue;
    const displayedFromCny = displayedPrice(priceLabel);
    const abbreviated = /^¥\d+(?:\.\d{1,2})?万起$/.test(priceLabel);
    const unavailableDisplay = priceLabel === '暂无';
    // A truncated card can retain an accessibility label; require its visible price text too.
    if ((displayedFromCny === null && !abbreviated && !unavailableDisplay) || !visible.some((child) => child.text === priceLabel
      && within(rectangle(child.bounds), rectangle(node.bounds)))) continue;
    if (seenNumbers.has(cardNumber)) throw new Error('Ambiguous repeated card number in this viewport.');
    seenNumbers.add(cardNumber);
    observations.push({ cardName, cardNumber, rarity, displayedFromCny,
      pricePrecision: abbreviated ? 'abbreviated' : unavailableDisplay ? 'unavailable_display' : 'full', rawLabel, bounds: node.bounds });
  }
  return {
    kind: 'app_listing_observations',
    context: { language: context.language, setId: context.setId, setCode: context.setCode, packName: context.packName },
    displayedCardCount: [...counts][0],
    lowestAskingVerified: false,
    observations,
  };
}
