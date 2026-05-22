# SDLC Framework Update - check and update all dependencies
# Usage: .\bin\update.ps1 [-DryRun] [-ShowAll]

param(
    [switch]$DryRun,
    [switch]$ShowAll
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$sdlc-frameworkRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$issues = @()

Write-Host "`n🔧 SDLC Framework Dependency Update" -ForegroundColor Cyan
if ($DryRun) { Write-Host "  (DRY RUN - no changes will be made)" -ForegroundColor DarkGray }

# -----------------------------------------------------------------------
# 1. Node.js
# -----------------------------------------------------------------------
Write-Host "`n📦 [1/6] Node.js" -ForegroundColor Yellow
$nodeVersion = & node --version 2>$null
if ($nodeVersion) {
    $major = [int]($nodeVersion -replace '^v','').Split('.')[0]
    Write-Host "  ✅ Current: $nodeVersion" -ForegroundColor Green
    if ($major -lt 18) {
        $issues += "Node.js $nodeVersion is below minimum 18.x"
        Write-Host "  ❌ SDLC Framework requires Node.js 18+. Upgrade at https://nodejs.org" -ForegroundColor Red
    }
    try {
        $allVersions = Invoke-RestMethod "https://nodejs.org/dist/index.json" -TimeoutSec 5
        $latestLts = ($allVersions | Where-Object { $_.lts -and $_.lts -ne $false } | Select-Object -First 1)
        if ($latestLts -and $latestLts.version -ne $nodeVersion) {
            Write-Host "  ⬆️  Latest LTS: $($latestLts.version) ($($latestLts.lts))" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  Could not check latest version." -ForegroundColor DarkGray
    }
} else {
    $issues += "Node.js not installed"
    Write-Host "  ❌ NOT FOUND - install from https://nodejs.org" -ForegroundColor Red
}

# -----------------------------------------------------------------------
# 2. npm dependencies (root + MCP server)
# -----------------------------------------------------------------------
Write-Host "`n📦 [2/6] npm dependencies" -ForegroundColor Yellow

Write-Host "  Root package:" -ForegroundColor DarkGray
Push-Location $sdlc-frameworkRoot
try {
    $outdated = & npm outdated --json 2>$null | ConvertFrom-Json
    if ($outdated -and ($outdated | Get-Member -MemberType NoteProperty).Count -gt 0) {
        $breakingCount = 0
        $breakingPkgs = @()
        foreach ($prop in ($outdated | Get-Member -MemberType NoteProperty)) {
            $pkg = $prop.Name
            $info = $outdated.$pkg
            $current = $info.current
            $wanted = $info.wanted
            $latest = $info.latest
            $currentMajor = if ($current) { ($current -split '\.')[0] } else { "?" }
            $latestMajor = if ($latest) { ($latest -split '\.')[0] } else { "?" }
            $breaking = $currentMajor -ne $latestMajor -and $currentMajor -ne "?"
            $flag = if ($breaking) { " [BREAKING]" } else { "" }
            if ($breaking) {
                $breakingCount++
                $breakingPkgs += @{ name = $pkg; current = $current; latest = $latest }
            }
            Write-Host "    $pkg $current -> $latest$flag" -ForegroundColor $(if ($breaking) { "Red" } else { "DarkGray" })
        }
        $totalOutdated = ($outdated | Get-Member -MemberType NoteProperty).Count
        Write-Host "  $totalOutdated outdated, $breakingCount breaking major" -ForegroundColor $(if ($breakingCount -gt 0) { "Yellow" } else { "DarkGray" })
        if ($breakingCount -gt 0) {
            $issues += "$breakingCount npm packages have breaking major updates"
        }
        if (-not $DryRun) {
            Write-Host "  Updating non-breaking..." -ForegroundColor Yellow
            & npm update

            if ($breakingCount -gt 0) {
                Write-Host "`n  Creating Agility story for $breakingCount breaking updates..." -ForegroundColor Yellow

                $pkgList = ($breakingPkgs | ForEach-Object { "$($_.name) $($_.current)->$($_.latest)" }) -join ", "

                $storyName = "chore - upgrade $breakingCount breaking npm dependencies"
                $storyDesc = "bin/update.ps1 detected $breakingCount breaking major npm updates. Packages - $pkgList. Upgrade TypeScript first, then React+ReactDOM, then build tools, then remaining one at a time. Run tsc --noEmit after each."

                $configFile = Join-Path $sdlc-frameworkRoot ".sdlc-framework.config.json"
                $team = "Ninja Turtles"
                $owner = "Jason Bohan"
                if (Test-Path $configFile) {
                    $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
                    if ($cfg.project.team) { $team = $cfg.project.team }
                    if ($cfg.project.owners) { $owner = $cfg.project.owners[0] }
                }

                $storyBody = @{
                    name = $storyName
                    description = $storyDesc
                    estimate = $breakingCount
                    team = $team
                    owner = $owner
                    classOfService = "Standard"
                } | ConvertTo-Json -Compress -Depth 5

                try {
                    $storyResult = Invoke-RestMethod -Uri "http://localhost:3847/api/agility/create-story" -Method Post -Body $storyBody -ContentType "application/json" -TimeoutSec 120
                    if ($storyResult.number) {
                        Write-Host "  Story $($storyResult.number) created: $storyName" -ForegroundColor Green
                        Write-Host "  Assign to DevOps via the dashboard to start the upgrade." -ForegroundColor DarkGray
                    } else {
                        Write-Host "  Story created but no number returned. Check Agility." -ForegroundColor Yellow
                    }
                } catch {
                    Write-Host "  Dashboard not running or timed out." -ForegroundColor Yellow
                    Write-Host "  Start the dashboard (npm run dashboard) and re-run, or create manually:" -ForegroundColor DarkGray
                    Write-Host "    Name: $storyName" -ForegroundColor DarkGray
                    Write-Host "    Packages: $(($breakingPkgs | ForEach-Object { "$($_.name) $($_.current)->$($_.latest)" }) -join ', ')" -ForegroundColor DarkGray
                }
            }
        }
    } else {
        Write-Host "  ✅ All up to date." -ForegroundColor Green
    }
    if ($ShowAll) {
        Write-Host "  Installed packages:" -ForegroundColor DarkGray
        $lsJson = & npm ls --json --depth=0 2>$null | ConvertFrom-Json
        if ($lsJson.dependencies) {
            foreach ($prop in ($lsJson.dependencies | Get-Member -MemberType NoteProperty)) {
                $pkg = $prop.Name
                $ver = $lsJson.dependencies.$pkg.version
                if ($ver) { Write-Host "    $pkg@$ver" -ForegroundColor DarkGray }
            }
        }
    }
} finally {
    Pop-Location
}

$mcpAgilityDir = Join-Path $sdlc-frameworkRoot "tools\mcp-agility"
if (Test-Path (Join-Path $mcpAgilityDir "package.json")) {
    Write-Host "  MCP Agility server:" -ForegroundColor DarkGray
    Push-Location $mcpAgilityDir
    try {
        $mcpOutdated = & npm outdated --json 2>$null | ConvertFrom-Json
        if ($mcpOutdated -and ($mcpOutdated | Get-Member -MemberType NoteProperty).Count -gt 0) {
            foreach ($prop in ($mcpOutdated | Get-Member -MemberType NoteProperty)) {
                $pkg = $prop.Name
                $info = $mcpOutdated.$pkg
                $currentMajor = if ($info.current) { ($info.current -split '\.')[0] } else { "?" }
                $latestMajor = if ($info.latest) { ($info.latest -split '\.')[0] } else { "?" }
                $breaking = $currentMajor -ne $latestMajor -and $currentMajor -ne "?"
                $flag = if ($breaking) { " [BREAKING]" } else { "" }
                if ($breaking) { $issues += "MCP Agility: $pkg has breaking major update $($info.current) -> $($info.latest)" }
                Write-Host "    $pkg $($info.current) -> $($info.latest)$flag" -ForegroundColor $(if ($breaking) { "Red" } else { "DarkGray" })
            }
            if (-not $DryRun) {
                & npm update
            }
        } else {
            Write-Host "    ✅ All up to date." -ForegroundColor Green
        }
        if ($ShowAll) {
            Write-Host "    Installed packages:" -ForegroundColor DarkGray
            $mcpLsJson = & npm ls --json --depth=0 2>$null | ConvertFrom-Json
            if ($mcpLsJson.dependencies) {
                foreach ($prop in ($mcpLsJson.dependencies | Get-Member -MemberType NoteProperty)) {
                    $pkg = $prop.Name
                    $ver = $mcpLsJson.dependencies.$pkg.version
                    if ($ver) { Write-Host "      $pkg@$ver" -ForegroundColor DarkGray }
                }
            }
        }
    } finally {
        Pop-Location
    }
}

# -----------------------------------------------------------------------
# 3. Goose CLI
# -----------------------------------------------------------------------
Write-Host "`n🪿  [3/6] Goose CLI" -ForegroundColor Yellow
$gooseCmd = Get-Command goose -ErrorAction SilentlyContinue
if (-not $gooseCmd) {
    $gooseFallback = Join-Path $env:USERPROFILE ".local\bin\goose.exe"
    if (Test-Path $gooseFallback) { $gooseCmd = Get-Item $gooseFallback }
}
if ($gooseCmd) {
    $goosePath = if ($gooseCmd.Source) { $gooseCmd.Source } else { $gooseCmd.FullName }
    $gooseVer = & $goosePath --version 2>$null
    Write-Host "  ✅ Current: $gooseVer" -ForegroundColor Green
    if (-not $DryRun) {
        Write-Host "  Checking for updates..." -ForegroundColor DarkGray
        try {
            & $goosePath update 2>$null
            $newVer = & $goosePath --version 2>$null
            if ($newVer -ne $gooseVer) {
                Write-Host "  Updated: $newVer" -ForegroundColor Green
            } else {
                Write-Host "  Already latest." -ForegroundColor Green
            }
        } catch {
            Write-Host "  Update check failed." -ForegroundColor DarkGray
        }
    }

    $gooseConfigYaml = "$env:APPDATA\Block\goose\config\config.yaml"
    if (Test-Path $gooseConfigYaml) {
        $gooseConfig = Get-Content $gooseConfigYaml -Raw
        if ($gooseConfig -match 'GOOSE_PROVIDER:\s*(\S+)') {
            Write-Host "  Provider: $($Matches[1])" -ForegroundColor DarkGray
        } else {
            Write-Host "  No provider configured. Run 'goose configure' for Speed mode." -ForegroundColor Yellow
            $issues += "Goose has no cloud provider configured"
        }
    }
} else {
    Write-Host "  ⬜ Not installed (optional). Install: https://block.github.io/goose" -ForegroundColor DarkGray
}

# -----------------------------------------------------------------------
# 4. Ollama + models
# -----------------------------------------------------------------------
Write-Host "`n🦙 [4/6] Ollama" -ForegroundColor Yellow
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCmd) {
    $ollamaFallback = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $ollamaFallback) { $ollamaCmd = Get-Item $ollamaFallback }
}
if ($ollamaCmd) {
    $ollamaPath = if ($ollamaCmd.Source) { $ollamaCmd.Source } else { $ollamaCmd.FullName }
    Write-Host "  ✅ Found: $ollamaPath" -ForegroundColor Green

    try {
        $models = & $ollamaPath list 2>&1
        if ($LASTEXITCODE -eq 0) {
            $modelCount = ($models | Where-Object { $_ -match '\S' }).Count - 1
            Write-Host "  Models installed: $modelCount" -ForegroundColor DarkGray

            $hasQwen = $models | Where-Object { $_ -match 'qwen3' }
            if (-not $hasQwen) {
                Write-Host "  WARNING: qwen3:14b not found (used for story enrichment)." -ForegroundColor Yellow
                $issues += "Ollama missing recommended model qwen3:14b"
                if (-not $DryRun) {
                    $pull = Read-Host "  Pull qwen3:14b now? (y/N)"
                    if ($pull -eq 'y' -or $pull -eq 'Y') {
                        & $ollamaPath pull qwen3:14b
                    }
                }
            }

            $hasLlama = $models | Where-Object { $_ -match 'llama3\.2' }
            if (-not $hasLlama) {
                Write-Host "  WARNING: llama3.2:latest not found (used for agent delegation)." -ForegroundColor Yellow
                $issues += "Ollama missing recommended model llama3.2:latest"
                if (-not $DryRun) {
                    $pull = Read-Host "  Pull llama3.2:latest now? (y/N)"
                    if ($pull -eq 'y' -or $pull -eq 'Y') {
                        & $ollamaPath pull llama3.2:latest
                    }
                }
            }
        } else {
            Write-Host "  Ollama is installed but not running. Start with: ollama serve" -ForegroundColor Yellow
            $issues += "Ollama not running"
        }
    } catch {
        Write-Host "  Could not check Ollama models." -ForegroundColor DarkGray
    }
} else {
    Write-Host "  ⬜ Not installed (optional). Install: https://ollama.com/download" -ForegroundColor DarkGray
}

