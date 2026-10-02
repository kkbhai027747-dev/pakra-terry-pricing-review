import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, readJson } from './files.mjs';
import { listingPrice } from './prepare-listings.mjs';
import { verifyAppDailyQuotes } from './app-quotes.mjs';
import { resolveQueueExecutionRow } from './queue-quote-refresh.mjs';
import { inspectQueuePolicyPlan } from './one-off-listing-policy.mjs';
import { inspectAbsentCreateWitness } from './creation-receipts.mjs';
import { inspectCreatedDraftResolution, reserveCreatedDraftResolution } from './created-draft-resolution.mjs';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(PROJECT, '..');
const STORE = 'egk2fq-va.myshopify.com';
const PUBLICATION = 'gid://shopify/Publication/173264044220';
const COLLECTIONS = ['gid://shopify/Collection/333313114300', 'gid://shopify/Collection/333313278140'];
const COLLECTION_HANDLE = 'pokemon-single-cards';
const GID = (kind, value) => new RegExp(`^gid://shopify/${kind}/[1-9]\\d*$`).test(value ?? '');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Separate exact operations: the existing price-only ShopifyClient remains unchanged.
export const LISTING_OPERATIONS = Object.freeze({
  preflight: `query ListingPreflight($handle: String!, $collectionHandle: String!, $collectionIds: [ID!]!) {
    shop { currencyCode } productByIdentifier(identifier: {handle: $handle}) { id handle }
    collectionByHandle(handle: $collectionHandle) { id handle title ruleSet { appliedDisjunctively } }
    nodes(ids: $collectionIds) { ... on Collection { id handle ruleSet { appliedDisjunctively } } }
  }`,
  verifyCollection: `query VerifyPokemonSinglesCollection($handle: String!) {
    collectionByHandle(handle: $handle) { id handle title ruleSet { appliedDisjunctively }
      resourcePublicationsV2(first: 20) { nodes { isPublished publication { id } } pageInfo { hasNextPage } } }
  }`,
  stage: `mutation StagePokemonImage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
  }`,
  createCollection: `mutation CreatePokemonSinglesCollection($input: CollectionInput!) {
    collectionCreate(input: $input) { collection { id handle title } userErrors { field message } }
  }`,
  create: `mutation CreatePokemonSingle($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) { product { id handle status variants(first: 2) { nodes { id sku } }
      media(first: 2) { nodes { id status } } } userErrors { field message } }
  }`,
  variant: `mutation PrepareDisplayOnlyVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id sku price inventoryPolicy inventoryItem { tracked } } userErrors { field message }
    }
  }`,
  addToCollection: `mutation AddListingToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) { collection { id } userErrors { field message } }
  }`,
  activate: `mutation ActivatePokemonDisplay($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id status handle } userErrors { field message } }
  }`,
  publish: `mutation PublishPokemonDisplay($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`,
  verify: `query VerifyPokemonDisplay($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) { id handle title status onlineStoreUrl vendor productType descriptionHtml tags category { id }
      collections(first: 20) { nodes { id handle ruleSet { appliedDisjunctively } } pageInfo { hasNextPage } }
      media(first: 3) { nodes { id status alt ... on MediaImage { image { id url width height } } } pageInfo { hasNextPage } }
      variants(first: 3) { nodes { id sku price availableForSale inventoryPolicy inventoryQuantity inventoryItem { tracked }
        image { id url } media(first: 3) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
      resourcePublicationsV2(first: 20) { nodes { isPublished publication { id } } pageInfo { hasNextPage } }
    }
  }`,
  verifyCreated: `query VerifyCreatedPokemonDisplay($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) { id createdAt updatedAt handle title status onlineStoreUrl vendor productType descriptionHtml tags category { id }
      collections(first: 20) { nodes { id handle ruleSet { appliedDisjunctively } } pageInfo { hasNextPage } }
      media(first: 3) { nodes { id status alt ... on MediaImage { image { id url width height } } } pageInfo { hasNextPage } }
      variants(first: 3) { nodes { id sku price availableForSale inventoryPolicy inventoryQuantity inventoryItem { tracked }
        image { id url } media(first: 3) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
      resourcePublicationsV2(first: 20) { nodes { isPublished publication { id } } pageInfo { hasNextPage } }
    }
  }`,
  verifyMany: `query VerifyPokemonDisplays($ids: [ID!]!) {
    nodes(ids: $ids) { __typename ... on Product { id handle title status onlineStoreUrl vendor productType descriptionHtml tags category { id }
      collections(first: 20) { nodes { id handle ruleSet { appliedDisjunctively } } pageInfo { hasNextPage } }
      media(first: 3) { nodes { id status alt ... on MediaImage { image { id url width height } } } pageInfo { hasNextPage } }
      variants(first: 3) { nodes { id sku price availableForSale inventoryPolicy inventoryQuantity inventoryItem { tracked }
        image { id url } media(first: 3) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
      resourcePublicationsV2(first: 20) { nodes { isPublished publication { id } } pageInfo { hasNextPage } }
    } }
  }`,

});
const READS = new Set(['preflight', 'verify', 'verifyCreated', 'verifyCollection', 'verifyMany']);
const READ_RETRY_DELAYS = [1500, 5000, 15000];

function cliTransport(result) {
  const diagnosticText = [result.stdout, result.stderr, result.error?.code, result.error?.message]
    .filter(value => value != null).join('\n').toUpperCase();
  const indicators = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN',
    'EACCES', 'EPERM', 'THROTTLED', 'UNAUTHORIZED', 'ACCESS DENIED', 'FETCH FAILED', 'CERTIFICATE',
    'TIMED OUT', 'TIMEOUT', 'SOCKET HANG UP', 'UNEXPECTED END', 'CONNECTION CLOSED', 'REQUEST FAILED',
    'NETWORK ERROR', 'STATUS 429', 'STATUS 500', 'STATUS 502', 'STATUS 503', 'STATUS 504', 'ABORT', 'RATE LIMIT'];
  const transport = { exitCode: Number.isInteger(result.status) ? result.status : null,
    errorCode: /^[A-Z_]{1,64}$/.test(result.error?.code ?? '') ? result.error.code : null,
    indicators: indicators.filter(value => diagnosticText.includes(value)) };
  const blocked = /\b(?:EACCES|EPERM|UNAUTHORIZED|UNAUTHENTICATED|FORBIDDEN|ACCESS[_ ]DENIED|PERMISSION|AUTHENTICATION|INVALID[_ ](?:TOKEN|CREDENTIALS)|CERTIFICATE|CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|GRAPHQL_VALIDATION_FAILED|GRAPHQL_PARSE_FAILED|SYNTAX ERROR|PARSE ERROR|UNEXPECTED TOKEN|UNEXPECTED END OF JSON|INVALID JSON|MALFORMED|INVALID VARIABLE|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)\b/.test(diagnosticText)
    || /\b(?:HTTP(?:\/\d(?:\.\d)?)?|STATUS(?:[_ ]?CODE)?)["']?\s*[:=]?\s*["']?(?:401|403)\b/.test(diagnosticText);
  const transient = /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|THROTTLED|FETCH FAILED|TIMED OUT|TIMEOUT|SOCKET HANG UP|CONNECTION CLOSED|NETWORK ERROR)\b/.test(diagnosticText)
    || /\b(?:HTTP(?:\/\d(?:\.\d)?)?|STATUS(?:[_ ]?CODE)?)["']?\s*[:=]?\s*["']?(?:429|5\d\d)\b/.test(diagnosticText);
  return { transport, blocked, retryable: !blocked && transient };
}

