const LANGUAGES = new Set(['zh-Hans', 'ja', 'en']);
const CONDITIONS = ['流通品相', '有瑕疵', '有损伤'];
const APP_PACKAGE = 'com.jihuanshe.pro';

function rectangle(value) {
  const match = typeof value === 'string' && /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function within(inner, outer) {
  return inner && outer && inner.left >= outer.left && inner.top >= outer.top
    && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

function cny(value) {
  const match = /^(\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const minor = Number(match[1].replaceAll(',', '')) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0
    ? `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : null;
}

const isTrue = (value) => value === true || value === 'true';
const labelIs = (node, label) => node.text === label || node['content-desc'] === label;
const cardNames = (context) => [...new Set([context.cardName, context.originalName].filter(Boolean))];

function readPublicNodes(nodes, context) {
  if (!Array.isArray(nodes) || !nodes.length || !LANGUAGES.has(context?.language)
    || !/^[1-9]\d*$/.test(context.setId || '')
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(context.setCode || '')
    || !['packName', 'cardName', 'cardNumber'].every((key) => typeof context[key] === 'string' && context[key].trim())
    || (context.originalName !== undefined && (typeof context.originalName !== 'string' || !context.originalName.trim()))
    || !/^https:\/\/api\.jihuanshe\.com\/pro\/cards\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(context.shareUrl || '')) {
    throw new Error('Explicit card context, official share URL and flat UI nodes are required.');
  }
  nodes.forEach((node, index) => {
    if (!node || (node.parentIndex !== null
      && (!Number.isInteger(node.parentIndex) || node.parentIndex < 0 || node.parentIndex >= index))) {
      throw new Error('UI nodes must have ordered parentIndex values, with null for roots.');
    }
    if (isTrue(node.password) || (node.class === 'android.widget.EditText'
      && ![...cardNames(context), context.cardNumber].includes(node.text))
      || /登录|注册|验证码|手机号|手机号码|密码/.test(`${node.text || ''} ${node['content-desc'] || ''}`)) {
      throw new Error('Login or private input is not public card-detail evidence.');
    }
    if (node.package && node.package !== APP_PACKAGE) {
      throw new Error('Card-detail evidence must contain only the official app.');
    }
  });
  const rectangles = nodes.map((node) => rectangle(node.bounds));
  const indices = nodes.map((_, index) => index).filter((index) => rectangles[index]);
  const ancestors = (index) => {
    const result = [];
    for (let parent = nodes[index].parentIndex; parent !== null; parent = nodes[parent].parentIndex) result.push(parent);
    return result;
  };
  const descendant = (child, parent) => ancestors(child).includes(parent);
  const matches = (label) => indices.filter((index) => labelIs(nodes[index], label));
  const buttons = (label) => matches(label).filter((index) => nodes[index].class === 'android.widget.Button');
  const oneButton = (label) => {
    const found = buttons(label);
    if (found.length !== 1) throw new Error('Unambiguous card-detail controls are required.');
    return found[0];
  };
  return { rectangles, indices, ancestors, descendant, matches, oneButton };
}

const cardContext = (context) => Object.fromEntries(['language', 'setId', 'setCode', 'packName', 'cardName', 'originalName', 'cardNumber', 'shareUrl']
  .filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));

/** Public UI observations only. Context/share URL and a single viewport cannot certify a quote. */
export function parseAppDetail(nodes, context, { requireHeader = true } = {}) {
  if (typeof requireHeader !== 'boolean') throw new Error('requireHeader must be a boolean.');
  const { rectangles, indices, ancestors, descendant, matches, oneButton } = readPublicNodes(nodes, context);
  const sell = oneButton('出售');
  const buy = oneButton('立即加购');
  const bar = ancestors(sell).find((index) => descendant(buy, index));
  const toolbar = nodes[oneButton('返回')].parentIndex;
  if (bar === undefined || toolbar === null || !rectangles[bar] || !rectangles[toolbar]
    || rectangles[bar].top <= rectangles[toolbar].bottom) {
    throw new Error('Visible top and bottom action bars are required.');
  }
  const single = oneButton('单卡');
  const graded = oneButton('评级卡');
  const fixedButtons = indices.filter((index) => nodes[index].class === 'android.widget.Button'
    && /^一口价,\s*(?:\d+|999\+)$/.test(nodes[index]['content-desc'] || ''));
  if (fixedButtons.length !== 1) throw new Error('One fixed-price listing control is required.');
  const compactConditions = indices.filter((index) => nodes[index].class === 'android.widget.Button'
    && (nodes[index]['content-desc'] || '').startsWith('评级筛选'));
  let conditionButtons;
  if (compactConditions.length) {
    const index = compactConditions[0], parent = nodes[index].parentIndex;
    const controlArea = { left: rectangles[bar].left, right: rectangles[bar].right,
      top: rectangles[toolbar].bottom, bottom: rectangles[bar].top };
    const visible = (child) => within(rectangles[child], controlArea)
      && ancestors(child).every((ancestor) => within(rectangles[child], rectangles[ancestor]));
    const labels = indices.filter((child) => descendant(child, index)
      && nodes[child].class === 'android.widget.TextView' && nodes[child].text === CONDITIONS[0]);
    if (compactConditions.length !== 1
      || nodes[index]['content-desc'] !== '评级筛选：流通品相，点击选择'
      || CONDITIONS.some((label) => matches(label).some((child) => nodes[child].class === 'android.widget.Button'))
      || parent === null || [single, graded, fixedButtons[0]].some((child) => nodes[child].parentIndex !== parent)
      || !visible(index) || labels.length !== 1 || !visible(labels[0])
      || rectangles[labels[0]].bottom - rectangles[labels[0]].top < 24) {
      throw new Error('Unambiguous visible compact condition controls are required.');
    }
    conditionButtons = [index];
  } else conditionButtons = CONDITIONS.map(oneButton);
  const controls = [single, graded, ...conditionButtons, fixedButtons[0]];
  const visibleArea = { left: rectangles[bar].left, right: rectangles[bar].right,
    top: Math.max(rectangles[toolbar].bottom, ...controls.map((index) => rectangles[index].bottom)),
    bottom: rectangles[bar].top };
  if (visibleArea.bottom <= visibleArea.top) throw new Error('No unobscured offer area is visible.');
  const fullyVisible = (index, area = visibleArea) => within(rectangles[index], area)
    && ancestors(index).every((parent) => within(rectangles[index], rectangles[parent]));

  let header = null;
  const inputs = indices.filter((index) => nodes[index].class === 'android.widget.EditText');
  if (requireHeader || inputs.length) {
    let names = inputs.filter((index) => nodes[index].text === context.cardName);
    const numbers = inputs.filter((index) => nodes[index].text === context.cardNumber);
    const languageLabel = context.languageLabel || ({ 'zh-Hans': '简中', ja: '日文' })[context.language];
    const distinctOriginal = typeof context.originalName === 'string' && context.originalName !== context.cardName;
    const canonicalEnglish = context.originalName === undefined && /[A-Za-z]/.test(context.cardName)
      && !/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/.test(context.cardName);
    const displayName = distinctOriginal ? context.originalName : canonicalEnglish ? context.cardName : null;
    const englishNameOnly = context.language === 'en' && context.setId === '100236' && context.setCode === '30C'
      && context.packName === '30周年庆典' && languageLabel === '英文'
      && displayName && names.length === (distinctOriginal ? 0 : 1)
      && nodes.filter((node) => node.class === 'android.widget.EditText').length === 2
      && matches('查看系列 30th Celebration').some((index) => nodes[index].class === 'android.widget.Button');
    const actualHeaderName = englishNameOnly ? displayName : context.cardName;
    const actualPackName = englishNameOnly ? '30th Celebration' : context.packName;
    if (englishNameOnly) names = inputs.filter((index) => nodes[index].text === displayName);
    const parent = names.length === 1 ? nodes[names[0]].parentIndex : null;
    const headerArea = { ...visibleArea, top: rectangles[toolbar].bottom,
      bottom: Math.min(...controls.map((index) => rectangles[index].top)) };
    const series = matches(`查看系列 ${actualPackName}`);
    if (englishNameOnly && (series.length !== 1 || nodes[series[0]].class !== 'android.widget.Button'
      || nodes.filter((node) => node.class === 'android.widget.Button' && (node['content-desc'] || '').startsWith('查看系列')).length !== 1)) {
      throw new Error('One exact observed English-series button is required.');
    }
    if (!languageLabel || names.length !== 1 || numbers.length !== 1 || parent === null
      || nodes[numbers[0]].parentIndex !== parent
      || !fullyVisible(names[0], headerArea) || !fullyVisible(numbers[0], headerArea)
      || !matches(languageLabel).some((index) => descendant(index, parent) && fullyVisible(index, headerArea))
      || !matches('宝可梦').some((index) => descendant(index, parent) && fullyVisible(index, headerArea))
      || !series.some((index) => descendant(index, parent) && fullyVisible(index, headerArea))) {
      throw new Error('Visible public card header does not match the explicit card context.');
    }
    if (context.originalName && context.originalName !== context.cardName) {
      const originals = inputs.filter((index) => nodes[index].text === context.originalName);
      if (originals.length !== 1 || nodes[originals[0]].parentIndex !== parent || !fullyVisible(originals[0], headerArea)) {
        throw new Error('Visible original card name does not match the explicit card context.');
      }
    }
    header = { cardName: actualHeaderName, cardNumber: context.cardNumber,
      languageLabel, packName: actualPackName,
      ...(context.originalName ? { originalName: context.originalName } : {}),
      ...(englishNameOnly ? { layout: distinctOriginal ? 'original_name_only' : 'canonical_name_only', actualHeaderName, actualPackName } : {}) };
  }

  const observations = [];
  for (const index of indices) {
    const row = nodes[index];
    const description = row['content-desc'] || '';
    const offerName = cardNames(context).find((name) => description.startsWith(`${name}, `));
    if (row.class !== 'android.widget.Button' || !offerName
      || !fullyVisible(index)) continue;
    const match = /, ([¥￥]((?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?)\/张), (库存\s+([1-9]\d*))$/.exec(description);
    if (!match) continue;
    const priceCny = cny(match[2]);
    const stock = Number(match[4]);
    if (!priceCny || !Number.isSafeInteger(stock)) continue;
    const children = indices.filter((child) => descendant(child, index));
    const visibleTexts = (text) => children.filter((child) => nodes[child].text === text
      && fullyVisible(child) && within(rectangles[child], rectangles[index]) && rectangles[child].bottom - rectangles[child].top >= 24);
    const prices = visibleTexts(match[1]);
    const stocks = visibleTexts(match[3]);
    if (prices.length !== 1 || stocks.length !== 1 || !visibleTexts(offerName).length) continue;
    const warehouse = visibleTexts('集换仓').length === 1
      && description.startsWith(`${offerName}, 集换仓, `);
    observations.push({ cardName: offerName, priceCny, stock,
      offerKind: warehouse ? 'warehouse' : 'seller', nodeIndex: index,
      bounds: row.bounds, priceBounds: nodes[prices[0]].bounds, stockBounds: nodes[stocks[0]].bounds });
  }
  const selectedConditions = conditionButtons.filter((index) => isTrue(nodes[index].selected));
  return {
    kind: 'app_detail_observations',
    context: cardContext(context),
    header, headerVerified: header !== null, lowestAskingVerified: false,
    controls: { singleCardSelected: isTrue(nodes[single].selected) ? true : null,
      fixedPriceSelected: isTrue(nodes[fixedButtons[0]].selected) ? true : null,
      conditionSelected: selectedConditions.length === 1
        ? (compactConditions.length ? CONDITIONS[0] : nodes[selectedConditions[0]]['content-desc']) : null },
    visibleArea, observations,
  };
}

/** The app labels this version minimum explicitly, but does not state its condition scope. */
export function parseAppVersionMinimum(nodes, context) {
  const { rectangles, indices, ancestors, descendant, matches, oneButton } = readPublicNodes(nodes, context);
  const panels = matches('全部语言版本').filter((index) => nodes[index].class === 'android.view.ViewGroup');
  if (panels.length !== 1) throw new Error('One complete language-version panel is required.');
  const panel = panels[0];
  oneButton('关闭全部版本列表');
  const collapse = oneButton('收起');
  if (!descendant(collapse, panel)) throw new Error('Version panel controls do not match.');
  const fullyVisible = (index) => within(rectangles[index], rectangles[panel])
    && ancestors(index).every((parent) => within(rectangles[index], rectangles[parent]));
  const currentRows = indices.filter((index) => nodes[index].class === 'android.widget.Button'
    && descendant(index, panel) && cardNames(context).some((name) =>
      (nodes[index]['content-desc'] || '').startsWith(`${name}, 当前, ${context.cardNumber}, `)));
  if (currentRows.length !== 1 || !fullyVisible(currentRows[0])) {
    throw new Error('One fully visible exact current-card row is required.');
  }
  const row = currentRows[0];
  const match = /, (最低价 [¥￥]((?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?)起)$/.exec(nodes[row]['content-desc']);
  const amountCny = match && cny(match[2]);
  if (!amountCny) throw new Error('No exact version minimum is displayed; this does not establish no stock.');
  const visibleTexts = (text) => indices.filter((index) => nodes[index].text === text
    && descendant(index, row) && fullyVisible(index) && within(rectangles[index], rectangles[row])
    && rectangles[index].bottom - rectangles[index].top >= 24);
  const prices = visibleTexts(match[1]);
  const rowName = cardNames(context).find((name) => nodes[row]['content-desc'].startsWith(`${name}, 当前, `));
  if (prices.length !== 1 || [rowName, context.cardNumber, '当前'].some((text) => visibleTexts(text).length !== 1)) {
    throw new Error('Current-card identity and exact minimum must have fully visible matching child text.');
  }
  return {
    kind: 'app_version_minimum_observation', context: cardContext(context),
    amountCny, sourceMetricLabel: '最低价', sourceDisplayLabel: match[1],
    conditionScope: 'app_unfiltered_version_minimum', quoteEligible: false,
    nodeIndex: row, bounds: nodes[row].bounds, priceBounds: nodes[prices[0]].bounds,
  };
}
