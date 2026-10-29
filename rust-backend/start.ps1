param(
    [int]$Port = 8765,
    [string[]]$AllowOrigin = @(),
    [switch]$ServeUi
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
$newestSource = Get-ChildItem -Path (Join-Path $PSScriptRoot 'src'), (Join-Path $PSScriptRoot 'Cargo.toml') -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$needsBuild = -not (Test-Path -LiteralPath $releaseBinary) -or ($newestSource -and $newestSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $releaseBinary).LastWriteTimeUtc)
if (-not $needsBuild) { & $releaseBinary @serviceArguments; exit $LASTEXITCODE }
if (-not $cargoBinary -or -not (Test-Path -LiteralPath $cargoBinary)) {
    if (Test-Path -LiteralPath $releaseBinary) { & $releaseBinary @serviceArguments; exit $LASTEXITCODE }
    throw 'Install Rust with rustup, then run this launcher again.'
}
& $cargoBinary run --release --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') -- @serviceArguments
exit $LASTEXITCODE
