import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson, save, withLock } from './files.mjs';
import { PublicSource, discover, collectSamples, publicSourceUrl } from './source.mjs';
import { importAppPack, importBatch } from './batch.mjs';
import { checkReadiness } from './doctor.mjs';
import { buildPricePlan } from './pricing.mjs';
import { ShopifyClient, readListedVariants, planDigest, applyPricePlan, validateRows as validateMappingRows } from './shopify.mjs';
import { verifyAppDailyQuotes } from './app-quotes.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HELP = `Pokemon single-card pipeline (Node 22+)
  node sync.mjs doctor                       Check background connection and missing prerequisites
  node sync.mjs discover                     Fetch verified public pack metadata and covers
  node sync.mjs samples                      Fetch ranking card-image candidates; incomplete and not prices
  node sync.mjs import-batch --input FILE     Import exact-pack API rows or a verified_app_pack manifest
  node sync.mjs daily --quotes FILE          Validate today's captured lowest-asking evidence; preview only
  node sync.mjs daily --app-run DIRECTORY [--procurement FILE]
                                            Reverify an App capture batch and preview mapped prices
  node sync.mjs apply --plan FILE --approved-sha256 SHA256
                                            Apply only a specifically approved price plan
  Optional: --config FILE

The full card-list and lowest-asking endpoints are not yet verified. The daily
command requires captured price evidence; it does not claim to scrape prices.
No Codex automation is used. Daily previews never apply prices automatically.`;

function review(plan) {
  const lines = ['# 商品价格变更预览', '', `店铺：${plan.store}；币种：${plan.currency}；日期：${plan.date}`,
    '', `审批摘要 SHA-256：\`${planDigest(plan)}\``, '',
    '| 对象 | 商品 ID | 变体 ID | 字段 | 原值 | 新值 | 预计影响 |',
    '|---|---|---|---|---:|---:|---|'];
  for (const row of plan.changes) lines.push(`| ProductVariant | ${row.productGid} | ${row.variantGid} | price | ${row.oldPrice} | ${row.newPrice} | 更新该已上架单卡售价 |`);
  lines.push('', `变更 ${plan.changes.length} 项；保持原价 ${plan.unchanged.length} 项；跳过 ${plan.skipped.length} 项；阻断 ${plan.blocked.length} 项。`,
    '', '本文件是预览，不表示已获批准或已写入。每份计划须由用户确认后才能执行 apply。');
  for (const row of plan.blocked) lines.push(`- ${row.identity}: ${row.reason}`);
  for (const row of plan.skipped) lines.push(`- 跳过 ${row.identity}: ${row.reason}（保持原价 ${row.oldPrice}）`);
  if (plan.sourceScope === 'app_unfiltered_version_minimum') lines.push('',
    '价格来源：集换社当前版本面板明确显示的最低在售价，未限定品相。缺失或无法精确识别的价格不参与调价。');
  return `${lines.join('\n')}\n`;
}

