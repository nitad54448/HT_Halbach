param(
    [int]$Port = 8765,
    [string[]]$AllowOrigin = @(),
    [switch]$ServeUi,
    [switch]$OpenBrowser,
    [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$serviceArguments = @('--port', "$Port", '--data-dir', (Join-Path $PSScriptRoot 'data'))
foreach ($origin in $AllowOrigin) { $serviceArguments += @('--allow-origin', $origin) }
if ($ServeUi) { $serviceArguments += @('--ui-dir', (Join-Path $workspacePath 'app')) }
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCommand) {
    $localCargo = Join-Path $workspacePath '.tools/cargo'
    $cargoBinary = Join-Path $localCargo 'bin/cargo.exe'
    if (Test-Path -LiteralPath $cargoBinary) {
        $env:CARGO_HOME = $localCargo
        $env:RUSTUP_HOME = Join-Path $workspacePath '.tools/rustup'
        $nativeTools = Join-Path $env:RUSTUP_HOME 'toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin'
        $env:PATH = (Join-Path $localCargo 'bin') + ';' + $nativeTools + ';' + (Join-Path $nativeTools 'self-contained') + ';' + $env:PATH
        $env:RUSTFLAGS = '-C linker=rust-lld.exe -C linker-flavor=ld.lld -C link-self-contained=yes'
    }
} else {
    $cargoBinary = $cargoCommand.Source
}
$releaseBinary = Join-Path $PSScriptRoot 'target/release/halbach-service.exe'
$newestSource = Get-ChildItem -Path (Join-Path $PSScriptRoot 'src'), (Join-Path $PSScriptRoot 'Cargo.toml'), (Join-Path $PSScriptRoot 'Cargo.lock') -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$needsBuild = -not (Test-Path -LiteralPath $releaseBinary) -or ($newestSource -and $newestSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $releaseBinary).LastWriteTimeUtc)
if ($needsBuild) {
    $runningRelease = Get-Process -Name halbach-service -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $releaseBinary }
    if ($runningRelease) {
        throw 'An older workstation service is still running. Stop it with stop-workstation.bat (updated services) or press Esc then Ctrl+Break in its service window, then run start-workstation.bat again. Refreshing the browser does not update the Rust service.'
    }
    if (-not $cargoBinary -or -not (Test-Path -LiteralPath $cargoBinary)) { throw 'Sources have changed. Install Rust with rustup to build the current service; an outdated binary will not be started.' }
    & $cargoBinary build --release --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Service build failed. Stop any previous service before rebuilding, then run the launcher again.' }
}
if ($BuildOnly) { exit 0 }
$browserJob = $null
if ($OpenBrowser) {
    $browserJob = Start-Job -ArgumentList "http://127.0.0.1:$Port" -ScriptBlock {
        param($serviceUrl)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $health = Invoke-RestMethod -Uri "$serviceUrl/api/health" -TimeoutSec 1
                if ($health.ok -and $health.backend -eq 'rust') { Start-Process $serviceUrl; return }
            } catch {}
            Start-Sleep -Seconds 1
        }
    }
}
try { & $releaseBinary @serviceArguments; $serviceExitCode = $LASTEXITCODE }
finally { if ($browserJob) { Stop-Job $browserJob; Remove-Job $browserJob -Force } }
exit $serviceExitCode
