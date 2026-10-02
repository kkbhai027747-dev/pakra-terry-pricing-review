#Requires -Version 7.0
param([ValidateSet(0, 20)][int]$StartOffset)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = 'D:\CODEX\pokemon-single-card-sync'
$queueRoot = 'D:\CODEX\output\pokemon-v9-listing-20260927\quote-queue'
$requestPath = Join-Path $queueRoot 'request.json'
$cardsPath = 'D:\CODEX\output\pokemon-v9-listing-20260927\listing-full\quote-contexts.json'
$catalogPath = 'D:\CODEX\output\pokemon-v9-listing-20260927\listing-full\quote-catalog.json'
$markerPath = Join-Path $project 'output\watchdog\observe-only.requested'
$captureTaskName = 'PakraPokemonPilotPackCapture'
$queueLock = $null; $runDir = $null; $request = $null; $child = $null; $exitCode = 1
$report = [ordered]@{ kind = 'listing_quote_queue'; status = 'in_progress'; stage = 'configuration'; pid = $PID
    startedAt = [DateTime]::UtcNow.ToString('o'); expectedCards = 200; completedBatches = @(); currentBatch = $null;
    attempted = 0; observed = 0; verifiedQuotes = 0; freshQuotes = 0; unquoted = 0; reason = $null; markerCleanup = 'not_owned' }

