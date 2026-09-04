# Expose the signing page publicly through ngrok.
#
#   powershell -File scripts/tunnel.ps1
#
# One tunnel, pointed at the frontend. The frontend proxies /api to the backend,
# so both reach the outside world through a single URL - which is also what
# keeps signing links valid, since a link must be openable from the recipient's
# machine, not just this one.

$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

$root = Split-Path $PSScriptRoot -Parent

# --- 0. refuse to expose a service still using the development secret --------

if (-not $env:ESIGN_SECRET -or $env:ESIGN_SECRET -eq "local-dev-secret") {
  Write-Host ""
  Write-Host "  Refusing to start: ESIGN_SECRET is unset or still the dev default." -ForegroundColor Red
  Write-Host "  A public URL with a known secret lets anyone create envelopes and"
  Write-Host "  send mail in your name."
  Write-Host ""
  Write-Host "  Generate one and restart the servers with it:"
  Write-Host ""
  Write-Host '    $env:ESIGN_SECRET = -join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })' -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

# --- 1. the frontend must be up ---------------------------------------------

$web = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $web) {
  Write-Host "  Nothing is listening on :3000. Start the servers first (npm start)." -ForegroundColor Red
  exit 1
}

# --- 2. start the tunnel ------------------------------------------------------

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "`n  Starting tunnel to :3000 ..." -ForegroundColor Cyan
# --request-header-add makes ngrok skip its free-tier interstitial. Without it
# the browser's fetch calls to /api receive that HTML warning page instead of
# JSON, and the signing page fails with a parse error that says nothing useful.
Start-Process -FilePath "ngrok" `
  -ArgumentList "http","3000","--log","stdout","--log-format","json",
                "--request-header-add=ngrok-skip-browser-warning:true" `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$env:TEMP\ngrok.log" `
  -RedirectStandardError "$env:TEMP\ngrok.err"

# ngrok publishes the assigned URL on its local API once the tunnel is up.
$publicUrl = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not $publicUrl) {
  Start-Sleep -Milliseconds 700
  try {
    $api = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
    $publicUrl = ($api.tunnels | Where-Object { $_.proto -eq "https" } |
                  Select-Object -First 1).public_url
  } catch { }
}

if (-not $publicUrl) {
  Write-Host "  The tunnel did not come up. ngrok said:" -ForegroundColor Red
  Get-Content "$env:TEMP\ngrok.err","$env:TEMP\ngrok.log" -ErrorAction SilentlyContinue |
    Select-Object -Last 12
  exit 1
}

Write-Host "  Public URL   $publicUrl" -ForegroundColor Green
Write-Host "  Inspector    http://127.0.0.1:4040"

# --- 3. verify it actually serves ---------------------------------------------

try {
  $r = Invoke-WebRequest $publicUrl -UseBasicParsing -TimeoutSec 20
  Write-Host "  Reachable    $($r.StatusCode)"
} catch {
  Write-Host "  Not reachable: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

try {
  $h = Invoke-RestMethod "$publicUrl/api/health" -TimeoutSec 20
  Write-Host "  API proxy    ok (storage: $($h.driver))"
} catch {
  Write-Host "  The API proxy is not answering: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# --- 4. tell the backend to build links with the public URL -------------------

Write-Host ""
Write-Host "  Restart the API so signing links point at the tunnel:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    `$env:ESIGN_FRONTEND_URL = '$publicUrl'"
Write-Host "    npm run start:api"
Write-Host ""
Write-Host "  Then create an envelope:"
Write-Host ""
Write-Host "    npm run seed -- --file <pdf> --signer `"Name <email>:Role:1,62,565,160,44`""
Write-Host ""
Write-Host "  Stop the tunnel with:  Get-Process ngrok | Stop-Process" -ForegroundColor DarkGray
Write-Host ""

$publicUrl | Out-File -Encoding utf8 "$env:TEMP\esign-tunnel-url.txt"
