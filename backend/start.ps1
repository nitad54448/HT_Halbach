$ErrorActionPreference = 'Stop'
$rustLauncher = Join-Path (Split-Path -Parent $PSScriptRoot) 'rust-backend/start.ps1'
& $rustLauncher @args
exit $LASTEXITCODE
