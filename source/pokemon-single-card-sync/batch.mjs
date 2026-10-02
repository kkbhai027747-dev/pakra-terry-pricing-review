import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, save, sha256 } from './files.mjs';
import { downloadImage, publicSourceUrl } from './source.mjs';
import { verifyAppPack } from './verify-app-pack.mjs';

const LANGUAGES = { sc: 'zh-Hans', jp: 'ja', en: 'en' };
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function workspaceEvidencePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('App evidence paths must be absolute workspace paths.');
  const path = realpathSync(value), child = relative(realpathSync(WORKSPACE), path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('App evidence paths must remain inside the workspace.');
  }
  return path;
}

/** Local verified App evidence is a distinct source; no legacy IDs or remote image URLs are inferred. */
export function importAppPack(config, outputDir, input) {
  if (input?.kind !== 'verified_app_pack' || !Number.isInteger(config?.batchSize) || config.batchSize < 1 || config.batchSize > 100) {
    throw new Error('Expected a verified_app_pack import manifest and valid batch size.');
  }
  const directory = workspaceEvidencePath(input.directory), listingPath = workspaceEvidencePath(input.listingPath);
  const report = verifyAppPack(directory, listingPath);
  if (report.invalidCards.length || !report.cards.length) throw new Error('App capture must contain verified cards and no invalid card evidence.');
  const discovery = readJson(resolve(outputDir, 'discovery.json'));
  const pilots = discovery.pilots?.filter((row) => row.setId === report.context.setId && row.language === report.context.language);
  if (pilots?.length !== 1 || pilots[0].code !== report.context.setCode || pilots[0].name !== report.context.packName
    || pilots[0].expectedCards !== report.expectedCards) throw new Error('App capture does not match the discovered exact pack.');
  const listing = readJson(listingPath);
  const references = new Map(listing.observations.map((row) => [row.cardNumber, row]));
  const cards = report.cards.map((verified) => {
    const context = verified.context, raw = references.get(context.cardNumber), cardDir = resolve(directory, verified.uuid);
    const evidence = readJson(resolve(cardDir, 'evidence.json'));
    const rarity = raw.rarity ?? null;
    if (rarity !== null && (typeof rarity !== 'string' || !rarity.trim() || /原包|原盒|整盒|卡包|sealed/i.test(rarity))) {
      throw new Error('App card has invalid or sealed-product rarity evidence.');
    }
    return { identity: `pokemon:${context.language}:${context.setId}:${verified.uuid}`, ip: 'pokemon',
      language: context.language, setId: context.setId, setCode: context.setCode, packName: context.packName,
      sourceKind: 'official_app_ui', versionIdKind: 'jihuanshe_pro_card_uuid', sourceId: null, versionId: verified.uuid,
      number: context.cardNumber, rarity, name: context.cardName, originalName: context.originalName ?? '',
      languageLabel: context.languageLabel, sourceUrl: context.shareUrl, imageUrl: null, image: verified.image,
      capturedAt: new Date(evidence.header.capturedAt).toISOString(),
      evidence: { kind: 'verified_app_pack', directory: cardDir, packDirectory: directory, listingPath,
        referenceSha256: report.referenceSha256, contextSha256: sha256(readFileSync(resolve(cardDir, 'context.json'))),
        evidenceSha256: sha256(readFileSync(resolve(cardDir, 'evidence.json'))),
        imageMetadataSha256: sha256(readFileSync(resolve(cardDir, 'image/image.json'))) } };
  });
  const file = resolve(outputDir, 'catalog.json'), catalog = existsSync(file) ? readJson(file) : { schemaVersion: 1, cards: [] };
  if (!Array.isArray(catalog.cards) || new Set(catalog.cards.map((card) => card.identity)).size !== catalog.cards.length) {
    throw new Error('Existing catalog must contain unique exact identities.');
  }
  const index = new Map(catalog.cards.map((card) => [card.identity, card]));
  const stableFields = ['ip', 'language', 'setId', 'setCode', 'packName', 'sourceKind', 'versionIdKind', 'sourceId',
    'versionId', 'number', 'rarity', 'name', 'originalName', 'languageLabel', 'sourceUrl', 'imageUrl'];
  for (const card of cards) {
    const previous = index.get(card.identity);
    if (previous && stableFields.some((key) => previous[key] !== card[key])) {
      throw new Error('Conflicting metadata for an existing exact card identity.');
    }
    index.set(card.identity, card);
  }
  const coverage = { ...report.context, directory, listingPath, referenceSha256: report.referenceSha256,
    expectedCards: report.expectedCards, verifiedCards: report.verifiedCards, imagesVerified: report.imagesVerified,
    completePackEvidenceVerified: report.completePackEvidenceVerified, originalImagesCaptured: false,
    imageSourceKind: 'app_screenshot_crop', lowestAskingVerified: false, missing: report.missing };
  if (catalog.appPacks !== undefined && !Array.isArray(catalog.appPacks)) throw new Error('Invalid existing App pack coverage.');
  const existingCoverage = catalog.appPacks?.find((row) => row.setId === coverage.setId && row.language === coverage.language);
  if (existingCoverage?.completePackEvidenceVerified === true && !coverage.completePackEvidenceVerified) {
    throw new Error('Cannot replace complete App pack coverage with a partial capture.');
  }
  const appPacks = [...(catalog.appPacks ?? []).filter((row) => row.setId !== coverage.setId || row.language !== coverage.language), coverage];
  save(file, { ...catalog, updatedAt: new Date().toISOString(), cards: [...index.values()], appPacks });
  return { imported: cards.length, catalogCards: index.size, sourceKind: 'official_app_ui',
    completePackEvidenceVerified: report.completePackEvidenceVerified, expectedCards: report.expectedCards,
    verifiedCards: report.verifiedCards, imagesVerified: report.imagesVerified, missingCards: report.missing.length,
    originalImagesCaptured: false, lowestAskingVerified: false };
}

