<#
.SYNOPSIS
    Stop the SDLC Framework Docker stack for the current worktree.

.PARAMETER Volumes
    Also remove per-worktree volumes (database, .sdlc-framework state).
    The shared Ollama model volume is never removed by this script.
#>
param([switch]$Volumes)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$worktreeRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $worktreeRoot) { Write-Error "Not inside a git repository."; exit 1 }

$worktreeName = [System.IO.Path]::GetFileName($worktreeRoot) -replace '[^a-zA-Z0-9]', '-'
$projectName  = "sdlc-framework-$worktreeName".ToLower() -replace '-+', '-'
$env:COMPOSE_PROJECT_NAME = $projectName

$args = @('compose', 'down')
if ($Volumes) {
    $args += '--volumes'
    Write-Host "  Removing per-worktree volumes (Ollama model cache is preserved)" -ForegroundColor DarkGray
}

Write-Host "▶ Stopping stack: $projectName" -ForegroundColor Cyan
docker @args
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Stack stopped" -ForegroundColor Green
    # Clean up port file
    $portsFile = Join-Path $worktreeRoot '.sdlc-framework' 'docker-ports.json'
    if (Test-Path $portsFile) { Remove-Item $portsFile -Force }
}
