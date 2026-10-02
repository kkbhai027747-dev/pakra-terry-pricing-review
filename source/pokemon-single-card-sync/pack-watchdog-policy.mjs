const MINUTE = 60_000;
const PILOT_PACKS = { '100143': 176, '100145': 177, '100236': 191 };
const RETRYABLE = new Set(['invalid_ui_xml', 'device_command_failed', 'device_command_timeout',
  'pack_controls_mismatch', 'detail_controls_mismatch', 'pack_return_failed', 'pack_evidence_incomplete']);
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const integer = (value) => Number.isInteger(value) && value >= 0;

/** Pure policy. The host must verify evidence before setting verificationPassed, and owns all side effects. */
export function evaluateWatchdog(snapshot, state = {}, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('invalid_watchdog_time');
  const at = new Date(nowMs).toISOString();
  const next = { ...state, version: 1, checkedAt: at,
    restartTimes: (Array.isArray(state.restartTimes) ? state.restartTimes : [])
      .filter((value) => time(value) !== null && time(value) > nowMs - 60 * MINUTE && time(value) <= nowMs),
    notifiedKeys: [...(Array.isArray(state.notifiedKeys) ? state.notifiedKeys : [])] };
  function result(classification, action, reason, notice) {
    let notify = null;
    if (notice && !next.notifiedKeys.includes(notice.key)) {
      notify = notice;
      next.notifiedKeys.push(notice.key);
    }
    return { classification, action, reason, notify, nextState: next };
  }
  const blocked = (reason) => result('blocked', 'none', reason,
    { key: `blocked:${reason}:${next.lastCardCount ?? 0}`, kind: 'blocked', message: `采集监控需要处理：${reason}` });
  if (!snapshot || snapshot.expectedCount !== 544 || !integer(snapshot.cardCount) || snapshot.cardCount > 544
    || typeof snapshot.running !== 'boolean') return blocked('invalid_snapshot');
  const previousCount = integer(state.lastCardCount) ? state.lastCardCount : snapshot.cardCount;
  if (snapshot.cardCount < previousCount) return blocked('card_count_regressed');
  const advanced = snapshot.cardCount > previousCount;
  next.lastCardCount = snapshot.cardCount;
  if (advanced) next.lastProgressAt = at;
  else if (time(next.lastProgressAt) === null) next.lastProgressAt = time(snapshot.lastCardAt) !== null
    && time(snapshot.lastCardAt) <= nowMs ? snapshot.lastCardAt : at;
  if (advanced) {
    next.consecutiveRestarts = 0;
    next.memoryWaitSince = null;
  } else if (!integer(next.consecutiveRestarts)) next.consecutiveRestarts = 0;

  if (snapshot.userStopRequested === true || (snapshot.reason === 'stop_requested'
    && snapshot.stopRequestedByWatchdog !== true && next.recoveryPending !== true)) {
    next.recoveryPending = false;
    return result('user_stopped', 'none', 'user_stop_requested');
  }
  const packs = Array.isArray(snapshot.packs) ? snapshot.packs : [];
  const validPack = (pack) => Object.hasOwn(PILOT_PACKS, String(pack?.packId))
    && pack.expectedCount === PILOT_PACKS[String(pack.packId)]
    && pack.verifiedCount === pack.expectedCount && pack.verificationPassed === true;
  const complete = snapshot.report?.status === 'completed' && snapshot.report.verificationPassed === true
    && snapshot.report.expectedCount === 544 && snapshot.report.verifiedCount === 544
    && snapshot.cardCount === 544 && packs.length === 3
    && new Set(packs.map((pack) => String(pack?.packId))).size === 3 && packs.every(validPack);
  if (complete) {
    next.recoveryPending = false;
    return result('completed', 'none', 'verified_pilot_complete',
      { key: 'completed:544', kind: 'completed', message: '三包宝可梦单卡已完成：544 张资料与图片通过独立核验。' });
  }
  if (snapshot.running) {
    if (next.recoveryPending === true || snapshot.stopRequestedByWatchdog === true)
      return result('stalled', 'none', 'awaiting_graceful_stop');
    const runStarted = time(snapshot.runId);
    const latestStart = Math.max(time(next.lastProgressAt), time(next.lastRestartAt) ?? 0,
      runStarted !== null && runStarted <= nowMs ? runStarted : 0);
    if (nowMs - latestStart >= 15 * MINUTE) {
      next.recoveryPending = true;
      return result('stalled', 'request_stop', 'no_card_progress_15_minutes',
        { key: `stalled:${next.lastProgressAt}`, kind: 'recover', message: '采集连续 15 分钟没有新增卡牌，已请求正常退出，待释放后尝试恢复。' });
    }
    const milestone = packs.find((pack) => validPack(pack) && !next.notifiedKeys.includes(`pack:${pack.packId}`));
    if (milestone) return result('progress', 'none', 'pack_verified',
      { key: `pack:${milestone.packId}`, kind: 'progress', message: `卡包 ${milestone.packId} 已完成，${milestone.verifiedCount} 张通过独立核验。` });
    return result(advanced ? 'progress' : 'healthy', 'none', advanced ? 'cards_added' : 'running');
  }
  const reason = snapshot.reason === 'capture_pack_failed' ? snapshot.childReason : snapshot.reason;
  const ownStop = next.recoveryPending === true && snapshot.stopRequestedByWatchdog === true && reason === 'stop_requested';
  if (!ownStop && !RETRYABLE.has(reason)) return blocked(reason || 'stopped_without_retryable_reason');
  if (snapshot.resourcesReleased === false) return result('recover', 'none', 'awaiting_resource_release');
  if (next.restartTimes.length >= 3) return blocked('hourly_restart_budget_exhausted');
  if (next.consecutiveRestarts >= 2) return blocked('no_progress_restart_budget_exhausted');
  if (time(next.lastRestartAt) !== null && nowMs - time(next.lastRestartAt) < 2 * MINUTE)
    return result('recover', 'none', 'restart_cooldown');
  if (!Number.isFinite(snapshot.freeMemoryMb) || snapshot.freeMemoryMb < 3072) {
    if (time(next.memoryWaitSince) === null) next.memoryWaitSince = at;
    if (nowMs - time(next.memoryWaitSince) >= 30 * MINUTE) return blocked('insufficient_memory_30_minutes');
    return result('wait_memory', 'none', 'insufficient_memory');
  }
  next.memoryWaitSince = null;
  next.lastRestartAt = at;
  next.restartTimes.push(at);
  next.consecutiveRestarts += 1;
  next.recoveryPending = false;
  return result('recover', 'restart', ownStop ? 'resume_after_graceful_stop' : reason,
    { key: `recover:${at}`, kind: 'recover', message: `正在从已保存的 ${snapshot.cardCount} 张卡牌继续采集。` });
}
