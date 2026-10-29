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
$releaseBinary = Join-Path $PSScriptRoot 'target/release/halbach-service.exe'
if (Test-Path -LiteralPath $releaseBinary) { & $releaseBinary @serviceArguments; exit $LASTEXITCODE }
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargoCommand) { $cargoBinary = $cargoCommand.Source }
else {
    $localCargo = Join-Path $workspacePath '.tools/cargo'
    $cargoBinary = Join-Path $localCargo 'bin/cargo.exe'
    if (-not (Test-Path -LiteralPath $cargoBinary)) { throw 'Install Rust with rustup, then run this launcher again.' }
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $workspacePath '.tools/rustup'
    $nativeTools = Join-Path $env:RUSTUP_HOME 'toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin'
    $env:PATH = (Join-Path $localCargo 'bin') + ';' + $nativeTools + ';' + (Join-Path $nativeTools 'self-contained') + ';' + $env:PATH
    $env:RUSTFLAGS = '-C linker=rust-lld.exe -C linker-flavor=ld.lld -C link-self-contained=yes'
}
& $cargoBinary run --release --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') -- @serviceArguments
exit $LASTEXITCODE
