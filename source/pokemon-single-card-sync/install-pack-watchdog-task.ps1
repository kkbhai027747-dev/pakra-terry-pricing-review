#Requires -Version 7.0
param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = 'D:\CODEX\pokemon-single-card-sync'
$taskName = 'PakraPokemonPackWatchdog'
$scriptPath = Join-Path $project 'run-pack-watchdog.ps1'
if ($PSScriptRoot -ne $project) { throw 'unexpected_monitor_location' }
foreach ($file in @($scriptPath, (Join-Path $project 'pack-watchdog-policy.mjs'), (Join-Path $project 'notify-pack-status.ps1'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'watchdog_files_missing' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsSystem -or $identity.User.Value -notlike 'S-1-5-21-*') { throw 'interactive_user_required' }
$pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '" -NotifyEnabled'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $actions = @($existing.Actions); $triggers = @($existing.Triggers | Where-Object { $null -ne $_ })
    $user = [Security.Principal.NTAccount]::new($existing.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne $pwsh -or $actions[0].Arguments -ne $arguments -or
        $actions[0].WorkingDirectory -ne $project -or $existing.Principal.RunLevel -ne 'Limited' -or
        $existing.Principal.LogonType -ne 'Interactive' -or $user -ne $identity.User.Value -or $triggers.Count -ne 1 -or
        $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskTimeTrigger' -or $triggers[0].Repetition.Interval -ne 'PT1M' -or
        $triggers[0].Repetition.Duration -or $triggers[0].EndBoundary -or -not $triggers[0].Enabled -or
        $existing.Settings.MultipleInstances -ne 'IgnoreNew' -or $existing.Settings.ExecutionTimeLimit -ne 'PT5M') {
        throw 'existing_watchdog_definition_mismatch'
    }
} else {
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $project
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval ([TimeSpan]::FromMinutes(1))
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5)) -StartWhenAvailable
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Check the approved local Pokemon pack capture every minute; bounded resume, local status and Windows notifications. No Shopify writes.'
    $null = Register-ScheduledTask -TaskName $taskName -InputObject $task
}
if ($StartNow) { Start-ScheduledTask -TaskName $taskName }
$installed = Get-ScheduledTask -TaskName $taskName
@{ taskName = $taskName; state = [string]$installed.State; runLevel = [string]$installed.Principal.RunLevel;
    logonType = [string]$installed.Principal.LogonType; interval = $installed.Triggers[0].Repetition.Interval;
    startRequested = [bool]$StartNow; scriptPath = $scriptPath } | ConvertTo-Json
