<#
.SYNOPSIS
    Run the full SDLC Framework test suite in an isolated Docker environment.

.DESCRIPTION
    Lifecycle:
    1. Start an isolated server container (mock mode, no Ollama) on a random port
    2. Run vitest unit tests on the host (they manage their own in-process servers)
    3. Start the Vite dashboard pointing at the container
    4. Run Cypress E2E tests against the container API + host Vite dashboard
    5. Tear down the container (use -KeepUp to skip)

    Each invocation gets a fresh database (tmpfs inside the container) so
    tests are reproducible and don't interfere with dev state.

.PARAMETER ServerPort
    If the stack is already running (via docker-up.ps1), pass its port to skip
    starting a new container. Reads from .sdlc-framework/docker-ports.json if present.

.PARAMETER CypressOnly
    Skip vitest, only run Cypress E2E tests.

.PARAMETER UnitOnly
    Skip Cypress, only run vitest unit tests.

.PARAMETER KeepUp
    Don't tear down the container after tests (useful for debugging).

.PARAMETER Open
    Open Cypress in interactive mode instead of headless run.

.PARAMETER Spec
    Run only these Cypress specs (paths relative to repo root or under cypress/e2e/).
    May be passed multiple times or as a comma-separated list.

.EXAMPLE
    .\bin\docker-test.ps1                  # full suite, fresh container
    .\bin\docker-test.ps1 -CypressOnly     # just e2e
    .\bin\docker-test.ps1 -UnitOnly        # just unit tests (no Docker needed)
    .\bin\docker-test.ps1 -KeepUp          # leave container running after
    .\bin\docker-test.ps1 -Open            # open Cypress UI
    .\bin\docker-test.ps1 -CypressOnly -Spec chat-panel.cy.ts,reviewer-desk.cy.ts
#>
param(
    [int]$ServerPort = 0,
    [switch]$CypressOnly,
    [switch]$UnitOnly,
    [switch]$KeepUp,
    [switch]$Open,
    [string[]]$Spec = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-AzureSection {
    param([string]$Title)
    Write-Host ""
    Write-Host "##[section]$Title"
    Write-Host "> $Title" -ForegroundColor Cyan
}

function Write-AzureGroup {
    param([string]$Title)
    Write-Host "##[group]$Title"
}

function Write-AzureEndGroup {
    Write-Host "##[endgroup]"
}

function Write-AzureWarning {
    param([string]$Message)
    Write-Host "##[warning]$Message"
    Write-Warning $Message
}

function Write-AzureError {
    param([string]$Message)
    Write-Host "##[error]$Message"
    Write-Error $Message
}

$worktreeRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $worktreeRoot) { Write-Error "Not inside a git repository."; exit 1 }

$worktreeName = [System.IO.Path]::GetFileName($worktreeRoot) -replace '[^a-zA-Z0-9]', '-'
# Use a test-specific project name so this stack is separate from the dev stack
$projectName  = "sdlc-framework-test-$worktreeName".ToLower() -replace '-+', '-'

$ownedContainer = $false

# ── Resolve server port ───────────────────────────────────────────────────────
if ($ServerPort -eq 0) {
    # Check if caller passed a port file from a running stack
    $portsFile = Join-Path (Join-Path $worktreeRoot '.sdlc-framework') 'docker-ports.json'
    if ((Test-Path $portsFile) -and -not $CypressOnly) {
        $ports = Get-Content $portsFile | ConvertFrom-Json
        $ServerPort = $ports.serverPort
        Write-Host "  Reusing existing stack on port $ServerPort" -ForegroundColor DarkGray
    }
}

# ── Start test container if needed ───────────────────────────────────────────
if (-not $UnitOnly -and $ServerPort -eq 0) {
    Write-AzureSection "Docker test server"
    $env:COMPOSE_PROJECT_NAME = $projectName
    New-Item -ItemType Directory -Force -Path (Join-Path $worktreeRoot '.sdlc-framework') | Out-Null

    Write-AzureGroup "Build image and start server-only mock stack ($projectName)"
    docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --detach --wait --wait-timeout 120 --no-deps server
    $dockerExit = $LASTEXITCODE
    Write-AzureEndGroup
    if ($dockerExit -ne 0) { Write-AzureError "Failed to start test container"; exit 1 }
    $ownedContainer = $true

    Write-AzureGroup "Resolve server port"
    $binding = docker compose -f docker-compose.yml -f docker-compose.test.yml port server 3001 2>$null
    $ServerPort = [int](($binding -split ':')[1])
    Write-Host "  Test server -> http://localhost:$ServerPort" -ForegroundColor DarkGray
    # Container writes internal 3001 to .dev-port; Vite on the host must proxy to the published port.
    $devPortFile = Join-Path (Join-Path $worktreeRoot '.sdlc-framework') '.dev-port'
    Set-Content -Path $devPortFile -Value $ServerPort -NoNewline
    Write-AzureEndGroup
}

