# wait-and-open.ps1
# Waits until the local server has actually bound its port, then opens the browser.
#
# Why: the launcher scripts used to run `start <browser> http://localhost:5200`
# BEFORE starting server.py. Python needs ~1.4s (cold start: more) to listen on
# the port, so the browser always hit ERR_CONNECTION_REFUSED on first open and
# the user had to refresh manually.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File wait-and-open.ps1 `
#       -Port 5200 -Url "http://localhost:5200/" -Browser "C:\...\chrome.exe"
#
# -Browser is optional. If it is empty or the file does not exist, the default
# browser is used instead.

param(
    [int]$Port = 5200,
    [string]$Url = 'http://localhost:5200/',
    [string]$Browser = '',
    [int]$TimeoutSeconds = 30,
    # Wait only, do not open anything. Useful for troubleshooting
    # (e.g. "is the server actually coming up?").
    [switch]$NoOpen
)

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$ready = $false

while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        $ready = $true
    } catch {
        # Port not bound yet - server.py still starting up.
        Start-Sleep -Milliseconds 120
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
    if ($ready) { break }
}

$stopwatch.Stop()

if ($NoOpen) { return }

# Even on timeout we still try to open, so the user sees the page (and any real
# error) instead of nothing happening at all.
if ($Browser -and (Test-Path -LiteralPath $Browser)) {
    Start-Process -FilePath $Browser -ArgumentList $Url
} else {
    Start-Process $Url
}
