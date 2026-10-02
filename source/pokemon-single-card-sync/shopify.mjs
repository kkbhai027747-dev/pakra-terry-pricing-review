import { createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const LISTED_VARIANTS_QUERY = `query ListedVariants($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    ... on ProductVariant { id sku price product { id title status onlineStoreUrl } }
  }
}`;

export const UPDATE_PRICES_MUTATION = `mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id sku price product { id title status onlineStoreUrl } }
    userErrors { field message }
  }
}`;

function storeDomain(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new Error('Expected the exact lowercase myshopify.com store domain.');
  }
  return value;
}

function locateCli(cliPath) {
  if (cliPath) return cliPath;
  if (process.platform !== 'win32') return 'shopify';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'shopify.ps1');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Official Shopify CLI was not found on PATH.');
}

function cliEnvironment() {
  // Credentials and flag overrides must never come from environment variables.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^SHOPIFY_/i.test(key)));
  return { ...environment, CI: '1', SHOPIFY_CLI_AGENT_INFO: 'n:Codex|v:1|p:OpenAI', SHOPIFY_CLI_AGENT_IDS: 'r:pokemon-single-card-sync|i:shopify-client' };
}

const SPAWN_CODES = new Set(['ETIMEDOUT', 'EACCES', 'EPERM', 'ENOENT', 'ENOBUFS', 'ENOMEM', 'E2BIG']);
const TRANSPORT_CATEGORIES = new Set(['authentication', 'permission', 'network', 'rate_limit']);
function safeTransport(value) {
  return { exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null,
    spawnErrorCode: SPAWN_CODES.has(value?.spawnErrorCode) ? value.spawnErrorCode : null,
    outputFileExists: value?.outputFileExists === true,
    categories: [...new Set(Array.isArray(value?.categories) ? value.categories.filter(category => TRANSPORT_CATEGORIES.has(category)) : [])] };
}
function cliFailure(message, code, result, outputFileExists, response) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${JSON.stringify(response ?? null)}`;
  const categories = [];
  if (/UNAUTHORIZED|UNAUTHENTICATED|AUTHENTICATION|NOT LOGGED IN|STATUS\s*401/i.test(text)) categories.push('authentication');
  if (/ACCESS DENIED|FORBIDDEN|REQUIRED.*SCOPES?|ACCESS SCOPES?|STATUS\s*403/i.test(text)
    || ['EACCES', 'EPERM'].includes(result.error?.code)) categories.push('permission');
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|FETCH FAILED|SOCKET HANG UP|CONNECTION CLOSED|NETWORK ERROR|TIMED OUT|STATUS\s*50[0234]/i.test(text)
    || result.error?.code === 'ETIMEDOUT') categories.push('network');
  if (/THROTTL|RATE LIMIT|TOO MANY REQUESTS|STATUS\s*429/i.test(text)) categories.push('rate_limit');
  return Object.assign(new Error(message), { code, transport: safeTransport({ exitCode: result.status,
    spawnErrorCode: result.error?.code, outputFileExists, categories }) });
}

export class ShopifyClient {
  constructor({ store, cliPath, runner = spawnSync } = {}) {
    this.store = storeDomain(store);
    this.cliPath = locateCli(cliPath);
    if (typeof runner !== 'function') throw new Error('CLI runner must be a function.');
    this.runner = runner;
  }

  async execute(query, variables, { allowMutations = false } = {}) {
    const mutation = query === UPDATE_PRICES_MUTATION;
    if (query !== LISTED_VARIANTS_QUERY && !mutation) throw new Error('This client only supports mapped product reads and variant price updates.');
    if (mutation !== allowMutations) throw new Error('Mutation permission does not match the operation.');
    if (/\.(?:cmd|bat)$/i.test(this.cliPath)) throw new Error('Use the official shopify.ps1 launcher on Windows.');

    const temporaryRoot = resolve(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, 'pokemon-shopify-'));
    try {
      const queryPath = join(directory, 'operation.graphql');
      const variablesPath = join(directory, 'variables.json');
      const outputPath = join(directory, 'result.json');
      writeFileSync(queryPath, query, 'utf8');
      writeFileSync(variablesPath, JSON.stringify(variables), 'utf8');
      const args = ['store', 'execute', '--store', this.store, '--query-file', queryPath,
        '--variable-file', variablesPath, '--version', '2026-07', '--json', '--no-color', '--output-file', outputPath];
      if (mutation) args.push('--allow-mutations');
      const powershell = /\.ps1$/i.test(this.cliPath);
      for (let attempt = 0; attempt < (mutation ? 1 : 2); attempt += 1) {
        if (existsSync(outputPath)) unlinkSync(outputPath);
        let result;
        try {
          result = this.runner(powershell ? 'powershell.exe' : this.cliPath,
            powershell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.cliPath, ...args] : args,
            { shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: cliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) { result = { status: null, error: { code: error.code } }; }
        const outputFileExists = existsSync(outputPath);
        let response, failure;
        if (result.error || result.status !== 0 || !outputFileExists) {
          failure = cliFailure('Shopify CLI execution failed; no authentication or scope changes were attempted.',
            'shopify_cli_execution_failed', result, outputFileExists);
        } else {
          try { response = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')); }
          catch { failure = cliFailure('Shopify CLI returned invalid JSON.', 'shopify_cli_invalid_json', result, outputFileExists); }
          if (!failure && (response?.errors?.length || response?.error)) {
            failure = cliFailure('Shopify reported an API error; no further price updates were attempted.',
              'shopify_api_error', result, outputFileExists, response);
          }
        }
        if (!failure) return response?.data ?? response;
        if (!mutation && attempt === 0 && !failure.transport.categories.some(category => ['authentication', 'permission'].includes(category))) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw failure;
      }
    } finally {
      const childPath = relative(temporaryRoot, resolve(directory));
      if (!childPath || childPath.startsWith(`..${sep}`) || childPath === '..' || isAbsolute(childPath)) {
        throw new Error('Refused to remove a temporary directory outside the expected root.');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Mapping must be an array.');
  const variants = new Set();
  const identities = new Set();
  for (const row of rows) {
    if (!row || typeof row.identity !== 'string' || !row.identity.trim()
      || !/^gid:\/\/shopify\/Product\/\d+$/.test(row.productGid)
      || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(row.variantGid)
      || typeof row.sku !== 'string' || !row.sku.trim()) throw new Error('Mapping requires identity, productGid, variantGid, and a nonempty exact SKU.');
    if (variants.has(row.variantGid) || identities.has(row.identity)) throw new Error('Duplicate mapped variant ID or identity.');
    variants.add(row.variantGid);
    identities.add(row.identity);
  }
}

export async function readListedVariants(client, mapping) {
  if (!Array.isArray(mapping)) throw new Error('Mapping must be an array.');
  const rows = mapping.filter(row => row?.enabled === true);
  validateRows(rows);
  const products = new Map();
  let currencyCode;
  // An empty mapping still reads shop currency without enumerating the catalog.
  for (let offset = 0; offset < Math.max(rows.length, 1); offset += 250) {
    const ids = rows.slice(offset, offset + 250).map(row => row.variantGid);
    const result = await client.execute(LISTED_VARIANTS_QUERY, { ids });
    if (!result || typeof result.shop?.currencyCode !== 'string' || !Array.isArray(result.nodes)) throw new Error('Shopify product-read response is incomplete.');
    if (currencyCode && currencyCode !== result.shop.currencyCode) throw new Error('Shop currency changed during the read.');
    currencyCode = result.shop.currencyCode;
    const requested = new Set(ids);
    const seen = new Set();
    for (const variant of result.nodes) {
      if (variant === null) continue;
      if (!variant || !requested.has(variant.id) || seen.has(variant.id) || !variant.product?.id) throw new Error('Shopify returned an unexpected or duplicate variant.');
      seen.add(variant.id);
      const { product, id, sku, price } = variant;
      let item = products.get(product.id);
      if (!item) {
        item = { id: product.id, title: product.title, status: product.status, onlineStoreUrl: product.onlineStoreUrl, variants: [] };
        products.set(product.id, item);
      } else if (item.status !== product.status || item.onlineStoreUrl !== product.onlineStoreUrl) {
        throw new Error('Product publication changed during the read.');
      }
      item.variants.push({ id, sku, price });
    }
  }
  return { currencyCode, products: [...products.values()] };
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Price plans must contain only JSON values.');
}

export function planDigest(plan) {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex');
}

function chinaDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`${field} must include an ISO date, time, and timezone.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} is invalid.`);
  return milliseconds;
}

function cents(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Prices must be positive USD values with at most two decimal places.');
  const [whole, fraction = ''] = String(value).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Price is outside the supported positive range.');
  return amount;
}

function priceString(value) {
  const amount = cents(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function validatePlan(client, plan, digest, approvedSha256, now) {
  if (typeof approvedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(approvedSha256)
    || !timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(approvedSha256, 'hex'))) throw new Error('Approval SHA-256 does not match this exact price plan.');
  if (plan.schemaVersion !== 1 || plan.store !== client.store || plan.currency !== 'USD') throw new Error('Price plan schema, target store, or USD currency does not match.');
  storeDomain(plan.store);
  if (!plan.pricingPolicy || !Array.isArray(plan.blocked) || plan.blocked.length) throw new Error('Price plan must contain a pricing policy and no unresolved blocked entries.');
  if (!Array.isArray(plan.changes)) throw new Error('Price plan changes must be an array.');
  validateRows(plan.changes);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.');
  const createdMs = timestamp(plan.createdAt, 'createdAt');
  if (plan.date !== chinaDate(now) || chinaDate(createdMs) !== plan.date || createdMs > nowMs || nowMs - createdMs > 4 * 60 * 60 * 1000) throw new Error('Price plan is stale, future-dated, or outside the current Asia/Shanghai day.');
  for (const change of plan.changes) {
    cents(change.oldPrice);
    cents(change.newPrice);
    const observedMs = timestamp(change.sourceObservedAt, 'sourceObservedAt');
    if (chinaDate(observedMs) !== plan.date || observedMs > createdMs) throw new Error('A source price is not from today or was observed after this plan was created.');
    if (nowMs - observedMs > 4 * 60 * 60 * 1000) throw new Error('A source price is stale; observations must be no older than four hours at apply time.');
  }
}

function matchLive(live, changes) {
  if (live.currencyCode !== 'USD') throw new Error('Shop currency must be USD.');
  const variants = new Map(live.products.flatMap(product => product.variants.map(variant => [variant.id, { product, variant }])));
  return changes.map(change => {
    const found = variants.get(change.variantGid);
    if (!found || found.product.id !== change.productGid || found.variant.sku !== change.sku) throw new Error('A variant is missing or its product/SKU mapping has changed.');
    if (found.product.status !== 'ACTIVE' || typeof found.product.onlineStoreUrl !== 'string' || !found.product.onlineStoreUrl.startsWith('https://')) throw new Error('A mapped product is not ACTIVE and listed on the online store.');
    const current = cents(found.variant.price);
    if (current === cents(change.newPrice)) return { change, alreadyApplied: true };
    if (current !== cents(change.oldPrice)) throw new Error('A live price has drifted from both the approved old and new prices.');
    return { change, alreadyApplied: false };
  });
}

export async function applyPricePlan(client, plan, approvedSha256, { now, journalPath = resolve('data', 'price-sync-journal.jsonl') } = {}) {
  plan = JSON.parse(canonicalJson(plan));
  const digest = planDigest(plan);
  const currentTime = () => now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  validatePlan(client, plan, digest, approvedSha256, currentTime());
  const path = resolve(journalPath);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = openSync(lockPath, 'wx'); }
  catch { throw new Error('Price-sync journal is locked or unavailable; review any interrupted run before retrying.'); }
  const journal = event => appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), digest, store: client.store, ...event })}\n`, { encoding: 'utf8', flush: true });
  let applied = 0;
  let alreadyApplied = 0;
  let groups = 0;
  try {
    const mapping = plan.changes.map(change => ({ ...change, enabled: true }));
    const checked = matchLive(await readListedVariants(client, mapping), plan.changes);
    const products = new Map();
    for (const item of checked) {
      if (item.alreadyApplied) { alreadyApplied += 1; continue; }
      const product = products.get(item.change.productGid) ?? [];
      product.push(item.change);
      products.set(item.change.productGid, product);
    }
    journal({ status: 'preflight-verified', count: plan.changes.length, alreadyApplied });
    for (const [productGid, changes] of products) {
      for (let offset = 0; offset < changes.length; offset += 100) {
        const batch = changes.slice(offset, offset + 100);
        const current = matchLive(await readListedVariants(client, batch.map(change => ({ ...change, enabled: true }))), batch);
        const pending = current.filter(item => !item.alreadyApplied).map(item => item.change);
        alreadyApplied += current.length - pending.length;
        if (!pending.length) continue;
        validatePlan(client, plan, digest, approvedSha256, currentTime());
        const details = { productGid, changes: pending.map(({ variantGid, sku, oldPrice, newPrice }) => ({ variantGid, sku, oldPrice, newPrice })) };
        journal({ status: 'mutating', ...details });
        let rejected = false, stage = 'mutation';
        try {
          const result = await client.execute(UPDATE_PRICES_MUTATION, {
            productId: productGid,
            variants: pending.map(change => ({ id: change.variantGid, price: priceString(change.newPrice) })),
          }, { allowMutations: true });
          const payload = result?.productVariantsBulkUpdate;
          if (!payload || !Array.isArray(payload.userErrors) || !Array.isArray(payload.productVariants)) throw new Error('Incomplete mutation response.');
          if (payload.userErrors.length) { rejected = payload.productVariants.length === 0; throw new Error('Mutation rejected.'); }
          if (payload.productVariants.length !== pending.length) throw new Error('Incomplete mutation result.');
          const returned = new Map(payload.productVariants.map(variant => [variant.id, variant]));
          if (returned.size !== pending.length || pending.some(change => !returned.has(change.variantGid)
            || returned.get(change.variantGid).sku !== change.sku
            || returned.get(change.variantGid).product?.id !== productGid
            || cents(returned.get(change.variantGid).price) !== cents(change.newPrice))) throw new Error('Unexpected mutation result.');
          stage = 'readback';
          const verified = matchLive(await readListedVariants(client, pending.map(change => ({ ...change, enabled: true }))), pending);
          if (verified.some(item => !item.alreadyApplied)) throw new Error('Readback did not confirm all new prices.');
          journal({ status: 'verified', ...details });
          applied += pending.length;
          groups += 1;
        } catch (error) {
          const transport = error.transport ? safeTransport(error.transport) : undefined;
          journal({ status: rejected ? 'rejected' : 'uncertain', stage, ...(transport ? { transport } : {}), ...details });
          throw Object.assign(new Error(`Price sync stopped after ${applied} verified updates; the current group is ${rejected ? 'rejected' : 'uncertain'}. Review the journal and live prices before retrying.`),
            { stage, ...(transport ? { transport } : {}) });
        }
      }
    }
    journal({ status: 'complete', applied, alreadyApplied, groups });
    return { digest, applied, alreadyApplied, groups, journalPath: path };
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
