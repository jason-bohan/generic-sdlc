# SDLC Framework Setup - run once after cloning the repo
# Usage: .\bin\setup.ps1

$ErrorActionPreference = 'Stop'
$sdlc-frameworkRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

Write-Host "`n=== SDLC Framework Setup ===" -ForegroundColor Cyan

# 1. Verify Node.js
Write-Host "`n[1/8] Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = & node --version 2>$null
if ($nodeVersion) {
    $major = [int]($nodeVersion -replace '^v','').Split('.')[0]
    if ($major -ge 18) {
        Write-Host "  Node.js $nodeVersion - OK" -ForegroundColor Green
    } else {
        Write-Host "  Node.js $nodeVersion found but 18+ is required." -ForegroundColor Red
        Write-Host "  Install from https://nodejs.org" -ForegroundColor DarkGray
        exit 1
    }
} else {
    Write-Host "  Node.js not found! Install Node.js 18+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# 2. Check for Goose CLI (local AI agent - token efficiency mode)
Write-Host "`n[2/8] Checking for Goose CLI..." -ForegroundColor Yellow
Write-Host "  Goose lets SDLC Framework run AI workflows locally using Ollama," -ForegroundColor DarkGray
Write-Host "  avoiding cloud token usage. Required for 'Efficiency' mode." -ForegroundColor DarkGray

$gooseCmd = Get-Command goose -ErrorAction SilentlyContinue
if (-not $gooseCmd) {
    $gooseExe = @(
        "$env:USERPROFILE\.local\bin\goose.exe",
        "$env:LOCALAPPDATA\Programs\Goose\goose.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($gooseExe) {
        Write-Host "  Found Goose at: $gooseExe" -ForegroundColor Green
        $gooseDir = Split-Path $gooseExe -Parent
        $gooseLine = "`$env:PATH = `"$gooseDir;`$env:PATH`""
        if (-not ((Test-Path $PROFILE) -and (Get-Content $PROFILE -Raw) -match [regex]::Escape($gooseDir))) {
            $profileDir = Split-Path $PROFILE -Parent
            if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
            Add-Content -Path $PROFILE -Value "`n# Goose CLI`n$gooseLine"
        }
        $env:PATH = "$gooseDir;$env:PATH"
        $gooseVer = & $gooseExe --version 2>$null
        if ($gooseVer) { Write-Host "  Version: $gooseVer" -ForegroundColor DarkGray }
    } else {
        Write-Host ""
        $install = Read-Host "  Goose is not installed. Install it now? (y/N)"
        if ($install -eq 'y' -or $install -eq 'Y') {
            Write-Host "  Installing Goose via PowerShell..." -ForegroundColor Yellow
            try {
                Invoke-RestMethod https://github.com/block/goose/releases/latest/download/download_cli.ps1 | Invoke-Expression
                Write-Host "  Goose installed." -ForegroundColor Green
                $gooseVer = & goose --version 2>$null
                if ($gooseVer) { Write-Host "  Version: $gooseVer" -ForegroundColor DarkGray }
            } catch {
                Write-Host "  Install failed. Install manually: https://block.github.io/goose/docs/getting-started" -ForegroundColor Red
            }
        } else {
            Write-Host "  Skipping. Without Goose, only 'Balanced' and 'Speed' modes are available." -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  Goose found: $($gooseCmd.Source)" -ForegroundColor Green
    $gooseVer = & goose --version 2>$null
    if ($gooseVer) { Write-Host "  Version: $gooseVer" -ForegroundColor DarkGray }
    $updateGoose = Read-Host "  Check for updates? (y/N)"
    if ($updateGoose -eq 'y' -or $updateGoose -eq 'Y') {
        Write-Host "  Updating Goose..." -ForegroundColor Yellow
        try {
            & goose update 2>$null
            $newVer = & goose --version 2>$null
            Write-Host "  Version: $newVer" -ForegroundColor Green
        } catch {
            Write-Host "  Update check failed. Current version is fine." -ForegroundColor DarkGray
        }
    }
}

# 2b. Goose provider (local-mode story creation uses Goose + Ollama only - not OpenRouter)
$gooseConfigYaml = "$env:APPDATA\Block\goose\config\config.yaml"
if (Test-Path $gooseConfigYaml) {
    $gooseConfig = Get-Content $gooseConfigYaml -Raw
    if ($gooseConfig -match 'GOOSE_PROVIDER:\s*(\S+)') {
        $provider = $Matches[1]
        Write-Host "  Goose provider: $provider" -ForegroundColor Green
        if ($provider -eq 'ollama') {
            Write-Host "  Story creation in SDLC Framework uses Ollama for Goose recipes; dashboard balanced/speed use REST + Ollama enrichment." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  No GOOSE_PROVIDER set. Run 'goose configure' if you use Goose outside SDLC Framework story flows." -ForegroundColor Yellow
        Write-Host "  Optional: set GOOSE_PROVIDER to ollama for recipe runs aligned with SDLC Framework defaults." -ForegroundColor DarkGray
    }
} else {
    $gooseAvailable = Get-Command goose -ErrorAction SilentlyContinue
    if ($gooseAvailable) {
        Write-Host "  Goose config not found. Run 'goose configure' to set up a provider." -ForegroundColor Yellow
    }
}

# 2c. Configure Goose MCP extension and local Ollama provider
$gooseAvailableForMcp = Get-Command goose -ErrorAction SilentlyContinue
if ($gooseAvailableForMcp) {
    Write-Host "`n  Configuring SDLC Framework MCP extension for Goose..." -ForegroundColor Yellow

    # Resolve node.exe full path — Goose doesn't inherit nvs-managed PATH
    $nodeFullPath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
    if (-not $nodeFullPath) {
        $nvsBase = "$env:LOCALAPPDATA\nvs\node"
        if (Test-Path $nvsBase) {
            $nodeFullPath = Get-ChildItem $nvsBase -Filter "22.*" -Directory |
                Sort-Object Name -Descending |
                Select-Object -ExpandProperty FullName -First 1 |
                ForEach-Object { Join-Path $_ "x64\node.exe" } |
                Where-Object { Test-Path $_ } |
                Select-Object -First 1
        }
    }

    if (-not $nodeFullPath) {
        Write-Host "  Cannot find node.exe — skipping Goose MCP config. Re-run setup after installing Node." -ForegroundColor Yellow
    } else {
        $gooseConfigYaml = "$env:APPDATA\Block\goose\config\config.yaml"
        $mcpIndexPath = Join-Path $sdlc-frameworkRoot "tools\mcp-sdlc-framework\index.js"

        if (Test-Path $gooseConfigYaml) {
            $content = Get-Content $gooseConfigYaml -Raw
            if ($content -match 'name:\s*SDLC Framework') {
                Write-Host "  SDLC Framework MCP extension already in Goose config." -ForegroundColor Green
            } else {
                $extensionBlock = @"
  sdlc-framework:
    enabled: true
    type: stdio
    name: SDLC Framework
    description: SDLC Framework SDLC orchestration - assign stories, monitor agents, manage workflows, search Agility backlog
    cmd: $nodeFullPath
    args:
    - $mcpIndexPath
    envs:
      SDLC_FRAMEWORK_BASE_URL: http://localhost:3001
    env_keys: []
    timeout: 30
    bundled: null
    available_tools: []
"@
                # Insert before the first top-level settings key
                if ($content -match 'GOOSE_TELEMETRY_ENABLED') {
                    $content = $content -replace '(GOOSE_TELEMETRY_ENABLED)', "$extensionBlock`$1"
                } else {
                    $content = $content.TrimEnd() + "`n$extensionBlock"
                }
                Set-Content $gooseConfigYaml $content -NoNewline
                Write-Host "  SDLC Framework MCP extension added to Goose config." -ForegroundColor Green
                Write-Host "  Using node: $nodeFullPath" -ForegroundColor DarkGray
            }
        } else {
            Write-Host "  Goose config not found — run 'goose configure' first, then re-run setup." -ForegroundColor DarkGray
        }

        # Create Local Ollama custom provider if not already present
        $customProvidersDir = "$env:APPDATA\Block\goose\config\custom_providers"
        $flashhPath = Join-Path $customProvidersDir "custom_flashh.json"
        if (-not (Test-Path $flashhPath)) {
            if (-not (Test-Path $customProvidersDir)) {
                New-Item -ItemType Directory -Path $customProvidersDir -Force | Out-Null
            }
            @'
{
  "name": "custom_flashh",
  "engine": "openai",
  "display_name": "Local Ollama",
  "description": "Local Ollama instance",
  "api_key_env": "",
  "base_url": "http://localhost:11434/v1",
  "models": [
    { "name": "qwen3:14b", "context_limit": 128000, "input_token_cost": null, "output_token_cost": null, "currency": null, "supports_cache_control": null },
    { "name": "qwen3:8b",  "context_limit": 128000, "input_token_cost": null, "output_token_cost": null, "currency": null, "supports_cache_control": null }
  ],
  "headers": null,
  "timeout_seconds": null,
  "supports_streaming": true,
  "requires_auth": false
}
'@ | Set-Content $flashhPath
            Write-Host "  Created Local Ollama provider for Goose." -ForegroundColor Green
        } else {
            Write-Host "  Local Ollama provider already configured." -ForegroundColor Green
        }
    }
}

# 3. Check for Ollama (local LLM runner)
Write-Host "`n[3/8] Checking for Ollama..." -ForegroundColor Yellow
Write-Host "  Ollama runs local AI models for story enrichment" -ForegroundColor DarkGray
Write-Host "  and agent delegation. Required for 'Efficiency' and 'Balanced' modes." -ForegroundColor DarkGray

$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCmd) {
    $ollamaExe = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "C:\Users\$env:USERNAME\AppData\Local\Programs\Ollama\ollama.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($ollamaExe) {
        Write-Host "  Found Ollama at: $ollamaExe" -ForegroundColor Green
        $ollamaDir = Split-Path $ollamaExe -Parent
        $ollamaLine = "`$env:PATH = `"$ollamaDir;`$env:PATH`""
        if (-not ((Test-Path $PROFILE) -and (Get-Content $PROFILE -Raw) -match [regex]::Escape($ollamaDir))) {
            $profileDir = Split-Path $PROFILE -Parent
            if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
            Add-Content -Path $PROFILE -Value "`n# Ollama`n$ollamaLine"
        }
        $env:PATH = "$ollamaDir;$env:PATH"
    } else {
        Write-Host ""
        $install = Read-Host "  Ollama is not installed. Install it now? (y/N)"
        if ($install -eq 'y' -or $install -eq 'Y') {
            Write-Host "  Downloading Ollama installer..." -ForegroundColor Yellow
            $installerUrl = "https://ollama.com/download/OllamaSetup.exe"
            $installerPath = Join-Path $env:TEMP "OllamaSetup.exe"
            try {
                Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
                Write-Host "  Running installer (follow the prompts)..." -ForegroundColor Yellow
                Start-Process -FilePath $installerPath -Wait
                Write-Host "  Ollama installed." -ForegroundColor Green
            } catch {
                Write-Host "  Download failed. Install manually from https://ollama.com/download" -ForegroundColor Red
            }
        } else {
            Write-Host "  Skipping. Without Ollama, only 'Speed' mode is available." -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  Ollama found: $($ollamaCmd.Source)" -ForegroundColor Green
}

# Pull recommended models for Ollama
$ollamaReady = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaReady) {
    try {
        $models = & ollama list 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Installed models:" -ForegroundColor DarkGray
            $models | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

            $hasQwen = $models | Where-Object { $_ -match 'qwen3' }
            if (-not $hasQwen) {
                $pullModel = Read-Host "  Recommended model qwen3:14b not found. Pull it now? (y/N)"
                if ($pullModel -eq 'y' -or $pullModel -eq 'Y') {
                    Write-Host "  Pulling qwen3:14b (this may take a few minutes)..." -ForegroundColor Yellow
                    & ollama pull qwen3:14b
                }
            }
        } else {
            Write-Host "  Ollama is installed but not running. Start it with: ollama serve" -ForegroundColor DarkGray
            $pullModel = Read-Host "  Start Ollama and pull qwen3:14b? (y/N)"
            if ($pullModel -eq 'y' -or $pullModel -eq 'Y') {
                Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
                Start-Sleep -Seconds 3
                Write-Host "  Pulling qwen3:14b..." -ForegroundColor Yellow
                & ollama pull qwen3:14b
            }
        }
    } catch {
        Write-Host "  Could not check Ollama models." -ForegroundColor DarkGray
    }
}

# 4. Detect available IDE CLI and determine agent driver
Write-Host "`n[4/9] Detecting IDE agent CLI..." -ForegroundColor Yellow
Write-Host "  SDLC Framework uses an IDE CLI to spawn agents and run inline AI queries." -ForegroundColor DarkGray
Write-Host "  Supported: Cursor ('agent'), Claude Code ('claude'), Goose, or a custom CLI." -ForegroundColor DarkGray

$hasCursor = $false
$hasClaudeCode = $false
$detectedDriver = 'cursor'  # default

$agentCmd = Get-Command agent -ErrorAction SilentlyContinue
if ($agentCmd) {
    $hasCursor = $true
    Write-Host "  Cursor agent CLI found: $($agentCmd.Source)" -ForegroundColor Green
    $agentVer = & agent --version 2>$null
    if ($agentVer) { Write-Host "    Version: $agentVer" -ForegroundColor DarkGray }
} else {
    $cursorShim = Join-Path $env:LOCALAPPDATA "cursor-agent\bin\agent.cmd"
    if (Test-Path $cursorShim) {
        $hasCursor = $true
        Write-Host "  Cursor agent CLI found (shim): $cursorShim" -ForegroundColor Green
    }
}

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    $claudeNpm = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $claudeNpm) { $claudeCmd = [pscustomobject]@{ Source = $claudeNpm } }
}
if ($claudeCmd) {
    $hasClaudeCode = $true
    Write-Host "  Claude Code CLI found: $($claudeCmd.Source)" -ForegroundColor Green
    $claudeVer = & claude --version 2>$null
    if ($claudeVer) { Write-Host "    Version: $claudeVer" -ForegroundColor DarkGray }
}

