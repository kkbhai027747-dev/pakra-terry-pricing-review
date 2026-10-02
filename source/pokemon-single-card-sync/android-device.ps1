function Invoke-Device([string[]]$DeviceArguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($script:adbPath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-H', '127.0.0.1', '-P', '15037', '-s', 'emulator-5580') + $DeviceArguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $bytes = [IO.MemoryStream]::new()
    try {
        if (-not $process.Start()) { throw 'device_command_start_failed' }
        $copy = $process.StandardOutput.BaseStream.CopyToAsync($bytes)
        $discardedError = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'device_command_timeout' }
        if (-not $copy.Wait(1000) -or -not $discardedError.Wait(1000) -or $process.ExitCode -ne 0) { throw 'device_command_failed' }
        return ,$bytes.ToArray()
    } finally { $bytes.Dispose(); $process.Dispose() }
}
