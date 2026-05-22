# Reports exact cloud LLM token usage from the Cursor agent turn to the dashboard.
# Registered as a stop hook - fires after each agent turn completes.
# Posts to http://localhost:3001/api/tokens/cloud with { agentId, input, output }.
# Fails silently if the Vite dev server is unreachable or tokens are unavailable.
#
# Currently Cursor does not expose token counts in the stop hook payload.
# When it does, this hook will pick them up automatically.
#
# WARNING: When enabling this hook with real token data, you MUST remove
# cloud-token-estimator.ps1 from hooks.json FIRST to avoid double-counting.
# Both hooks POST to the same /api/tokens/cloud endpoint and tokens accumulate additively.

$ErrorActionPreference = "SilentlyContinue"

$API_URL = "http://localhost:3001/api/tokens/cloud"
$workspace = Get-Location

# --- 1. Read stdin JSON from Cursor ---
$rawInput = ""
try {
    $rawInput = [Console]::In.ReadToEnd()
} catch {}

$hookData = $null
if ($rawInput) {
    try {
        $hookData = $rawInput | ConvertFrom-Json
    } catch {}
}

# --- 2. Extract token counts ---
# Check documented and potential undocumented stdin fields first
$inputTokens = 0
$outputTokens = 0
$foundTokens = $false

if ($hookData) {
    # Check for direct token fields (may be added in future Cursor versions)
    foreach ($field in @("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")) {
        $val = $hookData.$field
        if ($val -and $val -gt 0) {
            $inputTokens = [int]$val
            $foundTokens = $true
            break
        }
    }
    foreach ($field in @("output_tokens", "completion_tokens", "outputTokens", "completionTokens")) {
        $val = $hookData.$field
        if ($val -and $val -gt 0) {
            $outputTokens = [int]$val
            $foundTokens = $true
            break
        }
    }

    # Check nested usage object (OpenAI-style)
    if (-not $foundTokens -and $hookData.usage) {
        $usage = $hookData.usage
        if ($usage.prompt_tokens -and $usage.prompt_tokens -gt 0) {
            $inputTokens = [int]$usage.prompt_tokens
            $foundTokens = $true
        }
        if ($usage.completion_tokens -and $usage.completion_tokens -gt 0) {
            $outputTokens = [int]$usage.completion_tokens
            $foundTokens = $true
        }
    }
}

# Fallback: check environment variables
if (-not $foundTokens) {
    $envInput = $env:CURSOR_INPUT_TOKENS
    $envOutput = $env:CURSOR_OUTPUT_TOKENS
    if ($envInput -and [int]::TryParse($envInput, [ref]$null)) {
        $inputTokens = [int]$envInput
        $foundTokens = $true
    }
    if ($envOutput -and [int]::TryParse($envOutput, [ref]$null)) {
        $outputTokens = [int]$envOutput
        $foundTokens = $true
    }
}

# AC: skip POST if tokens are absent or zero
if (-not $foundTokens -or ($inputTokens -le 0 -and $outputTokens -le 0)) {
    Write-Output '{}'
    exit 0
}

# --- 3. Determine active agentId by scanning .*-status.json files ---
$agentId = "frontend"
# Keep in sync with: cloud-token-estimator.ps1, skills/office/SKILL.md
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
} catch {
    # Server not running or unreachable - fail silently per AC
}

Write-Output '{}'
exit 0
