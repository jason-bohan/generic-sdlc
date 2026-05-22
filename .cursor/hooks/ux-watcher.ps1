$statusFile = Join-Path (Get-Location) ".ux-status.json"
$messagesFile = Join-Path (Get-Location) ".ux-messages.json"

$_devPortFile = Join-Path (Get-Location) ".sdlc-framework\.dev-port"
$_apiPort = if (Test-Path $_devPortFile) { [int](Get-Content $_devPortFile -Raw).Trim() } else { 3001 }
$_apiBase = "http://localhost:$_apiPort"

try {
    if (Test-Path $statusFile) {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        if ($status.currentPhase -eq "reading-story") {
            $storyNum = $status.storyNumber
            $storyName = $status.storyName
            @{ followup_message = "UX agent has story $storyNum ($storyName) in reading-story phase. Read skills/ux/SKILL.md and execute the design workflow. Update .ux-status.json after each phase. (Display name defaults to Prism; configurable.)" } | ConvertTo-Json -Compress
            exit 0
        }

        if ($status.currentPhase -eq "spec-ready") {
            if (-not $status.handoffDispatched) {
                $storyNum = $status.storyNumber
                $storyName = $status.storyName
                $designSpec = if ($status.designSpec) { $status.designSpec } else { ".ux-design-spec.md" }
                $payload = @{
                    storyNumber = $storyNum
                    storyName = $storyName
                    designSpec = $designSpec
                } | ConvertTo-Json -Compress
                try {
                    Invoke-RestMethod -Uri "$_apiBase/api/handoff/design-ready" -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 5 | Out-Null
                } catch {
                    $errLog = Join-Path (Get-Location) ".watcher-errors.log"
                    $ts = Get-Date -Format "o"
                    "$ts [ux-watcher] Failed POST /api/handoff/design-ready for story $storyNum`: $_" | Add-Content $errLog -Encoding UTF8
                    Write-Error "ux-watcher: handoff POST failed - $_" 2>&1 | Out-Null
                }
                $status | Add-Member -NotePropertyName "handoffDispatched" -NotePropertyValue $true -Force
                $status | ConvertTo-Json -Depth 10 | Set-Content $statusFile -Encoding UTF8
            }
            @{ followup_message = "UX design spec is ready. Handoff to frontend agent dispatched via /api/handoff/design-ready." } | ConvertTo-Json -Compress
            exit 0
        }

        if ((Test-Path $messagesFile) -and $status.currentPhase -ne "idle") {
            $messages = Get-Content $messagesFile -Raw | ConvertFrom-Json
            $pendingCount = ($messages | Where-Object { $_.from -eq "user" -and $_.status -ne "acted" -and $_.status -ne "read" }).Count
            if ($pendingCount -gt 0) {
                @{ followup_message = "UX agent has $pendingCount pending /btw message(s). Read skills/ux/SKILL.md and check .ux-messages.json between phases. Mark messages as 'read' or 'acted' after processing." } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
} catch {}

Write-Output '{}'
exit 0
