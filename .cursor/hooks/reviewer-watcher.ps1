$statusFile = Join-Path (Get-Location) ".reviewer-status.json"
$messagesFile = Join-Path (Get-Location) ".reviewer-messages.json"

$_devPortFile = Join-Path (Get-Location) ".sdlc-framework\.dev-port"
$_apiPort = if (Test-Path $_devPortFile) { [int](Get-Content $_devPortFile -Raw).Trim() } else { 3001 }
$_apiBase = "http://localhost:$_apiPort"

try {
    if (Test-Path $statusFile) {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        if ($status.currentPhase -eq "pending-review") {
            $prId = $status.assignedPR.id
            $prTitle = $status.assignedPR.title
            if (-not $status.handoffDispatched) {
                try {
                    Invoke-RestMethod -Uri "$_apiBase/api/reviewer/spawn-from-desk" -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 20 | Out-Null
                } catch {
                    $errLog = Join-Path (Get-Location) ".watcher-errors.log"
                    $ts = Get-Date -Format "o"
                    "$ts [reviewer-watcher] spawn-from-desk failed: $_" | Add-Content $errLog -Encoding UTF8
                }
            }
            $spawnHint = "When global and reviewer step mode are both off, the server can start the reviewer CLI headless (no new terminal): logs under .agent-output/reviewer-*.log and .agent-spawns.log; PID in .reviewer-status.json as spawnedPid when started. If either step mode is on or spawn failed, read skills/reviewer/SKILL.md and run the review (Pick Up still put the PR on the desk)."
            try {
                $sm = Invoke-RestMethod -Uri "$_apiBase/api/agent/step-mode/reviewer" -Method GET -TimeoutSec 3
                if ($sm.globalStepMode -eq $true -or $sm.stepMode -eq $true) {
                    $spawnHint = "Global or reviewer step mode is ON: the server does not auto-spawn the reviewer CLI for this desk. The PR is still on pending-review; read skills/reviewer/SKILL.md and run the review yourself."
                }
            } catch { }
            @{ followup_message = "Reviewer has PR #$prId ($prTitle) in pending-review. $spawnHint (Display name defaults to Brehon; configurable.)" } | ConvertTo-Json -Compress
            exit 0
        }

        if ($status.currentPhase -eq "approved" -or $status.currentPhase -eq "changes-requested") {
            if (-not $status.handoffDispatched) {
                $verdict = $status.currentPhase
                $prId = $status.assignedPR.id
                $storyNumber = $status.assignedPR.storyNumber
                $branch = $status.assignedPR.branch
                $payload = @{
                    prId = $prId
                    verdict = if ($verdict -eq "approved") { "approved" } else { "changes-requested" }
                    storyNumber = $storyNumber
                    branch = $branch
                } | ConvertTo-Json -Compress
                try {
                    Invoke-RestMethod -Uri "$_apiBase/api/handoff/review-complete" -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 5 | Out-Null
                } catch {
                    $errLog = Join-Path (Get-Location) ".watcher-errors.log"
                    $ts = Get-Date -Format "o"
                    "$ts [reviewer-watcher] Failed POST /api/handoff/review-complete for PR #$prId`: $_" | Add-Content $errLog -Encoding UTF8
                    Write-Error "reviewer-watcher: handoff POST failed - $_" 2>&1 | Out-Null
                }
                $status | Add-Member -NotePropertyName "handoffDispatched" -NotePropertyValue $true -Force
                $status | ConvertTo-Json -Depth 10 | Set-Content $statusFile -Encoding UTF8
            }
        }

        if ((Test-Path $messagesFile) -and $status.currentPhase -ne "idle") {
            $messages = Get-Content $messagesFile -Raw | ConvertFrom-Json
            $pendingCount = ($messages | Where-Object { $_.from -eq "user" -and $_.status -ne "acted" -and $_.status -ne "read" }).Count
            if ($pendingCount -gt 0) {
                @{ followup_message = "Reviewer agent has $pendingCount pending /btw message(s). Read skills/reviewer/SKILL.md and check .reviewer-messages.json between phases. Mark messages as 'read' or 'acted' after processing." } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
} catch {}

Write-Output '{}'
exit 0
