import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson } from './files.mjs';
import { verifyAppPack } from './verify-app-pack.mjs';

const LABELS = { 'zh-Hans': '简体中文', ja: '日文', en: '英文' };
const CSV_FIELDS = ['language', 'languageLabel', 'cardName', 'originalName', 'cardNumber', 'rarity',
  'setId', 'setCode', 'packName', 'uuid', 'shareUrl', 'capturedAt', 'imagePath', 'imageSha256',
  'imageWidth', 'imageHeight', 'imageSourceKind', 'originalImage', 'galleryScreenshotPath', 'evidenceDirectory'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeInput = (path) => {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('invalid_preview_source_path');
  const actual = realpathSync(path);
  if ([path, actual].some((value) => value.split(/[\\/]/).some((part) => part.toLowerCase() === '.pending'))) fail('invalid_preview_source_path');
  return actual;
};

export function cardsCsv(cards) {
  const cell = (value) => {
    let text = value == null ? '' : String(value);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [CSV_FIELDS, ...cards.map((card) => CSV_FIELDS.map((key) => card[key]))]
    .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function previewHtml(report, outputDir) {
  const localUrl = (path) => {
    const target = relative(outputDir, path);
    return isAbsolute(target) ? pathToFileURL(path).href : target.split(sep).map(encodeURIComponent).join('/');
  };
  const packs = report.packs.map((pack) => `<tr><td>${escapeHtml(LABELS[pack.context.language])}</td><td>${escapeHtml(pack.context.packName)} · ${escapeHtml(pack.context.setCode)}</td><td>${pack.verifiedCards} / ${pack.expectedCards}</td><td>${pack.missingCards}</td><td>${pack.invalidCards.length}</td><td>${pack.completePackEvidenceVerified ? '已完整验证' : '整包未完成'}</td></tr>`).join('');
  const cards = report.cards.map((card) => `<article><a href="${escapeHtml(localUrl(card.imagePath))}"><img src="${escapeHtml(localUrl(card.imagePath))}" alt="${escapeHtml(card.cardName)} ${escapeHtml(card.cardNumber)}" width="${card.imageWidth}" height="${card.imageHeight}" loading="lazy"></a><div><span class="language">${escapeHtml(LABELS[card.language])} · ${escapeHtml(card.setCode)}</span><h2>${escapeHtml(card.cardName)}</h2>${card.originalName ? `<p>${escapeHtml(card.originalName)}</p>` : ''}<p class="number">${escapeHtml(card.cardNumber)}</p><p>${escapeHtml(card.packName)} · ${escapeHtml(card.rarity ?? '稀有度未显示')}</p><details><summary>查看来源</summary><p>集换社 App 展示图截图裁切<br>${card.imageWidth} × ${card.imageHeight}；非原始图片</p><p class="uuid">UUID：${escapeHtml(card.uuid)}</p><a href="${escapeHtml(card.shareUrl)}" rel="noreferrer">集换社卡牌链接</a> · <a href="${escapeHtml(localUrl(card.galleryScreenshotPath))}">完整截图</a></details></div></article>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'"><title>宝可梦单卡采集预览</title>
<style>body{margin:0;background:#f5f6f8;color:#1e293b;font:15px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:32px 20px}h1{font-size:28px;margin:0 0 10px}p{margin:4px 0}.notice{padding:14px 18px;border-left:4px solid #947142;background:#fff8e8;margin:20px 0}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #e2e8f0}.table{overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;margin-top:24px}article{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:14px}article>div{padding-top:10px}img{display:block;width:100%;height:auto}h2{font-size:18px;margin:3px 0}.language{font-size:12px;color:#52657a}.number,.uuid{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.uuid{font-size:11px}details{font-size:12px;margin-top:10px}summary{cursor:pointer}a{color:#245ea5}footer{margin-top:24px;color:#52657a;font-size:12px}</style>
<main><h1>宝可梦单卡采集预览</h1><p>已验证 ${report.verifiedCards} 张卡、${report.imagesVerified} 张图片；目标 ${report.expectedCards} 张，尚缺 ${report.missingCards} 张。</p>
<div class="notice"><strong>${report.completePackEvidenceVerified ? '本次所选卡包已完整验证' : '当前为部分采集结果，整包尚未完成'}</strong><p>图片来自集换社 App 展示图截图裁切，非原始图片。此清单用于核对卡牌信息，不包含售价、库存或 Shopify 商品映射。</p>${report.invalidCards ? `<p>${report.invalidCards} 条证据未通过验证，未进入下方清单；详情见 JSON。</p>` : ''}</div>
<p><a href="preview.json">JSON 清单与缺失记录</a> · <a href="cards.csv">CSV 清单</a></p>
<div class="table"><table><thead><tr><th>语言</th><th>卡包</th><th>已验证 / 目标</th><th>缺失</th><th>无效证据</th><th>状态</th></tr></thead><tbody>${packs}</tbody></table></div>
<section class="grid">${cards || '<p>本次快照暂无通过验证的已提交卡牌。</p>'}</section>
<footer>导出时间：${escapeHtml(report.generatedAt)}。仅收录采集进度已登记、身份和文件哈希验证通过的完整目录；图片链接指向本机证据文件。</footer></main></html>\n`;
}

/** Export a snapshot of committed records only; verifyAppPack never enumerates pending directories. */
export function exportAppPreview(input, outputDirectory) {
  if (input?.kind !== 'app_pack_preview_sources' || !Array.isArray(input.packs) || !input.packs.length || input.packs.length > 3) fail('invalid_preview_sources');
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) fail('invalid_preview_output');
  const outputDir = resolve(outputDirectory);
  if (existsSync(outputDir)) fail('preview_output_exists');
  const packKeys = new Set(), uuids = new Set(), cards = [], packs = [];
  for (const source of input.packs) {
    const directory = safeInput(source?.directory), listingPath = safeInput(source?.listingPath);
    const destination = relative(directory, outputDir);
    if (!destination || destination !== '..' && !destination.startsWith(`..${sep}`) && !isAbsolute(destination)) fail('preview_output_inside_capture');
    const verified = verifyAppPack(directory, listingPath);
    const key = `${verified.context.language}:${verified.context.setId}`;
    if (packKeys.has(key)) fail('duplicate_preview_pack');
    packKeys.add(key);
    const listing = readJson(listingPath), rows = new Map(listing.observations.map((row) => [row.cardNumber, row]));
    for (const record of verified.cards) {
      if (uuids.has(record.uuid)) fail('duplicate_preview_uuid');
      uuids.add(record.uuid);
      const context = record.context, evidenceDirectory = resolve(directory, record.uuid);
      const evidence = readJson(resolve(evidenceDirectory, 'evidence.json'));
      cards.push({ language: context.language, languageLabel: context.languageLabel, cardName: context.cardName,
        originalName: context.originalName ?? '', cardNumber: context.cardNumber, rarity: rows.get(context.cardNumber).rarity ?? null,
        setId: context.setId, setCode: context.setCode, packName: context.packName, uuid: record.uuid, shareUrl: context.shareUrl,
        capturedAt: evidence.header.capturedAt, imagePath: record.image.path, imageSha256: record.image.sha256,
        imageWidth: record.image.width, imageHeight: record.image.height, imageSourceKind: record.image.sourceKind,
        originalImage: false, galleryScreenshotPath: resolve(evidenceDirectory, 'gallery.png'),
        galleryScreenshotSha256: evidence.gallery.pngSha256, evidenceDirectory });
    }
    packs.push({ context: verified.context, directory, listingPath, referenceSha256: verified.referenceSha256,
      expectedCards: verified.expectedCards, recordedCards: verified.recordedCards, verifiedCards: verified.verifiedCards,
      imagesVerified: verified.imagesVerified, missingCards: verified.missing.length, invalidCards: verified.invalidCards,
      completePackEvidenceVerified: verified.completePackEvidenceVerified, missing: verified.missing });
  }
  const total = (field) => packs.reduce((sum, pack) => sum + pack[field], 0);
  const report = { kind: 'app_card_preview', generatedAt: new Date().toISOString(),
    expectedCards: total('expectedCards'), verifiedCards: cards.length, imagesVerified: total('imagesVerified'),
    missingCards: total('missingCards'), invalidCards: packs.reduce((sum, pack) => sum + pack.invalidCards.length, 0),
    completePackEvidenceVerified: packs.every((pack) => pack.completePackEvidenceVerified),
    sourceKind: 'official_app_ui', imageSourceKind: 'app_screenshot_crop', originalImagesCaptured: false,
    selection: 'verified_committed_progress_records_only', packs, cards };
  const outputs = { 'preview.json': `${JSON.stringify(report, null, 2)}\n`, 'cards.csv': cardsCsv(cards), 'index.html': previewHtml(report, outputDir) };
  mkdirSync(dirname(outputDir), { recursive: true }); mkdirSync(outputDir);
  for (const [name, data] of Object.entries(outputs)) writeFileSync(resolve(outputDir, name), data, { flag: 'wx' });
  return { ...report, outputDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ strict: true, options: { input: { type: 'string' }, 'output-dir': { type: 'string' } } });
    if (!values.input || !values['output-dir']) fail('invalid_arguments');
    const report = exportAppPreview(readJson(resolve(values.input)), resolve(values['output-dir']));
    console.log(JSON.stringify({ status: report.completePackEvidenceVerified ? 'complete_preview' : 'partial_preview',
      verifiedCards: report.verifiedCards, imagesVerified: report.imagesVerified, expectedCards: report.expectedCards,
      missingCards: report.missingCards, invalidCards: report.invalidCards, outputDir: report.outputDir }));
  } catch (error) {
    console.error(JSON.stringify({ error: /^[a-z_]+$/.test(error.code || '') ? error.code : 'preview_export_failed' }));
    process.exitCode = 1;
  }
}
