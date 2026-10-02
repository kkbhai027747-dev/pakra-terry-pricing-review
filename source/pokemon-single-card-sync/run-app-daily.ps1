#Requires -Version 7.0
param(
    [string]$CardsPath = (Join-Path $PSScriptRoot 'pilot-contexts.json'),
    [string]$PackManifestPath,
    [ValidateRange(0, 2147483647)][int]$Offset = 0,
    [ValidateRange(1, 100)][int]$Limit = 25,
    [ValidateRange(512, 16384)][int]$MemoryMb = 2560,
    [ValidateRange(1536, 8192)][int]$SystemReserveMb = 2048,
    [string]$SummaryPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$runtime = 'D:\CODEX\output\pokemon-android-runtime'
$sdk = Join-Path $runtime 'sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$avdHome = Join-Path $runtime 'avd'
$avdName = 'PakraPokemon'
$startedHere = $false
$runDir = $null
$lockStream = $null
$lockPath = $null
$exitCode = 1
$summaryFile = $null
$report = [ordered]@{ status = 'in_progress'; stage = 'configuration'; startedAt = [DateTime]::UtcNow.ToString('o'); pid=$PID
    offset = $Offset; limit = $Limit; startedEmulator = $false; collectorReportPath = $null; cleanup = 'not_needed' }
$packMode = -not [string]::IsNullOrWhiteSpace($PackManifestPath)
$report.mode = $(if($packMode) { 'pack_catalog' } else { 'daily_prices' })

function Assert-WorkspacePath([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if (-not $full.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase)) { throw 'path_outside_workspace' }
    $ancestor = [IO.DirectoryInfo]::new($full)
    while ($null -ne $ancestor) {
        if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'path_reparse_point' }
        $ancestor = $ancestor.Parent
    }
    $entry = Get-Item -LiteralPath $full -ErrorAction SilentlyContinue
    if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'path_reparse_point' }
    return $full
}

function Save-RunStatus([string]$Stage) {
    $report.stage = $Stage
    $report.updatedAt = [DateTime]::UtcNow.ToString('o')
    if ($runDir) {
        [IO.File]::WriteAllText((Join-Path $runDir 'run.json'), ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    }
}

function Resolve-SummaryPath([string]$Value) {
    if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw 'summary_path_not_absolute' }
    $full = Assert-WorkspacePath $Value
    if ([IO.Path]::GetExtension($full) -ne '.json') { throw 'summary_path_not_json' }
    if (Test-Path -LiteralPath $full) { throw 'summary_path_already_exists' }
    if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($full)) -PathType Container)) { throw 'summary_parent_missing' }
    return $full
}

function Write-RunSummary([string]$Path, [string]$Json) {
    $full = Resolve-SummaryPath $Path
    $stream = [IO.FileStream]::new($full, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Remove-OwnedChildLock([string]$Path, [Diagnostics.Process]$Child) {
    if([string]::IsNullOrWhiteSpace($Path) -or -not $Child.HasExited) { return }
    $ownedPath=Assert-WorkspacePath $Path
    if(-not (Test-Path -LiteralPath $ownedPath -PathType Leaf)) { return }
    try { $owner=Get-Content -LiteralPath $ownedPath -Raw | ConvertFrom-Json }
    catch { throw 'child_lock_owner_unverified' }
    if($owner -isnot [pscustomobject] -or ($owner.pid -isnot [int] -and $owner.pid -isnot [long]) -or
        $owner.pid -le 0 -or $owner.pid -gt [int]::MaxValue) { throw 'child_lock_owner_unverified' }
    if($owner.pid -eq $Child.Id) {
        Remove-Item -LiteralPath $ownedPath -ErrorAction Stop
        $report.collectorLockCleanup='exited_child_lock_removed'
    }
}

function Invoke-Hidden([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 30, [bool]$CaptureOutput = $true, [string]$OwnedLockPath) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $PSScriptRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $CaptureOutput
    $start.RedirectStandardError = $CaptureOutput
    if($CaptureOutput) {
        $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
        $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    }
    foreach ($key in @($start.Environment.Keys)) {
        if ($key -in @('ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS')) { $null = $start.Environment.Remove($key) }
    }
    $start.Environment['ANDROID_ADB_SERVER_PORT'] = '15037'
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'child_start_failed' }
        if ($CaptureOutput) {
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            if(-not $process.WaitForExit(10000)) { throw 'child_stop_unconfirmed' }
            Remove-OwnedChildLock $OwnedLockPath $process
            throw 'child_timeout'
        }
        Remove-OwnedChildLock $OwnedLockPath $process
        if ($CaptureOutput -and (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000))) { throw 'child_output_failed' }
        return @{ exitCode = $process.ExitCode; stdout = $(if ($CaptureOutput) { $stdout.Result } else { '' }) }
    } finally { $process.Dispose() }
}

