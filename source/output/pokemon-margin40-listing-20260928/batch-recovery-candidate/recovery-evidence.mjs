import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { assertCompletedRemote } from '../worker-resume-review.mjs';
import { verifyAppDailyQuotes } from '../../../pokemon-single-card-sync/app-quotes.mjs';
import { readCompletedCreationReceipt, isCompletedCreationReceipt } from '../../../pokemon-single-card-sync/creation-receipts.mjs';
import { resolveHistoricalQueueExecutionRow } from '../../../pokemon-single-card-sync/queue-quote-refresh.mjs';

export const STORE = 'egk2fq-va.myshopify.com';
export const QUEUE_SHA = 'ece88600b814061e1a8257b432143d4fea118926a44aeb86dbfea085b87059b4';
export const THEME = '158535483580';
export const COLLECTION = 'gid://shopify/Collection/522669424956';
export const ASSETS = ['assets/p10-pokemon-single-card-catalog.json', 'assets/p10-pokemon-single-card-boxes.json', 'assets/p10-single-card-boxes.json'];
export const sha = value => createHash('sha256').update(value).digest('hex');
export const need = value => { if (!value) throw Object.assign(new Error('worker_resume_evidence_invalid'), { code: 'worker_resume_evidence_invalid' }); };
export const epoch = value => { need(typeof value === 'string' && Number.isFinite(Date.parse(value))); return Date.parse(value); };
export const gid = (value, type) => new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(value ?? '');
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const lines = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
export const key = binding => ({ path: path.resolve(binding.path), sha256: binding.sha256 });

