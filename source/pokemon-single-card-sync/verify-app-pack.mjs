import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverAppDetailIdentity } from './app-pack-detail.mjs';
import { readJson, sha256 } from './files.mjs';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const SHARE = new RegExp(`^https://api\\.jihuanshe\\.com/pro/cards/(${UUID})$`);
const PACK_KEYS = ['language', 'setId', 'setCode', 'packName'];
const CARD_KEYS = [...PACK_KEYS, 'cardName', 'cardNumber', 'shareUrl'];
const IDENTITY_KEYS = [...CARD_KEYS, 'languageLabel', 'originalName'];
const LABELS = { 'zh-Hans': '简中', ja: '日文', en: '英文' };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const equalFields = (a, b, keys) => keys.every((key) => a?.[key] === b?.[key]);

function file(root, relative) {
  const path = resolve(root, relative);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_evidence_file');
  return readFileSync(path);
}
function json(root, relative) {
  try { return JSON.parse(file(root, relative).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'invalid_evidence_file') throw error; fail('invalid_evidence_json'); }
}
function digest(bytes, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha256(bytes) !== expected) fail('evidence_hash_mismatch');
}
function pngSize(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') fail('invalid_evidence_png');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) fail('invalid_evidence_png');
  return { width, height };
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail('invalid_evidence_time');
  return Date.parse(value);
}
function verifyFrame(root, stem, entry) {
  if (!entry) fail('missing_frame_evidence');
  timestamp(entry.capturedAt);
  const xml = file(root, `${stem}.xml`), png = file(root, `${stem}.png`), nodes = file(root, `${stem}.nodes.json`);
  digest(xml, entry.xmlSha256); digest(png, entry.pngSha256); digest(nodes, entry.nodesSha256);
  const size = pngSize(png);
  if (size.width !== 720 || size.height !== 1280) fail('unexpected_screen_size');
  return { nodes: JSON.parse(nodes.toString('utf8').replace(/^\uFEFF/, '')), size };
}
function rectangle(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value || '');
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}
function verifyGallery(nodes, context, crop) {
  if (!Array.isArray(nodes) || !nodes.length) fail('invalid_gallery_nodes');
  nodes.forEach((node, index) => {
    if (!node || node.package !== 'com.jihuanshe.pro' || node.class === 'android.widget.EditText'
      || node.password === true || node.password === 'true'
      || /登录|注册|验证码|手机号|手机号码|密码/.test(`${node.text || ''} ${node['content-desc'] || ''}`)
      || (node.parentIndex !== null && (!Number.isInteger(node.parentIndex) || node.parentIndex < 0 || node.parentIndex >= index))) fail('invalid_gallery_nodes');
  });
  const labels = [context.cardName, context.cardNumber, context.packName, LABELS[context.language]];
  if (labels.some((label) => !nodes.some((node) => node.text === label))
    || nodes.filter((node) => node.class === 'android.widget.Button' && node['content-desc'] === '关闭').length !== 1) fail('gallery_identity_mismatch');
  const crops = nodes.filter((node) => node.class === 'android.widget.ImageView').map((node) => rectangle(node.bounds))
    .filter((box) => box && box.right - box.left >= 200 && box.bottom - box.top >= 280
      && (box.right - box.left) / (box.bottom - box.top) >= 0.66
      && (box.right - box.left) / (box.bottom - box.top) <= 0.76
      && box.left >= 0 && box.right <= 720 && box.top >= 140 && box.top <= 400 && box.bottom <= 900);
  const unique = [...new Map(crops.map((box) => [JSON.stringify(box), box])).values()];
  if (unique.length !== 1 || !equalFields(crop, unique[0], ['left', 'top', 'right', 'bottom'])) fail('image_crop_mismatch');
  for (const node of nodes.filter((item) => item.text)) {
    const box = rectangle(node.bounds);
    if (!box || (Math.max(box.left, crop.left) < Math.min(box.right, crop.right)
      && Math.max(box.top, crop.top) < Math.min(box.bottom, crop.bottom))
      || (labels.includes(node.text) && box.top < crop.bottom)) fail('gallery_image_obscured');
  }
}

/** Read and verify one finished UUID directory. Absolute paths in metadata are archival, never read targets. */
export function verifyCapturedCard(directory, expectedContext, expectedCard) {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
    || !lstatSync(resolve(root, 'image')).isDirectory() || lstatSync(resolve(root, 'image')).isSymbolicLink()) fail('invalid_card_directory');
  const contextBytes = file(root, 'context.json');
  const context = JSON.parse(contextBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const match = SHARE.exec(context.shareUrl || '');
  if (!match || basename(root) !== match[1] || !equalFields(context, expectedContext, PACK_KEYS)
    || !equalFields(context, expectedCard, ['cardName', 'cardNumber'])
    || context.languageLabel !== LABELS[context.language]
    || (expectedContext.shareUrl !== undefined && expectedContext.shareUrl !== context.shareUrl)) fail('card_context_mismatch');
  const evidence = json(root, 'evidence.json');
  if (evidence.source !== 'jihuanshe' || evidence.method !== 'official_app_copy_link_then_header_check'
    || evidence.shareUrl !== context.shareUrl) fail('card_evidence_mismatch');
  const header = verifyFrame(root, 'header', evidence.header);
  const identity = discoverAppDetailIdentity(header.nodes, expectedContext, expectedCard);
  if (!equalFields(context, identity.context, IDENTITY_KEYS.filter((key) => key !== 'shareUrl'))) fail('header_identity_mismatch');
  const gallery = verifyFrame(root, 'gallery', evidence.gallery);
  if (timestamp(evidence.gallery.capturedAt) < timestamp(evidence.header.capturedAt)) fail('invalid_capture_sequence');
  const image = json(root, 'image/image.json');
  if (image.sourceKind !== 'app_screenshot_crop' || image.originalImage !== false || image.pixelsUnchanged !== true
    || !equalFields(image.card, context, CARD_KEYS)) fail('image_identity_mismatch');
  digest(contextBytes, image.source?.contextSha256);
  if (image.source?.pngSha256 !== evidence.gallery.pngSha256 || image.source?.uiSha256 !== evidence.gallery.xmlSha256
    || image.source.width !== 720 || image.source.height !== 1280) fail('image_source_mismatch');
  verifyGallery(gallery.nodes, context, image.crop);
  const cardBytes = file(root, 'image/card.png');
  digest(cardBytes, image.sha256);
  const size = pngSize(cardBytes);
  if (image.bytes !== cardBytes.length || !equalFields(size, image, ['width', 'height'])
    || image.width !== image.crop.right - image.crop.left || image.height !== image.crop.bottom - image.crop.top) fail('image_dimensions_mismatch');
  return { context, uuid: match[1], cardNumber: context.cardNumber, headerVerified: true, imageVerified: true,
    image: { path: resolve(root, 'image/card.png'), sha256: image.sha256, ...size,
      sourceKind: 'app_screenshot_crop', originalImage: false } };
}