function Test-PrivateServer {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 15037 })
    foreach ($listener in $listeners) {
        $owner = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $listener.OwningProcess) -ErrorAction Stop
        if ($listener.LocalAddress -notin @('127.0.0.1', '::1') -or -not $owner.ExecutablePath -or
            -not [string]::Equals($owner.ExecutablePath, $adb, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'private_adb_owner_unverified'
        }
    }
    return $listeners.Count -gt 0
}

function Invoke-PrivateAdb([string[]]$Arguments, [int]$TimeoutSeconds = 15) {
    return Invoke-Hidden $adb (@('-H', '127.0.0.1', '-P', '15037', '-s', 'emulator-5580') + $Arguments) $TimeoutSeconds
}

function Assert-AvdIdentity {
    $identity = Invoke-PrivateAdb @('emu', 'avd', 'name')
    if ($identity.exitCode -ne 0 -or ($identity.stdout.Replace("`r", '').Trim() -ne "PakraPokemon`nOK")) {
        throw 'avd_identity_unverified'
    }
}

function Test-LaunchMemoryBlocked($Result, $LaunchReport) {
    if ($null -eq $Result -or $null -eq $LaunchReport -or $startedHere -or $packMode) { return $false }
    $memoryBlocker = "Insufficient free physical memory; the emulator allocation requires an additional $SystemReserveMb MB reserve. No other process was stopped."
    if ($Result.exitCode -ne 2 -or $LaunchReport.exitCode -ne 2 -or $LaunchReport.status -ne 'blocked' -or
        $LaunchReport.mode -ne 'start' -or $LaunchReport.displayMode -ne 'headless' -or
        @($LaunchReport.blockers).Count -ne 1 -or $LaunchReport.blockers[0] -cne $memoryBlocker) { return $false }
    if (@($LaunchReport.PSObject.Properties.Name | Where-Object { $_ -in @('pid', 'avd', 'port', 'stdout', 'stderr') }).Count) { return $false }
    if ($LaunchReport.acceleration.available -isnot [bool] -or -not $LaunchReport.acceleration.available -or
        $LaunchReport.acceleration.exitCode -ne 0 -or $LaunchReport.adbServer.host -cne '127.0.0.1' -or
        $LaunchReport.adbServer.port -ne 15037 -or $LaunchReport.adbServer.status -cne 'verified_sdk_adb') { return $false }
    foreach ($field in @('availableMb', 'emulatorMb', 'requiredMb')) {
        $value = $LaunchReport.memory.$field
        if (($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double]) -or
            [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or
            [double]$value -lt 0 -or [Math]::Truncate([double]$value) -ne [double]$value) { return $false }
    }
    return $LaunchReport.memory.availableMb -ge 0 -and $LaunchReport.memory.availableMb -lt ($MemoryMb + $SystemReserveMb) -and
        $LaunchReport.memory.emulatorMb -eq $MemoryMb -and $LaunchReport.memory.requiredMb -eq ($MemoryMb + $SystemReserveMb)
}