function graphqlTransport(response, result) {
  const errors = [...(Array.isArray(response.errors) ? response.errors : []), ...(response.error ? [response.error] : [])];
  const diagnostic = cliTransport({ ...result, stdout: '', stderr: JSON.stringify(errors) });
  return { transport: diagnostic.transport, retryable: !diagnostic.blocked && errors.length > 0 && errors.every(error => {
    const code = error?.extensions?.code ?? error?.code;
    const status = error?.extensions?.http?.status ?? error?.statusCode ?? error?.status;
    return code === 'THROTTLED' || Number.isInteger(status) && (status === 429 || status >= 500 && status <= 599);
  }) };
}

/** Uses only the official CLI credential store; staged responses and business variables stay in process memory. */
export class ListingShopifyClient {
  constructor({ store = STORE, cliPath, runner = spawnSync } = {}) {
    if (store !== STORE || typeof cliPath !== 'string' || !isAbsolute(cliPath) || /\.(cmd|bat)$/i.test(cliPath)) fail('invalid_listing_cli_configuration');
    this.store = store; this.cliPath = cliPath; this.runner = runner;
  }
  async execute(operation, variables, { allowMutations = false } = {}) {
    if (!Object.hasOwn(LISTING_OPERATIONS, operation) || allowMutations !== !READS.has(operation)) fail('listing_operation_not_allowed');
    if (operation === 'verifyMany' && (Object.keys(variables ?? {}).length !== 1 || !Array.isArray(variables?.ids)
      || variables.ids.length < 1 || variables.ids.length > 5 || new Set(variables.ids).size !== variables.ids.length
      || variables.ids.some(id => !GID('Product', id)))) fail('invalid_listing_product_read_batch');
    const directory = mkdtempSync(join(tmpdir(), 'pokemon-listing-cli-'));
    try {
      const queryPath = join(directory, 'operation.graphql');
      writeFileSync(queryPath, LISTING_OPERATIONS[operation]);
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^SHOPIFY_/i.test(name)));
      // This is a CLI-supported argument carrier, not a credential or a persisted .env file.
      Object.assign(environment, { CI: '1', SHOPIFY_FLAG_VARIABLES: JSON.stringify(variables),
        SHOPIFY_CLI_AGENT_INFO: 'n:Codex|v:1|p:OpenAI', SHOPIFY_CLI_AGENT_IDS: 'r:pokemon-single-card-sync|i:listing-client' });
      const args = ['store', 'execute', '--store', this.store, '--query-file', queryPath, '--version', '2026-07', '--json', '--no-color'];
      if (allowMutations) args.push('--allow-mutations');
      const powershell = /\.ps1$/i.test(this.cliPath);
      const maxAttempts = READS.has(operation) ? READ_RETRY_DELAYS.length + 1 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const result = this.runner(powershell ? 'powershell.exe' : this.cliPath,
          powershell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.cliPath, ...args] : args,
          { shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
            env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let response;
        if (!result.error && result.status === 0) {
          try { response = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { }
        }
        if (!response) {
          const { transport, retryable } = cliTransport(result);
          // Exit zero with malformed output is a format failure, not a transport retry.
          if (attempt + 1 < maxAttempts && retryable && (result.error || result.status !== 0)) {
            await pause(READ_RETRY_DELAYS[attempt]); continue;
          }
          throw Object.assign(new Error('listing_cli_result_unknown'), { code: 'listing_cli_result_unknown', transport,
            retryableTransport: retryable && Boolean(result.error || result.status !== 0) });
        }
        if (response.errors?.length || response.error) {
          const { transport, retryable } = graphqlTransport(response, result);
          if (attempt + 1 < maxAttempts && retryable) { await pause(READ_RETRY_DELAYS[attempt]); continue; }
          throw Object.assign(new Error('listing_graphql_failed'), { code: 'listing_graphql_failed', transport });
        }
        return response.data ?? response;
      }
    } finally {
      if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('pokemon-listing-cli-')) fail('invalid_cli_temporary_path');
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function localPath(value, { mustExist = true } = {}) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('invalid_listing_path');
  const path = resolve(value), child = relative(WORKSPACE, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('listing_path_outside_workspace');
  for (let cursor = path; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('listing_path_symlink');
  }
  if (mustExist && (!existsSync(path) || !lstatSync(path).isFile())) fail('listing_file_missing');
  return path;
}
function imageBytes(image) {
  const bytes = readFileSync(localPath(image?.path));
  if (bytes.length > 30 * 1024 * 1024 || sha256(bytes) !== image.sha256) fail('listing_image_hash_mismatch');
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { bytes, mimeType: 'image/png', extension: 'png' };
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return { bytes, mimeType: 'image/jpeg', extension: 'jpg' };
  fail('listing_image_type_unsupported');
}
function uploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_staged_upload_target'); }
  const allowed = url.hostname === 'cdn.shopify.com'
    || /^shopify-[a-z0-9-]+\.storage\.googleapis\.com$/.test(url.hostname)
    || /^shopify-[a-z0-9-]+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
    || url.hostname === 'storage.googleapis.com' && /^\/shopify-[a-z0-9-]+\//.test(url.pathname);
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') fail('invalid_staged_upload_target');
  return url.href;
}
export async function uploadStagedImage(target, image, filename, { fetchImpl = fetch, sleep = pause, guard = () => {} } = {}) {
  const url = uploadUrl(target?.url), resourceUrl = uploadUrl(target?.resourceUrl);
  if (!Array.isArray(target.parameters) || !target.parameters.length || target.parameters.length > 64) fail('invalid_staged_upload_parameters');
  const form = new FormData(), names = new Set();
  for (const { name, value } of target.parameters) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name) || name === 'file' || names.has(name)
      || typeof value !== 'string' || value.length > 65_536) fail('invalid_staged_upload_parameters');
    names.add(name); form.append(name, value);
  }
  form.append('file', new Blob([image.bytes], { type: image.mimeType }), filename);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await guard();
    let response, networkFailed = false;
    try { response = await fetchImpl(url, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(120_000) }); }
    catch { networkFailed = true; }
    const success = response?.ok === true && response.status >= 200 && response.status < 300;
    const retryable = networkFailed || response?.status === 429 || response?.status >= 500 && response.status <= 599;
    try { await response?.body?.cancel(); } catch {}
    if (success) return resourceUrl;
    if (!retryable || attempt === 2) fail('staged_upload_failed');
    await sleep(attempt === 0 ? 2000 : 5000);
  }
}

