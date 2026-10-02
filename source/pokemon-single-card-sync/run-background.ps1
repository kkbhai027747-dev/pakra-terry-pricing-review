param(
    [ValidateSet('Doctor', 'Discover', 'Samples', 'Daily', 'AppDaily')][string]$Mode = 'Doctor',
    [string]$QuotesPath,
    [string]$ProcurementPath,
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

$ErrorActionPreference = 'Stop'
$logsPath = Join-Path $PSScriptRoot 'output\logs'
$runId = '{0}-{1}-{2}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), $PID, [Guid]::NewGuid().ToString('N')
function Send-DailyFailureNotification([int]$FailureCode) {
    if ($Mode -notin @('AppDaily', 'Daily')) { return $null }
    $notifier = Join-Path $PSScriptRoot 'notify-pack-status.ps1'
    if (-not (Test-Path -LiteralPath $notifier -PathType Leaf)) { return @{ status = 'unavailable' } }
    $noticeProcess = $null
    try {
        New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
        $message = 'Daily price preview stopped ({0}, exit {1}). Check the local run log.' -f $Mode, $FailureCode
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "{0}" -Title "Pokemon daily price preview" -Message "{1}" -Level Warning' -f $notifier, $message
        $noticeProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments `
            -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logsPath "$runId.notify.stdout.log") -RedirectStandardError (Join-Path $logsPath "$runId.notify.stderr.log")
        if (-not $noticeProcess.WaitForExit(20000)) { $noticeProcess.Kill(); return @{ status = 'failed'; reason = 'notification_timeout' } }
        return @{ status = $(if ($noticeProcess.ExitCode -eq 0) { 'requested' } else { 'failed' }); displayConfirmed = $false }
    } catch { return @{ status = 'failed'; reason = 'notification_failed' } }
    finally { if ($noticeProcess) { $noticeProcess.Dispose() } }
}
try {
    $scriptPath = Join-Path $PSScriptRoot $(if($Mode -eq 'AppDaily') { 'run-listed-daily.mjs' } else { 'sync.mjs' })
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Project entry script was not found beside this launcher.' }
    $nodeArguments = @(('"{0}"' -f $scriptPath))
    if($Mode -eq 'AppDaily') { $nodeArguments += '--run' } else { $nodeArguments += $Mode.ToLowerInvariant() }
    $configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw 'ConfigPath must identify a configuration file.' }
    $nodeArguments += @('--config', ('"{0}"' -f $configFile))
    if(-not [string]::IsNullOrWhiteSpace($ProcurementPath)) {
        if($Mode -ne 'AppDaily') { throw 'ProcurementPath is only supported with AppDaily mode.' }
        $allocationPath = (Resolve-Path -LiteralPath $ProcurementPath).Path
        if(-not (Test-Path -LiteralPath $allocationPath -PathType Leaf)) { throw 'ProcurementPath must identify an allocation file.' }
        $nodeArguments += @('--procurement', ('"{0}"' -f $allocationPath))
    }
    if ($Mode -eq 'Daily') {
        if ([string]::IsNullOrWhiteSpace($QuotesPath)) { throw 'Daily requires -QuotesPath pointing to current captured lowest-asking evidence; this launcher does not collect prices.' }
        $sourcePath = (Resolve-Path -LiteralPath $QuotesPath).Path
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'QuotesPath must identify an evidence file.' }
        $nodeArguments += @('--quotes', ('"{0}"' -f $sourcePath))
    } elseif (-not [string]::IsNullOrWhiteSpace($QuotesPath)) {
        throw 'QuotesPath is only supported with Daily mode.'
    }
    $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
    $stdoutPath = Join-Path $logsPath "$runId.stdout.log"
    $stderrPath = Join-Path $logsPath "$runId.stderr.log"
    $child = Start-Process -FilePath $nodePath -ArgumentList ($nodeArguments -join ' ') `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
    $exitCode = $child.ExitCode
    if ($null -eq $exitCode) { throw 'The hidden Node process did not provide an exit code.' }
    $notification = if ($exitCode -ne 0) { Send-DailyFailureNotification $exitCode } else { $null }
    [ordered]@{
        status = $(if ($exitCode -eq 0) { 'completed' } else { 'child_failed' })
        mode = $Mode
        configPath = $configFile
        pid = $child.Id
        exitCode = $exitCode
        stdout = $stdoutPath
        stderr = $stderrPath
        notification = $notification
    } | ConvertTo-Json | Write-Output
    exit $exitCode
} catch {
    $failureMessage = $_.Exception.Message
    $notification = Send-DailyFailureNotification 1
    [ordered]@{ status = 'launcher_failed'; mode = $Mode; exitCode = 1; message = $failureMessage; notification = $notification } | ConvertTo-Json | Write-Output
    exit 1
}
