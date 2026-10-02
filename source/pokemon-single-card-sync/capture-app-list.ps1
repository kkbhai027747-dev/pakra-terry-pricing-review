#Requires -Version 7.0
param(
    [Parameter(Mandatory)][ValidateSet('zh-Hans', 'ja', 'en')][string]$Language,
    [Parameter(Mandatory)][ValidatePattern('^[1-9]\d*$')][string]$SetId,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*$')][string]$SetCode,
    [string]$PackName = '30周年庆典',
    [ValidateRange(1, 100)][int]$MaxPages = 3,
    [Parameter(Mandatory)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$script:stage = 'configuration'

function Get-Rectangle([string]$Value) {
    if ($Value -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { return $null }
    $r = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
    if ($r[2] -le $r[0] -or $r[3] -le $r[1]) { return $null }
    return ,$r
}

function Test-ListingFrame([string]$XmlText, [string]$ExpectedName, [string]$ExpectedCode, [bool]$FirstFrame) {
    $readerSettings = [System.Xml.XmlReaderSettings]::new()
    $readerSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $readerSettings.XmlResolver = $null
    $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($XmlText), $readerSettings)
    try { $document = [System.Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader) }
    finally { $reader.Dispose() }
    $all = @($document.SelectNodes('//node'))
    if (-not $all.Count -or $all[0].bounds -ne '[0,0][720,1280]' -or $all[0].package -ne 'com.jihuanshe.pro') {
        throw 'Unexpected app or display.'
    }
    if ($all | Where-Object { $_.class -eq 'android.widget.EditText' -or $_.password -eq 'true' -or $_.text -in @('登录/注册', '请输入手机号') }) {
        throw 'Input or login screen is not public listing evidence.'
    }
    $nodes = @($all | ForEach-Object { [pscustomobject]@{
        text = [string]$_.text; 'content-desc' = [string]$_.'content-desc'; bounds = [string]$_.bounds; selected = [string]$_.selected
    } })
    $visible = @($nodes | Where-Object { $null -ne (Get-Rectangle $_.bounds) })
    $counts = @($visible | Where-Object { $_.'content-desc' -match '^卡牌,\s*[1-9]\d*$' })
    $countValues = @($counts | ForEach-Object { [int]($_.'content-desc'.Split(',')[1].Trim()) } | Select-Object -Unique)
    if ($countValues.Count -gt 1 -or ($FirstFrame -and $countValues.Count -ne 1)) { throw 'Card count is missing or ambiguous.' }
    $countTop = ($counts | ForEach-Object { (Get-Rectangle $_.bounds)[1] } | Measure-Object -Minimum).Minimum
    if ($FirstFrame -and -not ($visible | Where-Object { $_.text -eq $ExpectedCode -and (Get-Rectangle $_.bounds)[3] -le $countTop })) {
        throw 'Initial pack code is missing.'
    }
    $raw = @($visible | Where-Object { ($_.text -eq 'RAW' -or $_.'content-desc' -eq 'RAW') -and $_.selected -eq 'true' })
    $minimum = @($visible | Where-Object { $_.'content-desc' -eq '最低价' })
    if ($raw.Count -ne 1 -or -not $minimum.Count -or ($visible | Where-Object { $_.'content-desc' -eq 'PSA10' -and $_.selected -eq 'true' })) {
        throw 'RAW or lowest-price controls changed.'
    }
    $controlsBottom = (@($raw) + @($minimum) | ForEach-Object { (Get-Rectangle $_.bounds)[3] } | Measure-Object -Maximum).Maximum
    if (-not ($visible | Where-Object { $_.text -eq $ExpectedName -and (Get-Rectangle $_.bounds)[1] -le $controlsBottom })) {
        throw 'Pack header changed.'
    }
    $labels = @($visible | Where-Object { (Get-Rectangle $_.bounds)[1] -ge $controlsBottom -and $_.'content-desc' -match ',\s*\S+,\s*\S+' } |
        ForEach-Object { '{0}|{1}' -f $_.'content-desc', $_.bounds })
    if (-not $labels.Count) { throw 'No visible card rows; empty or loading state is not no-stock evidence.' }
    return [pscustomobject]@{ nodes = $nodes; count = $(if ($countValues.Count) { $countValues[0] } else { $null }); labels = $labels; swipeEndY = [int][Math]::Max(480, $controlsBottom + 48) }
}



function Get-Hash([byte[]]$Bytes) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false)) }

