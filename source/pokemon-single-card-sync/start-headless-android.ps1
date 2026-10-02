param(
    [Parameter(Mandatory = $true)][string]$EmulatorPath,
    [Parameter(Mandatory = $true)][string]$AndroidSdkRoot,
    [Parameter(Mandatory = $true)][string]$AvdHome,
    [string]$AvdName,
    [ValidateRange(5554, 5682)][int]$Port = 5580,
    [ValidateRange(512, 16384)][int]$MemoryMb = 2048,
    [ValidateRange(1536, 8192)][int]$SystemReserveMb = 2048,
    [string]$ReportPath,
    [switch]$Quiet,
    [switch]$LoginWindow,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$report = [ordered]@{
    mode = $(if ($CheckOnly) { 'check_only' } else { 'start' })
    displayMode = $(if ($LoginWindow) { 'login_window' } else { 'headless' })
    status = 'blocked'
    blockers = @()
    acceleration = $null
    memory = $null
    adbServer = @{ host = '127.0.0.1'; port = 15037; status = 'unchecked' }
}
$savedEnvironment = @{}
$exitCode = 2
$reportFile = $null

function Get-WorkspacePath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime paths must stay inside D:\CODEX.'
    }
    $ancestor = $fullPath
    while ($ancestor.StartsWith('D:\CODEX\', [StringComparison]::OrdinalIgnoreCase)) {
        $entry = Get-Item -LiteralPath $ancestor -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Runtime paths must not pass through directory links or junctions.'
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $fullPath.TrimEnd('\')
}

try {
    $sdkPath = Get-WorkspacePath $AndroidSdkRoot
    $emulatorExe = Get-WorkspacePath $EmulatorPath
    $avdRoot = Get-WorkspacePath $AvdHome
    if (-not $emulatorExe.StartsWith("$sdkPath\", [StringComparison]::OrdinalIgnoreCase) `
        -or -not (Test-Path -LiteralPath $emulatorExe -PathType Leaf)) {
        throw 'The configured emulator executable must exist inside the provided SDK directory.'
    }
    $logsPath = Join-Path $avdRoot 'logs'
    $temporaryPath = Join-Path $avdRoot 'tmp'
    $userPath = Join-Path $avdRoot 'user'
    $emulatorHome = Join-Path $avdRoot 'emulator'
    foreach ($directory in @($logsPath, $temporaryPath, $userPath, $emulatorHome)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    if ($ReportPath) {
        $requestedReport = Get-WorkspacePath $ReportPath
        if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($requestedReport)) -PathType Container)) {
            throw 'The launch report parent directory must already exist.'
        }
        $reportFile = $requestedReport
    }
    $environment = @{
        ANDROID_HOME = $sdkPath; ANDROID_SDK_ROOT = $sdkPath; ANDROID_AVD_HOME = $avdRoot
        ANDROID_USER_HOME = $userPath; ANDROID_EMULATOR_HOME = $emulatorHome
        ANDROID_SDK_HOME = $userPath; TEMP = $temporaryPath; TMP = $temporaryPath; TMPDIR = $temporaryPath
        ANDROID_ADB_SERVER_PORT = '15037'; ADB_SERVER_SOCKET = $null; ANDROID_ADB_SERVER_ADDRESS = $null
    }
    foreach ($name in $environment.Keys) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    $runId = '{0}-{1}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), [Guid]::NewGuid().ToString('N')
    if (-not $reportFile) { $reportFile = Join-Path $logsPath "$runId.launch.json" }
    $accelOutput = Join-Path $logsPath "$runId.accel.stdout.log"
    $accelError = Join-Path $logsPath "$runId.accel.stderr.log"
    $check = Start-Process -FilePath $emulatorExe -ArgumentList '-accel-check' -WindowStyle Hidden `
        -WorkingDirectory $sdkPath -RedirectStandardOutput $accelOutput -RedirectStandardError $accelError -Wait -PassThru
    $accelText = Get-Content -LiteralPath $accelOutput -Raw
    $accelStatus = [regex]::Match($accelText, '(?m)^\s*accel:\s*\r?\n\s*(\d+)\s*$')
    $accelReady = $null -ne $check.ExitCode -and $check.ExitCode -eq 0 `
        -and (-not $accelStatus.Success -or $accelStatus.Groups[1].Value -eq '0')
    $report.acceleration = @{ available = $accelReady; exitCode = $check.ExitCode; stdout = $accelOutput; stderr = $accelError }
    if (-not $accelReady) { $report.blockers += 'Hardware acceleration is unavailable. No drivers or Windows features were changed.' }
    $freeMb = [Math]::Floor([double](Get-CimInstance -ClassName Win32_OperatingSystem).FreePhysicalMemory / 1024)
    $requiredMb = $MemoryMb + $SystemReserveMb
    $report.memory = @{ availableMb = $freeMb; emulatorMb = $MemoryMb; reserveMb = $SystemReserveMb; requiredMb = $requiredMb }
    if ($freeMb -lt $requiredMb) { $report.blockers += "Insufficient free physical memory; the emulator allocation requires an additional $SystemReserveMb MB reserve. No other process was stopped." }
    $adbListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $report.adbServer.port })
    $expectedAdb = Get-WorkspacePath (Join-Path $sdkPath 'platform-tools\adb.exe')
    foreach ($listener in $adbListeners) {
        $owner = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $listener.OwningProcess) -ErrorAction Stop
        if ($listener.LocalAddress -notin @('127.0.0.1', '::1') -or -not $owner.ExecutablePath `
            -or -not [string]::Equals($owner.ExecutablePath, $expectedAdb, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The private ADB server port belongs to an unverified process or non-loopback listener; no service was contacted or stopped.'
        }
    }
    $report.adbServer.status = $(if ($adbListeners.Count) { 'verified_sdk_adb' } else { 'available' })

    if (-not $CheckOnly -and $report.blockers.Count -eq 0) {
        if ($AvdName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'Provide one exact valid AvdName; device names are never guessed.' }
        if ($Port % 2 -ne 0) { throw 'The emulator console port must be even.' }
        $avdDirectory = Join-Path $avdRoot "$AvdName.avd"
        $avdIni = Join-Path $avdRoot "$AvdName.ini"
        if (-not (Test-Path -LiteralPath $avdIni -PathType Leaf) `
            -or -not (Test-Path -LiteralPath (Join-Path $avdDirectory 'config.ini') -PathType Leaf)) {
            throw 'The exact named AVD and its config.ini must already exist in AvdHome.'
        }
        $pathEntries = @(Get-Content -LiteralPath $avdIni | Where-Object { $_ -match '^path=' })
        if ($pathEntries.Count -ne 1 -or (Get-WorkspacePath $pathEntries[0].Substring(5)) -ne $avdDirectory) {
            throw 'The named AVD must point to its exact directory inside AvdHome.'
        }
        $occupied = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in @($Port, ($Port + 1)) })
        if ($occupied.Count -gt 0) { throw 'The selected emulator console or ADB port is already in use; no port was changed.' }
        $stdoutPath = Join-Path $logsPath "$runId.emulator.stdout.log"
        $stderrPath = Join-Path $logsPath "$runId.emulator.stderr.log"
        $launchOptions = @{
            executable = $emulatorExe; cwd = $avdRoot; stdout = $stdoutPath; stderr = $stderrPath
            windowsHide = -not $LoginWindow
            arguments = @('-avd', $AvdName, '-port', [string]$Port, '-memory', [string]$MemoryMb, '-cores', '2', '-accel', 'on',
                '-datadir', $avdDirectory, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-camera-back', 'none', '-camera-front', 'none')
        }
        if ($LoginWindow) { $launchOptions.arguments = @($launchOptions.arguments | Where-Object { $_ -ne '-no-window' }) }
        $launchText = $launchOptions | ConvertTo-Json -Depth 3 -Compress | & node.exe (Join-Path $PSScriptRoot 'launch-emulator.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'The detached emulator launcher failed; inspect its error output.' }
        $child = $launchText | ConvertFrom-Json
        if (-not $child.pid -or [int]$child.pid -le 0) { throw 'The detached emulator launcher did not return a process ID.' }
        $report.status = 'started'
        $report.pid = $child.pid
        $report.port = $Port
        $report.avd = $AvdName
        $report.stdout = $stdoutPath
        $report.stderr = $stderrPath
        $exitCode = 0
    } elseif ($CheckOnly -and $report.blockers.Count -eq 0) {
        $report.status = 'ready_for_avd_validation'
        $exitCode = 0
    }
} catch {
    $report.blockers += $_.Exception.Message
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
$report.exitCode = $exitCode
$reportJson = $report | ConvertTo-Json -Depth 5
if ($reportFile) { [IO.File]::WriteAllText($reportFile, $reportJson, [Text.UTF8Encoding]::new($false)) }
if (-not $Quiet) { $reportJson | Write-Output }
exit $exitCode