export function readApprovedListingPlan(planPath, approval, { now = new Date(), limit = 1, refreshedQuotesPath } = {}) {
  const bytes = readFileSync(localPath(planPath)), digest = sha256(bytes);
  if (approval?.approved !== true || approval.planSha256 !== digest) fail('listing_approval_hash_mismatch');
  return readSelectedListingPlan(planPath, approval.identities, { now, limit, refreshedQuotesPath, expectedDigest: digest });
}
function readSelectedListingPlan(planPath, identities, { now, limit, refreshedQuotesPath, expectedDigest, inspectedRefresh }) {
  const bytes = readFileSync(localPath(planPath)), digest = sha256(bytes);
  if (digest !== expectedDigest) fail('listing_plan_changed');
  if (!Array.isArray(identities) || !identities.length || identities.length > 20
    || new Set(identities).size !== identities.length || !Number.isInteger(limit) || limit < 1 || limit > identities.length) fail('invalid_listing_approved_selection');
  const plan = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (plan.kind !== 'pokemon_listing_preparation' || plan.store !== STORE || plan.currency !== 'USD' || plan.saleMode !== 'display_only'
    || plan.shopifyWritesPerformed !== false || !Array.isArray(plan.records) || plan.collection?.id !== null
    || plan.collection.handle !== COLLECTION_HANDLE || plan.collection.title !== 'Pokémon Single Cards' || plan.collection.type !== 'manual'
    || plan.collection.publicationId !== PUBLICATION) fail('invalid_listing_plan');
  if (sha256(readFileSync(localPath(plan.snapshotPath))) !== plan.snapshotSha256) fail('listing_snapshot_hash_mismatch');
  const all = new Map(plan.records.map(row => [row.identity, row]));
  if (all.size !== plan.records.length) fail('duplicate_listing_identity');
  let records = identities.map(identity => all.get(identity));
  for (const row of records) {
    const code = { 'zh-Hans': 'SC', ja: 'JP', en: 'EN' }[row?.language];
    if (!row || !code || !/^[1-9]\d*$/.test(row.setId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.sourceUuid)
      || row.identity !== `pokemon:${row.language}:${row.setId}:${row.sourceUuid}`
      || row.sourceUrl !== `https://api.jihuanshe.com/pro/cards/${row.sourceUuid}`
      || row.handle !== `pokemon-single-${code.toLowerCase()}-${row.setId}-${row.sourceUuid}`
      || row.sku !== `PKM-${code}-${row.setId}-${row.sourceUuid.toUpperCase()}`
      || row.productId !== null || row.variantId !== null || row.oldValue !== null || row.saleMode !== 'display_only'
      || row.readyForReview !== true || !Array.isArray(row.blockers) || row.blockers.length
      || row.fields?.finalStatus !== 'ACTIVE' || row.fields.publicationId !== PUBLICATION
      || !same(row.fields.collections, COLLECTIONS) || row.fields.newCollectionHandle !== COLLECTION_HANDLE
      || row.fields.inventory?.tracked !== true || row.fields.inventory.inventoryPolicy !== 'DENY' || row.fields.inventory.quantityWrite !== false
      || !['inventory_tracked_true', 'inventory_policy_deny', 'available_for_sale_false'].every(value => row.publicationReadbackRequired?.includes(value))) fail('listing_record_not_approved_ready');
    imageBytes(row.image);
  }
  if (inspectedRefresh && refreshedQuotesPath) fail('invalid_listing_refreshed_quotes');
  if (inspectedRefresh) records = records.map(originalRow => resolveQueueExecutionRow({ originalRow, inspectedRefresh }));
  let refreshedQuotes;
  if (refreshedQuotesPath) {
    const path = localPath(refreshedQuotesPath), bytes = readFileSync(path);
    const supplied = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (supplied.kind !== 'verified_app_quotes' || !Array.isArray(supplied.targetIdentities)
      || supplied.targetIdentities.some(identity => !all.has(identity))) fail('invalid_listing_refreshed_quotes');
    const verified = verifyAppDailyQuotes(localPath(supplied.directory, { mustExist: false }), quoteCatalog(plan), { now });
    for (const key of ['kind', 'source', 'metric', 'sourceKind', 'conditionScope', 'directory', 'reportSha256',
      'selection', 'targetIdentities', 'quotes', 'unquoted']) {
      if (!same(supplied[key], verified[key])) fail('listing_refreshed_quote_evidence_changed');
    }
    const byIdentity = new Map(verified.quotes.map(quote => [quote.identity, quote]));
    records = records.map(row => {
      const quote = byIdentity.get(row.identity);
      if (!quote) fail('listing_refreshed_quote_missing');
      return { ...row, quote };
    });
    refreshedQuotes = { path, sha256: sha256(bytes), directory: verified.directory, reportSha256: verified.reportSha256 };
  }
  for (const row of records) {
    const price = listingPrice(row.quote, row.identity, now, { pricingModel: plan.pricing?.pricingModel });
    if (price.reason || !/^\d+\.00$/.test(row.fields.price) || Number(row.fields.price) <= 0) fail('listing_fresh_price_required');
    if (price.price !== row.fields.price) fail(refreshedQuotes ? 'listing_refreshed_price_changed' : 'listing_fresh_price_required');
  }
  return { plan, digest, records: records.slice(0, limit), approvedCount: records.length, ...(refreshedQuotes ? { refreshedQuotes } : {}) };
}
export function readQueueListingPlan(planPath, queuePolicyPath, identities, { now = new Date(), limit = 1, queueQuoteRefresh } = {}) {
  const authorization = inspectQueuePolicyPlan({ policyPath: queuePolicyPath, planPath, identities, queueQuoteRefresh, now });
  if (authorization.quoteRefresh && identities.some(identity => !authorization.quoteRefresh.remainingIdentities.includes(identity))) {
    fail('listing_quote_refresh_completed_selection');
  }
  const { approvedCount, refreshedQuotes, ...prepared } = readSelectedListingPlan(planPath, identities, { now, limit,
    expectedDigest: authorization.digest, inspectedRefresh: authorization.quoteRefresh });
  return { ...prepared, authorizedCount: approvedCount, queueAuthorization: authorization,
    ...(authorization.quoteRefresh ? { queueQuoteRefresh: authorization.quoteRefresh.refreshBinding } : {}) };
}
function quoteCatalog(plan) {
  const snapshot = readJson(localPath(plan.snapshotPath));
  return snapshot.cards.map(card => ({ identity: `pokemon:${card.language}:${card.setId}:${card.uuid}`, ip: 'pokemon',
    language: card.language, setId: card.setId, setCode: card.setCode, packName: card.packName, name: card.cardName,
    originalName: card.originalName || undefined, number: card.cardNumber, sourceKind: 'official_app_ui',
    versionIdKind: 'jihuanshe_pro_card_uuid', versionId: card.uuid, sourceUrl: card.shareUrl }));
}
function verifyQuoteEvidence(plan, records, now) {
  const catalog = quoteCatalog(plan);
  const runs = new Map();
  for (const row of records) {
    const capture = row.quote?.evidence?.directory;
    if (!isAbsolute(capture ?? '') || basename(capture) !== 'capture') fail('invalid_listing_quote_evidence');
    const run = dirname(dirname(capture));
    if (!runs.has(run)) runs.set(run, verifyAppDailyQuotes(run, catalog, { now }));
    const verified = runs.get(run).quotes.find(quote => quote.identity === row.identity);
    if (!verified || !same(verified, row.quote)) fail('listing_quote_evidence_changed');
  }
}
function payload(data, field) {
  const result = data?.[field];
  if (!result || !Array.isArray(result.userErrors)) fail('listing_mutation_result_unknown');
  if (result.userErrors.length) {
    const validation = result.userErrors.map(error => ({
      field: Array.isArray(error.field) ? error.field.map(value => String(value).slice(0, 80)) : null,
      message: String(error.message ?? '').replace(/https?:\/\/\S+/gi, '[URL omitted]')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[long value omitted]').slice(0, 500),
    }));
    throw Object.assign(new Error('listing_mutation_rejected'), { code: 'listing_mutation_rejected', validation });
  }
  return result;
}
function productRead(data, row, productId, status) {
  const product = data?.productByIdentifier;
  const html = value => typeof value === 'string' ? value.replace(/>[\r\n\t ]+</g, '><') : value;
  const tags = values => [...new Set(values.map(value => /^(?:Pokémon|Pokemon)$/i.test(value) ? 'pokemon' : value))].sort();
  if (!product || product.id !== productId || product.handle !== row.handle || product.title !== row.fields.title
    || product.status !== status || product.vendor !== row.fields.vendor || product.productType !== row.fields.productType
    || html(product.descriptionHtml) !== html(row.fields.descriptionHtml) || product.category?.id !== row.fields.category
    || !Array.isArray(product.tags) || !same(tags(product.tags), tags(row.fields.tags))) fail('listing_product_readback_mismatch');
  for (const key of ['variants', 'media', 'collections', 'resourcePublicationsV2']) {
    if (!Array.isArray(product[key]?.nodes) || product[key].pageInfo?.hasNextPage !== false) fail('listing_readback_incomplete');
  }
  if (product.variants.nodes.length !== 1 || product.media.nodes.length !== 1) fail('listing_variant_or_media_not_unique');
  return product;
}
function displayOnlyRead(product, row, variantId, mediaId) {
  const variant = product.variants.nodes[0], media = product.media.nodes[0];
  if (variant.id !== variantId || variant.sku !== row.sku || Number(variant.price).toFixed(2) !== row.fields.price
    || variant.inventoryPolicy !== 'DENY' || variant.inventoryItem?.tracked !== true || variant.availableForSale !== false
    || variant.inventoryQuantity !== 0) fail('listing_display_only_readback_failed');
  displayMediaRead(product, mediaId);
  return { variant, media };
}
function displayMediaRead(product, mediaId) {
  const variant = product.variants.nodes[0], media = product.media.nodes[0];
  if (media.id !== mediaId || media.status !== 'READY' || !GID('ImageSource', media.image?.id) || !GID('ProductImage', variant.image?.id)
    || publicImageUrl(variant.image.url) !== publicImageUrl(media.image.url)
    || variant.media?.pageInfo?.hasNextPage !== false || !same(variant.media?.nodes?.map(item => item.id), [mediaId])) fail('listing_variant_media_readback_failed');
}
function variantConfigured(product, row, variantId, mediaId) {
  const variant = product.variants.nodes[0], media = product.media.nodes[0];
  if (variant.sku === row.sku && Number(variant.price).toFixed(2) === row.fields.price && variant.inventoryItem?.tracked === true) {
    displayOnlyRead(product, row, variantId, mediaId); return true;
  }
  if (product.status !== 'DRAFT' || product.onlineStoreUrl !== null
    || !Array.isArray(product.resourcePublicationsV2?.nodes)
    || product.resourcePublicationsV2.pageInfo?.hasNextPage !== false) fail('listing_draft_variant_drift');
  publications(product, []);
  if (variant.id !== variantId || !['', null].includes(variant.sku) || typeof variant.price !== 'string' || !/^0(?:\.0{1,2})?$/.test(variant.price)
    || variant.inventoryItem?.tracked !== false || variant.inventoryPolicy !== 'DENY'
    || variant.inventoryQuantity !== 0 || typeof variant.availableForSale !== 'boolean' || media.id !== mediaId
    || media.status !== 'READY' || !GID('ImageSource', media.image?.id)) fail('listing_draft_variant_drift');
  if (variant.image !== null || variant.media?.pageInfo?.hasNextPage !== false || !same(variant.media.nodes, [])) fail('listing_draft_variant_drift');
  return false;
}
function publications(product, expected) {
  const ids = product.resourcePublicationsV2.nodes.filter(item => item.isPublished === true).map(item => item.publication?.id).sort();
  if (!same(ids, expected)) fail('listing_unapproved_publication');
}
function publicImageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || url.username || url.password
    || [...url.searchParams.keys()].some(key => !['v', 'width', 'height', 'crop', 'format'].includes(key))) fail('invalid_listing_public_image_url');
  return url.href;
}

