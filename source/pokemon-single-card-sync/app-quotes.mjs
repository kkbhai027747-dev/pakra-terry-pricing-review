import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './files.mjs';
import { verifyAppDetail } from './summarize-app-detail.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const SHARE = new RegExp(`^https://api\\.jihuanshe\\.com/pro/cards/(${UUID})$`);
const LABELS = { 'zh-Hans': '简中', ja: '日文', en: '英文' };
const SCOPE = 'app_unfiltered_version_minimum';
const CONTEXT_FIELDS = ['language', 'setId', 'setCode', 'packName', 'cardName', 'cardNumber', 'shareUrl'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function localPath(value, root = WORKSPACE) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('invalid_app_evidence_path');
  const path = resolve(value), child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('app_evidence_path_escape');
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail('app_evidence_symlink');
    if (dirname(cursor) === cursor) break;
  }
  return path;
}

function directory(path, root) {
  const checked = localPath(path, root);
  if (!lstatSync(checked).isDirectory()) fail('invalid_app_evidence_directory');
  return checked;
}

function file(path, root) {
  const checked = localPath(path, root);
  if (!lstatSync(checked).isFile()) fail('invalid_app_evidence_file');
  return readFileSync(checked);
}

function json(path, root) {
  try { return JSON.parse(file(path, root).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code?.startsWith('app_') || error.code?.startsWith('invalid_app_')) throw error; fail('invalid_app_evidence_json'); }
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail('invalid_app_evidence_time');
  return Date.parse(value);
}

function sameContext(actual, expected) {
  return CONTEXT_FIELDS.every((key) => actual?.[key] === expected[key])
    && (actual?.originalName ?? '') === (expected.originalName ?? '')
    && (actual?.languageLabel ?? LABELS[actual?.language]) === LABELS[expected.language];
}

function catalogIndex(cards) {
  if (!Array.isArray(cards)) fail('invalid_app_catalog');
  const identities = new Set(), index = new Map();
  for (const card of cards) {
    if (!card?.identity || identities.has(card.identity)) fail('duplicate_catalog_identity');
    identities.add(card.identity);
    if (card.sourceKind !== 'official_app_ui') continue;
    const match = SHARE.exec(card.sourceUrl || '');
    if (!match || card.ip !== 'pokemon' || !LABELS[card.language] || !/^[1-9]\d*$/.test(card.setId)
      || card.versionIdKind !== 'jihuanshe_pro_card_uuid' || card.versionId !== match[1]
      || card.identity !== `pokemon:${card.language}:${card.setId}:${match[1]}`
      || !['setCode', 'packName', 'name', 'number'].every((key) => typeof card[key] === 'string' && card[key].trim())) fail('invalid_app_catalog_identity');
    if (index.has(card.sourceUrl)) fail('duplicate_catalog_uuid');
    index.set(card.sourceUrl, card);
  }
  return index;
}

