#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$ContextPath,
    [Parameter(Mandatory)][string]$OutputDir,
    [ValidateRange(1, 20)][int]$MaxPages = 3
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-device.ps1')
$stage = 'configuration'
$runPath = $null
$remoteXml = '/sdcard/pakra-card-detail-' + [Guid]::NewGuid().ToString('N') + '.xml'
$script:optionalUpdateDismissed=$false

function Write-DetailJson([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Detail-Hash([byte[]]$Bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-English30thDisplayName($Context) {
    if ($Context.language -cne 'en' -or [string]$Context.setId -cne '100236' -or
        $Context.setCode -cne '30C' -or $Context.packName -cne '30周年庆典') { return $null }
    $hasOriginalName=$Context.PSObject.Properties.Name -ccontains 'originalName'
    if ($hasOriginalName -and -not [string]::IsNullOrWhiteSpace($Context.originalName) -and $Context.originalName -cne $Context.cardName) {
        return $Context.originalName
    }
    if (-not $hasOriginalName -and $Context.cardName -match '[A-Za-z]' -and
        $Context.cardName -notmatch '[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]') { return $Context.cardName }
    return $null
}
function Get-OptionalUpdateDismissControl($Nodes) {
    if ($Nodes.Count -ne 11 -or $Nodes[0].bounds -cne '[0,48][720,1232]' -or
        @($Nodes | Where-Object { $_.package -cne 'com.jihuanshe.pro' -or $_.password -eq 'true' -or $_.class -eq 'android.widget.EditText' }).Count) { return $null }
    $labels=@($Nodes | ForEach-Object { ([string]$_.text -replace '\s+',' ').Trim() })
    if ('发现新版本' -cnotin $labels -or '集换社 Pro 0.4.0 已发布，建议更新至最新版本。' -cnotin $labels) { return $null }
    $buttons=@($Nodes | Where-Object { $_.clickable -eq 'true' })
    $later=@($buttons | Where-Object { $_.text -ceq '稍后' -and $_.class -ceq 'android.widget.TextView' -and $_.bounds -ceq '[120,711][342,795]' })
    $update=@($buttons | Where-Object { $_.text -ceq '立即更新' -and $_.class -ceq 'android.widget.TextView' -and $_.bounds -ceq '[378,711][600,795]' })
    if ($buttons.Count -eq 2 -and $later.Count -eq 1 -and $update.Count -eq 1 -and
        [object]::ReferenceEquals($later[0].ParentNode,$update[0].ParentNode)) { return $later[0] }
    return $null
}
function Read-DetailFrame($Context, [bool]$RequireHeader, [bool]$VersionPanel = $false) {
    $script:detailLoadingObserved=$false
    $script:detailHeaderPending=$false
    $script:detailHeaderProgress=$null
    $null = Invoke-Device @('shell', 'rm', '-f', '--', $remoteXml)
    $null = Invoke-Device @('shell', 'uiautomator', 'dump', $remoteXml)
    $bytes = Invoke-Device @('exec-out', 'cat', $remoteXml)
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new([Text.Encoding]::UTF8.GetString($bytes)), $settings)
    try { $doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null; $doc.Load($reader) }
    finally { $reader.Dispose() }
    $all = @($doc.SelectNodes('//node'))
    $packages = @($all | ForEach-Object { [string]$_.package } | Sort-Object -Unique)
    if (-not $all.Count -or $all[0].package -ne 'com.jihuanshe.pro' -or $all[0].bounds -notin @('[0,0][720,1280]', '[0,48][720,1232]') -or
        @($packages | Where-Object { $_ -ne 'com.jihuanshe.pro' }).Count) {
        if ($runPath) {
            Write-DetailJson (Join-Path $runPath 'frame-layout-diagnostic.json') @{
                kind='layout_diagnostic_not_quote'; at=[DateTime]::UtcNow.ToString('o'); nodeCount=$all.Count
                rootPackage=$(if ($all.Count) { [string]$all[0].package } else { $null })
                rootBounds=$(if ($all.Count) { [string]$all[0].bounds } else { $null }); packages=$packages
            }
        }
        throw 'unexpected_app_or_display'
    }
    foreach ($item in $all) {
        if ($item.password -eq 'true' -or ([string]$item.text+' '+[string]$item.'content-desc') -match '登录|注册|验证码|手机号|手机号码|密码' -or
            ($item.class -eq 'android.widget.EditText' -and $item.text -notin @($Context.cardName, $Context.originalName, $Context.cardNumber))) {
            throw 'login_or_private_input'
        }
    }
    if ($RequireHeader -and -not $VersionPanel -and -not $script:optionalUpdateDismissed) {
        $dismiss=Get-OptionalUpdateDismissControl $all
        if ($null -ne $dismiss) {
            Tap-DetailNode $dismiss
            $script:optionalUpdateDismissed=$true
            Write-DetailJson (Join-Path $runPath 'optional-update-dismissed.json') @{
                kind='optional_update_dismissed_not_quote'; version='0.4.0'; action='later'; quoteEligible=$false; at=[DateTime]::UtcNow.ToString('o')
            }
            throw 'optional_update_dismissed'
        }
    }
    $labels = @($all | ForEach-Object { $_.text; $_.'content-desc' })
    $languageLabel=@{ 'zh-Hans'='简中'; ja='日文'; en='英文' }[$Context.language]
    $inputNodes=@($all | Where-Object { $_.class -eq 'android.widget.EditText' })
    $inputTexts=@($inputNodes | ForEach-Object { $_.text })
    $legacyHeader=$Context.cardName -in $inputTexts -and $Context.cardNumber -in $inputTexts -and
        $languageLabel -in $labels -and $Context.packName -in $labels
    $englishHeader=$false
    $englishDisplayName=Get-English30thDisplayName $Context
    if ($englishDisplayName) {
        $names=@($inputNodes | Where-Object { $_.text -ceq $englishDisplayName })
        $numbers=@($inputNodes | Where-Object { $_.text -ceq $Context.cardNumber })
        $series=@($all | Where-Object { $_.class -eq 'android.widget.Button' -and $_.'content-desc' -ceq '查看系列 30th Celebration' })
        if ($inputNodes.Count -eq 2 -and $names.Count -eq 1 -and $numbers.Count -eq 1 -and $series.Count -eq 1 -and
            [object]::ReferenceEquals($names[0].ParentNode,$numbers[0].ParentNode) -and $languageLabel -in $labels) {
            $descendants=@($names[0].ParentNode.SelectNodes('.//node'))
            $visible=@(@($names[0],$numbers[0],$series[0]) | Where-Object {
                $_.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$' -and
                [int]$Matches[1] -ge 0 -and [int]$Matches[2] -ge 144 -and [int]$Matches[3] -le 720 -and
                [int]$Matches[4] -le 600 -and [int]$Matches[3] -gt [int]$Matches[1] -and [int]$Matches[4] -gt [int]$Matches[2]
            })
            $englishHeader=$visible.Count -eq 3 -and $series[0] -in $descendants -and
                @($descendants | Where-Object { $_.text -ceq $languageLabel }).Count -gt 0 -and
                @($descendants | Where-Object { $_.text -ceq '宝可梦' }).Count -gt 0
        }
    }
    $headerMatch=$legacyHeader -or $englishHeader
    $headerIdentity=$(if ($headerMatch) { @{layout=$(if($legacyHeader){'canonical_header'}elseif($Context.PSObject.Properties.Name -ccontains 'originalName'){'original_name_only'}else{'canonical_name_only'});
        actualHeaderName=$(if($legacyHeader){$Context.cardName}else{$englishDisplayName});
        actualPackName=$(if($legacyHeader){$Context.packName}else{'30th Celebration'});
        cardNumber=$Context.cardNumber;languageLabel=$languageLabel} } else {$null})
    if ($RequireHeader -and -not $VersionPanel) {
        $languageLabel=@{ 'zh-Hans'='简中'; ja='日文'; en='英文' }[$Context.language]
        $script:detailHeaderPending=$Context.cardNumber -in $labels -and '单卡' -in $labels -and
            '评级卡' -in $labels -and '立即加购' -in $labels
        # Save matches and input geometry only; never retain unknown input text or full XML.
        $script:detailHeaderProgress=@{kind='header_progress_not_quote'; at=[DateTime]::UtcNow.ToString('o');
            pending=$script:detailHeaderPending;
            matched=@{name=($Context.cardName -in $labels);originalName=($Context.originalName -in $labels);
                number=($Context.cardNumber -in $labels);pack=($Context.packName -in $labels);language=($languageLabel -in $labels)};
            inputLayout=@($all | Where-Object { $_.class -eq 'android.widget.EditText' } | ForEach-Object {
                @{bounds=[string]$_.bounds;known=($_.text -in @($Context.cardName,$Context.originalName,$Context.cardNumber))}
            })}
    }
    if ($RequireHeader -and -not $VersionPanel -and $script:detailHeaderPending) {
        $knownInputs=@($all | Where-Object { $_.class -eq 'android.widget.EditText' })
        $inputTexts=@($knownInputs | ForEach-Object { $_.text })
        $diagnosticGate=$Context.originalName -in $inputTexts -and $Context.cardNumber -in $inputTexts -and
            $languageLabel -in $labels -and [bool]($labels | Where-Object { $_ -match '^一口价(?:,\s*(?:\d+|999\+))?$' })
        if ($diagnosticGate) {
            $topNodes=@($all | Where-Object {
                $_.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$' -and
                [int]$Matches[1] -ge 320 -and [int]$Matches[2] -ge 144 -and [int]$Matches[3] -le 720 -and
                [int]$Matches[4] -le 600 -and [int]$Matches[3] -gt [int]$Matches[1] -and [int]$Matches[4] -gt [int]$Matches[2]
            })
            $script:detailHeaderProgress.publicHeader=@{
                knownInputs=@($topNodes | Where-Object { $_.class -eq 'android.widget.EditText' -and
                    $_.text -in @($Context.cardName,$Context.originalName,$Context.cardNumber) } | ForEach-Object {
                    @{text=[string]$_.text;bounds=[string]$_.bounds}
                });
                seriesButtons=@($topNodes | Where-Object { $_.class -eq 'android.widget.Button' -and
                    $_.'content-desc' -match '^查看系列(?:[ ,，][\p{L}\p{N}\p{P}\p{Zs}]{1,100})?$' -and
                    $_.'content-desc' -notmatch '(?i)https?://|www\.|@|[0-9]{8,}' } | ForEach-Object {
                    @{description=[string]$_.'content-desc';bounds=[string]$_.bounds}
                })
            }
        }
    }
    if ($VersionPanel) {
        $prefix=$Context.cardName + ', 当前, ' + $Context.cardNumber + ','
        $currentVersion=[bool]($labels | Where-Object { $_.StartsWith($prefix) })
        if (-not $currentVersion -and $englishDisplayName) {
            $prefix=$englishDisplayName + ', 当前, ' + $Context.cardNumber + ','
            $currentVersion=@($all | Where-Object { $_.class -eq 'android.widget.Button' -and
                $_.'content-desc'.StartsWith($prefix,[StringComparison]::Ordinal) }).Count -eq 1
        }
        if ('全部语言版本' -notin $labels -or -not $currentVersion) {
            throw 'current_version_missing'
        }
    } elseif ('单卡' -notin $labels -or '评级卡' -notin $labels -or '立即加购' -notin $labels -or
        -not ($labels | Where-Object { $_ -match '^一口价(?:,\s*(?:\d+|999\+))?$' })) {
        if($runPath) {
            Write-DetailJson (Join-Path $runPath 'public-control-diagnostics.json') @{
                stage=$stage; at=[DateTime]::UtcNow.ToString('o'); nodeCount=$all.Count;
                rootPackage=[string]$all[0].package; rootBounds=[string]$all[0].bounds;
                controls=@{single=('单卡' -in $labels); graded=('评级卡' -in $labels); buy=('立即加购' -in $labels);
                    fixedOffer=[bool]($labels | Where-Object { $_ -match '^一口价(?:,\s*(?:\d+|999\+))?$' });
                    gameHome=[bool]($labels | Where-Object { $_ -like '游戏选择，当前*' });
                    versions=('全部语言版本' -in $labels)};
                identity=@{name=($Context.cardName -in $labels); number=($Context.cardNumber -in $labels);
                    pack=($Context.packName -in $labels)}
            }
            $languageLabel=@{ 'zh-Hans'='简中'; ja='日文'; en='英文' }[$Context.language]
            $publicHeader=$headerMatch
            $script:detailLoadingObserved=$publicHeader -and '查看行情, 加载中' -in $labels
            if($publicHeader) {
                $topNodes=@($all | Where-Object {
                    $_.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$' -and
                    [int]$Matches[1] -ge 0 -and [int]$Matches[2] -ge 48 -and [int]$Matches[3] -le 720 -and [int]$Matches[4] -le 900
                } | ForEach-Object { @{class=[string]$_.class;bounds=[string]$_.bounds;text=[string]$_.text;
                    description=[string]$_.'content-desc';clickable=[string]$_.clickable;selected=[string]$_.selected} })
                Write-DetailJson (Join-Path $runPath 'public-header-diagnostic.nodes.json') @{kind='diagnostic_not_quote';nodes=$topNodes}
                $png=Invoke-Device @('exec-out','screencap','-p')
                if($png.Length -lt 24 -or [Convert]::ToHexString($png[0..7]) -ne '89504E470D0A1A0A' -or
                    [Convert]::ToHexString($png[16..23]) -ne '000002D000000500') { throw 'screenshot_format_or_size_changed' }
                $stream=[IO.MemoryStream]::new($png,$false)
                $bitmap=$null; $cropped=$null
                try {
                    Add-Type -AssemblyName System.Drawing
                    $bitmap=[Drawing.Bitmap]::new($stream)
                    $cropped=$bitmap.Clone([Drawing.Rectangle]::new(0,48,720,852),$bitmap.PixelFormat)
                    $cropped.Save((Join-Path $runPath 'public-header-diagnostic.png'),[Drawing.Imaging.ImageFormat]::Png)
                } finally { if($cropped){$cropped.Dispose()}; if($bitmap){$bitmap.Dispose()}; $stream.Dispose() }
            }
        }
        throw 'detail_controls_missing'
    }
    if ($RequireHeader) {
        if (-not $headerMatch) { throw 'card_header_mismatch' }
        if ($runPath) { Write-DetailJson (Join-Path $runPath 'public-header-identity.json') $headerIdentity }
    }
    $indexes = @{}
    for ($i = 0; $i -lt $all.Count; $i++) { $indexes[$all[$i]] = $i }
    $nodes = @($all | ForEach-Object {
        $row = [ordered]@{}
        foreach ($attribute in $_.Attributes) { $row[$attribute.Name] = $attribute.Value }
        $row['parentIndex'] = $(if ($indexes.ContainsKey($_.ParentNode)) { $indexes[$_.ParentNode] } else { $null })
        [pscustomobject]$row
    })
    return @{ bytes = $bytes; nodes = $nodes; headerIdentity = $headerIdentity }
}

function Save-DetailFrame($Frame, [string]$Stem) {
    $png = Invoke-Device @('exec-out', 'screencap', '-p')
    if ($png.Length -lt 24 -or [Convert]::ToHexString($png[0..7]) -ne '89504E470D0A1A0A' -or
        [Convert]::ToHexString($png[16..23]) -ne '000002D000000500') { throw 'screenshot_format_or_size_changed' }
    [IO.File]::WriteAllBytes((Join-Path $runPath "$Stem.xml"), $Frame.bytes)
    [IO.File]::WriteAllBytes((Join-Path $runPath "$Stem.png"), $png)
    $nodesPath = Join-Path $runPath "$Stem.nodes.json"
    Write-DetailJson $nodesPath $Frame.nodes
    return [ordered]@{ capturedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        xmlSha256 = (Detail-Hash $Frame.bytes); pngSha256 = (Detail-Hash $png)
        nodesSha256 = (Detail-Hash ([IO.File]::ReadAllBytes($nodesPath))) }
}

function Wait-DetailFrame($Context, [bool]$RequireHeader, [bool]$VersionPanel = $false) {
    for ($attempt = 1; $attempt -le 16; $attempt++) {
        try { return Read-DetailFrame $Context $RequireHeader $VersionPanel }
        catch {
            $knownLoading=($_.Exception.Message -eq 'detail_controls_missing' -and $script:detailLoadingObserved) -or
                $_.Exception.Message -eq 'optional_update_dismissed'
            $knownHeaderPending=$RequireHeader -and -not $VersionPanel -and $script:detailHeaderPending -and
                $_.Exception.Message -in @('detail_controls_missing','card_header_mismatch')
            if ($script:detailHeaderProgress -and $runPath -and $_.Exception.Message -in @('detail_controls_missing','card_header_mismatch')) {
                $script:detailHeaderProgress.attempt=$attempt
                Write-DetailJson (Join-Path $runPath ('header-progress-{0:D2}.json' -f $attempt)) $script:detailHeaderProgress
            }
            if ($_.Exception.Message -eq 'login_or_private_input' -or $attempt -eq 16 -or
                ($attempt -ge 8 -and -not $knownLoading -and -not $knownHeaderPending)) { throw }
            Start-Sleep -Milliseconds 800
        }
    }
}

function Tap-DetailNode($Node) {
    if ($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'invalid_control_bounds' }
    $left, $top, $right, $bottom = 1..4 | ForEach-Object { [int]$Matches[$_] }
    if ($left -lt 0 -or $top -lt 48 -or $right -gt 720 -or $bottom -gt 1087 -or $right -le $left -or $bottom -le $top) {
        throw 'control_not_fully_visible'
    }
    $null = Invoke-Device @('shell', 'input', 'tap', [string][int](($left + $right)/2), [string][int](($top + $bottom)/2))
}

try {
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $script:adbPath = 'D:\CODEX\output\pokemon-android-runtime\sdk\platform-tools\adb.exe'
    if ([IO.Path]::GetFullPath($config.android.adbPath) -ne $script:adbPath -or $config.android.transport -ne 'emulator' -or
        $config.android.serial -ne 'emulator-5580' -or $config.android.serverPort -ne 15037) { throw 'device_config_mismatch' }
    $context = Get-Content -LiteralPath $ContextPath -Raw | ConvertFrom-Json
    if ($context.language -notin @('zh-Hans', 'ja', 'en') -or $context.setId -notmatch '^[1-9]\d*$' -or
        [string]::IsNullOrWhiteSpace($context.cardName) -or [string]::IsNullOrWhiteSpace($context.cardNumber) -or
        [string]::IsNullOrWhiteSpace($context.packName) -or
        $context.shareUrl -notmatch '^https://api\.jihuanshe\.com/pro/cards/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$') {
        throw 'invalid_explicit_card_context'
    }
    $uuid = $Matches[1]
    $candidate = [IO.Path]::GetFullPath($OutputDir)
    if (-not $candidate.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $candidate)) {
        throw 'output_must_be_new_workspace_directory'
    }
    $ancestor = [IO.DirectoryInfo]::new($candidate)
    while ($null -ne $ancestor) {
        if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'output_reparse_point' }
        $ancestor = $ancestor.Parent
    }
    [IO.Directory]::CreateDirectory($candidate) | Out-Null
    $runPath = $candidate
    $stage = 'device_connection'
    if ([Text.Encoding]::UTF8.GetString((Invoke-Device @('get-state'))).Trim() -ne 'device') { throw 'device_not_connected' }
    if ([Text.Encoding]::UTF8.GetString((Invoke-Device @('shell', 'wm', 'size'))).Trim() -ne 'Physical size: 720x1280') {
        throw 'display_size_unsupported'
    }
    $stage = 'open_known_card'
    # A repeated deep link can keep the old scroll position. Restart only this
    # App in the isolated emulator so the next capture starts at the header.
    $null = Invoke-Device @('shell', 'am', 'force-stop', 'com.jihuanshe.pro')
    $null = Invoke-Device @('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', "jihuanshepro://pro/cards/$uuid", '-p', 'com.jihuanshe.pro')
    $pages = @()
    $previousHash = $null
    for ($page = 1; $page -le $MaxPages; $page++) {
        $stage = 'validate_public_detail'
        $frame = Wait-DetailFrame $context ($page -eq 1)
        $stage = 'save_public_evidence'
        $stem = 'page-{0:D3}' -f $page
        $entry = Save-DetailFrame $frame $stem
        $entry.page = $page
        $entry.previousXmlSha256 = $previousHash
        $entry.headerChecked = ($page -eq 1)
        $entry.continuity = $(if ($page -eq 1) { 'exact_header_after_known_deeplink' } else { 'same_session_swipe' })
        $pages += $entry
        $previousHash = $entry.xmlSha256
        if ($page -eq 1) {
            $stage = 'read_explicit_minimum_label'
            $openVersions = @($frame.nodes | Where-Object { $_.'content-desc' -match '^查看全部语言版本，共\s*\d+\s*张$' })
            if ($openVersions.Count -ne 1) { throw 'version_control_missing' }
            Tap-DetailNode $openVersions[0]
            $minimumFrame = Wait-DetailFrame $context $false $true
            $minimumEvidence = Save-DetailFrame $minimumFrame 'minimum'
            $close = @($minimumFrame.nodes | Where-Object { $_.'content-desc' -eq '收起' })
            if ($close.Count -ne 1) { throw 'version_close_control_missing' }
            Tap-DetailNode $close[0]
            $null = Wait-DetailFrame $context $true
        }
        Write-DetailJson (Join-Path $runPath 'session.json') @{ status = 'in_progress'; context = $context; pages = $pages; minimumEvidence = $minimumEvidence }
        if ($page -lt $MaxPages) {
            $stage = 'scroll_offers'
            $null = Invoke-Device @('shell', 'input', 'swipe', '640', '1060', '640', '500', '650')
            Start-Sleep -Milliseconds 800
        }
    }
    $result = [ordered]@{ status = 'public_detail_evidence_only'; context = $context; pages = $pages; minimumEvidence = $minimumEvidence
        lowestAskingVerified = $false; originalImageDownloaded = $false; conditionSelectionVerified = $false
        note = 'Visible offer observations only. No exhaustive or ascending-order proof; no quote or Shopify write.' }
    Write-DetailJson (Join-Path $runPath 'session.json') $result
    @{ status = $result.status; outputDir = $runPath; pages = $pages.Count } | ConvertTo-Json
} catch {
    $reason = $_.Exception.Message
    if ($reason -notmatch '^[a-z_]+$') { $reason = 'device_or_capture_failed' }
    $failure = @{ status = 'capture_stopped'; stage = $stage; reason = $reason; observedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    if ($runPath) { Write-DetailJson (Join-Path $runPath 'failure.json') $failure }
    $failure | ConvertTo-Json
    exit 1
} finally {
    if ($script:adbPath -and $runPath) { try { $null = Invoke-Device @('shell', 'rm', '--', $remoteXml) } catch {} }
}
