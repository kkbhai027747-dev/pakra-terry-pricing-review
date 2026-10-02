#Requires -Version 7.0
param([switch]$StartNow)

$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskName='PakraPokemonPilotPackCapture'
$project='D:\CODEX\pokemon-single-card-sync'
$scriptPath=Join-Path $project 'run-app-daily.ps1'
$manifestPath=Join-Path $project 'pilot-pack-manifest.json'
if($PSScriptRoot -ne $project -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'pilot_task_files_missing' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.IsSystem -or $identity.User.Value -notlike 'S-1-5-21-*') { throw 'interactive_user_required' }
$pwsh=(Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$scriptPath+'" -PackManifestPath "'+$manifestPath+'"'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing) {
    $actions=@($existing.Actions)
    if($actions.Count -ne 1 -or $actions[0].Execute -ne $pwsh -or $actions[0].Arguments -ne $arguments -or
        $actions[0].WorkingDirectory -ne $project -or @($existing.Triggers | Where-Object { $null -ne $_ }).Count -ne 0 -or
        $existing.Principal.RunLevel -ne 'Limited' -or $existing.Principal.LogonType -ne 'Interactive') {
        throw 'existing_task_definition_mismatch'
    }
} else {
    $action=New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $project
    $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromHours(84)) -StartWhenAvailable
    $task=New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'Collect the three approved Pokemon pilot packs into the local catalog. No Shopify writes. Run on demand while this user is logged in.'
    $null=Register-ScheduledTask -TaskName $taskName -InputObject $task
}
if($StartNow) { Start-ScheduledTask -TaskName $taskName }
$installed=Get-ScheduledTask -TaskName $taskName
@{taskName=$taskName;state=[string]$installed.State;runLevel=[string]$installed.Principal.RunLevel;
    logonType=[string]$installed.Principal.LogonType;triggerCount=@($installed.Triggers | Where-Object { $null -ne $_ }).Count;
    startRequested=[bool]$StartNow;scriptPath=$scriptPath;manifestPath=$manifestPath} | ConvertTo-Json