function pristineCreatedDraft(product, row, variantId, mediaId) {
  if (variantConfigured(product, row, variantId, mediaId)) fail('listing_unknown_create_not_pristine');
  const media = product.media.nodes[0], url = publicImageUrl(media.image.url);
  if (media.alt !== row.title || basename(new URL(url).pathname) !== `${row.sourceUuid}.${imageBytes(row.image).extension}`
    || product.collections.nodes.some(item => typeof item.ruleSet?.appliedDisjunctively !== 'boolean')) fail('listing_unknown_create_evidence_mismatch');
}

function reviewedCreatedDraft(witnessPath, row, digest) {
  const path = localPath(witnessPath), witness = readJson(path);
  if (witness.kind !== 'reviewed_unknown_create_draft' || witness.reviewed !== true || witness.planSha256 !== digest
    || witness.identity !== row.identity || !GID('Product', witness.productId) || !GID('ProductVariant', witness.variantId)
    || !GID('MediaImage', witness.mediaId)) fail('listing_unknown_create_witness_invalid');
  const journalPath = localPath(witness.journalPath), readbackPath = localPath(witness.readbackPath);
  if (sha256(readFileSync(journalPath)) !== witness.journalSha256 || sha256(readFileSync(readbackPath)) !== witness.readbackSha256) fail('listing_unknown_create_evidence_changed');
  const events = readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const allowed = new Set(['refreshed_quotes_verified', 'preflight_verified', 'stage_requested', 'stage_response_received',
    'image_uploaded', 'create_requested', 'stopped_review_required']);
  if (events.some(event => event.planSha256 !== digest || !allowed.has(event.status) || event.identity && event.identity !== row.identity)
    || events.filter(event => event.status === 'create_requested').length !== 1 || events.at(-2)?.status !== 'create_requested'
    || events.at(-2)?.identity !== row.identity || events.at(-1)?.status !== 'stopped_review_required'
    || events.at(-1)?.reason !== 'listing_cli_result_unknown' || events.at(-1)?.completed !== 0
    || !events.some(event => event.status === 'image_uploaded' && event.identity === row.identity && event.imageSha256 === row.image.sha256)) fail('listing_unknown_create_journal_not_safe');
  const snapshot = productRead(readJson(readbackPath), row, witness.productId, 'DRAFT');
  pristineCreatedDraft(snapshot, row, witness.variantId, witness.mediaId);
  return { identity: row.identity, productId: witness.productId, variantId: witness.variantId, mediaId: witness.mediaId,
    requests: [], confirmedCollections: [], unknownCreateWitness: { path, sha256: sha256(readFileSync(path)),
      journalPath, journalSha256: witness.journalSha256, readbackPath, readbackSha256: witness.readbackSha256 }, snapshot };
}

