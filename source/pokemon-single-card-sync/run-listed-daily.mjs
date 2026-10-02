import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson, save, sha256, withLock } from './files.mjs';
import { ShopifyClient, planDigest, readListedVariants } from './shopify.mjs';
import { selectListedAppCards } from './listed-app-cards.mjs';
import { verifyCapturedCard } from './verify-app-pack.mjs';
import { main as syncMain } from './sync.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export function executeFileIgnoringOutput(file, args, options, { spawnImpl = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(file, args, { ...options, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}
const RUNTIME_STAGES = new Set(['configuration', 'claim_runtime_lock', 'private_adb', 'start_headless_avd',
  'wait_for_boot', 'collect_public_observations']);
const RUNTIME_REASONS = new Set(['path_outside_workspace', 'path_reparse_point', 'child_start_failed', 'child_timeout',
  'child_output_failed', 'child_stop_unconfirmed', 'child_lock_owner_unverified',
  'private_adb_owner_unverified', 'avd_identity_unverified', 'runtime_file_missing',
  'avd_userdata_path_mismatch', 'device_config_mismatch', 'invalid_card_selection', 'runtime_lock_exists_or_unavailable',
  'private_adb_start_failed', 'private_adb_query_failed', 'headless_launch_failed', 'launch_report_invalid',
  'device_boot_timeout', 'collection_stopped', 'collection_report_invalid', 'private_adb_missing',
  'owned_avd_stop_failed', 'runtime_operation_failed']);
const COLLECTOR_STAGES = new Set(['capture', 'summary', 'configuration', 'device_connection', 'open_known_card',
  'validate_public_detail', 'save_public_evidence', 'read_explicit_minimum_label', 'scroll_offers']);
const fail = (code) => { throw Object.assign(new Error(code), { name: 'ListedDailyError', code }); };
const within = (root, path) => {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

function reportPath(value, roots, filename) {
  if (typeof value !== 'string' || !isAbsolute(value) || basename(value) !== filename || !existsSync(value)) fail('runtime_report_missing');
  const path = realpathSync(value);
  if (!roots.some((root) => existsSync(root) && within(realpathSync(root), path))) fail('runtime_report_outside_expected_output');
  return path;
}

function verifySelected(cards, catalogCards) {
  const index = new Map(catalogCards.map((card) => [card.identity, card]));
  for (const context of cards) {
    const card = index.get(context.identity), evidence = card.evidence;
    for (const [path, hash] of [[resolve(evidence.directory, 'context.json'), evidence.contextSha256],
      [resolve(evidence.directory, 'evidence.json'), evidence.evidenceSha256],
      [resolve(evidence.directory, 'image/image.json'), evidence.imageMetadataSha256],
      [evidence.listingPath, evidence.referenceSha256]]) {
      if (!/^[a-f0-9]{64}$/.test(hash || '') || sha256(readFileSync(path)) !== hash) fail('catalog_evidence_changed');
    }
    const listing = readJson(evidence.listingPath);
    const expected = listing.observations?.filter((row) => row.cardNumber === context.cardNumber);
    if (expected?.length !== 1) fail('catalog_evidence_changed');
    const verified = verifyCapturedCard(evidence.directory, listing.context, expected[0]);
    if (verified.context.shareUrl !== context.shareUrl || verified.context.cardName !== context.cardName
      || verified.context.cardNumber !== context.cardNumber || verified.context.language !== context.language
      || verified.context.setId !== context.setId || verified.image.sha256 !== card.image.sha256) fail('catalog_evidence_changed');
  }
}

function runtimeDetails(stdout, outputDir) {
  let summary;
  try { summary = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '')); } catch { fail('runtime_output_invalid'); }
  if (!['observations_only', 'stopped'].includes(summary.status)) fail('runtime_output_invalid');
  const roots = [...new Set([resolve(ROOT, 'output'), outputDir])];
  const runReportPath = summary.runReportPath == null ? null
    : reportPath(summary.runReportPath, roots.map((root) => resolve(root, 'app-daily-runtime')), 'run.json');
  const runtime = runReportPath ? readJson(runReportPath) : null;
  if (runtime && (runtime.mode !== 'daily_prices' || runtime.status !== summary.status)) fail('unexpected_runtime_mode');
  if (summary.status === 'observations_only' && !runtime) fail('runtime_report_missing');
  const collectorReportPath = summary.collectorReportPath == null ? null
    : reportPath(summary.collectorReportPath, roots.map((root) => resolve(root, 'app-daily')), 'report.json');
  return { status: summary.status, runReportPath, collectorReportPath,
    reportedStage: RUNTIME_STAGES.has(runtime?.stage) ? runtime.stage : null,
    reportedReason: RUNTIME_REASONS.has(runtime?.reason ?? summary.reason) ? runtime?.reason ?? summary.reason : null,
    cleanup: ['not_needed', 'owned_avd_stop_requested', 'owned_avd_not_stopped_identity_or_connection_unverified'].includes(summary.cleanup)
      ? summary.cleanup : null };
}

