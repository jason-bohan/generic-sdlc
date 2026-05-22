# Reset SDLC Framework agent status files and chat messages to idle defaults.
# Dashboard Settings uses the same idle shapes via POST /api/agents/reset-to-idle (confirm: RESET_ALL_AGENTS).
# Does not delete workflow SQLite data. Restart the API server after reset if you see stale UI.
# Usage: .\bin\reset-agents.ps1 [-RepoRoot <path>]
# Default RepoRoot: parent of this script (repo root).

param(
    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$isoNow = (Get-Date).ToUniversalTime().ToString('o')

function Write-StatusJson {
    param([string]$Path, [object]$Object)
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    [System.IO.File]::WriteAllText($Path, $json)
}

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    Write-Error "RepoRoot not found: $RepoRoot"
    exit 1
}

$idleEvent = @(
    @{
        timestamp = $isoNow
        type      = 'info'
        message   = 'Reset to idle.'
    }
)

$tokens = @{
    cloud  = @{ input = 0; output = 0 }
    ollama = @{ input = 0; output = 0 }
}

$cypress = @{
    lastRun   = $null
    total     = 0
    passed    = 0
    failed    = 0
    skipped   = 0
    failures  = @()
}

$storyOwner = @{
    storyNumber       = $null
    storyName         = $null
    storyDescription  = $null
    currentPhase      = 'idle'
    currentTask       = $null
    startedAt         = $null
    tokens            = $tokens
    tasks             = @()
    prs               = @()
    requests          = @()
    cypress           = $cypress
    events            = $idleEvent
    handoffDispatched = $false
}

foreach ($id in @('frontend', 'backend', 'qa')) {
    $path = Join-Path $RepoRoot ".$id-status.json"
    Write-StatusJson -Path $path -Object $storyOwner
    Write-Host "Wrote $path"
}

$uxIdle = @{
    storyNumber       = $null
    storyName         = $null
    storyDescription  = $null
    currentPhase      = 'idle'
    currentTask       = $null
    startedAt         = $null
    tokens            = $tokens
    tasks             = @()
    prs               = @()
    requests          = @()
    cypress           = $cypress
    events            = $idleEvent
    handoffDispatched = $false
    collaborators     = @()
    designSpec        = $null
}
Write-StatusJson -Path (Join-Path $RepoRoot '.ux-status.json') -Object $uxIdle
Write-Host "Wrote $(Join-Path $RepoRoot '.ux-status.json')"

$supportIdle = @{
    assignedPR   = $null
    currentPhase = 'idle'
    requestedAt  = $null
    events       = $idleEvent
    projectKey   = $null
}
Write-StatusJson -Path (Join-Path $RepoRoot '.reviewer-status.json') -Object $supportIdle
Write-Host "Wrote $(Join-Path $RepoRoot '.reviewer-status.json')"

$devopsIdle = @{
    currentPhase = 'idle'
    assignedPR   = $null
    events       = $idleEvent
    projectKey   = $null
}
Write-StatusJson -Path (Join-Path $RepoRoot '.devops-status.json') -Object $devopsIdle
Write-Host "Wrote $(Join-Path $RepoRoot '.devops-status.json')"

Get-ChildItem -LiteralPath $RepoRoot -Force -File |
    Where-Object { $_.Name -match '^\.[^\\]+\-messages\.json$' } |
    ForEach-Object {
        Set-Content -LiteralPath $_.FullName -Value '[]' -Encoding utf8
        Write-Host "Cleared $($_.Name)"
    }

Write-Host ""
Write-Host "Agent JSON reset complete under: $RepoRoot"
Write-Host "Restart the SDLC Framework API server if it is running (npm run server) so hooks and watchers pick up clean files."