# -----------------------------------------------------------------------
# 5. Rust toolchain
# -----------------------------------------------------------------------
Write-Host "`n🦀 [5/6] Rust toolchain" -ForegroundColor Yellow
$rustcCmd = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rustcCmd) {
    $rustcFallback = Join-Path $env:USERPROFILE ".cargo\bin\rustc.exe"
    if (Test-Path $rustcFallback) { $rustcCmd = Get-Item $rustcFallback }
}
if ($rustcCmd) {
    $rustcPath = if ($rustcCmd.Source) { $rustcCmd.Source } else { $rustcCmd.FullName }
    $rustVer = & $rustcPath --version 2>$null
    Write-Host "  ✅ Current: $rustVer" -ForegroundColor Green

    $rustupCmd = Get-Command rustup -ErrorAction SilentlyContinue
    if (-not $rustupCmd) {
        $rustupFallback = Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe"
        if (Test-Path $rustupFallback) { $rustupCmd = Get-Item $rustupFallback }
    }
    $rustupPath = if ($rustupCmd.Source) { $rustupCmd.Source } elseif ($rustupCmd.FullName) { $rustupCmd.FullName } else { $null }
    if ($rustupPath) {
        if (-not $DryRun) {
            Write-Host "  Checking for updates..." -ForegroundColor DarkGray
            try {
                $updateOutput = & $rustupPath update stable 2>&1
                $newVer = & $rustcPath --version 2>$null
                if ($newVer -ne $rustVer) {
                    Write-Host "  Updated: $newVer" -ForegroundColor Green
                } else {
                    Write-Host "  Already latest." -ForegroundColor Green
                }
            } catch {
                Write-Host "  Update check failed." -ForegroundColor DarkGray
            }
        }

        $tauriTarget = "wasm32-unknown-unknown"
        $targets = & $rustupPath target list --installed 2>$null
        $hasWasm = $targets | Where-Object { $_ -match $tauriTarget }
        if (-not $hasWasm) {
            Write-Host "  Note: $tauriTarget target not installed (needed for some Tauri plugins)." -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  ⬜ Not installed (required for Tauri builds). Install: https://rustup.rs" -ForegroundColor DarkGray
}

# -----------------------------------------------------------------------
# 6. Configuration health check
# -----------------------------------------------------------------------
Write-Host "`n⚙️  [6/6] Configuration" -ForegroundColor Yellow

$envFile = Join-Path $sdlc-frameworkRoot ".env"
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match 'your-api-key-here' -or $envContent -match 'your-instance') {
        Write-Host "  ⚠️  .env has placeholder values - update with real credentials." -ForegroundColor Yellow
        $issues += ".env still has placeholder values"
    } else {
        Write-Host "  ✅ .env configured." -ForegroundColor Green
    }
} else {
    Write-Host "  ❌ .env missing - run .\bin\setup.ps1 or copy from .env.example" -ForegroundColor Red
    $issues += ".env file missing"
}