export function readRuntimeSummary(summaryPath, batchDir, outputDir) {
  if (!isAbsolute(summaryPath) || resolve(summaryPath) !== resolve(batchDir, 'runtime-summary.json')) fail('runtime_summary_outside_batch');
  for (let cursor = resolve(summaryPath); dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('runtime_summary_reparse_point');
  }
  if (!existsSync(summaryPath)) fail('runtime_summary_missing');
  const stats = statSync(summaryPath);
  if (!stats.isFile() || stats.size < 1 || stats.size > 64 * 1024) fail('runtime_summary_invalid');
  if (dirname(realpathSync(summaryPath)) !== realpathSync(batchDir)) fail('runtime_summary_outside_batch');
  const bytes = readFileSync(summaryPath);
  return { ...runtimeDetails(bytes.toString('utf8'), outputDir), summaryPath, summarySha256: sha256(bytes) };
}

function collectorDetails(path, contexts) {
  const report = readJson(path);
  if (report.kind !== 'app_daily_public_observations' || !Array.isArray(report.cards)
    || report.selection?.selected !== contexts.length || report.cards.length !== contexts.length
    || report.selection.offset !== 0 || report.selection.inputCount !== contexts.length) fail('collector_selection_mismatch');
  const expected = new Set(contexts.map((row) => row.shareUrl)), actual = new Set();
  for (const row of report.cards) {
    if (!expected.has(row.sourceUrl) || actual.has(row.sourceUrl)) fail('collector_selection_mismatch');
    actual.add(row.sourceUrl);
  }
  const failure = report.cards.find((row) => row.status === 'capture_stopped');
  return { status: ['observations_only', 'stopped'].includes(report.status) ? report.status : 'unknown',
    attempted: report.cards.filter((row) => row.status !== 'not_attempted').length,
    observed: report.cards.filter((row) => row.status === 'observed').length,
    notExactMinimum: report.cards.filter((row) => row.status === 'not_exact_minimum').length,
    reportedStage: COLLECTOR_STAGES.has(failure?.stage) ? failure.stage : null,
    reportedReason: failure ? 'collector_card_failed' : null };
}

function procurementAllocations(rows, mapping, cards, batchSize) {
  const allowed = new Set(mapping.filter((row) => row.enabled === true).map((row) => row.identity));
  if (!Array.isArray(rows) || rows.some((row) => !allowed.has(row?.identity))
    || new Set(rows.map((row) => row.identity)).size !== rows.length) fail('invalid_procurement');
  const groups = new Map();
  for (const row of rows) {
    if (typeof row.orderId !== 'string' || !row.orderId.trim() || row.orderId !== row.orderId.trim()
      || !Number.isSafeInteger(row.units) || row.units <= 0 || !Number.isSafeInteger(row.totalUnits)
      || row.totalUnits <= 0 || row.units > row.totalUnits) fail('invalid_procurement_group');
    if (!groups.has(row.orderId)) groups.set(row.orderId, []);
    groups.get(row.orderId).push(row);
  }
  const batchByIdentity = new Map(cards.map((card, index) => [card.identity, Math.floor(index / batchSize)]));
  for (const group of groups.values()) {
    const total = group[0].totalUnits, counted = group.reduce((sum, row) => sum + row.units, 0);
    if (group.some((row) => row.totalUnits !== total) || !Number.isSafeInteger(counted) || counted !== total) fail('invalid_procurement_group');
    const selected = group.filter((row) => batchByIdentity.has(row.identity));
    if (selected.length && selected.length !== group.length) fail('procurement_group_contains_unlisted_cards');
    if (new Set(selected.map((row) => batchByIdentity.get(row.identity))).size > 1) fail('procurement_group_spans_batches');
  }
  return rows.map(({ identity, orderId, totalUnits, units }) => ({ identity, orderId, totalUnits, units }));
}

