param(
    [string]$QuotesPath,
    [string]$ProcurementPath,
    [string]$At,
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)
$ErrorActionPreference = 'Stop'
$configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw 'ConfigPath must identify a configuration file.' }
$config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
if (-not $PSBoundParameters.ContainsKey('At')) {
    $At = if ([string]::IsNullOrWhiteSpace($config.dailyAt)) { '09:00' } else { [string]$config.dailyAt }
}
$mode = 'AppDaily'
$sourceArguments = ''
if($At -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') { throw 'At must be HH:mm in the Windows local timezone.' }
if(-not [string]::IsNullOrWhiteSpace($QuotesPath)) {
    if(-not [string]::IsNullOrWhiteSpace($ProcurementPath)) { throw 'Choose App procurement or legacy quotes, never both.' }
    $sourcePath = (Resolve-Path -LiteralPath $QuotesPath).Path
    $quotes = Get-Content -Raw -LiteralPath $sourcePath | ConvertFrom-Json
    if ($quotes.source -ne 'jihuanshe' -or $quotes.metric -ne 'lowest_asking') { throw 'Must supply a verified captured lowest-asking evidence file.' }
    $mode = 'Daily'
    $sourceArguments = ' -QuotesPath "{0}"' -f $sourcePath
} elseif(-not [string]::IsNullOrWhiteSpace($ProcurementPath)) {
    $allocationPath = (Resolve-Path -LiteralPath $ProcurementPath).Path
    $null = Get-Content -Raw -LiteralPath $allocationPath | ConvertFrom-Json
    $sourceArguments = ' -ProcurementPath "{0}"' -f $allocationPath
}
if ($config.shipping.mode -eq 'unconfirmed') { throw 'Confirm the Jihuanshe procurement shipping rule first.' }
if ([string]::IsNullOrWhiteSpace($config.mappingFile)) { throw 'The selected config must define mappingFile.' }
$mappingPath = if ([IO.Path]::IsPathRooted($config.mappingFile)) { $config.mappingFile } else { Join-Path ([IO.Path]::GetDirectoryName($configFile)) $config.mappingFile }
$mapping = Get-Content -Raw -LiteralPath $mappingPath | ConvertFrom-Json
if (@($mapping | Where-Object { $_.enabled -eq $true }).Count -eq 0) { throw 'No enabled exact single-card mappings.' }
if($mode -eq 'AppDaily') {
    if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'run-listed-daily.mjs') -PathType Leaf)) { throw 'App daily collector entry is missing.' }
    if($config.shipping.mode -eq 'per_order' -and [string]::IsNullOrWhiteSpace($ProcurementPath)) {
        throw 'Per-order shipping requires explicit procurement allocations before installing daily price previews.'
    }
}
Get-Command node -CommandType Application -ErrorAction Stop | Out-Null
$powershellCommand = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$powershellPath = if ($powershellCommand) { $powershellCommand.Source } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$launcherPath = Join-Path $PSScriptRoot 'run-background.ps1'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw 'Hidden background launcher was not found.' }
$taskName = 'PakraPokemonSingleCardDailyPreview'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task already exists; review it before replacing it.' }
$taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument (('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Mode {1} -ConfigPath "{2}"' -f $launcherPath, $mode, $configFile) + $sourceArguments) -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description 'Daily price preview from independently captured current Jihuanshe evidence; never applies Shopify mutations.' | Out-Null
Write-Output "Installed $taskName at $At in the Windows local timezone, mode $mode. This task creates previews and never applies Shopify mutations."
