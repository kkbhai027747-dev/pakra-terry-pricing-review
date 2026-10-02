import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readJson, sha256 } from './files.mjs';
import { listingPrice } from './prepare-listings.mjs';

const { values } = parseArgs({ strict: true, options: { plan: { type: 'string' }, contexts: { type: 'string' },
  'theme-manifest': { type: 'string' }, output: { type: 'string' } } });
if (!values.plan || !values.contexts || !values['theme-manifest'] || !values.output) throw new Error('plan_contexts_manifest_output_required');
const bytes = readFileSync(resolve(values.plan)), plan = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const contexts = readJson(resolve(values.contexts)), theme = readJson(resolve(values['theme-manifest']));
if (!Array.isArray(contexts) || contexts.length < 1 || contexts.length > 20 || theme.themeId !== '158535483580'
  || theme.roleAtRead !== 'unpublished' || theme.files.length !== 6) throw new Error('invalid_review_scope');
const records = contexts.map(context => plan.records.find(row => row.sourceUrl === context.shareUrl
  && row.language === context.language && row.setId === context.setId && row.cardNumber === context.cardNumber));
if (new Set(records.map(row => row?.identity)).size !== records.length || records.some(row => !row?.readyForReview
  || row.blockers.length || listingPrice(row.quote, row.identity).price !== row.fields.price)) throw new Error('review_prices_not_ready');
const digest = sha256(bytes), out = resolve(values.output); mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'frozen-plan.json'), bytes);
const request = { kind: 'pokemon_listing_approval_request', approved: false, createdAt: new Date().toISOString(),
  planPath: resolve(out, 'frozen-plan.json'), planSha256: digest, identities: records.map(row => row.identity),
  productCount: records.length, collection: plan.collection, existingCollections: records[0].fields.collections,
  targetTheme: { id: theme.themeId, role: theme.roleAtRead, files: theme.files.map(file => file.path) },
  dynamicFields: 'Only IDs and CDN image URLs returned and independently verified for these exact new products may fill the approved Pokemon catalog and covers.',
  remoteWritesPerformed: 0, themePublish: false };
writeFileSync(resolve(out, 'approval-request.json'), JSON.stringify(request, null, 2) + '\n');
const cell = value => String(value).replaceAll('|', '\\|');
const descriptions = {
  'assets/p10-single-card-boxes.json': ['仅有 My Little Pony 入口', '保留原入口，新增宝可梦入口；封面使用本批核验卡图'],
  'assets/p10-pokemon-single-card-boxes.json': ['不存在', '新增简中、日文、英文三个已采集卡包入口及本批核验封面'],
  'assets/p10-pokemon-single-card-catalog.json': ['不存在', '仅加入本批成功回读的真实商品、变体、图片映射；USD，禁止购买'],
  'assets/p10-single-card-catalog-20260719-v6.js': ['最新 V9 目录交互，仅有 MLP 数据源', '新增独立宝可梦数据源、准确变体价格与图片匹配、仅展示行为；保留现有 MLP 交互'],
  'sections/p10-single-card-lounge-v6.liquid': ['最新 V9 目录区块，仅有原集合数据源', '新增宝可梦集合设置与独立数据入口；保留最新目录交互和辅助功能'],
  'templates/page.single-cards-live.json': ['source_collection=mlp-single-cards', '保留原设置，新增 pokemon_source_collection=pokemon-single-cards'],
};
if (theme.files.some(file => !descriptions[file.path]) || new Set(theme.files.map(file => file.path)).size !== 6) throw new Error('unexpected_theme_file');
const lines = ['# 首批宝可梦单卡：待批准修改清单', '',
  `本批 ${records.length} 张，全部仅展示、不可购买。此文件是写入前清单，尚未上架。`, '',
  '## 商品、变体与图片', '',
  '以下商品和唯一变体均为新建，原值为不存在，ID尚未分配；精确handle、SKU、全部字段与证据见 frozen-plan.json。',
  '新商品字段：标题、说明、Pokémon品牌、Single Card/Single Card Bundle类型、非体育集换卡分类、源证据标签及以下售价和图片。每卡图只绑定自己的变体。',
  '先建DRAFT并回读，开启库存跟踪、缺货策略DENY，不写库存数量；确认库存0和availableForSale=false后才ACTIVE并发布到Online Store（173264044220）。',
  '预计影响：这些新商品可出现在全站搜索和集合中，但不能购买。V9主题仍为未发布草稿，不发布主主题。', '',
  '|卡号 / 语言|商品名|今日最低在售价 CNY|新展示价 USD|图片来源|精确SKU|', '|---|---|---:|---:|---|---|',
  ...records.map(row => `|${cell(row.cardNumber)} / ${row.language}|${cell(row.title)}|${row.quote.amountCny}|${row.fields.price}|${row.image.originalImage ? '原始下载图' : '已获准核验裁切图'}|${row.sku}|`), '',
  '## 集合与发布渠道', '',
  '- 新建手工集合 Pokémon Single Cards，handle=pokemon-single-cards，ID尚未分配，原值不存在；只向Online Store发布并加入本批新商品。',
  '- 现有 ip-pokemon（333313114300）及 type-single-cards（333313278140）原成员不变，仅新增本批新商品ID。',
  '- 其他产品、集合成员、价格、库存数量和发布渠道不变。', '',
  '## V9精确文件', '',
  `目标现有 Theme ${theme.themeId} / unpublished，上传前再次核对角色和每个最新远端SHA。`, '',
  '|文件|原值|新值 / 影响|', '|---|---|---|',
  ...theme.files.map(file => `|${file.path}|${descriptions[file.path][0]}|${descriptions[file.path][1]}|`), '',
  '生产商品数据JSON的原空模板会仅填入本批成功建档并回读的真实Product/Variant/ProductImage ID、SKU和CDN图。卡图已由本清单的SHA固定；IP与三语言卡包封面只引用本批对应语言的已回读卡图。任何创建或验收失败都不填入假ID、不把测试价12.34写入生产。',
  'MLP/G4与最新目录UX保留；不上传CSS、旧MLP catalog或清单以外文件，不新建主题，不执行theme publish。', '',
  '## 执行与验收', '',
  '先执行1张canary；图片/售价/不可购买状态/Online Store及集合回读全部通过后，继续本批余下商品。异常结果停并回读，不自动重复创建。',
  '正式每日商品映射仅从成功回读生成；每日自动写入仍需遵守每次写前批准规则，此清单不扩大无人值守改价权限。', '',
  `冻结计划 SHA-256：${digest}`, '',
  '依据 D:/CODEX/AGENTS.override.md，每次写入前需要列出对象、ID、字段、原值、新值与影响并获得当前任务明确批准。本请求尚未获得批准。'];
