import { pathToFileURL } from 'node:url';

const APP = 'com.jihuanshe.pro';
const LANGUAGE_LABELS = { 'zh-Hans': '简中', ja: '日文', en: '英文' };
const isTrue = (value) => value === true || value === 'true';
const fail = (code, diagnostic) => { throw Object.assign(new Error(code), { code, ...(diagnostic ? { diagnostic } : {}) }); };
const labelIs = (node, label) => node.text === label || node['content-desc'] === label;
const rectangle = (value) => {
  const match = typeof value === 'string' && /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};
const within = (inner, outer) => inner && outer && inner.left >= outer.left && inner.top >= outer.top
  && inner.right <= outer.right && inner.bottom <= outer.bottom;
const center = (box) => ({ x: Math.floor((box.left + box.right) / 2), y: Math.floor((box.top + box.bottom) / 2) });

function packContext(context) {
  if (!context || !LANGUAGE_LABELS[context.language] || !/^[1-9]\d*$/.test(context.setId || '')
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(context.setCode || '')
    || typeof context.packName !== 'string' || !context.packName.trim()) fail('invalid_pack_context');
  return Object.fromEntries(['language', 'setId', 'setCode', 'packName'].map((key) => [key, context[key]]));
}

function publicTree(nodes, { allowInputs = false } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) fail('invalid_ui_tree');
  nodes.forEach((node, index) => {
    if (!node || (node.parentIndex !== null
      && (!Number.isInteger(node.parentIndex) || node.parentIndex < 0 || node.parentIndex >= index))) fail('invalid_ui_tree');
    if (node.package && node.package !== APP) fail('foreign_app');
    if (isTrue(node.password) || /登录|注册|验证码|手机号|手机号码|密码/.test(`${node.text || ''} ${node['content-desc'] || ''}`)
      || (!allowInputs && node.class === 'android.widget.EditText')) fail('private_or_login_screen');
  });
  const boxes = nodes.map((node) => rectangle(node.bounds));
  const indices = nodes.map((_, index) => index).filter((index) => boxes[index]);
  const ancestors = (index) => {
    const parents = [];
    for (let parent = nodes[index].parentIndex; parent !== null; parent = nodes[parent].parentIndex) parents.push(parent);
    return parents;
  };
  const descendant = (child, parent) => ancestors(child).includes(parent);
  const visible = (index, area = { left: 0, top: 0, right: 720, bottom: 1280 }) => within(boxes[index], area)
    && ancestors(index).every((parent) => within(boxes[index], boxes[parent]));
  const matches = (label) => indices.filter((index) => labelIs(nodes[index], label));
  return { boxes, indices, ancestors, descendant, visible, matches };
}

function cardRecord(card) {
  if (!card || !['cardName', 'cardNumber'].every((key) => typeof card[key] === 'string' && card[key].trim())
    || (card.rarity !== undefined && card.rarity !== null && (typeof card.rarity !== 'string' || !card.rarity.trim()))
    || /原包|原盒|整盒|卡包|sealed/i.test(`${card.cardName} ${card.rarity || ''}`)) fail('invalid_expected_card');
  return { cardName: card.cardName, cardNumber: card.cardNumber, rarity: card.rarity ?? null };
}

