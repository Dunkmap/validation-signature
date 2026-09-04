# One full cycle: seed an envelope, sign it three times in a real browser,
# download the finished PDF and inspect the certificate chain.
#
#   powershell -File scripts/verify-flow.ps1

$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

$backend = Split-Path $PSScriptRoot -Parent
$root    = Split-Path $backend -Parent
$tmp  = Join-Path $env:TEMP "esign-verify"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Push-Location $backend
try {
  Write-Host "1. seeding an envelope"
  $out = node scripts/seed.js
  $toks = ($out | Select-String -Pattern '/s/([0-9a-f]{64})' -AllMatches).Matches |
          ForEach-Object { $_.Groups[1].Value }
  if ($toks.Count -ne 3) { throw "expected 3 tokens, got $($toks.Count)" }
  Write-Host "   ok - 3 signing links"

  Write-Host "`n2. signing in a real browser, in order"
  $drive = Join-Path $PSScriptRoot "live.py"
  if (-not (Test-Path $drive)) { throw "live.py driver not found at $drive" }
  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  python $drive $toks[0] $toks[1] $toks[2]

  Write-Host "`n3. downloading the finished document"
  $pdf = Join-Path $tmp "final.pdf"
  Invoke-WebRequest "http://127.0.0.1:3000/download/$($toks[2])" -OutFile $pdf `
    -UseBasicParsing -TimeoutSec 30
  $hash = (Get-FileHash $pdf -Algorithm SHA256).Hash.ToLower()
  Write-Host "   $((Get-Item $pdf).Length) bytes, sha256 $hash"

  # The download must be the stored bytes, identical every time.
  $pdf2 = Join-Path $tmp "final2.pdf"
  Invoke-WebRequest "http://127.0.0.1:3000/download/$($toks[0])" -OutFile $pdf2 `
    -UseBasicParsing -TimeoutSec 30
  $same = (Get-FileHash $pdf2 -Algorithm SHA256).Hash.ToLower() -eq $hash
  Write-Host "   identical for another signer: $same"

  Write-Host "`n4. inspecting the certificate pages"
  node scripts/inspect-pdf.mjs $pdf 2>&1 |
    Where-Object { $_ -notmatch 'fetchStandardFontData|baseUrl' }
}
finally {
  Pop-Location
}
