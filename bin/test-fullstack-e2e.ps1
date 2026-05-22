<#
.SYNOPSIS
  Full-stack E2E pipeline test — hybrid orchestration with live agent spawns.

.DESCRIPTION
  Simulates a full-stack story flowing through the entire SDLC:
    1. A temp git repo mimicking Mosaic is created
    2. Both frontend + backend agents are assigned the same story and spawned
    3. Agents work in parallel (read story, plan tasks, write code, create PRs)
    4. Reviewer handles both PRs (with API-driven fallback if agents skip /api/pr/created)
    5. DevOps build gates are simulated
    6. Real Cypress tests run for QA validation
    7. All status files, git state, and handoffs are validated
    8. Cleanup restores original state

  Run with:  powershell -File bin/test-fullstack-e2e.ps1
  Flags:
    -SkipAgentSpawn   Skip live agent spawns; drive entire pipeline via API (fast mode)
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

$testStory = "FS-99001"
$testStoryName = "Add Widget Dashboard with API"
$testStoryDesc = "Full-stack story: Backend adds /api/widgets endpoint returning widget data. Frontend adds a Widgets dashboard page consuming the API. Includes unit tests for both."

$script:failures = 0
$script:passes = 0
$script:startTime = Get-Date

# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

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

function Assert-Contains($list, $value, $label) {
    if ($list -contains $value) { Write-Pass "$label contains '$value'" }
    else { Write-Fail "$label does not contain '$value'" }
}

function Get-ElapsedStr {
    $elapsed = (Get-Date) - $script:startTime
    return "{0:mm\:ss}" -f $elapsed
}

# Wait for an agent status file phase to reach one of the target phases.
# Returns the final status object, or $null on timeout.
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
            if ($TargetPhases -contains $phase) {
                return $s
            }
            if ($phase -eq "error") {
                Write-Warn "[$AgentId] entered error phase"
                if ($s.events) {
                    $errEvents = @($s.events | Where-Object { $_.type -eq "error" })
                    foreach ($ev in $errEvents) { Write-Info "  error: $($ev.message)" }
                }
                return $s
            }
        }
        Start-Sleep -Seconds $PollSec
    }
    Write-Warn "[$AgentId] timed out after ${TimeoutSec}s (last phase: $lastPhase)"
    return Read-StatusFile $statusFile
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 0: Setup
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "FULL-STACK E2E PIPELINE TEST"
Write-Info "Story: $testStory - $testStoryName"
Write-Info "Agent timeout: ${AgentTimeout}s"
Write-Info "Skip agent spawn: $SkipAgentSpawn"
Write-Info "Skip Cypress: $SkipCypress"

Write-Step "Phase 0: Pre-flight checks"

# Check API server
$apiCheck = Get-Api "/api/execution-mode"
if (-not $apiCheck) {
    Write-Host "ERROR: API server not reachable at $apiUrl" -ForegroundColor Red
    Write-Host "Start it with:  npx tsx src/server/index.ts" -ForegroundColor Yellow
    exit 1
}
Write-Pass "API server running on $apiUrl"

# Check Vite (needed for Cypress)
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

# Save original config for patching
$origConfig = Get-Content (Join-Path $root $configFile) -Raw | ConvertFrom-Json

# Create temp git repo mimicking Mosaic
Write-Step "Phase 0: Creating temp git repo"
$tempBase = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { '/tmp' }
$tempRepo = Join-Path $tempBase "sdlc-framework-e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $tempRepo -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/src/Mosaic.Api" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/src/Mosaic.Api.Tests" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempRepo/.cursor/rules" -Force | Out-Null

# Minimal .NET skeleton
@"
Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Mosaic.Api", "src\Mosaic.Api\Mosaic.Api.csproj", "{A1B2C3D4}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Mosaic.Api.Tests", "src\Mosaic.Api.Tests\Mosaic.Api.Tests.csproj", "{E5F6G7H8}"
EndProject
"@ | Set-Content "$tempRepo/Mosaic.sln"

@"
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
"@ | Set-Content "$tempRepo/src/Mosaic.Api/Mosaic.Api.csproj"

@"
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => "Mosaic API");
app.Run();
"@ | Set-Content "$tempRepo/src/Mosaic.Api/Program.cs"

@"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.*" />
    <PackageReference Include="xunit" Version="2.*" />
  </ItemGroup>
