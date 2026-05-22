<#
.SYNOPSIS
  Autonomous agent driver loop. Runs agent -p --force repeatedly until
  the agent's status file reaches a terminal phase.

.PARAMETER AgentId
  Agent name (frontend, backend, qa, ux, reviewer, devops).

.PARAMETER InitialPrompt
  The first prompt to send to the agent.

.PARAMETER WorkspaceDir
  Path to the SDLC Framework workspace (defaults to repo root).

.PARAMETER MaxTurns
  Safety limit on iterations (default 30).

.EXAMPLE
  .\bin\run-agent.ps1 -AgentId frontend -InitialPrompt "Read story B-16990..."
#>
param(
    [Parameter(Mandatory)][string]$AgentId,
    [string]$InitialPrompt = "",
    [string]$PromptFile = "",
    [string]$WorkspaceDir = (Split-Path -Parent $PSScriptRoot),
    [int]$MaxTurns = 30,
    [string]$Model = "",
    [switch]$KeepOpen
)

if ($PromptFile -and (Test-Path $PromptFile)) {
    $InitialPrompt = Get-Content $PromptFile -Raw -Encoding UTF8
} elseif (-not $InitialPrompt) {
    Write-Host "[run-agent] ERROR: Must provide either -InitialPrompt or -PromptFile." -ForegroundColor Red
    exit 1
}

$SkillDirName = $AgentId

$ErrorActionPreference = "Continue"

# Allow Ctrl-C to terminate the driver cleanly between turns (does not forcibly kill the in-flight agent process).
[Console]::TreatControlCAsInput = $false
$stopping = $false
try {
    $cancelHandler = [System.ConsoleCancelEventHandler] {
        param($sender, [System.ConsoleCancelEventArgs]$e)
        $e.Cancel = $true
        $script:stopping = $true
        Stop-FileWatcher
        Write-Host ""
        Write-Host "[run-agent] Interrupt received - finishing this step, then exiting." -ForegroundColor Yellow
    }
    [void][Console]::add_CancelKeyPress($cancelHandler)
} catch {
    Register-EngineEvent PowerShell.Exiting -Action { $script:stopping = $true } -ErrorAction SilentlyContinue | Out-Null
}

# Ensure agent CLI is on PATH
$shimDir = "$env:LOCALAPPDATA\cursor-agent\bin"
if (Test-Path $shimDir) {
    $env:PATH = "$shimDir;$env:PATH"
}

$agentCmd = Get-Command agent -ErrorAction SilentlyContinue
if (-not $agentCmd) {
    Write-Host "[run-agent] ERROR: agent CLI not found. Run bin/setup.ps1 first." -ForegroundColor Red
    exit 1
}

$statusFile = Join-Path $WorkspaceDir ".$AgentId-status.json"
$logDir = Join-Path $WorkspaceDir ".agent-output"
$logFile = Join-Path $logDir "$AgentId-driver.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$baseTerminalPhases = @(
    "complete",
    "idle",
    "watching-reviews",
    "pending-approval"
)

$configPath = Join-Path $WorkspaceDir ".sdlc-framework.config.json"
$defaultStepModePhases = @("analyzing", "validating")
$agentStepModePhases = @{
    frontend = @(
        "analyzing",
        "generating-code",
        "validating",
        "creating-pr",
        "watching-reviews",
        "addressing-feedback",
        "running-cypress"
    )
    backend = @(
        "analyzing",
        "generating-code",
        "validating",
        "creating-pr",
        "watching-reviews",
        "addressing-feedback",
        "running-tests"
    )
    devops = @("analyzing", "validating", "pending-build", "monitoring-build", "build-passed", "build-failed")
    reviewer = @("reviewing", "commenting", "approved", "changes-requested")
    ux = @("researching", "designing", "spec-ready", "collaborating")
}

