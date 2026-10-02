param(
    [string]$AndroidSdkRoot = 'D:\CODEX\output\pokemon-android-runtime\sdk',
    [string]$AvdHome = 'D:\CODEX\output\pokemon-android-runtime\avd'
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = 'D:\CODEX\output\pokemon-android-runtime'
function Get-RuntimePath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $fullPath.StartsWith("$runtimeRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'All SDK and AVD paths must remain inside D:\CODEX\output\pokemon-android-runtime.'
    }
    $ancestor = $fullPath
    while ($ancestor -and $ancestor.StartsWith('D:\CODEX', [StringComparison]::OrdinalIgnoreCase)) {
        $entry = Get-Item -LiteralPath $ancestor -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Runtime paths must not pass through links or junctions.'
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $fullPath
}

try {
    $sdkPath = Get-RuntimePath $AndroidSdkRoot
    $avdRoot = Get-RuntimePath $AvdHome
    $imagePath = Get-RuntimePath (Join-Path $sdkPath 'system-images\android-35\google_apis\x86_64')
    $propertiesPath = Join-Path $imagePath 'source.properties'
    if (-not (Test-Path -LiteralPath $propertiesPath -PathType Leaf)) { throw 'The exact Android 35 Google APIs x86_64 source.properties is missing.' }
    $properties = @{}
    foreach ($line in Get-Content -LiteralPath $propertiesPath) {
        if ($line -match '^\s*([^#!\s=]+)\s*=\s*(.*?)\s*$') {
            if ($properties.ContainsKey($matches[1])) { throw 'System image metadata contains duplicate keys.' }
            $properties[$matches[1]] = $matches[2]
        }
    }
    if ($properties['AndroidVersion.ApiLevel'] -ne '35' -or $properties['SystemImage.TagId'] -ne 'google_apis' `
        -or $properties['SystemImage.Abi'] -ne 'x86_64') {
        throw 'System image metadata must exactly match API 35, google_apis, and x86_64.'
    }
    foreach ($name in @('kernel-ranchu', 'ramdisk.img', 'system.img', 'vendor.img', 'build.prop')) {
        $image = Get-Item -LiteralPath (Join-Path $imagePath $name) -ErrorAction SilentlyContinue
        if (-not $image -or $image.PSIsContainer -or $image.Length -le 0) { throw "Required system-image file is missing or empty: $name" }
    }
    $initialDataImage = Get-Item -LiteralPath (Join-Path $imagePath 'userdata.img') -ErrorAction SilentlyContinue
    $dataDirectory = Join-Path $imagePath 'data'
    $hasInitialImage = $initialDataImage -and -not $initialDataImage.PSIsContainer -and $initialDataImage.Length -gt 0
    $hasEmptyDataMarker = (Test-Path -LiteralPath $dataDirectory -PathType Container) -and `
        (Test-Path -LiteralPath (Join-Path $dataDirectory 'empty_data_disk') -PathType Leaf)
    if (-not $hasInitialImage -and -not $hasEmptyDataMarker) {
        throw 'System image requires a nonempty userdata.img or a data directory containing the empty_data_disk file.'
    }
    $avdName = 'PakraPokemon'
    $avdDirectory = Get-RuntimePath (Join-Path $avdRoot "$avdName.avd")
    $rootIni = Join-Path $avdRoot "$avdName.ini"
    $configIni = Join-Path $avdDirectory 'config.ini'
    $rootText = "avd.ini.encoding=UTF-8`npath=$avdDirectory`ntarget=android-35`n"
    $configText = @(
        'AvdId=PakraPokemon', 'avd.ini.displayname=PakraPokemon', 'avd.ini.encoding=UTF-8',
        'PlayStore.enabled=false', 'abi.type=x86_64', 'hw.cpu.arch=x86_64', 'hw.cpu.ncore=2', 'hw.ramSize=2048',
        'tag.id=google_apis', 'tag.display=Google APIs', "image.sysdir.1=$imagePath",
        "disk.dataPartition.path=$(Join-Path $avdDirectory 'userdata-qemu.img')", 'disk.dataPartition.size=6G',
        "disk.cachePartition.path=$(Join-Path $avdDirectory 'cache.img')",
        'hw.lcd.width=720', 'hw.lcd.height=1280', 'hw.lcd.density=320', 'skin.name=720x1280',
        'hw.gpu.enabled=yes', 'hw.gpu.mode=auto', 'hw.keyboard=yes', 'hw.mainKeys=no', 'hw.sdCard=no',
        'hw.camera.back=none', 'hw.camera.front=none', 'hw.audioInput=no', 'hw.audioOutput=no', 'fastboot.forceColdBoot=yes'
    ) -join "`n"
    $configText += "`n"
    $files = @(@{ path = $configIni; text = $configText }, @{ path = $rootIni; text = $rootText })
    foreach ($file in $files) {
        if (Test-Path -LiteralPath $file.path) {
            if (-not (Test-Path -LiteralPath $file.path -PathType Leaf) `
                -or [IO.File]::ReadAllText($file.path) -ne $file.text) {
                throw 'An existing PakraPokemon configuration conflicts with the requested settings; nothing was overwritten.'
            }
        }
    }
    New-Item -ItemType Directory -Path $avdDirectory -Force | Out-Null
    $created = 0
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath $file.path)) {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($file.text)
            $stream = [IO.File]::Open($file.path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            $created += 1
        }
    }
    [ordered]@{
        status = $(if ($created) { 'initialized' } else { 'already_initialized' })
        avd = $avdName; rootIni = $rootIni; configIni = $configIni; systemImage = $imagePath
        userData = (Join-Path $avdDirectory 'userdata-qemu.img'); temporaryDirectory = (Join-Path $avdRoot 'tmp')
        cores = 2; memoryMb = 2048; vmStarted = $false
        note = 'Only configuration files were created. The existing headless launcher sets D-drive temporary paths and verifies acceleration, memory, and ports before boot.'
    } | ConvertTo-Json | Write-Output
    exit 0
} catch {
    [ordered]@{ status = 'blocked'; exitCode = 2; vmStarted = $false; message = $_.Exception.Message } | ConvertTo-Json | Write-Output
    exit 2
}