# Determine driver — prefer whichever is available; if both, ask
if ($hasCursor -and $hasClaudeCode) {
    Write-Host ""
    Write-Host "  Both Cursor and Claude Code CLIs are available." -ForegroundColor Cyan
    $driverChoice = Read-Host "  Which driver should SDLC Framework use? (cursor/claude-code) [cursor]"
    $detectedDriver = if ($driverChoice -eq 'claude-code') { 'claude-code' } else { 'cursor' }
} elseif ($hasClaudeCode) {
    $detectedDriver = 'claude-code'
    Write-Host "  Will use Claude Code as the agent driver." -ForegroundColor Cyan
} elseif ($hasCursor) {
    $detectedDriver = 'cursor'
    Write-Host "  Will use Cursor as the agent driver." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "  No IDE CLI found. You can install one:" -ForegroundColor Yellow
    Write-Host "    Cursor:      irm 'https://cursor.com/install?win32=true' | iex" -ForegroundColor DarkGray
    Write-Host "    Claude Code: npm install -g @anthropic-ai/claude-code" -ForegroundColor DarkGray
    Write-Host "  Without a CLI, SDLC handoffs require manual agent starts." -ForegroundColor DarkGray
    $installChoice = Read-Host "  Install Claude Code now? (y/N)"
    if ($installChoice -eq 'y' -or $installChoice -eq 'Y') {
        Write-Host "  Installing Claude Code CLI..." -ForegroundColor Yellow
        try {
            npm install -g "@anthropic-ai/claude-code"
            $detectedDriver = 'claude-code'
            Write-Host "  Claude Code installed." -ForegroundColor Green
        } catch {
            Write-Host "  Install failed: $_" -ForegroundColor Red
        }
    }
}

