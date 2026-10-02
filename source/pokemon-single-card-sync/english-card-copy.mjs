// Reviewed official-name dictionary, 2026-09-28. Source review SHA-256:
// 36400527d0d0425a71796041a865be86c4ac7719da92a189f519217686a0c8a2
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWED_COPY_OVERRIDES } from './english-card-copy-overrides.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const reviewedByUuid = new Map(REVIEWED_COPY_OVERRIDES.map(row => [row.sourceUuid, row]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const CARD_NAMES = Object.freeze({
  '耿鬼': 'Gengar', '洛奇亚': 'Lugia', '蛋蛋': 'Exeggcute', '阿罗拉 椰蛋树': 'Alolan Exeggutor',
  '彩粉蝶': 'Vivillon', '火焰鸟': 'Moltres', '凤王': 'Ho-Oh', '莱希拉姆': 'Reshiram',
  '呆火鳄ex': 'Fuecoco ex', '急冻鸟': 'Articuno', '盖欧卡': 'Kyogre', '帕路奇亚': 'Palkia',
  '甲贺忍蛙ex': 'Greninja ex', '弱丁鱼': 'Wishiwashi', '皮卡丘': 'Pikachu', 'ゲンガー': 'Gengar', Lugia: 'Lugia',
});
const SET_NAMES = Object.freeze({ '30周年庆典': '30th Celebration' });
const RARITIES = Object.freeze({ '无标记': 'Unmarked', C: 'C', R: 'R', RR: 'RR' });
const knownEnglishNames = new Set(Object.values(CARD_NAMES));
const lookup = (dictionary, value) => Object.hasOwn(dictionary, value) ? dictionary[value] : null;
const english = value => typeof value === 'string' && /[A-Za-z]/.test(value)
  && /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}\p{M}]+$/u.test(value);
const required = () => { throw new Error('english_copy_required'); };

function reviewedMatch(card, match) {
  const identity = `pokemon:${card.language}:${card.setId}:${card.sourceUuid ?? card.uuid}`;
  if (identity !== match.identity || (card.identity !== undefined && card.identity !== match.identity)
    || ['sourceUuid', 'uuid'].some(key => card[key] !== undefined && card[key] !== match.sourceUuid)
    || card.language !== match.language || card.setId !== match.setId || card.cardNumber !== match.cardNumber
    || card.cardName !== match.rawCardName || card.originalName !== match.originalName || card.rarity !== match.rawRarity
    || (card.setCode !== undefined && card.setCode !== match.setCode)
    || (card.packName !== undefined && card.packName !== match.packName)) return false;
  const shareUrl = `https://api.jihuanshe.com/pro/cards/${match.sourceUuid}`;
  if (['shareUrl', 'sourceUrl'].some(key => card[key] !== undefined && card[key] !== shareUrl)) return false;
  const directory = resolve(ROOT, 'output/app-packs', match.setId, match.sourceUuid);
  try {
    if (typeof card.evidenceDirectory !== 'string' || resolve(card.evidenceDirectory) !== directory
      || digest(readFileSync(resolve(directory, 'context.json'))) !== match.contextSha256
      || digest(readFileSync(resolve(directory, 'image/card.png'))) !== match.imageSha256) return false;
    const images = [];
    if (Object.hasOwn(card, 'imageSha256') || Object.hasOwn(card, 'imagePath')) {
      images.push({ sha256: card.imageSha256, path: card.imagePath });
    }
    if (card.image !== undefined) images.push(card.image);
    const approvedImages = [{ path: resolve(directory, 'image/card.png'), sha256: match.imageSha256 },
      ...(match.alternateImages ?? []).map(image => ({ path: resolve(ROOT, image.path), sha256: image.sha256 }))];
    return images.length > 0 && images.every(image => {
      const approved = image && typeof image.path === 'string' && approvedImages.find(candidate =>
        image.sha256 === candidate.sha256 && resolve(image.path) === candidate.path);
      return approved && digest(readFileSync(approved.path)) === approved.sha256;
    });
  } catch { return false; }
}

/** Display copy only. Capture names and identity evidence are never modified. */
export function englishCardCopy(card, { strict = true } = {}) {
  const original = typeof card.originalName === 'string' ? card.originalName.trim() : '';
  const name = original || card.cardName;
  const cardName = lookup(CARD_NAMES, name) ?? (original && english(original) || knownEnglishNames.has(name) ? name : null);
  const rarity = lookup(RARITIES, card.rarity) ?? (english(card.rarity) ? card.rarity : null);
  const copy = { cardName, rarity, missing: [] };
  const reviewed = [card.sourceUuid, card.uuid, typeof card.identity === 'string' ? card.identity.split(':').at(-1) : null]
    .map(uuid => reviewedByUuid.get(uuid)).find(Boolean);
  if (reviewed) {
    if (reviewedMatch(card, reviewed)) Object.assign(copy, reviewed.displayOverrides);
    else copy.missing.push('reviewed_copy_evidence');
  }
  if (Object.hasOwn(card, 'packName')) copy.packName = lookup(SET_NAMES, card.packName) ?? (english(card.packName) ? card.packName : null);
  for (const field of ['cardName', 'rarity', ...(Object.hasOwn(copy, 'packName') ? ['packName'] : [])]) {
    if (copy[field] === null) copy.missing.push(field);
  }
  copy.ready = copy.missing.length === 0;
  if (strict && !copy.ready) required();
  return copy;
}

/** Translate only the reviewed set token in existing display labels. */
export function englishPackTitle(value) {
  if (value === undefined) return undefined;
  let title = value;
  if (typeof title !== 'string') required();
  for (const [source, translated] of Object.entries(SET_NAMES)) title = title.replaceAll(source, translated);
  if (!english(title)) required();
  return title;
}
