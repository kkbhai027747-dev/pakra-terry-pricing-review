#Requires -Version 7.0
param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Test-QuoteQueueDuration([string]$Value) {
    try { return [Xml.XmlConvert]::ToTimeSpan($Value) -eq [TimeSpan]::FromHours(24) } catch { return $false }
}
$project = 'D:\CODEX\pokemon-single-card-sync'
$taskName = 'PakraPokemonListingQuoteQueue'
$scriptPath = Join-Path $project 'run-listing-quotes.ps1'
if ($PSScriptRoot -ne $project -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'quote_queue_script_missing' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsSystem -or $identity.User.Value -notlike 'S-1-5-21-*') { throw 'interactive_user_required' }
$pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '"'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $actions = @($existing.Actions)
    $user = $existing.Principal.UserId
    if ($user -notlike 'S-1-*') { $user = [Security.Principal.NTAccount]::new($user).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne $pwsh -or $actions[0].Arguments -ne $arguments -or
        $actions[0].WorkingDirectory -ne $project -or $existing.Principal.RunLevel -ne 'Limited' -or
        $existing.Principal.LogonType -ne 'Interactive' -or $user -ne $identity.User.Value -or
        @($existing.Triggers | Where-Object { $null -ne $_ }).Count -ne 0 -or $existing.Settings.MultipleInstances -ne 'IgnoreNew' -or
        -not (Test-QuoteQueueDuration $existing.Settings.ExecutionTimeLimit)) { throw 'existing_quote_queue_definition_mismatch' }
} else {
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $project
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromHours(24)) -StartWhenAvailable
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'On-demand hidden 20/100/80 Pokemon quote capture queue. Waits for memory and explicit device handoff; no Shopify writes.'
    $null = Register-ScheduledTask -TaskName $taskName -InputObject $task
}
if ($StartNow) {
    $request = Get-Content -LiteralPath 'D:\CODEX\output\pokemon-v9-listing-20260927\quote-queue\request.json' -Raw | ConvertFrom-Json
    $marker = Get-Content -LiteralPath (Join-Path $project 'output\watchdog\observe-only.requested') -Raw | ConvertFrom-Json
    if ($request.kind -ne 'listing_quote_queue_request' -or $request.operationId -notmatch '^[a-f0-9]{32}$' -or
        $marker.owner -cne 'listing_quote_queue' -or $marker.operationId -cne $request.operationId) { throw 'quote_queue_handoff_not_ready' }
    Start-ScheduledTask -TaskName $taskName
}
$installed = Get-ScheduledTask -TaskName $taskName
@{ taskName = $taskName; state = [string]$installed.State; runLevel = [string]$installed.Principal.RunLevel;
    logonType = [string]$installed.Principal.LogonType; triggerCount = @($installed.Triggers | Where-Object { $null -ne $_ }).Count;
    startRequested = [bool]$StartNow; scriptPath = $scriptPath } | ConvertTo-Json
