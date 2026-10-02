#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$ListingPath,
    [Parameter(Mandatory)][string]$OutputDir,
    [ValidateRange(1, 20)][int]$MaxPackSwipes = 12
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'android-device.ps1')
$script:adbPath = 'D:\CODEX\output\pokemon-android-runtime\sdk\platform-tools\adb.exe'
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$remoteXml = '/sdcard/pakra-open-pack-' + [Guid]::NewGuid().ToString('N') + '.xml'
$stage = 'configuration'; $runPath = $null; $lockStream = $null

function Hash-Bytes([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Save-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 30), [Text.UTF8Encoding]::new($false)) }
function Rectangle($Node) {
    if ($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { return $null }
    $r = @(1..4 | ForEach-Object { [int]$Matches[$_] })
    if ($r[0] -lt 0 -or $r[1] -lt 48 -or $r[2] -gt 720 -or $r[3] -gt 1232 -or $r[2] -le $r[0] -or $r[3] -le $r[1]) { return $null }
    return ,$r
}
function Read-Frame {
    $null = Invoke-Device @('shell','rm','-f','--',$remoteXml)
    $null = Invoke-Device @('shell','uiautomator','dump',$remoteXml)
    $bytes = Invoke-Device @('exec-out','cat',$remoteXml)
    $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new([Text.Encoding]::UTF8.GetString($bytes)), $settings)
    try { $doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null; $doc.Load($reader) } finally { $reader.Dispose() }
    $all = @($doc.SelectNodes('//node')); $indexes = @{}
    if (-not $all.Count -or $all[0].bounds -ne '[0,0][720,1280]' -or $all[0].package -ne 'com.jihuanshe.pro') {
        $diagnostic = @{stage=$stage; nodeCount=$all.Count; rootBounds=$null; rootPackage=$null; rootClass=$null; at=[DateTime]::UtcNow.ToString('o')}
        if($all.Count) {
            $diagnostic.rootBounds = $(if($all[0].bounds -match '^\[\d{1,8},\d{1,8}\]\[\d{1,8},\d{1,8}\]$') { [string]$all[0].bounds } else { 'invalid_attribute' })
            $diagnostic.rootPackage = $(if($all[0].package -match '^[A-Za-z0-9_.$]{1,200}$') { [string]$all[0].package } else { 'invalid_attribute' })
            $diagnostic.rootClass = $(if($all[0].class -match '^[A-Za-z0-9_.$]{1,200}$') { [string]$all[0].class } else { 'invalid_attribute' })
        }
        if($runPath) { Save-Json (Join-Path $runPath 'public-frame-diagnostics.json') $diagnostic }
        throw 'unexpected_app_or_display'
    }
    if ($all | Where-Object { $_.package -ne 'com.jihuanshe.pro' -or $_.class -eq 'android.widget.EditText' -or $_.password -eq 'true' -or
            ([string]$_.text + ' ' + [string]$_.'content-desc') -match '登录|注册|验证码|手机号|手机号码|密码' }) { throw 'private_or_login_screen' }
    for ($i = 0; $i -lt $all.Count; $i++) { $indexes[$all[$i]] = $i }
    $nodes = @($all | ForEach-Object {
        $row = [ordered]@{}
        foreach ($attribute in $_.Attributes) { $row[$attribute.Name] = $attribute.Value }
        $row.parentIndex = $(if ($indexes.ContainsKey($_.ParentNode)) { $indexes[$_.ParentNode] } else { $null })
        [pscustomobject]$row
    })
    return @{ bytes = $bytes; nodes = $nodes }
}
function Find-Control($Frame, [string]$Label) {
    $found = @($Frame.nodes | Where-Object { $_.'content-desc' -eq $Label -and $_.clickable -eq 'true' -and $null -ne (Rectangle $_) })
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}
function Find-PackCarousel($Frame) {
    return @($Frame.nodes | Where-Object {
        $r = Rectangle $_
        $_.class -eq 'android.widget.HorizontalScrollView' -and $_.scrollable -eq 'true' -and $r -and
            $r[1] -ge 420 -and $r[3] -le 730 -and ($r[3]-$r[1]) -ge 180
    })
}
function Wait-Frame([scriptblock]$Predicate) {
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try { $frame = Read-Frame; if (& $Predicate $frame) { return $frame } }
        catch { if ($_.Exception.Message -match 'private|login' -or $attempt -eq 8) { throw } }
        Start-Sleep -Milliseconds 600
    }
    throw 'expected_public_state_not_reached'
}
function Tap-Control($Node) {
    $r = Rectangle $Node
    if ($null -eq $r -or $Node.clickable -ne 'true') { throw 'control_missing_or_not_visible' }
    $null = Invoke-Device @('shell','input','tap',[string][int](($r[0]+$r[2])/2),[string][int](($r[1]+$r[3])/2))
}
function Save-Frame($Frame, [string]$Stem) {
    $png = Invoke-Device @('exec-out','screencap','-p')
    if ($png.Length -lt 24 -or [Convert]::ToHexString($png[0..7]) -ne '89504E470D0A1A0A' -or [Convert]::ToHexString($png[16..23]) -ne '000002D000000500') { throw 'invalid_screenshot' }
    [IO.File]::WriteAllBytes((Join-Path $runPath "$Stem.xml"), $Frame.bytes)
    [IO.File]::WriteAllBytes((Join-Path $runPath "$Stem.png"), $png)
    Save-Json (Join-Path $runPath "$Stem.nodes.json") $Frame.nodes
    return @{ capturedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); xmlSha256 = (Hash-Bytes $Frame.bytes); pngSha256 = (Hash-Bytes $png) }
}
function Parse-Pack($Frame) {
    $start = [Diagnostics.ProcessStartInfo]::new($nodePath)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'app-pack-detail.mjs'))
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'parser_start_failed' }
        $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
        $payload = @{ mode = 'pack'; nodes = $Frame.nodes; context = $listing.context; expectedCards = $listing.observations; requireHeader = $true }
        $process.StandardInput.Write((ConvertTo-Json -InputObject $payload -Depth 30 -Compress)); $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) { $process.Kill($true); throw 'parser_timeout' }
        if (-not $out.Wait(1000) -or -not $err.Wait(1000)) { throw 'parser_output_failed' }
        $result = $out.Result | ConvertFrom-Json
        if ($process.ExitCode -ne 0 -or $result.error) {
            if ($result.error -match '^[a-z_]+$') { throw $result.error }
            throw 'pack_validation_failed'
        }
        return $result
    } finally { $process.Dispose() }
}

