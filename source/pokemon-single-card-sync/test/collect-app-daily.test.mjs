import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectAppDaily } from '../collect-app-daily.mjs';
import { readJson, save } from '../files.mjs';

function fixture(t) {
  const outputRoot = mkdtempSync(join(tmpdir(), 'pakra-app-daily-'));
  t.after(() => {
    assert.equal(dirname(resolve(outputRoot)), resolve(tmpdir()));
    rmSync(outputRoot, { recursive: true, force: true });
  });
  const cards = [1, 2, 3, 4].map((index) => ({ language: 'zh-Hans', setId: '100143', setCode: '30thC',
    packName: '30周年庆典', cardName: `合成卡${index}`, cardNumber: `30thC-${index}/103`,
    shareUrl: `https://api.jihuanshe.com/pro/cards/00000000-0000-0000-0000-00000000000${index}`,
    ignoredPrivateField: 'must-never-be-persisted' }));
  const summarize = (captureDir) => {
    const context = readJson(join(dirname(captureDir), 'context.json'));
    return { status: 'observed', sourceUrl: context.shareUrl, quoteEligible: false,
      minimum: { amountCny: '90.00', conditionScope: 'app_unfiltered_version_minimum', quoteEligible: false,
        evidence: { capturedAt: '2026-09-26T12:00:00.000Z', xmlSha256: 'a'.repeat(64) } } };
  };
  return { outputRoot, cards, summarize };
}

test('captures only the selected batch in sequence, stores whitelisted context and releases the shared lock', async (t) => {
  const { outputRoot, cards, summarize } = fixture(t);
  const called = [];
  let active = false;
  const capture = async ({ contextPath, captureDir }) => {
    assert.equal(active, false);
    active = true;
    assert.equal(existsSync(join(outputRoot, 'run.lock')), true);
    assert.equal(existsSync(captureDir), false);
    called.push(readJson(contextPath).cardNumber);
    assert.ok(!readFileSync(contextPath, 'utf8').includes('must-never-be-persisted'));
    await Promise.resolve();
    active = false;
  };
  const result = await collectAppDaily({ cards, offset: 1, limit: 2 }, { outputRoot, capture, summarize });
  assert.deepEqual(called, ['30thC-2/103', '30thC-3/103']);
  assert.equal(result.status, 'observations_only');
  assert.equal(result.attempted, 2);
  assert.equal(result.observed, 2);
  assert.equal(result.quoteEligible, false);
  assert.equal(result.cards[0].amountCny, '90.00');
  assert.equal(result.cards[0].observedAt, '2026-09-26T12:00:00.000Z');
  assert.equal(existsSync(join(outputRoot, 'run.lock')), false);
  assert.equal(readJson(result.reportPath).status, 'observations_only');
});

test('login or device failure stops later cards and never records child output or exception details', async (t) => {
  const { outputRoot, cards, summarize } = fixture(t);
  let calls = 0;
  const capture = async ({ captureDir }) => {
    calls++;
    if (calls === 2) {
      save(join(captureDir, 'failure.json'), { status: 'capture_stopped', stage: 'validate_public_detail', reason: 'login_or_private_input' });
      throw new Error('private-command-output');
    }
  };
  const result = await collectAppDaily({ cards, limit: 3 }, { outputRoot, capture, summarize });
  assert.equal(calls, 2);
  assert.equal(result.status, 'stopped');
  assert.equal(result.cards[1].reason, 'login_or_private_input');
  assert.equal(result.cards[2].status, 'not_attempted');
  assert.ok(!readFileSync(result.reportPath, 'utf8').includes('private-command-output'));
  assert.equal(existsSync(join(outputRoot, 'run.lock')), false);
  const unknown = await collectAppDaily({ cards, limit: 1 }, { outputRoot, summarize,
    capture: async () => { throw new Error('arbitrary-sensitive-error'); } });
  assert.equal(unknown.cards[0].reason, 'capture_process_failed');
  assert.ok(!JSON.stringify(unknown).includes('arbitrary-sensitive-error'));
});

test('a missing minimum remains null and permits the next explicit card, while invalid evidence stops', async (t) => {
  const { outputRoot, cards, summarize } = fixture(t);
  let calls = 0;
  const capture = async ({ captureDir }) => {
    if (++calls === 1) {
      save(join(captureDir, 'failure.json'), { status: 'capture_stopped', stage: 'read_explicit_minimum_label', reason: 'version_control_missing' });
      throw new Error('missing minimum');
    }
  };
  const result = await collectAppDaily({ cards, limit: 2 }, { outputRoot, capture, summarize });
  assert.equal(calls, 2);
  assert.equal(result.status, 'observations_only');
  assert.equal(result.notExactMinimum, 1);
  assert.equal(result.cards[0].amountCny, null);
  assert.ok(!('available' in result.cards[0]));
  const invalid = await collectAppDaily({ cards, limit: 2 }, { outputRoot, capture: async () => {},
    summarize: () => { throw new Error('hash mismatch with private contents'); } });
  assert.equal(invalid.status, 'stopped');
  assert.equal(invalid.attempted, 1);
  assert.equal(invalid.cards[0].reason, 'evidence_validation_failed');
});

test('invalid ranges, duplicate contexts and an occupied device lock never invoke the collector', async (t) => {
  const { outputRoot, cards, summarize } = fixture(t);
  const capture = async () => { assert.fail('collector must not run'); };
  for (const selection of [{ offset: -1, limit: 1 }, { offset: 4, limit: 1 }, { offset: 0, limit: 101 }]) {
    await assert.rejects(collectAppDaily({ cards, ...selection }, { outputRoot, capture, summarize }), /Invalid offset or limit/);
  }
  await assert.rejects(collectAppDaily({ cards: [cards[0], cards[0]], limit: 2 }, { outputRoot, capture, summarize }), /duplicate/);
  assert.deepEqual(readdirSync(outputRoot), []);
  save(join(outputRoot, 'run.lock'), { pid: process.pid });
  await assert.rejects(collectAppDaily({ cards, limit: 1 }, { outputRoot, capture, summarize }), /Another run exists/);
});
