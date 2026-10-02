import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readJson, save, withLock } from './files.mjs';
import { summarizeAppDetail } from './summarize-app-detail.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const FIELDS = ['language', 'setId', 'setCode', 'packName', 'cardName', 'originalName', 'cardNumber', 'shareUrl', 'languageLabel'];
const STAGES = new Set(['configuration', 'device_connection', 'open_known_card', 'validate_public_detail',
  'save_public_evidence', 'read_explicit_minimum_label', 'scroll_offers']);
const REASONS = new Set(['unexpected_app_or_display', 'login_or_private_input', 'current_version_missing',
  'detail_controls_missing', 'card_header_mismatch', 'screenshot_format_or_size_changed', 'invalid_control_bounds',
  'control_not_fully_visible', 'device_config_mismatch', 'invalid_explicit_card_context',
  'output_must_be_new_workspace_directory', 'output_reparse_point', 'device_not_connected', 'display_size_unsupported',
  'version_control_missing', 'version_close_control_missing', 'device_or_capture_failed',
  'device_command_start_failed', 'device_command_timeout', 'device_command_failed']);

function contexts(cards) {
  if (!Array.isArray(cards) || !cards.length) throw new Error('Cards must be a nonempty array of explicit verified contexts.');
  const urls = new Set();
  return cards.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid explicit card context.');
    const context = Object.fromEntries(FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]));
    if (!['zh-Hans', 'ja', 'en'].includes(context.language)
      || !/^[1-9]\d*$/.test(context.setId || '') || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(context.setCode || '')
      || !['packName', 'cardName', 'cardNumber'].every((field) => typeof context[field] === 'string' && context[field].trim())
      || !Object.values(context).every((value) => typeof value === 'string' && value.length <= 300 && !/[\r\n\u0000]/.test(value))
      || !/^https:\/\/api\.jihuanshe\.com\/pro\/cards\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(context.shareUrl || '')
      || urls.has(context.shareUrl)) throw new Error('Invalid or duplicate explicit card context.');
    urls.add(context.shareUrl);
    return context;
  });
}

async function captureDetail({ contextPath, captureDir }) {
  await execute('pwsh', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
    resolve(ROOT, 'capture-app-detail.ps1'), '-ContextPath', contextPath, '-OutputDir', captureDir, '-MaxPages', '1'],
  { cwd: ROOT, windowsHide: true, shell: false, timeout: 180_000, maxBuffer: 64 * 1024 });
}

function captureFailure(captureDir) {
  try {
    const record = readJson(resolve(captureDir, 'failure.json'));
    if (record.status === 'capture_stopped' && STAGES.has(record.stage) && REASONS.has(record.reason)) {
      return { stage: record.stage, reason: record.reason };
    }
  } catch { /* A missing or invalid failure file provides no trustworthy detail. */ }
  return { stage: 'capture', reason: 'capture_process_failed' };
}

/** Sequential public observations only. Does not start Android, schedule work or contact Shopify. */
export async function collectAppDaily({ cards, offset = 0, limit }, {
  capture = captureDetail, summarize = summarizeAppDetail, outputRoot = resolve(ROOT, 'output'),
} = {}) {
  const input = contexts(cards);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= input.length
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid offset or limit (1..100).');
  const selected = input.slice(offset, offset + limit);
  return withLock(outputRoot, async () => {
    const runDir = resolve(outputRoot, 'app-daily', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    mkdirSync(dirname(runDir), { recursive: true });
    mkdirSync(runDir);
    const report = { kind: 'app_daily_public_observations', status: 'in_progress',
      startedAt: new Date().toISOString(), completedAt: null, quoteEligible: false,
      selection: { offset, limit, selected: selected.length, inputCount: input.length },
      cards: selected.map((context, index) => ({ index: offset + index, sourceUrl: context.shareUrl,
        cardNumber: context.cardNumber, language: context.language, status: 'not_attempted',
        amountCny: null, observedAt: null, conditionScope: null, quoteEligible: false })) };
    const reportPath = resolve(runDir, 'report.json');
    save(reportPath, report);
    let stopped = false;
    for (const [index, context] of selected.entries()) {
      const cardDir = resolve(runDir, `card-${String(offset + index + 1).padStart(6, '0')}`);
      const contextPath = resolve(cardDir, 'context.json');
      const captureDir = resolve(cardDir, 'capture');
      save(contextPath, context);
      let stage = 'capture';
      try {
        await capture({ contextPath, captureDir });
        stage = 'summary';
        const observation = await summarize(captureDir);
        if (!['observed', 'not_exact_minimum'].includes(observation.status)
          || observation.sourceUrl !== context.shareUrl || observation.quoteEligible !== false
          || observation.minimum?.quoteEligible !== false) throw new Error('Invalid observation result.');
        save(resolve(cardDir, 'observation.json'), observation);
        Object.assign(report.cards[index], { status: observation.status, amountCny: observation.minimum.amountCny,
          observedAt: observation.minimum.evidence?.capturedAt ?? null,
          conditionScope: observation.minimum.conditionScope, minimumReason: observation.minimum.reason ?? null,
          evidence: observation.minimum.evidence ?? null });
      } catch {
        const failure = stage === 'capture' ? captureFailure(captureDir)
          : { stage: 'summary', reason: 'evidence_validation_failed' };
        const missingMinimum = failure.stage === 'read_explicit_minimum_label' && failure.reason === 'version_control_missing';
        const row = { status: missingMinimum ? 'not_exact_minimum' : 'capture_stopped',
          ...failure, amountCny: null, observedAt: null, quoteEligible: false };
        Object.assign(report.cards[index], row);
        save(resolve(cardDir, 'observation.json'), row);
        stopped = !missingMinimum;
      }
      save(reportPath, report);
      if (stopped) break;
    }
    report.status = stopped ? 'stopped' : 'observations_only';
    report.completedAt = new Date().toISOString();
    report.attempted = report.cards.filter((row) => row.status !== 'not_attempted').length;
    report.observed = report.cards.filter((row) => row.status === 'observed').length;
    report.notExactMinimum = report.cards.filter((row) => row.status === 'not_exact_minimum').length;
    save(reportPath, report);
    return { ...report, reportPath };
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    cards: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node collect-app-daily.mjs --cards VERIFIED_CONTEXTS.json [--offset 0] [--limit 25]\nPublic UI observations only; Android must already be running and logged in. No price sync or scheduled task.');
    return;
  }
  if (!values.cards || !existsSync(resolve(values.cards))) throw new Error('Provide --cards with an existing explicit-context JSON array.');
  const config = readJson(resolve(ROOT, 'config.json'));
  for (const key of ['offset', 'limit']) {
    if (values[key] !== undefined && !/^\d+$/.test(values[key])) throw new Error('Offset and limit must be whole numbers.');
  }
  const report = await collectAppDaily({ cards: readJson(resolve(values.cards)),
    offset: values.offset === undefined ? 0 : Number(values.offset),
    limit: values.limit === undefined ? config.batchSize : Number(values.limit) });
  console.log(JSON.stringify({ status: report.status, attempted: report.attempted, observed: report.observed,
    notExactMinimum: report.notExactMinimum, quoteEligible: false, reportPath: report.reportPath }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((report) => { if (report?.status === 'stopped') process.exitCode = 2; })
    .catch(() => { console.error('App observation run failed. Check the input, project output lock and local run report.'); process.exitCode = 1; });
}
