# meeting-start.ps1 — Start the full meeting agent stack with one command.
#
# Services started:
#   Port 3978  teams-agent (Node.js bot)
#   Port 9338  meeting-bridge (task router + pipeline trigger)
#   Port 9001  preview-server (live diff UI — open in browser)
#   Port 9339  voice-agent (TTS, optional)
#   Port 9340  auto-pr watcher (creates PRs from completed tasks)
#
# Usage:
#   .\scripts\meeting-start.ps1
#   .\scripts\meeting-start.ps1 -SkipVoice
#   .\scripts\meeting-start.ps1 -WhisperDevice "CABLE Output" -WhisperModel small

param(
    [string]$MeshUrl       = "http://localhost:9337/v1",
    [string]$BotUrl        = "http://localhost:3978",
    [int]   $BridgePort    = 9338,
    [int]   $PreviewPort   = 9001,
    [int]   $VoicePort     = 9339,
    [string]$WhisperDevice = "",          # e.g. "CABLE Output" or "Microphone"
    [string]$WhisperModel  = "base",      # tiny | base | small | medium
    [string]$WhisperSpeaker = "Participant",
    [switch]$SkipVoice,
    [switch]$SkipWhisper,
    [switch]$SkipBot,
    [switch]$NoCable                      # play TTS through speakers instead of VB-CABLE
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$ScriptsDir = Join-Path $RepoRoot "scripts"
$TeamsBotDir = Join-Path $RepoRoot "teams-agent"
$Python = "python"

function Write-Header($text) {
    Write-Host "`n== $text ==" -ForegroundColor Cyan
}

function Start-Service($name, $cmd, $args, $workDir = $RepoRoot, $color = "Green") {
    Write-Host "  Starting $name..." -ForegroundColor $color
    $proc = Start-Process -FilePath $cmd -ArgumentList $args `
        -WorkingDirectory $workDir `
        -PassThru -WindowStyle Minimized
    Write-Host "    PID $($proc.Id)  $name" -ForegroundColor DarkGray
    return $proc
}

# ─── Dependency checks ────────────────────────────────────────────────────────

Write-Header "SDLC Framework Meeting Agent"

# Check Python
try { & $Python --version 2>&1 | Out-Null } catch {
    Write-Host "ERROR: python not found in PATH" -ForegroundColor Red; exit 1
}

# Check gh CLI (for auto-pr)
$ghAvailable = $false
try { gh --version 2>&1 | Out-Null; $ghAvailable = $true } catch {
    Write-Host "  gh CLI not found — auto-pr will be skipped" -ForegroundColor Yellow
}

# Check Node (for Teams bot)
$nodeAvailable = $false
try { node --version 2>&1 | Out-Null; $nodeAvailable = $true } catch {
    Write-Host "  node not found — Teams bot will be skipped" -ForegroundColor Yellow
    $SkipBot = $true
}

# Install Teams bot deps if needed
if (-not $SkipBot -and (Test-Path $TeamsBotDir)) {
    if (-not (Test-Path (Join-Path $TeamsBotDir "node_modules"))) {
        Write-Host "  Installing Teams bot dependencies..." -ForegroundColor Yellow
        Push-Location $TeamsBotDir
        npm install --silent 2>&1 | Out-Null
        Pop-Location
    }
}

# ─── Start services ───────────────────────────────────────────────────────────

$procs = @()

Write-Header "Starting Services"

# 1. Meeting bridge
$procs += Start-Service "meeting-bridge:$BridgePort" $Python `
    "$ScriptsDir\meeting-bridge.py serve --port $BridgePort"

Start-Sleep -Milliseconds 800

# 2. Preview server
$procs += Start-Service "preview-server:$PreviewPort" $Python `
    "$ScriptsDir\preview-server.py serve --port $PreviewPort"

Start-Sleep -Milliseconds 800

# 3. Voice agent (optional)
if (-not $SkipVoice) {
    $voiceArgs = "$ScriptsDir\voice-agent.py serve --port $VoicePort --mesh-url $MeshUrl"
    if ($NoCable) { $voiceArgs += " --no-cable" }
    $procs += Start-Service "voice-agent:$VoicePort" $Python $voiceArgs
    Start-Sleep -Milliseconds 600
}

# 4. Teams bot (optional)
if (-not $SkipBot -and (Test-Path $TeamsBotDir)) {
    # Copy .env if .env.example exists but .env doesn't
    $envFile = Join-Path $TeamsBotDir ".env"
    $envExample = Join-Path $TeamsBotDir ".env.example"
    if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
        Copy-Item $envExample $envFile
        Write-Host "  Copied .env.example → .env (fill in credentials for Teams)" -ForegroundColor Yellow
    }
    $procs += Start-Service "teams-bot:3978" "node" `
        (Join-Path $TeamsBotDir "index.js") $TeamsBotDir
    Start-Sleep -Milliseconds 800
}

# 5. Auto-PR watcher (optional, requires gh CLI)
if ($ghAvailable) {
    $procs += Start-Service "auto-pr-watcher" $Python `
        "$ScriptsDir\auto-pr.py serve --bot-url $BotUrl"
}

