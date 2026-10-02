import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareInputs } from '../output/pokemon-margin40-listing-20260928/final-public-audit/audit-public-products.mjs';
import { completedProduct, proofReader, sha } from '../output/pokemon-margin40-listing-20260928/batch-recovery-candidate/recovery-evidence.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../output/pokemon-margin40-listing-20260928/daily-script-integration-candidate');
const ROOT = path.dirname(HERE);
const STATE = path.join(ROOT, 'remaining503-worker-state');
const RECEIPTS = path.join(ROOT, 'remaining250-control/creation-receipts');
const HISTORICAL_REVIEW = { path: path.join(ROOT, 'interrupted-review-20260929T160700Z/review.json'),
  sha256: 'c86302ca63c2ba050c4a2b95e8fba88516b23e7105bd41903e46df71e79b62ec' };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const events = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);

export function mappingRows(targets) {
  assert.ok(Array.isArray(targets) && targets.length >= 40 && targets.length <= 543);
  const result = targets.map(product => {
    assert.match(product.identity, /^pokemon:(zh-Hans|ja|en):\d+:[a-f0-9-]{36}$/);
    assert.match(product.productId, /^gid:\/\/shopify\/Product\/[1-9]\d*$/);
    assert.match(product.variantId, /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/);
    assert.ok(typeof product.sku === 'string' && product.sku.length > 0);
    assert.equal(product.availableForSale, false); assert.equal(product.inventoryTracked, true);
    assert.equal(product.inventoryPolicy, 'DENY');
    if (product.status !== undefined) assert.equal(product.status, 'ACTIVE');
    assert.equal(product.identity, `pokemon:${product.language}:${product.setId}:${product.sourceUuid}`);
    return { identity: product.identity, productGid: product.productId, variantGid: product.variantId,
      sku: product.sku, enabled: true, sourceUuid: product.sourceUuid, language: product.language, setId: product.setId };
  });
  for (const key of ['identity', 'productGid', 'variantGid', 'sku']) assert.equal(new Set(result.map(row => row[key])).size, result.length, `duplicate_${key}`);
  return result;
}

/** Historical completed evidence only; the existing daily runner still rereads current ACTIVE/publication/SKU before capture. */
export function prepareCompletedMapping() {
  const inputs = prepareInputs();
  const bindings = new Map(inputs.bindings.map(binding => [path.resolve(binding.path), binding]));
  const bind = file => {
    const binding = { path: path.resolve(file), sha256: sha(fs.readFileSync(file)) };
    const previous = bindings.get(binding.path);
    if (previous) assert.equal(previous.sha256, binding.sha256, 'source_changed');
    bindings.set(binding.path, binding); return binding;
  };
  const stateBinding = bind(inputs.statePath), journalBinding = bind(path.join(STATE, 'journal.jsonl'));
  assert.equal(stateBinding.sha256, inputs.stateSha256); assert.equal(journalBinding.sha256, inputs.journalSha256);
  const proofs = proofReader(ROOT), originalCheck = proofs.check;
  proofs.check = binding => { const result = originalCheck(binding); bindings.set(path.resolve(binding.path), binding); return result; };
  const verified = events(journalBinding.path).filter(event => event.stage === 'product_verified');
  assert.equal(verified.length, inputs.verifiedProducts - 40);
  const historyBinding = bind(HISTORICAL_REVIEW.path); assert.equal(historyBinding.sha256, HISTORICAL_REVIEW.sha256);
  const history = read(historyBinding.path);
  const oldEntries = [...history.completedBatches.flatMap(batch => batch.products), ...history.currentBatch.completed];
  const completed = [];
  for (const [index, event] of verified.entries()) {
    const directory = path.dirname(event.lastReadbackPath), planBinding = bind(path.join(path.dirname(directory), 'prepared/listing-plan.json'));
    const target = inputs.targets[40 + index], plan = read(planBinding.path);
    const rows = plan.records.filter(row => row.identity === target.identity); assert.equal(rows.length, 1);
    const journal = bind(path.join(directory, 'journal.jsonl')), authorization = events(journal.path)[0].authorization;
    const entry = { identity: target.identity, readback: bind(event.lastReadbackPath), journal,
      receipt: bind(path.join(RECEIPTS, `${sha(target.identity)}.jsonl`)) };
    const finalPath = path.join(directory, 'final-readback.json');
    if (fs.existsSync(finalPath)) entry.remote = bind(finalPath);
    else {
      const historical = oldEntries.filter(item => item.identity === target.identity); assert.equal(historical.length, 1, 'completed_remote_missing');
      for (const field of ['readback', 'journal', 'receipt']) {
        assert.equal(path.resolve(historical[0][field].path), entry[field].path);
        assert.equal(historical[0][field].sha256, entry[field].sha256, 'cached_completion_changed');
      }
      entry.remote = bind(historical[0].remote.path); assert.equal(entry.remote.sha256, historical[0].remote.sha256);
    }
    const product = completedProduct(entry, rows[0], planBinding, authorization, RECEIPTS, proofs);
    assert.equal(product.productId, target.productId); assert.equal(product.variantId, target.variantId);
    completed.push({ identity: target.identity, ...entry, plan: planBinding });
  }
  // Initial40 are covered by the pinned independent audit and exact source manifest in prepareInputs.
  const mapping = mappingRows(inputs.targets);
  const guard = () => {
    proofs.guard();
    for (const binding of bindings.values()) {
      for (let cursor = binding.path; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
        assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false, 'source_reparse_point');
      }
      assert.equal(sha(fs.readFileSync(binding.path)), binding.sha256, 'source_changed_during_refresh');
    }
  };
  guard();
  return { mapping, guard, evidence: { kind: 'completed_listing_daily_mapping_candidate', createdAt: new Date().toISOString(),
    installed: false, networkCalls: 0, shopifyWrites: 0, mappingCount: mapping.length, catalogCards: inputs.catalogCards,
    remainingUnmapped: 543 - mapping.length, workerState: inputs.state, completedNewProducts: completed,
    sourceBindings: [...bindings.values()],
    limitations: ['Uses saved completed evidence, not fresh remote status. Daily collection rereads current ACTIVE/publication/SKU.',
      'Excludes DRAFT/incomplete products by requiring product_verified plus complete receipt/journal/final ACTIVE readback.',
      'No pricing policy activation, config replacement, scheduling, device operation or remote writes.'] } };
}

export function saveMappingCandidate(prepared) {
  prepared.guard();
  const runs = path.join(HERE, 'runs');
  for (let cursor = runs; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    assert.ok(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink(), 'output_reparse_point');
  }
  fs.mkdirSync(runs, { recursive: true });
  const directory = path.join(runs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  fs.mkdirSync(directory);
  const mappingPath = path.join(directory, 'mapping.candidate.json');
  const bytes = JSON.stringify(prepared.mapping, null, 2) + '\n';
  prepared.guard();
  fs.writeFileSync(mappingPath, bytes, { flag: 'wx' });
  const reportPath = path.join(directory, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ ...prepared.evidence, mapping: { path: mappingPath, sha256: sha(bytes) } }, null, 2) + '\n', { flag: 'wx' });
  return { mappingPath, reportPath, count: prepared.mapping.length, installed: false };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { write: { type: 'boolean', default: false } } });
  const prepared = prepareCompletedMapping();
  const result = values.write ? saveMappingCandidate(prepared) : { count: prepared.mapping.length, catalogCards: prepared.evidence.catalogCards,
    installed: false, outputWritten: false, note: 'Use --write only to save a new local candidate; production mapping is never changed.' };
  console.log(JSON.stringify(result)); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
