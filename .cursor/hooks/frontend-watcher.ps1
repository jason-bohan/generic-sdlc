$statusFile = Join-Path (Get-Location) ".frontend-status.json"
$messagesFile = Join-Path (Get-Location) ".frontend-messages.json"

# Keep in sync with src/messages/triggers.ts (single source of truth for TypeScript consumers)
$triggerPatterns = @(
    @{ Pattern = "(?i)\bpr\s+approved\b"; Trigger = "pr-approved"; TargetPhase = "running-cypress"; Description = "PR approved - advance to Cypress tests" }
    @{ Pattern = "(?i)\bchanges\s+requested\b"; Trigger = "changes-requested"; TargetPhase = "addressing-feedback"; Description = "Changes requested - address feedback" }
    @{ Pattern = "(?i)\bbuild\s+passed\b"; Trigger = "build-passed"; TargetPhase = "complete"; Description = "Build passed - complete story" }
    @{ Pattern = "(?i)\bbuild\s+failed\b"; Trigger = "build-failed"; TargetPhase = "validating"; Description = "Build failed - return to validation" }
    @{ Pattern = "(?i)\b(brehon|reviewer)\s+(approved|did\s+(his|her|their)\s+review|finished\s+review)\b"; Trigger = "pr-approved"; TargetPhase = "running-cypress"; Description = "PR review complete - advance to Cypress" }
)

try {
    if (Test-Path $statusFile) {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        if ($status.currentPhase -eq "reading-story") {
            $storyNum = $status.storyNumber
            $storyName = $status.storyName
            @{ followup_message = "Frontend agent has story $storyNum ($storyName) in reading-story phase. Read skills/frontend/SKILL.md and execute the workflow starting at Phase 1. Update .frontend-status.json after each phase. (Display name defaults to Lasair; configurable in dashboard or config.)" } | ConvertTo-Json -Compress
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
                        @{ followup_message = "INTERRUPT: /btw message matched trigger '$trigger'. $desc. Read skills/frontend/SKILL.md, process the pending message in .frontend-messages.json (mark it status='acted'), and transition to phase '$targetPhase'. Update .frontend-status.json." } | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }

            $pendingCount = ($messages | Where-Object { $_.from -eq "user" -and $_.status -ne "acted" -and $_.status -ne "read" }).Count
            if ($pendingCount -gt 0) {
                @{ followup_message = "Frontend agent has $pendingCount pending /btw message(s). Read skills/frontend/SKILL.md and check .frontend-messages.json between phases. Mark messages as 'read' or 'acted' after processing." } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
} catch {}

Write-Output '{}'
exit 0
