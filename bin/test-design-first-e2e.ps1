<#
.SYNOPSIS
  Design-first E2E pipeline test — UX designs, then frontend + backend implement, parallel review.

.DESCRIPTION
  Simulates a design-first story flowing through the SDLC:
    1. UX agent is assigned a story and produces a design spec
    2. Design-ready handoff triggers both frontend and backend agents
    3. Both implementation agents code and create PRs
    4. Brehon (code review) and Prism (design review) run in parallel
    5. Both must approve before devops/build proceeds
    6. Build gate and final assertions

  Run with:  powershell -File bin/test-design-first-e2e.ps1
  Flags:
    -SkipAgentSpawn   Skip live agent spawns; drive pipeline via API (fast mode)
    -SkipCypress      Skip Cypress test execution
    -AgentTimeout     Max seconds to wait per agent spawn (default 300)

.NOTES
  Requires: API + Vite dev servers running (npm run dev). Ports are read from .sdlc-framework/.dev-port.
  Uses mock external mode — no real ADO/Agility calls.
#>
param(
    [switch]$SkipAgentSpawn,
    [switch]$SkipCypress,
    [int]$AgentTimeout = 300
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$devPortFile = Join-Path $root ".sdlc-framework/.dev-port"
if (Test-Path $devPortFile) { $apiPort = (Get-Content $devPortFile -Raw).Trim() } else { $apiPort = "3001" }
$vitePort = if ($apiPort -eq "3001") { "3847" } else { [int]$apiPort + 1000 }
$apiUrl = "http://localhost:$apiPort"
$dashUrl = "http://localhost:$vitePort"

$testStory = "DS-99001"
$testStoryName = "User Profile Page with Design System"
$testStoryDesc = "Design-first story: UX creates a design spec for a new User Profile page. Frontend implements the UI components. Backend adds the /api/user-profile endpoint. Both PRs require code review AND design review approval."

$script:failures = 0
$script:passes = 0
$script:startTime = Get-Date

# ===========================================================================
# Helpers (same as test-fullstack-e2e.ps1)
# ===========================================================================

function Write-Banner($msg) {
    $border = "=" * 70
    Write-Host ""
    Write-Host $border -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor White
    Write-Host $border -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step($label) {
    Write-Host ""
    Write-Host "--- $label ---" -ForegroundColor Cyan
}

function Write-Pass($msg) {
    Write-Host "  PASS: $msg" -ForegroundColor Green
    $script:passes++
}

function Write-Fail($msg) {
    Write-Host "  FAIL: $msg" -ForegroundColor Red
    $script:failures++
}

function Write-Info($msg) {
    Write-Host "  INFO: $msg" -ForegroundColor Gray
}

function Write-Warn($msg) {
    Write-Host "  WARN: $msg" -ForegroundColor Yellow
}

function Post-Api($path, $body, [string]$base = $apiUrl) {
    $json = $body | ConvertTo-Json -Compress -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    try {
        $resp = Invoke-RestMethod -Uri "$base$path" -Method POST `
            -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 15
        return $resp
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Write-Fail "POST $path failed (HTTP $code): $_"
        return $null
    }
}

function Get-Api($path, [string]$base = $apiUrl) {
    try {
        return Invoke-RestMethod -Uri "$base$path" -Method GET -TimeoutSec 10
    } catch {
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
        try { return Get-Content $p -Raw | ConvertFrom-Json } catch { return $null }
    }
    return $null
}

function Assert-Equal($actual, $expected, $label) {
    if ("$actual" -eq "$expected") { Write-Pass "$label = '$expected'" }
    else { Write-Fail "$label expected '$expected' but got '$actual'" }
}

function Assert-NotNull($value, $label) {
    if ($null -ne $value -and "$value" -ne "") { Write-Pass "$label is set" }
    else { Write-Fail "$label is null/empty" }
}

function Assert-GreaterThan($actual, $threshold, $label) {
    if ($actual -gt $threshold) { Write-Pass "$label = $actual (> $threshold)" }
    else { Write-Fail "$label = $actual (expected > $threshold)" }
}

function Get-ElapsedStr {
    $elapsed = (Get-Date) - $script:startTime
    return "{0:mm\:ss}" -f $elapsed
}

function Wait-AgentPhase {
    param(
        [string]$AgentId,
        [string[]]$TargetPhases,
        [int]$TimeoutSec = $AgentTimeout,
        [int]$PollSec = 10
    )
    $statusFile = ".$AgentId-status.json"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastPhase = ""
    while ((Get-Date) -lt $deadline) {
        $s = Read-StatusFile $statusFile
        if ($s) {
            $phase = $s.currentPhase
            if ($phase -ne $lastPhase) {
                Write-Info "[$AgentId] phase: $lastPhase -> $phase  ($(Get-ElapsedStr))"
                $lastPhase = $phase
            }
            if ($TargetPhases -contains $phase) { return $s }
            if ($phase -eq "error") {
                Write-Warn "[$AgentId] entered error phase"
                return $s
            }
        }
        Start-Sleep -Seconds $PollSec
    }
    Write-Warn "[$AgentId] timed out after ${TimeoutSec}s (last phase: $lastPhase)"
    return Read-StatusFile $statusFile
}

# ===========================================================================
# Phase 0: Setup
# ===========================================================================

Write-Banner "DESIGN-FIRST E2E PIPELINE TEST"
Write-Info "Story: $testStory - $testStoryName"
Write-Info "Agent timeout: ${AgentTimeout}s"
Write-Info "Skip agent spawn: $SkipAgentSpawn"
Write-Info "Skip Cypress: $SkipCypress"

Write-Step "Phase 0: Pre-flight checks"

$apiCheck = Get-Api "/api/execution-mode"
if (-not $apiCheck) {
    Write-Host "ERROR: API server not reachable at $apiUrl" -ForegroundColor Red
    Write-Host "Start it with:  npx tsx src/server/index.ts" -ForegroundColor Yellow
    exit 1
}
Write-Pass "API server running on $apiUrl"

if (-not $SkipCypress) {
    try {
        $null = Invoke-WebRequest -Uri "$dashUrl" -TimeoutSec 5 -UseBasicParsing
        Write-Pass "Vite dev server running on $dashUrl"
    } catch {
        Write-Warn "Vite not reachable at $dashUrl - Cypress tests will be skipped"
        $SkipCypress = $true
    }
}

# Back up status files and config
Write-Step "Phase 0: Backing up state"
$backupDir = Join-Path $root ".e2e-test-backup"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

$statusFiles = @(
    ".frontend-status.json", ".backend-status.json", ".reviewer-status.json",
    ".devops-status.json", ".ux-status.json", ".qa-status.json"
)
$configFile = ".sdlc-framework.config.json"
$spawnLog = ".agent-spawns.log"

foreach ($f in @($statusFiles + $configFile + $spawnLog)) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $backupDir $f) -Force
        Write-Info "Backed up $f"
    }
}

# Create temp git repo
Write-Step "Phase 0: Creating temp git repo"
$tempRepo = Join-Path $env:TEMP "sdlc-framework-design-e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $tempRepo -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/src/YourProject.Api" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/src/YourProject.Web/app/user-profile" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/.cursor/rules" -Force | Out-Null

@"
Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "YourProject.Api", "src\YourProject.Api\YourProject.Api.csproj", "{A1B2C3D4}"
EndProject
"@ | Set-Content "$tempRepo/YourProject.sln"

@"
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
"@ | Set-Content "$tempRepo/src/YourProject.Api/YourProject.Api.csproj"

@"
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => "YourProject API");
app.Run();
"@ | Set-Content "$tempRepo/src/YourProject.Api/Program.cs"

@"
# .NET Standards (Test Skeleton)
- Use nullable reference types
- Constructor injection for DI
"@ | Set-Content "$tempRepo/.cursor/rules/.net-standards.mdc"

Push-Location $tempRepo
git init --initial-branch main 2>&1 | Out-Null
git add -A 2>&1 | Out-Null
git commit -m "Initial YourProject skeleton for design-first E2E test" 2>&1 | Out-Null
Pop-Location
Write-Pass "Temp repo created at $tempRepo"

# Patch config
Write-Step "Phase 0: Patching config"
$patchedConfig = Get-Content (Join-Path $root $configFile) -Raw | ConvertFrom-Json
$patchedConfig.projects.YourProject.workspacePath = $tempRepo
$patchedConfig.externalMode = "mock"
$patchedConfig.activeProject = "YourProject"
$patchedConfig.scheduler.agents.ux.stepMode = $false
$patchedConfig.scheduler.agents.ux.enabled = $true
$patchedConfig.scheduler.agents.backend.stepMode = $false
$patchedConfig.scheduler.agents.backend.enabled = $true
$patchedConfig.scheduler.agents.frontend.stepMode = $false
$patchedConfig.scheduler.agents.frontend.enabled = $true
Write-JsonFile (Join-Path $root $configFile) $patchedConfig
Write-Pass "Config patched: mock mode, step mode OFF for ux/frontend/backend"

# Clear spawn log and existing status files
$spawnLogPath = Join-Path $root $spawnLog
if (Test-Path $spawnLogPath) { Remove-Item $spawnLogPath -Force }
foreach ($agentId in @("frontend", "backend", "reviewer", "devops", "ux")) {
    $sf = Join-Path $root ".$agentId-status.json"
    if (Test-Path $sf) { Remove-Item $sf -Force }
}

# ===========================================================================
# Phase 1: Assign Story to UX, Approve/Spawn
# ===========================================================================

Write-Banner "PHASE 1: ASSIGN STORY TO UX AGENT"

Write-Step "Assigning story to UX agent"
$uxAssign = Post-Api "/api/scheduler/assign" @{
    agentId          = "ux"
    storyNumber      = $testStory
    storyName        = $testStoryName
    storyDescription = $testStoryDesc
}
if ($uxAssign) {
    Assert-Equal $uxAssign.ok $true "ux assign ok"
    Write-Info "UX initial phase: $($uxAssign.phase)"
} else { Write-Fail "UX assign returned null" }

# Approve UX if needed
$uxStatus = Read-StatusFile ".ux-status.json"
if ($uxStatus -and $uxStatus.currentPhase -eq "pending-approval") {
    $uxApprove = Post-Api "/api/scheduler/approve" @{ agentId = "ux" }
    if ($uxApprove) {
        Assert-Equal $uxApprove.ok $true "ux approve ok"
        Write-Info "UX spawned: $($uxApprove.agentSpawned)"
    }
} else {
    Write-Info "UX already in phase '$($uxStatus.currentPhase)' (auto-start)"
}

# ===========================================================================
# Phase 2: Monitor UX through spec-ready (or simulate)
# ===========================================================================

Write-Banner "PHASE 2: UX DESIGN PHASE"

if ($SkipAgentSpawn) {
    Write-Info "Agent spawn skipped - simulating UX work via API"

    # Write design spec file
    $designSpecContent = @"
# Design Spec: $testStory - $testStoryName

## Overview
New User Profile page with avatar, bio, and settings sections.

## Color Tokens
| Token | Value | Contrast | Usage |
|-------|-------|----------|-------|
| bgProfile | #F8FAFC | - | Profile page background |
| textName | #0F172A | 15.3:1 | User display name |
| accentAvatar | #6366F1 | 4.6:1 | Avatar border ring |

## Layout
- Full-width header with avatar (96px) and name
- Two-column grid below: Bio (left), Settings (right)
- Responsive: stacks to single column at 768px

## Components
### UserAvatar
- Props: src, size (sm/md/lg), status (online/offline/busy)
- States: default, hover (scale 1.05), loading (skeleton)

### ProfileCard
- Props: user, editable
- Contains: UserAvatar, display name, role badge, bio text

## Accessibility
- Avatar: aria-label with user name
- All interactive elements keyboard-navigable
- Minimum 4.5:1 contrast on all text
"@
    $designSpecPath = Join-Path $root ".ux-design-spec.md"
    [System.IO.File]::WriteAllText($designSpecPath, $designSpecContent, (New-Object System.Text.UTF8Encoding $false))

    # Write UX status
    $uxEvt1 = @{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Story $testStory assigned." }
    $uxEvt2 = @{ timestamp = (Get-Date -Format "o"); type = "success"; message = "Design spec written to .ux-design-spec.md" }
    $uxSimStatus = @{
        projectKey    = "YourProject"
        storyNumber   = $testStory
        storyName     = $testStoryName
        currentPhase  = "spec-ready"
        currentTask   = $null
        startedAt     = (Get-Date -Format "o")
        executionMode = "speed"
        collaborators = @()
        designSpec    = ".ux-design-spec.md"
        tokens        = @{ cloud = @{ input = 500; output = 300 }; ollama = @{ input = 0; output = 0 } }
        tasks         = @()
        prs           = @()
        cypress       = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
        events        = @($uxEvt1, $uxEvt2)
    }
    Write-JsonFile (Join-Path $root ".ux-status.json") $uxSimStatus
    Write-Pass "Simulated UX agent work (design spec written, phase: spec-ready)"
} else {
    Write-Info "Waiting for UX agent to reach spec-ready (timeout: ${AgentTimeout}s)..."
    $uxResult = Wait-AgentPhase -AgentId "ux" -TargetPhases @("spec-ready", "collaborating", "complete", "error") -TimeoutSec $AgentTimeout
    if ($uxResult) {
        Write-Info "UX reached phase: $($uxResult.currentPhase)"
    } else {
        Write-Warn "UX agent timed out"
    }
}

# Validate design spec exists
$designSpecPath = Join-Path $root ".ux-design-spec.md"
if (Test-Path $designSpecPath) {
    Write-Pass "Design spec file exists"
} else {
    Write-Warn "Design spec file not found (expected at .ux-design-spec.md)"
}

# ===========================================================================
# Phase 3: Design-ready handoff to frontend + backend
# ===========================================================================

Write-Banner "PHASE 3: DESIGN-READY HANDOFF"

Write-Step "Handing off to frontend agent"
$feHandoff = Post-Api "/api/handoff/design-ready" @{
    storyNumber = $testStory
    storyName   = $testStoryName
    designSpec  = ".ux-design-spec.md"
    targetAgent = "frontend"
}
if ($feHandoff) {
    Assert-Equal $feHandoff.ok $true "design-ready(frontend) ok"
    Write-Info "Frontend target phase: $($feHandoff.targetPhase)"
}

Write-Step "Handing off to backend agent"
$beHandoff = Post-Api "/api/handoff/design-ready" @{
    storyNumber = $testStory
    storyName   = $testStoryName
    designSpec  = ".ux-design-spec.md"
    targetAgent = "backend"
}
if ($beHandoff) {
    Assert-Equal $beHandoff.ok $true "design-ready(backend) ok"
    Write-Info "Backend target phase: $($beHandoff.targetPhase)"
}

# Verify both agents have collaborators: ['ux']
$feStatus = Read-StatusFile ".frontend-status.json"
$beStatus = Read-StatusFile ".backend-status.json"
if ($feStatus -and $feStatus.collaborators) {
    $feCollabs = @($feStatus.collaborators)
    if ($feCollabs -contains "ux") { Write-Pass "Frontend has collaborator: ux" }
    else { Write-Fail "Frontend missing collaborator: ux" }
} else { Write-Fail "Frontend status missing collaborators field" }

if ($beStatus -and $beStatus.collaborators) {
    $beCollabs = @($beStatus.collaborators)
    if ($beCollabs -contains "ux") { Write-Pass "Backend has collaborator: ux" }
    else { Write-Fail "Backend missing collaborator: ux" }
} else { Write-Fail "Backend status missing collaborators field" }

# Verify UX status updated to collaborating
$uxStatus = Read-StatusFile ".ux-status.json"
if ($uxStatus) {
    Assert-Equal $uxStatus.currentPhase "collaborating" "ux phase after handoff"
}

# ===========================================================================
# Phase 4: Monitor implementation agents (or simulate)
# ===========================================================================

Write-Banner "PHASE 4: IMPLEMENTATION"

$fePrId = 201
$bePrId = 202

if ($SkipAgentSpawn) {
    Write-Info "Agent spawn skipped - simulating implementation work"

    # Approve agents if needed
    foreach ($agentId in @("frontend", "backend")) {
        $s = Read-StatusFile ".$agentId-status.json"
        if ($s -and $s.currentPhase -eq "pending-approval") {
            $resp = Post-Api "/api/scheduler/approve" @{ agentId = $agentId }
            if ($resp) { Write-Info "$agentId approved" }
        }
    }

    # Simulate frontend work
    $feTask1 = @{ number = "TK-DS99001-1"; name = "Create UserAvatar component"; status = "Completed"; estimateHours = 1.5 }
    $feTask2 = @{ number = "TK-DS99001-2"; name = "Create ProfileCard component"; status = "Completed"; estimateHours = 2.0 }
    $fePrObj = @{ id = $fePrId; title = "feat($testStory): User Profile UI components"; url = "$apiUrl/mock-prs/$fePrId"; branch = "feat/DS-99001-profile-ui"; status = "active"; mock = $true }
    $feEvt1 = @{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Story $testStory assigned from UX design." }
    $feEvt2 = @{ timestamp = (Get-Date -Format "o"); type = "success"; message = "Implemented UserAvatar, ProfileCard. Mock PR $fePrId created." }
    $feSimStatus = @{
        projectKey        = "YourProject"
        storyNumber       = $testStory
        storyName         = $testStoryName
        currentPhase      = "watching-reviews"
        currentTask       = $null
        startedAt         = (Get-Date -Format "o")
        executionMode     = "speed"
        collaborators     = @("ux")
        designSpec        = ".ux-design-spec.md"
        tokens            = @{ cloud = @{ input = 1200; output = 800 }; ollama = @{ input = 0; output = 0 } }
        tasks             = @($feTask1, $feTask2)
        prs               = @($fePrObj)
        cypress           = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
        events            = @($feEvt1, $feEvt2)
        handoffDispatched = $false
    }
    Write-JsonFile (Join-Path $root ".frontend-status.json") $feSimStatus

    # Simulate backend work
    $beTask1 = @{ number = "TK-DS99001-3"; name = "Add UserProfileController"; status = "Completed"; estimateHours = 1.5 }
    $beTask2 = @{ number = "TK-DS99001-4"; name = "Add UserProfile DTO and repository"; status = "Completed"; estimateHours = 1.0 }
    $bePrObj = @{ id = $bePrId; title = "feat($testStory): User Profile API endpoint"; url = "$apiUrl/mock-prs/$bePrId"; branch = "feat/DS-99001-profile-api"; status = "active"; mock = $true }
    $beEvt1 = @{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Story $testStory assigned from UX design." }
    $beEvt2 = @{ timestamp = (Get-Date -Format "o"); type = "success"; message = "Implemented UserProfileController, DTO. Mock PR $bePrId created." }
    $beSimStatus = @{
        projectKey        = "YourProject"
        storyNumber       = $testStory
        storyName         = $testStoryName
        currentPhase      = "watching-reviews"
        currentTask       = $null
        startedAt         = (Get-Date -Format "o")
        executionMode     = "speed"
        collaborators     = @("ux")
        designSpec        = ".ux-design-spec.md"
        tokens            = @{ cloud = @{ input = 1000; output = 700 }; ollama = @{ input = 0; output = 0 } }
        tasks             = @($beTask1, $beTask2)
        prs               = @($bePrObj)
        cypress           = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
        events            = @($beEvt1, $beEvt2)
        handoffDispatched = $false
    }
    Write-JsonFile (Join-Path $root ".backend-status.json") $beSimStatus

    # Create branches in temp repo
    Push-Location $tempRepo
    git checkout -b "feat/DS-99001-profile-ui" 2>&1 | Out-Null
    @"
import { Component } from '@angular/core';
@Component({ selector: 'app-user-profile', template: '<div class="profile"><app-user-avatar></app-user-avatar></div>' })
export class UserProfileComponent {}
"@ | Set-Content "src/YourProject.Web/app/user-profile/user-profile.component.ts"
    git add -A 2>&1 | Out-Null
    git commit -m "feat(DS-99001): Add User Profile UI components" 2>&1 | Out-Null

    git checkout main 2>&1 | Out-Null
    git checkout -b "feat/DS-99001-profile-api" 2>&1 | Out-Null
    @"
namespace YourProject.Api.Controllers;
public class UserProfileController {
    [HttpGet("/api/user-profile")]
    public UserProfile Get() => new("Test User", "Developer");
}
public record UserProfile(string Name, string Role);
"@ | Set-Content "src/YourProject.Api/UserProfileController.cs"
    git add -A 2>&1 | Out-Null
    git commit -m "feat(DS-99001): Add User Profile API endpoint" 2>&1 | Out-Null
    git checkout main 2>&1 | Out-Null
    Pop-Location

    Write-Pass "Simulated frontend agent work (2 tasks, PR #$fePrId)"
    Write-Pass "Simulated backend agent work (2 tasks, PR #$bePrId)"
} else {
    # Approve and wait for live agents
    foreach ($agentId in @("frontend", "backend")) {
        $s = Read-StatusFile ".$agentId-status.json"
        if ($s -and $s.currentPhase -eq "pending-approval") {
            $resp = Post-Api "/api/scheduler/approve" @{ agentId = $agentId }
            if ($resp) { Write-Info "$agentId approved, spawned: $($resp.agentSpawned)" }
        }
    }

    $terminalPhases = @("watching-reviews", "complete", "idle", "error", "creating-pr")
    $deadline = (Get-Date).AddSeconds($AgentTimeout)
    $feReached = $false
    $beReached = $false

    while ((Get-Date) -lt $deadline -and (-not $feReached -or -not $beReached)) {
        if (-not $feReached) {
            $fs = Read-StatusFile ".frontend-status.json"
            if ($fs -and $terminalPhases -contains $fs.currentPhase) {
                $feReached = $true
                Write-Pass "Frontend reached: $($fs.currentPhase)"
                $fePrId = if ($fs.prs -and @($fs.prs).Count -gt 0) { @($fs.prs)[0].id } else { $fePrId }
            }
        }
        if (-not $beReached) {
            $bs = Read-StatusFile ".backend-status.json"
            if ($bs -and $terminalPhases -contains $bs.currentPhase) {
                $beReached = $true
                Write-Pass "Backend reached: $($bs.currentPhase)"
                $bePrId = if ($bs.prs -and @($bs.prs).Count -gt 0) { @($bs.prs)[0].id } else { $bePrId }
            }
        }
        if (-not $feReached -or -not $beReached) { Start-Sleep -Seconds 10 }
    }
}

# ===========================================================================
# Phase 5: Register PRs + Parallel Reviews (Code + Design)
# ===========================================================================

Write-Banner "PHASE 5: PARALLEL CODE AND DESIGN REVIEW"

# Register frontend PR (triggers UX review notification because collaborators has 'ux')
Write-Step "Registering frontend PR #$fePrId"
$fePrResp = Post-Api "/api/pr/created" @{
    agentId     = "frontend"
    prId        = $fePrId
    prTitle     = "feat($testStory): User Profile UI components"
    prUrl       = "$apiUrl/mock-prs/$fePrId"
    storyNumber = $testStory
    branch      = "feat/DS-99001-profile-ui"
}
if ($fePrResp) {
    Assert-Equal $fePrResp.ok $true "pr/created(frontend) ok"
    if ($fePrResp.uxNotified) { Write-Pass "UX agent notified for design review" }
    else { Write-Info "UX not notified (may not have collaborators)" }
}

# Register backend PR
Write-Step "Registering backend PR #$bePrId"
$bePrResp = Post-Api "/api/pr/created" @{
    agentId     = "backend"
    prId        = $bePrId
    prTitle     = "feat($testStory): User Profile API endpoint"
    prUrl       = "$apiUrl/mock-prs/$bePrId"
    storyNumber = $testStory
    branch      = "feat/DS-99001-profile-api"
}
if ($bePrResp) {
    Assert-Equal $bePrResp.ok $true "pr/created(backend) ok"
}

# Verify UX entered reviewing-design phase
$uxStatus = Read-StatusFile ".ux-status.json"
if ($uxStatus) {
    Assert-Equal $uxStatus.currentPhase "reviewing-design" "ux phase after PR registration"
    if ($uxStatus.assignedPR) {
        Write-Pass "UX has assignedPR for design review"
    }
}

# Verify frontend PR has designReview field initialized
$feStatus = Read-StatusFile ".frontend-status.json"
if ($feStatus -and $feStatus.prs) {
    $fePr = @($feStatus.prs) | Where-Object { $_.id -eq $fePrId }
    if ($fePr -and $fePr.designReview) {
        Write-Pass "Frontend PR has designReview field initialized"
    } else {
        Write-Info "Frontend PR designReview field not initialized (gate inactive for this PR)"
    }
}

# --- Parallel reviews ---

# Code review: Brehon approves frontend PR
Write-Step "Brehon: Code review APPROVED for frontend PR #$fePrId"
$codeReviewFe = Post-Api "/api/handoff/review-complete" @{
    prId        = $fePrId
    verdict     = "approved"
    storyNumber = $testStory
}
if ($codeReviewFe) {
    Assert-Equal $codeReviewFe.ok $true "code-review(frontend) ok"
    Write-Info "Code review target: $($codeReviewFe.target), phase: $($codeReviewFe.targetPhase)"
    if ($codeReviewFe.target -eq "waiting-for-design-review") {
        Write-Pass "Code review approved but waiting for design review (parallel gate working)"
    } elseif ($codeReviewFe.target -eq "devops") {
        Write-Info "Code review proceeded to devops (no design gate active)"
    }
}

# Design review: Prism approves frontend PR
Write-Step "Prism: Design review APPROVED for frontend PR #$fePrId"
$designReviewFe = Post-Api "/api/handoff/design-review-complete" @{
    prId        = $fePrId
    verdict     = "approved"
    storyNumber = $testStory
    comments    = "Design spec fully implemented. Avatar sizes correct, contrast passes WCAG AA."
}
if ($designReviewFe) {
    Assert-Equal $designReviewFe.ok $true "design-review(frontend) ok"
    Assert-Equal $designReviewFe.bothApproved $true "both reviews approved for frontend"
    if ($designReviewFe.bothApproved) {
        Assert-Equal $designReviewFe.target "devops" "frontend PR -> devops after both approved"
        Assert-Equal $designReviewFe.targetPhase "pending-build" "devops phase after both approved"
    }
}

# Validate devops has the frontend PR
$devops = Read-StatusFile ".devops-status.json"
if ($devops) {
    Assert-Equal $devops.currentPhase "pending-build" "devops phase after frontend PR"
    Assert-Equal $devops.assignedPR.id $fePrId "devops assigned frontend PR"
}

# Build complete for frontend PR
Write-Step "Build complete for frontend PR #$fePrId"
$buildFe = Post-Api "/api/handoff/build-complete" @{
    prId    = $fePrId
    result  = "passed"
    buildId = 95001
}
if ($buildFe) {
    Assert-Equal $buildFe.ok $true "build-complete(frontend) ok"
    Assert-Equal $buildFe.newPrStatus "completed" "frontend PR status after build"
}

# --- Backend PR: code + design review ---
Write-Step "Brehon: Code review APPROVED for backend PR #$bePrId"
$codeReviewBe = Post-Api "/api/handoff/review-complete" @{
    prId        = $bePrId
    verdict     = "approved"
    storyNumber = $testStory
}
if ($codeReviewBe) {
    Assert-Equal $codeReviewBe.ok $true "code-review(backend) ok"
    Write-Info "Code review target: $($codeReviewBe.target), phase: $($codeReviewBe.targetPhase)"
}

Write-Step "Prism: Design review APPROVED for backend PR #$bePrId"
$designReviewBe = Post-Api "/api/handoff/design-review-complete" @{
    prId        = $bePrId
    verdict     = "approved"
    storyNumber = $testStory
    comments    = "API response shape matches design spec DTO definitions."
}
if ($designReviewBe) {
    Assert-Equal $designReviewBe.ok $true "design-review(backend) ok"
    Assert-Equal $designReviewBe.bothApproved $true "both reviews approved for backend"
}

# Build complete for backend PR
Write-Step "Build complete for backend PR #$bePrId"
$buildBe = Post-Api "/api/handoff/build-complete" @{
    prId    = $bePrId
    result  = "passed"
    buildId = 95002
}
if ($buildBe) {
    Assert-Equal $buildBe.ok $true "build-complete(backend) ok"
    Assert-Equal $buildBe.newPrStatus "completed" "backend PR status after build"
}

# ===========================================================================
# Phase 6: Verify final states
# ===========================================================================

Write-Banner "PHASE 6: FINAL STATE VALIDATION"

Write-Step "Verifying agent completion states"
$feFinalPost = Read-StatusFile ".frontend-status.json"
$beFinalPost = Read-StatusFile ".backend-status.json"
$uxFinalPost = Read-StatusFile ".ux-status.json"

if ($feFinalPost) {
    Assert-Equal $feFinalPost.currentPhase "complete" "frontend final phase"
}
if ($beFinalPost) {
    Assert-Equal $beFinalPost.currentPhase "complete" "backend final phase"
}
if ($uxFinalPost) {
    # UX should be complete after design reviews are done
    $uxPhase = $uxFinalPost.currentPhase
    if ($uxPhase -eq "complete" -or $uxPhase -eq "collaborating") {
        Write-Pass "ux final phase: $uxPhase"
    } else {
        Write-Info "ux final phase: $uxPhase (expected complete or collaborating)"
    }
}

Write-Step "Agent status summary"
foreach ($agentId in @("ux", "frontend", "backend", "reviewer", "devops")) {
    $s = Read-StatusFile ".$agentId-status.json"
    if ($s) {
        $phase = $s.currentPhase
        $eventCount = if ($s.events) { @($s.events).Count } else { 0 }
        $taskCount = if ($s.tasks) { @($s.tasks).Count } else { 0 }
        $prCount = if ($s.prs) { @($s.prs).Count } else { 0 }
        Write-Info "$($agentId.PadRight(10)) | phase: $($phase.PadRight(20)) | tasks: $taskCount | PRs: $prCount | events: $eventCount"
    } else {
        Write-Info "$($agentId.PadRight(10)) | (no status file)"
    }
}

# ===========================================================================
# Phase 7: QA / Cypress (optional)
# ===========================================================================

Write-Banner "PHASE 7: QA VALIDATION"

if ($SkipCypress) {
    Write-Info "Cypress tests skipped (-SkipCypress flag or Vite not running)"
    $qaResp = Post-Api "/api/test-results" @{
        agentId  = "qa"
        total    = 7
        passed   = 7
        failed   = 0
        skipped  = 0
        specFile = "e2e-design-first-simulation"
    }
    if ($qaResp) { Write-Pass "Simulated QA results posted (7 passed)" }
} else {
    Write-Step "Running Cypress tests"
    $cypressStart = Get-Date
    try {
        $cypressOutput = & npx cypress run --spec "cypress/e2e/dashboard.cy.ts,cypress/e2e/model-picker.cy.ts" 2>&1
        $cypressExit = $LASTEXITCODE
    } catch {
        $cypressOutput = $_.ToString()
        $cypressExit = 1
    }
    $cypressElapsed = [Math]::Round(((Get-Date) - $cypressStart).TotalSeconds, 1)
    Write-Info "Cypress completed in ${cypressElapsed}s with exit code $cypressExit"
    $passMatch = [regex]::Match(($cypressOutput -join "`n"), "(\d+) passing")
    $failMatch = [regex]::Match(($cypressOutput -join "`n"), "(\d+) failing")
    $cypressPassed = if ($passMatch.Success) { [int]$passMatch.Groups[1].Value } else { 0 }
    $cypressFailed = if ($failMatch.Success) { [int]$failMatch.Groups[1].Value } else { 0 }
    $cypressTotal = $cypressPassed + $cypressFailed
    if ($cypressExit -eq 0) { Write-Pass "Cypress: $cypressPassed passed, $cypressFailed failed" }
    else { Write-Fail "Cypress: $cypressPassed passed, $cypressFailed failed (exit $cypressExit)" }
    $qaResp = Post-Api "/api/test-results" @{
        agentId  = "qa"
        total    = $cypressTotal
        passed   = $cypressPassed
        failed   = $cypressFailed
        skipped  = 0
        specFile = "cypress/e2e/dashboard.cy.ts,cypress/e2e/model-picker.cy.ts"
    }
    if ($qaResp) { Write-Info "QA results posted to API" }
}

# ===========================================================================
# Phase 8: Cleanup
# ===========================================================================

Write-Banner "PHASE 8: CLEANUP"

Write-Step "Restoring original state"
foreach ($f in @($statusFiles + $configFile + $spawnLog)) {
    $backup = Join-Path $backupDir $f
    $dest = Join-Path $root $f
    if (Test-Path $backup) {
        Copy-Item $backup $dest -Force
        Write-Info "Restored $f"
    } else {
        if (Test-Path $dest) {
            Remove-Item $dest -Force
            Write-Info "Removed test $f (no backup existed)"
        }
    }
}

# Clean up design spec
$designSpecClean = Join-Path $root ".ux-design-spec.md"
if (Test-Path $designSpecClean) {
    Remove-Item $designSpecClean -Force
    Write-Info "Removed .ux-design-spec.md"
}

Write-Step "Removing temp git repo"
if (Test-Path $tempRepo) {
    Remove-Item $tempRepo -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $tempRepo) {
        Start-Sleep -Seconds 1
        Remove-Item $tempRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempRepo) {
        Write-Warn "Could not fully remove temp repo (locked files): $tempRepo"
    } else {
        Write-Pass "Temp repo removed: $tempRepo"
    }
}

if (Test-Path $backupDir) {
    Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ===========================================================================
# Summary
# ===========================================================================

$totalElapsed = [Math]::Round(((Get-Date) - $script:startTime).TotalSeconds, 1)

Write-Host ""
Write-Banner "TEST SUMMARY"
Write-Host "  Passed:  $($script:passes)" -ForegroundColor Green
Write-Host "  Failed:  $($script:failures)" -ForegroundColor $(if ($script:failures -gt 0) { "Red" } else { "Green" })
Write-Host "  Elapsed: ${totalElapsed}s" -ForegroundColor Cyan
Write-Host ""

if ($script:failures -eq 0) {
    Write-Host "  ALL TESTS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  $($script:failures) FAILURE(S)" -ForegroundColor Red
    exit 1
}
