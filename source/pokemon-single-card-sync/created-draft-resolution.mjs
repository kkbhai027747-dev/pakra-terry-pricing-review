import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error('created_draft_resolution_invalid'), { code: 'created_draft_resolution_invalid' }); };
const need = value => { if (!value) fail(); };
const time = value => { need(typeof value === 'string' && Number.isFinite(Date.parse(value))); return Date.parse(value); };
const gid = (value, type) => new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(value ?? '');
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const json = bytes => { try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail(); } };
const events = bytes => { try { return bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse); } catch { fail(); } };
const withoutDates = product => { const { createdAt, updatedAt, ...business } = product; return business; };

function filesFor(receiptDirectory) {
  need(typeof receiptDirectory === 'string' && path.isAbsolute(receiptDirectory));
  const receipts = path.resolve(receiptDirectory), root = path.resolve(receipts, '../..');
  need(receipts === path.join(root, 'remaining250-control/creation-receipts'));
  const local = file => {
    need(typeof file === 'string' && path.isAbsolute(file));
    const full = path.resolve(file), relative = path.relative(root, full);
    need(relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
    for (let cursor = full; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
      need(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink());
    }
    return full;
  };
  const read = file => { const full = local(file); need(fs.statSync(full).isFile()); return fs.readFileSync(full); };
  const bind = file => ({ path: local(file), sha256: sha(read(file)) });
  const check = binding => {
    need(binding && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
    const bytes = read(binding.path); need(sha(bytes) === binding.sha256); return bytes;
  };
  return { root, receipts, local, read, bind, check };
}

/** Full pristine business assertion. A DRAFT's initial untracked variant may report availableForSale=true. */
export function assertResolvedPristineDraft(data, row, ids) {
  need(data && !Array.isArray(data) && (!('errors' in data) || same(data.errors, [])));
  const p = data.productByIdentifier;
  const html = value => typeof value === 'string' ? value.replace(/>[\r\n\t ]+</g, '><') : value;
  const tags = value => { need(Array.isArray(value)); return [...new Set(value.map(x => /^(?:Pokémon|Pokemon)$/i.test(x) ? 'pokemon' : x))].sort(); };
  need(p && gid(ids.productId, 'Product') && gid(ids.variantId, 'ProductVariant') && gid(ids.mediaId, 'MediaImage')
    && p.id === ids.productId && p.handle === row.handle && p.title === row.title && p.title === row.fields.title
    && p.status === 'DRAFT' && p.onlineStoreUrl === null && p.vendor === row.fields.vendor && p.productType === row.fields.productType
    && p.category?.id === row.fields.category && html(p.descriptionHtml) === html(row.fields.descriptionHtml)
    && same(tags(p.tags), tags(row.fields.tags)));
  for (const field of ['variants', 'media', 'collections', 'resourcePublicationsV2']) {
    need(Array.isArray(p[field]?.nodes) && p[field].pageInfo?.hasNextPage === false);
  }
  need(p.variants.nodes.length === 1 && p.media.nodes.length === 1
    && p.resourcePublicationsV2.nodes.every(item => item.isPublished === false)
    && p.collections.nodes.every(item => gid(item.id, 'Collection') && typeof item.ruleSet?.appliedDisjunctively === 'boolean')
    && new Set(p.collections.nodes.map(item => item.id)).size === p.collections.nodes.length);
  const v = p.variants.nodes[0], m = p.media.nodes[0];
  need(v.id === ids.variantId && ['', null].includes(v.sku) && typeof v.price === 'string' && /^0(?:\.0{1,2})?$/.test(v.price)
    && v.inventoryItem?.tracked === false && v.inventoryPolicy === 'DENY' && v.inventoryQuantity === 0
    && typeof v.availableForSale === 'boolean' && v.image === null && v.media?.pageInfo?.hasNextPage === false && same(v.media.nodes, [])
    && m.id === ids.mediaId && m.status === 'READY' && m.alt === row.title && gid(m.image?.id, 'ImageSource')
    && m.image.width === row.image.width && m.image.height === row.image.height);
  let image; try { image = new URL(m.image.url); } catch { fail(); }
  need(image.protocol === 'https:' && image.hostname === 'cdn.shopify.com' && !image.username && !image.password
    && [...image.searchParams.keys()].every(key => ['v', 'width', 'height', 'crop', 'format'].includes(key))
    && ['.png', '.jpg', '.jpeg'].includes(path.extname(row.image.path).toLowerCase())
    && path.basename(image.pathname) === `${row.sourceUuid}${path.extname(row.image.path).toLowerCase()}`);
  return p;
}

/** This reads reviewed evidence; it grants no queue or price authorization and performs no API call. */
export function inspectCreatedDraftResolution({ resolutionPath, row, planSha256, authorization, receiptDirectory,
  now = new Date(), historical = false }) {
  const files = filesFor(receiptDirectory), resolutionBinding = files.bind(resolutionPath), resolution = json(files.check(resolutionBinding));
  need(row && typeof row.identity === 'string' && typeof row.handle === 'string' && /^[a-f0-9]{64}$/.test(planSha256 ?? '')
    && resolution.kind === 'reviewed_unknown_create_resolution' && resolution.schemaVersion === 1 && resolution.reviewed === true
    && resolution.createsAuthorization === false && resolution.maxResumeAttempts === 1
    && resolution.identity === row.identity && resolution.handle === row.handle && resolution.planSha256 === planSha256
    && resolution.imageSha256 === row.image?.sha256 && same(resolution.authorization, authorization)
    && authorization?.kind === 'one_off_queue_policy' && authorization.queueKey === 'remaining503' && authorization.queueCount === 503
    && authorization.listingBatchCount === 26 && Number.isInteger(authorization.listingBatchNumber)
    && authorization.listingBatchNumber >= 1 && authorization.listingBatchNumber <= 26);
  const identitySha = sha(row.identity), originalReceiptPath = path.join(files.receipts, `${identitySha}.jsonl`);
  const resolutionReceiptPath = path.join(files.receipts, 'created-draft-resolutions', `${identitySha}.jsonl`);
  const absentRetryPath = path.join(files.receipts, 'absent-create-retries', `${identitySha}.jsonl`);
  need(files.local(resolution.originalReceipt?.path) === originalReceiptPath && !fs.existsSync(files.local(absentRetryPath)));
  const batchDirectory = path.join(files.root, 'remaining503-worker-state', `batch-${String(authorization.listingBatchNumber).padStart(3, '0')}`);
  const planBinding = files.bind(path.join(batchDirectory, 'prepared/listing-plan.json'));
  need(planBinding.sha256 === planSha256);
  const plan = json(files.check(planBinding));
  need(plan.kind === 'pokemon_listing_preparation' && plan.store === 'egk2fq-va.myshopify.com' && plan.currency === 'USD'
    && plan.saleMode === 'display_only' && Array.isArray(plan.records)
    && plan.records.length === (authorization.listingBatchNumber === 26 ? 3 : 20)
    && plan.records.filter(record => record.identity === row.identity).length === 1);
  const recordIndex = plan.records.findIndex(record => record.identity === row.identity);
  need(same(plan.records[recordIndex], row));
  const journalPath = path.join(batchDirectory, `card-${String(recordIndex + 1).padStart(2, '0')}`, 'journal.jsonl');
  need(files.local(resolution.originalJournal?.path) === journalPath);
  const original = events(files.check(resolution.originalReceipt)), journal = events(files.check(resolution.originalJournal));
  need(original.length === 1 && original[0].status === 'create_requested' && original[0].identity === row.identity
    && original[0].planSha256 === planSha256 && same(original[0].authorization, authorization)
    && same(journal.map(event => event.status), ['preflight_verified', 'stage_requested', 'stage_response_received', 'image_uploaded', 'create_requested', 'stopped_review_required'])
    && journal.every(event => event.planSha256 === planSha256 && same(event.authorization, authorization)
      && (event.identity === undefined || event.identity === row.identity)
      && ['productId', 'variantId', 'mediaId'].every(field => event[field] === undefined))
    && journal[0].count === 1 && journal.slice(1, 5).every(event => event.identity === row.identity)
    && journal.slice(1, 4).every(event => event.imageSha256 === row.image.sha256)
    && journal[5].reason === 'listing_cli_result_unknown' && journal[5].completed === 0);
  const times = journal.map(event => time(event.at)), receiptAt = time(original[0].at), requestedAt = times[4], stoppedAt = times[5];
  need(times.every((at, index) => index === 0 || at >= times[index - 1]) && receiptAt <= requestedAt && requestedAt - receiptAt <= 1000);
  need(Array.isArray(resolution.observations) && resolution.observations.length === 2
    && files.local(resolution.observations[0].path) !== files.local(resolution.observations[1].path));
  const ids = Object.fromEntries(['productId', 'variantId', 'mediaId'].map(field => [field, resolution[field]]));
  const observations = resolution.observations.map(binding => {
    const data = json(files.check(binding)), meta = json(files.check(binding.observation));
    need(files.local(meta.outputPath) === files.local(binding.path) && meta.sha256 === binding.sha256
      && meta.before === binding.requestStartedAt && meta.at === binding.observedAt
      && time(meta.before) >= stoppedAt && time(meta.before) <= time(meta.at));
    const product = assertResolvedPristineDraft(data, row, ids);
    need(time(product.createdAt) >= Math.floor(requestedAt / 1000) * 1000 && time(product.createdAt) <= stoppedAt
      && time(product.updatedAt) >= time(product.createdAt) && time(product.updatedAt) <= time(meta.at));
    return data;
  });
  need(same(observations[0], observations[1]));
  const firstAt = time(resolution.observations[0].observedAt), lastAt = time(resolution.observations[1].observedAt), reviewedAt = time(resolution.reviewRecordedAt);
  need(time(resolution.observations[1].requestStartedAt) - firstAt >= 60000 && reviewedAt >= lastAt);
  const fresh = checkTime => {
    const checkedAt = new Date(checkTime).getTime(); need(Number.isFinite(checkedAt) && checkedAt >= reviewedAt && checkedAt >= lastAt);
    if (!historical) need(checkedAt - lastAt <= 15 * 60000);
  };
  fresh(now);
  const bindings = frozen([resolutionBinding, planBinding, resolution.originalReceipt, resolution.originalJournal,
    ...resolution.observations.flatMap(binding => [binding, binding.observation])].map(binding => ({ path: files.local(binding.path), sha256: binding.sha256 })));
  const snapshot = frozen(observations[1].productByIdentifier);
  const guard = ({ now: checkTime = new Date(), requireFresh = false } = {}) => {
    bindings.forEach(binding => files.check(binding));
    need(!fs.existsSync(files.local(absentRetryPath)));
    if (requireFresh) fresh(checkTime);
  };
  const assertLive = data => {
    const live = assertResolvedPristineDraft(data, row, ids);
    need(same(withoutDates(live), withoutDates(snapshot)));
    if ('createdAt' in live) need(live.createdAt === snapshot.createdAt);
    if ('updatedAt' in live) need(live.updatedAt === snapshot.updatedAt);
    return live;
  };
  return { resolution: frozen(resolution), resolutionBinding: bindings[0], bindings, originalReceiptPath,
    resolutionReceiptPath, snapshot, ...ids, guard, assertLive };
}

/** Exactly one local reservation, after an immediate pristine read. No create/upload/stage operation is provided. */
export function reserveCreatedDraftResolution({ inspected, liveData, now = new Date() }) {
  inspected.guard({ now, requireFresh: true }); inspected.assertLive(liveData);
  const r = inspected.resolution, files = filesFor(path.dirname(inspected.originalReceiptPath));
  const destination = files.local(inspected.resolutionReceiptPath);
  const event = { status: 'owned_draft_resolved', at: new Date(now).toISOString(), identity: r.identity,
    planSha256: r.planSha256, authorization: r.authorization, productId: r.productId, variantId: r.variantId, mediaId: r.mediaId,
    resolution: inspected.resolutionBinding, originalReceipt: r.originalReceipt };
  fs.mkdirSync(path.dirname(destination), { recursive: true }); files.local(destination);
  try { fs.writeFileSync(destination, JSON.stringify(event) + '\n', { encoding: 'utf8', flag: 'wx', flush: true }); }
  catch { fail(); }
  let expectedSha = sha(files.read(destination)), finished = false;
  const guard = () => {
    inspected.guard(); need(sha(files.read(destination)) === expectedSha);
  };
  const complete = ({ productId, variantId, mediaId, now: completedAt = new Date() }) => {
    guard(); need(!finished && productId === r.productId && variantId === r.variantId && mediaId === r.mediaId
      && new Date(completedAt).getTime() >= time(event.at));
    fs.appendFileSync(destination, JSON.stringify({ status: 'product_completed', at: new Date(completedAt).toISOString(),
      identity: r.identity, productId, variantId, mediaId }) + '\n', { encoding: 'utf8', flush: true });
    expectedSha = sha(files.read(destination)); finished = true;
  };
  return { guard, complete, resolutionReceiptPath: destination };
}

/** Keeps the resolved event factual; callers must explicitly accept owned_draft_resolved, not fabricate draft_created. */
export function readCompletedDraftResolution({ receiptPath, identity, planSha256, authorization, product, checkBinding }) {
  need(typeof checkBinding === 'function');
  const files = filesFor(path.dirname(receiptPath)), originalBinding = files.bind(receiptPath);
  need(files.local(receiptPath) === path.join(files.receipts, `${sha(identity)}.jsonl`));
  const original = events(files.check(originalBinding)); need(original.length === 1);
  const sidecarBinding = files.bind(path.join(files.receipts, 'created-draft-resolutions', `${sha(identity)}.jsonl`));
  const sidecar = events(files.check(sidecarBinding));
  need(same(sidecar.map(event => event.status), ['owned_draft_resolved', 'product_completed']));
  const event = sidecar[0];
  need(event.identity === identity && event.planSha256 === planSha256 && same(event.authorization, authorization)
    && same({ path: files.local(event.originalReceipt?.path), sha256: event.originalReceipt?.sha256 }, originalBinding));
  const resolution = json(files.check(event.resolution));
  const planPath = path.join(files.root, 'remaining503-worker-state', `batch-${String(authorization.listingBatchNumber).padStart(3, '0')}`, 'prepared/listing-plan.json');
  const row = json(files.read(planPath)).records.find(item => item.identity === identity);
  const inspected = inspectCreatedDraftResolution({ resolutionPath: event.resolution.path, row, planSha256, authorization,
    receiptDirectory: files.receipts, historical: true });
  need(same(inspected.resolutionBinding, { path: files.local(event.resolution.path), sha256: event.resolution.sha256 })
    && time(event.at) >= time(resolution.reviewRecordedAt) && time(event.at) - time(resolution.observations[1].observedAt) <= 15 * 60000
    && time(sidecar[1].at) >= time(event.at)
    && sidecar.every(item => item.identity === identity && ['productId', 'variantId', 'mediaId'].every(field => item[field] === product[field] && item[field] === resolution[field])));
  for (const binding of [originalBinding, sidecarBinding, ...inspected.bindings]) checkBinding(binding);
  return [original[0], ...sidecar];
}
