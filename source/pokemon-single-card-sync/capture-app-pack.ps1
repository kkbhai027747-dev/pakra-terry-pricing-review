#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$ListingPath,
    [Parameter(Mandatory)][string]$OutputDir,
    [ValidateRange(1, 600)][int]$MaxCards = 25,
    [ValidateRange(1, 200)][int]$MaxPages = 100
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'android-device.ps1')
$script:adbPath = 'D:\CODEX\output\pokemon-android-runtime\sdk\platform-tools\adb.exe'
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$remoteXml = '/sdcard/pakra-pack-' + [Guid]::NewGuid().ToString('N') + '.xml'
$stage = 'configuration'
$runPath = $null
$lockStream = $null
$pendingCardDir = $null

function Save-Json([string]$Path, $Value) {
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}
function Hash-Bytes([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Set-Stage([string]$Value) {
    $script:stage=$Value
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'output\app-packs\stop.requested')) { throw 'stop_requested' }
    if($runPath) { Save-Json (Join-Path $runPath 'current-run.json') @{status='in_progress';stage=$Value;pid=$PID;updatedAt=[DateTime]::UtcNow.ToString('o')} }
}
function Verify-ExistingCard([string]$Directory) {
    $start=[Diagnostics.ProcessStartInfo]::new($nodePath)
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false); $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    foreach($arg in @((Join-Path $PSScriptRoot 'verify-app-pack.mjs'),'--card-directory',$Directory,'--listing',(Resolve-Path -LiteralPath $ListingPath).Path)) { $start.ArgumentList.Add($arg) }
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        if(-not $process.Start()) { throw 'evidence_verifier_start_failed' }
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(15000)) { $process.Kill($true); throw 'evidence_verifier_timeout' }
        if(-not $stdout.Wait(1000) -or -not $stderr.Wait(1000) -or $process.ExitCode -ne 0) { throw 'existing_card_evidence_invalid' }
        return ($stdout.Result | ConvertFrom-Json)
    } finally { $process.Dispose() }
}
function Read-Frame {
    $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
    $xmlFailures = @()
    for($attempt=1; $attempt -le 3; $attempt++) {
        $null = Invoke-Device @('shell','rm','-f','--',$remoteXml)
        $null = Invoke-Device @('shell','uiautomator','dump',$remoteXml)
        $bytes = Invoke-Device @('exec-out','cat',$remoteXml)
        $xmlText = [Text.Encoding]::UTF8.GetString($bytes)
        $reader = $null
        try {
            $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($xmlText), $settings)
            $doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null; $doc.Load($reader)
            break
        } catch {
            $xmlError = $_.Exception.GetBaseException()
            if($xmlError -isnot [Xml.XmlException]) { throw }
            $prohibitedDtd = $xmlText.Contains('<!DOCTYPE', [StringComparison]::Ordinal)
            $xmlFailures += @(@{attempt=$attempt; byteLength=$bytes.Length; errorType='XmlException';
                lineNumber=$xmlError.LineNumber; linePosition=$xmlError.LinePosition;
                category=$(if($prohibitedDtd){'dtd_prohibited'}elseif([string]::IsNullOrWhiteSpace($xmlText)){'empty_xml'}else{'malformed_xml'})})
            if($runPath) { Save-Json (Join-Path $runPath 'ui-xml-diagnostics.json') @{
                stage=$stage; reason='invalid_ui_xml'; recovered=$false; attempts=$xmlFailures; at=[DateTime]::UtcNow.ToString('o')} }
            if($prohibitedDtd -or $attempt -eq 3) { throw 'invalid_ui_xml' }
        } finally { if($reader) { $reader.Dispose() } }
        Start-Sleep -Milliseconds 800
    }
    if($xmlFailures.Count -and $runPath) { Save-Json (Join-Path $runPath 'ui-xml-diagnostics.json') @{
        stage=$stage; reason='invalid_ui_xml'; recovered=$true; attempts=$xmlFailures; at=[DateTime]::UtcNow.ToString('o')} }
    $all = @($doc.SelectNodes('//node')); $indexes = @{}
    for ($i=0; $i -lt $all.Count; $i++) { $indexes[$all[$i]] = $i }
    $nodes = @($all | ForEach-Object {
        $row = [ordered]@{}
        foreach($attribute in $_.Attributes) { $row[$attribute.Name] = $attribute.Value }
        $row.parentIndex = $(if($indexes.ContainsKey($_.ParentNode)) { $indexes[$_.ParentNode] } else { $null })
        [pscustomobject]$row
    })
    return @{ bytes=$bytes; nodes=$nodes }
}
function Parse-Frame($Frame, [string]$Mode, $ExpectedCard, [bool]$RequireHeader = $false) {
    $start = [Diagnostics.ProcessStartInfo]::new($nodePath)
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'app-pack-detail.mjs'))
    $process = [Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        if(-not $process.Start()) { throw 'parser_start_failed' }
        $out=$process.StandardOutput.ReadToEndAsync(); $err=$process.StandardError.ReadToEndAsync()
        $payload = @{ mode=$Mode; nodes=$Frame.nodes; context=$listing.context; expectedCards=$listing.observations; expectedCard=$ExpectedCard; requireHeader=$RequireHeader }
        $process.StandardInput.Write(($payload | ConvertTo-Json -Depth 30 -Compress)); $process.StandardInput.Close()
        if(-not $process.WaitForExit(10000)) { $process.Kill($true); throw 'parser_timeout' }
        if(-not $out.Wait(1000) -or -not $err.Wait(1000)) { throw 'parser_output_failed' }
        $result=$out.Result | ConvertFrom-Json
        if($process.ExitCode -ne 0 -or $result.error) {
            if($result.error -eq 'unexpected_public_input' -and $result.diagnostic -and $runPath) {
                Save-Json (Join-Path $runPath 'detail-input-diagnostics.json') @{
                    stage=$stage; cardNumber=$ExpectedCard.cardNumber; at=[DateTime]::UtcNow.ToString('o'); detail=$result.diagnostic}
            }
            if($result.error -match '^[a-z_]+$') { throw $result.error }
            throw 'public_frame_validation_failed'
        }
        return $result
    } finally { $process.Dispose() }
}
function Wait-Parsed([string]$Mode, $ExpectedCard, [bool]$RequireHeader = $false) {
    for($attempt=1;$attempt -le 8;$attempt++) {
        try { $frame=Read-Frame; $parsed=Parse-Frame $frame $Mode $ExpectedCard $RequireHeader; return @{frame=$frame; parsed=$parsed} }
        catch {
            if($_.Exception.Message -match 'login|private|password|^invalid_ui_xml$|^device_command_' -or $attempt -eq 8) { throw }
            Start-Sleep -Milliseconds 800
        }
    }
}
function Find-One($Frame, [string]$Field, [string]$Value) {
    $found=@($Frame.nodes | Where-Object { $_.$Field -eq $Value })
    if($found.Count -ne 1) { throw 'expected_control_missing_or_ambiguous' }
    return $found[0]
}
function Tap-Node($Node) {
    if($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'invalid_control_bounds' }
    $r=1..4 | ForEach-Object { [int]$Matches[$_] }
    if($r[0] -lt 0 -or $r[1] -lt 48 -or $r[2] -gt 720 -or $r[3] -gt 1232 -or $r[2] -le $r[0] -or $r[3] -le $r[1]) { throw 'control_not_visible' }
    $null=Invoke-Device @('shell','input','tap',[string][int](($r[0]+$r[2])/2),[string][int](($r[1]+$r[3])/2))
}
function Copy-PublicCardLink($DetailFrame) {
    Tap-Node (Find-One $DetailFrame 'content-desc' '更多')
    $frame=Read-Frame
    Tap-Node (Find-One $frame 'text' '复制链接')
    $null=Invoke-Device @('shell','am','start','-W','-a','android.settings.SETTINGS')
    $fieldId='com.google.android.settings.intelligence:id/open_search_view_edit_text'
    for($attempt=1;$attempt -le 6;$attempt++) {
        $frame=Read-Frame
        $fields=@($frame.nodes | Where-Object { $_.'resource-id' -eq $fieldId })
        if($fields.Count -eq 1) { break }
        $search=@($frame.nodes | Where-Object { $_.'resource-id' -eq 'com.android.settings:id/search_action_bar' })
        if($search.Count -eq 1) { Tap-Node $search[0] }
        elseif($attempt -eq 6) { throw 'settings_search_missing' }
    }
    if($fields.Count -ne 1 -or $fields[0].password -eq 'true') { throw 'settings_search_missing' }
    if($fields[0].text -notin @('','Search settings')) {
        if($fields[0].text -notmatch 'https://api\.jihuanshe\.com/pro/cards/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}') { throw 'unexpected_settings_input' }
        Tap-Node (Find-One $frame 'resource-id' 'com.google.android.settings.intelligence:id/open_search_view_clear_button')
        $frame=Read-Frame
    }
    $field=Find-One $frame 'resource-id' $fieldId
    if($field.text -notin @('','Search settings')) { throw 'search_not_empty' }
    Tap-Node $field
    $null=Invoke-Device @('shell','input','keyevent','KEYCODE_PASTE')
    $frame=Read-Frame
    $field=Find-One $frame 'resource-id' $fieldId
    $urlMatches=[regex]::Matches($field.text,'https://api\.jihuanshe\.com/pro/cards/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')
    if($urlMatches.Count -ne 1) { throw 'official_card_link_missing' }
    return $urlMatches[0].Value
}
function Save-PublicFrame($Frame, [string]$Directory, [string]$Stem) {
    $png=Invoke-Device @('exec-out','screencap','-p')
    if($png.Length -lt 24 -or [Convert]::ToHexString($png[0..7]) -ne '89504E470D0A1A0A' -or [Convert]::ToHexString($png[16..23]) -ne '000002D000000500') { throw 'invalid_screenshot' }
    [IO.File]::WriteAllBytes((Join-Path $Directory "$Stem.xml"),$Frame.bytes)
    [IO.File]::WriteAllBytes((Join-Path $Directory "$Stem.png"),$png)
    Save-Json (Join-Path $Directory "$Stem.nodes.json") $Frame.nodes
    return @{ capturedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); xmlSha256=(Hash-Bytes $Frame.bytes); pngSha256=(Hash-Bytes $png); nodesSha256=(Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $Directory "$Stem.nodes.json")))) }
}
function Save-CardImage($Header, $Context, [string]$Directory) {
    $pictures=@($Header.nodes | Where-Object { $_.class -eq 'android.widget.ImageView' -and $_.bounds -eq '[32,156][288,512]' })
    if($pictures.Count -ne 1) { throw 'header_card_image_missing' }
    Tap-Node $pictures[0]
    for($attempt=1;$attempt -le 8;$attempt++) {
        try {
            $gallery=Read-Frame
            if(@($gallery.nodes | Where-Object { $_.password -eq 'true' -or $_.class -eq 'android.widget.EditText' -or $_.package -ne 'com.jihuanshe.pro' }).Count) { throw 'unexpected_gallery_input' }
            $texts=@($gallery.nodes | ForEach-Object { $_.text })
            if(@($Context.cardName,$Context.cardNumber,$Context.packName,$Context.languageLabel | Where-Object { $_ -notin $texts }).Count) { throw 'gallery_identity_mismatch' }
            $close=Find-One $gallery 'content-desc' '关闭'
            break
        } catch { if($attempt -eq 8 -or $_.Exception.Message -match '^unexpected_gallery_input$|^invalid_ui_xml$|^device_command_') { throw }; Start-Sleep -Milliseconds 800 }
    }
    $galleryEvidence=Save-PublicFrame $gallery $Directory 'gallery'
    $start=[Diagnostics.ProcessStartInfo]::new('D:\CodexData\runtimes\codex-primary-runtime\dependencies\python\python.exe')
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    foreach($argument in @((Join-Path $PSScriptRoot 'crop-app-card.py'),'--image',(Join-Path $Directory 'gallery.png'),'--ui',(Join-Path $Directory 'gallery.xml'),'--context',(Join-Path $Directory 'context.json'),'--out-dir',(Join-Path $Directory 'image'))) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        if(-not $process.Start()) { throw 'image_crop_start_failed' }
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(15000)) { $process.Kill($true); throw 'image_crop_timeout' }
        if(-not $stdout.Wait(1000) -or -not $stderr.Wait(1000) -or $process.ExitCode -ne 0) { throw 'image_crop_validation_failed' }
    } finally { $process.Dispose() }
    Tap-Node $close
    return $galleryEvidence
}
function Return-ToPack($ExpectedCard) {
    for($back=1;$back -le 3;$back++) {
        $null=Invoke-Device @('shell','input','keyevent','KEYCODE_BACK')
        $sameDetail=$false
        $detailConfirmations=0
        for($attempt=1;$attempt -le 8;$attempt++) {
            $frame=Read-Frame
            try { return @{frame=$frame; parsed=(Parse-Frame $frame 'pack' $null $false)} }
            catch { $packError=$_.Exception.Message }
            try {
                $null=Parse-Frame $frame 'detail' $ExpectedCard
                $detailConfirmations++
                if($detailConfirmations -ge 2) { $sameDetail=$true; break }
            }
            catch {
                $detailConfirmations=0
                $detailError=$_.Exception.Message
                if($detailError -match 'private|login|foreign') { throw }
            }
            if($attempt -eq 8) {
                $diagnostic=@{at=[DateTime]::UtcNow.ToString('o');
                    cardNumber=$ExpectedCard.cardNumber; back=$back; attempts=$attempt;
                    packError=$(if($packError -match '^[a-z_]+$'){$packError}else{'parse_failed'});
                    detailError=$(if($detailError -match '^[a-z_]+$'){$detailError}else{'parse_failed'})}
                $publicOnly=@($frame.nodes | Where-Object { $_.package -ne 'com.jihuanshe.pro' -or
                    $_.class -eq 'android.widget.EditText' -or $_.password -eq 'true' -or
                    ([string]$_.text+' '+[string]$_.'content-desc') -match '登录|注册|验证码|手机号|手机号码|密码' }).Count -eq 0
                $visibleLabels=@($frame.nodes | Where-Object {
                    if($_.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { return $false }
                    [int]$Matches[1] -ge 0 -and [int]$Matches[2] -ge 48 -and [int]$Matches[3] -le 720 -and
                        [int]$Matches[4] -le 1232 -and [int]$Matches[3] -gt [int]$Matches[1] -and [int]$Matches[4] -gt [int]$Matches[2]
                } | ForEach-Object { $_.text; $_.'content-desc' })
                if($publicOnly -and $listing.context.packName -in $visibleLabels -and 'RAW' -in $visibleLabels) {
                    $stem='return-failure-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
                    try { $diagnostic.publicFrame=@{stem=$stem;evidence=(Save-PublicFrame $frame $runPath $stem)} }
                    catch { $diagnostic.publicFrameError='diagnostic_capture_failed' }
                }
                Save-Json (Join-Path $runPath 'return-diagnostics.json') $diagnostic
                throw 'pack_return_failed'
            }
            Start-Sleep -Milliseconds 800
        }
        if(-not $sameDetail) { throw 'pack_return_failed' }
    }
    throw 'pack_return_failed'
}

try {
    $config=Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    if([IO.Path]::GetFullPath($config.android.adbPath) -ne $script:adbPath -or $config.android.serial -ne 'emulator-5580' -or $config.android.serverPort -ne 15037) { throw 'device_config_mismatch' }
    $listing=Get-Content -LiteralPath $ListingPath -Raw | ConvertFrom-Json
    if($listing.kind -ne 'public_listing_observations' -or -not $listing.observations.Count) { throw 'invalid_reference_listing' }
    $candidate=[IO.Path]::GetFullPath($OutputDir)
    if(-not $candidate.StartsWith('D:\CODEX\',[StringComparison]::OrdinalIgnoreCase)) { throw 'output_outside_workspace' }
    $ancestor=[IO.DirectoryInfo]::new($candidate)
    while($null -ne $ancestor) {
        if($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'output_reparse_point' }
        $ancestor=$ancestor.Parent
    }
    [IO.Directory]::CreateDirectory($candidate) | Out-Null; $runPath=$candidate
    $lockPath=Join-Path $PSScriptRoot 'output\run.lock'
    $lockStream=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $lockBytes=[Text.Encoding]::UTF8.GetBytes((@{pid=$PID;startedAt=[DateTime]::UtcNow.ToString('o');outputDir=$runPath} | ConvertTo-Json -Compress))
    $lockStream.Write($lockBytes,0,$lockBytes.Length); $lockStream.Flush()
    $reportPath=Join-Path $runPath 'progress.json'
    $referenceHash=Hash-Bytes ([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ListingPath).Path))
    $report=@{ kind='pack_identity_capture'; status='in_progress'; context=$listing.context; referenceSha256=$referenceHash; cards=@(); pagesVisited=0; endObserved=$false }
    if(Test-Path -LiteralPath $reportPath) {
        $previous=Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        if($previous.referenceSha256 -ne $referenceHash) { throw 'reference_listing_changed' }
        $report.cards=@($previous.cards)
    }
    Set-Stage 'verify_resume_evidence'
    $verifiedCards=@()
    foreach($folder in @(Get-ChildItem -LiteralPath $runPath -Directory | Where-Object { $_.Name -match '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' })) {
        $saved=Verify-ExistingCard $folder.FullName
        if(@($verifiedCards | Where-Object { $_.cardNumber -eq $saved.context.cardNumber }).Count) { throw 'duplicate_saved_card_number' }
        $verifiedCards+=@($saved.context)
    }
    foreach($card in @($report.cards)) {
        if(@($verifiedCards | Where-Object { $_.cardNumber -eq $card.cardNumber -and $_.shareUrl -eq $card.shareUrl }).Count -ne 1) { throw 'progress_evidence_missing' }
    }
    $report.cards=$verifiedCards
    Save-Json $reportPath $report
    Save-Json (Join-Path $runPath 'contexts.json') @($report.cards)
    Set-Stage 'verify_open_pack'
    $view=Wait-Parsed 'pack' $null $true
    $newCount=0; $lastLabels=$null; $unchanged=0
    for($page=1;$page -le $MaxPages;$page++) {
        if($report.cards.Count -ge $listing.observations.Count) { break }
        $report.pagesVisited=$page
        Save-Json (Join-Path $runPath 'last-pack-targets.json') @{page=$page;targets=@($view.parsed.targets);capturedAt=[DateTime]::UtcNow.ToString('o')}
        foreach($target in @($view.parsed.targets)) {
            if(@($report.cards | Where-Object { $_.cardNumber -eq $target.cardNumber }).Count) { continue }
            Set-Stage 'open_card'
            $currentTarget=@($view.parsed.targets | Where-Object { $_.cardNumber -eq $target.cardNumber })
            if($currentTarget.Count -ne 1) { continue }
            $null=Invoke-Device @('shell','input','tap',[string]$currentTarget[0].tap.x,[string]$currentTarget[0].tap.y)
            $detail=Wait-Parsed 'detail' $target
            Set-Stage 'copy_public_card_link'
            $url=Copy-PublicCardLink $detail.frame
            if(@($report.cards | Where-Object { $_.shareUrl -eq $url }).Count) { throw 'shared_link_identity_collision' }
            $uuid=$url.Substring($url.LastIndexOf('/')+1)
            Set-Stage 'verify_copied_link'
            $null=Invoke-Device @('shell','am','start','-W','-a','android.intent.action.VIEW','-d',"jihuanshepro://pro/cards/$uuid",'-p','com.jihuanshe.pro')
            $verified=Wait-Parsed 'detail' $target
            $cardContext=$verified.parsed.context
            $cardContext | Add-Member -NotePropertyName shareUrl -NotePropertyValue $url -Force
            $cardContext | Add-Member -NotePropertyName rarity -NotePropertyValue $target.rarity -Force
            $finalCardDir=Join-Path $runPath $uuid
            if(Test-Path -LiteralPath $finalCardDir) { throw 'unexpected_existing_card_directory' }
            $cardDir=Join-Path $runPath ('.pending\'+$uuid+'-'+[Guid]::NewGuid().ToString('N'))
            $pendingCardDir=$cardDir
            [IO.Directory]::CreateDirectory($cardDir) | Out-Null
            Save-Json (Join-Path $cardDir 'context.json') $cardContext
            $evidence=Save-PublicFrame $verified.frame $cardDir 'header'
            Set-Stage 'capture_card_image'
            $galleryEvidence=Save-CardImage $verified.frame $cardContext $cardDir
            $null=Wait-Parsed 'detail' $target
            Save-Json (Join-Path $cardDir 'evidence.json') @{ source='jihuanshe'; method='official_app_copy_link_then_header_check'; shareUrl=$url; header=$evidence; gallery=$galleryEvidence }
            foreach($path in @($cardDir,$finalCardDir)) {
                if(-not [IO.Path]::GetFullPath($path).StartsWith(($runPath.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'card_path_outside_pack' }
            }
            [IO.Directory]::Move($cardDir,$finalCardDir); $pendingCardDir=$null
            $imageMetaPath=Join-Path $finalCardDir 'image\image.json'
            $imageMeta=Get-Content -LiteralPath $imageMetaPath -Raw | ConvertFrom-Json
            $imageMeta.path=Join-Path $finalCardDir 'image\card.png'
            $imageMeta.source.pngPath=Join-Path $finalCardDir 'gallery.png'
            $imageMeta.source.uiPath=Join-Path $finalCardDir 'gallery.xml'
            $imageMeta.source.contextPath=Join-Path $finalCardDir 'context.json'
            Save-Json $imageMetaPath $imageMeta
            $report.cards+=@($cardContext); $newCount++
            Save-Json $reportPath $report
            Save-Json (Join-Path $runPath 'contexts.json') @($report.cards)
            Set-Stage 'return_to_pack'
            $view=Return-ToPack $target
            if($newCount -ge $MaxCards -or $report.cards.Count -ge $listing.observations.Count) { break }
        }
        if($newCount -ge $MaxCards -or $report.cards.Count -ge $listing.observations.Count) { break }
        $labels=($view.frame.nodes | Where-Object { $_.'content-desc' -match ', RAW,' } | ForEach-Object { $_.'content-desc' + '|' + $_.bounds }) -join "`n"
        if($labels -eq $lastLabels) { $unchanged++ } else { $unchanged=0 }
        if($unchanged -ge 2) { $report.endObserved=$true; break }
        $lastLabels=$labels
        Set-Stage 'scroll_pack'
        $endY=[int][Math]::Max(830,$view.parsed.controlsBottom+48)
        if($endY -ge 1100) { throw 'pack_scroll_area_missing' }
        $null=Invoke-Device @('shell','input','swipe','600','1130','600',[string]$endY,'450')
        $view=Wait-Parsed 'pack' $null $false
    }
    $report.status='batch_completed'; $report.completedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); $report.newCards=$newCount
    Save-Json $reportPath $report
    Save-Json (Join-Path $runPath 'current-run.json') @{status=$report.status;capturedTotal=$report.cards.Count;completedAt=$report.completedAt;pid=$PID}
    @{status=$report.status; capturedTotal=$report.cards.Count; newCards=$newCount; outputDir=$runPath; endObserved=$report.endObserved} | ConvertTo-Json
} catch {
    $reason=$(if($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'capture_operation_failed' })
    $failure=@{status='capture_stopped';stage=$stage;reason=$reason;errorType=$_.Exception.GetType().Name;errorLine=$_.InvocationInfo.ScriptLineNumber;at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
    if($runPath -and $lockStream) { Save-Json (Join-Path $runPath 'last-failure.json') $failure; Save-Json (Join-Path $runPath 'current-run.json') $failure }
    $failure | ConvertTo-Json; exit 1
} finally {
    try { $null=Invoke-Device @('shell','rm','-f','--',$remoteXml) } catch {}
    if($lockStream) { $lockStream.Dispose(); Remove-Item -LiteralPath $lockPath }
}
