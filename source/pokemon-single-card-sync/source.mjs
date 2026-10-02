import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, save, sha256 } from './files.mjs';

export const GAME_CONFIG_URL = 'https://jihuanshe-qn-src.jihuanshe.com/configs/games.json';
const API = 'https://api.jihuanshe.com/api/market';
const LANGUAGES = Object.freeze({ sc: 'zh-Hans', jp: 'ja', en: 'en' });
const HOSTS = new Set(['api.jihuanshe.com', 'jihuanshe-qn-src.jihuanshe.com', 'm-static-src.jihuanshe.com',
  'jihuanshe-r2-imagex.jihuanshe.com', 'jihuanshe-imagex.jihuanshe.com', 'jihuanshe-frontend.jihuanshe.com']);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function publicSourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port
    || [...url.searchParams.keys()].some((key) => /token|secret|cookie|signature|auth|password|api[_-]?key|access[_-]?key|jwt/i.test(key))) {
    throw new Error('Source URL is outside the verified public Jihuanshe hosts or contains credentials.');
  }
  return url;
}

export class PublicSource {
  constructor({ delayMs = 1000, fetcher = fetch } = {}) {
    this.fetcher = fetcher;
    this.delayMs = Math.max(0, delayMs);
    this.lastRequest = 0;
  }
  async get(value, { image = false } = {}) {
    const url = publicSourceUrl(value);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(Math.max(0, this.lastRequest + this.delayMs - Date.now()));
      this.lastRequest = Date.now();
      let response;
      try {
        response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(25000),
          headers: { Accept: image ? 'image/*' : 'application/json', 'User-Agent': 'PAKRA-Catalog-ReadOnly/0.1' } });
      } catch { throw new Error(`Source connection failed: ${url.hostname}${url.pathname}`); }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Source HTTP ${response.status}: ${url.hostname}${url.pathname}; no authentication bypass attempted.`);
      const limit = image ? 15 * 1024 * 1024 : 12 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Source response too large.'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) throw new Error('Source response too large.');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (image) return { bytes, extension: imageExtension(bytes) };
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Source is not JSON; existing data retained.'); }
      if (data?.error) throw new Error('Source returned an application error; existing data retained.');
      return data;
    }
  }
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Image response is not a PNG/JPEG/WebP.');
}

export function extractPacks(tree, subKey) {
  const found = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (Array.isArray(node.packList)) for (const pack of node.packList) {
      if (pack.type !== 2 || pack.game_key !== 'pkm' || pack.game_sub_key !== subKey || !Number.isSafeInteger(pack.packId) || pack.packId < 1) continue;
      const row = { ip: 'pokemon', language: LANGUAGES[subKey], gameSubKey: subKey,
        setId: String(pack.packId), name: String(pack.packName || ''), code: String(pack.packAlias || ''),
        releasedAt: pack.packReleaseAt || null, imageUrl: pack.image || null };
      if (!found.has(row.setId)) found.set(row.setId, row);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'packList') visit(value);
  }
  visit(tree);
  if (!LANGUAGES[subKey] || found.size === 0) throw new Error('No verified Pokemon packs for the requested language.');
  return [...found.values()];
}

export async function downloadImage(source, url, directory) {
  const key = sha256(publicSourceUrl(url).toString());
  const { bytes, extension } = await source.get(url, { image: true });
  const hash = sha256(bytes);
  const path = resolve(directory, `${key}-${hash.slice(0, 12)}.${extension}`);
  if (!existsSync(path) || sha256(readFileSync(path)) !== hash) save(path, bytes);
  return { path, sha256: hash, bytes: bytes.length, sourceUrl: url };
}

export async function discover(source, config, outputDir) {
  const games = await source.get(GAME_CONFIG_URL);
  if (!Array.isArray(games)) throw new Error('Game configuration schema changed.');
  const packs = []; const pilots = [];
  for (const subKey of ['sc', 'jp', 'en']) {
    const game = games.find((row) => row.game_key === 'pkm' && row.game_sub_key === subKey);
    if (!game?.category_tree_v2) throw new Error(`Missing official language configuration: ${subKey}`);
    const tree = await source.get(game.category_tree_v2);
    const languagePacks = extractPacks(tree, subKey);
    packs.push(...languagePacks);
    save(resolve(outputDir, `packs-${subKey}.json`), { fetchedAt: new Date().toISOString(), sourceUrl: game.category_tree_v2, packs: languagePacks });
    for (const selected of config.pilotSets.filter((row) => row.gameSubKey === subKey)) {
      const pack = languagePacks.find((row) => row.setId === selected.setId && row.language === selected.language);
      if (!pack) throw new Error(`Configured pilot absent from official pack directory: ${subKey}/${selected.setId}`);
      const shareUrl = new URL('https://www.jihuanshe.com/app/cardPacket');
      shareUrl.search = new URLSearchParams({ packId: pack.setId, gameKey: 'pkm', gameSubKey: subKey });
      const apiUrl = new URL(`${API}/share/pack`);
      apiUrl.search = new URLSearchParams({ pack_id: pack.setId, game_key: 'pkm', game_sub_key: subKey, url: shareUrl.toString() });
      const response = await source.get(apiUrl);
      const data = response.data ?? response;
      if (String(data.pack_id) !== pack.setId || !Number.isSafeInteger(data.card_version_count) || data.card_version_count < 1) {
        throw new Error('Pack detail schema or identity mismatch.');
      }
      // Only these product fields are retained; share responses may contain signing data.
      const pilot = { ...pack, name: data.name_cn || pack.name, originalName: data.name_origin || '',
        expectedCards: data.card_version_count, sourceUrl: apiUrl.toString(), shareUrl: shareUrl.toString(),
        fetchedAt: new Date().toISOString(), image: await downloadImage(source, data.image_url || pack.imageUrl, resolve(outputDir, 'images')),
        cardCatalogueStatus: 'unverified', lowestAskingStatus: 'unverified' };
      pilots.push(pilot);
      save(resolve(outputDir, `pilot-${subKey}.json`), pilot);
    }
  }
  const report = { generatedAt: new Date().toISOString(), packs: packs.length, pilots,
    completeCardBatches: 0, status: 'pack_metadata_only',
    limitation: 'Public pack endpoints do not provide card lists or lowest asking prices. Pack counts and covers are not completed card batches.' };
  save(resolve(outputDir, 'discovery.json'), report);
  return report;
}

export async function collectSamples(source, config, outputDir) {
  const discovery = readJson(resolve(outputDir, 'discovery.json'));
  if (!Array.isArray(discovery.pilots)) throw new Error('Run discovery before collecting card samples.');
  const pilots = config.pilotSets.map((selected) => {
    const pilot = discovery.pilots.find((row) => row.setId === selected.setId
      && row.language === selected.language && row.gameSubKey === selected.gameSubKey);
    if (!pilot || !pilot.code || LANGUAGES[pilot.gameSubKey] !== pilot.language) {
      throw new Error('Configured pilot is missing verified discovery metadata.');
    }
    return pilot;
  });
  const sourceUrl = `${API}/ranking/searchPageRanking`;
  const response = await source.get(sourceUrl);
  if (!Array.isArray(response?.data) || response.data.some((group) => !Array.isArray(group?.data))) {
    throw new Error('Public ranking schema changed; existing samples retained.');
  }
  const candidates = new Map();
  for (const group of response.data) {
    if (!['hot', 'priceIncrease'].includes(group.type)) continue;
    for (const row of group.data) {
      if (row?.game_key !== 'pkm' || /原包|原盒|原箱|未拆封|礼盒|周边/.test(`${row.name_cn || ''} ${row.rarity || ''}`)) continue;
      const matches = pilots.filter((pilot) => pilot.gameSubKey === row.game_sub_key && pilot.code === row.number_alias);
      if (matches.length === 0) continue;
      if (matches.length !== 1) throw new Error('Ranking alias matches multiple pilot sets; membership cannot be inferred.');
      if (!Number.isSafeInteger(row.card_id) || row.card_id < 1
        || !Number.isSafeInteger(row.card_version_id) || row.card_version_id < 1
        || typeof row.name_cn !== 'string' || !row.name_cn.trim()
        || typeof row.number !== 'string' || !row.number.trim()
        || typeof row.rarity !== 'string' || typeof row.image_url !== 'string') {
        throw new Error('Public card sample schema changed; existing samples retained.');
      }
      publicSourceUrl(row.image_url);
      const pilot = matches[0];
      const key = `${pilot.language}:${row.card_version_id}`;
      if (!candidates.has(key)) candidates.set(key, {
        ip: 'pokemon', language: pilot.language, gameSubKey: pilot.gameSubKey,
        sourceId: String(row.card_id), versionId: String(row.card_version_id),
        setId: 'UNKNOWN', candidateSetId: pilot.setId, membership: 'unverified',
        name: row.name_cn, number: row.number, rarity: row.rarity, imageUrl: row.image_url, sourceUrl,
      });
    }
  }
  const cards = [];
  for (const card of candidates.values()) {
    cards.push({ ...card, image: await downloadImage(source, card.imageUrl, resolve(outputDir, 'images')) });
  }
  const report = { generatedAt: new Date().toISOString(), sourceUrl, status: 'card_samples_only', count: cards.length,
    cards, completeCardBatches: 0,
    limitation: 'Ranking samples are matched by language and alias only. Set membership and lowest asking prices remain unverified; these samples are not a complete card catalogue.' };
  save(resolve(outputDir, 'card-samples.json'), report);
  return report;
}
