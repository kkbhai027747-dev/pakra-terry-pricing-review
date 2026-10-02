#Requires -Version 7.0
param([switch]$ObserveOnly, [switch]$NoNotify, [switch]$NotifyEnabled)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = 'D:\CODEX\pokemon-single-card-sync'
$watchdogDir = Join-Path $project 'output\watchdog'
$taskName = 'PakraPokemonPilotPackCapture'
$stopPath = Join-Path $project 'output\app-packs\stop.requested'
$statePath = Join-Path $watchdogDir 'state.json'
$watchdogLock = $null
$exitCode = 0
$state = @{ policy = @{} }
$report = [ordered]@{ kind = 'pack_watchdog_check'; at = [DateTime]::UtcNow.ToString('o'); status = 'checking'; mode = 'active' }
$packDefinitions = @(
    @{ packId = '100143'; count = 176; language = '中文'; listingFolder = 'sc-cards-full-02' },
    @{ packId = '100145'; count = 177; language = '日文'; listingFolder = 'jp-cards-full-02' },
    @{ packId = '100236'; count = 191; language = '英文'; listingFolder = 'en-cards-full-02' }
)

function Assert-LocalPath([string]$Value) {
    if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw 'invalid_monitor_path' }
    $full = [IO.Path]::GetFullPath($Value)
    if (-not $full.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or $full.Substring(3).Contains(':')) { throw 'monitor_path_outside_workspace' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'monitor_path_reparse_point' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}
