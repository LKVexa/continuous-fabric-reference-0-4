$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cfpStatePath = if ($env:CFP_STATE_DIR) { $env:CFP_STATE_DIR } else { '.state' }
if (-not (Test-Path -LiteralPath (Join-Path $cfpStatePath 'hub.json'))) {
  & node bin/cfp.js init
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& node bin/cfp.js start
exit $LASTEXITCODE
