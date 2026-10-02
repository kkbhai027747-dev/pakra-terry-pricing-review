import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseAppListing } from './app-listing.mjs';
import { sha256 } from './files.mjs';

const read = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function rect(value) {
  const match = typeof value === 'string' && /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return left < right && top < bottom && right <= 720 && bottom <= 1280 ? { left, top, right, bottom } : null;
}
const inside = (a, b) => a && b && a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom;
function visibleRows(nodes, context) {
  if (!Array.isArray(nodes)) throw new Error('Invalid flat node evidence.');
  const visible = nodes.filter((node) => node && rect(node.bounds));
  const controls = visible.filter((node) => (node['content-desc'] === '最低价')
    || ((node.text === 'RAW' || node['content-desc'] === 'RAW') && [true, 'true'].includes(node.selected)));
  if (controls.length < 2) throw new Error('Listing controls missing in the captured session.');
  const controlsBottom = Math.max(...controls.map((node) => rect(node.bounds).bottom));
  return visible.flatMap((node) => {
    const rawLabel = node['content-desc'];
    if (typeof rawLabel !== 'string' || rect(node.bounds).bottom <= controlsBottom) return [];
    const parts = rawLabel.split(',').map((part) => part.trim());
    if (parts.some((part) => !part) || !((parts.length === 5 && parts[3] === 'RAW')
      || (parts.length === 4 && parts[2] === 'RAW'))) return [];
    const [cardName, cardNumber] = parts;
    const rarity = parts.length === 5 ? parts[2] : null;
    const rawPriceLabel = parts.at(-1);
    const prefixed = cardNumber.startsWith(`${context.setCode}-`) && cardNumber.length > context.setCode.length + 1 && !/[\s()]/.test(cardNumber);
    const original = context.language === 'en' && context.setCode === '30C' && /^[A-Z][A-Z0-9]*-\d+(?:\/\d+)?\(30C\)$/.test(cardNumber);
    const legendSet = context.language === 'ja' && context.setCode === 'M6a'
      && /^M6a-\d+~\d+\/\d+\(1Set\)$/.test(cardNumber);
    if ((!prefixed && !original && !legendSet) || /原包|原盒|整盒|卡包|sealed/i.test(rarity)) return [];
    if (!visible.some((child) => child.text === rawPriceLabel && inside(rect(child.bounds), rect(node.bounds))
      && rect(child.bounds).top >= controlsBottom && rect(child.bounds).bottom - rect(child.bounds).top >= 24)) return [];
    let displayedFromCny = null;
    let pricePrecision;
    const amount = /^¥(\d+)(?:\.(\d{1,2}))?起$/.exec(rawPriceLabel);
    if (amount) {
      const cents = Number(amount[1]) * 100 + Number((amount[2] || '').padEnd(2, '0'));
      if (!Number.isSafeInteger(cents) || cents <= 0) return [];
      displayedFromCny = (cents / 100).toFixed(2);
      pricePrecision = 'full';
    } else if (/^¥\d+(?:\.\d{1,2})?万起$/.test(rawPriceLabel)) pricePrecision = 'abbreviated';
    else if (rawPriceLabel === '暂无') pricePrecision = 'unavailable_display';
    else return [];
    return [{ cardName, cardNumber, rarity, rawPriceLabel, displayedFromCny, pricePrecision, rawLabel }];
  });
}

