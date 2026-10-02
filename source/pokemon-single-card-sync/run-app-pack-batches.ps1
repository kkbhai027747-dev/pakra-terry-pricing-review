#Requires -Version 7.0
param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'pilot-pack-manifest.json'),
    [Parameter(Mandatory)][string]$ReportDir
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$project = 'D:\CODEX\pokemon-single-card-sync'
$runtime = 'D:\CODEX\output\pokemon-android-runtime\app-validation-20260926'
$reportPath = $null
$lockStream = $null
$lockPath = $null
$exitCode = 1
$report = [ordered]@{
    kind = 'app_pack_batch_run'; status = 'in_progress'; stage = 'configuration'
    startedAt = [DateTime]::UtcNow.ToString('o'); pid = $PID
    currentPack = $null; currentAttempt = $null; attempts = @(); completed = @(); failed = @(); reason = $null
}
$allowed = @(
    @{ setId = '100143'; language = 'zh-Hans'; setCode = '30thC'; count = 176; folder = 'sc-cards-full-02' },
    @{ setId = '100145'; language = 'ja'; setCode = 'M6a'; count = 177; folder = 'jp-cards-full-02' },
    @{ setId = '100236'; language = 'en'; setCode = '30C'; count = 191; folder = 'en-cards-full-02' }
)

function Assert-WorkspacePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) { throw 'invalid_workspace_path' }
    $full = [IO.Path]::GetFullPath($Value)
    if (-not $full.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase) -or $full.Substring(3).Contains(':')) {
        throw 'path_outside_workspace'
    }
    $cursor = $full
    while ($cursor) {
        $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'path_reparse_point' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Assert-OutputTree([string]$Directory) {
    $null = Assert-WorkspacePath $Directory
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'output_not_directory' }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Directory)
    while ($pending.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'output_reparse_point' }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
}

function Save-Report([string]$Stage) {
    $report.stage = $Stage
    $report.updatedAt = [DateTime]::UtcNow.ToString('o')
    if ($reportPath) {
        $null = Assert-WorkspacePath $reportPath
        $temporary = "$reportPath.$PID.tmp"
        $null = Assert-WorkspacePath $temporary
        [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $reportPath, $true)
    }
}

function Invoke-Hidden([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $project
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($name in @('ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS')) { $null = $start.Environment.Remove($name) }
    $start.Environment['ANDROID_ADB_SERVER_PORT'] = '15037'
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw 'child_start_failed' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $report.childPid = $process.Id
        Save-Report $report.stage
        $lastUpdate = 0
        while (-not $process.WaitForExit(1000)) {
            if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'child_timeout' }
            if ($watch.Elapsed.TotalSeconds - $lastUpdate -ge 15) {
                $report.childElapsedSeconds = [int]$watch.Elapsed.TotalSeconds
                Save-Report $report.stage
                $lastUpdate = $watch.Elapsed.TotalSeconds
            }
        }
        if (-not $stdout.Wait(2000) -or -not $stderr.Wait(2000)) { throw 'child_output_failed' }
        return @{ exitCode = $process.ExitCode; stdout = $stdout.Result; stderrLength = $stderr.Result.Length
            stderrMarkers = @([regex]::Matches($stderr.Result, 'Remove-Item|IOException|UnauthorizedAccess|PermissionDenied|sharing violation|NativeCommandError') |
                ForEach-Object { $_.Value } | Select-Object -Unique) }
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            $null = $process.WaitForExit(5000)
        }
        $process.Dispose()
        $report.childPid = $null
        $report.childElapsedSeconds = $null
    }
}

