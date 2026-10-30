param(
    [ValidateRange(1, 65535)][int]$Port = 8765,
    [ValidateRange(1, 60)][int]$WaitSeconds = 30
)
$ErrorActionPreference = 'Stop'
$serviceUrl = "http://127.0.0.1:$Port"
try {
    $session = Invoke-RestMethod -Uri "$serviceUrl/api/session" -TimeoutSec 3
    if ($session.backend -ne 'rust' -or $session.mode -ne 'workstation' -or -not $session.token) {
        throw 'No compatible local workstation service responded.'
    }
    $headers = @{ 'X-Halbach-Token' = $session.token }
    $result = Invoke-RestMethod -Uri "$serviceUrl/api/shutdown" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    if (-not $result.ok -or -not $result.pid) { throw 'Shutdown was not acknowledged.' }
    $serviceProcessId = [int]$result.pid
} catch {
    Write-Error 'Could not request service shutdown. In its console, press Esc to clear text selection, then Ctrl+Break. Older services must be stopped there once before rebuilding. This script does not forcibly terminate instrument control.'
    exit 1
}
Write-Host 'Shutdown requested. Waiting for acquisition cleanup and service exit...'
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {
        Write-Host 'Workstation service stopped.'
        exit 0
    }
    Start-Sleep -Milliseconds 200
}
Write-Error 'The service process is still running. Check its console and instrument cleanup before restarting.'
exit 1