writeFileSync(resolve(out, '首批上架确认清单.md'), lines.join('\n') + '\n');
const html = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
writeFileSync(resolve(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; base-uri 'none'"><title>首批20张宝可梦：上架确认</title><style>body{margin:0;background:#f7f6fa;color:#24212b;font:15px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:24px}h1{font-size:27px}h2{font-size:16px}.notice{background:#eee9f4;padding:16px;border-left:4px solid #72538e}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}article{border:1px solid #ddd5e5;border-radius:8px;background:white;padding:14px}img{width:100%;height:auto}small{color:#655c6e}.price{font-size:22px;font-weight:700;margin:0}a{color:#60417c}details{font-size:12px;overflow-wrap:anywhere}</style><main><h1>首批 ${records.length} 张宝可梦单卡</h1><div class="notice"><strong>待批准，尚未写入 Shopify</strong><p>以下均为今日实际采价及公式售价，全部仅展示、不可购买。¥15采购运费只计整单成本。</p><p>本次拟新建商品和宝可梦集合，并更新现有 V9 主题 158535483580 的6个指定文件。</p><a href="首批上架确认清单.md">查看完整对象、字段、影响与文件清单</a></div><p>报价超过4小时须重新采集并复核，价格变化会重新列出差异。</p><section class="grid">${records.map(row => `<article><img loading="lazy" src="${html(pathToFileURL(row.image.path).href)}" alt="${html(row.title)}"><small>${html(row.cardNumber)} · ${html(row.language)}</small><h2>${html(row.title)}</h2><p class="price">$${html(row.fields.price)} USD</p><p>集换社最低在售：¥${html(row.quote.amountCny)}</p><p>仅展示 · 暂不开放购买</p><details><summary>图片与身份</summary><p>${row.image.originalImage ? '源站下载原图' : '已获准核验 App 裁切图'}</p><p>${html(row.sku)}</p><p>${html(row.handle)}</p><a href="${html(row.sourceUrl)}">集换社来源</a></details></article>`).join('')}</section></main></html>\n`);
console.log(JSON.stringify({status:'awaiting_approval',count:records.length,planSha256:digest,outputDir:out}));