export function proofReader(root) {
  const bindings = new Map(), permitted = new Map(), base = path.resolve(root), workspace = path.resolve(root, '../..');
  const local = file => {
    need(typeof file === 'string' && path.isAbsolute(file));
    const full = path.resolve(file), relative = path.relative(base, full);
    need(relative && (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..' || permitted.has(full)));
    for (let cursor = full; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) need(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink());
    return full;
  };
  const check = (binding, remember = true) => {
    need(binding && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
    const file = local(binding.path); need(!permitted.has(file) || permitted.get(file) === binding.sha256);
    need(fs.statSync(file).isFile() && sha(fs.readFileSync(file)) === binding.sha256);
    if (remember) { need(!bindings.has(file) || bindings.get(file) === binding.sha256); bindings.set(file, binding.sha256); }
    return file;
  };
  return { local, check, json: binding => read(check(binding)), events: binding => lines(check(binding)),
    permitExact(binding) {
      need(binding && typeof binding.path === 'string' && path.isAbsolute(binding.path) && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
      const file = path.resolve(binding.path), relative = path.relative(workspace, file);
      need(relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..'
        && (!permitted.has(file) || permitted.get(file) === binding.sha256));
      permitted.set(file, binding.sha256); check(binding);
    },
    guard: () => { for (const [file, digest] of bindings) check({ path: file, sha256: digest }, false); },
    theme(files) {
      need(Array.isArray(files) && files.length === 3 && same(files.map(x => x.asset).sort(), [...ASSETS].sort()));
      return ASSETS.map(asset => { const file = files.find(x => x.asset === asset); check(file); return { ...file, relativePath: asset }; });
    } };
}

/** The caller must bind this manifest to the existing launch manifest, never to an untrusted review alone. */
export function readInitialProducts(binding, proofs) {
  const initial = proofs.json(binding), products = [];
  need(initial.count === 40 && initial.uniqueApproved === true && initial.store === STORE && Array.isArray(initial.sources));
  for (const source of initial.sources) {
    const file = { path: source.readbackPath, sha256: source.readbackSha256 };
    proofs.permitExact(file);
    const report = proofs.json(file);
    need(report.kind === 'verified_display_only_pokemon_products' && report.store === STORE && Array.isArray(report.products)); products.push(...report.products);
  }
  need(products.length === 40 && new Set(products.map(product => product.identity)).size === 40
    && products.every(product => product.availableForSale === false && product.inventoryTracked === true && product.inventoryPolicy === 'DENY'));
  return products;
}

export function verifyPlanQuotes(plan, snapshot, { now = new Date(), identity, verifyQuotes = verifyAppDailyQuotes } = {}) {
  const catalog = snapshot.cards.map(card => ({ identity: `pokemon:${card.language}:${card.setId}:${card.uuid}`, ip: 'pokemon',
    language: card.language, setId: card.setId, setCode: card.setCode, packName: card.packName, name: card.cardName,
    originalName: card.originalName || undefined, number: card.cardNumber, sourceKind: 'official_app_ui',
    versionIdKind: 'jihuanshe_pro_card_uuid', versionId: card.uuid, sourceUrl: card.shareUrl }));
  const runs = new Map();
  for (const item of plan.records.filter(item => identity === undefined || item.identity === identity)) {
    const capture = item.quote?.evidence?.directory; need(path.isAbsolute(capture ?? '') && path.basename(capture) === 'capture');
    const run = path.dirname(path.dirname(capture));
    if (!runs.has(run)) runs.set(run, verifyQuotes(run, catalog, { now: new Date(now) }));
    need(same(runs.get(run).quotes.find(quote => quote.identity === item.identity), item.quote));
  }
}

export function frozenPlan(plan, batch, queue) {
  need(plan.kind === 'pokemon_listing_preparation' && plan.store === STORE && plan.currency === 'USD' && plan.saleMode === 'display_only'
    && same(plan.records?.map(row => row.identity), batch.identities));
  for (const row of plan.records) {
    const frozen = queue.records.find(card => card.identity === row.identity);
    need(frozen && row.handle === frozen.proposedHandle && row.sku === frozen.proposedSku && row.title === frozen.proposedDisplayFields.title
      && row.fields?.title === row.title && row.fields.descriptionHtml === frozen.proposedDisplayFields.descriptionHtml
      && same(row.fields.tags, frozen.proposedDisplayFields.tags)
      && ['sourceUuid', 'setId', 'language', 'cardNumber'].every(field => row[field] === frozen[field]));
  }
}

export function completedProduct(entry, row, planBinding, authorization, receiptDirectory, proofs) {
  const report = proofs.json(entry.readback), journal = proofs.events(entry.journal), remote = proofs.json(entry.remote);
  proofs.check(entry.receipt);
  const originalRow = proofs.json(planBinding).records.find(item => item.identity === row.identity);
  const executionRow = resolveHistoricalQueueExecutionRow({ originalRow, planPath: planBinding.path, planSha256: planBinding.sha256,
    authorization, receiptDirectory, journalPath: entry.journal.path, journalSha256: entry.journal.sha256,
    checkBinding: binding => proofs.check(binding) });
  need(same(row, originalRow) || same(row, executionRow));
  row = executionRow;
  need(entry.identity === row.identity && path.resolve(entry.receipt.path) === path.join(receiptDirectory, `${sha(row.identity)}.jsonl`)
    && report.kind === 'verified_display_only_pokemon_products' && report.store === STORE && report.planSha256 === planBinding.sha256 && report.products?.length === 1);
  const product = report.products[0], completed = journal.filter(event => event.status === 'product_completed');
  let receipt;
  try { receipt = readCompletedCreationReceipt({receiptPath:entry.receipt.path,identity:row.identity,planSha256:planBinding.sha256,
    authorization,product,checkBinding:binding=>proofs.check(binding)}); } catch { need(false); }
  need(['identity', 'sourceUuid', 'setId', 'language', 'cardNumber', 'sku', 'handle'].every(field => product[field] === row[field])
    && product.productHandle === row.handle && product.title === row.title && product.price === row.fields.price
    && product.availableForSale === false && product.inventoryTracked === true && product.inventoryPolicy === 'DENY'
    && product.collectionId === COLLECTION && product.imageURL === product.imageUrl
    && isCompletedCreationReceipt(receipt)
    && receipt.every(event => event.identity === row.identity) && receipt[0].planSha256 === planBinding.sha256
    && same(receipt[0].authorization, authorization)
    && receipt.slice(1).every(event => ['productId', 'variantId', 'mediaId'].every(field => event[field] === product[field]))
    && journal.every(event => event.planSha256 === planBinding.sha256) && journal.at(-1)?.status === 'completed'
    && completed.length === 1 && completed[0].identity === row.identity
    && ['productId', 'variantId', 'mediaId'].every(field => completed[0][field] === product[field]));
  for (const [field, type] of Object.entries({ productId: 'Product', variantId: 'ProductVariant', mediaId: 'MediaImage', imageId: 'ProductImage', imageSourceId: 'ImageSource' })) need(gid(product[field], type));
  assertCompletedRemote(remote, row, product);
  return product;
}

export function assertCatalog(catalog, products) {
  need(catalog.catalogIp === 'pokemon' && catalog.currency === 'USD' && catalog.purchaseMode === 'display_only'
    && catalog.cards?.length === products.length);
  const identity = card => `pokemon:${card.language}:${card.setId}:${card.sourceUuid ?? card.uuid}`;
  need(new Set(catalog.cards.map(identity)).size === catalog.cards.length);
  const tail = value => String(value).split('/').at(-1);
  for (const product of products) {
    const card = catalog.cards.find(card => identity(card) === product.identity);
    need(card && card.productId === tail(product.productId) && card.variantId === tail(product.variantId)
      && card.imageId === tail(product.imageId) && card.sku === product.sku && card.productHandle === product.handle
      && card.imageURL === product.imageUrl && card.cardNumber === product.cardNumber && card.purchaseMode === 'display_only');
  }
}

export function assertKnownDraft(data, row, target, journal) {
  const p = data?.productByIdentifier;
  const html = value => value?.replace(/>[\r\n\t ]+</g, '><');
  const tags = values => [...new Set((values ?? []).map(value => /^(?:Pokémon|Pokemon)$/i.test(value) ? 'pokemon' : value))].sort();
  need(p && p.id === target.productId && p.status === 'DRAFT' && p.onlineStoreUrl === null && p.handle === row.handle
    && p.title === row.title && p.vendor === row.fields.vendor && p.productType === row.fields.productType
    && p.category?.id === row.fields.category && html(p.descriptionHtml) === html(row.fields.descriptionHtml) && same(tags(p.tags), tags(row.fields.tags)));
  for (const field of ['variants', 'media', 'collections', 'resourcePublicationsV2']) need(Array.isArray(p[field]?.nodes) && p[field].pageInfo?.hasNextPage === false);
  need(p.variants.nodes.length === 1 && p.media.nodes.length === 1 && p.resourcePublicationsV2.nodes.every(item => item.isPublished === false));
  const v = p.variants.nodes[0], m = p.media.nodes[0];
  need(gid(target.productId, 'Product') && gid(target.variantId, 'ProductVariant') && gid(target.mediaId, 'MediaImage')
    && v.id === target.variantId && m.id === target.mediaId && m.status === 'READY' && m.alt === row.title && gid(m.image?.id, 'ImageSource')
    && typeof v.availableForSale === 'boolean' && v.inventoryPolicy === 'DENY' && v.inventoryQuantity === 0
    && v.media?.pageInfo?.hasNextPage === false && Array.isArray(v.media.nodes));
  const image = new URL(m.image.url);
  need(image.protocol === 'https:' && image.hostname === 'cdn.shopify.com' && !image.username && !image.password
    && [...image.searchParams.keys()].every(name => ['v', 'width', 'height', 'crop', 'format'].includes(name))
    && path.basename(image.pathname) === `${row.sourceUuid}${path.extname(row.image.path)}`);
  const configured = v.sku === row.sku && Number(v.price).toFixed(2) === row.fields.price && v.inventoryItem?.tracked === true;
  const configurationConfirmed = journal.some(event => event.status === 'variant_response_received'
    || event.status === 'verified_after_transport_failure' && event.operation === 'variant' || event.status.startsWith('addToCollection_'));
  need(!configurationConfirmed || configured);
  if (configured) need(v.availableForSale === false && gid(v.image?.id, 'ProductImage') && v.image.url === m.image.url && same(v.media.nodes.map(item => item.id), [m.id]));
  else need(['', null].includes(v.sku) && typeof v.price === 'string' && /^0(?:\.0{1,2})?$/.test(v.price)
    && v.inventoryItem?.tracked === false && v.image === null && v.media.nodes.length === 0);
  const allowed = [...row.fields.collections, COLLECTION], members = p.collections.nodes.map(item => item.id);
  need(new Set(members).size === members.length && p.collections.nodes.every(item => allowed.includes(item.id) || typeof item.ruleSet?.appliedDisjunctively === 'boolean'));
  const confirmed = journal.filter(event => event.status === 'addToCollection_response_received'
    || event.status === 'verified_after_transport_failure' && event.operation === 'addToCollection').map(event => event.collectionId);
  need(confirmed.every(id => members.includes(id)));
  return p;
}
