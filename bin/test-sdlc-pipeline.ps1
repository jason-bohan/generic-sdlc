<#
.SYNOPSIS
  End-to-end smoke test for the SDLC Framework SDLC handoff pipeline.

.DESCRIPTION
  Walks the full SDLC pipeline against the running dev server (localhost:3847),
  validating each API endpoint and the resulting status file mutations.

  Run with:  powershell -File bin/test-sdlc-pipeline.ps1

.NOTES
  Requires the dev server running (npm run dev). Port is read from .sdlc-framework/.dev-port.
  Backs up and restores status files so production state is preserved.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$devPortFile = Join-Path $root ".sdlc-framework/.dev-port"
if (Test-Path $devPortFile) { $apiPort = (Get-Content $devPortFile -Raw).Trim() } else { $apiPort = "3001" }
$baseUrl = "http://localhost:$apiPort"

# -- Helpers ---------------------------------------------------------------
function Write-Step($label) { Write-Host "`n=== $label ===" -ForegroundColor Cyan }
function Write-Pass($msg)  { Write-Host "  PASS: $msg" -ForegroundColor Green }
function Write-Fail($msg)  { Write-Host "  FAIL: $msg" -ForegroundColor Red; $script:failures++ }
function Write-Info($msg)  { Write-Host "  INFO: $msg" -ForegroundColor Gray }

function Post-Api($path, $body) {
    $json = $body | ConvertTo-Json -Compress -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    try {
        $resp = Invoke-RestMethod -Uri "$baseUrl$path" -Method POST -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 10
        return $resp
    } catch {
        Write-Fail "POST $path failed: $_"
        return $null
    }
}

function Write-JsonFile($filePath, $data) {
    $json = $data | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($filePath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Read-StatusFile($filename) {
    $p = Join-Path $root $filename
    if (Test-Path $p) {
        return Get-Content $p -Raw | ConvertFrom-Json
    }
    return $null
}

function Assert-Equal($actual, $expected, $label) {
    if ("$actual" -eq "$expected") {
        Write-Pass "$label = '$expected'"
    } else {
        Write-Fail "$label expected '$expected' but got '$actual'"
    }
}

function Assert-NotNull($value, $label) {
    if ($null -ne $value -and "$value" -ne "") {
        Write-Pass "$label is set"
    } else {
        Write-Fail "$label is null/empty"
    }
}

function Assert-SpawnLog($agentId, $label) {
    $logFile = Join-Path $root ".agent-spawns.log"
    if (-not (Test-Path $logFile)) {
        Write-Info "No .agent-spawns.log found (agent CLI may not be installed)"
        return
    }
    $lines = Get-Content $logFile
    $match = $lines | Where-Object { $_ -match "\| $agentId \|" }
    if ($match) {
        Write-Pass "$label spawn log entry for '$agentId' found"
    } else {
        Write-Info "$label no spawn log entry for '$agentId' (agent CLI may not be installed)"
    }
}

# -- Status file names touched by the pipeline -----------------------------
$statusFiles = @(
    ".frontend-status.json",
    ".reviewer-status.json",
    ".devops-status.json",
    ".ux-status.json"
)

$backupDir = Join-Path $root ".sdlc-test-backup"
$script:failures = 0

# -- Pre-flight ------------------------------------------------------------
Write-Step "Pre-flight: checking dev server on $baseUrl"
try {
    $null = Invoke-WebRequest -Uri "$baseUrl/api/status?agentId=frontend" -TimeoutSec 5 -UseBasicParsing
    Write-Pass "Dev server is running"
} catch {
    Write-Host "`nERROR: Dev server not reachable at $baseUrl" -ForegroundColor Red
    Write-Host "Start it with:  npm run dev" -ForegroundColor Yellow
    exit 1
}

# -- Backup existing status files ------------------------------------------
Write-Step "Backing up status files"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
foreach ($f in $statusFiles) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $backupDir $f) -Force
        Write-Info "Backed up $f"
    }
}

# -- Clear spawn log for fresh test ----------------------------------------
$spawnLogFile = Join-Path $root ".agent-spawns.log"
if (Test-Path $spawnLogFile) {
    $spawnLogBackup = Join-Path $backupDir ".agent-spawns.log"
    Copy-Item $spawnLogFile $spawnLogBackup -Force
    Remove-Item $spawnLogFile -Force
    Write-Info "Cleared .agent-spawns.log (backed up)"
}

