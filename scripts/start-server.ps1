<#
.SYNOPSIS
    Starts the NOTA sync server on the local network.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
    powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Port 9443
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$PublicUrl = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$venvPython = Join-Path $backend '.venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    throw 'Server is not installed yet. Run scripts\install-windows.ps1 first.'
}

if ($Port -gt 0) { $env:THOTH_PORT = $Port }
if ($PublicUrl) {
    # The address is validated by the server itself; a plain http:// one would
    # fail on the iPad later, so it is refused here and nothing is started.
    & $venvPython -m app.cli public-url $PublicUrl
    if ($LASTEXITCODE -ne 0) {
        throw "The trusted address '$PublicUrl' was refused. It must start with https:// and have no path, for example https://jps-laptop.tailnet-name.ts.net"
    }
    Write-Host "  Using trusted address $($PublicUrl.TrimEnd('/')) - no local certificate, loopback only."
}

Push-Location $backend
try {
    & $venvPython -m app
} finally {
    Pop-Location
}