function acceptedListing(listingPath) {
  const listingBytes = readFileSync(resolve(listingPath)), listing = readJson(resolve(listingPath));
  if (listing.kind !== 'public_listing_observations' || !Array.isArray(listing.observations) || !listing.observations.length
    || listing.distinctCardNumbers !== listing.observations.length || listing.displayedCardCount !== listing.observations.length
    || listing.endObserved !== true || listing.missingCount !== 0) fail('incomplete_reference_listing');
  const expected = new Map();
  for (const card of listing.observations) {
    if (typeof card.cardNumber !== 'string' || !card.cardNumber || typeof card.cardName !== 'string' || !card.cardName
      || expected.has(card.cardNumber)) fail('invalid_reference_listing');
    expected.set(card.cardNumber, card);
  }
  return { listingBytes, listing, expected };
}

export function verifyAppPack(directory, listingPath) {
  const root = resolve(directory), { listingBytes, listing, expected } = acceptedListing(listingPath);
  const progress = json(root, 'progress.json');
  if (progress.kind !== 'pack_identity_capture' || !Array.isArray(progress.cards)
    || !equalFields(progress.context, listing.context, PACK_KEYS) || progress.referenceSha256 !== sha256(listingBytes)) fail('progress_reference_mismatch');
  const seenNumbers = new Set(), seenUrls = new Set(), cards = [], invalidCards = [];
  for (const card of progress.cards) {
    const match = SHARE.exec(card.shareUrl || '');
    const reference = expected.get(card.cardNumber);
    if (!match || !reference || !equalFields(card, listing.context, PACK_KEYS)
      || card.cardName !== reference.cardName || seenNumbers.has(card.cardNumber) || seenUrls.has(card.shareUrl)) fail('invalid_progress_card');
    seenNumbers.add(card.cardNumber); seenUrls.add(card.shareUrl);
    try {
      const verified = verifyCapturedCard(resolve(root, match[1]), listing.context, reference);
      if (!equalFields(verified.context, card, IDENTITY_KEYS)) fail('progress_identity_mismatch');
      cards.push(verified);
    } catch (error) {
      invalidCards.push({ cardNumber: card.cardNumber, error: /^[a-z_]+$/.test(error.code || '') ? error.code : 'card_verification_failed' });
    }
  }
  const verifiedNumbers = new Set(cards.map((card) => card.cardNumber));
  const missing = listing.observations.filter((card) => !verifiedNumbers.has(card.cardNumber))
    .map(({ cardName, cardNumber }) => ({ cardName, cardNumber }));
  return { kind: 'app_pack_verification', context: listing.context, referenceSha256: sha256(listingBytes),
    expectedCards: expected.size, recordedCards: progress.cards.length, verifiedCards: cards.length,
    imagesVerified: cards.filter((card) => card.imageVerified).length,
    completePackEvidenceVerified: missing.length === 0 && invalidCards.length === 0,
    originalImagesCaptured: false, imageSourceKind: 'app_screenshot_crop', lowestAskingVerified: false,
    missing, invalidCards, cards };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      if (!['--directory', '--card-directory', '--listing', '--output'].includes(flag) || options[flag] || !args[index + 1] || args[index + 1].startsWith('--')) fail('invalid_arguments');
      options[flag] = args[index + 1];
    }
    if ((!options['--directory'] === !options['--card-directory']) || !options['--listing']) fail('invalid_arguments');
    let report;
    if (options['--card-directory']) {
      const { listing, expected } = acceptedListing(options['--listing']);
      const root = resolve(options['--card-directory']), context = json(root, 'context.json');
      const card = expected.get(context.cardNumber);
      if (!card) fail('card_not_in_reference_listing');
      report = verifyCapturedCard(root, listing.context, card);
    } else report = verifyAppPack(options['--directory'], options['--listing']);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options['--output']) writeFileSync(resolve(options['--output']), output, { flag: 'wx' });
    process.stdout.write(output);
    if (report.invalidCards?.length) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.code === 'EEXIST' ? 'output_already_exists'
      : /^[a-z_]+$/.test(error.code || '') ? error.code : 'verification_failed' }));
    process.exitCode = 1;
  }
}
