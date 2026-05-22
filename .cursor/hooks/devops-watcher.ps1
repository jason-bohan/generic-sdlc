$statusFile = Join-Path (Get-Location) ".devops-status.json"
$messagesFile = Join-Path (Get-Location) ".devops-messages.json"

# Read the API port written by the server at startup; fall back to 3001 for the main worktree.
$_devPortFile = Join-Path (Get-Location) ".sdlc-framework\.dev-port"
$_apiPort = if (Test-Path $_devPortFile) { [int](Get-Content $_devPortFile -Raw).Trim() } else { 3001 }
$_apiBase = "http://localhost:$_apiPort"

# Keep in sync with src/messages/triggers.ts (single source of truth for TypeScript consumers)
$triggerPatterns = @(
    @{ Pattern = "(?i)\bbuild\s+passed\b"; Trigger = "build-passed"; TargetPhase = "complete"; Description = "Build passed - complete pipeline" }
    @{ Pattern = "(?i)\bbuild\s+failed\b"; Trigger = "build-failed"; TargetPhase = "build-failed"; Description = "Build failed - investigate" }
    @{ Pattern = "(?i)\bpr\s+approved\b"; Trigger = "pr-approved"; TargetPhase = "pending-build"; Description = "PR approved - trigger build" }
)

try {
    if (Test-Path $statusFile) {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        if ($status.currentPhase -eq "pending-build") {
            $prId = $status.assignedPR.id
            $prTitle = $status.assignedPR.title
            @{ followup_message = "DevOps agent has PR #$prId ($prTitle) in pending-build phase. Read skills/devops/SKILL.md and execute the Pipeline Workflow (Mode B). Update .devops-status.json after each phase. (Display name is configurable in dashboard or config.)" } | ConvertTo-Json -Compress
            exit 0
        }
        if ($status.currentPhase -eq "reading-story") {
            $storyNum = $status.storyNumber
            $storyName = $status.storyName
            @{ followup_message = "DevOps agent has story $storyNum ($storyName) in reading-story phase. Read skills/devops/SKILL.md and execute the DevOps Story Workflow (Mode A). Update .devops-status.json after each phase." } | ConvertTo-Json -Compress
            exit 0
        }
        if ($status.currentPhase -eq "monitoring-build") {
            $buildId = $status.buildId
            @{ followup_message = "DevOps agent is monitoring build #$buildId. Read skills/devops/SKILL.md and resume the Pipeline Workflow at Step 2 (Monitor Build). Update .devops-status.json after each phase." } | ConvertTo-Json -Compress
            exit 0
        }

        if ($status.currentPhase -eq "build-passed" -or $status.currentPhase -eq "build-failed") {
            if (-not $status.handoffDispatched) {
                $result = if ($status.currentPhase -eq "build-passed") { "passed" } else { "failed" }
                $prId = $status.assignedPR.id
                $buildId = $status.buildId
                $payload = @{
                    prId = $prId
                    result = $result
                    buildId = $buildId
                } | ConvertTo-Json -Compress
                try {
                    Invoke-RestMethod -Uri "$_apiBase/api/handoff/build-complete" -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 5 | Out-Null
                } catch {
                    $errLog = Join-Path (Get-Location) ".watcher-errors.log"
                    $ts = Get-Date -Format "o"
                    "$ts [devops-watcher] Failed POST /api/handoff/build-complete for PR #$prId`: $_" | Add-Content $errLog -Encoding UTF8
                    Write-Error "devops-watcher: handoff POST failed - $_" 2>&1 | Out-Null
                }
                $status | Add-Member -NotePropertyName "handoffDispatched" -NotePropertyValue $true -Force
                $status | ConvertTo-Json -Depth 10 | Set-Content $statusFile -Encoding UTF8
            }
        }

        if ((Test-Path $messagesFile) -and $status.currentPhase -ne "idle") {
            $messages = Get-Content $messagesFile -Raw | ConvertFrom-Json
            foreach ($msg in $messages) {
                if ($msg.from -ne "user") { continue }
                if ($msg.status -eq "acted" -or $msg.status -eq "read") { continue }
                $text = if ($msg.message) { $msg.message } else { $msg.text }
                if (-not $text) { continue }

                foreach ($tp in $triggerPatterns) {
                    if ($text -match $tp.Pattern) {
                        $trigger = $tp.Trigger
                        $targetPhase = $tp.TargetPhase
                        $desc = $tp.Description
                        @{ followup_message = "INTERRUPT: /btw message matched trigger '$trigger'. $desc. Read skills/devops/SKILL.md, process the pending message in .devops-messages.json (mark it status='acted'), and transition to phase '$targetPhase'. Update .devops-status.json." } | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }

            $pendingCount = ($messages | Where-Object { $_.from -eq "user" -and $_.status -ne "acted" -and $_.status -ne "read" }).Count
            if ($pendingCount -gt 0) {
                @{ followup_message = "DevOps agent has $pendingCount pending /btw message(s). Read skills/devops/SKILL.md and check .devops-messages.json between phases. Mark messages as 'read' or 'acted' after processing." } | ConvertTo-Json -Compress
                exit 0
            }
        }

        if ($status.currentPhase -eq "build-passed" -and $status.assignedPR -and $status.assignedPR.id) {
            $wrapPrId = $status.assignedPR.id
            $wrapTitle = $status.assignedPR.title
            $wrapStory = $status.assignedPR.storyNumber
            $storyBit = if ($wrapStory) { " Story $wrapStory." } else { "" }
            $slug = if ($wrapStory) { ($wrapStory.ToString().Trim() -replace '[^a-zA-Z0-9-]', '') } else { "" }
            $wrapReqId = if ($slug) { "WRAPUP-$slug-PR-$wrapPrId" } else { "WRAPUP-PR-$wrapPrId" }
            @{ followup_message = "DevOps: CI passed for PR #$wrapPrId ($wrapTitle).$storyBit Run wrap-up per .cursor/rules/story-wrapup.mdc, then idle this agent in .devops-status.json. Dashboard: open request $wrapReqId under Tasks on the DevOps desk." } | ConvertTo-Json -Compress
            exit 0
        }
    }
} catch {}

Write-Output '{}'
exit 0