export function validateQuotes(input) {
  if (input?.source !== 'jihuanshe' || input.metric !== 'lowest_asking' || !Array.isArray(input.quotes) || !input.quotes.length) {
    throw new Error('Expected captured Jihuanshe lowest_asking evidence; rankings and market-average prices are not accepted.');
  }
  const rejectUiEvidence = (record) => {
    if (record?.quoteEligible !== undefined && record.quoteEligible !== true || record?.minimum?.quoteEligible === false
      || record?.sourceKind === 'official_app_ui' || record?.sourceKind === 'app_screenshot_crop'
      || typeof record?.kind === 'string' && record.kind.startsWith('app_')
      || typeof record?.conditionScope === 'string' && record.conditionScope.startsWith('app_')
      || record?.evidence?.kind === 'verified_app_pack') {
      throw new Error('App UI observations are not eligible price quotes; verified pricing evidence is still required.');
    }
  };
  rejectUiEvidence(input);
  return input.quotes.map((row) => {
    if (!row || typeof row.identity !== 'string' || !row.identity.startsWith('pokemon:')) throw new Error('Invalid quote identity.');
    rejectUiEvidence(row);
    // Only the established legacy API quote identity is supported until an App quote verifier exists.
    if (!/^pokemon:(?:zh-Hans|ja|en):[1-9]\d*:[1-9]\d*$/.test(row.identity)
      || row.versionIdKind === 'jihuanshe_pro_card_uuid'
      || row.versionId !== undefined && !/^[1-9]\d*$/.test(String(row.versionId))) {
      throw new Error('App UUID quotes require a verified App pricing adapter; changing the source URL does not qualify them.');
    }
    const sourceUrl = publicSourceUrl(row.sourceUrl).toString();
    if (new URL(sourceUrl).hostname !== 'api.jihuanshe.com' || /^\/pro\/cards(?:\/|$)/.test(new URL(sourceUrl).pathname)) {
      throw new Error('Quote must reference its observed API response, not an App card share page.');
    }
    return { identity: row.identity, currency: row.currency, metric: input.metric, amountCny: row.amountCny,
      available: row.available, shippingCny: row.shippingCny ?? null, observedAt: row.observedAt, sourceUrl,
      language: row.language, setId: row.setId, versionId: row.versionId,
      procurement: row.procurement == null ? undefined : {
        orderId: row.procurement.orderId, totalUnits: row.procurement.totalUnits, units: row.procurement.units,
      } };
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    config: { type: 'string' }, input: { type: 'string' }, quotes: { type: 'string' },
    plan: { type: 'string' }, 'approved-sha256': { type: 'string' }, help: { type: 'boolean' },
    'app-run': { type: 'string' }, procurement: { type: 'string' },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['doctor', 'discover', 'samples', 'import-batch', 'daily', 'apply'].includes(command)) throw new Error('Unknown command; use --help.');
  const configPath = values.config ? resolve(values.config) : resolve(ROOT, 'config.json');
  const config = readJson(configPath);
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 100) throw new Error('batchSize must be between 1 and 100.');
  const outputDir = resolve(dirname(configPath), config.outputDir);
  const source = new PublicSource({ delayMs: config.requestDelayMs });
  return withLock(outputDir, async () => {
    try {
      let result;
      if (command === 'doctor') {
        result = await checkReadiness(config, dirname(configPath));
        save(resolve(outputDir, 'preflight.json'), result);
      } else if (command === 'discover') {
        const report = await discover(source, config, outputDir);
        result = { status: report.status, packs: report.packs, pilots: report.pilots.map(({ language, setId, expectedCards }) => ({ language, setId, expectedCards })) };
      } else if (command === 'samples') {
        const report = await collectSamples(source, config, outputDir);
        result = { status: report.status, count: report.count, file: resolve(outputDir, 'card-samples.json') };
      } else if (command === 'import-batch') {
        if (!values.input) throw new Error('import-batch requires --input containing captured exact-pack card data.');
        const input = readJson(resolve(values.input));
        result = input.kind === 'verified_app_pack' ? importAppPack(config, outputDir, input)
          : await importBatch(source, config, outputDir, input);
      } else if (command === 'daily') {
        if (values.quotes && values['app-run']) throw new Error('Choose either --quotes or --app-run, never both.');
        if (values.procurement && !values['app-run']) throw new Error('--procurement is only supported with --app-run.');
        if (!values.quotes && !values['app-run']) throw new Error('BLOCKED: lowest-asking source endpoint is unverified. Supply --quotes or --app-run only after capturing real current lowest-asking evidence; no prices were read or changed.');
        let quotes = values.quotes ? validateQuotes(readJson(resolve(values.quotes))) : null;
        let mapping = readJson(resolve(dirname(configPath), config.mappingFile));
        if (!Array.isArray(mapping)) throw new Error('Mapping must be an array.');
        if (!mapping.some((row) => row.enabled === true)) throw new Error('BLOCKED: no exact listed single-card mappings. Create and review card/product/variant/SKU mappings first.');
        validateMappingRows(mapping.filter((row) => row.enabled === true));
        const catalogPath = resolve(outputDir, 'catalog.json');
        if (!existsSync(catalogPath)) throw new Error('BLOCKED: no verified exact-pack card catalog.');
        const catalog = readJson(catalogPath);
        let appEvidence;
        if (values['app-run']) {
          appEvidence = verifyAppDailyQuotes(resolve(values['app-run']), catalog.cards);
          quotes = appEvidence.quotes;
          const identities = new Set(appEvidence.targetIdentities);
          mapping = mapping.filter((row) => identities.has(row.identity));
          if (!mapping.some((row) => row.enabled === true)) throw new Error('BLOCKED: this App batch has no enabled exact listed single-card mappings.');
          if (values.procurement) {
            const allocations = readJson(resolve(values.procurement));
            if (!Array.isArray(allocations) || new Set(allocations.map((row) => row?.identity)).size !== allocations.length
              || allocations.some((row) => !identities.has(row?.identity))) throw new Error('Invalid or unrelated App procurement allocations.');
            const byIdentity = new Map(allocations.map((row) => [row.identity,
              { orderId: row.orderId, totalUnits: row.totalUnits, units: row.units }]));
            quotes = quotes.map((quote) => ({ ...quote, procurement: byIdentity.get(quote.identity) }));
          }
        } else if (catalog.cards.some((card) => card.sourceKind === 'official_app_ui' && quotes.some((quote) => quote.identity === card.identity))) {
          throw new Error('App catalog cards require a verified App pricing adapter before a price preview.');
        }
        const client = new ShopifyClient({ store: config.store, cliPath: config.shopifyCliPath });
        const live = await readListedVariants(client, mapping);
        const plan = buildPricePlan({ config, cards: catalog.cards, quotes, mapping, live });
        if (appEvidence) {
          plan.sourceScope = appEvidence.conditionScope;
          plan.appEvidence = { reportSha256: appEvidence.reportSha256, verifiedAt: appEvidence.verifiedAt,
            unquoted: appEvidence.unquoted };
        }
        const runDir = resolve(outputDir, 'history', new Date().toISOString().replace(/[:.]/g, '-'));
        save(resolve(runDir, 'plan.json'), plan);
        save(resolve(runDir, 'review.md'), review(plan));
        save(resolve(outputDir, 'latest-plan.json'), plan);
        save(resolve(outputDir, 'review.md'), review(plan));
        result = { status: 'preview_only', changes: plan.changes.length, skipped: plan.skipped.length, blocked: plan.blocked.length, digest: planDigest(plan), review: resolve(outputDir, 'review.md') };
      } else {
        if (!values.plan || !values['approved-sha256']) throw new Error('apply requires a reviewed --plan and its user-approved --approved-sha256.');
        const plan = readJson(resolve(values.plan));
        const client = new ShopifyClient({ store: config.store, cliPath: config.shopifyCliPath });
        result = await applyPricePlan(client, plan, values['approved-sha256'], { journalPath: resolve(outputDir, 'apply-journal.jsonl') });
      }
      save(resolve(outputDir, 'last-run.json'), { command, completedAt: new Date().toISOString(), ...result });
      console.log(JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      save(resolve(outputDir, 'last-run.json'), { command, completedAt: new Date().toISOString(), status: 'failed_or_blocked', message: error.message });
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => { if (result?.status === 'blocked') process.exitCode = 2; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