function Assert-QueuePath([string]$Value) {
    if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw 'invalid_queue_path' }
    $full = [IO.Path]::GetFullPath($Value)
    if (-not $full.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or $full.Substring(3).Contains(':')) { throw 'queue_path_outside_workspace' }
    for ($cursor = $full; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'queue_path_reparse_point' }
    }
    return $full
}
function Read-QueueJson([string]$Path) {
    $null = Assert-QueuePath $Path
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
}
function Save-QueueJson([string]$Path, $Value) {
    $null = Assert-QueuePath $Path
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}
function Save-QueueStatus([string]$Stage) {
    $report.stage = $Stage; $report.updatedAt = [DateTime]::UtcNow.ToString('o')
    if ($runDir) { Save-QueueJson (Join-Path $runDir 'status.json') $report }
    Save-QueueJson (Join-Path $queueRoot 'status.json') $report
}
function Get-QuoteBatches([int]$Offset) {
    if ($Offset -notin @(0, 20)) { throw 'invalid_queue_start_offset' }
    if ($Offset -eq 0) { @{ offset = 0; limit = 20 } }
    @{ offset = 20; limit = 100 }
    @{ offset = 120; limit = 80 }
}
function Test-QueueMarker([string]$OperationId) {
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
    try {
        $marker = Read-QueueJson $markerPath
        return $marker.owner -ceq 'listing_quote_queue' -and $marker.operationId -ceq $OperationId
    } catch { return $false }
}
function Assert-QueueDeviceIdle {
    foreach ($relative in @('output\app-daily-runtime.lock', 'output\app-pack-batches.lock', 'output\run.lock')) {
        if (Test-Path -LiteralPath (Assert-QueuePath (Join-Path $project $relative))) { throw 'queue_device_lock_present' }
    }
    $task = Get-ScheduledTask -TaskName $captureTaskName -ErrorAction Stop
    $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $project 'run-app-daily.ps1') + '" -PackManifestPath "' + (Join-Path $project 'pilot-pack-manifest.json') + '"'
    $actions = @($task.Actions)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $taskUser = $task.Principal.UserId
    if ($taskUser -notlike 'S-1-*') { $taskUser = [Security.Principal.NTAccount]::new($taskUser).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne $pwsh -or $actions[0].Arguments -ne $arguments -or
        $actions[0].WorkingDirectory -ne $project -or $task.Principal.RunLevel -ne 'Limited' -or
        $task.Principal.LogonType -ne 'Interactive' -or $taskUser -ne $identity.User.Value -or
        @($task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0 -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'capture_task_definition_mismatch' }
    if ([string]$task.State -in @('Running', 'Queued')) { throw 'queue_capture_task_running' }
}
function Get-QueueMemoryDecision([long]$FreeMb, [double]$WaitSeconds) {
    if ($FreeMb -ge 3072) { return 'ready' }
    if ($WaitSeconds -ge 1800) { return 'blocked' }
    return 'wait'
}
function Wait-QueueMemory {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        if (-not (Test-QueueMarker $request.operationId)) { throw 'quote_queue_handoff_lost' }
        Assert-QueueDeviceIdle
        $freeMb = [math]::Floor((Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory / 1024)
        $report.freeMemoryMb = $freeMb; $report.memoryWaitSeconds = [int]$watch.Elapsed.TotalSeconds
        switch (Get-QueueMemoryDecision $freeMb $watch.Elapsed.TotalSeconds) {
            ready { return }
            blocked { throw 'quote_queue_insufficient_memory_30_minutes' }
            wait { Save-QueueStatus 'wait_memory'; Start-Sleep -Seconds 30 }
        }
    }
}
function Invoke-QueueUtility([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 90) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WorkingDirectory = $project
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'queue_utility_start_failed' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill($true); $null = $process.WaitForExit(5000); throw 'queue_utility_timeout' }
        $text = $stdout.GetAwaiter().GetResult(); $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'queue_utility_failed' }
        return $text | ConvertFrom-Json -AsHashtable
    } finally { $process.Dispose() }
}
function Find-QueueRuntime([int]$ChildPid, [int]$Offset, [int]$Limit) {
    $directory = Join-Path $project 'output\app-daily-runtime'
    foreach ($folder in @(Get-ChildItem -LiteralPath $directory -Directory | Sort-Object Name -Descending | Select-Object -First 12)) {
        $path = Join-Path $folder.FullName 'run.json'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            $run = Read-QueueJson $path
            if ($run.pid -eq $ChildPid -and $run.mode -eq 'daily_prices' -and $run.offset -eq $Offset -and $run.limit -eq $Limit -and
                ([DateTime]$run.startedAt).ToUniversalTime() -ge ([DateTime]$report.currentBatch.startedAt).ToUniversalTime()) { return $path }
        } catch { }
    }
    return $null
}
function Update-QueueLiveObservations {
    # The runtime records its collector pointer only when it exits; bind the live local report to this batch.
    $batch = $report.currentBatch
    if (-not $batch.collectorReportPath) {
        foreach ($folder in @(Get-ChildItem -LiteralPath (Join-Path $project 'output\app-daily') -Directory | Sort-Object Name -Descending | Select-Object -First 6)) {
            try {
                $path = Join-Path $folder.FullName 'report.json'; $candidate = Read-QueueJson $path
                if ($candidate.kind -eq 'app_daily_public_observations' -and ([DateTime]$candidate.startedAt).ToUniversalTime() -ge ([DateTime]$batch.startedAt).ToUniversalTime() -and
                    $candidate.selection.offset -eq $batch.offset -and $candidate.selection.limit -eq $batch.limit -and $candidate.selection.inputCount -eq 200 -and
                    $candidate.cards[0].sourceUrl -ceq $cards[$batch.offset].shareUrl) { $batch.collectorReportPath = $path; break }
            } catch { }
        }
    }
    if ($batch.collectorReportPath) {
        try {
            $live = Read-QueueJson $batch.collectorReportPath
            $batch.observed = @($live.cards | Where-Object status -eq 'observed').Count
            $batch.notExactMinimum = @($live.cards | Where-Object status -eq 'not_exact_minimum').Count
            $batch.lastObservedAt = @($live.cards | Where-Object observedAt | Sort-Object observedAt -Descending | Select-Object -First 1)[0].observedAt
        } catch { }
    }
}
function Verify-QueueBatch([string]$RuntimePath, [int]$Offset, [int]$Limit, [switch]$Prior) {
    $runtimePath = Assert-QueuePath $RuntimePath
    if (-not $runtimePath.StartsWith((Join-Path $project 'output\app-daily-runtime\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'queue_runtime_path_mismatch' }
    $runtime = Read-QueueJson $runtimePath
    if ($runtime.status -ne 'observations_only' -or $runtime.mode -ne 'daily_prices' -or $runtime.offset -ne $Offset -or $runtime.limit -ne $Limit) { throw 'queue_runtime_not_completed' }
    $collectorPath = Assert-QueuePath $runtime.collectorReportPath
    if (-not $collectorPath.StartsWith((Join-Path $project 'output\app-daily\'), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($collectorPath) -ne 'report.json') { throw 'queue_collector_path_mismatch' }
    $collector = Read-QueueJson $collectorPath
    if ($collector.kind -ne 'app_daily_public_observations' -or $collector.status -ne 'observations_only' -or
        $collector.attempted -ne $Limit -or $collector.selection.offset -ne $Offset -or $collector.selection.selected -ne $Limit -or
        $collector.selection.limit -ne $Limit -or ($collector.selection.inputCount -ne 200 -and -not ($Prior -and $Offset -eq 0 -and $collector.selection.inputCount -eq 20))) { throw 'queue_collector_selection_mismatch' }
    $verifiedPath = Join-Path $runDir ('batch-{0:D3}-{1:D3}-verified.json' -f $Offset, $Limit)
    $code = @'
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {verifyAppDailyQuotes} from './app-quotes.mjs';
import {listingPrice} from './prepare-listings.mjs';
const [collectorPath,catalogPath,cardsPath,offsetText,limitText,out]=process.argv.slice(1);
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const catalog=read(catalogPath).cards, cards=read(cardsPath), offset=Number(offsetText), limit=Number(limitText);
const verified=verifyAppDailyQuotes(dirname(collectorPath),catalog);
const expected=cards.slice(offset,offset+limit).map(c=>`pokemon:${c.language}:${c.setId}:${c.shareUrl.split('/').at(-1)}`);
if(JSON.stringify(verified.targetIdentities)!==JSON.stringify(expected) || verified.quotes.length+verified.unquoted.length!==limit) throw new Error('quote_batch_identity_mismatch');
writeFileSync(out,JSON.stringify(verified,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({verifiedQuotes:verified.quotes.length,unquoted:verified.unquoted.length,
 freshQuotes:verified.quotes.filter(q=>listingPrice(q,q.identity).price!==null).length,verifiedPath:out}));
'@
    $verified = Invoke-QueueUtility $node @('--input-type=module', '-e', $code, $collectorPath, $catalogPath, $cardsPath, [string]$Offset, [string]$Limit, $verifiedPath)
    return @{ offset = $Offset; limit = $Limit; status = 'verified'; runtimeReportPath = $runtimePath; collectorReportPath = $collectorPath;
        attempted = $collector.attempted; observed = $collector.observed; verifiedQuotes = $verified.verifiedQuotes;
        freshQuotes = $verified.freshQuotes; unquoted = $verified.unquoted; verifiedPath = $verifiedPath; cleanup = $runtime.cleanup }
}
function Update-QueueTotals {
    foreach ($name in @('attempted', 'observed', 'verifiedQuotes', 'freshQuotes', 'unquoted')) {
        $report[$name] = [int](($report.completedBatches | Measure-Object -Property $name -Sum).Sum)
    }
}
function Assert-FirstQuoteBatch($Batch) {
    if ($Batch.offset -eq 0 -and ($Batch.limit -ne 20 -or $Batch.verifiedQuotes -ne 20 -or $Batch.freshQuotes -ne 20 -or $Batch.unquoted -ne 0)) {
        throw 'first_20_fresh_quotes_required'
    }
}
function Test-QueueMayResumePack($Result, $Request, [bool]$ObserveMarkerPresent, [bool]$StopMarkerPresent) {
    return $Request.resumePackCaptureAfterCompletion -eq $true -and $Result.status -in @('completed', 'partial_prices') -and
        $Result.attempted -eq 200 -and ($Result.verifiedQuotes + $Result.unquoted) -eq 200 -and
        $Result.completedBatches.Count -eq 3 -and $Result.markerCleanup -eq 'owned_marker_removed_monitor_resumed' -and
        -not $ObserveMarkerPresent -and -not $StopMarkerPresent
}
function Remove-OwnedQueueMarker([string]$OperationId) {
    if (-not (Test-QueueMarker $OperationId)) { return 'preserved_marker_not_owned' }
    Assert-QueueDeviceIdle
    if (-not (Test-QueueMarker $OperationId)) { return 'preserved_marker_owner_changed' }
    Remove-Item -LiteralPath $markerPath -ErrorAction Stop
    return 'owned_marker_removed_monitor_resumed'
}

try {
    if ($PSScriptRoot -ne $project) { throw 'unexpected_quote_queue_location' }
    $null = Assert-QueuePath $queueRoot; [IO.Directory]::CreateDirectory($queueRoot) | Out-Null
    $request = Read-QueueJson $requestPath
    if ($request.kind -ne 'listing_quote_queue_request' -or $request.operationId -notmatch '^[a-f0-9]{32}$' -or
        $request.startOffset -notin @(0, 20)) { throw 'invalid_quote_queue_request' }
    if ($PSBoundParameters.ContainsKey('StartOffset') -and $StartOffset -ne $request.startOffset) { throw 'queue_start_offset_request_mismatch' }
    if (-not (Test-QueueMarker $request.operationId)) { throw 'quote_queue_handoff_not_ready' }
    foreach ($item in @(@{ path = $cardsPath; hash = $request.cardsSha256 }, @{ path = $catalogPath; hash = $request.catalogSha256 })) {
        if ($item.hash -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath (Assert-QueuePath $item.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.hash) { throw 'queue_input_hash_mismatch' }
    }
    $cards = Get-Content -LiteralPath $cardsPath -Raw -Encoding utf8 | ConvertFrom-Json -NoEnumerate
    $catalog = Read-QueueJson $catalogPath
    if ($cards -isnot [array] -or $cards.Count -ne 200 -or @($catalog.cards).Count -ne 200) { throw 'queue_requires_exact_200_cards' }
    try { $queueLock = [IO.FileStream]::new((Join-Path $queueRoot 'queue.lock'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'quote_queue_already_claimed' }
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; operationId = $request.operationId; startedAt = $report.startedAt } | ConvertTo-Json -Compress))
    $queueLock.Write($bytes, 0, $bytes.Length); $queueLock.Flush()
    $runDir = Assert-QueuePath (Join-Path $queueRoot ('runs\' + $request.operationId))
    if (Test-Path -LiteralPath $runDir) { throw 'quote_queue_operation_already_started_review_required' }
    [IO.Directory]::CreateDirectory($runDir) | Out-Null
    $report.operationId = $request.operationId; $report.startOffset = $request.startOffset; $report.cardsSha256 = $request.cardsSha256
    $report.catalogSha256 = $request.catalogSha256; $report.markerCleanup = 'owned_until_finished'
    Save-QueueStatus 'validate_handoff'
    Assert-QueueDeviceIdle
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    if ($request.startOffset -eq 20) {
        Save-QueueStatus 'verify_prior_20'
        $prior = Verify-QueueBatch $request.priorRuntimeReportPath 0 20 -Prior
        Assert-FirstQuoteBatch $prior
        $report.completedBatches += $prior
        Update-QueueTotals
    }
    foreach ($batch in @(Get-QuoteBatches $request.startOffset)) {
        $report.currentBatch = @{ offset = $batch.offset; limit = $batch.limit; status = 'waiting'; runtimeReportPath = $null; collectorReportPath = $null }
        Save-QueueStatus 'batch_prerequisites'; Wait-QueueMemory
        if (-not (Test-QueueMarker $request.operationId)) { throw 'quote_queue_handoff_lost' }
        Assert-QueueDeviceIdle
        foreach ($item in @(@{ path = $cardsPath; hash = $request.cardsSha256 }, @{ path = $catalogPath; hash = $request.catalogSha256 })) {
            if ((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.hash) { throw 'queue_input_changed' }
        }
        $info = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source)
        $info.WorkingDirectory = $project; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        foreach ($argument in @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', (Join-Path $project 'run-app-daily.ps1'),
            '-CardsPath', $cardsPath, '-Offset', [string]$batch.offset, '-Limit', [string]$batch.limit)) { $info.ArgumentList.Add($argument) }
        $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
        $report.currentBatch.startedAt = [DateTime]::UtcNow.ToString('o')
        if (-not $child.Start()) { throw 'queue_runtime_start_failed' }
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        $report.currentBatch.childPid = $child.Id; $report.currentBatch.status = 'in_progress'; Save-QueueStatus 'collect_batch'
        $watch = [Diagnostics.Stopwatch]::StartNew(); $lastSave = -15
        # The existing runtime owns its bounded collector timeout and cleanup; never kill that wrapper here.
        while (-not $child.WaitForExit(1000)) {
            if ($watch.Elapsed.TotalSeconds - $lastSave -ge 15) {
                $report.currentBatch.elapsedSeconds = [int]$watch.Elapsed.TotalSeconds
                if (-not $report.currentBatch.runtimeReportPath) { $report.currentBatch.runtimeReportPath = Find-QueueRuntime $child.Id $batch.offset $batch.limit }
                Update-QueueLiveObservations
                Save-QueueStatus 'collect_batch'; $lastSave = $watch.Elapsed.TotalSeconds
            }
        }
        $summary = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable; $null = $stderr.GetAwaiter().GetResult()
        $report.currentBatch.runtimeReportPath = Assert-QueuePath $summary.runReportPath
        $report.currentBatch.collectorReportPath = $summary.collectorReportPath; $report.currentBatch.cleanup = $summary.cleanup
        $childExitCode = $child.ExitCode; $child.Dispose(); $child = $null
        if ($childExitCode -ne 0 -or $summary.status -ne 'observations_only') {
            $report.currentBatch.failureReason = $summary.reason
            if ($summary.collectorReportPath) {
                $stopped = Read-QueueJson $summary.collectorReportPath
                $failedRow = @($stopped.cards | Where-Object status -eq 'capture_stopped' | Select-Object -First 1)
                if ($failedRow.Count) { $report.currentBatch.childReason = $failedRow[0].reason }
            }
            throw 'quote_queue_batch_stopped'
        }
        Save-QueueStatus 'verify_batch'
        $verified = Verify-QueueBatch $summary.runReportPath $batch.offset $batch.limit
        Assert-FirstQuoteBatch $verified
        $report.completedBatches += $verified; $report.currentBatch = $null; Update-QueueTotals; Save-QueueStatus 'batch_verified'
    }
    $mergeCode = @'
import {readFileSync,writeFileSync} from 'node:fs';
import {listingPrice} from './prepare-listings.mjs';
const [statusPath,out]=process.argv.slice(1), status=JSON.parse(readFileSync(statusPath,'utf8'));
const quotes=[],unquoted=[],seen=new Set();
for(const batch of status.completedBatches){const verified=JSON.parse(readFileSync(batch.verifiedPath,'utf8'));
 for(const id of verified.targetIdentities){if(seen.has(id))throw new Error('duplicate_queue_identity');seen.add(id);}
 quotes.push(...verified.quotes);unquoted.push(...verified.unquoted);}
if(seen.size!==200 || quotes.length+unquoted.length!==200)throw new Error('incomplete_queue_evidence');
const fresh=quotes.filter(q=>listingPrice(q,q.identity).price!==null).length;
writeFileSync(out,JSON.stringify({kind:'verified_listing_quote_queue',verifiedAt:new Date().toISOString(),expected:200,
 verifiedQuotes:quotes.length,freshQuotes:fresh,unquoted:unquoted.length,quotes,unquotedCards:unquoted},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({verifiedQuotes:quotes.length,freshQuotes:fresh,unquoted:unquoted.length}));
'@
    $report.verifiedQuotesPath = Join-Path $runDir 'verified-quotes.json'
    $merged = Invoke-QueueUtility $node @('--input-type=module', '-e', $mergeCode, (Join-Path $runDir 'status.json'), $report.verifiedQuotesPath)
    $report.verifiedQuotes = $merged.verifiedQuotes; $report.freshQuotes = $merged.freshQuotes; $report.unquoted = $merged.unquoted
    $report.status = $(if ($report.freshQuotes -eq 200 -and $report.unquoted -eq 0) { 'completed' } else { 'partial_prices' })
    $report.reason = $(if ($report.status -eq 'partial_prices') { 'some_cards_have_no_fresh_exact_price' } else { $null })
    $exitCode = $(if ($report.status -eq 'completed') { 0 } else { 2 })
} catch {
    $report.status = 'stopped'
    $report.reason = $(if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'quote_queue_operation_failed' })
    $report.errorLine = $_.InvocationInfo.ScriptLineNumber
} finally {
    if ($queueLock) {
        try {
            if ($child -and -not $child.HasExited) { $report.markerCleanup = 'preserved_child_still_running' }
            elseif ($report.currentBatch.cleanup -eq 'owned_avd_not_stopped_identity_or_connection_unverified') { $report.markerCleanup = 'preserved_unconfirmed_device_cleanup' }
            else {
                try { $report.markerCleanup = Remove-OwnedQueueMarker $request.operationId } catch { $report.markerCleanup = 'preserved_device_not_idle' }
            }
            $report.completedAt = [DateTime]::UtcNow.ToString('o'); Save-QueueStatus $report.status
            if (Test-QueueMayResumePack $report $request (Test-Path -LiteralPath $markerPath) (Test-Path -LiteralPath (Join-Path $project 'output\app-packs\stop.requested'))) {
                # One explicit completion handoff, journaled before Start; never retry an uncertain result.
                try {
                    Assert-QueueDeviceIdle
                    if ((Test-Path -LiteralPath $markerPath) -or (Test-Path -LiteralPath (Join-Path $project 'output\app-packs\stop.requested'))) { throw 'another_device_handoff_or_stop_present' }
                    $report.packResume = @{ status = 'start_requested'; taskName = $captureTaskName; at = [DateTime]::UtcNow.ToString('o') }
                    Save-QueueStatus $report.status
                    Start-ScheduledTask -TaskName $captureTaskName -ErrorAction Stop
                    $report.packResume.status = 'start_command_succeeded'
                } catch { $report.packResume = @{ status = 'not_confirmed_review_required'; taskName = $captureTaskName } }
                Save-QueueStatus $report.status
            }
            $message = $(if ($report.status -eq 'completed') { '200 张宝可梦今日最低在售价已独立核验完成。' }
                elseif ($report.status -eq 'partial_prices') { "报价队列已处理200张，其中$($report.freshQuotes)张有新鲜精确报价，其余价格仍待补齐。" }
                else { "报价队列已停止：$($report.reason)。已核验$($report.verifiedQuotes)张；进度已保存在D盘。" })
            try {
                $level = $(if ($report.status -eq 'completed') { 'Info' } else { 'Warning' })
                $report.notification = Invoke-QueueUtility (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile', '-NonInteractive',
                    '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'RemoteSigned', '-File', (Join-Path $project 'notify-pack-status.ps1'), '-Title', '宝可梦报价队列', '-Message', $message, '-Level', $level) 25
                Save-QueueStatus $report.status
            } catch { $report.notification = @{ status = 'failed' }; Save-QueueStatus $report.status }
        } finally {
            $queueLock.Dispose(); Remove-Item -LiteralPath (Join-Path $queueRoot 'queue.lock')
        }
    }
}
@{ status = $report.status; reason = $report.reason; observed = $report.observed; verifiedQuotes = $report.verifiedQuotes;
    freshQuotes = $report.freshQuotes; statusPath = (Join-Path $queueRoot 'status.json'); markerCleanup = $report.markerCleanup } | ConvertTo-Json
exit $exitCode
