import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppDetail, parseAppVersionMinimum } from './app-detail.mjs';
import { readJson, sha256 } from './files.mjs';

const timestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error('Invalid evidence timestamp.');
  return Date.parse(value);
};

function verifyFrame(root, stem, entry) {
  if (!entry || typeof entry !== 'object') throw new Error(`Missing ${stem} evidence metadata.`);
  timestamp(entry.capturedAt);
  for (const [extension, field] of [['xml', 'xmlSha256'], ['png', 'pngSha256'], ['nodes.json', 'nodesSha256']]) {
    if (!/^[a-f0-9]{64}$/.test(entry[field] || '')
      || sha256(readFileSync(resolve(root, `${stem}.${extension}`))) !== entry[field]) {
      throw new Error(`${stem} ${extension} hash mismatch.`);
    }
  }
  return readJson(resolve(root, `${stem}.nodes.json`));
}

const evidence = (entry) => Object.fromEntries(['capturedAt', 'xmlSha256', 'pngSha256', 'nodesSha256']
  .map((key) => [key, entry[key]]));

/** Recheck original completed public UI evidence without writing an observation or price quote. */
export function verifyAppDetail(directory) {
  const root = resolve(directory);
  if (existsSync(resolve(root, 'failure.json')) || existsSync(resolve(root, 'stopped.json'))
    || !existsSync(resolve(root, 'session.json'))) throw new Error('A completed session without failure evidence is required.');
  const session = readJson(resolve(root, 'session.json'));
  if (session.status !== 'public_detail_evidence_only' || !Array.isArray(session.pages)
    || !session.pages.length || session.pages.length > 20) throw new Error('Invalid completed detail session.');
  const expectedFiles = session.pages.flatMap((_, index) => ['xml', 'png', 'nodes.json']
    .map((extension) => `page-${String(index + 1).padStart(3, '0')}.${extension}`)).sort();
  const pageFiles = readdirSync(root).filter((name) => /^page-\d+\.(?:xml|png|nodes\.json)$/.test(name)).sort();
  if (JSON.stringify(pageFiles) !== JSON.stringify(expectedFiles)) throw new Error('Captured page file count or numbering mismatch.');

  let previousHash = null;
  let previousTime = -Infinity;
  const observations = [];
  const pages = [];
  let context;
  for (const [index, entry] of session.pages.entries()) {
    const time = timestamp(entry.capturedAt);
    if (entry.page !== index + 1 || entry.previousXmlSha256 !== previousHash || time < previousTime
      || entry.headerChecked !== (index === 0)
      || entry.continuity !== (index === 0 ? 'exact_header_after_known_deeplink' : 'same_session_swipe')) {
      throw new Error(`Page ${index + 1} metadata or session continuity mismatch.`);
    }
    const nodes = verifyFrame(root, `page-${String(index + 1).padStart(3, '0')}`, entry);
    const parsed = parseAppDetail(nodes, session.context, { requireHeader: index === 0 });
    context = parsed.context;
    const reference = { page: entry.page, ...evidence(entry) };
    pages.push({ ...reference, headerVerified: parsed.headerVerified, controls: parsed.controls });
    observations.push(...parsed.observations.map((row) => ({ ...row, evidence: reference })));
    previousHash = entry.xmlSha256;
    previousTime = time;
  }

  let minimum = { status: 'not_exact_minimum', amountCny: null, reason: 'missing_minimum_evidence',
    conditionScope: 'app_unfiltered_version_minimum', quoteEligible: false };
  if (session.minimumEvidence != null) {
    const entry = session.minimumEvidence;
    const time = timestamp(entry.capturedAt);
    if (time < timestamp(session.pages[0].capturedAt)
      || (session.pages.length > 1 && time > timestamp(session.pages[1].capturedAt))) {
      throw new Error('Minimum evidence is outside the first-page capture sequence.');
    }
    const nodes = verifyFrame(root, 'minimum', entry);
    try {
      minimum = { ...parseAppVersionMinimum(nodes, session.context), status: 'observed', evidence: evidence(entry) };
    } catch (error) {
      if (error.message !== 'No exact version minimum is displayed; this does not establish no stock.') throw error;
      minimum = { ...minimum, reason: 'no_exact_minimum_displayed', evidence: evidence(entry) };
    }
  } else if (['minimum.xml', 'minimum.png', 'minimum.nodes.json'].some((name) => existsSync(resolve(root, name)))) {
    throw new Error('Minimum files exist without corresponding evidence metadata.');
  }
  const report = { kind: 'public_detail_observations', status: minimum.status, context,
    sourceUrl: context.shareUrl, capturedAt: session.pages[0].capturedAt,
    latestCapturedAt: session.minimumEvidence
      && timestamp(session.minimumEvidence.capturedAt) > timestamp(session.pages.at(-1).capturedAt)
      ? session.minimumEvidence.capturedAt : session.pages.at(-1).capturedAt,
    headerVerified: true, lowestAskingVerified: false, quoteEligible: false,
    conditionScope: minimum.conditionScope, originalImageDownloaded: false,
    pageCount: pages.length, pages, minimum, observations };
  return report;
}

/** Summarize completed public UI evidence; never creates a business quote. */
export function summarizeAppDetail(directory) {
  const output = resolve(directory, 'observations.json');
  if (existsSync(output)) throw new Error('Observation output already exists; refusing overwrite.');
  const report = verifyAppDetail(directory);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node summarize-app-detail.mjs COMPLETED_SESSION_DIRECTORY');
    const report = summarizeAppDetail(process.argv[2]);
    console.log(JSON.stringify({ kind: report.kind, status: report.status, pages: report.pageCount,
      offersObserved: report.observations.length, minimumCny: report.minimum.amountCny, quoteEligible: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