/** A same-session caller may omit only the expanded pack header after it scrolls out. */
export function parsePackCardTargets(nodes, context, expectedCards, { requireHeader = true } = {}) {
  const pack = packContext(context);
  if (typeof requireHeader !== 'boolean' || !Array.isArray(expectedCards) || !expectedCards.length) fail('invalid_expected_cards');
  const expected = new Map();
  for (const value of expectedCards) {
    const card = cardRecord(value);
    if (expected.has(card.cardNumber)) fail('duplicate_expected_card');
    expected.set(card.cardNumber, card);
  }
  const { boxes, indices, descendant, visible, matches } = publicTree(nodes);
  const firstText = indices.filter((index) => nodes[index].text?.trim() && visible(index))
    .sort((a, b) => boxes[a].top - boxes[b].top)[0];
  if (requireHeader && nodes[firstText]?.text !== pack.packName) fail('pack_header_mismatch');
  const cardCount = (label) => {
    const match = /^(?:卡牌,\s*([1-9]\d*)|卡牌\(([1-9]\d*)\))$/.exec(label || '');
    return match ? Number(match[1] || match[2]) : null;
  };
  const counts = indices.filter((index) => cardCount(nodes[index]['content-desc']) !== null && visible(index));
  const countValues = new Set(counts.map((index) => cardCount(nodes[index]['content-desc'])));
  if (requireHeader && (countValues.size !== 1 || [...countValues][0] !== expected.size
    || !matches(pack.setCode).some((index) => visible(index) && boxes[index].bottom <= Math.min(...counts.map((item) => boxes[item].top))))) {
    fail('pack_header_mismatch');
  }
  const raw = matches('RAW').filter((index) => isTrue(nodes[index].selected) && visible(index));
  const minimum = indices.filter((index) => nodes[index]['content-desc'] === '最低价' && visible(index));
  if (raw.length !== 1 || !minimum.length || matches('PSA10').some((index) => isTrue(nodes[index].selected))) fail('pack_controls_mismatch');
  const controlsBottom = Math.max(boxes[raw[0]].bottom, ...minimum.map((index) => boxes[index].bottom));
  if (!matches(pack.packName).some((index) => visible(index) && boxes[index].bottom <= controlsBottom)) fail('pack_header_mismatch');
  const area = { left: 0, top: controlsBottom, right: 720, bottom: 1280 };
  const targets = [];
  const seen = new Set();
  for (const index of indices) {
    const node = nodes[index];
    if (!isTrue(node.clickable) || !visible(index, area)) continue;
    const parts = (node['content-desc'] || '').split(',').map((part) => part.trim());
    const number = parts.find((part) => expected.has(part));
    const card = expected.get(number);
    if (!card || !/^(?:[¥￥]\d+(?:\.\d{1,2})?万?起|暂无)$/.test(parts.at(-1))) continue;
    const rarity = card.rarity ? [card.rarity] : [];
    const old = [card.cardName, card.cardNumber, ...rarity, 'RAW'];
    const current = [card.cardName, ...rarity, card.cardNumber, 'RAW', LANGUAGE_LABELS[pack.language]];
    const prefix = parts.slice(0, -1);
    if (![old, current].some((shape) => shape.length === prefix.length && shape.every((value, offset) => prefix[offset] === value))) continue;
    const childText = (text) => indices.filter((child) => nodes[child].text === text && descendant(child, index)
      && visible(child, area) && within(boxes[child], boxes[index]) && boxes[child].bottom - boxes[child].top >= 24);
    if (childText(card.cardName).length !== 1 || childText(card.cardNumber).length !== 1) continue;
    if (seen.has(number)) fail('ambiguous_visible_card');
    const image = indices.find((child) => nodes[child].parentIndex === index && boxes[child].top === boxes[index].top
      && boxes[child].bottom - boxes[child].top >= 100 && visible(child, area));
    const tap = image === undefined ? center(boxes[childText(card.cardName)[0]]) : center(boxes[image]);
    const smallActionAtTap = indices.some((child) => descendant(child, index) && isTrue(nodes[child].clickable)
      && tap.x >= boxes[child].left && tap.x < boxes[child].right && tap.y >= boxes[child].top && tap.y < boxes[child].bottom);
    if (smallActionAtTap) continue;
    seen.add(number);
    targets.push({ ...card, nodeIndex: index, bounds: node.bounds, tap });
  }
  return { kind: 'app_pack_card_targets', context: pack, headerVerified: requireHeader, controlsBottom, targets };
}

