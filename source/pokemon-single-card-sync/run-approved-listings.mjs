import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executeListingPlan, ListingShopifyClient } from './listing-shopify.mjs';

const { values } = parseArgs({ strict: true, options: {
  approval: { type: 'string' }, output: { type: 'string' }, phase: { type: 'string', default: 'canary' },
  canary: { type: 'string' }, 'resume-draft-journal': { type: 'string' }, completed: { type: 'string', multiple: true }, identity: { type: 'string' },
  'refreshed-quotes': { type: 'string' },
  'resume-created-draft-witness': { type: 'string' },
} });
if (!values.approval || !values.output || !['canary', 'remaining'].includes(values.phase)) throw new Error('invalid_execution_arguments');
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, ''));
const approval = read(values.approval);
if (approval.approved !== true || approval.userApproval !== '批准' || approval.identities.length !== 20) throw new Error('explicit_batch_approval_required');
let selected = approval;
if (values.phase === 'remaining') {
  const canary = read(values.canary);
  if (canary.kind !== 'verified_display_only_pokemon_products' || canary.planSha256 !== approval.planSha256
      || canary.products.length !== 1 || canary.products[0].identity !== approval.identities[0]
      || canary.products[0].availableForSale !== false) throw new Error('verified_canary_required');
  selected = { ...approval, identities: approval.identities.slice(1) };
  const completed = new Set();
  for (const path of values.completed ?? []) {
    const report = read(path);
    if (report.kind !== 'verified_display_only_pokemon_products' || report.planSha256 !== approval.planSha256
      || report.store !== 'egk2fq-va.myshopify.com' || !Array.isArray(report.products)) throw new Error('invalid_completed_readback');
    for (const product of report.products) {
      if (!selected.identities.includes(product.identity) || completed.has(product.identity)
        || product.availableForSale !== false || product.inventoryPolicy !== 'DENY' || product.inventoryTracked !== true)
        throw new Error('invalid_completed_product');
      completed.add(product.identity);
    }
  }
  selected.identities = selected.identities.filter(identity => !completed.has(identity));
  if (!selected.identities.length) throw new Error('no_uncompleted_approved_products');
}
if (values.identity) {
  if (!selected.identities.includes(values.identity)) throw new Error('identity_outside_approved_selection');
  selected = { ...selected, identities: [values.identity] };
}
const client = new ListingShopifyClient({ cliPath: 'C:\\Users\\JT\\AppData\\Roaming\\npm\\shopify.ps1' });
try {
  const result = await executeListingPlan({ client, planPath: approval.planPath, approval: selected,
    outputDir: resolve(values.output), limit: values.phase === 'canary' ? 1 : selected.identities.length,
    resumeDraftJournal: values['resume-draft-journal'], resumeCreatedDraftWitness: values['resume-created-draft-witness'],
    refreshedQuotesPath: values['refreshed-quotes'] });
  writeFileSync(resolve(values.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, count: result.count, outputDir: result.outputDir }));
} catch (error) {
  console.error(JSON.stringify({ status: 'stopped_review_required', reason: error.code || 'listing_execution_failed' }));
  process.exitCode = 1;
}