$exitCode = 0

# ── Unit tests (vitest) ───────────────────────────────────────────────────────
if (-not $CypressOnly) {
    Write-AzureSection "Unit tests (Vitest)"
    Write-AzureGroup "Run npm test"
    npm run test
    Write-AzureEndGroup
    if ($LASTEXITCODE -ne 0) {
        Write-AzureWarning "Unit tests failed (exit $LASTEXITCODE)"
        $exitCode = $LASTEXITCODE
    }
}

# ── E2E tests (Cypress) ───────────────────────────────────────────────────────
if (-not $UnitOnly -and $ServerPort -ne 0) {
    Write-AzureSection "Vite dashboard"

    # Use a dedicated Vite port so we do not collide with a dev `npm run dev` on 3847
    # (which often proxies to localhost:3001 while Cypress seeds the Docker API port).
    $vitePort = $ServerPort + 1000

    Write-AzureGroup "Start dashboard on port $vitePort"
    $viteJob = Start-Job -ScriptBlock {
        param($apiPort, $dashboardPort, $root)
        Set-Location $root
        $env:SDLC_API_PORT = "$apiPort"
        $env:SDLC_VITE_PORT = "$dashboardPort"
        npm run dashboard
    } -ArgumentList $ServerPort, $vitePort, $worktreeRoot
    Write-AzureEndGroup

    # Wait for Vite to be ready
    Write-AzureGroup "Wait for dashboard readiness"
    Write-Host "  Waiting for Vite on port $vitePort..." -ForegroundColor DarkGray
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:$vitePort" -TimeoutSec 1 -ErrorAction Stop
            $ready = $true; break
        } catch {}
    }
    Write-AzureEndGroup

    if (-not $ready) {
        Write-AzureWarning "Vite did not start within 30s - skipping Cypress"
    } else {
        Write-AzureSection "Cypress E2E"
        $env:CYPRESS_BASE_URL = "http://localhost:$vitePort"
        $env:CYPRESS_API_URL  = "http://localhost:$ServerPort"

        Write-AzureGroup "Run Cypress"
        $cypressArgs = @()
        if ($Spec.Count -gt 0) {
            $specPaths = foreach ($item in ($Spec -join ',').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) {
                if ($item -match '[/\\]') { $item } else { "cypress/e2e/$item" }
            }
            $cypressArgs += '--spec', ($specPaths -join ',')
            Write-Host "  Specs: $($specPaths -join ', ')" -ForegroundColor DarkGray
        }
        if ($Open) {
            if ($cypressArgs.Count -gt 0) { Write-AzureWarning "-Spec is ignored in -Open mode; pick specs in the Cypress UI." }
            npx cypress open
        } else {
            if ($cypressArgs.Count -gt 0) { npx cypress run @cypressArgs } else { npx cypress run }
        }
        Write-AzureEndGroup
        if ($LASTEXITCODE -ne 0) {
            Write-AzureWarning "Cypress tests failed (exit $LASTEXITCODE)"
            if ($exitCode -eq 0) { $exitCode = $LASTEXITCODE }
        }
    }

    # Stop Vite
    Stop-Job $viteJob -ErrorAction SilentlyContinue
    Remove-Job $viteJob -ErrorAction SilentlyContinue
}

# ── Tear down ─────────────────────────────────────────────────────────────────
if ($ownedContainer -and -not $KeepUp) {
    Write-AzureSection "E2E cleanup"
    Write-AzureGroup "Remove Docker test stack"
    $env:COMPOSE_PROJECT_NAME = $projectName
    docker compose -f docker-compose.yml -f docker-compose.test.yml down --volumes 2>$null
    Write-AzureEndGroup
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-AzureSection "Test summary"
if ($exitCode -eq 0) {
    Write-Host "PASS: All tests passed" -ForegroundColor Green
} else {
    Write-Host "##[error]Tests failed (exit $exitCode)"
    Write-Host "FAIL: Tests failed (exit $exitCode)" -ForegroundColor Red
}
exit $exitCode