try {
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($config.android.adbPath) -ne $script:adbPath -or $config.android.transport -ne 'emulator' -or
        $config.android.serial -ne 'emulator-5580' -or $config.android.serverPort -ne 15037) { throw 'device_config_mismatch' }
    $referencePath = (Resolve-Path -LiteralPath $ListingPath).Path
    $listing = Get-Content -LiteralPath $referencePath -Raw | ConvertFrom-Json
    if ($listing.kind -ne 'public_listing_observations' -or -not $listing.endObserved -or $listing.missingCount -ne 0 -or
        $listing.observations.Count -ne $listing.displayedCardCount -or $listing.observations.Count -ne $listing.distinctCardNumbers -or
        $listing.duplicateCardNumbers.Count -ne 0 -or $listing.context.language -notin @('zh-Hans','ja','en') -or
        $listing.context.setId -notmatch '^[1-9]\d*$' -or $listing.context.setCode -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*$' -or
        [string]::IsNullOrWhiteSpace($listing.context.packName)) { throw 'incomplete_reference_listing' }
    $candidate = [IO.Path]::GetFullPath($OutputDir)
    if (-not $candidate.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $candidate)) { throw 'output_not_new_workspace_directory' }
    $ancestor = [IO.DirectoryInfo]::new($candidate)
    while ($ancestor) {
        if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'output_reparse_point' }
        $ancestor = $ancestor.Parent
    }
    $lockPath = Join-Path $PSScriptRoot 'output\run.lock'
    $lockStream = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $lockBytes = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; startedAt = [DateTime]::UtcNow.ToString('o'); operation = 'open_app_pack' } | ConvertTo-Json -Compress))
    $lockStream.Write($lockBytes, 0, $lockBytes.Length); $lockStream.Flush()
    [IO.Directory]::CreateDirectory($candidate) | Out-Null; $runPath = $candidate
    if ([Text.Encoding]::UTF8.GetString((Invoke-Device @('shell','wm','size'))).Trim() -ne 'Physical size: 720x1280') { throw 'unverified_display' }
    if ([Text.Encoding]::UTF8.GetString((Invoke-Device @('emu','avd','name'))).Replace("`r",'').Trim() -ne "PakraPokemon`nOK") { throw 'unexpected_avd' }

    $stage = 'start_public_home'
    $null = Invoke-Device @('shell','am','start','-S','-W','-n','com.jihuanshe.pro/.SplashActivity')
    $frame = Wait-Frame { param($f) @($f.nodes | Where-Object { $_.'content-desc' -like '游戏选择，当前*' -and $_.clickable -eq 'true' }).Count -eq 1 }
    $stage = 'select_pokemon'
    Tap-Control (@($frame.nodes | Where-Object { $_.'content-desc' -like '游戏选择，当前*' -and $_.clickable -eq 'true' })[0])
    $frame = Wait-Frame { param($f) $null -ne (Find-Control $f '宝可梦') -and $null -ne (Find-Control $f '关闭游戏选择器') }
    Tap-Control (Find-Control $frame '宝可梦')
    $frame = Wait-Frame { param($f) $null -ne (Find-Control $f '游戏选择，当前宝可梦') }
    $stage = 'select_language'
    $languageLabel = @{ 'zh-Hans' = '简中'; ja = '日文'; en = '英文' }[$listing.context.language]
    Tap-Control (Find-Control $frame $languageLabel)
    $packLabel = '{0}, {1}' -f $listing.context.packName, $listing.context.setCode
    $frame = Wait-Frame { param($f)
        (Find-Control $f $languageLabel).selected -eq 'true' -and
        $null -ne (Find-Control $f '游戏选择，当前宝可梦') -and
        ($null -ne (Find-Control $f $packLabel) -or @(Find-PackCarousel $f).Count -eq 1)
    }
    $homeEvidence = Save-Frame $frame 'language-home'

    $stage = 'find_exact_pack'
    $packSwipes = 0; $previousPackLabels = $null
    while ($null -eq (Find-Control $frame $packLabel)) {
        if ($packSwipes -ge $MaxPackSwipes) { throw 'pack_not_found_within_swipe_limit' }
        $scrollers = @(Find-PackCarousel $frame)
        if ($scrollers.Count -ne 1) { throw 'public_pack_carousel_missing' }
        $r = Rectangle $scrollers[0]
        $labels = ($frame.nodes | Where-Object { $_.clickable -eq 'true' -and $_.'content-desc' -like '*, *' -and $null -ne (Rectangle $_) } | ForEach-Object { $_.'content-desc' }) -join '|'
        if ($packSwipes -gt 0 -and $labels -eq $previousPackLabels) { throw 'pack_not_found_at_carousel_end' }
        $previousPackLabels = $labels
        $y = [string][int](($r[1]+$r[3])/2)
        $null = Invoke-Device @('shell','input','swipe','660',$y,'80',$y,'450')
        $packSwipes++
        $frame = Wait-Frame { param($f) (Find-Control $f $languageLabel).selected -eq 'true' -and $null -ne (Find-Control $f '游戏选择，当前宝可梦') }
    }
    Tap-Control (Find-Control $frame $packLabel)
    $stage = 'select_cards'
    $count = [int]$listing.displayedCardCount
    $cardLabel = '卡牌({0})' -f $count
    $frame = Wait-Frame { param($f) $null -ne (Find-Control $f $cardLabel) -or $null -ne (Find-Control $f ('卡牌, {0}' -f $count)) }
    $cardTab = Find-Control $frame $cardLabel
    if (-not $cardTab) { $cardTab = Find-Control $frame ('卡牌, {0}' -f $count) }
    Tap-Control $cardTab
    $frame = Wait-Frame { param($f) $null -ne (Find-Control $f 'RAW') }
    if ((Find-Control $frame 'RAW').selected -ne 'true') { Tap-Control (Find-Control $frame 'RAW') }
    $stage = 'verify_pack_header'
    $parsed = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try { $frame = Read-Frame; $parsed = Parse-Pack $frame; if (-not $parsed.targets.Count) { throw 'no_visible_expected_cards' }; break }
        catch { if ($_.Exception.Message -match 'private|login' -or $attempt -eq 8) { throw }; Start-Sleep -Milliseconds 600 }
    }
    $packEvidence = Save-Frame $frame 'pack-first'
    Save-Json (Join-Path $runPath 'pack-first.parsed.json') $parsed
    $report = [ordered]@{ status = 'pack_opened'; context = $listing.context; expectedCards = $count; headerVerified = $true; cardTabClicked = $true
        languageSelected = $languageLabel; packSwipes = $packSwipes; referencePath = $referencePath; referenceSha256 = (Hash-Bytes ([IO.File]::ReadAllBytes($referencePath)))
        homeEvidence = $homeEvidence; packEvidence = $packEvidence; outputDir = $runPath; evidencePath = (Join-Path $runPath 'pack-first.xml') }
    Save-Json (Join-Path $runPath 'result.json') $report
    $report | ConvertTo-Json -Depth 5
} catch {
    $reason = $_.Exception.Message
    if ($reason -notmatch '^[a-z_]+$') { $reason = 'device_or_file_operation_failed' }
    $failure = [ordered]@{ status = 'open_pack_stopped'; stage = $stage; reason = $reason; outputDir = $runPath
        errorType = $_.Exception.GetType().Name; errorLine = $_.InvocationInfo.ScriptLineNumber }
    if ($runPath) { Save-Json (Join-Path $runPath 'failure.json') $failure }
    $failure | ConvertTo-Json
    exit 1
} finally {
    if ($lockStream) {
        try { $null = Invoke-Device @('shell','rm','-f','--',$remoteXml) } catch { }
        $lockStream.Dispose(); Remove-Item -LiteralPath $lockPath
    }
}
