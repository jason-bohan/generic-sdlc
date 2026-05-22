#Requires -Version 5.1
<#
.SYNOPSIS
    Headless Claude Code agent launcher for SDLC Framework.
    Equivalent to bin/run-agent.ps1 but targets the Claude Code CLI instead of Cursor.

.NOTES
    Called by spawn-agent.ts when scheduler.driver = "claude-code".
    Requires 'claude' on PATH (npm install -g @anthropic-ai/claude-code).
#>
param(
    [Parameter(Mandatory)][string]$AgentId,
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][string]$WorkspaceDir,
    [string]$Model = "auto"
)

Set-Location $WorkspaceDir

$configPath = Join-Path $WorkspaceDir ".sdlc-framework.config.json"

function Get-ExternalMode {
    if ($env:SDLC_EXTERNAL_MODE -in @("mock", "live")) { return $env:SDLC_EXTERNAL_MODE }
    if (Test-Path $configPath) {
        try {
            $mConfig = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($mConfig.externalMode -eq "mock" -or $mConfig.integrations.mode -eq "mock") { return "mock" }
        } catch { }
    }
    return "live"
}

function Install-MockModeCommandGuards {
    $mockBin = Join-Path $WorkspaceDir ".sdlc-framework\mock-bin"
    if (-not (Test-Path $mockBin)) { New-Item -ItemType Directory -Path $mockBin -Force | Out-Null }
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $realGit = $gitCmd.Source
        $gitShim = Join-Path $mockBin "git.cmd"
        @"
@echo off
if /I "%~1"=="push" (
  echo [sdlc-framework mock mode] git push is blocked. Use local commits and mock PR state only. 1>&2
  exit /b 88
)
"$realGit" %*
"@ | Set-Content -Path $gitShim -Encoding ASCII
    }
    $azShim = Join-Path $mockBin "az.cmd"
    @"
@echo off
echo [sdlc-framework mock mode] Azure CLI is blocked. Use SDLC Framework mock API/state instead. 1>&2
exit /b 88
"@ | Set-Content -Path $azShim -Encoding ASCII
    if (-not (($env:PATH -split ';') -contains $mockBin)) {
        $env:PATH = "$mockBin;$env:PATH"
    }
    $env:SDLC_FRAMEWORK_MOCK_MODE = "1"
    Write-Host "[run-agent-claude] Mock command guards installed (git push and az are blocked)"
}

if ((Get-ExternalMode) -eq "mock") {
    Install-MockModeCommandGuards
    $env:AGILITY_BASE_URL = "http://localhost:3001/mock-v1"
    $env:V1_BASE_URL = "http://localhost:3001/mock-v1"
    $env:AGILITY_API_KEY = "mock-token"
    $env:V1_ACCESS_TOKEN = "mock-token"
    Write-Host "[run-agent-claude] External mode: MOCK (live ADO and git push are prohibited)"
}

if (-not (Test-Path $PromptFile)) {
    Write-Error "Prompt file not found: $PromptFile"
    exit 1
}

$claudeExe = (Get-Command claude -ErrorAction SilentlyContinue)?.Source
if (-not $claudeExe) {
    # Fallback: npm global bin on Windows
    $npmGlobal = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $npmGlobal) { $claudeExe = $npmGlobal }
}
if (-not $claudeExe) {
    Write-Error "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
}

$prompt = Get-Content $PromptFile -Raw -Encoding UTF8

$modelArgs = if ($Model -ne "auto" -and $Model) { @("--model", $Model) } else { @() }

Write-Host "[run-agent-claude] Spawning Claude Code for agent: $AgentId"

& $claudeExe --dangerously-skip-permissions -p $prompt @modelArgs
exit $LASTEXITCODE
