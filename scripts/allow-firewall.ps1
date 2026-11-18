<#
.SYNOPSIS
    Lets the iPad reach the NOTA server on this Wi-Fi.

.DESCRIPTION
    Run this from an Administrator PowerShell window. Two things are needed,
    and the second is the one that silently wins:

      * an inbound Allow rule for TCP 8443, scoped to LocalSubnet so it never
        reaches the Internet, on the Private *and* Public profiles — Windows
        classifies a home Wi-Fi as Public by default, and a Private-only rule
        then does nothing at all;
      * any inbound Block rule that matches the Python running the server. A
        block rule wins over every allow rule, so such a rule drops each
        connection from the iPad while the server looks perfectly healthy.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 8443
)

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw 'Run this script from an Administrator PowerShell window.'
}

$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root 'backend\.venv\Scripts\python.exe'

# Windows attributes the socket to the real interpreter, and the virtual
# environment on Windows is a redirector: ask the server's own Python which
# executable that is, so the block rules are matched exactly.
$serverPython = ''
if (Test-Path $venvPython) {
    try {
        $serverPython = (& $venvPython -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim()
    } catch {
        $serverPython = ''
    }
}
if (-not $serverPython) {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if ($found) { $serverPython = $found.Source }
}

Write-Host ''
Write-Host '  NOTA - letting the iPad in' -ForegroundColor Green
Write-Host '  --------------------------'
if ($serverPython) { Write-Host "  Server Python : $serverPython" }

# 1. The allow rule, on both profiles, limited to this network -----------------
$profiles = 'Private,Public'
$existing = Get-NetFirewallRule -DisplayName 'Thoth Notes' -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Set-NetFirewallRule -Enabled True -Action Allow -Profile $profiles -Direction Inbound
    $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
    $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet
    Write-Host "  Updated 'Thoth Notes': TCP $Port, private and public networks, this subnet only."
} else {
    New-NetFirewallRule -DisplayName 'Thoth Notes' -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile $profiles -RemoteAddress LocalSubnet | Out-Null
    Write-Host "  Created 'Thoth Notes': TCP $Port, private and public networks, this subnet only."
}

# 2. Block rules that would override it, for this interpreter only ------------
if ($serverPython) {
    $blocking = @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue |
        Where-Object { (($_ | Get-NetFirewallApplicationFilter).Program) -eq $serverPython })
    if ($blocking.Count -gt 0) {
        foreach ($rule in $blocking) {
            Write-Host "  Removing the blocking rule '$($rule.DisplayName)' ($($rule.Profile)) for that program." -ForegroundColor Yellow
            Remove-NetFirewallRule -Name $rule.Name
        }
    } else {
        Write-Host '  No blocking rule matched the server program.'
    }
} else {
    Write-Host '  Server Python not found - start run.bat once, then run this script again.' -ForegroundColor Yellow
}

# 3. Say what the machine now looks like --------------------------------------
$networks = @(Get-NetConnectionProfile | ForEach-Object { "$($_.Name) ($($_.InterfaceAlias), $($_.NetworkCategory))" })
if ($networks.Count -gt 0) { Write-Host "  Networks      : $($networks -join '; ')" }
Get-NetFirewallRule -DisplayName 'Thoth Notes' -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  Rule          : $($_.DisplayName) | $($_.Enabled) | $($_.Action) | $($_.Profile)" }

Write-Host ''
Write-Host '  Done. On the iPad, reload the setup page or press Sync now.'
Write-Host ''
