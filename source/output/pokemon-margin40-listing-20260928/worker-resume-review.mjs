import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readCompletedCreationReceipt, isCompletedCreationReceipt } from '../../pokemon-single-card-sync/creation-receipts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const events = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const fail = () => { throw Object.assign(new Error('worker_resume_evidence_invalid'), { code: 'worker_resume_evidence_invalid' }); };
const STORE = 'egk2fq-va.myshopify.com';
const PUBLICATION = 'gid://shopify/Publication/173264044220';

function checkFile(binding, root) {
  if (!binding || !path.isAbsolute(binding.path ?? '') || !/^[0-9a-f]{64}$/.test(binding.sha256 ?? '')) fail();
  const relative = path.relative(root, binding.path);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail();
  for (let cursor = path.resolve(binding.path); path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail();
  }
  if (!fs.statSync(binding.path).isFile() || sha(fs.readFileSync(binding.path)) !== binding.sha256) fail();
  return binding.path;
}

export function assertCompletedRemote(data, row, completed) {
  const p = data?.productByIdentifier;
  const html = value => value?.replace(/>[\r\n\t ]+</g, '><');
  const tags = values => [...new Set((values ?? []).map(value => /^(?:Pokémon|Pokemon)$/i.test(value) ? 'pokemon' : value))].sort();
  if (!p || p.id !== completed.productId || p.handle !== row.handle || p.title !== row.fields.title || p.status !== 'ACTIVE'
    || p.vendor !== row.fields.vendor || p.productType !== row.fields.productType || p.category?.id !== row.fields.category
    || html(p.descriptionHtml) !== html(row.fields.descriptionHtml) || !same(tags(p.tags), tags(row.fields.tags))) fail();
  for (const name of ['variants', 'media', 'collections', 'resourcePublicationsV2']) {
    if (!Array.isArray(p[name]?.nodes) || p[name].pageInfo?.hasNextPage !== false) fail();
  }
  const v = p.variants.nodes[0], m = p.media.nodes[0];
  if (p.variants.nodes.length !== 1 || p.media.nodes.length !== 1 || v.id !== completed.variantId
    || v.sku !== row.sku || Number(v.price).toFixed(2) !== row.fields.price || v.availableForSale !== false
    || v.inventoryItem?.tracked !== true || v.inventoryPolicy !== 'DENY' || v.inventoryQuantity !== 0
    || v.image?.id !== completed.imageId || v.image?.url !== completed.imageUrl || m.id !== completed.mediaId
    || m.status !== 'READY' || m.image?.url !== completed.imageUrl || m.image?.id !== completed.imageSourceId
    || m.alt !== row.title || v.media?.pageInfo?.hasNextPage !== false || !same(v.media.nodes.map(item => item.id), [completed.mediaId])
    || p.onlineStoreUrl !== completed.productUrl) fail();
  const published = p.resourcePublicationsV2.nodes.filter(item => item.isPublished).map(item => item.publication?.id).sort();
  if (!same(published, [PUBLICATION]) || ![...row.fields.collections, completed.collectionId].every(id => p.collections.nodes.some(item => item.id === id))) fail();
  return p;
}

