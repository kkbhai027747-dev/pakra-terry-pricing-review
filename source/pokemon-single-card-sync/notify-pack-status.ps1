#Requires -Version 5.1
param(
    [string]$Title = 'Pokemon capture monitor',
    [string]$Message,
    [string]$Level = 'Info',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$logPath = Join-Path $PSScriptRoot 'output\watchdog\notifications.jsonl'
$result = [ordered]@{
    kind = 'pack_status_notification'
    at = [DateTime]::UtcNow.ToString('o')
    status = 'failed'
    reason = $null
    dryRun = [bool]$DryRun
    level = $null
    title = $null
    message = $null
    displayConfirmed = $false
}
$icon = $null
$exitCode = 1
try {
    if ([string]::IsNullOrWhiteSpace($Title) -or $Title.Length -gt 60 -or
        [string]::IsNullOrWhiteSpace($Message) -or $Message.Length -gt 240 -or
        $Level -cnotin @('Info', 'Warning', 'Error') -or
        $Title -match '[\x00-\x1f\x7f]' -or $Message -match '[\x00-\x1f\x7f]') {
        throw 'invalid_notification_arguments'
    }
    $result.level = $Level
    $result.title = $Title
    $result.message = $Message
    if ($DryRun) {
        $result.status = 'dry_run'
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $icon = [Windows.Forms.NotifyIcon]::new()
        $icon.Icon = switch ($Level) {
            'Warning' { [Drawing.SystemIcons]::Warning }
            'Error' { [Drawing.SystemIcons]::Error }
            default { [Drawing.SystemIcons]::Information }
        }
        $icon.Text = $Title
        $icon.Visible = $true
        $tipIcon = [Enum]::Parse([Windows.Forms.ToolTipIcon], $Level)
        $icon.ShowBalloonTip(13000, $Title, $Message, $tipIcon)
        $result.status = 'requested'
        # Windows notification settings can suppress display; this is not a delivery receipt.
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while ($watch.ElapsedMilliseconds -lt 13000) {
            [Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 100
        }
    }
    $exitCode = 0
} catch {
    $result.status = 'failed'
    $result.reason = if ($_.Exception.Message -eq 'invalid_notification_arguments') {
        'invalid_notification_arguments'
    } else {
        'notification_unavailable'
    }
} finally {
    if ($null -ne $icon) {
        try { $icon.Visible = $false } catch {}
        try { $icon.Dispose() } catch {}
    }
    try {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($logPath)) | Out-Null
        [IO.File]::AppendAllText($logPath, (($result | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    } catch {
        $result.status = 'failed'
        $result.reason = 'notification_log_failed'
        $exitCode = 1
    }
}
$result | ConvertTo-Json -Compress
exit $exitCode
