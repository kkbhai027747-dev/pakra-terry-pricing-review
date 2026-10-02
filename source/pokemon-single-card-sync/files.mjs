import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export async function withLock(directory, action) {
  mkdirSync(directory, { recursive: true });
  const lock = resolve(directory, 'run.lock');
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another run exists. If it crashed, verify its PID before removing output/run.lock.'); throw error; }
  try { return await action(); } finally { unlinkSync(lock); }
}