/** Explicitly reviewed first-batch interruption only; creation receipts are never removed or recreated. */
export function inspectWorkerResume({ reviewPath, expectedSha256, root, stateDirectory, authorized, previous, now }) {
  const binding = { path: reviewPath, sha256: expectedSha256 };
  checkFile(binding, root);
  const review = read(reviewPath), auth = authorized.authorization, batch = authorized.queue.listingBatches[0];
  const pendingUpload = review.kind === 'reviewed_first_batch_upload_resume';
  const target = pendingUpload ? review.pending : review.draft;
  if (!['reviewed_first_batch_draft_resume', 'reviewed_first_batch_upload_resume'].includes(review.kind)
    || pendingUpload && review.draft !== undefined || !pendingUpload && review.pending !== undefined || review.scopeKey !== auth.queueKey
    || review.policySha256 !== auth.policySha256 || review.queueSha256 !== auth.queueSha256
    || previous?.status !== 'stopped_review_required' || previous.failureStage !== 'create_product_requested'
    || !(pendingUpload ? ['staged_upload_failed', 'worker_stage_failed_review_required'] : ['listing_cli_result_unknown']).includes(previous.reason)
    || previous.batchNumber !== 1 || previous.catalogAdded !== 0
    || previous.completedBatches?.length !== 0 || review.startedAt !== previous.startedAt
    || !Number.isFinite(Date.parse(previous.startedAt)) || now - new Date(previous.startedAt) > 24 * 3600000
    || !Array.isArray(review.completed) || review.completed.length !== previous.verifiedProducts
    || review.completed.length >= batch.count || target?.identity !== batch.identities[review.completed.length]
    || previous.currentIdentity !== target.identity) fail();
  const staticFiles = [binding, review.previousProgress, review.previousJournal, review.plan,
    ...review.completed.flatMap(item => [item.readback, item.journal, item.receipt, item.remote]),
    target.journal, target.remote, ...(!pendingUpload ? [target.receiptSnapshot] : [])];
  const guard = () => { for (const file of staticFiles) checkFile(file, root); };
  guard();
  if (sha(fs.readFileSync(path.join(stateDirectory, 'progress.json'))) !== review.previousProgress.sha256
    || sha(fs.readFileSync(path.join(stateDirectory, 'journal.jsonl'))) !== review.previousJournal.sha256
    || !same(read(review.previousProgress.path), previous)) fail();
  const plan = read(review.plan.path), products = [], readbacks = [];
  if (!same(plan.records.map(row => row.identity), batch.identities)) fail();
  const receiptFor = identity => path.join(authorized.policy.receiptDirectory, `${sha(identity)}.jsonl`);
  for (let index = 0; index < review.completed.length; index++) {
    const item = review.completed[index], row = plan.records[index], report = read(item.readback.path);
    if (item.identity !== row.identity || report.kind !== 'verified_display_only_pokemon_products' || report.store !== STORE
      || report.planSha256 !== review.plan.sha256 || report.products?.length !== 1
      || path.resolve(item.receipt.path) !== path.resolve(receiptFor(row.identity))) fail();
    const p = report.products[0], journal = events(item.journal.path);
    let receipt;
    try { receipt = readCompletedCreationReceipt({receiptPath:item.receipt.path,identity:row.identity,planSha256:review.plan.sha256,
      authorization:{...auth,listingBatchNumber:1},product:p,checkBinding:file=>{checkFile(file,root);staticFiles.push(file);}}); } catch { fail(); }
    if (p.identity !== row.identity || p.price !== row.fields.price || p.title !== row.fields.title || p.sku !== row.sku
      || p.availableForSale !== false || p.inventoryTracked !== true || p.inventoryPolicy !== 'DENY'
      || !isCompletedCreationReceipt(receipt)
      || receipt.some(event => event.identity !== row.identity) || receipt[0].planSha256 !== review.plan.sha256
      || receipt[0].authorization?.policySha256 !== auth.policySha256 || receipt[0].authorization?.queueSha256 !== auth.queueSha256
      || receipt.slice(1).some(event => ['productId', 'variantId', 'mediaId'].some(key => event[key] !== p[key]))
      || journal.some(event => event.planSha256 !== review.plan.sha256) || journal.at(-1)?.status !== 'completed'
      || journal.filter(event => event.status === 'product_completed').length !== 1
      || journal.find(event => event.status === 'product_completed').identity !== row.identity
      || ['productId', 'variantId', 'mediaId'].some(key => journal.find(event => event.status === 'product_completed')[key] !== p[key])) fail();
    assertCompletedRemote(read(item.remote.path), row, p);
    products.push(p); readbacks.push(item.readback);
  }
  for (const key of ['identity', 'productId', 'variantId', 'mediaId', 'imageId']) {
    if (new Set(products.map(p => p[key])).size !== products.length) fail();
  }
  if (pendingUpload) {
    const pendingEvents = events(target.journal.path), row = plan.records[review.completed.length];
    const allowed = ['preflight_verified', 'stage_requested', 'stage_response_received', 'stopped_review_required'];
    if (fs.existsSync(receiptFor(target.identity)) || read(target.remote.path).productByIdentifier !== null
      || !same(pendingEvents.map(event => event.status), allowed)
      || pendingEvents.some(event => event.planSha256 !== review.plan.sha256
        || event.identity !== undefined && event.identity !== target.identity
        || event.authorization?.policySha256 !== auth.policySha256 || event.authorization?.queueSha256 !== auth.queueSha256)
      || pendingEvents[1].imageSha256 !== row.image.sha256 || pendingEvents[2].imageSha256 !== row.image.sha256
      || pendingEvents.at(-1).reason !== 'staged_upload_failed' || pendingEvents.at(-1).completed !== 0) fail();
    return { review, guard, products, readbacks, planPath: review.plan.path, pendingUpload: true, suffix: expectedSha256.slice(0, 12) };
  }
  const draft = review.draft, receiptPath = receiptFor(draft.identity);
  if (sha(fs.readFileSync(receiptPath)) !== draft.receiptSnapshot.sha256) fail();
  const receipt = events(draft.receiptSnapshot.path), draftEvents = events(draft.journal.path), created = draftEvents.filter(event => event.status === 'draft_created');
  const requests = draftEvents.slice(draftEvents.findIndex(event => event.status === 'draft_created') + 1)
    .filter(event => event.status.endsWith('_requested'));
  if (!same(receipt.map(event => event.status), ['create_requested', 'draft_created']) || created.length !== 1
    || created[0].identity !== draft.identity || requests.length === 0
    || requests.some(event => !['variant_requested', 'addToCollection_requested'].includes(event.status)
      || event.identity !== draft.identity || event.productId !== draft.productId
      || event.status === 'variant_requested' && event.variantId !== draft.variantId)
    || receipt.some(event => event.identity !== draft.identity) || receipt[0].planSha256 !== review.plan.sha256
    || receipt[0].authorization?.policySha256 !== auth.policySha256 || receipt[0].authorization?.queueSha256 !== auth.queueSha256
    || ['productId', 'variantId', 'mediaId'].some(key => receipt[1][key] !== draft[key] || created[0][key] !== draft[key])
    || draftEvents.some(event => event.planSha256 !== review.plan.sha256)
    || draftEvents.at(-1)?.reason !== 'listing_cli_result_unknown' || draftEvents.at(-1)?.status !== 'stopped_review_required'
    || draftEvents.at(-1)?.completed !== 0
    || read(draft.remote.path).productByIdentifier?.id !== draft.productId
    || read(draft.remote.path).productByIdentifier?.status !== 'DRAFT') fail();
  return { review, guard, products, readbacks, planPath: review.plan.path,
    resumeDraftJournal: draft.journal.path, suffix: expectedSha256.slice(0, 12) };
}