/** No automatic resume of create steps. A stopped or ambiguous run requires explicit journal review. */
export async function executeListingPlan({ client, planPath, approval, queuePolicyPath, queueIdentities, queueQuoteRefresh, outputDir, limit = 1, now, resumeDraftJournal, resumeCreatedDraftWitness, resumeAbsentCreateWitness, resumeCreatedDraftResolution, refreshedQuotesPath,
  sleep = pause, upload = uploadStagedImage, evidenceVerifier = verifyQuoteEvidence, pollAttempts = 12 } = {}) {
  const currentTime = () => now === undefined ? new Date() : new Date(now);
  if (queuePolicyPath && (approval !== undefined || resumeCreatedDraftWitness || refreshedQuotesPath)
    || !queuePolicyPath && (queueIdentities !== undefined || resumeAbsentCreateWitness || resumeCreatedDraftResolution || queueQuoteRefresh !== undefined)
    || resumeAbsentCreateWitness && (resumeDraftJournal || resumeCreatedDraftWitness || resumeCreatedDraftResolution || refreshedQuotesPath)
    || resumeCreatedDraftResolution && (resumeDraftJournal || resumeCreatedDraftWitness || refreshedQuotesPath)) fail('listing_authorization_modes_conflict');
  const prepared = queuePolicyPath
    ? readQueueListingPlan(planPath, queuePolicyPath, queueIdentities, { now: currentTime(), limit, queueQuoteRefresh })
    : readApprovedListingPlan(planPath, approval, { now: currentTime(), limit, refreshedQuotesPath });
  const { plan, digest, records } = prepared;
  const queueAuthorization = prepared.queueAuthorization;
  const receiptPath = row => join(queueAuthorization.receiptDirectory, `${sha256(row.identity)}.jsonl`);
  if (queueAuthorization && !resumeDraftJournal && !resumeAbsentCreateWitness && !resumeCreatedDraftResolution && records.some(row => existsSync(receiptPath(row)))) fail('queue_policy_creation_already_attempted');
  let absentRetry = null, retryReceiptSha256 = null;
  if (resumeAbsentCreateWitness) {
    if (records.length !== 1) fail('listing_absent_create_witness_invalid');
    absentRetry = inspectAbsentCreateWitness({ witnessPath: resumeAbsentCreateWitness, row: records[0], planSha256: digest,
      authorization: queueAuthorization.authorization, receiptDirectory: queueAuthorization.receiptDirectory, now: currentTime() });
    if (existsSync(absentRetry.retryReceiptPath)) fail('listing_absent_create_retry_consumed');
  }
  const guardAbsentRetry = (requireFresh = false) => {
    if (!absentRetry) return;
    absentRetry.guard({ now: currentTime(), requireFresh });
    if (retryReceiptSha256 !== null && sha256(readFileSync(localPath(absentRetry.retryReceiptPath))) !== retryReceiptSha256) fail('listing_absent_create_retry_changed');
  };
  const appendRetryReceipt = event => {
    guardAbsentRetry();
    appendFileSync(localPath(absentRetry.retryReceiptPath), JSON.stringify(event) + '\n', { flush: true });
    retryReceiptSha256 = sha256(readFileSync(localPath(absentRetry.retryReceiptPath)));
  };
  let resolvedDraft = null, resolutionReservation = null;
  if (resumeCreatedDraftResolution) {
    if (records.length !== 1) fail('listing_created_draft_resolution_invalid');
    // Quote refresh changes only the execution row; ownership remains bound to the original frozen row.
    const originalRow = plan.records.find(row => row.identity === records[0].identity);
    resolvedDraft = inspectCreatedDraftResolution({ resolutionPath: resumeCreatedDraftResolution, row: originalRow,
      planSha256: digest, authorization: queueAuthorization.authorization, receiptDirectory: queueAuthorization.receiptDirectory, now: currentTime() });
    if (existsSync(resolvedDraft.resolutionReceiptPath)) fail('listing_created_draft_resolution_consumed');
  }
  const guardResolution = () => { if (resolvedDraft) resolvedDraft.guard(); if (resolutionReservation) resolutionReservation.guard(); };
  let resumedDraft = resolvedDraft ? { identity: records[0].identity, productId: resolvedDraft.productId,
    variantId: resolvedDraft.variantId, mediaId: resolvedDraft.mediaId, requests: [], confirmedCollections: [], snapshot: resolvedDraft.snapshot } : null,
    queueResumeEvidence = [];
  if (resumeCreatedDraftWitness) {
    if (resumeDraftJournal || records.length !== 1) fail('listing_unknown_create_witness_invalid');
    resumedDraft = reviewedCreatedDraft(resumeCreatedDraftWitness, records[0], digest);
  }
  if (resumeDraftJournal) {
    const resumeJournalBytes = readFileSync(localPath(resumeDraftJournal));
    const events = resumeJournalBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const created = events.filter(event => event.status === 'draft_created');
    const createdAt = events.findIndex(event => event.status === 'draft_created');
    const requests = events.slice(createdAt + 1).filter(event => typeof event.status === 'string' && event.status.endsWith('_requested'));
    const stopped = events.at(-1);
    const metadataOnly = stopped?.reason === 'listing_product_readback_mismatch' && requests.length === 0;
    const createdThenStopped = Boolean(queueAuthorization) && stopped?.reason === 'listing_execution_stopped' && requests.length === 0
      && same(events.map(event => event.status), ['preflight_verified', 'stage_requested', 'stage_response_received',
        'image_uploaded', 'create_requested', 'create_response_received', 'draft_created', 'stopped_review_required']);
    const transportDraft = ['listing_cli_result_unknown', 'listing_recovery_state_drift'].includes(stopped?.reason) && requests.length > 0
      && requests.every(event => ['variant_requested', 'addToCollection_requested'].includes(event.status)
        && event.identity === created[0]?.identity && event.productId === created[0]?.productId
        && (event.status === 'variant_requested' ? event.variantId === created[0]?.variantId : GID('Collection', event.collectionId)));
    if (records.length !== 1 || created.length !== 1 || events.some(event => event.planSha256 !== digest)
      || created[0].identity !== records[0].identity || !GID('Product', created[0].productId)
      || !GID('ProductVariant', created[0].variantId) || !GID('MediaImage', created[0].mediaId)
      || stopped?.status !== 'stopped_review_required' || (!metadataOnly && !transportDraft && !createdThenStopped)) fail('listing_draft_resume_not_safe');
    resumedDraft = { ...created[0], requests,
      confirmedCollections: events.slice(createdAt + 1).filter(event => event.status === 'addToCollection_response_received'
        || event.status === 'verified_after_transport_failure' && event.operation === 'addToCollection').map(event => event.collectionId) };
    if (queueAuthorization) {
      const row = records[0], receiptFile = receiptPath(row);
      if (!existsSync(receiptFile)) fail('queue_policy_draft_receipt_required');
      const receiptBytes = readFileSync(localPath(receiptFile));
      let receipt;
      try { receipt = receiptBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)); }
      catch { fail('queue_policy_draft_receipt_invalid'); }
      const allowed = new Set(['preflight_verified', 'stage_requested', 'stage_response_received', 'image_uploaded',
        'create_requested', 'create_response_received', 'draft_created', 'variant_requested', 'variant_response_received',
        'addToCollection_requested', 'addToCollection_response_received', 'retry_after_verified_old_state',
        'verified_after_transport_failure', 'stopped_review_required']);
      const sameIds = event => event.identity === row.identity && ['productId', 'variantId', 'mediaId'].every(key => event[key] === resumedDraft[key]);
      const creates = events.filter(event => event.status === 'create_requested');
      const responses = events.filter(event => event.status === 'create_response_received');
      if (receipt.length !== 2 || receipt[0].status !== 'create_requested' || receipt[0].identity !== row.identity
        || receipt[0].planSha256 !== digest || !same(receipt[0].authorization, queueAuthorization.authorization)
        || receipt[1].status !== 'draft_created' || !sameIds(receipt[1])
        || events.some(event => !allowed.has(event.status) || !same(event.authorization, queueAuthorization.authorization)
          || event.identity !== undefined && event.identity !== row.identity
          || ['productId', 'variantId', 'mediaId'].some(key => event[key] !== undefined && event[key] !== resumedDraft[key])
          || event.operation !== undefined && !['variant', 'addToCollection'].includes(event.operation))
        || creates.length !== 1 || responses.length !== 1 || events.indexOf(creates[0]) >= events.indexOf(responses[0])
        || events.indexOf(responses[0]) >= createdAt || stopped.completed !== 0
        || events.filter(event => event.status === 'image_uploaded' && event.imageSha256 === row.image.sha256).length !== 1) {
        fail('queue_policy_draft_receipt_invalid');
      }
      queueResumeEvidence = [{ path: localPath(resumeDraftJournal), sha256: sha256(resumeJournalBytes) },
        { path: localPath(receiptFile), sha256: sha256(receiptBytes) }];
    }
  }
  const guardQueueResume = () => {
    guardResolution();
    if (queueResumeEvidence.some(file => sha256(readFileSync(localPath(file.path))) !== file.sha256)) fail('queue_policy_draft_evidence_changed');
  };
  if (client?.store !== STORE || typeof client.execute !== 'function') fail('listing_client_store_mismatch');
  if (!Number.isInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 24) fail('invalid_listing_poll_limit');
  evidenceVerifier(plan, records, currentTime());
  const out = localPath(outputDir, { mustExist: false });
  if (existsSync(out)) fail('listing_output_exists_review_journal');
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const journalPath = join(out, 'journal.jsonl'), lockPath = join(PROJECT, 'output', 'listing-create.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  let lock;
  try { lock = openSync(lockPath, 'wx'); } catch { fail('listing_create_locked'); }
  const journal = (status, values = {}) => appendFileSync(journalPath,
    `${JSON.stringify({ at: currentTime().toISOString(), planSha256: digest,
      ...(queueAuthorization ? { authorization: queueAuthorization.authorization } : {}), status, ...values })}\n`, { encoding: 'utf8', flush: true });
  const mappings = [], v9 = [], ownedProducts = new Set();
  const read = (row) => client.execute('verify', { identifier: { handle: row.handle } });
  const mutate = async (operation, variables, event, recovery) => {
    const row = records.find(item => item.identity === event.identity);
    const metadataRetry = ['variant', 'addToCollection'].includes(operation)
      && recovery?.before?.status === 'DRAFT' && ownedProducts.has(event.productId);
    const retryDelays = [5000, 15000], maxAttempts = metadataRetry ? retryDelays.length + 1 : 2;
    const mutationGuard = () => {
      if (event.identity && (!row || listingPrice(row.quote, row.identity, currentTime(), { pricingModel: plan.pricing?.pricingModel }).price !== row.fields.price)) fail('listing_fresh_price_required');
      if (queueAuthorization) {
        queueAuthorization.guard({ now: currentTime() });
        if (!row || !['stage', 'create', 'variant', 'addToCollection', 'activate', 'publish'].includes(operation)) fail('queue_policy_operation_not_allowed');
        if (resumedDraft && ['stage', 'create'].includes(operation)) fail('queue_policy_resume_create_forbidden');
        evidenceVerifier(plan, [row], currentTime());
        guardQueueResume();
        guardAbsentRetry();
      }
    };
    const reconcile = async () => {
      if (!recovery || !ownedProducts.has(event.productId)) fail('listing_product_not_owned');
      if (metadataRetry) mutationGuard();
      const { before, variantId, mediaId } = recovery;
      const data = await read(row), status = data?.productByIdentifier?.status;
      if (metadataRetry) mutationGuard();
      if (!(operation === 'activate' ? ['DRAFT', 'ACTIVE'] : [before.status]).includes(status)) fail('listing_recovery_state_drift');
      const product = productRead(data, row, event.productId, status);
      const ids = value => value.collections.nodes.filter(item => typeof item.ruleSet?.appliedDisjunctively !== 'boolean').map(item => item.id).sort();
      if (!same(product.media.nodes, before.media.nodes)) fail('listing_recovery_state_drift');
      if (operation === 'variant') {
        publications(product, []);
        if (!same(ids(product), ids(before)) || product.onlineStoreUrl !== before.onlineStoreUrl) fail('listing_recovery_state_drift');
        if (variantConfigured(product, row, variantId, mediaId)) return { done: true, product };
        if (!same(product.variants.nodes, before.variants.nodes)) fail('listing_recovery_state_drift');
        return { done: false, product };
      }
      displayOnlyRead(product, row, variantId, mediaId);
      if (!same(product.variants.nodes, before.variants.nodes)) fail('listing_recovery_state_drift');
      const collectionIds = ids(product), oldIds = ids(before);
      if (operation === 'addToCollection') {
        publications(product, []);
        if (product.onlineStoreUrl !== before.onlineStoreUrl) fail('listing_recovery_state_drift');
        if (same(collectionIds, [...new Set([...oldIds, event.collectionId])].sort())) return { done: true, product };
        if (!same(collectionIds, oldIds)) fail('listing_recovery_state_drift');
        return { done: false, product };
      }
      if (!same(collectionIds, oldIds)) fail('listing_recovery_state_drift');
      if (operation === 'activate') {
        publications(product, []);
        if (product.onlineStoreUrl !== before.onlineStoreUrl) fail('listing_recovery_state_drift');
        return { done: status === 'ACTIVE', product };
      }
      if (operation !== 'publish') fail('listing_recovery_operation_not_allowed');
      const published = product.resourcePublicationsV2.nodes.some(item => item.isPublished === true);
      publications(product, published ? [PUBLICATION] : []);
      if (published ? typeof product.onlineStoreUrl !== 'string' || !product.onlineStoreUrl.startsWith('https:')
        : product.onlineStoreUrl !== before.onlineStoreUrl) fail('listing_recovery_state_drift');
      return { done: published, product };
    };
    const recoveredResult = checked => {
      journal('verified_after_transport_failure', { operation, ...event });
      const field = { variant: 'productVariantsBulkUpdate', addToCollection: 'collectionAddProducts', activate: 'productUpdate', publish: 'publishablePublish' }[operation];
      return { [field]: { userErrors: [], product: checked.product, productVariants: checked.product.variants.nodes,
        ...(operation === 'addToCollection' ? { collection: { id: event.collectionId } } : {}) } };
    };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      mutationGuard();
      if (attempt && metadataRetry) {
        const checked = await reconcile();
        if (checked.done) return recoveredResult(checked);
      }
      if (queueAuthorization) {
        if (operation === 'create') {
          const event = { status: 'create_requested', identity: row.identity, at: currentTime().toISOString(),
            planSha256: digest, authorization: queueAuthorization.authorization };
          if (absentRetry) {
            guardAbsentRetry(true);
            if ((await read(row))?.productByIdentifier !== null) fail('listing_absent_create_no_longer_absent');
            queueAuthorization.guard({ now: currentTime() }); evidenceVerifier(plan, [row], currentTime()); guardAbsentRetry(true);
            const receipt = readFileSync(localPath(absentRetry.retryReceiptPath), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
            if (receipt.length !== 1 || receipt[0].status !== 'retry_reserved') fail('listing_absent_create_retry_consumed');
            appendRetryReceipt(event);
          } else {
            mkdirSync(queueAuthorization.receiptDirectory, { recursive: true });
            const receipt = localPath(receiptPath(row), { mustExist: false });
            try { writeFileSync(receipt, JSON.stringify(event) + '\n', { flag: 'wx', encoding: 'utf8', flush: true }); }
            catch (error) { fail(error.code === 'EEXIST' ? 'queue_policy_creation_already_attempted' : 'queue_policy_receipt_write_failed'); }
          }
        }
      }
      journal(`${operation}_requested`, { ...event, ...(attempt ? { retry: attempt } : {}) });
      let result;
      try { result = await client.execute(operation, variables, { allowMutations: true }); }
      catch (error) {
        if (error.code !== 'listing_cli_result_unknown' || !recovery || !ownedProducts.has(event.productId)
          || !['variant', 'addToCollection', 'activate', 'publish'].includes(operation)) throw error;
        const checked = await reconcile();
        if (checked.done) return recoveredResult(checked);
        if (attempt + 1 >= maxAttempts || metadataRetry && error.retryableTransport !== true) throw error;
        journal('retry_after_verified_old_state', { operation, ...event });
        if (metadataRetry) await sleep(retryDelays[attempt]);
        continue;
      }
      journal(`${operation}_response_received`, event);
      if (attempt && !(await reconcile()).done) fail('listing_recovery_target_not_reached');
      return result;
    }
  };
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, planSha256: digest, startedAt: currentTime().toISOString() }));
    if (prepared.refreshedQuotes) journal('refreshed_quotes_verified', { ...prepared.refreshedQuotes,
      quotes: records.map(row => ({ identity: row.identity, observedAt: row.quote.observedAt,
        amountCny: row.quote.amountCny, approvedPrice: row.fields.price })) });
    const preflights = [];
    for (const row of records) {
      const result = await client.execute('preflight', { handle: row.handle, collectionHandle: COLLECTION_HANDLE, collectionIds: COLLECTIONS });
      if (result.shop?.currencyCode !== 'USD') fail('listing_store_currency_mismatch');
      if (resumedDraft ? result.productByIdentifier?.id !== resumedDraft.productId
        || result.productByIdentifier?.handle !== row.handle : result.productByIdentifier !== null) fail('listing_handle_already_exists');
      if (!Array.isArray(result.nodes) || result.nodes.length !== 2 || COLLECTIONS.some(id => !result.nodes.some(item => item?.id === id))) fail('listing_collection_missing');
      const collection = result.collectionByHandle;
      if (queueAuthorization && (collection?.id !== queueAuthorization.policy.existingCollectionId
        || result.nodes.some(item => item.ruleSet !== null))) fail('queue_policy_existing_collection_required');
      if (collection !== null && (!GID('Collection', collection.id) || collection.handle !== COLLECTION_HANDLE
        || collection.title !== plan.collection.title || collection.ruleSet !== null)) fail('listing_collection_handle_conflict');
      preflights.push(result);
    }
    if (preflights.some(result => !same(result.collectionByHandle, preflights[0].collectionByHandle))) fail('listing_collection_changed_during_preflight');
    journal('preflight_verified', { count: records.length, ...(prepared.queueQuoteRefresh ? {
      queueQuoteRefresh: prepared.queueQuoteRefresh, quotes: records.map(row => ({ identity: row.identity,
        observedAt: row.quote.observedAt, amountCny: row.quote.amountCny, approvedPrice: row.fields.price })) } : {}) });
    let collection = preflights[0].collectionByHandle;
    if (resumedDraft && (!collection || resumedDraft.requests.some(event => event.collectionId
      && ![...COLLECTIONS, collection.id].includes(event.collectionId)))) fail('listing_draft_resume_not_safe');
    if (!collection) {
      collection = payload(await mutate('createCollection', { input: { title: plan.collection.title, handle: COLLECTION_HANDLE } }, {}), 'collectionCreate').collection;
      if (!GID('Collection', collection?.id) || collection.handle !== COLLECTION_HANDLE || collection.title !== plan.collection.title) fail('listing_collection_create_result_unknown');
      journal('collection_created', { collectionId: collection.id });
      payload(await mutate('publish', { id: collection.id, input: [{ publicationId: PUBLICATION }] }, { collectionId: collection.id }), 'publishablePublish');
    }
    const collectionCheck = (await client.execute('verifyCollection', { handle: COLLECTION_HANDLE })).collectionByHandle;
    if (collectionCheck?.id !== collection.id || collectionCheck.handle !== COLLECTION_HANDLE || collectionCheck.title !== plan.collection.title
      || collectionCheck.ruleSet !== null || collectionCheck.resourcePublicationsV2?.pageInfo?.hasNextPage !== false
      || !same(collectionCheck.resourcePublicationsV2.nodes.filter(item => item.isPublished === true).map(item => item.publication?.id), [PUBLICATION])) fail('listing_collection_publication_unverified');
    for (const [index, row] of records.entries()) {
      // Recheck price immediately before creating a purchasable entity, including long batches crossing midnight.
      if (listingPrice(row.quote, row.identity, currentTime(), { pricingModel: plan.pricing?.pricingModel }).price !== row.fields.price) fail('listing_fresh_price_required');
      const checked = await client.execute('preflight', { handle: row.handle, collectionHandle: COLLECTION_HANDLE, collectionIds: COLLECTIONS });
      let productId, variantId, mediaId;
      if (resumedDraft) {
        if (checked.productByIdentifier?.id !== resumedDraft.productId || checked.productByIdentifier?.handle !== row.handle) fail('listing_handle_already_exists');
        ({ productId, variantId, mediaId } = resumedDraft);
        const draft = productRead(await read(row), row, productId, 'DRAFT'); publications(draft, []);
        if (draft.variants.nodes[0].id !== variantId || draft.media.nodes[0].id !== mediaId) fail('listing_draft_resume_not_safe');
        if (resolvedDraft) {
          guardResolution(); queueAuthorization.guard({ now: currentTime() }); evidenceVerifier(plan, [row], currentTime());
          resolutionReservation = reserveCreatedDraftResolution({ inspected: resolvedDraft, liveData: { productByIdentifier: draft }, now: currentTime() });
          journal('unknown_create_draft_resolved_after_review', { identity: row.identity, productId, variantId, mediaId,
            resolution: resolvedDraft.resolutionBinding });
        }
        if (resumedDraft.unknownCreateWitness) {
          pristineCreatedDraft(draft, row, variantId, mediaId);
          if (!same(draft.media.nodes, resumedDraft.snapshot.media.nodes)) fail('listing_unknown_create_evidence_mismatch');
          journal('unknown_create_draft_verified_after_review', { identity: row.identity, productId, variantId, mediaId,
            witness: resumedDraft.unknownCreateWitness });
        }
        const allowedCollections = [...COLLECTIONS, collection.id], memberships = draft.collections.nodes.map(item => item.id);
        if (new Set(memberships).size !== memberships.length || draft.collections.nodes.some(item => !allowedCollections.includes(item.id)
          && typeof item.ruleSet?.appliedDisjunctively !== 'boolean')
          || resumedDraft.confirmedCollections.some(id => !memberships.includes(id))) fail('listing_draft_resume_collection_drift');
        journal('draft_resumed_after_readback', { identity: row.identity, productId, variantId, mediaId });
      } else {
        if (checked.productByIdentifier !== null) fail('listing_handle_already_exists');
        if (absentRetry) {
          queueAuthorization.guard({ now: currentTime() }); evidenceVerifier(plan, [row], currentTime()); guardAbsentRetry(true);
          if ((await read(row))?.productByIdentifier !== null) fail('listing_absent_create_no_longer_absent');
          guardAbsentRetry(true);
          const retryPath = localPath(absentRetry.retryReceiptPath, { mustExist: false });
          mkdirSync(dirname(retryPath), { recursive: true });
          const reservation = { status: 'retry_reserved', identity: row.identity, planSha256: digest,
            authorization: queueAuthorization.authorization, at: currentTime().toISOString(),
            witness: absentRetry.witnessBinding, originalReceipt: absentRetry.witness.originalReceipt };
          try { writeFileSync(retryPath, JSON.stringify(reservation) + '\n', { flag: 'wx', encoding: 'utf8', flush: true }); }
          catch { fail('listing_absent_create_retry_consumed'); }
          retryReceiptSha256 = sha256(readFileSync(retryPath));
          journal('absent_create_retry_reviewed', { identity: row.identity, witness: absentRetry.witnessBinding });
        }
        const image = imageBytes(row.image), filename = `${row.sourceUuid}.${image.extension}`;
        const targets = payload(await mutate('stage', { input: [{ resource: 'IMAGE', filename, mimeType: image.mimeType,
          httpMethod: 'POST', fileSize: String(image.bytes.length) }] }, { identity: row.identity, imageSha256: row.image.sha256 }), 'stagedUploadsCreate').stagedTargets;
        if (!Array.isArray(targets) || targets.length !== 1) fail('invalid_staged_upload_target');
        if (queueAuthorization) queueAuthorization.guard({ now: currentTime() });
        const resourceUrl = await upload(targets[0], image, filename, { guard: () => {
          if (queueAuthorization) queueAuthorization.guard({ now: currentTime() });
          if (queueAuthorization && !absentRetry && existsSync(receiptPath(row))) fail('queue_policy_creation_already_attempted');
          if (listingPrice(row.quote, row.identity, currentTime(), { pricingModel: plan.pricing?.pricingModel }).price !== row.fields.price) fail('listing_fresh_price_required');
          evidenceVerifier(plan, [row], currentTime());
          guardQueueResume();
          guardAbsentRetry(true);
        } });
        journal('image_uploaded', { identity: row.identity, imageSha256: row.image.sha256 });
        const productInput = Object.fromEntries(['title', 'descriptionHtml', 'vendor', 'productType', 'category', 'tags'].map(key => [key, row.fields[key]]));
        const created = payload(await mutate('create', { product: { ...productInput, handle: row.handle, status: 'DRAFT' },
          media: [{ originalSource: resourceUrl, mediaContentType: 'IMAGE', alt: row.title }] }, { identity: row.identity }), 'productCreate').product;
        if (!GID('Product', created?.id) || created.handle !== row.handle || created.status !== 'DRAFT'
          || created.variants?.nodes?.length !== 1 || !GID('ProductVariant', created.variants.nodes[0].id)
          || created.media?.nodes?.length !== 1 || !GID('MediaImage', created.media.nodes[0].id)) fail('listing_product_create_result_unknown');
        productId = created.id; variantId = created.variants.nodes[0].id; mediaId = created.media.nodes[0].id;
        journal('draft_created', { identity: row.identity, productId, variantId, mediaId });
        if (queueAuthorization) {
          const event = { status: 'draft_created', at: currentTime().toISOString(), identity: row.identity, productId, variantId, mediaId };
          if (absentRetry) appendRetryReceipt(event);
          else appendFileSync(localPath(receiptPath(row)), JSON.stringify(event) + '\n', { flush: true });
        }
      }
      if (ownedProducts.has(productId)) fail('duplicate_created_product');
      ownedProducts.add(productId);
      let product;
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        product = productRead(await read(row), row, productId, 'DRAFT'); publications(product, []);
        const media = product.media.nodes[0];
        if (media.id !== mediaId || media.status === 'FAILED') fail('listing_media_processing_failed');
        if (media.status === 'READY' && media.image?.id) break;
        if (attempt === pollAttempts - 1) fail('listing_media_not_ready');
        await sleep(2500);
      }
      if (!ownedProducts.has(productId)) fail('listing_product_not_owned');
      const configured = variantConfigured(product, row, variantId, mediaId);
      if (resumedDraft?.requests.at(-1)?.status === 'addToCollection_requested' && !configured) fail('listing_draft_variant_drift');
      const recovery = () => ({ before: structuredClone(product), variantId, mediaId });
      if (!configured) {
        payload(await mutate('variant', { productId, variants: [{ id: variantId, price: row.fields.price,
          inventoryPolicy: 'DENY', inventoryItem: { sku: row.sku, tracked: true }, mediaId }] }, { identity: row.identity, productId, variantId }, recovery()), 'productVariantsBulkUpdate');
      } else journal('variant_already_configured', { identity: row.identity, productId, variantId });
      product = productRead(await read(row), row, productId, 'DRAFT'); displayOnlyRead(product, row, variantId, mediaId); publications(product, []);
      const collections = [...preflights[index].nodes, { id: collection.id, ruleSet: null }];
      for (const target of collections) {
        if (target.ruleSet !== null) continue;
        if (product.collections.nodes.some(item => item.id === target.id)) {
          journal('collection_membership_already_present', { identity: row.identity, productId, collectionId: target.id }); continue;
        }
        const added = payload(await mutate('addToCollection', { id: target.id, productIds: [productId] },
          { identity: row.identity, productId, collectionId: target.id }, recovery()), 'collectionAddProducts');
        if (added.collection?.id !== target.id) fail('listing_membership_result_unknown');
        product = productRead(await read(row), row, productId, 'DRAFT'); displayOnlyRead(product, row, variantId, mediaId); publications(product, []);
      }
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        product = productRead(await read(row), row, productId, 'DRAFT'); displayOnlyRead(product, row, variantId, mediaId); publications(product, []);
        if (collections.every(target => product.collections.nodes.some(item => item.id === target.id))) break;
        if (attempt === pollAttempts - 1) fail('listing_collection_membership_unverified');
        await sleep(2500);
      }
      journal('draft_verified_not_for_sale', { identity: row.identity, productId, variantId, mediaId });
      payload(await mutate('activate', { product: { id: productId, status: 'ACTIVE' } }, { identity: row.identity, productId }, recovery()), 'productUpdate');
      product = productRead(await read(row), row, productId, 'ACTIVE'); displayOnlyRead(product, row, variantId, mediaId); publications(product, []);
      payload(await mutate('publish', { id: productId, input: [{ publicationId: PUBLICATION }] }, { identity: row.identity, productId }, recovery()), 'publishablePublish');
      product = productRead(await read(row), row, productId, 'ACTIVE');
      const final = displayOnlyRead(product, row, variantId, mediaId); publications(product, [PUBLICATION]);
      if (!collections.every(target => product.collections.nodes.some(item => item.id === target.id))
        || typeof product.onlineStoreUrl !== 'string' || !product.onlineStoreUrl.startsWith('https://')) fail('listing_final_readback_failed');
      if (records.length === 1) writeFileSync(join(out, 'final-readback.json'), JSON.stringify({ productByIdentifier: product }, null, 2) + '\n', { flag: 'wx' });
      const imageUrl = publicImageUrl(final.media.image.url);
      mappings.push({ identity: row.identity, productGid: productId, variantGid: variantId, sku: row.sku, enabled: true,
        sourceUuid: row.sourceUuid, language: row.language, setId: row.setId });
      v9.push({ identity: row.identity, handle: row.handle, productHandle: row.handle, sku: row.sku, sourceUuid: row.sourceUuid,
        setId: row.setId, title: row.title, productId, variantId, mediaId,
        imageId: final.variant.image.id, imageSourceId: final.media.image.id,
        imageUrl, imageURL: imageUrl, productUrl: product.onlineStoreUrl, price: row.fields.price,
        availableForSale: false, inventoryTracked: true, inventoryPolicy: 'DENY', cardNumber: row.cardNumber, language: row.language,
        collectionId: collection.id, imageSourceKind: row.image.sourceKind, originalImage: row.image.originalImage });
      writeFileSync(join(out, 'mapping-candidates.json'), JSON.stringify(mappings, null, 2) + '\n');
      writeFileSync(join(out, 'v9-verified-products.json'), JSON.stringify({ kind: 'verified_display_only_pokemon_products',
        planSha256: digest, store: STORE, collectionId: collection.id, products: v9 }, null, 2) + '\n');
      journal('product_completed', { identity: row.identity, productId, variantId, mediaId });
      if (queueAuthorization) {
        guardQueueResume();
        const event = { status: 'product_completed', at: currentTime().toISOString(), identity: row.identity, productId, variantId, mediaId };
        if (resolutionReservation) resolutionReservation.complete({ productId, variantId, mediaId, now: currentTime() });
        else if (absentRetry) appendRetryReceipt(event);
        else appendFileSync(localPath(receiptPath(row)), JSON.stringify(event) + '\n', { flush: true });
      }
    }
    journal('completed', { count: mappings.length });
    return { status: 'completed', count: mappings.length, planSha256: digest, outputDir: out, mappings, products: v9 };
  } catch (error) {
    const reason = /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'listing_execution_stopped';
    journal('stopped_review_required', { reason, completed: mappings.length,
      ...(error.transport ? { transport: error.transport } : {}), ...(error.validation ? { validation: error.validation } : {}) });
    fail(reason);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