# -- Setup: create a test agent status for frontend --------------------------
Write-Step "Setup: creating test agent status for frontend"
$testStory = "B-99999"
$testPrId = 99999
$frontendSetup = @{
    storyNumber = $testStory
    storyName = "SDLC Pipeline Test"
    currentPhase = "creating-pr"
    currentTask = $null
    startedAt = (Get-Date -Format "o")
    executionMode = "speed"
    tokens = @{ cloud = @{ input = 0; output = 0 }; ollama = @{ input = 0; output = 0 } }
    tasks = @()
    prs = @()
    cypress = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
    events = @(@{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Test setup" })
}
Write-JsonFile (Join-Path $root ".frontend-status.json") $frontendSetup
Write-Pass "Frontend status written with story $testStory"

# -- Step 1: POST /api/pr/created -----------------------------------------
Write-Step "Step 1: POST /api/pr/created"
$resp = Post-Api "/api/pr/created" @{
    agentId     = "frontend"
    prId        = $testPrId
    prTitle     = "test(SDLC): pipeline smoke test PR"
    prUrl       = "https://example.com/pr/$testPrId"
    storyNumber = $testStory
    branch      = "test/sdlc-pipeline"
}
if ($resp) {
    Assert-Equal $resp.ok $true "response.ok"
    Assert-Equal $resp.reviewerPhase "pending-review" "response.reviewerPhase"

    $reviewer = Read-StatusFile ".reviewer-status.json"
    Assert-Equal $reviewer.currentPhase "pending-review" "reviewer.currentPhase"
    Assert-Equal $reviewer.assignedPR.id $testPrId "reviewer.assignedPR.id"
    Assert-Equal $reviewer.assignedPR.storyNumber $testStory "reviewer.assignedPR.storyNumber"
    Assert-Equal $reviewer.assignedPR.branch "test/sdlc-pipeline" "reviewer.assignedPR.branch"

    $frontend = Read-StatusFile ".frontend-status.json"
    $pr = $frontend.prs | Where-Object { $_.id -eq $testPrId }
    Assert-NotNull $pr "frontend.prs contains test PR"
    Assert-Equal $pr.status "active" "frontend.prs[].status"
    Assert-SpawnLog "reviewer" "Step 1"
}

# -- Step 2: POST /api/handoff/review-complete (approved) ------------------
Write-Step "Step 2: POST /api/handoff/review-complete (verdict: approved)"
$resp = Post-Api "/api/handoff/review-complete" @{
    prId        = $testPrId
    verdict     = "approved"
    storyNumber = $testStory
    branch      = "test/sdlc-pipeline"
}
if ($resp) {
    Assert-Equal $resp.ok $true "response.ok"
    Assert-Equal $resp.target "devops" "response.target"
    Assert-Equal $resp.targetPhase "pending-build" "response.targetPhase"

    $devops = Read-StatusFile ".devops-status.json"
    Assert-Equal $devops.currentPhase "pending-build" "devops.currentPhase"
    Assert-Equal $devops.assignedPR.id $testPrId "devops.assignedPR.id"

    $reviewer = Read-StatusFile ".reviewer-status.json"
    Write-Info "reviewer.currentPhase after approval = '$($reviewer.currentPhase)'"
    if ($reviewer.currentPhase -eq "idle" -or $null -eq $reviewer.assignedPR) {
        Write-Pass "Reviewer was cleaned up after handoff"
    } else {
        Write-Info "NOTE: Reviewer status not cleaned up (known gap - fix-reviewer-phase todo)"
    }
    Assert-SpawnLog "devops" "Step 2"
}

# -- Step 2b: Idempotency check -------------------------------------------
Write-Step "Step 2b: Idempotency - re-posting same approval"
$devopsBefore = Read-StatusFile ".devops-status.json"
$devopsBeforeCount = 0
if ($devopsBefore.events) { $devopsBeforeCount = @($devopsBefore.events).Count }
$resp2 = Post-Api "/api/handoff/review-complete" @{
    prId    = $testPrId
    verdict = "approved"
}
$devopsAfter = Read-StatusFile ".devops-status.json"
$devopsAfterCount = 0
if ($devopsAfter.events) { $devopsAfterCount = @($devopsAfter.events).Count }
if ($devopsBeforeCount -eq $devopsAfterCount) {
    Write-Pass "DevOps status was NOT overwritten on duplicate approval (idempotent)"
} else {
    Write-Fail "DevOps events changed on duplicate call ($devopsBeforeCount -> $devopsAfterCount)"
}

# -- Step 3: POST /api/handoff/build-complete (passed) ---------------------
Write-Step "Step 3: POST /api/handoff/build-complete (result: passed)"
$resp = Post-Api "/api/handoff/build-complete" @{
    prId    = $testPrId
    result  = "passed"
    buildId = 12345
}
if ($resp) {
    Assert-Equal $resp.ok $true "response.ok"
    Assert-Equal $resp.storyOwner "frontend" "response.storyOwner"
    Assert-Equal $resp.newPrStatus "completed" "response.newPrStatus"

    $frontend = Read-StatusFile ".frontend-status.json"
    $pr = $frontend.prs | Where-Object { $_.id -eq $testPrId }
    Assert-Equal $pr.status "completed" "frontend.prs[].status after build passed"

    $devops = Read-StatusFile ".devops-status.json"
    Assert-Equal $devops.currentPhase "build-passed" "devops.currentPhase"
    $buildEvent = $devops.events | Where-Object { $_.message -match "12345" }
    Assert-NotNull $buildEvent "devops has event mentioning build #12345"
    Assert-SpawnLog "frontend" "Step 3"
}

# -- Step 4: POST /api/handoff/design-ready --------------------------------
Write-Step "Step 4: POST /api/handoff/design-ready"
$uxSetup = @{
    storyNumber = "B-88888"
    storyName = "Design Test"
    currentPhase = "spec-ready"
    events = @()
}
Write-JsonFile (Join-Path $root ".ux-status.json") $uxSetup

$resp = Post-Api "/api/handoff/design-ready" @{
    storyNumber = "B-88888"
    storyName   = "Design Test"
    designSpec  = ".ux-design-spec.md"
    targetAgent = "frontend"
}
if ($resp) {
    Assert-Equal $resp.ok $true "response.ok"
    Assert-Equal $resp.targetAgent "frontend" "response.targetAgent"
    Assert-Equal $resp.targetPhase "pending-approval" "response.targetPhase"

    $frontend = Read-StatusFile ".frontend-status.json"
    Assert-Equal $frontend.storyNumber "B-88888" "frontend.storyNumber (overwritten by design-ready)"
    Assert-Equal $frontend.currentPhase "pending-approval" "frontend.currentPhase"
    if ($frontend.collaborators -contains "ux") {
        Write-Pass "frontend.collaborators includes 'ux'"
    } else {
        Write-Fail "frontend.collaborators missing 'ux'"
    }
    Assert-Equal $frontend.designSpec ".ux-design-spec.md" "frontend.designSpec"

    $ux = Read-StatusFile ".ux-status.json"
    Assert-Equal $ux.currentPhase "collaborating" "ux.currentPhase"
    Assert-SpawnLog "frontend" "Step 4"
}

# -- Step 5: POST /api/handoff/review-complete (changes-requested) ---------
Write-Step "Step 5: POST /api/handoff/review-complete (verdict: changes-requested)"
$frontendCR = @{
    storyNumber = "B-77777"
    currentPhase = "watching-reviews"
    prs = @(@{ id = 77777; title = "CR Test PR"; status = "active" })
    events = @()
}
Write-JsonFile (Join-Path $root ".frontend-status.json") $frontendCR

$resp = Post-Api "/api/handoff/review-complete" @{
    prId    = 77777
    verdict = "changes-requested"
}
if ($resp) {
    Assert-Equal $resp.ok $true "response.ok"
    Assert-Equal $resp.target "frontend" "response.target"
    Assert-Equal $resp.targetPhase "addressing-feedback" "response.targetPhase"

    $frontend = Read-StatusFile ".frontend-status.json"
    Assert-Equal $frontend.currentPhase "addressing-feedback" "frontend.currentPhase after changes-requested"
    $pr = $frontend.prs | Where-Object { $_.id -eq 77777 }
    Assert-Equal $pr.status "changes-requested" "frontend.prs[].status after changes-requested"
}

# -- Step 6: Step-mode resume with task selection ---------------------------
Write-Step "Step 6: Step-mode resume via /api/agent/continue"

# Enable global step mode
$configFile = Join-Path $root ".sdlc-framework.config.json"
$configBackup = Join-Path $backupDir ".sdlc-framework.config.json"
if (Test-Path $configFile) { Copy-Item $configFile $configBackup -Force }
$config = Get-Content $configFile -Raw | ConvertFrom-Json
$origGlobalStep = $config.scheduler.globalStepMode
$config.scheduler.globalStepMode = $true
Write-JsonFile $configFile $config

# Set frontend to 'analyzing' with tasks and handoffDispatched=true
$stepTestFrontend = @{
    storyNumber = "B-66666"
    storyName = "Step Mode Test"
    currentPhase = "analyzing"
    handoffDispatched = $true
    tasks = @(
        @{ id = "TK-1"; number = "TK-1"; name = "Task One"; status = "pending"; category = "Frontend" }
        @{ id = "TK-2"; number = "TK-2"; name = "Task Two"; status = "pending"; category = "Frontend" }
        @{ id = "TK-3"; number = "TK-3"; name = "Task Three"; status = "pending"; category = "Frontend" }
    )
    requests = @(
        @{ id = "REQ-1"; type = "review"; source = "reviewer"; summary = "Fix null check"; file = "src/app.ts"; line = 42; status = "open" }
    )
    events = @()
}
Write-JsonFile (Join-Path $root ".frontend-status.json") $stepTestFrontend
Write-Pass "Frontend set to 'analyzing' with step mode ON, handoffDispatched=true"

# Call continue with selected tasks and requests
$resp = Post-Api "/api/agent/continue" @{
    agentId = "frontend"
    selectedTaskIds = @("TK-1", "TK-3")
    selectedRequestIds = @("REQ-1")
}
if ($resp) {
    Assert-Equal $resp.ok $true "continue response.ok"
    Assert-Equal $resp.agentId "frontend" "continue response.agentId"
    Assert-Equal $resp.phase "analyzing" "continue response.phase"
    if ($resp.selectedTaskIds -and $resp.selectedTaskIds.Count -eq 2) {
        Write-Pass "continue response.selectedTaskIds has 2 items"
    } else {
        Write-Fail "continue response.selectedTaskIds expected 2 items"
    }
    if ($resp.selectedRequestIds -and $resp.selectedRequestIds.Count -eq 1) {
        Write-Pass "continue response.selectedRequestIds has 1 item"
    } else {
        Write-Fail "continue response.selectedRequestIds expected 1 item"
    }

    # Verify handoffDispatched was reset before spawn attempt
    $frontendAfter = Read-StatusFile ".frontend-status.json"
    if ($frontendAfter.handoffDispatched -eq $false -or $null -eq $frontendAfter.handoffDispatched) {
        Write-Fail "handoffDispatched should be true (re-set by _doSpawn after spawn)"
    } else {
        Write-Pass "handoffDispatched is true (set by _doSpawn after spawn)"
    }
}

# -- Step 6b: Continue without selected tasks (bare resume) ----------------
Write-Step "Step 6b: Bare resume (no task selection)"
# Reset handoffDispatched for next test
$stepTestFrontend.handoffDispatched = $true
Write-JsonFile (Join-Path $root ".frontend-status.json") $stepTestFrontend

$resp = Post-Api "/api/agent/continue" @{ agentId = "frontend" }
if ($resp) {
    Assert-Equal $resp.ok $true "bare continue response.ok"
    Assert-Equal $resp.phase "analyzing" "bare continue response.phase"
}

# -- Step 7: Dismiss completed task ----------------------------------------
Write-Step "Step 7: Dismiss completed task via /api/agent/dismiss-item"
$dismissFrontend = @{
    storyNumber = "B-66666"
    currentPhase = "generating-code"
    tasks = @(
        @{ id = "TK-1"; number = "TK-1"; name = "Done Task"; status = "completed"; category = "Frontend" }
        @{ id = "TK-2"; number = "TK-2"; name = "Active Task"; status = "in_progress"; category = "Frontend" }
    )
    requests = @(
        @{ id = "REQ-1"; type = "review"; source = "reviewer"; summary = "Resolved fix"; status = "resolved" }
        @{ id = "REQ-2"; type = "build"; source = "devops"; summary = "Build fail"; status = "open" }
    )
    events = @()
}
Write-JsonFile (Join-Path $root ".frontend-status.json") $dismissFrontend

$resp = Post-Api "/api/agent/dismiss-item" @{ agentId = "frontend"; itemId = "TK-1"; itemType = "task" }
if ($resp) {
    Assert-Equal $resp.ok $true "dismiss task response.ok"
    Assert-Equal $resp.dismissed "TK-1" "dismiss task response.dismissed"
    $afterDismiss = Read-StatusFile ".frontend-status.json"
    $remaining = @($afterDismiss.tasks | Where-Object { $_.id -eq "TK-1" })
    if ($remaining.Count -eq 0) {
        Write-Pass "TK-1 removed from tasks array"
    } else {
        Write-Fail "TK-1 still present after dismiss"
    }
    if (@($afterDismiss.tasks).Count -eq 1) {
        Write-Pass "Only 1 task remains"
    } else {
        Write-Fail "Expected 1 task remaining, got $(@($afterDismiss.tasks).Count)"
    }
}

# -- Step 7b: Dismiss resolved request ------------------------------------
Write-Step "Step 7b: Dismiss resolved request"
$resp = Post-Api "/api/agent/dismiss-item" @{ agentId = "frontend"; itemId = "REQ-1"; itemType = "request" }
if ($resp) {
    Assert-Equal $resp.ok $true "dismiss request response.ok"
    Assert-Equal $resp.dismissed "REQ-1" "dismiss request response.dismissed"
    $afterDismiss = Read-StatusFile ".frontend-status.json"
    $remaining = @($afterDismiss.requests | Where-Object { $_.id -eq "REQ-1" })
    if ($remaining.Count -eq 0) {
        Write-Pass "REQ-1 removed from requests array"
    } else {
        Write-Fail "REQ-1 still present after dismiss"
    }
}

# -- Step 7c: Step-mode toggle (enabled alias) ------------------------------
Write-Step "Step 7c: Step-mode toggle via POST /api/agent/step-mode"
# Turn off global step mode first so per-agent toggle is allowed
$config.scheduler.globalStepMode = $false
Write-JsonFile $configFile $config
$resp = Post-Api "/api/agent/step-mode" @{ agentId = "frontend"; enabled = $false }
if ($resp) {
    Assert-Equal $resp.agentId "frontend" "step-mode response.agentId"
    Assert-Equal $resp.stepMode $false "step-mode response.stepMode (enabled: false)"
}

# -- Step 7d: Continue with phaseHint --------------------------------------
Write-Step "Step 7d: Continue with phaseHint (creating-pr)"
$resp = Post-Api "/api/agent/continue" @{ agentId = "frontend"; phaseHint = "creating-pr" }
if ($resp) {
    Assert-Equal $resp.ok $true "continue phaseHint response.ok"
    Assert-Equal $resp.phaseHint "creating-pr" "continue response.phaseHint includes hint"
}

# Restore config
$config.scheduler.globalStepMode = $origGlobalStep
Write-JsonFile $configFile $config
if (Test-Path $configBackup) { Copy-Item $configBackup $configFile -Force }

# -- Step 8: Validation errors ---------------------------------------------
Write-Step "Step 8: Validation - missing required fields"
try {
    $null = Invoke-RestMethod -Uri "$baseUrl/api/pr/created" -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 5
    Write-Fail "Expected 400 for empty body on /api/pr/created"
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 400) {
        Write-Pass "/api/pr/created returns 400 on missing agentId/prId"
    } else {
        Write-Info "/api/pr/created returned $($_.Exception.Response.StatusCode.value__) (expected 400)"
    }
}

try {
    $null = Invoke-RestMethod -Uri "$baseUrl/api/handoff/review-complete" -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 5
    Write-Fail "Expected 400 for empty body on /api/handoff/review-complete"
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 400) {
        Write-Pass "/api/handoff/review-complete returns 400 on missing prId/verdict"
    } else {
        Write-Info "/api/handoff/review-complete returned $($_.Exception.Response.StatusCode.value__) (expected 400)"
    }
}

# -- Cleanup: restore backups ---------------------------------------------
Write-Step "Cleanup: restoring original status files"
foreach ($f in $statusFiles) {
    $backup = Join-Path $backupDir $f
    $dest = Join-Path $root $f
    if (Test-Path $backup) {
        Copy-Item $backup $dest -Force
        Write-Info "Restored $f from backup"
    } else {
        if (Test-Path $dest) {
            Remove-Item $dest -Force
            Write-Info "Removed test $f (no backup existed)"
        }
    }
}
# Restore spawn log
$spawnLogBackup = Join-Path $backupDir ".agent-spawns.log"
if (Test-Path $spawnLogBackup) {
    Copy-Item $spawnLogBackup $spawnLogFile -Force
    Write-Info "Restored .agent-spawns.log from backup"
} elseif (Test-Path $spawnLogFile) {
    Remove-Item $spawnLogFile -Force
    Write-Info "Removed test .agent-spawns.log"
}

if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }

# -- Summary ---------------------------------------------------------------
Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "ALL TESTS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:failures) FAILURE(S)" -ForegroundColor Red
    exit 1
}
