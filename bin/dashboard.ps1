<#
.SYNOPSIS
    Start the SDLC Framework dashboard pointed at the running Docker stack.
.DESCRIPTION
    Reads the port written by docker-up.ps1 from .sdlc-framework/docker-ports.json
    and launches the Vite dashboard with the correct SDLC_API_PORT.
.EXAMPLE
    .\bin\dashboard.ps1
#>

$worktreeRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $worktreeRoot) { Write-Error "Not inside a git repository."; exit 1 }

$portsFile = Join-Path $worktreeRoot '.sdlc-framework\docker-ports.json'
if (-not (Test-Path $portsFile)) {
    Write-Error "No docker-ports.json found. Run .\bin\docker-up.ps1 first."
    exit 1
}

$ports = Get-Content $portsFile | ConvertFrom-Json
$port  = $ports.serverPort

if (-not $port) {
    Write-Error "serverPort missing from docker-ports.json. Re-run .\bin\docker-up.ps1."
    exit 1
}

Write-Host "▶ Dashboard → http://localhost:$port" -ForegroundColor Cyan
$env:SDLC_API_PORT = $port
npm run dashboard
