$workspace = Get-Location
$errors = @()

$statusFiles = Get-ChildItem -Path $workspace -Filter ".*-status.json" -File -ErrorAction SilentlyContinue
foreach ($sf in $statusFiles) {
    $agent = $sf.Name -replace '^\.|(-status\.json)$', ''
    $statusFile = $sf.FullName
    if (-not (Test-Path $statusFile)) { continue }

    try {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
    } catch { continue }

    $phase = $status.currentPhase
    if (-not $phase -or $phase -eq "idle") { continue }

    # Check 1: If agent says "complete" but tasks aren't marked completed in status file
    if ($phase -eq "complete") {
        $openTasks = @()
        if ($status.tasks) {
            foreach ($t in $status.tasks) {
                $taskStatus = if ($t.status) { $t.status } else { "unknown" }
                if ($taskStatus -ne "completed" -and $taskStatus -ne "complete") {
                    $openTasks += $t.number
                }
            }
        }
        if ($openTasks.Count -gt 0) {
            $taskList = $openTasks -join ", "
            $errors += "$agent marked complete but has open tasks in status file: $taskList. You MUST mark them completed in Agility using update_task with field=status value=TaskStatus:125 AND field=todo value=0 for each one."
        }
    }

    # Check 2: If agent is at creating-pr or later, verify reviewer handoff exists (for frontend and devops)
    if ($agent -ne "reviewer") {
        $postPrPhases = @("watching-reviews", "complete")
        if ($phase -in $postPrPhases) {
            $reviewerFile = Join-Path $workspace ".reviewer-status.json"
            $handoffOk = $false
            if (Test-Path $reviewerFile) {
                try {
                    $rv = Get-Content $reviewerFile -Raw | ConvertFrom-Json
                    $reviewerPhase = $rv.currentPhase
                    $reviewPhases = @("pending-review", "reviewing", "approved", "changes-requested", "waiting-for-fixes")
                    if ($reviewerPhase -in $reviewPhases) {
                        if ($status.prs -and $status.prs.Count -gt 0) {
                            $latestPr = $status.prs[-1]
                            $prId = $latestPr.id
                            # Check assignedPR.id or currentTask containing PR id
                            $hasAssignedPR = $rv.assignedPR -and $rv.assignedPR.id -eq $prId
                            $hasCurrentTask = $rv.currentTask -and $rv.currentTask -match "$prId"
                            if ($hasAssignedPR -or $hasCurrentTask) {
                                $handoffOk = $true
                            }
                        } else {
                            $handoffOk = $true
                        }
                    }
                } catch {}
            }
            if (-not $handoffOk -and $phase -ne "complete") {
                $errors += "$agent is in $phase but .reviewer-status.json does not reference the current PR. You MUST write .reviewer-status.json with currentPhase=pending-review and full assignedPR details (id, title, url, storyNumber, branch). The reviewer agent cannot proceed without this handoff."
            }
        }
    }

    # Check 3: If agent jumped to complete but PR still shows as active (not reviewed)
    if ($phase -eq "complete" -and $agent -ne "reviewer") {
        if ($status.prs -and $status.prs.Count -gt 0) {
            $latestPr = $status.prs[-1]
            if ($latestPr.status -eq "active") {
                $errors += "$agent marked complete but PR #$($latestPr.id) is still active. You cannot be complete until the reviewer approves and devops runs the pipeline. Set currentPhase back to watching-reviews."
            }
        }
    }

    # Check 4: If tasks exist but none have status set (never signed up)
    if ($status.tasks -and $status.tasks.Count -gt 0) {
        $unsignedTasks = @()
        foreach ($t in $status.tasks) {
            if (-not $t.status -or $t.status -eq "pending") {
                $unsignedTasks += if ($t.number) { $t.number } elseif ($t.id) { $t.id } else { "unknown" }
            }
        }
        $activePhases = @("generating-code", "validating", "creating-pr", "watching-reviews", "complete")
        if ($unsignedTasks.Count -gt 0 -and $phase -in $activePhases) {
            $taskList = $unsignedTasks -join ", "
            $errors += "$agent is in $phase but tasks $taskList were never signed up for (still pending). You MUST set each task to In Progress in Agility using update_task with field=status value=TaskStatus:123 AND field=todo value=0."
        }
    }
}

if ($errors.Count -gt 0) {
    $message = "WORKFLOW VIOLATIONS DETECTED:`n"
    foreach ($e in $errors) {
        $message += "- $e`n"
    }
    $message += "`nFix ALL violations before proceeding. Do NOT skip these steps."
    @{ followup_message = $message } | ConvertTo-Json -Compress
    exit 0
}

Write-Output '{}'
exit 0
