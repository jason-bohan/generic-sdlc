# Estimates cloud token usage from the agent response text and reports to the dashboard.
# Registered as an afterAgentResponse hook - fires after each agent response.
# Uses ~4 chars/token heuristic for output; estimates input as 2x output (typical ratio).
# This is an approximation until Cursor exposes real token counts to hooks.
# When real counts become available, the stop hook (cloud-token-reporter.ps1) will
# detect them and this estimator can be removed.

$ErrorActionPreference = "SilentlyContinue"

$API_URL = "http://localhost:3001/api/tokens/cloud"
$CHARS_PER_TOKEN = 4
$workspace = Get-Location

# --- 1. Read stdin JSON from Cursor ---
$rawInput = ""
try {
    $rawInput = [Console]::In.ReadToEnd()
} catch {}

if (-not $rawInput) {
    Write-Output '{}'
    exit 0
}

$hookData = $null
try {
    $hookData = $rawInput | ConvertFrom-Json
} catch {
    Write-Output '{}'
    exit 0
}

# --- 2. Estimate tokens from response text ---
$text = $hookData.text
if (-not $text -or $text.Length -eq 0) {
    Write-Output '{}'
    exit 0
}

$outputTokens = [math]::Ceiling($text.Length / $CHARS_PER_TOKEN)
$inputTokens = $outputTokens * 2

if ($outputTokens -le 0) {
    Write-Output '{}'
    exit 0
}

# --- 3. Determine active agentId by scanning .*-status.json files ---
$agentId = "frontend"
# Keep in sync with: cloud-token-reporter.ps1, skills/office/SKILL.md
$activePhases = @("reading-story", "planning", "analyzing", "generating-code", "validating", "creating-pr", "watching-reviews", "addressing-feedback", "running-cypress", "reviewing", "commenting", "pending-build", "building")
$statusFiles = Get-ChildItem -Path $workspace -Filter ".*-status.json" -File -ErrorAction SilentlyContinue
foreach ($sf in $statusFiles) {
    try {
        $s = Get-Content $sf.FullName -Raw | ConvertFrom-Json
        if ($s.currentPhase -in $activePhases) {
            $agentId = $sf.Name -replace '^\.|(-status\.json)$', ''
            break
        }
    } catch {}
}

# --- 4. POST to dashboard token API ---
$body = @{
    agentId = $agentId
    input   = $inputTokens
    output  = $outputTokens
} | ConvertTo-Json -Compress

try {
    Invoke-RestMethod -Uri $API_URL -Method POST -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
} catch {}

Write-Output '{}'
exit 0