/** Discover the optional original name only inside an exact, independently identified public card header. */
export function discoverAppDetailIdentity(nodes, context, expectedCard) {
  const pack = packContext(context);
  const card = cardRecord(expectedCard);
  const { boxes, indices, ancestors, descendant, visible, matches } = publicTree(nodes, { allowInputs: true });
  const oneButton = (label) => {
    const found = matches(label).filter((index) => nodes[index].class === 'android.widget.Button' && visible(index));
    if (found.length !== 1) fail('detail_controls_mismatch');
    return found[0];
  };
  const back = oneButton('返回');
  const sell = oneButton('出售');
  const buy = oneButton('立即加购');
  const bar = ancestors(sell).find((index) => descendant(buy, index));
  const toolbar = nodes[back].parentIndex;
  if (bar === undefined || toolbar === null || !boxes[bar] || !boxes[toolbar] || boxes[bar].top <= boxes[toolbar].bottom) fail('detail_controls_mismatch');
  const inputs = indices.filter((index) => nodes[index].class === 'android.widget.EditText');
  const names = inputs.filter((index) => nodes[index].text === card.cardName);
  const numbers = inputs.filter((index) => nodes[index].text === card.cardNumber);
  const parent = names.length === 1 ? nodes[names[0]].parentIndex : null;
  const area = { left: 0, top: boxes[toolbar].bottom, right: 720, bottom: boxes[bar].top };
  if (![2, 3].includes(inputs.length) || names.length !== 1 || numbers.length !== 1 || parent === null
    || inputs.some((index) => nodes[index].parentIndex !== parent || !visible(index, area))
    || !['宝可梦', LANGUAGE_LABELS[pack.language], `查看系列 ${pack.packName}`].every((label) =>
      matches(label).some((index) => descendant(index, parent) && visible(index, area)))) fail('detail_header_mismatch');
  const extra = inputs.filter((index) => ![names[0], numbers[0]].includes(index));
  let originalName;
  if (extra.length) {
    const index = extra[0];
    const nameBox = boxes[names[0]];
    const originalBox = boxes[index];
    // Observed multiline titles overlap the aligned original-name widget by four pixels.
    const titlePaddingOverlap = originalBox.top >= nameBox.bottom - 4 && originalBox.top > nameBox.top
      && originalBox.bottom > nameBox.bottom && originalBox.left === nameBox.left && originalBox.right === nameBox.right;
    if (typeof nodes[index].text !== 'string' || !nodes[index].text.trim() || nodes[index].text.length > 200
      || (originalBox.top < nameBox.bottom && !titlePaddingOverlap) || originalBox.bottom > boxes[numbers[0]].top) {
      fail('unexpected_public_input', {
        inputCount: inputs.length, originalNameType: typeof nodes[index].text,
        originalNameLength: typeof nodes[index].text === 'string' ? nodes[index].text.length : null,
        originalNameEmpty: typeof nodes[index].text === 'string' ? !nodes[index].text.trim() : null,
        nameBounds: boxes[names[0]], originalNameBounds: boxes[index], numberBounds: boxes[numbers[0]],
      });
    }
    originalName = nodes[index].text;
  }
  return { kind: 'app_card_identity', context: { ...pack, cardName: card.cardName, cardNumber: card.cardNumber,
    languageLabel: LANGUAGE_LABELS[pack.language], ...(originalName ? { originalName } : {}) }, headerVerified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4_000_000) fail('input_too_large');
    }
    const request = JSON.parse(input.replace(/^\uFEFF/, ''));
    const result = request.mode === 'pack'
      ? parsePackCardTargets(request.nodes, request.context, request.expectedCards, { requireHeader: request.requireHeader ?? true })
      : request.mode === 'detail' ? discoverAppDetailIdentity(request.nodes, request.context, request.expectedCard) : fail('invalid_mode');
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: /^[a-z_]+$/.test(error.code || '') ? error.code : 'invalid_input',
      ...(error.code === 'unexpected_public_input' && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    process.exitCode = 1;
  }
}
