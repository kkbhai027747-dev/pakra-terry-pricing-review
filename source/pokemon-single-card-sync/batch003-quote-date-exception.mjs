import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = 'D:/CODEX/output/pokemon-margin40-listing-20260928';
const AUTH = path.join(ROOT, 'cross-midnight-batch003-candidate/authorization.json');
const AUTH_SHA = '68461e67f3feeda7347c2a87e057921d13730a0261eff327103db680aa5c5f92';
export const BATCH003_PLAN_SHA = '3d8f4d162ced1c4b4b03279f7df36ce75d8a6acc4166c2d0251609013dc1104e';
const MODEL = 'order_net_margin_40_fee_7';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error('batch003_quote_exception_invalid'), { code: 'batch003_quote_exception_invalid' }); };
const need = value => { if (!value) fail(); };
const date = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
function checked(binding) {
  need(binding && typeof binding.path === 'string' && path.isAbsolute(binding.path) && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''));
  const file = path.resolve(binding.path), relative = path.relative(ROOT, file);
  need(relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
  for (let cursor = file; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) need(!fs.lstatSync(cursor).isSymbolicLink());
  const bytes = fs.readFileSync(file); need(sha(bytes) === binding.sha256); return bytes;
}
function authorization(now) {
  const value = JSON.parse(checked({ path: AUTH, sha256: AUTH_SHA }).toString('utf8'));
  need(value.kind === 'one_off_batch003_quote_date_exception' && value.approved === true && value.batchNumber === 3
    && value.plan.sha256 === BATCH003_PLAN_SHA && value.pricingModel === MODEL && value.maxQuoteAgeHours === 4
    && value.createsAuthorization === false && value.extendsSession === false && value.changesEvidence === false
    && value.remaining.length === 3 && value.historicalVerificationOnly.length === 17);
  const time = new Date(now).getTime();
  need(Number.isFinite(time) && time >= Date.parse(value.recordedAt)
    && value.session.deadlineAt === '2026-09-29T16:25:11.133Z');
  [value.plan, value.policy, value.queue, ...value.bindings].forEach(checked);
  return value;
}

// This function grants only a calendar-date exception, never a quote-age or write authorization exception.
export function allowsBatch003DateException(quote, identity, now, pricingModel) {
  if (pricingModel !== MODEL || !['pokemon:en:100236:01a0900a-9bc0-7ef9-a804-2a51216146f6',
    'pokemon:en:100236:01a0900a-9e15-799e-9e99-2ccd713a3581',
    'pokemon:en:100236:01a0900a-a0e0-7c43-98fb-31933d80e209'].includes(identity)) return false;
  const value = authorization(now), row = value.remaining.find(item => item.identity === identity);
  const age = new Date(now).getTime() - Date.parse(quote?.observedAt);
  return row.quoteSha256 === sha(JSON.stringify(quote)) && age >= 0 && age <= 4 * 3600000
    && date(new Date(quote.observedAt)) === value.sourceShanghaiDate && date(new Date(now)) === value.allowedShanghaiDate;
}

// Historical verification is restricted to the immutable completed seventeen; listing executors never set this option.
export function hasBatch003HistoricalEvidence(quote, identity, now, planSha256) {
  if (planSha256 !== BATCH003_PLAN_SHA) return false;
  const value = authorization(now), row = value.historicalVerificationOnly.find(item => item.identity === identity);
  return Boolean(row && row.quoteSha256 === sha(JSON.stringify(quote)));
}
