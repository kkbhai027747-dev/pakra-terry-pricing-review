import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJson } from './files.mjs';

const execute = promisify(execFile);

function androidState(output) {
  const text = String(output).trim().toLowerCase();
  if (text === 'device') return 'connected';
  if (/more than one (?:device|emulator)|multiple (?:devices|emulators)/.test(text)) return 'multiple_devices';
  if (text.includes('unauthorized')) return 'unauthorized';
  if (text.includes('offline')) return 'offline';
  if (/no devices?(?:\/emulators?)? (?:found|connected)|device .+ not found/.test(text)) return 'not_connected';
  return 'unavailable';
}

function androidReport(status) {
  const messages = {
    connected: 'Android connection is available; the price collector still requires validation.',
    not_connected: 'The selected Android transport has no connected device. No fallback or connection command was attempted.',
    unauthorized: 'Android debugging authorization is required on the device. No settings were changed.',
    offline: 'The Android device is offline. No reconnect or App launch was attempted.',
    multiple_devices: 'More than one device matches the selected transport. Connect only one; no device was chosen.',
    unavailable: 'Android state check failed. No desktop action or App launch was attempted.',
  };
  return { status, message: messages[status] };
}

export async function checkAndroid(config, run = execute) {
  const android = config.android;
  if (typeof android?.adbPath !== 'string' || !existsSync(android.adbPath)) return { status: 'missing', message: 'Configured ADB executable not found.' };
  const transport = android.transport ?? (android.serial === undefined ? 'usb' : 'serial');
  const invalidConfiguration = { status: 'invalid', message: 'Use USB or the legacy local serial on port 5037, or emulator-5580 on local port 15037. Host overrides are not supported.' };
  if (android.host !== undefined || android.serverHost !== undefined) return invalidConfiguration;
  const defaultServer = android.serverPort === undefined || android.serverPort === 5037;
  let serverPort = '5037';
  let selection;
  if (transport === 'usb' && android.serial === undefined && defaultServer) selection = ['-d'];
  else if (transport === 'serial' && android.serial === '127.0.0.1:5555' && defaultServer) selection = ['-s', android.serial];
  else if (transport === 'emulator' && android.serial === 'emulator-5580' && android.serverPort === 15037) {
    selection = ['-s', android.serial];
    serverPort = '15037';
  } else return invalidConfiguration;
  try {
    const { stdout } = await run(android.adbPath, ['-H', '127.0.0.1', '-P', serverPort, ...selection, 'get-state'], {
      windowsHide: true, shell: false, timeout: 5000, maxBuffer: 8192,
    });
    return androidReport(androidState(stdout));
  } catch (error) {
    // Do not persist command output, device identifiers, or environment details.
    return androidReport(androidState(`${error.stdout || ''}\n${error.stderr || ''}`));
  }
}

export async function checkReadiness(config, configDirectory, { androidCheck = checkAndroid } = {}) {
  const outputDir = resolve(configDirectory, config.outputDir);
  const mappingPath = resolve(configDirectory, config.mappingFile);
  const catalogPath = resolve(outputDir, 'catalog.json');
  const mapping = existsSync(mappingPath) ? readJson(mappingPath) : [];
  const catalog = existsSync(catalogPath) ? readJson(catalogPath) : null;
  const enabledMappings = Array.isArray(mapping) ? mapping.filter((row) => row?.enabled === true).length : 0;
  const catalogCards = Array.isArray(catalog?.cards) ? catalog.cards.length : 0;
  const android = await androidCheck(config);
  const appCatalogCards = Array.isArray(catalog?.cards) ? catalog.cards.filter((card) => card.sourceKind === 'official_app_ui').length : 0;
  const blockers = ['App minimum observations require pricing eligibility verification before online price changes.'];
  if (android.status !== 'connected') blockers.push(`Android connection: ${android.status}.`);
  if (!catalogCards) blockers.push('No verified exact-pack card catalog.');
  if (!enabledMappings) blockers.push('No enabled exact Shopify single-card mappings.');
  if (!['fixed', 'actual', 'excluded', 'per_order'].includes(config.shipping?.mode)) blockers.push('Procurement shipping rule is unconfirmed.');
  if (config.shipping?.mode === 'per_order') blockers.push('Per-order shipping requires an explicit purchase group and card quantity in each quote.');
  if (!existsSync(config.shopifyCliPath)) blockers.push('Configured Shopify CLI path was not found.');
  return {
    checkedAt: new Date().toISOString(), status: 'blocked', desktopInteraction: false,
    android, collector: 'pilot_ui_observations_only', catalogCards, appCatalogCards, enabledMappings, blockers,
    nextStep: 'Verify pack coverage, listed variant mappings and pricing eligibility before enabling the daily synchronization task. This check never launches the App.',
  };
}