function Assert-LaunchMemoryRetryIdle {
    if (-not (Test-PrivateServer)) { throw 'private_adb_missing' }
    $retryDevices = Invoke-PrivateAdb @('devices')
    if ($retryDevices.exitCode -ne 0) { throw 'private_adb_query_failed' }
    $unexpected = @($retryDevices.stdout.Replace("`r", '').Split("`n") | ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and $_ -cne 'List of devices attached' })
    if ($unexpected.Count) { throw 'launch_retry_device_appeared' }
    $occupied = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(5580, 5581) })
    if ($occupied.Count) { throw 'launch_retry_port_occupied' }
    $runtimeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='emulator.exe' OR Name='qemu-system-x86_64.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$sdk\", [StringComparison]::OrdinalIgnoreCase) })
    if ($runtimeProcesses.Count) { throw 'launch_retry_process_appeared' }
}

try {
    if (-not [string]::IsNullOrWhiteSpace($SummaryPath)) { $summaryFile = Resolve-SummaryPath $SummaryPath }
    foreach ($path in @($adb, $emulator, (Join-Path $avdHome "$avdName.ini"),
        (Join-Path $avdHome "$avdName.avd\config.ini"), (Join-Path $PSScriptRoot 'start-headless-android.ps1'),
        (Join-Path $PSScriptRoot 'collect-app-daily.mjs'))) {
        if (-not (Test-Path -LiteralPath (Assert-WorkspacePath $path) -PathType Leaf)) { throw 'runtime_file_missing' }
    }
    $avdPaths = @(Get-Content -LiteralPath (Join-Path $avdHome "$avdName.ini") | Where-Object { $_ -match '^path=' })
    if ($avdPaths.Count -ne 1 -or (Assert-WorkspacePath $avdPaths[0].Substring(5)) -ne (Join-Path $avdHome "$avdName.avd")) {
        throw 'avd_userdata_path_mismatch'
    }
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($config.android.adbPath) -ne $adb -or $config.android.transport -ne 'emulator' -or
        $config.android.serial -ne 'emulator-5580' -or $config.android.serverPort -ne 15037) { throw 'device_config_mismatch' }
    if($packMode) {
        $manifestFile=Assert-WorkspacePath $PackManifestPath
        $manifest=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -NoEnumerate
        if($manifest -isnot [array] -or $manifest.Count -lt 1 -or $manifest.Count -gt 3) { throw 'invalid_pack_manifest' }
        foreach($entry in $manifest) {
            $null=Assert-WorkspacePath $entry.listingPath; $null=Assert-WorkspacePath $entry.outputDir
        }
        if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'run-app-pack-batches.ps1') -PathType Leaf)) { throw 'pack_runner_missing' }
    } else {
        $cardsFile = Assert-WorkspacePath $CardsPath
        $cards = Get-Content -LiteralPath $cardsFile -Raw | ConvertFrom-Json -NoEnumerate
        if ($cards -isnot [array] -or $cards.Count -eq 0 -or $Offset -ge $cards.Count) { throw 'invalid_card_selection' }
        $selectedCount = [Math]::Min($Limit, $cards.Count - $Offset)
    }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $runDir = Assert-WorkspacePath (Join-Path $PSScriptRoot ('output\app-daily-runtime\{0}-{1}' -f
        [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), [Guid]::NewGuid().ToString('N')))
    [IO.Directory]::CreateDirectory($runDir) | Out-Null
    Save-RunStatus 'claim_runtime_lock'
    $lockPath = Assert-WorkspacePath (Join-Path $PSScriptRoot 'output\app-daily-runtime.lock')
    try { $lockStream = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'runtime_lock_exists_or_unavailable' }
    $lockBytes = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; startedAt = $report.startedAt; runDir = $runDir } | ConvertTo-Json))
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    $lockStream.Flush()
    if($packMode) {
        $pointer=Join-Path $PSScriptRoot 'output\app-packs\background-job.json'
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($pointer)) | Out-Null
        $pointerValue=@{pid=$PID;runtimeReportPath=(Join-Path $runDir 'run.json');
            batchReportPath=(Join-Path $runDir 'packs\run.json');startedAt=$report.startedAt;
            workflow='three_pilot_pack_catalogs';host='background_script'}
        [IO.File]::WriteAllText("$pointer.$PID.tmp",($pointerValue | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        [IO.File]::Move("$pointer.$PID.tmp",$pointer,$true)
    }
    Save-RunStatus 'private_adb'
    if (-not (Test-PrivateServer)) {
        # -H is deliberately absent only for starting this exact local private server.
        $server = Invoke-Hidden $adb @('-P', '15037', 'start-server')
        if ($server.exitCode -ne 0 -or -not (Test-PrivateServer)) { throw 'private_adb_start_failed' }
    }
    for($attempt=0; $attempt -le $(if($packMode) { 1 } else { 0 }); $attempt++) {
    $report.attempt=$attempt + 1
    $devices = Invoke-PrivateAdb @('devices')
    if ($devices.exitCode -ne 0) { throw 'private_adb_query_failed' }
    $devicePresent = [regex]::IsMatch($devices.stdout, '(?m)^emulator-5580\s+')
    if (-not $devicePresent) {
      $memoryRetries = 0
      while ($true) {
        Save-RunStatus 'start_headless_avd'
        $launchPath = Join-Path $runDir $(if($memoryRetries -gt 0) { "launch-memory-retry-$memoryRetries.json" }
            elseif($attempt -eq 0) { 'launch.json' } else { 'launch-recovery.json' })
        if ($memoryRetries -gt 0 -and (Test-Path -LiteralPath $launchPath)) { throw 'launch_retry_report_exists' }
        $report.launchReportPath = $launchPath
        $launched = $null
        try {
            # The detached emulator can inherit launcher pipes; its JSON report is the result channel.
            $launch = Invoke-Hidden (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-File', (Join-Path $PSScriptRoot 'start-headless-android.ps1'), '-EmulatorPath', $emulator,
                '-AndroidSdkRoot', $sdk, '-AvdHome', $avdHome, '-AvdName', $avdName, '-Port', '5580',
                '-MemoryMb', [string]$MemoryMb, '-SystemReserveMb', [string]$SystemReserveMb, '-ReportPath', $launchPath, '-Quiet') 120 $false
        } finally {
            if (Test-Path -LiteralPath $launchPath -PathType Leaf) {
                $launched = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
                if ($launched.status -eq 'started' -and $launched.displayMode -eq 'headless' -and
                    $launched.avd -eq $avdName -and $launched.port -eq 5580 -and [int]$launched.pid -gt 0) {
                    $startedHere = $true
                    $report.startedEmulator = $true
                }
            }
        }
        if ($launch.exitCode -ne 0) {
            if ($memoryRetries -ge 3 -or -not (Test-LaunchMemoryBlocked $launch $launched)) { throw 'headless_launch_failed' }
            Assert-LaunchMemoryRetryIdle
            if ($memoryRetries -eq 0) { $report.launchMemoryRetry = @{ waits = 0; waitedSeconds = 0; maxWaitSeconds = 90; failedReportPaths = @() } }
            $report.launchMemoryRetry.waits = $memoryRetries + 1
            $report.launchMemoryRetry.failedReportPaths += $launchPath
            $report.launchMemoryRetry.availableMb = $launched.memory.availableMb
            $report.launchMemoryRetry.requiredMb = $launched.memory.requiredMb
            Save-RunStatus 'waiting_launch_memory'
            Start-Sleep -Seconds 30
            $report.launchMemoryRetry.waitedSeconds += 30
            Assert-LaunchMemoryRetryIdle
            $memoryRetries++
            continue
        }
        if (-not $startedHere) { throw 'launch_report_invalid' }
        break
      }
    }
    Save-RunStatus 'wait_for_boot'
    $bootWatch = [Diagnostics.Stopwatch]::StartNew()
    $booted = $false
    while ($bootWatch.Elapsed.TotalSeconds -lt 90) {
        try {
            $boot = Invoke-PrivateAdb @('shell', 'getprop', 'sys.boot_completed') 5
            if ($boot.exitCode -eq 0 -and $boot.stdout.Trim() -eq '1') { $booted = $true; break }
        } catch { if ($_.Exception.Message -ne 'child_timeout') { throw } }
        $report.bootWaitSeconds = [int]$bootWatch.Elapsed.TotalSeconds
        Save-RunStatus 'wait_for_boot'
        Start-Sleep -Seconds 2
    }
    if (-not $booted) { throw 'device_boot_timeout' }
    Assert-AvdIdentity
    Save-RunStatus $(if($packMode) { 'collect_pack_catalogs' } else { 'collect_public_observations' })
    if($packMode) {
        $collected=Invoke-Hidden (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
            (Join-Path $PSScriptRoot 'run-app-pack-batches.ps1'),'-ManifestPath',$manifestFile,'-ReportDir',
            (Join-Path $runDir $(if($attempt -eq 0) { 'packs' } else { 'packs-recovery' }))) (40 * 3600)
    } else {
        $collected = Invoke-Hidden $node @((Join-Path $PSScriptRoot 'collect-app-daily.mjs'), '--cards', $cardsFile,
            '--offset', [string]$Offset, '--limit', [string]$Limit) ($selectedCount * 180 + 60) $true (Join-Path $PSScriptRoot 'output\run.lock')
    }
    if ($collected.stdout.Trim()) {
        $summary = $collected.stdout | ConvertFrom-Json
        $report.collectorReportPath = Assert-WorkspacePath $summary.reportPath
        $report.collection = $(if($packMode) { @{status=$summary.status; packs=$manifest.Count} } else {
            @{ status = $summary.status; attempted = $summary.attempted; observed = $summary.observed;
            notExactMinimum = $summary.notExactMinimum; quoteEligible = $false }
        })
    }
    if ($collected.exitCode -ne 0 -and $packMode -and $attempt -eq 0) {
        $remaining=Invoke-PrivateAdb @('devices')
        if($remaining.exitCode -eq 0 -and -not [regex]::IsMatch($remaining.stdout,'(?m)^emulator-5580\s+')) {
            $report.recovery=@{reason='owned_device_disappeared';previousReportPath=$report.collectorReportPath;at=[DateTime]::UtcNow.ToString('o')}
            Save-RunStatus 'recover_missing_avd_once'
            continue
        }
    }
    if ($collected.exitCode -ne 0) { throw 'collection_stopped' }
    $expectedStatus=$(if($packMode) { 'pack_batches_completed' } else { 'observations_only' })
    if (-not $report.collectorReportPath -or $summary.status -ne $expectedStatus) { throw 'collection_report_invalid' }
    $report.status = $expectedStatus
    $exitCode = 0
    break
    }
} catch {
    $report.status = 'stopped'
    $report.errorType = $_.Exception.GetType().FullName
    $report.errorLine = $_.InvocationInfo.ScriptLineNumber
    $report.reason = $(if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'runtime_operation_failed' })
} finally {
    if ($startedHere) {
        try {
            if (-not (Test-PrivateServer)) { throw 'private_adb_missing' }
            Assert-AvdIdentity
            $stopped = Invoke-PrivateAdb @('emu', 'kill')
            if ($stopped.exitCode -ne 0) { throw 'owned_avd_stop_failed' }
            $report.cleanup = 'owned_avd_stop_requested'
        } catch {
            $report.cleanup = 'owned_avd_not_stopped_identity_or_connection_unverified'
            $report.status = 'stopped'
            $exitCode = 1
        }
    }
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    try { Save-RunStatus $report.stage }
    finally {
        if ($null -ne $lockStream) {
            $lockStream.Dispose()
            Remove-Item -LiteralPath $lockPath -ErrorAction Stop
        }
    }
}
$finalSummary = @{ status = $report.status; runReportPath = $(if ($runDir) { Join-Path $runDir 'run.json' } else { $null });
    collectorReportPath = $report.collectorReportPath; cleanup = $report.cleanup; reason = $report.reason }
$finalJson = $finalSummary | ConvertTo-Json
if ($summaryFile) {
    try { Write-RunSummary $summaryFile $finalJson }
    catch {
        $exitCode = 1
        $finalSummary.status = 'stopped'; $finalSummary.reason = 'summary_write_failed'
        $finalJson = $finalSummary | ConvertTo-Json
    }
}
$finalJson
exit $exitCode
