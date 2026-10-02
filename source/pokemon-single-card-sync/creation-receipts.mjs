import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readCompletedDraftResolution } from './created-draft-resolution.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Object.assign(new Error('creation_receipt_evidence_invalid'), { code: 'creation_receipt_evidence_invalid' }); };
const need = value => { if (!value) fail(); };
const epoch = value => { const time = Date.parse(value); need(typeof value === 'string' && Number.isFinite(time)); return time; };
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const json = bytes => { try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail(); } };
const lines = bytes => {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trim(); need(text);
  try { return text.split(/\r?\n/).map(line => JSON.parse(line)); } catch { fail(); }
};

function reader(receiptDirectory) {
  need(typeof receiptDirectory === 'string' && path.isAbsolute(receiptDirectory));
  const receipts = path.resolve(receiptDirectory), root = path.resolve(receipts, '../..');
  need(receipts === path.join(root, 'remaining250-control/creation-receipts'));
  const local = file => {
    need(typeof file === 'string' && path.isAbsolute(file));
    const resolved = path.resolve(file), relative = path.relative(root, resolved);
    need(relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
    for (let cursor = resolved; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
      need(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink());
    }
    return resolved;
  };
  const read = file => { const resolved = local(file); need(fs.statSync(resolved).isFile()); return fs.readFileSync(resolved); };
  const bind = file => ({ path: local(file), sha256: sha(read(file)) });
  const check = binding => {
    need(binding && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
    const bytes = read(binding.path); need(sha(bytes) === binding.sha256); return bytes;
  };
  return { root, receipts, local, read, bind, check };
}

function createRequest(event, identity, planSha256, authorization) {
  need(event?.status === 'create_requested' && event.identity === identity && event.planSha256 === planSha256
    && same(event.authorization, authorization));
}

/** Reads reviewed evidence only. The original receipt and journal are never rewritten. */
export function inspectAbsentCreateWitness({ witnessPath, row, planSha256, authorization, receiptDirectory,
  now = new Date(), historical = false }) {
  const files = reader(receiptDirectory), witnessBinding = files.bind(witnessPath);
  const witness = json(files.check(witnessBinding));
  need(row && typeof row.identity === 'string' && row.identity && typeof row.handle === 'string' && row.handle
    && /^[a-f0-9]{64}$/.test(planSha256 ?? '') && /^[a-f0-9]{64}$/.test(row.image?.sha256 ?? ''));
  need(witness.kind === 'reviewed_absent_create_retry' && witness.schemaVersion === 1 && witness.reviewed === true
    && witness.maxCreateAttempts === 1 && witness.identity === row.identity && witness.handle === row.handle
    && witness.imageSha256 === row.image.sha256 && witness.planSha256 === planSha256
    && same(witness.authorization, authorization));
  const originalReceiptPath = path.join(files.receipts, `${sha(row.identity)}.jsonl`);
  const retryReceiptPath = path.join(files.receipts, 'absent-create-retries', `${sha(row.identity)}.jsonl`);
  need(path.resolve(witness.originalReceipt?.path ?? '') === originalReceiptPath
    && Number.isSafeInteger(authorization?.listingBatchNumber) && authorization.listingBatchNumber >= 1 && authorization.listingBatchNumber <= 26);
  const batchDirectory = path.join(files.root, 'remaining503-worker-state',
    `batch-${String(authorization.listingBatchNumber).padStart(3, '0')}`);
  const planBinding = files.bind(path.join(batchDirectory, 'prepared/listing-plan.json'));
  need(planBinding.sha256 === planSha256);
  const plan = json(files.check(planBinding)), records = plan.records;
  need(plan.kind === 'pokemon_listing_preparation' && Array.isArray(records)
    && records.length === (authorization.listingBatchNumber === 26 ? 3 : 20)
    && records.filter(record => record.identity === row.identity).length === 1);
  const recordIndex = records.findIndex(record => record.identity === row.identity), planned = records[recordIndex];
  need(planned.handle === row.handle && planned.image?.sha256 === row.image.sha256);
  const journalPath = path.join(batchDirectory, `card-${String(recordIndex + 1).padStart(2, '0')}`, 'journal.jsonl');
  need(path.resolve(witness.originalJournal?.path ?? '') === journalPath);
  const receipt = lines(files.check(witness.originalReceipt)); need(receipt.length === 1);
  createRequest(receipt[0], row.identity, planSha256, authorization);
  const journal = lines(files.check(witness.originalJournal));
  need(same(journal.map(event => event.status), ['preflight_verified', 'stage_requested', 'stage_response_received',
    'image_uploaded', 'create_requested', 'stopped_review_required'])
    && journal.every(event => event.planSha256 === planSha256 && same(event.authorization, authorization)
      && (event.identity === undefined || event.identity === row.identity))
    && journal[0].count === 1 && journal.slice(1, 5).every(event => event.identity === row.identity)
    && journal.slice(1, 4).every(event => event.imageSha256 === row.image.sha256)
    && journal[5].reason === 'listing_cli_result_unknown' && journal[5].completed === 0);
  const requestedAt = epoch(journal[4].at), stoppedAt = epoch(journal[5].at), receiptAt = epoch(receipt[0].at);
  need(receiptAt <= requestedAt && requestedAt <= stoppedAt);
  need(Array.isArray(witness.observations) && witness.observations.length === 2
    && path.resolve(witness.observations[0].path) !== path.resolve(witness.observations[1].path));
  for (const binding of witness.observations) {
    const observation = json(files.check(binding));
    need(observation && !Array.isArray(observation) && observation.productByIdentifier === null
      && (!('errors' in observation) || Array.isArray(observation.errors) && observation.errors.length === 0));
  }
  const firstAt = epoch(witness.observations[0].observedAt), lastAt = epoch(witness.observations[1].observedAt);
  const reviewedAt = epoch(witness.reviewRecordedAt);
  need(firstAt - stoppedAt >= 5 * 60000 && lastAt - firstAt >= 60000 && reviewedAt >= lastAt);
  const freshness = time => {
    const checkedAt = new Date(time).getTime(); need(Number.isFinite(checkedAt) && reviewedAt <= checkedAt && lastAt <= checkedAt
      && receiptAt <= checkedAt && requestedAt <= checkedAt && stoppedAt <= checkedAt);
    if (!historical) need(checkedAt - lastAt <= 15 * 60000);
  };
  freshness(now);
  const bindings = frozen([witnessBinding, planBinding, witness.originalReceipt, witness.originalJournal, ...witness.observations]
    .map(binding => ({ path: files.local(binding.path), sha256: binding.sha256 })));
  const guard = ({ now: checkTime = new Date(), requireFresh = false } = {}) => {
    bindings.forEach(binding => files.check(binding));
    if (requireFresh) freshness(checkTime);
  };
  return { witness: frozen(witness), witnessBinding: bindings[0], originalReceiptPath, retryReceiptPath, bindings, guard };
}

export const isCompletedCreationReceipt = receipt => Array.isArray(receipt) && receipt.length === 3
  && receipt[0].status === 'create_requested' && ['draft_created', 'owned_draft_resolved'].includes(receipt[1].status)
  && receipt[2].status === 'product_completed';

/** Returns the three factual create/draft-or-resolution/completion events and registers every immutable proof with the caller. */
export function readCompletedCreationReceipt({ receiptPath, identity, planSha256, authorization, product, checkBinding }) {
  need(typeof checkBinding === 'function' && typeof identity === 'string' && /^[a-f0-9]{64}$/.test(planSha256 ?? ''));
  const files = reader(path.dirname(receiptPath));
  need(files.local(receiptPath) === path.join(files.receipts, `${sha(identity)}.jsonl`));
  const original = files.bind(receiptPath), receipt = lines(files.check(original));
  const complete = events => {
    need(same(events.map(event => event.status), ['create_requested', 'draft_created', 'product_completed']));
    createRequest(events[0], identity, planSha256, authorization);
    for (const [field, type] of Object.entries({ productId: 'Product', variantId: 'ProductVariant', mediaId: 'MediaImage' })) {
      need(new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(product?.[field] ?? ''));
    }
    need(events.every(event => event.identity === identity)
      && events.slice(1).every(event => ['productId', 'variantId', 'mediaId'].every(field => event[field] === product[field])));
    return events;
  };
  const resolutionPath = files.local(path.join(files.receipts, 'created-draft-resolutions', `${sha(identity)}.jsonl`));
  if (fs.existsSync(resolutionPath)) {
    need(receipt.length === 1 && !fs.existsSync(files.local(path.join(files.receipts, 'absent-create-retries', `${sha(identity)}.jsonl`))));
    return readCompletedDraftResolution({ receiptPath, identity, planSha256, authorization, product, checkBinding });
  }
  if (receipt.length === 3) {
    need(!fs.existsSync(files.local(path.join(files.receipts, 'absent-create-retries', `${sha(identity)}.jsonl`))));
    const result = complete(receipt); checkBinding(original); return result;
  }
  need(receipt.length === 1); createRequest(receipt[0], identity, planSha256, authorization);
  const sidecar = files.bind(path.join(files.receipts, 'absent-create-retries', `${sha(identity)}.jsonl`));
  const retry = lines(files.check(sidecar));
  need(same(retry.map(event => event.status), ['retry_reserved', 'create_requested', 'draft_created', 'product_completed']));
  const reservation = retry[0];
  need(reservation.identity === identity && reservation.planSha256 === planSha256 && same(reservation.authorization, authorization)
    && same({ path: files.local(reservation.originalReceipt?.path), sha256: reservation.originalReceipt?.sha256 }, original));
  const witness = json(files.check(reservation.witness));
  const checked = inspectAbsentCreateWitness({ witnessPath: reservation.witness.path,
    row: { identity, handle: product.handle ?? product.productHandle, image: { sha256: witness.imageSha256 } },
    planSha256, authorization, receiptDirectory: files.receipts, historical: true });
  need(same(checked.witnessBinding, { path: files.local(reservation.witness.path), sha256: reservation.witness.sha256 })
    && epoch(reservation.at) >= epoch(checked.witness.reviewRecordedAt));
  const times = retry.map(event => epoch(event.at));
  need(times.every((time, index) => index === 0 || time >= times[index - 1]));
  const result = complete(retry.slice(1));
  for (const binding of [original, sidecar, ...checked.bindings]) checkBinding(binding);
  return result;
}