# ─── Status ───────────────────────────────────────────────────────────────────

Write-Header "Stack Running"
Write-Host ""
Write-Host "  Meeting bridge  : http://localhost:$BridgePort/status" -ForegroundColor White
Write-Host "  Preview UI      : http://localhost:$PreviewPort  (open this in browser)" -ForegroundColor Green
if (-not $SkipVoice) {
    Write-Host "  Voice agent     : http://localhost:$VoicePort/health" -ForegroundColor White
}
if (-not $SkipBot) {
    Write-Host "  Teams bot       : http://localhost:3978/status" -ForegroundColor White
}
if ($ghAvailable) {
    Write-Host "  Auto-PR watcher : active (creates PRs from pipeline outputs)" -ForegroundColor White
}

Write-Host ""
Write-Host "  Test without Teams (no credentials needed):" -ForegroundColor DarkGray
Write-Host '  curl -X POST http://localhost:9338/task -H "Content-Type: application/json"' -ForegroundColor DarkGray
Write-Host '    -d "{""task"":""Fix null ref in userService"",""cluster"":""null_ref"",""confidence"":0.87}"' -ForegroundColor DarkGray
Write-Host ""

# 6. Optional: start Whisper stream
if (-not $SkipWhisper) {
    Write-Host ""
    $deviceArg = if ($WhisperDevice) { "--device `"$WhisperDevice`"" } else { "" }
    $whisperCmd = "$ScriptsDir\whisper-stream.py --model $WhisperModel --speaker `"$WhisperSpeaker`" $deviceArg"

    $startWhisper = Read-Host "Start Whisper voice capture now? [Y/n]"
    if ($startWhisper -ne "n" -and $startWhisper -ne "N") {
        Write-Host "  Starting Whisper ($WhisperModel)... Speak to trigger pipeline." -ForegroundColor Green
        # Run whisper in this terminal (it's the interactive part)
        & $Python $ScriptsDir\whisper-stream.py --model $WhisperModel --speaker $WhisperSpeaker $(if ($WhisperDevice) { "--device"; $WhisperDevice })
    } else {
        Write-Host ""
        Write-Host "  To start Whisper manually:" -ForegroundColor DarkGray
        Write-Host "  python $ScriptsDir\whisper-stream.py --model $WhisperModel --list-devices" -ForegroundColor DarkGray
        Write-Host "  python $ScriptsDir\whisper-stream.py --model $WhisperModel --device `"Microphone`"" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Yellow
        try { while ($true) { Start-Sleep 5 } }
        catch { }
    }
}

# ─── Cleanup ──────────────────────────────────────────────────────────────────

Write-Host "`nShutting down services..." -ForegroundColor Yellow
foreach ($proc in $procs) {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped PID $($proc.Id)" -ForegroundColor DarkGray
    }
}
Write-Host "Done." -ForegroundColor Green