/** Reverify local capture evidence against the exact catalog; never reads a device or Shopify. */
export function verifyAppDailyQuotes(value, catalogCards, { now = new Date(), allowStoppedPrefix = false } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('invalid_app_verification_time');
  if (typeof allowStoppedPrefix !== 'boolean') fail('invalid_app_partial_option');
  const root = directory(value);
  const reportBytes = file(resolve(root, 'report.json'), root);
  let report;
  try { report = JSON.parse(reportBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('invalid_app_daily_report'); }
  const selection = report?.selection;
  const partial = allowStoppedPrefix && report?.status === 'stopped';
  if (report?.kind !== 'app_daily_public_observations' || report.status !== 'observations_only' && !partial
    || report.quoteEligible !== false || !Array.isArray(report.cards) || !report.cards.length
    || !selection || !['offset', 'limit', 'selected', 'inputCount'].every((key) => Number.isSafeInteger(selection[key]))
    || selection.offset < 0 || selection.offset >= selection.inputCount || selection.limit < 1 || selection.limit > 100
    || selection.selected !== Math.min(selection.limit, selection.inputCount - selection.offset)
    || report.cards.length !== selection.selected
    || report.observed !== report.cards.filter((row) => row?.status === 'observed').length
    || report.notExactMinimum !== report.cards.filter((row) => row?.status === 'not_exact_minimum').length) fail('incomplete_app_daily_report');
  let prefixLength = report.cards.length;
  if (partial) {
    prefixLength = report.cards.findIndex(row => !['observed', 'not_exact_minimum'].includes(row?.status));
    const stopped = report.cards[prefixLength];
    if (selection.inputCount !== 20 || prefixLength < 1 || !stopped || report.attempted !== prefixLength + 1
      || stopped.status !== 'capture_stopped' || stopped.stage !== 'validate_public_detail' || stopped.reason !== 'device_command_failed'
      || report.cards.slice(prefixLength + 1).some(row => row?.status !== 'not_attempted')) fail('unsupported_app_stopped_prefix');
  } else if (report.attempted !== selection.selected) fail('incomplete_app_daily_report');
  const started = instant(report.startedAt), completed = instant(report.completedAt);
  if (completed < started || completed > now.getTime()) fail('invalid_app_run_sequence');
  const index = catalogIndex(catalogCards), urls = new Set(), quotes = [], unquoted = [], targetIdentities = [], excluded = [];
  let previousCapture = started;
  const attemptedRows = partial ? report.cards.slice(0, prefixLength + 1) : report.cards;
  const expectedDirectories = attemptedRows.map((_, position) => `card-${String(selection.offset + position + 1).padStart(6, '0')}`).sort();
  const actualDirectories = readdirSync(root).filter((name) => name.startsWith('card-')).sort();
  if (JSON.stringify(expectedDirectories) !== JSON.stringify(actualDirectories)) fail('app_card_directory_mismatch');

  for (const [position, row] of report.cards.entries()) {
    const unfinished = partial && position >= prefixLength;
    if (!row || row.index !== selection.offset + position || !unfinished && !['observed', 'not_exact_minimum'].includes(row.status)
      || row.quoteEligible !== false || !SHARE.test(row.sourceUrl || '')) fail('invalid_app_observation_row');
    if (urls.has(row.sourceUrl)) fail('duplicate_daily_uuid');
    urls.add(row.sourceUrl);
    const card = index.get(row.sourceUrl);
    if (!card || row.cardNumber !== card.number || row.language !== card.language) fail('daily_catalog_identity_mismatch');
    if (unfinished && (row.amountCny !== null || row.observedAt !== null || row.conditionScope !== null || row.evidence != null)) {
      fail('invalid_app_unfinished_observation');
    }
    if (unfinished && row.status === 'not_attempted') {
      if (row.stage !== undefined || row.reason !== undefined) fail('invalid_app_unfinished_observation');
      excluded.push({ identity: card.identity, index: row.index, status: row.status, quoteEligible: false });
      continue;
    }
    const expected = { language: card.language, setId: card.setId, setCode: card.setCode, packName: card.packName,
      cardName: card.name, originalName: card.originalName ?? '', cardNumber: card.number, shareUrl: card.sourceUrl };
    const cardDirectory = directory(resolve(root, `card-${String(row.index + 1).padStart(6, '0')}`), root);
    const contextPath = resolve(cardDirectory, 'context.json');
    const context = json(contextPath, root);
    if (!sameContext(context, expected)) fail('daily_context_identity_mismatch');
    const capture = directory(resolve(cardDirectory, 'capture'), root);
    // Reject links before the verifier reads its fixed evidence filenames.
    for (const name of readdirSync(capture)) {
      const checked = localPath(resolve(capture, name), root);
      if (!lstatSync(checked).isFile()) fail('unexpected_capture_directory');
    }
    if (unfinished) {
      if (JSON.stringify(readdirSync(capture).sort()) !== JSON.stringify(['failure.json'])) fail('invalid_app_transport_failure_evidence');
      const failurePath = resolve(capture, 'failure.json'), observationPath = resolve(cardDirectory, 'observation.json');
      const failure = json(failurePath, root), observation = json(observationPath, root);
      if (failure.status !== row.status || failure.stage !== row.stage || failure.reason !== row.reason
        || observation.status !== row.status || observation.stage !== row.stage || observation.reason !== row.reason
        || observation.amountCny !== null || observation.observedAt !== null || observation.quoteEligible !== false) {
        fail('invalid_app_transport_failure_evidence');
      }
      const stoppedAt = instant(failure.observedAt);
      if (stoppedAt < previousCapture || stoppedAt > completed) fail('invalid_app_transport_failure_sequence');
      excluded.push({ identity: card.identity, index: row.index, status: row.status, stage: row.stage, reason: row.reason,
        quoteEligible: false, failureSha256: sha256(file(failurePath, root)), contextSha256: sha256(file(contextPath, root)),
        observationSha256: sha256(file(observationPath, root)) });
      continue;
    }
    const sessionPath = resolve(capture, 'session.json');
    const session = json(sessionPath, root);
    if (!sameContext(session.context, expected)) fail('session_context_identity_mismatch');
    let observation;
    try { observation = verifyAppDetail(capture); }
    catch { fail('app_capture_evidence_invalid'); }
    if (!sameContext(observation.context, expected) || observation.sourceUrl !== card.sourceUrl
      || observation.headerVerified !== true || observation.status !== row.status
      || observation.conditionScope !== SCOPE) fail('app_observation_identity_mismatch');
    const first = instant(observation.capturedAt), last = instant(observation.latestCapturedAt);
    if (first < started || last < first || last > completed) fail('app_capture_outside_run');
    if (partial && first < previousCapture) fail('invalid_app_prefix_capture_sequence');
    previousCapture = last;
    targetIdentities.push(card.identity);
    if (observation.status !== 'observed') {
      unquoted.push({ identity: card.identity, sourceUrl: card.sourceUrl, reason: observation.minimum.reason,
        conditionScope: SCOPE, quoteEligible: false });
      continue;
    }
    const minimum = observation.minimum;
    if (!sameContext(minimum.context, expected) || !/^\d+\.\d{2}$/.test(minimum.amountCny || '')
      || Number(minimum.amountCny) <= 0 || minimum.sourceMetricLabel !== '最低价'
      || minimum.conditionScope !== SCOPE || !minimum.evidence) fail('invalid_app_minimum');
    const observedAt = new Date(instant(minimum.evidence.capturedAt)).toISOString();
    quotes.push({ identity: card.identity, language: card.language, setId: card.setId, versionId: card.versionId,
      versionIdKind: 'jihuanshe_pro_card_uuid', sourceKind: 'official_app_ui', sourceUrl: card.sourceUrl,
      currency: 'CNY', metric: 'lowest_asking', amountCny: minimum.amountCny, available: true, observedAt,
      conditionScope: SCOPE, sourceMetricLabel: minimum.sourceMetricLabel, sourceDisplayLabel: minimum.sourceDisplayLabel,
      quoteEligible: true, evidence: { kind: 'verified_app_daily_minimum', directory: capture,
        dailyReportSha256: sha256(reportBytes), contextSha256: sha256(file(contextPath, root)),
        sessionSha256: sha256(file(sessionPath, root)), header: observation.pages[0], minimum: minimum.evidence } });
  }
  return { kind: 'verified_app_quotes', source: 'jihuanshe', metric: 'lowest_asking', sourceKind: 'official_app_ui',
    conditionScope: SCOPE, verifiedAt: now.toISOString(), directory: root, reportSha256: sha256(reportBytes),
    selection: { ...selection }, targetIdentities, quotes, unquoted,
    ...(partial ? { partial: true, originalStatus: report.status, verifiedPrefixCount: prefixLength, excluded } : {}) };
}