# The agent CLI always runs in the SDLC Framework workspace (status files, skills, mock server live here).
# The target project's workspacePath is passed as context in the prompt so the agent knows where
# the target codebase lives, but --workspace must stay as SDLC Framework root.
$agentWorkspace = $WorkspaceDir
$targetCodebase = $null
if (Test-Path $configPath) {
    try {
        $projCfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($projCfg.projects) {
            $activeKey = if ($projCfg.activeProject) { $projCfg.activeProject } else { ($projCfg.projects.PSObject.Properties | Select-Object -First 1).Name }
            $activeProfile = $projCfg.projects.$activeKey
            if ($activeProfile -and $activeProfile.workspacePath -and (Test-Path $activeProfile.workspacePath)) {
                $targetCodebase = $activeProfile.workspacePath
            }
        }
    } catch { <# fall through #> }
}

function Get-StepModeEnabled {
    if (Test-Path $configPath) {
        try {
            $mConfig = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($mConfig.scheduler.globalStepMode -eq $true) { return $true }
            $agentCfg = $mConfig.scheduler.agents.$AgentId
            if ($agentCfg -and $agentCfg.stepMode -eq $true) { return $true }
        } catch { <# fall through #> }
    }
    return $false
}

function Get-ExternalMode {
    if ($env:SDLC_EXTERNAL_MODE -in @("mock", "live")) { return $env:SDLC_EXTERNAL_MODE }
    if (Test-Path $configPath) {
        try {
            $mConfig = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($mConfig.externalMode -eq "mock" -or $mConfig.integrations.mode -eq "mock") { return "mock" }
        } catch { <# fall through #> }
    }
    return "live"
}

function Get-MockModeSafetyDirective {
    if ((Get-ExternalMode) -ne "mock") { return "" }
    return @"
MOCK EXTERNAL MODE IS ACTIVE.
Hard safety rule: do not call Azure DevOps MCP tools, do not run git push, and do not create, update, approve, queue, or complete real Azure DevOps PRs or pipelines.
Use local git branches and commits only. For Agility MCP calls, use the local mock base URL http://localhost:3001/mock-v1 with AGILITY_API_KEY=mock-token.
When you reach PR/build/review phases, simulate them through SDLC Framework mock status/API state instead of contacting Azure DevOps.
"@
}

function Install-MockModeCommandGuards {
    $mockBin = Join-Path $WorkspaceDir ".sdlc-framework\mock-bin"
    if (-not (Test-Path $mockBin)) { New-Item -ItemType Directory -Path $mockBin -Force | Out-Null }

    $gitShim = Join-Path $mockBin "git.cmd"
    if (-not (Test-Path $gitShim)) {
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        if ($gitCmd) {
            $realGit = $gitCmd.Source
            @"
@echo off
if /I "%~1"=="push" (
  echo [sdlc-framework mock mode] git push is blocked. Use local commits and mock PR state only. 1>&2
  exit /b 88
)
"$realGit" %*
"@ | Set-Content -Path $gitShim -Encoding ASCII
        }
    }

    $azShim = Join-Path $mockBin "az.cmd"
    if (-not (Test-Path $azShim)) {
        @"
@echo off
echo [sdlc-framework mock mode] Azure CLI is blocked. Use SDLC Framework mock API/state instead. 1>&2
exit /b 88
"@ | Set-Content -Path $azShim -Encoding ASCII
    }

    if (-not (($env:PATH -split ';') -contains $mockBin)) {
        $env:PATH = "$mockBin;$env:PATH"
    }
    $env:SDLC_FRAMEWORK_MOCK_MODE = "1"
    Write-Log "Mock command guards installed at $mockBin (blocks git push and az)" "Magenta"
}

function Get-StepModePhases {
    if (Test-Path $configPath) {
        try {
            $mConfig = Get-Content $configPath -Raw | ConvertFrom-Json
            $configured = $mConfig.scheduler.agents.$AgentId.stepModePhases
            if ($configured -and $configured.Count -gt 0) {
                return @($configured | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 } | Select-Object -Unique)
            }
        } catch { <# fall through #> }
    }
    if ($agentStepModePhases.ContainsKey($AgentId)) {
        return $agentStepModePhases[$AgentId]
    }
    return $defaultStepModePhases
}

function Get-CurrentBranch([string]$Path) {
    try {
        $b = & git -C $Path rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $b) { return $b.Trim() }
    } catch { }
    return $null
}

# ── File-change watcher ───────────────────────────────────────────────────────

$script:watcherId  = $null
$script:fileWatcher = $null
# Patterns to suppress — log/status noise and build artifacts
$script:watchNoise = '(?i)(\\\.git\\|\\node_modules\\|\\dist\\|\\build\\|\.log$|\.tmp$|' +
                     '\-status\.json$|\.agent-output|mock-bin|\.agent-spawns\.log)'

# Returns the agent's worktree path when it exists, $null otherwise.
# Path is deterministic: <targetCodebase>/.claude/worktrees/<agentId>-<storyNumber>
function Get-AgentWorktreePath {
    $s = Get-AgentStatus
    $num = if ($s) { $s.storyNumber } else { $null }
    if (-not $num -and $s -and $s.assignedPR) { $num = $s.assignedPR.storyNumber }
    if (-not $num) { return $null }
    $base = if ($targetCodebase) { $targetCodebase } else { $agentWorkspace }
    $wt = Join-Path $base ".claude\worktrees\$AgentId-$num"
    if (Test-Path $wt) { return $wt }
    return $null
}

function Start-FileWatcher([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    $id = "SDLC FrameworkWatch_${AgentId}_$(Get-Random)"
    $w  = New-Object System.IO.FileSystemWatcher $Path
    $w.IncludeSubdirectories = $true
    $w.NotifyFilter = [IO.NotifyFilters]::FileName -bor
                      [IO.NotifyFilters]::LastWrite  -bor
                      [IO.NotifyFilters]::DirectoryName
    $w.EnableRaisingEvents = $true
    Register-ObjectEvent $w Changed -SourceIdentifier "$id.chg" | Out-Null
    Register-ObjectEvent $w Created -SourceIdentifier "$id.cre" | Out-Null
    Register-ObjectEvent $w Deleted -SourceIdentifier "$id.del" | Out-Null
    Register-ObjectEvent $w Renamed -SourceIdentifier "$id.ren" | Out-Null
    $script:watcherId   = $id
    $script:fileWatcher = $w
}

function Stop-FileWatcher {
    if ($script:fileWatcher) {
        $script:fileWatcher.EnableRaisingEvents = $false
        $script:fileWatcher.Dispose()
        $script:fileWatcher = $null
    }
    if ($script:watcherId) {
        Unregister-Event -SourceIdentifier "$($script:watcherId)*" -ErrorAction SilentlyContinue
        Remove-Event    -SourceIdentifier "$($script:watcherId)*" -ErrorAction SilentlyContinue
        $script:watcherId = $null
    }
}

# Drain queued file-system events and print them.
# $GitRoot     — repo root (watcher base); used for paths not inside the worktree
# $ShowDiff    — when $true, print a compact inline diff per changed file
# $WorktreePath — when set, paths inside it are displayed/diffed relative to the worktree
function Show-FileEvents([string]$GitRoot, [bool]$ShowDiff = $false, [string]$WorktreePath = '') {
    if (-not $script:watcherId) { return }
    $evts = Get-Event -SourceIdentifier "$($script:watcherId)*" -ErrorAction SilentlyContinue
    if (-not $evts) { return }

    $seen = @{}
    foreach ($evt in $evts) {
        $fp = $evt.SourceEventArgs.FullPath
        Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue
        if ($fp -match $script:watchNoise) { continue }
        if ($seen[$fp]) { continue }
        $seen[$fp] = $true

        # Display path relative to worktree when the file lives there, otherwise repo root
        $inWorktree = $WorktreePath -and $fp.StartsWith($WorktreePath)
        $displayBase = if ($inWorktree) { $WorktreePath } else { $GitRoot }
        $rel = if ($fp.StartsWith($displayBase)) {
            $fp.Substring($displayBase.Length).TrimStart('\','/')
        } else { $fp }

        $ct    = $evt.SourceEventArgs.ChangeType.ToString()
        $color = switch ($ct) { 'Created' { 'Green' } 'Deleted' { 'Red' } default { 'DarkYellow' } }
        Write-Host "  >> [file:$ct] $rel" -ForegroundColor $color

        if ($ShowDiff -and $ct -ne 'Deleted') {
            $diffRoot = if ($inWorktree) { $WorktreePath } else { $GitRoot }
            try {
                $diff = & git -C $diffRoot diff --unified=3 -- $fp 2>$null
                if (-not $diff) {
                    if (Test-Path $fp) {
                        $preview = Get-Content $fp -TotalCount 15 -ErrorAction SilentlyContinue
                        if ($preview) {
                            Write-Host "     (new file)" -ForegroundColor DarkGray
                            $preview | ForEach-Object { Write-Host "     + $_" -ForegroundColor Green }
                        }
                    }
                } else {
                    ($diff -split "`n") | Select-Object -First 20 | ForEach-Object {
                        $dc = if ($_ -match '^\+[^+]') { 'Green' }
                             elseif ($_ -match '^-[^-]') { 'Red' }
                             elseif ($_ -match '^@@')     { 'Cyan' }
                             else { 'DarkGray' }
                        Write-Host "     $_" -ForegroundColor $dc
                    }
                }
            } catch { }
        }
    }
}

# Show git diff --stat for the working tree after a turn completes.
# Prefers the worktree directory when the agent has one.
function Show-TurnDiffStat([string]$GitRoot, [string]$WorktreePath = '') {
    $root = if ($WorktreePath -and (Test-Path $WorktreePath)) { $WorktreePath } else { $GitRoot }
    try {
        $stat = & git -C $root diff --stat 2>$null
        if ($LASTEXITCODE -eq 0 -and $stat) {
            $label = if ($WorktreePath -and (Test-Path $WorktreePath)) {
                $wt = Split-Path $WorktreePath -Leaf
                "  Changes this turn  [$wt]:"
            } else { "  Changes this turn:" }
            Write-Host ""
            Write-Host $label -ForegroundColor DarkYellow
            ($stat -split "`n") | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
        }
    } catch { }
}

function Get-AgentStatus {
    if (Test-Path $statusFile) {
        try {
            return Get-Content $statusFile -Raw | ConvertFrom-Json
        } catch { return $null }
    }
    return $null
}

function Write-Log($msg, [string]$Color = "Gray") {
    $line = "$(Get-Date -Format 'o') | $msg"
    Write-Host "[run-agent] $msg" -ForegroundColor $Color
    try { Add-Content -Path $logFile -Value $line -ErrorAction Stop } catch { }
}

function Write-Banner($msg) {
    $border = "=" * 60
    Write-Host ""
    Write-Host $border -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor White
    Write-Host $border -ForegroundColor Cyan
    Write-Host ""
}

function Write-StatusSummary($status) {
    if (-not $status) { return }
    $lastEvent = if ($status.events -and $status.events.Count -gt 0) { $status.events[-1].message } else { "" }

    # ── Reviewer: PR-focused view ─────────────────────────────────────────────
    if ($AgentId -eq 'reviewer' -and $status.assignedPR) {
        $pr      = $status.assignedPR
        $phase   = if ($status.currentPhase) { $status.currentPhase } else { 'unknown' }
        $livePr  = if ($status.prs) { $status.prs | Where-Object { $_.id -eq $pr.id } | Select-Object -First 1 } else { $null }
        $approvals = if ($livePr -and $null -ne $livePr.approvals) { $livePr.approvals } else { 0 }
        $comments  = if ($livePr -and $null -ne $livePr.comments)  { $livePr.comments  } else { 0 }
        $verdict   = switch ($phase) {
            'approved'           { 'APPROVED' }
            'changes-requested'  { 'CHANGES REQUESTED' }
            'commenting'         { 'commenting' }
            'reviewing'          { 'reviewing' }
            default              { $phase }
        }
        $verdictColor = switch ($phase) {
            'approved'          { 'Green' }
            'changes-requested' { 'Red' }
            default             { 'DarkCyan' }
        }
        $titleShort = if ($pr.title.Length -gt 70) { $pr.title.Substring(0, 70) + '...' } else { $pr.title }
        Write-Host "  PR:      #$($pr.id) - $titleShort" -ForegroundColor Yellow
        Write-Host "  Branch:  $($pr.branch)" -ForegroundColor Cyan
        Write-Host "  Verdict: $verdict  |  Approvals: $approvals  |  Comments: $comments" -ForegroundColor $verdictColor
        if ($pr.url) { Write-Host "  URL:     $($pr.url)" -ForegroundColor DarkGray }
        if ($lastEvent) {
            $short = if ($lastEvent.Length -gt 80) { $lastEvent.Substring(0, 80) + '...' } else { $lastEvent }
            Write-Host "  Latest:  $short" -ForegroundColor DarkGray
        }
        Write-Host ""
        return
    }

    # ── Standard implementer view ─────────────────────────────────────────────
    $sNum = $status.storyNumber
    if (-not $sNum -and $status.assignedPR) { $sNum = $status.assignedPR.storyNumber }
    $sName = $status.storyName
    if (-not $sName -and $status.assignedPR) { $sName = $status.assignedPR.title }
    if ($sNum) { $story = "$sNum`: $sName" } else { $story = "(no story)" }
    $mode = if ($status.executionMode) { $status.executionMode } else { "unknown" }
    $phase = if ($status.currentPhase) { $status.currentPhase } else { "unknown" }
    $taskCount = if ($status.tasks) { $status.tasks.Count } else { 0 }
    $prCount = 0
    if ($status.prs) { $prCount = $status.prs.Count }
    elseif ($status.assignedPR) { $prCount = 1 }

    $branchPath = if ($targetCodebase) { $targetCodebase } else { $agentWorkspace }
    $currentBranch = Get-CurrentBranch $branchPath
    $branchLine = if ($currentBranch) { "  Branch: $currentBranch" } else { "" }

    Write-Host "  Story:  $story" -ForegroundColor Yellow
    Write-Host "  Mode:   $mode  |  Phase: $phase" -ForegroundColor DarkCyan
    if ($branchLine) { Write-Host $branchLine -ForegroundColor Cyan }
    Write-Host "  Tasks:  $taskCount  |  PRs: $prCount" -ForegroundColor DarkCyan
    if ($lastEvent) {
        $short = if ($lastEvent.Length -gt 80) { $lastEvent.Substring(0, 80) + "..." } else { $lastEvent }
        Write-Host "  Latest: $short" -ForegroundColor DarkGray
    }
    Write-Host ""
}

# ── Startup ──
$status = Get-AgentStatus
$startNum = $null
$startName = $null
if ($status) {
    $startNum = $status.storyNumber
    if (-not $startNum -and $status.assignedPR) { $startNum = $status.assignedPR.storyNumber }
    $startName = $status.storyName
    if (-not $startName -and $status.assignedPR) { $startName = $status.assignedPR.title }
}
if ($startNum) {
    $storyLabel = "$startNum - $startName"
} else {
    $storyLabel = "unknown"
}
$modelBanner = if ($Model -and $Model -ne '' -and $Model -ne 'auto') { "  [$Model]" } else { "" }
Write-Banner "$($AgentId.ToUpper()) - Autonomous Driver$modelBanner"
Write-Log "Story: $storyLabel" "White"
Write-Log "SDLC Framework dir: $WorkspaceDir"
Write-Log "Agent workspace: $agentWorkspace"
$workspaceBranch = Get-CurrentBranch $agentWorkspace
if ($workspaceBranch) { Write-Log "Branch: $workspaceBranch" "Cyan" }
if ($targetCodebase -and $targetCodebase -ne $agentWorkspace) {
    Write-Log "Target codebase: $targetCodebase (from active project profile)" "Cyan"
    $targetBranch = Get-CurrentBranch $targetCodebase
    if ($targetBranch) { Write-Log "Target branch: $targetBranch" "Cyan" }
}
if ($Model -and $Model -ne '' -and $Model -ne 'auto') {
    Write-Log "Model: $Model" "Cyan"
}
Write-Log "Max turns: $MaxTurns"
if (Get-StepModeEnabled) {
    $stepSource = "agent"
    try {
        $mCfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($mCfg.scheduler.globalStepMode -eq $true) { $stepSource = "global" }
    } catch { }
    Write-Log "Step mode: ON ($stepSource) (pauses at: $((Get-StepModePhases) -join ', '))" "Magenta"
} else {
    Write-Log "Step mode: OFF" "DarkGray"
}
if ((Get-ExternalMode) -eq "mock") {
    Write-Log "External mode: MOCK (live ADO and git push are prohibited for agent work)" "Magenta"
    $env:AGILITY_BASE_URL = "http://localhost:3001/mock-v1"
    $env:V1_BASE_URL = "http://localhost:3001/mock-v1"
    $env:AGILITY_API_KEY = "mock-token"
    $env:V1_ACCESS_TOKEN = "mock-token"
    Remove-Item Env:\AZURE_DEVOPS_PAT -ErrorAction SilentlyContinue
    Remove-Item Env:\AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue
    Remove-Item Env:\VSS_PAT -ErrorAction SilentlyContinue
    Install-MockModeCommandGuards
}
if ($AgentId -eq 'reviewer' -and $status -and $status.assignedPR) {
    $pr = $status.assignedPR
    Write-Log "Reviewing PR #$($pr.id): $($pr.title)" "Cyan"
    if ($pr.branch) { Write-Log "PR branch:  $($pr.branch)" "Cyan" }
    if ($pr.url)    { Write-Log "PR URL:     $($pr.url)" "DarkGray" }
}
Write-StatusSummary $status

# Local/Ollama routing — use Goose CLI instead of Cursor agent CLI
if ($Model -eq 'local') {
    Write-Log "Routing to Goose CLI (local Ollama model)" "Cyan"
    $goosePath = Join-Path $env:USERPROFILE ".local\bin\goose.exe"
    if (-not (Test-Path $goosePath)) {
        Write-Log "Goose CLI not found at $goosePath. Install from https://block.github.io/goose/" "Red"
        exit 1
    }
    $skillPath = Join-Path $WorkspaceDir "skills\$SkillDirName\SKILL.md"
    $safetyDirective = Get-MockModeSafetyDirective
    $goosePrompt = if ($safetyDirective) { "$safetyDirective`n`n$InitialPrompt" } else { $InitialPrompt }
    $goosePrompt += " IMPORTANT: This is a Windows machine. Use PowerShell or cmd commands (dir, type, cd) not Unix commands (ls, cat, pwd). Use backslashes in paths. You are an AUTONOMOUS agent. Do NOT ask questions or wait for confirmation. Execute every step yourself. Never say 'Shall I proceed?' - just proceed."
    if (Test-Path $skillPath) { $goosePrompt += " Refer to your skill file at: $skillPath" }
    if (-not $env:OLLAMA_HOST) { $env:OLLAMA_HOST = "http://localhost:11434" }
    $env:GOOSE_PROVIDER__HOST = $env:OLLAMA_HOST
    $envFile = Join-Path $WorkspaceDir ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+)$' -and $_ -notmatch '^\s*#') {
                [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
            }
        }
    }
    $nodePath = "C:\Program Files\nodejs"
    if ((Test-Path $nodePath) -and -not (($env:PATH -split ';') -contains $nodePath)) {
        $env:PATH = "$nodePath;$env:PATH"
    }
    $gooseModel = if ($env:LOCAL_LLM_MODEL) { $env:LOCAL_LLM_MODEL } else { "deepseek/deepseek-chat-v3.1" }
    Write-Log "Goose model: $gooseModel" "Cyan"
    $gooseProvider = if ($env:GOOSE_PROVIDER) { $env:GOOSE_PROVIDER } else { "openrouter_free" }
    Write-Log "Goose provider: $gooseProvider" "Cyan"
    $keyPreview = if ($env:OPENROUTER_API_KEY) { $env:OPENROUTER_API_KEY.Substring(0, 10) + "..." } else { "(not set)" }
    Write-Log "OPENROUTER_API_KEY: $keyPreview" "DarkGray"
    $goosePromptFile = Join-Path $logDir "$AgentId-goose-prompt.txt"
    [System.IO.File]::WriteAllText($goosePromptFile, $goosePrompt, (New-Object System.Text.UTF8Encoding $false))
    $gooseLauncher = Join-Path $logDir "$AgentId-goose-run.cmd"
    $promptEscaped = ($goosePrompt -replace "`r?`n", " ") -replace '"', '\"'
    $prevGooseSession = $null
    try {
        if (Test-Path $statusFile) {
            $stJson = Get-Content $statusFile -Raw | ConvertFrom-Json
            if ($stJson.lastGooseSessionId) { $prevGooseSession = $stJson.lastGooseSessionId }
        }
    } catch { }
    if ($prevGooseSession) {
        Write-Log "Resuming Goose session: $prevGooseSession" "Cyan"
        [System.IO.File]::WriteAllText($gooseLauncher, "@`"$goosePath`" run --resume --session-id $prevGooseSession --max-turns 50 --model $gooseModel --provider $gooseProvider --text `"$promptEscaped`"", (New-Object System.Text.UTF8Encoding $false))
    } else {
        [System.IO.File]::WriteAllText($gooseLauncher, "@`"$goosePath`" run --max-turns 50 --model $gooseModel --provider $gooseProvider --text `"$promptEscaped`"", (New-Object System.Text.UTF8Encoding $false))
    }
    $comSpec = if ($env:ComSpec) { $env:ComSpec } else { "C:\WINDOWS\System32\cmd.exe" }
    $gooseOutput = & $comSpec /c $gooseLauncher 2>&1 | ForEach-Object { Write-Host $_; $_ }
    $gooseOutputStr = $gooseOutput -join "`n"
    if ($gooseOutputStr -match 'session id:\s*(\S+)') {
        $capturedSession = $Matches[1]
        Write-Log "Captured Goose session: $capturedSession" "Cyan"
        try {
            if (Test-Path $statusFile) {
                $stJson = Get-Content $statusFile -Raw | ConvertFrom-Json
                $stJson | Add-Member -NotePropertyName lastGooseSessionId -NotePropertyValue $capturedSession -Force
                [System.IO.File]::WriteAllText($statusFile, ($stJson | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
            }
        } catch { Write-Log "Failed to save Goose session ID: $_" "Yellow" }
    }
    Write-Log "Goose run completed." "Green"
    if ($KeepOpen) {
        Write-Host ""
        Write-Host "  Terminal kept open (-KeepOpen). Press Enter to close." -ForegroundColor Magenta
        Read-Host
    }
    exit 0
}

$watchRoot = if ($targetCodebase) { $targetCodebase } else { $agentWorkspace }
Start-FileWatcher $watchRoot

# ── Activity viewer (Ctrl+O toggle) ───────────────────────────────────────────
$script:verboseMode = $false

function Shorten-Path([string]$FullPath) {
    if (-not $FullPath) { return '?' }
    return $FullPath -replace [regex]::Escape($agentWorkspace + '\'), ''
}

function Write-CodeLine([string]$Line, [string]$Indent = '    ', [string]$Prefix = '', [string]$PrefixColor = 'Gray') {
    if ($Prefix) { Write-Host -NoNewline "$Indent$Prefix " -ForegroundColor $PrefixColor }
    else         { Write-Host -NoNewline $Indent }

    $remaining = $Line
    while ($remaining.Length -gt 0) {
        # Single-line string (double-quoted)
        if ($remaining -match '^("(?:[^"\\]|\\.)*")') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor Yellow
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Single-line string (single-quoted)
        if ($remaining -match "^('(?:[^'\\]|\\.)*')") {
            Write-Host -NoNewline $Matches[1] -ForegroundColor Yellow
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Template literal (backtick-quoted)
        if ($remaining -match '^(`(?:[^`\\]|\\.)*`)') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor Yellow
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Line comment
        if ($remaining -match '^(\/\/.*)$') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor DarkGreen
            $remaining = ''
            continue
        }
        # Hash comment
        if ($remaining -match '^(#.*)$') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor DarkGreen
            $remaining = ''
            continue
        }
        # Numbers
        if ($remaining -match '^(\b\d+\.?\d*\b)') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor DarkYellow
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Keywords (JS/TS/PS)
        if ($remaining -match '^(\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|import|export|from|default|class|interface|type|async|await|new|this|throw|try|catch|finally|extends|implements|enum|readonly|private|public|protected|static|void|null|undefined|true|false)\b)') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor Cyan
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Arrow / fat-arrow
        if ($remaining -match '^(=>)') {
            Write-Host -NoNewline $Matches[1] -ForegroundColor Cyan
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Next non-special character run
        if ($remaining -match '^([^"''`#/\d\w=>]+|[/](?!/)|[\w]+)') {
            Write-Host -NoNewline $Matches[0] -ForegroundColor Gray
            $remaining = $remaining.Substring($Matches[0].Length)
            continue
        }
        # Fallback: emit one char to avoid infinite loop
        Write-Host -NoNewline $remaining[0] -ForegroundColor Gray
        $remaining = $remaining.Substring(1)
    }
    Write-Host ''
}

function Format-StreamJsonLine([string]$RawLine) {
    try { $evt = $RawLine | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
    $t = $evt.type
    $sub = $evt.subtype

    if ($t -eq 'system' -and $sub -eq 'init') {
        return @{ kind = 'system'; compact = "[init] model=$($evt.model)"; verbose = "[init] model=$($evt.model)  session=$($evt.session_id)" }
    }
    if ($t -eq 'user') {
        return @{ kind = 'user'; compact = ''; verbose = '' }
    }

    if ($t -eq 'tool_call' -and $sub -eq 'started') {
        $tc = $evt.tool_call
        $props = $tc.PSObject.Properties | Where-Object { $_.Name -ne 'type' } | Select-Object -First 1
        if (-not $props) { return @{ kind = 'tool-start'; compact = "[tool] starting..."; verbose = "[tool] starting..." } }
        $toolKey = $props.Name
        $args_ = $props.Value.args

        $label = ''
        $diff = $null
        switch -Wildcard ($toolKey) {
            'readToolCall' {
                $p = Shorten-Path $args_.path
                $lim = if ($args_.limit) { " ($($args_.limit) lines)" } else { '' }
                $off = if ($args_.offset) { " @$($args_.offset)" } else { '' }
                $label = "[read] $p$lim$off"
            }
            'editToolCall' {
                $p = Shorten-Path $args_.path
                $label = "[edit] $p"
                if ($args_.old_string -or $args_.new_string) {
                    $diff = @{ old = $args_.old_string; new = $args_.new_string }
                }
            }
            'writeToolCall' {
                $p = Shorten-Path $args_.path
                $label = "[write] $p"
            }
            'shellToolCall' {
                $cmd = if ($args_.command) { $args_.command } else { '...' }
                $short = if ($cmd.Length -gt 80) { $cmd.Substring(0,80) + '...' } else { $cmd }
                $label = "[shell] $short"
            }
            'grepToolCall' {
                $pat = if ($args_.pattern) { $args_.pattern } else { '?' }
                $p = if ($args_.path) { Shorten-Path $args_.path } else { '' }
                $label = "[search] `"$pat`" in $p"
            }
            'globToolCall' {
                $pat = if ($args_.glob_pattern) { $args_.glob_pattern } elseif ($args_.pattern) { $args_.pattern } else { '?' }
                $label = "[glob] $pat"
            }
            'listDirToolCall' { $label = "[ls] $(Shorten-Path $args_.path)" }
            'deleteToolCall'  { $label = "[delete] $(Shorten-Path $args_.path)" }
            default {
                $name = $toolKey -replace 'ToolCall$', '' -replace 'Tool$', ''
                $label = "[tool:$name] started"
            }
        }
        return @{ kind = 'tool-start'; compact = $label; verbose = $label; diff = $diff }
    }

    if ($t -eq 'tool_call' -and $sub -eq 'completed') {
        $tc = $evt.tool_call
        $props = $tc.PSObject.Properties | Where-Object { $_.Name -ne 'type' } | Select-Object -First 1
        if (-not $props) { return @{ kind = 'tool-done'; compact = ''; verbose = '' } }
        $toolKey = $props.Name
        $result = $props.Value.result

        $compactDetail = ''
        $verboseDetail = ''
        if ($result.success) {
            $s = $result.success
            if ($s.content) {
                $compactDetail = if ($s.content.Length -gt 80) { $s.content.Substring(0, 80) -replace "`n", ' ' } else { $s.content -replace "`n", ' ' }
                $verboseDetail = $s.content
            }
            if ($s.totalLines) { $compactDetail += " ($($s.totalLines) lines)" }
        } elseif ($result.error) {
            $compactDetail = "ERROR: $($result.error)"
            $verboseDetail = "ERROR: $($result.error)"
        }
        $compactDetail = $compactDetail.Trim()
        if ($compactDetail.Length -gt 100) { $compactDetail = $compactDetail.Substring(0, 100) + '...' }
        return @{ kind = 'tool-done'; compact = "  -> $compactDetail"; verbose = $verboseDetail }
    }

    if ($t -eq 'assistant') {
        $txt = ''
        if ($evt.message -and $evt.message.content) {
            foreach ($block in $evt.message.content) {
                if ($block.type -eq 'text' -and $block.text) { $txt += $block.text }
            }
        }
        if (-not $txt) { return @{ kind = 'text'; compact = ''; verbose = '' } }
        $firstLine = ($txt -split "`n" | Select-Object -First 1).Trim()
        $short = if ($firstLine.Length -gt 100) { $firstLine.Substring(0,100) + '...' } else { $firstLine }
        return @{ kind = 'text'; compact = $short; verbose = $txt }
    }

    if ($t -eq 'result') {
        $dur = if ($evt.duration_ms) { [Math]::Round($evt.duration_ms / 1000, 1) } else { '?' }
        $inp = if ($evt.usage.inputTokens) { $evt.usage.inputTokens } else { 0 }
        $out = if ($evt.usage.outputTokens) { $evt.usage.outputTokens } else { 0 }
        $cached = if ($evt.usage.cacheReadTokens) { $evt.usage.cacheReadTokens } else { 0 }
        $stats = "[done] ${dur}s | tokens: $inp in, $out out, $cached cached"
        return @{ kind = 'result'; compact = $stats; verbose = $stats }
    }

    return @{ kind = 'unknown'; compact = ''; verbose = '' }
}

function Write-StreamEvent($parsed) {
    if (-not $parsed) { return }
    if ($parsed.kind -eq 'user') { return }
    $isVerbose = $script:verboseMode
    $text = if ($isVerbose) { $parsed.verbose } else { $parsed.compact }
    if (-not $text) { return }

    $color = switch ($parsed.kind) {
        'system'     { 'DarkGray' }
        'tool-start' { 'DarkCyan' }
        'tool-done'  { 'DarkGray' }
        'text'       { 'White' }
        'result'     { 'Green' }
        default      { 'Gray' }
    }

    # Tool start with diff: show inline diff in verbose mode
    if ($parsed.kind -eq 'tool-start') {
        Write-Host "  $text" -ForegroundColor $color
        if ($isVerbose -and $parsed.diff) {
            $oldLines = if ($parsed.diff.old) { ($parsed.diff.old -split "`n") } else { @() }
            $newLines = if ($parsed.diff.new) { ($parsed.diff.new -split "`n") } else { @() }
            if ($oldLines.Count -gt 0) {
                foreach ($ol in ($oldLines | Select-Object -First 20)) {
                    Write-CodeLine $ol -Indent '    ' -Prefix '-' -PrefixColor Red
                }
                if ($oldLines.Count -gt 20) { Write-Host "    ... ($($oldLines.Count - 20) more lines)" -ForegroundColor DarkGray }
            }
            if ($newLines.Count -gt 0) {
                foreach ($nl in ($newLines | Select-Object -First 20)) {
                    Write-CodeLine $nl -Indent '    ' -Prefix '+' -PrefixColor Green
                }
                if ($newLines.Count -gt 20) { Write-Host "    ... ($($newLines.Count - 20) more lines)" -ForegroundColor DarkGray }
            }
        }
        return
    }

    # Tool result: multi-line verbose output with syntax highlighting
    if ($parsed.kind -eq 'tool-done' -and $isVerbose -and $text) {
        foreach ($vl in ($text -split "`n" | Select-Object -First 30)) {
            if ($vl -match '^ERROR') {
                Write-Host "    $vl" -ForegroundColor Red
            } elseif ($vl -match '^@@') {
                Write-Host "    $vl" -ForegroundColor Cyan
            } else {
                Write-CodeLine $vl -Indent '    '
            }
        }
        $totalLines = ($text -split "`n").Count
        if ($totalLines -gt 30) { Write-Host "    ... ($($totalLines - 30) more lines)" -ForegroundColor DarkGray }
        return
    }

    # Assistant text: multi-line verbose
    if ($parsed.kind -eq 'text' -and $isVerbose) {
        Write-Host ""
        foreach ($tl in ($text -split "`n")) {
            Write-Host "  $tl" -ForegroundColor White
        }
        Write-Host ""
        return
    }

    # Everything else: single line
    Write-Host "  $text" -ForegroundColor $color
}

$safetyDirective = Get-MockModeSafetyDirective
$prompt = if ($safetyDirective) { "$safetyDirective`n`n$InitialPrompt" } else { $InitialPrompt }
$turn = 0
$consecutiveUnavailable = 0

# Check for resumable session from a previous run
$script:resumeSessionId = $null
$script:lastSessionId = $null
try {
    $sf = Join-Path $WorkspaceDir ".$AgentId-status.json"
    if (Test-Path $sf) {
        $sj = Get-Content $sf -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($sj.lastSessionId -and $sj.currentPhase -and $sj.currentPhase -ne 'idle' -and $sj.currentPhase -ne 'complete') {
            $script:resumeSessionId = $sj.lastSessionId
            Write-Log "Found resumable session: $($script:resumeSessionId)" "Cyan"
        }
    }
} catch { <# non-fatal #> }

while ($turn -lt $MaxTurns) {
    if ($stopping) {
        Write-Log "Interrupted by user (Ctrl-C) - stopping." "Yellow"
        break
    }
    $turn++
    $status = Get-AgentStatus
    $phase = if ($status) { $status.currentPhase } else { "unknown" }

    # Only check true terminal phases here (complete, idle, etc.).
    # Step-mode phases are checked AFTER a turn completes so that
    # a resume spawn actually runs the agent before re-pausing.
    # Special case: watching-reviews with PR id 0 means the branch
    # hasn't been pushed yet - let the agent run to finish the push.
    $prPushed = $true
    if ($phase -eq "watching-reviews" -and $status -and $status.prs) {
        $pendingPr = $status.prs | Where-Object { $_.id -eq 0 -or $_.status -eq "PENDING-PUSH" } | Select-Object -First 1
        if ($pendingPr) { $prPushed = $false }
    }
    if ($baseTerminalPhases -contains $phase -and $prPushed) {
        Write-Log "Reached terminal phase '$phase' - stopping." "Green"
        break
    }
    if (-not $prPushed) {
        Write-Log "Phase '$phase' but PR not yet pushed - continuing." "Yellow"
    }

    $stepNow = Get-StepModeEnabled
    $stepLabel = if ($stepNow) { " [STEP]" } else { "" }
    $worktreePath = Get-AgentWorktreePath
    $branchRoot = if ($worktreePath) { $worktreePath } else { if ($targetCodebase) { $targetCodebase } else { $agentWorkspace } }
    $turnBranch = Get-CurrentBranch $branchRoot
    $branchTag = if ($turnBranch) { " | $turnBranch" } else { "" }
    $reviewerTag = if ($AgentId -eq 'reviewer' -and $status -and $status.assignedPR) {
        $livePr = if ($status.prs) { $status.prs | Where-Object { $_.id -eq $status.assignedPR.id } | Select-Object -First 1 } else { $null }
        $appr = if ($livePr -and $null -ne $livePr.approvals) { $livePr.approvals } else { 0 }
        $cmts = if ($livePr -and $null -ne $livePr.comments)  { $livePr.comments  } else { 0 }
        " | PR #$($status.assignedPR.id) [+$appr -$cmts]"
    } else { "" }
    Write-Banner "Turn $turn  |  Phase: $phase$stepLabel$modelBanner$branchTag$reviewerTag"

    $shortPrompt = if ($prompt.Length -gt 120) { $prompt.Substring(0, 120) + "..." } else { $prompt }
    Write-Host "  Prompt: $shortPrompt" -ForegroundColor DarkGray
    $modeHint = if ($script:verboseMode) { 'verbose' } else { 'compact' }
    Write-Host "  [Ctrl+O] Toggle detail ($modeHint)" -ForegroundColor DarkGray
    Write-Host ""

    $startTime = Get-Date
    $turnLog = Join-Path $logDir "$AgentId-turn-$turn.log"

    # Track how many events we have seen so far
    $seenEventCount = 0
    if ($status -and $status.events) { $seenEventCount = $status.events.Count }

    # Stream agent output live to terminal AND capture to file
    try {
        $turnOutput = New-Object System.Text.StringBuilder
        $eventsSincePoll = 0
        $modelArgs = @()
        if ($Model -and $Model -ne 'auto' -and $Model -ne 'local') {
            $modelArgs = @('--model', $Model)
        }
        $resumeArgs = @()
        if ($turn -eq 1 -and $script:resumeSessionId) {
            $resumeArgs = @('--resume', $script:resumeSessionId)
            Write-Log "Resuming session $($script:resumeSessionId)" "Cyan"
            $script:resumeSessionId = $null
        }
        & agent -p --force --trust --approve-mcps --output-format stream-json @resumeArgs @modelArgs --workspace $agentWorkspace $prompt 2>&1 | ForEach-Object {
            $line = $_.ToString()
            [void]$turnOutput.AppendLine($line)
            if ($line -match "^cursor-retrieval:|^WARNING:.*No source files") { return }

            # Check for Ctrl+O toggle (non-blocking key check)
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Modifiers -band [ConsoleModifiers]::Control -and $key.Key -eq 'O') {
                    $script:verboseMode = -not $script:verboseMode
                    $tag = if ($script:verboseMode) { 'VERBOSE' } else { 'COMPACT' }
                    Write-Host ""
                    Write-Host "  -- switched to $tag mode (Ctrl+O to toggle) --" -ForegroundColor Magenta
                    Write-Host ""
                }
            }

            # Parse and render stream-json event
            $parsed = Format-StreamJsonLine $line
            if ($parsed) {
                Write-StreamEvent $parsed
                # Capture session ID from init event for resume support
                if ($parsed.kind -eq 'system' -and $line -match '"session_id"\s*:\s*"([^"]+)"') {
                    $script:lastSessionId = $Matches[1]
                    try {
                        $sf = Join-Path $WorkspaceDir ".$AgentId-status.json"
                        if (Test-Path $sf) {
                            $sj = Get-Content $sf -Raw -Encoding UTF8 | ConvertFrom-Json
                            $sj | Add-Member -NotePropertyName lastSessionId -NotePropertyValue $script:lastSessionId -Force
                            [System.IO.File]::WriteAllText($sf, ($sj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
                        }
                    } catch { <# non-fatal #> }
                }
            } else {
                # Not valid JSON - show raw (stderr, warnings, etc.)
                Write-Host "  $line" -ForegroundColor White
            }

            # Periodically drain file-change events and check for new status events
            $eventsSincePoll++
            if ($eventsSincePoll -ge 5) {
                $eventsSincePoll = 0
                Show-FileEvents $watchRoot $false $worktreePath
                $liveStatus = Get-AgentStatus
                if ($liveStatus -and $liveStatus.events -and $liveStatus.events.Count -gt $seenEventCount) {
                    for ($ei = $seenEventCount; $ei -lt $liveStatus.events.Count; $ei++) {
                        $ev = $liveStatus.events[$ei]
                        $evColor = switch ($ev.type) {
                            "success" { "Green" }
                            "error"   { "Red" }
                            "warning" { "Yellow" }
                            default   { "Cyan" }
                        }
                        Write-Host ""
                        Write-Host "  >> [$($ev.type)] $($ev.message)" -ForegroundColor $evColor
                    }
                    $seenEventCount = $liveStatus.events.Count
                }
            }
        }
        $output = $turnOutput.ToString()
    } catch {
        Write-Log "ERROR: agent call failed: $_" "Red"
        $output = ""
    }
    $elapsed = ((Get-Date) - $startTime).TotalSeconds

    # Extract the assistant's text response from stream-json for the turn log
    $resultText = ''
    foreach ($jLine in ($output -split "`n")) {
        $jLine = $jLine.Trim()
        if (-not $jLine) { continue }
        try {
            $jEvt = $jLine | ConvertFrom-Json -ErrorAction Stop
            if ($jEvt.type -eq 'result' -and $jEvt.result) { $resultText = $jEvt.result }
        } catch { }
    }
    $turnLogContent = if ($resultText) { $resultText } else { $output }
    [System.IO.File]::WriteAllText($turnLog, $turnLogContent, (New-Object System.Text.UTF8Encoding $false))

    # Flush any remaining file-change events with inline diffs
    Show-FileEvents $watchRoot $true $worktreePath
    Show-TurnDiffStat $watchRoot $worktreePath

    Write-Host ""
    $elapsedRound = [Math]::Round($elapsed, 1)
    $outputLen = $output.Length
    Write-Log "Turn $turn completed in ${elapsedRound}s (${outputLen} chars)" "Cyan"

    # Show updated status
    $newStatus = Get-AgentStatus
    $newPhase = if ($newStatus) { $newStatus.currentPhase } else { "unknown" }

    if ($newPhase -ne $phase) {
        Write-Log "Phase: $phase -> $newPhase" "Yellow"
    } else {
        Write-Log "Phase: $newPhase (unchanged)" "DarkGray"
    }

    # Show any events added since our last poll
    if ($newStatus -and $newStatus.events -and $newStatus.events.Count -gt $seenEventCount) {
        Write-Host ""
        for ($i = $seenEventCount; $i -lt $newStatus.events.Count; $i++) {
            $ev = $newStatus.events[$i]
            $evColor = switch ($ev.type) {
                "success" { "Green" }
                "error"   { "Red" }
                "warning" { "Yellow" }
                default   { "DarkGray" }
            }
            Write-Host "  [$($ev.type)] $($ev.message)" -ForegroundColor $evColor
        }
    }

    # Abort early if the API is unreachable on consecutive turns (e.g. ENOTFOUND / [unavailable]).
    # A healthy turn resets the counter; 3 consecutive failures abort the loop.
    if ($output -match '\[unavailable\]' -and $elapsed -lt 5) {
        $consecutiveUnavailable++
        if ($consecutiveUnavailable -ge 3) {
            Write-Host ""
            Write-Log "API unreachable for $consecutiveUnavailable consecutive turns - aborting. Check your connection or model endpoint." "Red"
            break
        }
    } else {
        $consecutiveUnavailable = 0
    }

    $postPrPushed = $true
    if ($newPhase -eq "watching-reviews" -and $newStatus -and $newStatus.prs) {
        $postPendingPr = $newStatus.prs | Where-Object { $_.id -eq 0 -or $_.status -eq "PENDING-PUSH" } | Select-Object -First 1
        if ($postPendingPr) { $postPrPushed = $false }
    }
    if ($baseTerminalPhases -contains $newPhase -and $postPrPushed) {
        Write-Host ""
        Write-Log "Reached terminal phase '$newPhase' after turn $turn - stopping." "Green"
        break
    }
    if ((Get-StepModeEnabled) -and (Get-StepModePhases) -contains $newPhase) {
        Write-Host ""
        Write-Log "Step mode: paused at '$newPhase'. Use dashboard or TUI to continue." "Magenta"
        break
    }

    # Build continuation prompt
    $skillFile = "skills/$SkillDirName/SKILL.md"
    $prompt = "Continue as $AgentId. Read .$AgentId-status.json (currently in phase '$newPhase') and $skillFile. Execute the next phase. Do not stop until you reach a handoff or completion point."

    Write-Host ""
    Write-Host "  Pausing 2s before next turn... (Ctrl-C to stop)" -ForegroundColor DarkGray
    $pauseEnd = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $pauseEnd -and -not $stopping) { Start-Sleep -Milliseconds 100 }
    if ($stopping) {
        Write-Log "Interrupted by user (Ctrl-C) - stopping." "Yellow"
        break
    }
}

Stop-FileWatcher

$finalStatus = Get-AgentStatus
$finalPhase = if ($finalStatus) { $finalStatus.currentPhase } else { "unknown" }

Write-Host ""
Write-Banner "Driver finished - $turn turns  |  Final: $finalPhase"
Write-StatusSummary $finalStatus

if ($turn -ge $MaxTurns) {
    Write-Log "WARNING: Hit max turns limit ($MaxTurns). Agent may not be finished." "Red"
}

if ($KeepOpen) {
    Write-Host ""
    Write-Host "  Terminal kept open (-KeepOpen). Press Enter to close." -ForegroundColor Magenta
    Read-Host
}