/** Input is a captured exact-pack response, not search/ranking data or a name match. */
export function normalizeBatch(input, pilot) {
  if (input?.source !== 'jihuanshe' || !Array.isArray(input.cards) || !input.cards.length
    || !pilot || String(input.packId) !== pilot.setId || input.language !== pilot.language) {
    throw new Error('Batch must match a discovered exact pack and language.');
  }
  const capturedAt = new Date(input.capturedAt);
  if (typeof input.capturedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.capturedAt)
    || !Number.isFinite(capturedAt.getTime())) throw new Error('Batch capture timestamp with timezone required.');
  const sourceUrl = publicSourceUrl(input.sourceUrl).toString();
  if (new URL(sourceUrl).hostname !== 'api.jihuanshe.com') throw new Error('Batch provenance must identify the actual public API response.');
  const seen = new Set();
  return input.cards.map((raw) => {
    if (raw.game_key !== 'pkm' || LANGUAGES[raw.game_sub_key] !== pilot.language
      || String(raw.pack_id) !== pilot.setId || !Number.isSafeInteger(raw.card_version_id) || raw.card_version_id < 1
      || !Number.isSafeInteger(raw.card_id) || raw.card_id < 1
      || typeof raw.number !== 'string' || !raw.number.trim()
      || typeof raw.rarity !== 'string' || !raw.rarity.trim() || /原包|原盒|整盒|卡包|sealed/i.test(raw.rarity)
      || !(raw.name_cn || raw.name_origin)) throw new Error('Card row lacks exact pack/language/version evidence or is a sealed product.');
    const identity = `pokemon:${pilot.language}:${pilot.setId}:${raw.card_version_id}`;
    if (seen.has(identity)) throw new Error('Duplicate card version within batch.');
    seen.add(identity);
    return { identity, ip: 'pokemon', language: pilot.language, setId: pilot.setId,
      sourceId: String(raw.card_id), versionId: String(raw.card_version_id),
      number: raw.number, rarity: raw.rarity, name: raw.name_cn || raw.name_origin,
      originalName: raw.name_origin || '', imageUrl: publicSourceUrl(raw.image_url).toString(),
      sourceUrl, capturedAt: capturedAt.toISOString() };
  });
}

export async function importBatch(source, config, outputDir, input) {
  const discovery = readJson(resolve(outputDir, 'discovery.json'));
  const pilot = discovery.pilots.find((row) => row.setId === String(input.packId) && row.language === input.language);
  const cards = normalizeBatch(input, pilot);
  const file = resolve(outputDir, 'catalog.json');
  const catalog = existsSync(file) ? readJson(file) : { schemaVersion: 1, cards: [] };
  const index = new Map(catalog.cards.map((card) => [card.identity, card]));
  for (let offset = 0; offset < cards.length; offset += config.batchSize) {
    for (const card of cards.slice(offset, offset + config.batchSize)) {
      const previous = index.get(card.identity);
      const cached = previous?.image;
      if (previous && (previous.number !== card.number || previous.rarity !== card.rarity || previous.sourceId !== card.sourceId)) {
        throw new Error('Conflicting metadata for an existing exact card identity.');
      }
      const image = cached && previous.imageUrl === card.imageUrl && existsSync(cached.path)
        && sha256(readFileSync(cached.path)) === cached.sha256 ? cached
        : await downloadImage(source, card.imageUrl, resolve(outputDir, 'images'));
      index.set(card.identity, { ...card, image });
      // Persist each completed card so a failed image can be resumed without losing earlier work.
      save(file, { ...catalog, schemaVersion: 1, updatedAt: new Date().toISOString(), cards: [...index.values()] });
    }
    save(resolve(outputDir, 'batch-progress.json'), {
      generatedAt: new Date().toISOString(), completedInInput: Math.min(offset + config.batchSize, cards.length),
      inputCards: cards.length, sets: discovery.pilots.map((pack) => ({
        language: pack.language, setId: pack.setId, expectedSourceVersions: pack.expectedCards,
        importedSingleCards: [...index.values()].filter((card) => card.setId === pack.setId && card.language === pack.language).length,
        coverage: 'not_certified_complete',
      })),
    });
  }
  return { imported: cards.length, catalogCards: index.size };
}