$runPath = $null
try {
    $config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
    $script:adbPath = 'D:\CODEX\output\pokemon-android-runtime\sdk\platform-tools\adb.exe'
    if ([IO.Path]::GetFullPath($config.android.adbPath) -ne $script:adbPath -or $config.android.transport -ne 'emulator' -or
        $config.android.serial -ne 'emulator-5580' -or $config.android.serverPort -ne 15037) { throw 'Unexpected device configuration.' }
    . (Join-Path $PSScriptRoot 'android-device.ps1')
    if ([string]::IsNullOrWhiteSpace($PackName)) { throw 'Pack name is required.' }
    $candidate = [IO.Path]::GetFullPath($OutputDir)
    if (-not $candidate.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $candidate)) {
        throw 'Output must be a new run directory inside D:\CODEX.'
    }
    $ancestor = [IO.DirectoryInfo]::new($candidate)
    while ($null -ne $ancestor) {
        if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Output cannot traverse reparse points.' }
        $ancestor = $ancestor.Parent
    }
    $script:stage = 'display_check'
    $display = [Text.Encoding]::UTF8.GetString((Invoke-Device @('shell', 'wm', 'size'))).Trim()
    if ($display -ne 'Physical size: 720x1280') { throw 'Only the verified display size is supported.' }
    $remoteXml = '/sdcard/pakra-public-list-{0}.xml' -f [Guid]::NewGuid().ToString('N')
    $pages = @(); $previousHash = $null; $previousLabels = $null; $unchanged = 0; $endObserved = $false; $initialCount = $null
    for ($page = 1; $page -le $MaxPages; $page++) {
        $script:stage = 'read_ui'
        $null = Invoke-Device @('shell', 'uiautomator', 'dump', $remoteXml)
        $xmlBytes = Invoke-Device @('exec-out', 'cat', $remoteXml)
        $null = Invoke-Device @('shell', 'rm', '--', $remoteXml)
        $script:stage = 'validate_public_listing'
        $frame = Test-ListingFrame ([Text.Encoding]::UTF8.GetString($xmlBytes)) $PackName $SetCode ($page -eq 1)
        if ($page -eq 1) { $initialCount = $frame.count }
        if (($null -ne $frame.count -and $frame.count -ne $initialCount) -or $frame.swipeEndY -ge 1130) { throw 'Listing continuity changed.' }
        $script:stage = 'capture_public_screenshot'
        $png = Invoke-Device @('exec-out', 'screencap', '-p')
        if ($png.Length -lt 24 -or [Convert]::ToHexString($png[0..7]) -ne '89504E470D0A1A0A' -or
            [Convert]::ToHexString($png[16..23]) -ne '000002D000000500') { throw 'Unexpected screenshot dimensions or format.' }
        $script:stage = 'save_evidence'
        if ($null -eq $runPath) {
            if (Test-Path -LiteralPath $candidate) { throw 'Output run directory was created by another process.' }
            [IO.Directory]::CreateDirectory($candidate) | Out-Null; $runPath = $candidate
        }
        $stem = 'page-{0:D3}' -f $page
        [IO.File]::WriteAllBytes((Join-Path $runPath "$stem.xml"), $xmlBytes)
        [IO.File]::WriteAllBytes((Join-Path $runPath "$stem.png"), $png)
        $nodesPath = Join-Path $runPath "$stem.nodes.json"
        Write-Json $nodesPath @($frame.nodes)
        $fingerprint = Get-Hash ([Text.Encoding]::UTF8.GetBytes(($frame.labels -join "`n")))
        if ($fingerprint -eq $previousLabels) { $unchanged++ } else { $unchanged = 0 }
        $endObserved = $unchanged -ge 2
        $entry = [ordered]@{ page = $page; capturedAt = [DateTime]::UtcNow.ToString('o'); xmlSha256 = (Get-Hash $xmlBytes)
            pngSha256 = (Get-Hash $png); nodesSha256 = (Get-Hash ([IO.File]::ReadAllBytes($nodesPath)))
            previousXmlSha256 = $previousHash; visibleRowsSha256 = $fingerprint; displayedCardCount = $frame.count
            headerCodeChecked = ($page -eq 1); continuity = $(if ($page -eq 1) { 'initial_header' } else { 'same_session_swipe' }) }
        Write-Json (Join-Path $runPath "$stem.json") $entry
        $pages += $entry; $previousHash = $entry.xmlSha256; $previousLabels = $fingerprint
        if ($endObserved -or $page -eq $MaxPages) { break }
        $script:stage = 'scroll_current_listing'
        $null = Invoke-Device @('shell', 'input', 'swipe', '600', '1130', '600', [string]$frame.swipeEndY, '450')
        Start-Sleep -Milliseconds 900
    }
    $report = [ordered]@{ status = 'public_listing_evidence_only'; context = @{ language = $Language; setId = $SetId; setCode = $SetCode; packName = $PackName }
        initialDisplayedCardCount = $initialCount; endObserved = $endObserved; completeCatalogVerified = $false; lowestAskingVerified = $false; pages = $pages }
    Write-Json (Join-Path $runPath 'session.json') $report
    [ordered]@{ status = $report.status; outputDir = $runPath; pages = $pages.Count; endObserved = $endObserved; lowestAskingVerified = $false } | ConvertTo-Json
} catch {
    $reasonCodes = @{
        'Unexpected app or display.' = 'unexpected_app_or_display'
        'Input or login screen is not public listing evidence.' = 'login_or_input_screen'
        'Pack header changed.' = 'pack_header_changed'
        'Card count is missing or ambiguous.' = 'card_count_missing_or_ambiguous'
        'Initial pack code is missing.' = 'initial_pack_code_missing'
        'RAW or lowest-price controls changed.' = 'listing_controls_changed'
        'No visible card rows; empty or loading state is not no-stock evidence.' = 'no_visible_card_rows'
        'Device command did not start.' = 'device_start_failed'
        'Device command timed out.' = 'device_timeout_30_seconds'
        'Device command failed.' = 'device_command_failed'
        'Unexpected device configuration.' = 'device_config_mismatch'
        'Pack name is required.' = 'pack_name_missing'
        'Output must be a new run directory inside D:\CODEX.' = 'output_not_new_workspace_directory'
        'Output cannot traverse reparse points.' = 'output_reparse_point'
        'Only the verified display size is supported.' = 'display_size_unsupported'
        'Listing continuity changed.' = 'listing_continuity_changed'
        'Unexpected screenshot dimensions or format.' = 'screenshot_format_or_size_changed'
        'Output run directory was created by another process.' = 'output_created_concurrently'
    }
    $reason = $reasonCodes[$_.Exception.Message]
    if (-not $reason) { $reason = 'unexpected_operation_failure' }
    $failure = [ordered]@{ status = 'capture_stopped'; failureStage = $script:stage
        reason = $reason
        outputDir = $runPath; lowestAskingVerified = $false }
    if ($null -ne $runPath) { Write-Json (Join-Path $runPath 'stopped.json') $failure }
    $failure | ConvertTo-Json
    exit 1
}