$configFile = Join-Path $sdlc-frameworkRoot ".sdlc-framework.config.json"
if (Test-Path $configFile) {
    $configContent = Get-Content $configFile -Raw
    if ($configContent -match 'your-azure-devops-org') {
        Write-Host "  ⚠️  .sdlc-framework.config.json has placeholder values." -ForegroundColor Yellow
        $issues += ".sdlc-framework.config.json still has placeholder values"
    } else {
        Write-Host "  ✅ .sdlc-framework.config.json configured." -ForegroundColor Green
    }
} else {
    Write-Host "  ❌ .sdlc-framework.config.json missing - run .\bin\setup.ps1" -ForegroundColor Red
    $issues += ".sdlc-framework.config.json missing"
}

$mcpJson = Join-Path $sdlc-frameworkRoot ".cursor\mcp.json"
if (Test-Path $mcpJson) {
    Write-Host "  ✅ .cursor/mcp.json present." -ForegroundColor Green
} else {
    Write-Host "  ❌ .cursor/mcp.json missing - MCP servers not configured." -ForegroundColor Red
    $issues += ".cursor/mcp.json missing"
}

$mcpNodeModules = Join-Path $sdlc-frameworkRoot "tools\mcp-agility\node_modules"
if (Test-Path $mcpNodeModules) {
    Write-Host "  ✅ MCP Agility deps installed." -ForegroundColor Green
} else {
    Write-Host "  ⚠️  MCP Agility deps missing - run 'npm install' or .\bin\setup.ps1" -ForegroundColor Yellow
    $issues += "MCP Agility node_modules missing"
}

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
Write-Host "`n📋 Summary" -ForegroundColor Cyan
if ($issues.Count -eq 0) {
    Write-Host "  ✨ Everything looks good!" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  $($issues.Count) issues found:" -ForegroundColor Yellow
    foreach ($issue in $issues) {
        Write-Host "    → $issue" -ForegroundColor Yellow
    }
}
Write-Host ""