function Read-LocalJson([string]$Path, [switch]$Optional) {
    $null = Assert-LocalPath $Path
    if ($Optional -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
}
function Save-LocalJson([string]$Path, $Value) {
    $null = Assert-LocalPath $Path
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}
function Invoke-LocalProcess([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 40) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $info.WorkingDirectory = $project
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
    try {
        if (-not $child.Start()) { throw 'monitor_child_start_failed' }
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($TimeoutSeconds * 1000)) {
            $child.Kill($true); $null = $child.WaitForExit(5000); throw 'monitor_child_timeout'
        }
        $text = $stdout.GetAwaiter().GetResult(); $null = $stderr.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { throw 'monitor_child_failed' }
        return $text | ConvertFrom-Json -AsHashtable
    } finally { $child.Dispose() }
}
function Get-CaptureTask {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
    $expected = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $project 'run-app-daily.ps1') + '" -PackManifestPath "' + (Join-Path $project 'pilot-pack-manifest.json') + '"'
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne $pwsh -or $actions[0].Arguments -ne $expected -or
        $actions[0].WorkingDirectory -ne $project -or $task.Principal.RunLevel -ne 'Limited' -or
        $task.Principal.LogonType -ne 'Interactive' -or $task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        @($task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0) {
        throw 'capture_task_definition_mismatch'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $user = [Security.Principal.NTAccount]::new($task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($user -ne $identity.User.Value) { throw 'capture_task_user_mismatch' }
    return $task
}
function Send-StatusNotification([string]$Message, [string]$Level = 'Info') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return Invoke-LocalProcess $windowsPowerShell @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'RemoteSigned', '-File', (Join-Path $project 'notify-pack-status.ps1'),
        '-Title', '宝可梦采集监控', '-Message', $Message, '-Level', $Level) 25
}
function Save-StatusHtml($Snapshot, $Decision, [string]$Mode) {
    $encode = { param($Value) [Net.WebUtility]::HtmlEncode([string]$Value) }
    $rows = @($Snapshot.packs | ForEach-Object {
        '<tr><td>' + (& $encode $_.packId) + '</td><td>' + (& $encode $_.recordedCount) + '/' + (& $encode $_.expectedCount) + '</td><td>' +
            $(if ($_.verificationPassed) { '整包独立核验通过' } else { '采集中 / 未完成整包核验' }) + '</td></tr>'
    }) -join ''
    $labels = @{ healthy = '采集正常'; progress = '采集有进展'; completed = '三包已完成'; recover = '正在恢复或等待恢复';
        wait_memory = '等待可用内存'; blocked = '需要处理'; user_stopped = '用户已停止'; stalled = '已请求正常退出，等待恢复' }
    $title = $labels[$Decision.classification]
    $displayCount = $(if ($null -eq $Snapshot.cardCount) { '未知' } else { [string]$Snapshot.cardCount })
    $html = @"
<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="30"><meta name="viewport" content="width=device-width,initial-scale=1"><title>宝可梦采集监控</title><style>body{font:16px system-ui;background:#f5f6fa;color:#202438;max-width:850px;margin:50px auto;padding:24px}main{background:white;border-radius:16px;padding:28px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #eee}p{line-height:1.6}a{color:#6544ad}.count{font-size:36px;font-weight:700}</style><main><h1>$(& $encode $title)</h1><p class="count">$displayCount / 544 张已保存</p><p>检查时间：$(& $encode ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')))（本机时间） · 模式：$(& $encode $Mode)<br>原因：$(& $encode $Decision.reason)</p><table><tr><th>卡包 ID</th><th>保存张数</th><th>核验状态</th></tr>$rows</table><p>每分钟自动检查。本页每 30 秒刷新；恢复、无法恢复、整包完成时发送 Windows 非模态通知。普通健康检查保持安静。</p><p>已保存图片包括展示截图；源站原图单独保存，不把截图当作原图。电脑需保持开机、登录且不休眠。</p><p><a href="../card-originals/index.html">查看 D 盘源站原图</a> · <a href="check.json">本次检查记录</a></p></main></html>
"@
    $htmlPath = Join-Path $watchdogDir 'status.html'
    $null = Assert-LocalPath $htmlPath
    [IO.File]::WriteAllText($htmlPath, $html, [Text.UTF8Encoding]::new($false))
}

try {
    if ($PSScriptRoot -ne $project) { throw 'unexpected_monitor_location' }
    $null = Assert-LocalPath $watchdogDir
    [IO.Directory]::CreateDirectory($watchdogDir) | Out-Null
    # The host mutex is an open exclusive handle. Capture locks are only inspected, never deleted.
    try { $watchdogLock = [IO.FileStream]::new((Join-Path $watchdogDir 'host.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { @{ status = 'already_running' } | ConvertTo-Json; exit 0 }
    $saved = Read-LocalJson $statePath -Optional
    if ($saved) { $state = $saved }
    if (-not $state.policy) { $state.policy = @{} }
    $observing = [bool]$ObserveOnly -or (Test-Path -LiteralPath (Join-Path $watchdogDir 'observe-only.requested'))
    $report.mode = $(if ($observing) { 'observe_only' } else { 'active' })
    $task = Get-CaptureTask
    $running = [string]$task.State -in @('Running', 'Queued')
    $pointerPath = Join-Path $project 'output\app-packs\background-job.json'
    $pointer = Read-LocalJson $pointerPath
    $runRoot = Join-Path $project 'output\app-daily-runtime'
    $runtimePath = Assert-LocalPath $pointer.runtimeReportPath
    if (-not $runtimePath.StartsWith($runRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($runtimePath) -ne 'run.json' -or $pointer.workflow -ne 'three_pilot_pack_catalogs') { throw 'invalid_capture_pointer' }
    $batchPath = Join-Path ([IO.Path]::GetDirectoryName($runtimePath)) 'packs\run.json'
    if ([IO.Path]::GetFullPath($pointer.batchReportPath) -ne $batchPath) { throw 'invalid_capture_pointer' }
    $runtimeReport = Read-LocalJson $runtimePath
    if ($runtimeReport.pid -ne $pointer.pid -or $runtimeReport.mode -ne 'pack_catalog') { throw 'runtime_pointer_identity_mismatch' }
    $batch = Read-LocalJson $batchPath -Optional
    if ($batch -and ($batch.kind -ne 'app_pack_batch_run' -or $batch.manifestPath -ne (Join-Path $project 'pilot-pack-manifest.json'))) { throw 'batch_pointer_identity_mismatch' }
    $rootProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$pointer.pid) -ErrorAction Stop
    if ($rootProcess) {
        $command = [string]$rootProcess.CommandLine
        if ($command -notlike ('*"' + (Join-Path $project 'run-app-daily.ps1') + '"*') -or
            $command -notlike ('*"' + (Join-Path $project 'pilot-pack-manifest.json') + '"*')) { throw 'capture_process_identity_mismatch' }
        $running = $true
    }
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $packs = @(); $total = 0; $lastCardAt = $null
    foreach ($definition in $packDefinitions) {
        $directory = Join-Path $project ('output\app-packs\' + $definition.packId)
        $progressPath = Join-Path $directory 'progress.json'
        $progress = Read-LocalJson $progressPath
        if ($progress.kind -ne 'pack_identity_capture' -or $progress.context.setId -ne $definition.packId -or
            $progress.cards -isnot [System.Array]) { throw 'invalid_pack_progress' }
        $count = @($progress.cards).Count
        if ($count -gt $definition.count) { throw 'pack_progress_count_exceeded' }
        $total += $count
        $savedAt = (Get-Item -LiteralPath $progressPath).LastWriteTimeUtc
        if ($null -eq $lastCardAt -or $savedAt -gt $lastCardAt) { $lastCardAt = $savedAt }
        $pack = @{ packId = $definition.packId; expectedCount = $definition.count; recordedCount = $count; verifiedCount = 0; verificationPassed = $false }
        if ($count -eq $definition.count) {
            $listing = 'D:\CODEX\output\pokemon-android-runtime\app-validation-20260926\' + $definition.listingFolder + '\observations.json'
            $verified = Invoke-LocalProcess $node @((Join-Path $project 'verify-app-pack.mjs'), '--directory', $directory, '--listing', $listing) 90
            $pack.verifiedCount = $verified.verifiedCards
            $pack.verificationPassed = $verified.kind -eq 'app_pack_verification' -and $verified.context.setId -eq $definition.packId -and
                $verified.expectedCards -eq $definition.count -and $verified.verifiedCards -eq $definition.count -and
                $verified.imagesVerified -eq $definition.count -and $verified.completePackEvidenceVerified -eq $true -and
                @($verified.missing).Count -eq 0 -and @($verified.invalidCards).Count -eq 0
        }
        $packs += $pack
    }
    $locks = @()
    foreach ($relative in @('output\app-daily-runtime.lock', 'output\app-pack-batches.lock', 'output\run.lock')) {
        $path = Assert-LocalPath (Join-Path $project $relative)
        if (Test-Path -LiteralPath $path) {
            $entry = @{ path = $relative; ownerPid = $null; ownerStatus = 'locked_or_unreadable' }
            try {
                $owner = Read-LocalJson $path
                if (($owner.pid -is [int] -or $owner.pid -is [long]) -and $owner.pid -gt 0 -and $owner.pid -le [int]::MaxValue) {
                    $entry.ownerPid = $owner.pid
                    $ownerProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner.pid) -ErrorAction Stop
                    $entry.ownerStatus = $(if ($ownerProcess) { 'process_present' } else { 'process_absent' })
                } else { $entry.ownerStatus = 'invalid_owner' }
            } catch { }
            $locks += $entry
        }
    }
    $reason = $(if ($batch -and $batch.status -eq 'stopped') { $batch.reason } elseif ($runtimeReport.status -eq 'stopped') { $runtimeReport.reason } else { $null })
    $childReason = $null
    if ($batch.currentPack.setId -in @('100143', '100145', '100236')) {
        $current = Read-LocalJson (Join-Path $project ('output\app-packs\' + $batch.currentPack.setId + '\current-run.json')) -Optional
        if ($current.status -eq 'capture_stopped' -and $current.at -and [DateTime]$current.at -ge [DateTime]$runtimeReport.startedAt) { $childReason = $current.reason }
    }
    $ownStop = $false; $userStop = $false
    if (Test-Path -LiteralPath $stopPath) {
        try {
            $marker = Read-LocalJson $stopPath
            $ownStop = $state.stopRequestId -and $marker.kind -eq 'pack_watchdog_stop' -and $marker.owner -eq 'PakraPokemonPackWatchdog' -and
                $marker.requestId -eq $state.stopRequestId -and $marker.runId -eq $runtimeReport.startedAt
        } catch { $ownStop = $false }
        $userStop = -not $ownStop
    }
    if (-not $running -and $locks.Count -gt 0) { $reason = 'capture_resources_still_locked'; $childReason = $null }
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $complete = $batch.status -eq 'pack_batches_completed' -and @($batch.completed).Count -eq 3 -and
        @($batch.completed | Select-Object -ExpandProperty setId -Unique).Count -eq 3 -and
        @($packs | Where-Object { -not $_.verificationPassed }).Count -eq 0
    foreach ($pack in $packs) {
        $entry = @($batch.completed | Where-Object { $_.setId -eq $pack.packId })
        if ($entry.Count -ne 1 -or $entry[0].verifiedCards -ne $pack.expectedCount -or $entry[0].imagesVerified -ne $pack.expectedCount -or
            $entry[0].completePackEvidenceVerified -ne $true) { $complete = $false }
    }
    $snapshot = @{ expectedCount = 544; cardCount = $total; running = [bool]$running; freeMemoryMb = [math]::Floor($os.FreePhysicalMemory / 1024);
        resourcesReleased = $locks.Count -eq 0 -and -not $running; reason = $reason; childReason = $childReason;
        userStopRequested = [bool]$userStop; stopRequestedByWatchdog = [bool]$ownStop; runId = $runtimeReport.startedAt;
        lastCardAt = $lastCardAt.ToString('o'); packs = $packs;
        report = @{ status = $(if ($complete) { 'completed' } else { 'incomplete' }); verificationPassed = [bool]$complete;
            expectedCount = 544; verifiedCount = ($packs | Measure-Object -Property verifiedCount -Sum).Sum } }
    $inputPath = Join-Path $watchdogDir 'policy-input.json'
    Save-LocalJson $inputPath @{ snapshot = $snapshot; state = $state.policy; now = [DateTime]::UtcNow.ToString('o') }
    $code = 'import {readFileSync} from "node:fs"; import {evaluateWatchdog} from "./pack-watchdog-policy.mjs"; const x=JSON.parse(readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify(evaluateWatchdog(x.snapshot,x.state,x.now)));'
    $decision = Invoke-LocalProcess $node @('--input-type=module', '-e', $code, $inputPath)
    $report.status = $decision.classification; $report.reason = $decision.reason; $report.action = $decision.action
    $report.snapshot = $snapshot; $report.captureLocks = $locks; $report.runtimeReportPath = $runtimePath
    if (-not $observing) {
        $state.policy = $decision.nextState
        $state.lastHostError = $null
        Save-LocalJson $statePath $state
        if ($decision.action -eq 'request_stop') {
            $state.stopRequestId = [guid]::NewGuid().ToString()
            Save-LocalJson $statePath $state
            $marker = @{ kind = 'pack_watchdog_stop'; owner = 'PakraPokemonPackWatchdog'; requestId = $state.stopRequestId;
                runId = $runtimeReport.startedAt; createdAt = [DateTime]::UtcNow.ToString('o') }
            $stream = [IO.FileStream]::new($stopPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $bytes = [Text.Encoding]::UTF8.GetBytes(($marker | ConvertTo-Json)); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            $report.actionResult = 'graceful_stop_requested'
        } elseif ($decision.action -eq 'restart') {
            $freshTask = Get-CaptureTask
            if ([string]$freshTask.State -in @('Running', 'Queued')) { throw 'capture_started_concurrently' }
            foreach ($relative in @('output\app-daily-runtime.lock', 'output\app-pack-batches.lock', 'output\run.lock')) {
                if (Test-Path -LiteralPath (Join-Path $project $relative)) { throw 'capture_lock_appeared_before_restart' }
            }
            if (Test-Path -LiteralPath $stopPath) {
                $freshMarker = Read-LocalJson $stopPath
                if (-not $ownStop -or $freshMarker.kind -ne 'pack_watchdog_stop' -or $freshMarker.owner -ne 'PakraPokemonPackWatchdog' -or
                    $freshMarker.requestId -ne $state.stopRequestId -or $freshMarker.runId -ne $runtimeReport.startedAt) { throw 'stop_marker_owner_changed' }
                Remove-Item -LiteralPath $stopPath
                $state.stopRequestId = $null; Save-LocalJson $statePath $state
            }
            $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
            $report.actionResult = Invoke-LocalProcess $pwsh @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-File', (Join-Path $project 'install-app-pack-task.ps1'), '-StartNow') 30
        }
        if (-not $NoNotify -and $decision.notify) {
            $level = $(if ($decision.notify.kind -eq 'blocked') { 'Error' } elseif ($decision.notify.kind -eq 'recover') { 'Warning' } else { 'Info' })
            $report.notification = Send-StatusNotification $decision.notify.message $level
        }
        if ($NotifyEnabled -and -not $NoNotify -and -not $state.enabledNotificationAt) {
            $report.enabledNotification = Send-StatusNotification '监控已启用：每分钟检查采集进度，故障时尝试有限恢复并主动提醒。健康检查保持安静。'
            $state.enabledNotificationAt = [DateTime]::UtcNow.ToString('o'); Save-LocalJson $statePath $state
        }
    }
    Save-StatusHtml $snapshot $decision $report.mode
} catch {
    $exitCode = 1
    $reason = $(if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'watchdog_host_failed' })
    $report.status = 'blocked'; $report.reason = $reason; $report.errorLine = $_.InvocationInfo.ScriptLineNumber
    if ($watchdogLock) {
        try {
            if (-not $snapshot) { $snapshot = @{ cardCount = $state.policy.lastCardCount; packs = @() } }
            Save-StatusHtml $snapshot @{ classification = 'blocked'; reason = $reason } $report.mode
        } catch { }
    }
    if ($watchdogLock -and -not $ObserveOnly -and -not $NoNotify -and $report.mode -ne 'observe_only' -and $state.lastHostError -ne $reason) {
        $state.lastHostError = $reason
        try { Save-LocalJson $statePath $state; $report.notification = Send-StatusNotification ('采集监控无法自动继续：' + $reason + '。请查看 D 盘监控状态。') 'Error' } catch { }
    }
} finally {
    if ($watchdogLock) {
        try {
            Save-LocalJson (Join-Path $watchdogDir 'check.json') $report
            if ($report.notification -or $report.enabledNotification -or ($report.action -and $report.action -ne 'none')) {
                $eventsDir = Assert-LocalPath (Join-Path $watchdogDir 'events')
                [IO.Directory]::CreateDirectory($eventsDir) | Out-Null
                $name = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N') + '.json'
                Save-LocalJson (Join-Path $eventsDir $name) $report
            }
        } finally { $watchdogLock.Dispose() }
    }
}
@{ status = $report.status; reason = $report.reason; action = $report.action; mode = $report.mode;
    cardCount = $report.snapshot.cardCount; statusPath = (Join-Path $watchdogDir 'status.html'); reportPath = (Join-Path $watchdogDir 'check.json') } | ConvertTo-Json
exit $exitCode