const csvCell = (value) => {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

/** Summarize public UI evidence only; never produces card IDs or business quotes. */
export function summarizeAppList(directory) {
  const root = resolve(directory);
  if (existsSync(resolve(root, 'stopped.json')) || !existsSync(resolve(root, 'session.json'))) {
    throw new Error('A completed session.json without stopped.json is required.');
  }
  for (const name of ['observations.json', 'observations.csv']) {
    if (existsSync(resolve(root, name))) throw new Error('Observation outputs already exist; refusing overwrite.');
  }
  const session = read(resolve(root, 'session.json'));
  if (session.status !== 'public_listing_evidence_only' || !Array.isArray(session.pages)
    || !session.pages.length || session.pages.length > 100 || typeof session.endObserved !== 'boolean') {
    throw new Error('Invalid completed capture session.');
  }
  const observations = new Map();
  const rawLabels = new Set();
  let previousHash = null;
  let previousTime = -Infinity;
  let displayedCardCount;
  for (const [index, entry] of session.pages.entries()) {
    const page = index + 1;
    const stem = `page-${String(page).padStart(3, '0')}`;
    const metadata = read(resolve(root, `${stem}.json`));
    const time = Date.parse(entry.capturedAt);
    if (entry.page !== page || entry.previousXmlSha256 !== previousHash || !isDeepStrictEqual(metadata, entry)
      || typeof entry.capturedAt !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(entry.capturedAt)
      || !Number.isFinite(time) || time < previousTime
      || entry.headerCodeChecked !== (page === 1)
      || entry.continuity !== (page === 1 ? 'initial_header' : 'same_session_swipe')) {
      throw new Error(`Page ${page} metadata or session continuity mismatch.`);
    }
    for (const [extension, field] of [['xml', 'xmlSha256'], ['png', 'pngSha256'], ['nodes.json', 'nodesSha256']]) {
      const bytes = readFileSync(resolve(root, `${stem}.${extension}`));
      if (!/^[a-f0-9]{64}$/.test(entry[field]) || sha256(bytes) !== entry[field]) throw new Error(`Page ${page} ${extension} hash mismatch.`);
    }
    const nodes = read(resolve(root, `${stem}.nodes.json`));
    if (page === 1) {
      displayedCardCount = parseAppListing(nodes, session.context).displayedCardCount;
      if (displayedCardCount !== session.initialDisplayedCardCount) throw new Error('Initial displayed card count mismatch.');
    }
    if (entry.displayedCardCount !== null && entry.displayedCardCount !== displayedCardCount) throw new Error(`Page ${page} displayed count changed.`);
    for (const row of visibleRows(nodes, session.context)) {
      rawLabels.add(row.rawLabel);
      const key = JSON.stringify([row.cardName, row.cardNumber, row.rarity, row.rawPriceLabel]);
      const existing = observations.get(key);
      if (existing) {
        existing.latestCapturedAt = entry.capturedAt;
        existing.lastPage = page;
        if (!existing.pages.includes(page)) existing.pages.push(page);
      } else observations.set(key, { ...row, firstCapturedAt: entry.capturedAt, latestCapturedAt: entry.capturedAt,
        firstPage: page, lastPage: page, pages: [page] });
    }
    previousHash = entry.xmlSha256;
    previousTime = time;
  }
  const rows = [...observations.values()];
  const numbers = new Map();
  for (const row of rows) numbers.set(row.cardNumber, (numbers.get(row.cardNumber) || 0) + 1);
  const report = { kind: 'public_listing_observations', context: session.context,
    completeCatalogVerified: false, lowestAskingVerified: false, originalImagesCaptured: false,
    displayedCardCount, distinctCardNumbers: numbers.size, distinctRowLabels: rawLabels.size,
    endObserved: session.endObserved, missingCount: Math.max(0, displayedCardCount - numbers.size),
    countsAreReferenceOnly: true, tabFilteringVerified: false,
    duplicateCardNumbers: [...numbers].filter(([, count]) => count > 1).map(([cardNumber, count]) => ({ cardNumber, distinctObservations: count })),
    pages: session.pages.length, observations: rows };
  const fields = ['cardName', 'cardNumber', 'rarity', 'rawPriceLabel', 'displayedFromCny', 'pricePrecision', 'firstCapturedAt', 'latestCapturedAt', 'firstPage', 'lastPage', 'pages'];
  const csv = [fields.map(csvCell).join(','), ...rows.map((row) => fields.map((field) => csvCell(field === 'pages' ? row.pages.join(';') : row[field])).join(','))].join('\r\n');
  writeFileSync(resolve(root, 'observations.csv'), `\uFEFF${csv}\r\n`, { flag: 'wx' });
  writeFileSync(resolve(root, 'observations.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node summarize-app-list.mjs COMPLETED_SESSION_DIRECTORY');
    const report = summarizeAppList(process.argv[2]);
    console.log(JSON.stringify({ kind: report.kind, pages: report.pages, distinctCardNumbers: report.distinctCardNumbers,
      distinctRowLabels: report.distinctRowLabels, missingCount: report.missingCount, completeCatalogVerified: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