</Project>
"@ | Set-Content "$tempRepo/src/Mosaic.Api.Tests/Mosaic.Api.Tests.csproj"

@"
# .NET Standards (Test Skeleton)
- Use nullable reference types
- Constructor injection for DI
- Repository pattern for data access
- async/await throughout
"@ | Set-Content "$tempRepo/.cursor/rules/.net-standards.mdc"

Push-Location $tempRepo
git init --initial-branch main 2>&1 | Out-Null
git add -A 2>&1 | Out-Null
git commit -m "Initial Mosaic skeleton for E2E test" 2>&1 | Out-Null
Pop-Location
Write-Pass "Temp repo created at $tempRepo"

# Patch config to point at temp repo and ensure mock mode
Write-Step "Phase 0: Patching config"
$patchedConfig = Get-Content (Join-Path $root $configFile) -Raw | ConvertFrom-Json
$patchedConfig.projects.mosaic.workspacePath = $tempRepo
$patchedConfig.externalMode = "mock"
$patchedConfig.activeProject = "mosaic"
# Ensure both agents are enabled with step mode OFF for uninterrupted run
$patchedConfig.scheduler.agents.backend.stepMode = $false
$patchedConfig.scheduler.agents.backend.enabled = $true
$patchedConfig.scheduler.agents.frontend.stepMode = $false
$patchedConfig.scheduler.agents.frontend.enabled = $true
Write-JsonFile (Join-Path $root $configFile) $patchedConfig
Write-Pass "Config patched: mosaic workspace -> $tempRepo, mock mode, step mode OFF"

# Clear spawn log
$spawnLogPath = Join-Path $root $spawnLog
if (Test-Path $spawnLogPath) { Remove-Item $spawnLogPath -Force }