# 5. Check for Python / Harlequin (SQLite TUI)
Write-Host "`n[5/10] Checking for Python / Harlequin..." -ForegroundColor Yellow
Write-Host "  Harlequin is a terminal SQL IDE for inspecting the" -ForegroundColor DarkGray
Write-Host "  SDLC Framework SQLite database (token ledger, chat, Ollama state)." -ForegroundColor DarkGray

$pythonExe = @(
    (Get-Command python -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($pythonExe) {
    $pyVer = & $pythonExe --version 2>$null
    Write-Host "  Python found: $pyVer ($pythonExe)" -ForegroundColor Green

    $harlequinExe = @(
        (Get-Command harlequin -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\harlequin.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts\harlequin.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if ($harlequinExe) {
        Write-Host "  Harlequin found: $harlequinExe" -ForegroundColor Green
    } else {
        $installHq = Read-Host "  Harlequin not installed. Install it now? (y/N)"
        if ($installHq -eq 'y' -or $installHq -eq 'Y') {
            Write-Host "  Installing Harlequin..." -ForegroundColor Yellow
            & $pythonExe -m pip install harlequin 2>&1 | Out-Null
            Write-Host "  Harlequin installed. Run: npm run db" -ForegroundColor Green
        } else {
            Write-Host "  Skipping. Install later: pip install harlequin" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  Python not found. Install Python 3.11+ for Harlequin:" -ForegroundColor DarkGray
    Write-Host "    winget install Python.Python.3.12" -ForegroundColor DarkGray
    Write-Host "  Then: pip install harlequin" -ForegroundColor DarkGray
}

# 6. Install Node dependencies
Write-Host "`n[6/10] Installing dependencies..." -ForegroundColor Yellow
Push-Location $sdlc-frameworkRoot
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally {
    Pop-Location
}
Write-Host "  Done." -ForegroundColor Green

# 7. Install MCP server dependencies
Write-Host "`n[7/10] Installing MCP server dependencies..." -ForegroundColor Yellow
foreach ($mcpName in @('mcp-agility', 'mcp-sdlc-framework')) {
    $mcpDir = Join-Path $sdlc-frameworkRoot "tools\$mcpName"
    if (Test-Path (Join-Path $mcpDir "package.json")) {
        Push-Location $mcpDir
        try {
            npm install --production
            if ($LASTEXITCODE -ne 0) { throw "npm install failed for $mcpName" }
        } finally {
            Pop-Location
        }
        Write-Host "  $mcpName ready." -ForegroundColor Green
    } else {
        Write-Host "  tools/$mcpName not found - skipping." -ForegroundColor DarkGray
    }
}

# 8. Create .env from .env.example if missing
$envFile = Join-Path $sdlc-frameworkRoot ".env"
$envExample = Join-Path $sdlc-frameworkRoot ".env.example"

if (Test-Path $envFile) {
    Write-Host "`n[8/10] .env already exists - checking for AZURE_DEVOPS_PAT..." -ForegroundColor Yellow
    $envContent = Get-Content $envFile -Raw
    if ($envContent -notmatch 'AZURE_DEVOPS_PAT=\S') {
        Write-Host "  AZURE_DEVOPS_PAT is not set. Required for autonomous SDLC" -ForegroundColor Yellow
        Write-Host "  (PR creation, build polling, auto-complete)." -ForegroundColor DarkGray
        Write-Host "  Generate at: https://<org>.visualstudio.com/_usersSettings/tokens" -ForegroundColor DarkGray
        Write-Host "  Scopes: Code (Read & Write), Build (Read & Execute)" -ForegroundColor DarkGray
        $adoPat = Read-Host "  AZURE_DEVOPS_PAT (press Enter to skip)"
        if ($adoPat) {
            if ($envContent -match '# AZURE_DEVOPS_PAT=') {
                (Get-Content $envFile) -replace '# AZURE_DEVOPS_PAT=.*', "AZURE_DEVOPS_PAT=$adoPat" |
                    Set-Content $envFile
            } else {
                Add-Content -Path $envFile -Value "`nAZURE_DEVOPS_PAT=$adoPat"
            }
            Write-Host "  PAT saved to .env" -ForegroundColor Green
        } else {
            Write-Host "  Skipping. ADO bridge will be disabled (no autonomous PR/build flow)." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  AZURE_DEVOPS_PAT is set." -ForegroundColor Green
    }
} else {
    Write-Host "`n[8/10] Creating .env from .env.example..." -ForegroundColor Yellow
    Copy-Item $envExample $envFile

    Write-Host "  Fill in your credentials:" -ForegroundColor DarkGray
    Write-Host "    AGILITY_BASE_URL   - Your VersionOne/Agility REST API base URL" -ForegroundColor DarkGray
    Write-Host "    AGILITY_API_KEY    - Your personal Agility API token" -ForegroundColor DarkGray
    Write-Host "    AZURE_DEVOPS_PAT   - Azure DevOps Personal Access Token" -ForegroundColor DarkGray
    Write-Host "                         (Code R/W + Build R/Execute scopes)" -ForegroundColor DarkGray
    Write-Host "                         Generate at: https://<org>.visualstudio.com/_usersSettings/tokens" -ForegroundColor DarkGray
    Write-Host ""

    $baseUrl = Read-Host "  AGILITY_BASE_URL (press Enter to skip)"
    $apiKey  = Read-Host "  AGILITY_API_KEY  (press Enter to skip)"
    $adoPat  = Read-Host "  AZURE_DEVOPS_PAT (press Enter to skip)"

    if ($baseUrl) {
        (Get-Content $envFile) -replace 'AGILITY_BASE_URL=.*', "AGILITY_BASE_URL=$baseUrl" |
            Set-Content $envFile
    }
    if ($apiKey) {
        (Get-Content $envFile) -replace 'AGILITY_API_KEY=.*', "AGILITY_API_KEY=$apiKey" |
            Set-Content $envFile
    }
    if ($adoPat) {
        (Get-Content $envFile) -replace '# AZURE_DEVOPS_PAT=.*', "AZURE_DEVOPS_PAT=$adoPat" |
            Set-Content $envFile
    }
    Write-Host "  .env created. Edit it later at: $envFile" -ForegroundColor Green
}

# 9. Create .sdlc-framework.config.json from template if missing, then write detected driver
$configFile = Join-Path $sdlc-frameworkRoot ".sdlc-framework.config.json"
$configExample = Join-Path $sdlc-frameworkRoot ".sdlc-framework.config.example.json"

if (-not (Test-Path $configFile)) {
    if (Test-Path $configExample) {
        Write-Host "`n[9/10] Creating .sdlc-framework.config.json from template..." -ForegroundColor Yellow
        Copy-Item $configExample $configFile
        Write-Host "  Edit $configFile with your org, project, and owner info." -ForegroundColor Green
    } else {
        Write-Host "`n[9/10] No config template found - .sdlc-framework.config.json must already exist." -ForegroundColor Yellow
    }
} else {
    Write-Host "`n[9/10] .sdlc-framework.config.json already exists." -ForegroundColor Yellow
}

# Write detected driver into config
if (Test-Path $configFile) {
    try {
        $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
        if (-not $cfg.scheduler) { $cfg | Add-Member -NotePropertyName scheduler -NotePropertyValue ([pscustomobject]@{}) -Force }
        $currentDriver = $cfg.scheduler.driver
        if ($currentDriver -and $currentDriver -ne $detectedDriver) {
            Write-Host "  Config already has driver='$currentDriver'. Keeping existing setting." -ForegroundColor DarkGray
        } else {
            $cfg.scheduler | Add-Member -NotePropertyName driver -NotePropertyValue $detectedDriver -Force
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $configFile
            Write-Host "  Set scheduler.driver = '$detectedDriver' in config." -ForegroundColor Green
        }
    } catch {
        Write-Host "  Could not update scheduler.driver in config: $_" -ForegroundColor Yellow
    }
}

# 10. Configure project workspace paths
Write-Host "`n[10/11] Configuring project workspace paths..." -ForegroundColor Yellow
Write-Host "  SDLC Framework agents need to know where project repos live on your machine." -ForegroundColor DarkGray
Write-Host "  This enables reading coding standards, Cypress tests, and wiki lookups." -ForegroundColor DarkGray

if (Test-Path $configFile) {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json

    foreach ($projName in @($config.projects.PSObject.Properties.Name)) {
        $proj = $config.projects.$projName
        $currentPath = $proj.workspacePath

        if ($currentPath -and (Test-Path $currentPath)) {
            Write-Host "  $projName workspace: $currentPath (OK)" -ForegroundColor Green
        } else {
            Write-Host ""
            if ($currentPath) {
                Write-Host "  $projName workspace path '$currentPath' does not exist!" -ForegroundColor Red
            }
            $newPath = Read-Host "  Enter workspace path for '$projName' (e.g. c:\repos\$projName) or press Enter to skip"
            if ($newPath -and (Test-Path $newPath)) {
                $proj.workspacePath = $newPath
                $config | ConvertTo-Json -Depth 10 | Set-Content $configFile
                Write-Host "  Set $projName workspace to: $newPath" -ForegroundColor Green
            } elseif ($newPath) {
                Write-Host "  Path '$newPath' does not exist. Skipping — set it manually in .sdlc-framework.config.json" -ForegroundColor Yellow
            } else {
                Write-Host "  Skipping. Set projects.$projName.workspacePath in .sdlc-framework.config.json later." -ForegroundColor DarkGray
            }
        }
    }

    # Add project-specific workspace discovery here if needed.
    # Example: scan for .cursor/rules/*.mdc in each project workspace.
} else {
    Write-Host "  .sdlc-framework.config.json not found — skipping workspace path setup." -ForegroundColor DarkGray
    Write-Host "  Run setup again after creating the config file." -ForegroundColor DarkGray
}

# 11. Add bin/ to PATH in PowerShell profile
$binDir = Join-Path $sdlc-frameworkRoot "bin"
$profileDir = Split-Path $PROFILE -Parent
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

$pathLine = "`$env:PATH = `"$binDir;`$env:PATH`""
if ((Test-Path $PROFILE) -and (Get-Content $PROFILE -Raw) -match [regex]::Escape($binDir)) {
    Write-Host "`n[11/11] bin/ already in PowerShell profile - skipping." -ForegroundColor Yellow
} else {
    Write-Host "`n[11/11] Adding bin/ to PowerShell profile..." -ForegroundColor Yellow
    Add-Content -Path $PROFILE -Value "`n# SDLC Framework CLI`n$pathLine"
    Write-Host "  Added to $PROFILE" -ForegroundColor Green
}

Write-Host "`n=== Setup complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Agent driver: $detectedDriver" -ForegroundColor Cyan
Write-Host "  Change anytime: set scheduler.driver in .sdlc-framework.config.json" -ForegroundColor DarkGray
Write-Host "  Options: cursor | claude-code | goose | generic" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Execution Modes:" -ForegroundColor White
Write-Host "  Efficiency - Goose + Ollama (zero cloud tokens, needs both)" -ForegroundColor DarkGray
Write-Host "  Balanced   - Ollama enrichment + direct API (needs Ollama)" -ForegroundColor DarkGray
Write-Host "  Speed      - Cloud AI via IDE CLI (uses cloud tokens, needs agent CLI)" -ForegroundColor DarkGray
Write-Host "  Set mode in the TUI (Mainframe > Execution mode) or GUI dropdown" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Restart your terminal so 'sdlc-framework', 'goose', 'ollama', and 'claude'/'agent' are on PATH" -ForegroundColor DarkGray
Write-Host "  2. Edit .env with your Agility API credentials (if skipped above)" -ForegroundColor DarkGray
Write-Host "  3. Edit .sdlc-framework.config.json with your org, project, and team info" -ForegroundColor DarkGray
Write-Host "  4. Run 'npm run server' and open http://localhost:3001 for Scalar API docs" -ForegroundColor DarkGray
Write-Host "  5. Run 'npm run dashboard' to start the 3D office" -ForegroundColor DarkGray
Write-Host "  6. Run 'sdlc-framework' from any directory to use the TUI" -ForegroundColor DarkGray
Write-Host "  7. Run 'npm run db' to inspect the SQLite database with Harlequin" -ForegroundColor DarkGray
Write-Host ""
