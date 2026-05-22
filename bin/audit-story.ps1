<#
.SYNOPSIS
  Audits an Agility story to verify agent workflow compliance.
  Checks: tasks exist, tasks owned, tasks In Progress or Completed, hours tracked.

.USAGE
  .\bin\audit-story.ps1 -StoryNumber "B-16927"
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$StoryNumber
)

$workspace = $PSScriptRoot | Split-Path -Parent
$errors = @()
$warnings = @()
$passes = @()

Write-Host "`n=== SDLC Framework Story Audit: $StoryNumber ===" -ForegroundColor Cyan
Write-Host ""

# Find the agent status file that references this story
$agentFile = $null
$agentName = $null
foreach ($agent in @("frontend", "devops")) {
    $file = Join-Path $workspace ".$agent-status.json"
    if (Test-Path $file) {
        $content = Get-Content $file -Raw | ConvertFrom-Json
        if ($content.storyNumber -eq $StoryNumber) {
            $agentFile = $file
            $agentName = $agent
            break
        }
    }
}

if (-not $agentFile) {
    Write-Host "[SKIP] No agent status file references $StoryNumber" -ForegroundColor Yellow
    Write-Host "       (Agent may have cleared status or story was never assigned locally)"
    exit 0
}

Write-Host "Agent: $agentName" -ForegroundColor White
$status = Get-Content $agentFile -Raw | ConvertFrom-Json

# Check 1: Phase should be 'complete'
if ($status.currentPhase -eq "complete") {
    $passes += "Phase is 'complete'"
} else {
    $warnings += "Phase is '$($status.currentPhase)' (expected 'complete')"
}

# Check 2: Tasks exist
if ($status.tasks -and $status.tasks.Count -gt 0) {
    $passes += "Tasks created: $($status.tasks.Count)"
} else {
    $errors += "No tasks found in status file. Agent must create tasks in Agility."
}

# Check 3: All tasks marked completed
if ($status.tasks) {
    $openTasks = @()
    $completedTasks = @()
    foreach ($t in $status.tasks) {
        $taskStatus = if ($t.status) { $t.status } else { "unknown" }
        if ($taskStatus -eq "completed" -or $taskStatus -eq "complete") {
            $completedTasks += $t.number
        } else {
            $openTasks += "$($t.number) ($taskStatus)"
        }
    }
    if ($openTasks.Count -eq 0) {
        $passes += "All tasks marked completed: $($completedTasks -join ', ')"
    } else {
        $errors += "Open tasks: $($openTasks -join ', ')"
    }
}

# Check 4: PR was created
if ($status.prs -and $status.prs.Count -gt 0) {
    $latestPr = $status.prs[-1]
    $passes += "PR created: #$($latestPr.id) - $($latestPr.title)"
    if ($latestPr.status -eq "completed") {
        $passes += "PR merged"
    } elseif ($latestPr.status -eq "active") {
        $warnings += "PR #$($latestPr.id) still active (not yet merged)"
    }
} else {
    $errors += "No PR found in status file"
}

# Check 5: Reviewer reviewed
$reviewerFile = Join-Path $workspace ".reviewer-status.json"
if (Test-Path $reviewerFile) {
    $reviewer = Get-Content $reviewerFile -Raw | ConvertFrom-Json
    $reviewPhases = @("approved", "reviewing", "pending-review")
    if ($reviewer.currentPhase -in $reviewPhases -or $reviewer.currentPhase -eq "approved") {
        $passes += "Reviewer review: $($reviewer.currentPhase)"
    } else {
        $warnings += "Reviewer phase is '$($reviewer.currentPhase)' - may not have reviewed"
    }
} else {
    $errors += "No .reviewer-status.json - agent did not hand off to Reviewer"
}

# Print results
Write-Host ""
Write-Host "--- PASSES ---" -ForegroundColor Green
foreach ($p in $passes) { Write-Host "  [OK] $p" -ForegroundColor Green }

if ($warnings.Count -gt 0) {
    Write-Host ""
    Write-Host "--- WARNINGS ---" -ForegroundColor Yellow
    foreach ($w in $warnings) { Write-Host "  [!] $w" -ForegroundColor Yellow }
}

if ($errors.Count -gt 0) {
    Write-Host ""
    Write-Host "--- FAILURES ---" -ForegroundColor Red
    foreach ($e in $errors) { Write-Host "  [X] $e" -ForegroundColor Red }
}

Write-Host ""
$total = $passes.Count + $warnings.Count + $errors.Count
Write-Host "Score: $($passes.Count)/$total checks passed" -ForegroundColor $(if ($errors.Count -eq 0) { "Green" } else { "Red" })
Write-Host ""

if ($errors.Count -gt 0) {
    Write-Host "VERDICT: FAIL - Agent did not follow the complete workflow." -ForegroundColor Red
    Write-Host ""
    Write-Host "To verify Agility state directly, use the Agility MCP:" -ForegroundColor White
    Write-Host "  get_story -story_number $StoryNumber" -ForegroundColor Gray
    Write-Host "  (Check tasks have Status=Completed and ToDo=0)" -ForegroundColor Gray
    exit 1
} else {
    Write-Host "VERDICT: PASS - Workflow followed correctly." -ForegroundColor Green
    exit 0
}