/** Read listed mappings, collect each batch and create review plans. Never invokes apply. */
export async function runListedDaily({ configPath = resolve(ROOT, 'config.json'), procurementPath } = {}, {
  execute = executeFileIgnoringOutput,
  createClient = (config) => new ShopifyClient({ store: config.store, cliPath: config.shopifyCliPath }),
  readLive = readListedVariants, select = selectListedAppCards, verifySelection = verifySelected, preview = syncMain,
} = {}) {
  configPath = resolve(configPath);
  const config = readJson(configPath);
  if (typeof config.outputDir !== 'string' || !config.outputDir || typeof config.mappingFile !== 'string' || !config.mappingFile
    || !Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 100) fail('invalid_configuration');
  const outputDir = resolve(dirname(configPath), config.outputDir), listedRoot = resolve(outputDir, 'listed-daily');
  return withLock(listedRoot, async () => {
    const runDir = resolve(listedRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    mkdirSync(runDir);
    const path = resolve(runDir, 'run.json');
    const report = { kind: 'listed_app_daily_run', status: 'in_progress', stage: 'configuration',
      startedAt: new Date().toISOString(), completedAt: null, configPath, previewOnly: true, shopifyWrites: 0,
      enabledMappings: 0, selectedCards: 0, skipped: [], batches: [], reportPath: path };
    const record = (stage) => { report.stage = stage; report.updatedAt = new Date().toISOString(); save(path, report); };
    const finish = (status, reason = null) => {
      report.changes = report.batches.reduce((sum, batch) => sum + (batch.preview?.changes ?? 0), 0);
      report.blocked = report.batches.reduce((sum, batch) => sum + (batch.preview?.blocked ?? 0), 0);
      report.status = status; report.reason = reason; report.completedAt = new Date().toISOString(); record(report.stage); return report;
    };
    record('configuration');
    try {
      const mapping = readJson(resolve(dirname(configPath), config.mappingFile));
      if (!Array.isArray(mapping)) fail('invalid_mapping');
      report.enabledMappings = mapping.filter((row) => row?.enabled === true).length;
      if (!report.enabledMappings) return finish('blocked', 'no_mappings');
      const catalogPath = resolve(outputDir, 'catalog.json');
      if (!existsSync(catalogPath)) return finish('blocked', 'catalog_missing');
      const catalog = readJson(catalogPath);
      if (!Array.isArray(catalog.cards)) fail('invalid_catalog');
      record('read_listed_variants');
      const live = await readLive(createClient(config), mapping);
      if (live?.currencyCode !== 'USD') return finish('blocked', 'shop_currency_not_usd');
      record('select_listed_cards');
      const selected = select(catalog.cards, mapping, live);
      report.skipped = selected.skipped; report.selectedCards = selected.cards.length;
      if (!selected.cards.length) return finish('blocked', 'no_listed_cards');
      record('verify_selected_evidence');
      await verifySelection(selected.cards, catalog.cards);
      let allocations;
      if (procurementPath) {
        record('validate_procurement');
        allocations = procurementAllocations(readJson(resolve(procurementPath)), mapping, selected.cards, config.batchSize);
      }
      for (let offset = 0; offset < selected.cards.length; offset += config.batchSize) {
        const contexts = selected.cards.slice(offset, offset + config.batchSize), batchNumber = report.batches.length + 1;
        const batchDir = resolve(runDir, `batch-${String(batchNumber).padStart(3, '0')}`);
        const cardsPath = resolve(batchDir, 'cards.json'); save(cardsPath, contexts);
        const summaryPath = resolve(batchDir, 'runtime-summary.json');
        if (existsSync(summaryPath)) fail('runtime_summary_exists');
        const batch = { batch: batchNumber, offset, count: contexts.length, cardsPath, status: 'in_progress',
          startedAt: new Date().toISOString(), summaryPath, process: null, runtime: null, collector: null, preview: null };
        report.batches.push(batch); record('collect_batch');
        let result, executionError;
        try {
          result = await execute('pwsh', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
            resolve(ROOT, 'run-app-daily.ps1'), '-CardsPath', cardsPath, '-Limit', String(config.batchSize), '-SummaryPath', summaryPath], {
            // The PowerShell wrapper owns child deadlines and its finally cleanup; do not kill its parent on an outer timer.
            cwd: ROOT, windowsHide: true, shell: false, stdio: 'ignore',
          });
        } catch (error) { executionError = error; }
        batch.process = { code: Number.isInteger(result?.code) ? result.code : null,
          signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(result?.signal) ? result.signal : null,
          spawnFailed: Boolean(executionError) };
        let summaryError;
        try { batch.runtime = readRuntimeSummary(summaryPath, batchDir, outputDir); } catch (error) { summaryError = error; }
        if (batch.runtime?.collectorReportPath) batch.collector = collectorDetails(batch.runtime.collectorReportPath, contexts);
        record('collect_batch');
        if (executionError) {
          if (executionError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('runtime_output_limit');
          if (executionError.code === 'ETIMEDOUT' || executionError.killed && executionError.signal) fail('runtime_timeout');
          if (executionError.code === 'ENOENT') fail('runtime_launcher_missing');
          fail(batch.runtime?.status === 'stopped' ? 'runtime_stopped' : 'runtime_process_failed');
        }
        if (summaryError) throw summaryError;
        if (!result || !(Number.isInteger(result.code) || result.code === null)
          || !(result.signal === null || typeof result.signal === 'string')) fail('runtime_process_result_invalid');
        if (result.code !== 0 || result.signal !== null) fail(batch.runtime?.status === 'stopped' ? 'runtime_stopped' : 'runtime_process_failed');
        if (!batch.runtime || batch.runtime.status !== 'observations_only'
          || !batch.runtime.collectorReportPath || batch.collector?.status !== 'observations_only') fail('runtime_collection_incomplete');
        record('preview_batch');
        const args = ['daily', '--app-run', dirname(batch.runtime.collectorReportPath), '--config', configPath];
        if (allocations) {
          const identities = new Set(contexts.map((context) => context.identity));
          const path = resolve(batchDir, 'procurement.json');
          save(path, allocations.filter((row) => identities.has(row.identity)).map(({ identity, orderId, totalUnits, units }) => ({ identity, orderId, totalUnits, units })));
          batch.procurementPath = path; args.push('--procurement', path);
        }
        const planResult = await preview(args);
        if (planResult?.status !== 'preview_only' || !['changes', 'skipped', 'blocked'].every((key) => Number.isSafeInteger(planResult[key]) && planResult[key] >= 0)) fail('preview_result_invalid');
        const plan = readJson(resolve(outputDir, 'latest-plan.json'));
        if (planDigest(plan) !== planResult.digest) fail('preview_plan_mismatch');
        const review = readFileSync(resolve(outputDir, 'review.md'), 'utf8');
        if (!review.includes(planResult.digest)) fail('preview_review_mismatch');
        const planPath = resolve(batchDir, 'plan.json'), reviewPath = resolve(batchDir, 'review.md');
        save(planPath, plan); save(reviewPath, review);
        batch.preview = { status: 'preview_only', changes: planResult.changes, skipped: planResult.skipped,
          blocked: planResult.blocked, digest: planResult.digest, planPath, reviewPath };
        batch.status = planResult.blocked > 0 ? 'preview_blocked' : 'preview_completed';
        batch.completedAt = new Date().toISOString(); record('batch_completed');
      }
      return report.batches.some((batch) => batch.preview.blocked > 0) ? finish('blocked', 'price_preview_blocked') : finish('preview_only');
    } catch (error) {
      const fallback = { configuration: 'configuration_read_failed', read_listed_variants: 'shopify_read_failed',
        select_listed_cards: 'listed_selection_failed', verify_selected_evidence: 'catalog_evidence_failed',
        validate_procurement: 'procurement_read_failed', collect_batch: 'runtime_report_invalid', preview_batch: 'price_preview_failed', batch_completed: 'batch_record_failed' };
      const reason = error.name === 'ListedDailyError' ? error.code : fallback[report.stage] ?? 'listed_daily_failed';
      const batch = report.batches.at(-1);
      if (batch?.status === 'in_progress') { batch.status = 'stopped'; batch.reason = reason; batch.completedAt = new Date().toISOString(); }
      return finish(report.stage === 'validate_procurement' ? 'blocked' : 'stopped', reason);
    }
  }).catch((error) => {
    if (error.message?.startsWith('Another run exists.')) fail('listed_daily_already_running');
    throw error;
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: 'string' }, procurement: { type: 'string' }, help: { type: 'boolean' }, run: { type: 'boolean' } } });
  if (values.help || !values.run) {
    console.log('Daily listed-card price preview: no work started. Explicit --run required.\nUsage: node run-listed-daily.mjs --run [--config FILE] [--procurement FILE]\nReads mapped listed cards, collects current App evidence in batches and saves price previews. Never applies changes. Price synchronization requires a separate reviewed policy; scheduling and automatic writes are not enabled by this script.');
    return;
  }
  const report = await runListedDaily({ configPath: values.config, procurementPath: values.procurement });
  console.log(JSON.stringify({ status: report.status, reason: report.reason, selectedCards: report.selectedCards,
    batches: report.batches.length, changes: report.changes ?? 0, blocked: report.blocked ?? 0, reportPath: report.reportPath }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((report) => { if (report && report.status !== 'preview_only') process.exitCode = 2; })
    .catch((error) => { console.error(JSON.stringify({ error: error.name === 'ListedDailyError' ? error.code : 'listed_daily_failed' })); process.exitCode = 1; });
}