function Parse-Summary($Result) {
    try { return ($Result.stdout | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'child_summary_invalid' }
}

function Get-PackVerificationDecision($Verification, $Pack, [int]$ChildExitCode, [int]$Attempt) {
    if ($ChildExitCode -ne 0 -or $Verification.kind -ne 'app_pack_verification') {
        return @{ action = 'stop'; reason = 'pack_verification_failed' }
    }
    if ($Verification.context.setId -ne $Pack.setId -or $Verification.context.language -ne $Pack.language -or
        $Verification.context.setCode -ne $Pack.setCode -or $Verification.context.packName -ne '30周年庆典' -or
        $Verification.referenceSha256 -ne $Pack.referenceSha256) {
        return @{ action = 'stop'; reason = 'verification_identity_mismatch' }
    }
    foreach ($field in @('expectedCards', 'recordedCards', 'verifiedCards', 'imagesVerified')) {
        if (($Verification.$field -isnot [int] -and $Verification.$field -isnot [long]) -or $Verification.$field -lt 0) {
            return @{ action = 'stop'; reason = 'pack_evidence_inconsistent' }
        }
    }
    if ($Verification.missing -isnot [array] -or $Verification.invalidCards -isnot [array] -or
        $Verification.completePackEvidenceVerified -isnot [bool] -or
        $Verification.expectedCards -ne $Pack.expectedCards -or $Verification.recordedCards -ne $Verification.verifiedCards -or
        $Verification.imagesVerified -ne $Verification.verifiedCards -or $Verification.invalidCards.Count -ne 0 -or
        ($Verification.verifiedCards + $Verification.missing.Count) -ne $Pack.expectedCards) {
        return @{ action = 'stop'; reason = 'pack_evidence_inconsistent' }
    }
    if ($Verification.missing.Count -eq 0 -and $Verification.completePackEvidenceVerified -ceq $true) {
        return @{ action = 'import'; reason = $null }
    }
    if ($Verification.missing.Count -gt 0 -and $Verification.completePackEvidenceVerified -ceq $false) {
        if ($Attempt -ge 1 -and $Attempt -lt 3) { return @{ action = 'retry'; reason = 'verified_cards_missing' } }
        return @{ action = 'stop'; reason = 'pack_evidence_incomplete' }
    }
    return @{ action = 'stop'; reason = 'pack_evidence_inconsistent' }
}

try {
    if ((Assert-WorkspacePath $PSScriptRoot) -ne $project) { throw 'project_path_mismatch' }
    $manifestFile = Assert-WorkspacePath $ManifestPath
    $reportDirectory = Assert-WorkspacePath $ReportDir
    if (-not $reportDirectory.StartsWith(($project + '\output\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'report_outside_project_output' }
    Assert-OutputTree $reportDirectory
    [IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
    $candidateReport = Assert-WorkspacePath (Join-Path $reportDirectory 'run.json')
    if (Test-Path -LiteralPath $candidateReport) { throw 'report_already_exists' }
    $reportPath = $candidateReport
    Save-Report 'validate_manifest'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -NoEnumerate
    if ($manifest -isnot [array] -or $manifest.Count -lt 1 -or $manifest.Count -gt 3) { throw 'invalid_pack_manifest' }
    $packs = @(); $seen = @{}
    foreach ($entry in $manifest) {
        if (@($entry.PSObject.Properties.Name).Count -ne 2 -or -not $entry.listingPath -or -not $entry.outputDir) { throw 'invalid_manifest_entry' }
        $listingPath = Assert-WorkspacePath $entry.listingPath
        $outputDir = Assert-WorkspacePath $entry.outputDir
        $matches = @($allowed | Where-Object {
            $listingPath -eq (Join-Path $runtime ($_.folder + '\observations.json')) -and
            $outputDir -eq (Join-Path $project ('output\app-packs\' + $_.setId))
        })
        if ($matches.Count -ne 1 -or $seen.ContainsKey($matches[0].setId)) { throw 'pack_not_in_pilot_manifest' }
        $pack = $matches[0]
        $seen[$pack.setId] = $true
        $listing = Get-Content -LiteralPath $listingPath -Raw | ConvertFrom-Json
        if ($listing.kind -ne 'public_listing_observations' -or $listing.observations.Count -ne $pack.count -or
            $listing.displayedCardCount -ne $pack.count -or $listing.distinctCardNumbers -ne $pack.count -or
            $listing.missingCount -ne 0 -or $listing.endObserved -ne $true -or
            $listing.context.setId -ne $pack.setId -or $listing.context.language -ne $pack.language -or
            $listing.context.setCode -ne $pack.setCode -or $listing.context.packName -ne '30周年庆典') { throw 'reference_listing_mismatch' }
        Assert-OutputTree $outputDir
        $packs += @{ setId = $pack.setId; language = $pack.language; setCode = $pack.setCode; expectedCards = $pack.count
            listingPath = $listingPath; outputDir = $outputDir
            referenceSha256 = (Get-FileHash -LiteralPath $listingPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    foreach ($name in @('open-app-pack.ps1', 'capture-app-pack.ps1', 'verify-app-pack.mjs', 'sync.mjs')) {
        if (-not (Test-Path -LiteralPath (Assert-WorkspacePath (Join-Path $project $name)) -PathType Leaf)) { throw 'required_script_missing' }
    }
    $lockPath = Assert-WorkspacePath (Join-Path $project 'output\app-pack-batches.lock')
    try { $lockStream = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'pack_runner_lock_exists_or_unavailable' }
    $lockBytes = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; startedAt = $report.startedAt; reportPath = $reportPath } | ConvertTo-Json -Compress))
    $lockStream.Write($lockBytes, 0, $lockBytes.Length); $lockStream.Flush()
    $report.manifestPath = $manifestFile
    $report.plannedPacks = $packs.Count
    foreach ($pack in $packs) {
        $report.currentPack = $pack
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $report.currentAttempt = $attempt
            $report.verification = $null
            $report.openDiagnostics = $null
            $attemptReport = [ordered]@{ setId = $pack.setId; attempt = $attempt; startedAt = [DateTime]::UtcNow.ToString('o') }
            $report.attempts += $attemptReport
            Save-Report 'open_pack'
            $openOutput = Assert-WorkspacePath (Join-Path $reportDirectory ('open-' + $pack.setId + '-attempt-' + $attempt))
            $attemptReport.openOutputDir = $openOutput
            if (Test-Path -LiteralPath $openOutput) { throw 'open_evidence_directory_exists' }
            $opened = Invoke-Hidden $pwsh @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
                (Join-Path $project 'open-app-pack.ps1'), '-ListingPath', $pack.listingPath, '-OutputDir', $openOutput) 600
            $openSummary = Parse-Summary $opened
            $report.openDiagnostics = [ordered]@{
                childExitCode = $opened.exitCode; summaryStatus = $openSummary.status
                headerVerified = $openSummary.headerVerified; expectedCards = $openSummary.expectedCards
                contextSetId = $openSummary.context.setId; language = $openSummary.context.language; setCode = $openSummary.context.setCode
                packNameMatches = $openSummary.context.packName -eq '30周年庆典'; outputDirMatches = $openSummary.outputDir -eq $openOutput
                stderrLength = $opened.stderrLength; stderrMarkers = $opened.stderrMarkers
                replacementCharacters = ([regex]::Matches($opened.stdout, [string][char]0xFFFD)).Count
            }
            $attemptReport.openDiagnostics = $report.openDiagnostics
            Save-Report 'open_pack'
            if ($opened.exitCode -ne 0 -or $openSummary.status -ne 'pack_opened' -or $openSummary.headerVerified -ne $true -or
                $openSummary.expectedCards -ne $pack.expectedCards -or $openSummary.context.setId -ne $pack.setId -or
                $openSummary.context.language -ne $pack.language -or $openSummary.context.setCode -ne $pack.setCode -or
                $openSummary.context.packName -ne '30周年庆典' -or $openSummary.outputDir -ne $openOutput) { throw 'open_pack_failed' }
            Save-Report 'capture_pack'
            $captured = Invoke-Hidden $pwsh @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
                (Join-Path $project 'capture-app-pack.ps1'), '-ListingPath', $pack.listingPath, '-OutputDir', $pack.outputDir,
                '-MaxCards', '600', '-MaxPages', '200') (12 * 3600)
            $captureSummary = Parse-Summary $captured
            $attemptReport.capture = [ordered]@{ childExitCode = $captured.exitCode; status = $captureSummary.status
                capturedTotal = $captureSummary.capturedTotal; newCards = $captureSummary.newCards; endObserved = $captureSummary.endObserved }
            if ($captured.exitCode -ne 0 -or $captureSummary.status -ne 'batch_completed' -or
                $captureSummary.outputDir -ne $pack.outputDir) { throw 'capture_pack_failed' }
            Save-Report 'verify_pack'
            Assert-OutputTree $pack.outputDir
            $verified = Invoke-Hidden $node @((Join-Path $project 'verify-app-pack.mjs'), '--directory', $pack.outputDir,
                '--listing', $pack.listingPath) 600
            $verification = Parse-Summary $verified
            $report.verification = [ordered]@{
                expectedCards = $verification.expectedCards; recordedCards = $verification.recordedCards
                verifiedCards = $verification.verifiedCards; imagesVerified = $verification.imagesVerified
                completePackEvidenceVerified = $verification.completePackEvidenceVerified
                missingCount = @($verification.missing).Count; invalidCount = @($verification.invalidCards).Count
                missingCardNumbers = @($verification.missing | ForEach-Object { $_.cardNumber })
            }
            $attemptReport.verification = $report.verification
            $decision = Get-PackVerificationDecision $verification $pack $verified.exitCode $attempt
            $attemptReport.action = $decision.action
            $attemptReport.reason = $decision.reason
            $attemptReport.completedAt = [DateTime]::UtcNow.ToString('o')
            Save-Report 'verify_pack'
            if ($decision.action -eq 'stop') { throw $decision.reason }
            if ($decision.action -eq 'import') { break }
            Save-Report 'retry_missing_cards'
        }
        Save-Report 'import_pack'
        $importPath = Assert-WorkspacePath (Join-Path $reportDirectory ('import-' + $pack.setId + '.json'))
        $importBytes = [Text.Encoding]::UTF8.GetBytes((@{ kind = 'verified_app_pack'; directory = $pack.outputDir
            listingPath = $pack.listingPath } | ConvertTo-Json))
        $importFile = [IO.FileStream]::new($importPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $importFile.Write($importBytes, 0, $importBytes.Length) } finally { $importFile.Dispose() }
        $imported = Invoke-Hidden $node @((Join-Path $project 'sync.mjs'), 'import-batch', '--input', $importPath) 600
        $importSummary = Parse-Summary $imported
        if ($imported.exitCode -ne 0 -or $importSummary.sourceKind -ne 'official_app_ui' -or
            $importSummary.completePackEvidenceVerified -ne $true -or $importSummary.imported -ne $pack.expectedCards -or
            $importSummary.expectedCards -ne $pack.expectedCards -or $importSummary.verifiedCards -ne $pack.expectedCards -or
            $importSummary.imagesVerified -ne $pack.expectedCards -or $importSummary.missingCards -ne 0) { throw 'pack_import_failed' }
        $report.completed += @{ setId = $pack.setId; language = $pack.language; outputDir = $pack.outputDir
            verifiedCards = $verification.verifiedCards; imagesVerified = $verification.imagesVerified
            importManifestPath = $importPath; importedCards = $importSummary.imported; catalogCards = $importSummary.catalogCards
            completePackEvidenceVerified = $true; originalImagesCaptured = $false; lowestAskingVerified = $false
            completedAt = [DateTime]::UtcNow.ToString('o') }
        $report.currentPack = $null
        $report.currentAttempt = $null
        $report.verification = $null
        Save-Report 'pack_completed'
    }
    $report.status = 'pack_batches_completed'
    Save-Report 'completed'
    $exitCode = 0
} catch {
    $report.status = 'stopped'
    $report.reason = $(if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'pack_batch_operation_failed' })
    $report.failed += @{ setId = $report.currentPack.setId; attempt = $report.currentAttempt; stage = $report.stage; reason = $report.reason }
} finally {
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    try { Save-Report $report.stage }
    finally {
        if ($null -ne $lockStream) {
            $lockStream.Dispose()
            Remove-Item -LiteralPath $lockPath -ErrorAction Stop
        }
    }
}
@{ status = $report.status; reportPath = $reportPath; completedPacks = @($report.completed).Count
    failedPacks = @($report.failed).Count; currentPack = $report.currentPack.setId; reason = $report.reason } | ConvertTo-Json
exit $exitCode