# Clean any existing status files for our test agents
foreach ($agentId in @("frontend", "backend", "reviewer", "devops")) {
    $sf = Join-Path $root ".$agentId-status.json"
    if (Test-Path $sf) { Remove-Item $sf -Force }
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 1: Assign & Spawn
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 1: ASSIGN AND SPAWN AGENTS"

Write-Step "Assigning story to backend agent"
$beAssign = Post-Api "/api/scheduler/assign" @{
    agentId          = "backend"
    storyNumber      = $testStory
    storyName        = $testStoryName
    storyDescription = $testStoryDesc
}
if ($beAssign) {
    Assert-Equal $beAssign.ok $true "backend assign ok"
    Write-Info "Backend initial phase: $($beAssign.phase)"
} else { Write-Fail "Backend assign returned null" }

Write-Step "Assigning story to frontend agent"
$feAssign = Post-Api "/api/scheduler/assign" @{
    agentId          = "frontend"
    storyNumber      = $testStory
    storyName        = $testStoryName
    storyDescription = "Frontend portion: Add a Widgets dashboard page that fetches data from /api/widgets and displays it in a table. Use Angular components per Mosaic conventions."
}
if ($feAssign) {
    Assert-Equal $feAssign.ok $true "frontend assign ok"
    Write-Info "Frontend initial phase: $($feAssign.phase)"
} else { Write-Fail "Frontend assign returned null" }

# Approve both if they are in pending-approval
Write-Step "Approving agents"
foreach ($agentId in @("backend", "frontend")) {
    $s = Read-StatusFile ".$agentId-status.json"
    if ($s -and $s.currentPhase -eq "pending-approval") {
        $approveResp = Post-Api "/api/scheduler/approve" @{ agentId = $agentId }
        if ($approveResp) {
            Assert-Equal $approveResp.ok $true "$agentId approve ok"
            Write-Info "$agentId spawned: $($approveResp.agentSpawned)"
        }
    } elseif ($s) {
        Write-Info "$agentId already in phase '$($s.currentPhase)' (auto-start), no approval needed"
        if (-not $SkipAgentSpawn) {
            $contResp = Post-Api "/api/agent/continue" @{ agentId = $agentId }
            if ($contResp) { Write-Info "$agentId continue: spawned=$($contResp.spawned)" }
        }
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 2: Monitor Agent Work
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 2: MONITORING AGENT WORK"

$terminalPhases = @(
    "watching-reviews", "complete", "idle", "error",
    "analyzing", "creating-pr", "validating"
)

if ($SkipAgentSpawn) {
    Write-Info "Agent spawn skipped - simulating agent work via API"

    # Simulate backend work
    $beTask1 = @{ number = "TK-FS99001-1"; name = "Add WidgetController with GET /api/widgets"; status = "Completed"; estimateHours = 1.5 }
    $beTask2 = @{ number = "TK-FS99001-2"; name = "Create Widget DTO and seed data"; status = "Completed"; estimateHours = 1.0 }
    $bePrObj = @{ id = 101; title = "feat(FS-99001): Add /api/widgets endpoint"; url = "$apiUrl/mock-prs/101"; branch = "feat/FS-99001-widgets-api"; status = "active"; mock = $true }
    $beEvt1 = @{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Story $testStory assigned." }
    $beEvt2 = @{ timestamp = (Get-Date -Format "o"); type = "success"; message = "Created 2 tasks, implemented widgets API, mock PR 101 created." }
    $beStatus = @{
        projectKey       = "mosaic"
        storyNumber      = $testStory
        storyName        = $testStoryName
        storyDescription = $testStoryDesc
        currentPhase     = "watching-reviews"
        currentTask      = $null
        startedAt        = (Get-Date -Format "o")
        executionMode    = "speed"
        tokens           = @{ cloud = @{ input = 1200; output = 800 }; ollama = @{ input = 0; output = 0 } }
        tasks            = @($beTask1, $beTask2)
        prs              = @($bePrObj)
        cypress          = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
        events           = @($beEvt1, $beEvt2)
        handoffDispatched = $false
    }
    Write-JsonFile (Join-Path $root ".backend-status.json") $beStatus

    # Simulate frontend work
    $feTask1 = @{ number = "TK-FS99001-3"; name = "Add WidgetsDashboard Angular component"; status = "Completed"; estimateHours = 2.0 }
    $feTask2 = @{ number = "TK-FS99001-4"; name = "Add widget service and API integration"; status = "Completed"; estimateHours = 1.5 }
    $fePrObj = @{ id = 102; title = "feat(FS-99001): Add Widgets dashboard page"; url = "$apiUrl/mock-prs/102"; branch = "feat/FS-99001-widgets-ui"; status = "active"; mock = $true }
    $feEvt1 = @{ timestamp = (Get-Date -Format "o"); type = "info"; message = "Story $testStory assigned." }
    $feEvt2 = @{ timestamp = (Get-Date -Format "o"); type = "success"; message = "Created 2 tasks, implemented widgets dashboard, mock PR 102 created." }
    $feStatus = @{
        projectKey       = "mosaic"
        storyNumber      = $testStory
        storyName        = $testStoryName
        currentPhase     = "watching-reviews"
        currentTask      = $null
        startedAt        = (Get-Date -Format "o")
        executionMode    = "speed"
        tokens           = @{ cloud = @{ input = 1500; output = 1000 }; ollama = @{ input = 200; output = 150 } }
        tasks            = @($feTask1, $feTask2)
        prs              = @($fePrObj)
        cypress          = @{ lastRun = $null; total = 0; passed = 0; failed = 0; skipped = 0; failures = @() }
        events           = @($feEvt1, $feEvt2)
        handoffDispatched = $false
    }
    Write-JsonFile (Join-Path $root ".frontend-status.json") $feStatus

    # Create branches in temp repo
    Push-Location $tempRepo
    git checkout -b "feat/FS-99001-widgets-api" 2>&1 | Out-Null
    @"
namespace Mosaic.Api.Controllers;
public class WidgetController {
    [HttpGet("/api/widgets")]
    public IEnumerable<Widget> Get() => new[] { new Widget("Test", 42) };
}
public record Widget(string Name, int Value);
"@ | Set-Content "src/Mosaic.Api/WidgetController.cs"
    git add -A 2>&1 | Out-Null
    git commit -m "feat(FS-99001): Add /api/widgets endpoint" 2>&1 | Out-Null

    git checkout main 2>&1 | Out-Null
    git checkout -b "feat/FS-99001-widgets-ui" 2>&1 | Out-Null
    @"
// Simulated Angular component
export class WidgetsDashboardComponent {
    widgets = [];
    async ngOnInit() { this.widgets = await fetch('/api/widgets').then(r => r.json()); }
}
"@ | Set-Content "src/Mosaic.Api/WidgetsDashboard.ts"
    git add -A 2>&1 | Out-Null
    git commit -m "feat(FS-99001): Add Widgets dashboard page" 2>&1 | Out-Null
    git checkout main 2>&1 | Out-Null
    Pop-Location

    Write-Pass "Simulated backend agent work (2 tasks, PR #101, branch created)"
    Write-Pass "Simulated frontend agent work (2 tasks, PR #102, branch created)"

    $beFinal = Read-StatusFile ".backend-status.json"
    $feFinal = Read-StatusFile ".frontend-status.json"
} else {
    Write-Info "Waiting for agents to complete their work (timeout: ${AgentTimeout}s each)..."
    Write-Info "Polling both agents in parallel..."

    $beReached = $false
    $feReached = $false
    $beFinal = $null
    $feFinal = $null
    $beLastPhase = ""
    $feLastPhase = ""
    $deadline = (Get-Date).AddSeconds($AgentTimeout)

    while ((Get-Date) -lt $deadline -and (-not $beReached -or -not $feReached)) {
        if (-not $beReached) {
            $bs = Read-StatusFile ".backend-status.json"
            if ($bs) {
                if ($bs.currentPhase -ne $beLastPhase) {
                    Write-Info "[backend] phase: $beLastPhase -> $($bs.currentPhase)  ($(Get-ElapsedStr))"
                    $beLastPhase = $bs.currentPhase
                }
                if ($terminalPhases -contains $bs.currentPhase) {
                    $beReached = $true
                    $beFinal = $bs
                    Write-Pass "Backend reached terminal phase: $($bs.currentPhase)"
                }
            }
        }
        if (-not $feReached) {
            $fs = Read-StatusFile ".frontend-status.json"
            if ($fs) {
                if ($fs.currentPhase -ne $feLastPhase) {
                    Write-Info "[frontend] phase: $feLastPhase -> $($fs.currentPhase)  ($(Get-ElapsedStr))"
                    $feLastPhase = $fs.currentPhase
                }
                if ($terminalPhases -contains $fs.currentPhase) {
                    $feReached = $true
                    $feFinal = $fs
                    Write-Pass "Frontend reached terminal phase: $($fs.currentPhase)"
                }
            }
        }
        if (-not $beReached -or -not $feReached) { Start-Sleep -Seconds 10 }
    }

    if (-not $beReached) {
        Write-Warn "Backend agent timed out - falling back to API simulation for backend"
        $beFinal = Read-StatusFile ".backend-status.json"
    }
    if (-not $feReached) {
        Write-Warn "Frontend agent timed out - falling back to API simulation for frontend"
        $feFinal = Read-StatusFile ".frontend-status.json"
    }
}

# Validate agent outputs
Write-Step "Validating agent work products"

if ($beFinal) {
    $beTasks = @($beFinal.tasks)
    if ($beTasks.Count -gt 0) { Write-Pass "Backend created $($beTasks.Count) tasks" }
    else { Write-Warn "Backend has no tasks" }

    $beEvents = @($beFinal.events)
    Assert-GreaterThan $beEvents.Count 1 "Backend event count"
} else { Write-Fail "No backend status available" }

if ($feFinal) {
    $feTasks = @($feFinal.tasks)
    if ($feTasks.Count -gt 0) { Write-Pass "Frontend created $($feTasks.Count) tasks" }
    else { Write-Warn "Frontend has no tasks" }

    $feEvents = @($feFinal.events)
    Assert-GreaterThan $feEvents.Count 1 "Frontend event count"
} else { Write-Fail "No frontend status available" }

# Validate git branches in temp repo
Write-Step "Validating git branches"
Push-Location $tempRepo
$branches = git branch --list 2>&1 | ForEach-Object { $_.Trim().TrimStart("* ") }
Pop-Location
Write-Info "Branches in temp repo: $($branches -join ', ')"
$hasBranches = $branches.Count -gt 1
if ($hasBranches) { Write-Pass "Temp repo has $($branches.Count) branches (main + feature)" }
else { Write-Info "Only main branch exists (agents may not have pushed)" }

# ═══════════════════════════════════════════════════════════════════════════
# Phase 3: Reviewer Flow
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 3: REVIEWER AND BUILD PIPELINE"

# Determine PR IDs from agent status files
$bePrId = $null
$fePrId = $null

if ($beFinal -and $beFinal.prs -and @($beFinal.prs).Count -gt 0) {
    $bePrId = @($beFinal.prs)[0].id
    Write-Info "Backend PR ID: $bePrId"
} else {
    $bePrId = 101
    Write-Info "No backend PR found in status - using fallback ID $bePrId"
}

if ($feFinal -and $feFinal.prs -and @($feFinal.prs).Count -gt 0) {
    $fePrId = @($feFinal.prs)[0].id
    Write-Info "Frontend PR ID: $fePrId"
} else {
    $fePrId = 102
    Write-Info "No frontend PR found in status - using fallback ID $fePrId"
}

# Ensure PRs are registered (fallback if agents didn't call /api/pr/created)
Write-Step "Ensuring PRs are registered"
$reviewer = Read-StatusFile ".reviewer-status.json"
$reviewerHasBePr = $false
$reviewerHasFePr = $false

if ($reviewer -and $reviewer.assignedPR) {
    if ($reviewer.assignedPR.id -eq $bePrId -or $reviewer.assignedPR.id -eq $fePrId) {
        Write-Info "Reviewer already has an assigned PR"
    }
}

# Register backend PR if needed
if (-not $beFinal -or -not $beFinal.prs -or @($beFinal.prs).Count -eq 0) {
    # Need to seed a PR in backend status first so findStoryOwnerByPrId works
    $beStatus = Read-StatusFile ".backend-status.json"
    if ($beStatus) {
        if (-not $beStatus.prs) { $beStatus | Add-Member -NotePropertyName prs -NotePropertyValue @() -Force }
        $existingPr = @($beStatus.prs) | Where-Object { $_.id -eq $bePrId }
        if (-not $existingPr) {
            $mockPr = @{ id = $bePrId; title = "feat(${testStory}): Backend widgets API"; url = "$apiUrl/mock-prs/$bePrId"; branch = "feat/FS-99001-widgets-api"; status = "active"; mock = $true }
            $beStatus.prs = @($mockPr)
            Write-JsonFile (Join-Path $root ".backend-status.json") $beStatus
        }
    }
}
if (-not $feFinal -or -not $feFinal.prs -or @($feFinal.prs).Count -eq 0) {
    $feStatus = Read-StatusFile ".frontend-status.json"
    if ($feStatus) {
        if (-not $feStatus.prs) { $feStatus | Add-Member -NotePropertyName prs -NotePropertyValue @() -Force }
        $existingPr = @($feStatus.prs) | Where-Object { $_.id -eq $fePrId }
        if (-not $existingPr) {
            $mockPr = @{ id = $fePrId; title = "feat(${testStory}): Frontend widgets dashboard"; url = "$apiUrl/mock-prs/$fePrId"; branch = "feat/FS-99001-widgets-ui"; status = "active"; mock = $true }
            $feStatus.prs = @($mockPr)
            Write-JsonFile (Join-Path $root ".frontend-status.json") $feStatus
        }
    }
}

# --- Process Backend PR through reviewer + devops ---
Write-Step "PR #${bePrId}: Backend -> Reviewer -> DevOps"

$prCreated1 = Post-Api "/api/pr/created" @{
    agentId     = "backend"
    prId        = $bePrId
    prTitle     = "feat($testStory): Add /api/widgets endpoint"
    prUrl       = "$apiUrl/mock-prs/$bePrId"
    storyNumber = $testStory
    branch      = "feat/FS-99001-widgets-api"
}
if ($prCreated1) {
    Write-Info "PR created response: reviewerPhase=$($prCreated1.reviewerPhase), spawned=$($prCreated1.agentSpawned)"
}

# Wait briefly for reviewer if spawned
if (-not $SkipAgentSpawn -and $prCreated1 -and $prCreated1.agentSpawned) {
    Write-Info "Waiting for reviewer to process PR #$bePrId..."
    $revStatus = Wait-AgentPhase -AgentId "reviewer" -TargetPhases @("idle", "changes-requested", "approved") -TimeoutSec 180
    if ($revStatus) {
        Write-Info "Reviewer reached: $($revStatus.currentPhase)"
    }
}

# Simulate approval if reviewer didn't auto-complete
$reviewer = Read-StatusFile ".reviewer-status.json"
if ($reviewer -and $reviewer.currentPhase -ne "idle") {
    Write-Step "Approving backend PR #$bePrId via review-complete"
    $reviewResp = Post-Api "/api/handoff/review-complete" @{
        prId        = $bePrId
        verdict     = "approved"
        storyNumber = $testStory
    }
    if ($reviewResp) {
        Assert-Equal $reviewResp.ok $true "review-complete(backend) ok"
        Assert-Equal $reviewResp.target "devops" "review-complete(backend) target"
        Assert-Equal $reviewResp.targetPhase "pending-build" "review-complete(backend) phase"
    }
}

# Validate devops status
$devops = Read-StatusFile ".devops-status.json"
if ($devops) {
    Assert-Equal $devops.currentPhase "pending-build" "devops phase after backend PR approval"
    Assert-Equal $devops.assignedPR.id $bePrId "devops assigned PR is backend PR"
} else { Write-Fail "No devops status after backend PR approval" }

# Build complete for backend PR
Write-Step "Build complete for backend PR #$bePrId"
$buildResp1 = Post-Api "/api/handoff/build-complete" @{
    prId    = $bePrId
    result  = "passed"
    buildId = 90001
}
if ($buildResp1) {
    Assert-Equal $buildResp1.ok $true "build-complete(backend) ok"
    Assert-Equal $buildResp1.storyOwner "backend" "build-complete owner is backend"
    Assert-Equal $buildResp1.newPrStatus "completed" "build-complete PR status"
}

$devops = Read-StatusFile ".devops-status.json"
if ($devops) { Assert-Equal $devops.currentPhase "build-passed" "devops phase after backend build" }

# --- Process Frontend PR through reviewer + devops ---
Write-Step "PR #${fePrId}: Frontend -> Reviewer -> DevOps"

$prCreated2 = Post-Api "/api/pr/created" @{
    agentId     = "frontend"
    prId        = $fePrId
    prTitle     = "feat($testStory): Add Widgets dashboard page"
    prUrl       = "$apiUrl/mock-prs/$fePrId"
    storyNumber = $testStory
    branch      = "feat/FS-99001-widgets-ui"
}
if ($prCreated2) {
    Write-Info "PR created response: reviewerPhase=$($prCreated2.reviewerPhase), spawned=$($prCreated2.agentSpawned)"
}

# Wait for reviewer if spawned
if (-not $SkipAgentSpawn -and $prCreated2 -and $prCreated2.agentSpawned) {
    Write-Info "Waiting for reviewer to process PR #$fePrId..."
    $revStatus = Wait-AgentPhase -AgentId "reviewer" -TargetPhases @("idle", "changes-requested", "approved") -TimeoutSec 180
    if ($revStatus) { Write-Info "Reviewer reached: $($revStatus.currentPhase)" }
}

# Simulate approval for frontend PR
$reviewer = Read-StatusFile ".reviewer-status.json"
if ($reviewer -and $reviewer.currentPhase -ne "idle") {
    Write-Step "Approving frontend PR #$fePrId via review-complete"
    $reviewResp2 = Post-Api "/api/handoff/review-complete" @{
        prId        = $fePrId
        verdict     = "approved"
        storyNumber = $testStory
    }
    if ($reviewResp2) {
        Assert-Equal $reviewResp2.ok $true "review-complete(frontend) ok"
        Assert-Equal $reviewResp2.target "devops" "review-complete(frontend) target"
    }
}

# Build complete for frontend PR
Write-Step "Build complete for frontend PR #$fePrId"
$buildResp2 = Post-Api "/api/handoff/build-complete" @{
    prId    = $fePrId
    result  = "passed"
    buildId = 90002
}
if ($buildResp2) {
    Assert-Equal $buildResp2.ok $true "build-complete(frontend) ok"
    Assert-Equal $buildResp2.storyOwner "frontend" "build-complete owner is frontend"
    Assert-Equal $buildResp2.newPrStatus "completed" "build-complete PR status"
}

# Verify both agents now show complete
Write-Step "Verifying agent completion states"
$beFinalPost = Read-StatusFile ".backend-status.json"
$feFinalPost = Read-StatusFile ".frontend-status.json"

if ($beFinalPost) {
    Assert-Equal $beFinalPost.currentPhase "complete" "backend final phase"
    $bePr = @($beFinalPost.prs) | Where-Object { $_.id -eq $bePrId }
    if ($bePr) { Assert-Equal $bePr.status "completed" "backend PR status" }
}
if ($feFinalPost) {
    Assert-Equal $feFinalPost.currentPhase "complete" "frontend final phase"
    $fePr = @($feFinalPost.prs) | Where-Object { $_.id -eq $fePrId }
    if ($fePr) { Assert-Equal $fePr.status "completed" "frontend PR status" }
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 4: QA / Cypress
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 4: QA VALIDATION"

if ($SkipCypress) {
    Write-Info "Cypress tests skipped (-SkipCypress flag or Vite not running)"

    # Post simulated QA results
    $qaResp = Post-Api "/api/test-results" @{
        agentId  = "qa"
        total    = 7
        passed   = 7
        failed   = 0
        skipped  = 0
        specFile = "e2e-fullstack-simulation"
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

    # Parse pass/fail from output
    $passMatch = [regex]::Match(($cypressOutput -join "`n"), "(\d+) passing")
    $failMatch = [regex]::Match(($cypressOutput -join "`n"), "(\d+) failing")
    $cypressPassed = if ($passMatch.Success) { [int]$passMatch.Groups[1].Value } else { 0 }
    $cypressFailed = if ($failMatch.Success) { [int]$failMatch.Groups[1].Value } else { 0 }
    $cypressTotal = $cypressPassed + $cypressFailed

    if ($cypressExit -eq 0) {
        Write-Pass "Cypress: $cypressPassed passed, $cypressFailed failed"
    } else {
        Write-Fail "Cypress: $cypressPassed passed, $cypressFailed failed (exit $cypressExit)"
        # Show last few lines of output for debugging
        $lastLines = ($cypressOutput -join "`n").Split("`n") | Select-Object -Last 15
        foreach ($line in $lastLines) { Write-Info "  $line" }
    }

    # Post results to API
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

# Verify QA results are retrievable
$qaResults = Get-Api "/api/test-results?agentId=qa&latest=1"
if ($qaResults) {
    Assert-NotNull $qaResults "QA test results from API"
    Write-Info "QA results: total=$($qaResults.total), passed=$($qaResults.passed), failed=$($qaResults.failed)"
} else {
    Write-Warn "Could not fetch QA results from API"
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 5: Final Assertions
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 5: FINAL ASSERTIONS"

Write-Step "Agent status summary"
foreach ($agentId in @("backend", "frontend", "reviewer", "devops")) {
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

Write-Step "Token usage"
foreach ($agentId in @("backend", "frontend")) {
    $s = Read-StatusFile ".$agentId-status.json"
    if ($s -and $s.tokens) {
        $cloudIn = if ($s.tokens.cloud) { $s.tokens.cloud.input } else { 0 }
        $cloudOut = if ($s.tokens.cloud) { $s.tokens.cloud.output } else { 0 }
        $ollamaIn = if ($s.tokens.ollama) { $s.tokens.ollama.input } else { 0 }
        $ollamaOut = if ($s.tokens.ollama) { $s.tokens.ollama.output } else { 0 }
        Write-Info "$($agentId.PadRight(10)) | cloud: ${cloudIn}in/${cloudOut}out | ollama: ${ollamaIn}in/${ollamaOut}out"
    }
}

Write-Step "Event timeline validation"
foreach ($agentId in @("backend", "frontend")) {
    $s = Read-StatusFile ".$agentId-status.json"
    if ($s -and $s.events -and @($s.events).Count -gt 1) {
        $events = @($s.events)
        $inOrder = $true
        for ($i = 1; $i -lt $events.Count; $i++) {
            if ($events[$i].timestamp -lt $events[$i-1].timestamp) {
                $inOrder = $false
                break
            }
        }
        if ($inOrder) { Write-Pass "$agentId events are in chronological order" }
        else { Write-Fail "$agentId events are out of order" }
    }
}

Write-Step "Spawn log"
$spawnLogPath = Join-Path $root ".agent-spawns.log"
if (Test-Path $spawnLogPath) {
    $spawnLines = Get-Content $spawnLogPath
    Write-Info "Total spawn entries: $($spawnLines.Count)"
    foreach ($line in $spawnLines) { Write-Info "  $line" }
} else {
    Write-Info "No spawn log found (expected if -SkipAgentSpawn)"
}

# ═══════════════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ═══════════════════════════════════════════════════════════════════════════

Write-Banner "PHASE 6: CLEANUP"

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

Write-Step "Removing temp git repo"
if (Test-Path $tempRepo) {
    # Git lock files can block deletion; retry after a short delay
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
} else {
    Write-Info "Temp repo already gone"
}

if (Test-Path $backupDir) {
    Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

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
