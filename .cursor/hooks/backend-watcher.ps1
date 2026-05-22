$statusFile = Join-Path (Get-Location) ".backend-status.json"
$messagesFile = Join-Path (Get-Location) ".backend-messages.json"

$triggerPatterns = @(
    @{ Pattern = "(?i)\bpr\s+approved\b"; Trigger = "pr-approved"; TargetPhase = "running-tests"; Description = "PR approved - advance to tests" }
    @{ Pattern = "(?i)\bchanges\s+requested\b"; Trigger = "changes-requested"; TargetPhase = "addressing-feedback"; Description = "Changes requested - address feedback" }
    @{ Pattern = "(?i)\bbuild\s+passed\b"; Trigger = "build-passed"; TargetPhase = "complete"; Description = "Build passed - complete story" }
    @{ Pattern = "(?i)\bbuild\s+failed\b"; Trigger = "build-failed"; TargetPhase = "validating"; Description = "Build failed - return to validation" }
    @{ Pattern = "(?i)\b(brehon|reviewer)\s+(approved|did\s+(his|her|their)\s+review|finished\s+review)\b"; Trigger = "pr-approved"; TargetPhase = "running-tests"; Description = "PR review complete - advance to tests" }
)

try {
    if (Test-Path $statusFile) {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        if ($status.currentPhase -eq "reading-story") {
            $storyNum = $status.storyNumber
            $storyName = $status.storyName
            @{ followup_message = "Backend agent has story $storyNum ($storyName) in reading-story phase. Read skills/backend/SKILL.md and execute the workflow starting at Phase 1. Update .backend-status.json after each phase. (Display name defaults to Cairn; configurable in dashboard or config.)" } | ConvertTo-Json -Compress
            exit 0
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
                        @{ followup_message = "INTERRUPT: /btw message matched trigger '$trigger'. $desc. Read skills/backend/SKILL.md, process the pending message in .backend-messages.json (mark it status='acted'), and transition to phase '$targetPhase'. Update .backend-status.json." } | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }

            $pendingCount = ($messages | Where-Object { $_.from -eq "user" -and $_.status -ne "acted" -and $_.status -ne "read" }).Count
            if ($pendingCount -gt 0) {
                @{ followup_message = "Backend agent has $pendingCount pending /btw message(s). Read skills/backend/SKILL.md and check .backend-messages.json between phases. Mark messages as 'read' or 'acted' after processing." } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
} catch {}

Write-Output '{}'
exit 0
