import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';

const descriptors = [];
try {
  const options = JSON.parse(readFileSync(0, 'utf8'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS'].includes(key.toUpperCase())) delete env[key];
  }
  for (const path of [options.stdout, options.stderr]) descriptors.push(openSync(path, 'wx'));
  const child = spawn(options.executable, options.arguments, {
    cwd: options.cwd, env, detached: true, windowsHide: options.windowsHide !== false, shell: false,
    stdio: ['ignore', ...descriptors],
  });
  await once(child, 'spawn');
  child.unref();
  process.stdout.write(JSON.stringify({ pid: child.pid }));
} catch (error) {
  process.stderr.write(`Detached emulator launch failed: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  for (const descriptor of descriptors) closeSync(descriptor);
}
