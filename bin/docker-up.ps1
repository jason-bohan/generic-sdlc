<#
.SYNOPSIS
    Start an isolated SDLC Framework dev stack for the current worktree.

.DESCRIPTION
    Derives a unique COMPOSE_PROJECT_NAME from the current git worktree path
    so each worktree gets its own server, database, and Ollama instance.
    Ollama model storage is shared globally across all stacks to avoid
    re-downloading models.

    After startup, writes port assignments to .sdlc-framework/docker-ports.json
    and prints the commands needed to start Vite pointing at the container.

.EXAMPLE
    .\bin\docker-up.ps1
    .\bin\docker-up.ps1 -Detach $false   # run in foreground (shows logs)
    .\bin\docker-up.ps1 -MockMode        # force mock external mode
    .\bin\docker-up.ps1 -MeshLLM         # also start the MeshLLM client container
    .\bin\docker-up.ps1 -MeshLLMModel Qwen3-8B-Q4_K_M
    .\bin\docker-up.ps1 -MeshLLMModel C:\models\custom-model.gguf
#>
param(
    [switch]$Detach = $true,
    [switch]$MockMode,
    [switch]$MeshLLM,
    [string]$MeshLLMModel = '',
    [switch]$Help
)

if ($Help) { Get-Help $MyInvocation.MyCommand.Definition -Full; exit 0 }

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Derive project name from worktree directory ───────────────────────────────
$worktreeRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $worktreeRoot) { Write-Error "Not inside a git repository."; exit 1 }

$worktreeName = [System.IO.Path]::GetFileName($worktreeRoot) -replace '[^a-zA-Z0-9]', '-'
$projectName  = "sdlc-framework-$worktreeName".ToLower() -replace '-+', '-'
$env:COMPOSE_PROJECT_NAME = $projectName

Write-Host "▶ Starting stack: $projectName" -ForegroundColor Cyan

# ── External mode ─────────────────────────────────────────────────────────────
if ($MockMode) { $env:SDLC_EXTERNAL_MODE = 'mock' }
if ($MeshLLMModel) { $MeshLLM = $true }

# ── Ensure Docker daemon is running ───────────────────────────────────────────
function Test-DockerRunning {
    try { docker info 2>$null | Out-Null; return $LASTEXITCODE -eq 0 } catch { return $false }
}

function Test-DockerImage {
    param([Parameter(Mandatory = $true)][string]$Image)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        docker image inspect $Image *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

if (-not (Test-DockerRunning)) {
    $dockerDesktopPaths = @(
        'C:\Program Files\Docker\Docker\Docker Desktop.exe',
        'C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe'
    )
    $exePath = $dockerDesktopPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $exePath) {
        Write-Error "Docker Desktop not found and the daemon is not running. Please start Docker Desktop manually."
        exit 1
    }

    Write-Host "  Docker Desktop not running — starting it…" -ForegroundColor DarkGray
    Start-Process -FilePath $exePath -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-DockerRunning) { $ready = $true; break }
    }

    if (-not $ready) {
        Write-Error "Docker Desktop did not become ready within 60 s. Please start it manually and retry."
        exit 1
    }

    Write-Host "  Docker daemon ready" -ForegroundColor DarkGray
}

# ── GPU detection ─────────────────────────────────────────────────────────────
$composeFiles = @('-f', 'docker-compose.yml')
try {
    $null = nvidia-smi 2>$null
    Write-Host "  GPU detected — enabling NVIDIA passthrough" -ForegroundColor DarkGray
    $composeFiles += @('-f', 'docker-compose.gpu.yml')
} catch {
    Write-Host "  No GPU detected — Ollama will run on CPU" -ForegroundColor DarkGray
}

# ── Build MeshLLM image on host if needed (requires BuildKit on host) ─────────
if ($MeshLLM) {
    $meshImage = 'sdlc-framework-mesh-llm:client'
    if (-not (Test-DockerImage $meshImage)) {
        Write-Host "  Building MeshLLM client image (first run — may take a few minutes)…" -ForegroundColor DarkGray
        docker build -t $meshImage -f docker/Dockerfile.client --build-arg CMD=console https://github.com/Mesh-LLM/mesh-llm.git#main
        if ($LASTEXITCODE -ne 0) { Write-Error "MeshLLM image build failed"; exit 1 }
        Write-Host "  MeshLLM image ready" -ForegroundColor DarkGray
    }
}

# ── Optional local MeshLLM model serving ──────────────────────────────────────
if ($MeshLLMModel) {
    $composeFiles += @('-f', 'docker-compose.meshllm-local.yml')
    $env:MESHLLM_IMAGE = 'sdlc-framework-mesh-llm:cuda'
    if (-not (Test-DockerImage $env:MESHLLM_IMAGE)) {
        Write-Host "  Building MeshLLM CUDA runtime image…" -ForegroundColor DarkGray
        docker build -t $env:MESHLLM_IMAGE -f docker/Dockerfile.meshllm-cuda .
        if ($LASTEXITCODE -ne 0) { Write-Error "MeshLLM CUDA image build failed"; exit 1 }
        Write-Host "  MeshLLM CUDA image ready" -ForegroundColor DarkGray
    }
    if (Test-Path -LiteralPath $MeshLLMModel) {
        $resolvedModel = Resolve-Path -LiteralPath $MeshLLMModel
        $modelFile = Get-Item -LiteralPath $resolvedModel
        if ($modelFile.PSIsContainer) {
            Write-Error "-MeshLLMModel must be a model name, Hugging Face ref, URL, or local model file, not a directory."
            exit 1
        }
        $env:MESHLLM_MODEL_DIR = $modelFile.DirectoryName
        $env:MESHLLM_MODEL_ARG = '--gguf'
        $env:MESHLLM_MODEL = "/models/$($modelFile.Name)"
        Write-Host "  Publishing local MeshLLM model: $($modelFile.FullName)" -ForegroundColor DarkGray
    } else {
        $env:MESHLLM_MODEL_ARG = '--model'
        $env:MESHLLM_MODEL = $MeshLLMModel
        Remove-Item Env:MESHLLM_MODEL_DIR -ErrorAction SilentlyContinue
        Write-Host "  Publishing MeshLLM model by name: $MeshLLMModel" -ForegroundColor DarkGray
    }
}

# ── Build & start ─────────────────────────────────────────────────────────────
if ($MeshLLM) { $composeFiles += @('--profile', 'meshllm') }
$upArgs = $composeFiles + @('up', '--build')
if ($Detach) { $upArgs += '--detach' }
$upArgs += '--wait'

docker compose @upArgs
if ($LASTEXITCODE -ne 0) { Write-Error "docker compose up failed (exit $LASTEXITCODE)"; exit 1 }

# ── Read assigned host ports ──────────────────────────────────────────────────
$serverBinding = docker compose @composeFiles port server 3001 2>$null
$ollamaBinding = docker compose @composeFiles port ollama 11434 2>$null

$serverPort = if ($serverBinding) { ($serverBinding -split ':')[1] } else { $null }
$ollamaPort = if ($ollamaBinding) { ($ollamaBinding -split ':')[1] } else { $null }

# ── Persist ports for other tooling ──────────────────────────────────────────
$sdlcFrameworkDir = Join-Path $worktreeRoot '.sdlc-framework'
if (-not (Test-Path $sdlcFrameworkDir)) { New-Item -ItemType Directory $sdlcFrameworkDir -Force | Out-Null }
$portsFile = Join-Path $sdlcFrameworkDir 'docker-ports.json'
@{ serverPort = [int]$serverPort; ollamaPort = [int]$ollamaPort; projectName = $projectName } |
    ConvertTo-Json | Set-Content $portsFile -Encoding UTF8
# Write .dev-port so Vite auto-detects the dynamic port without needing SDLC_API_PORT
Set-Content (Join-Path $sdlcFrameworkDir '.dev-port') $serverPort -NoNewline -Encoding UTF8

# ── Ensure sdlc-tuned model exists (seed from Modelfile for new users) ────
$modelExists = docker compose @composeFiles exec -T ollama ollama list 2>$null | Select-String 'sdlc-tuned'
if (-not $modelExists) {
    Write-Host "  sdlc-tuned:latest not found — creating from Modelfile…" -ForegroundColor DarkGray
    $modelfilePath = Join-Path $worktreeRoot 'Modelfile'
    docker cp $modelfilePath "${projectName}-ollama-1:/tmp/Modelfile"
    docker compose @composeFiles exec -T ollama ollama create sdlc-tuned -f /tmp/Modelfile
    Write-Host "  sdlc-tuned:latest ready" -ForegroundColor DarkGray
}

# ── Print usage ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✅ Stack is up: $projectName" -ForegroundColor Green
Write-Host ""
Write-Host "  API server →  http://localhost:$serverPort" -ForegroundColor White
if ($ollamaPort) {
    Write-Host "  Ollama      →  http://localhost:$ollamaPort" -ForegroundColor White
}
if ($MeshLLM) {
    Write-Host "  MeshLLM     →  http://localhost:9337/v1" -ForegroundColor White
    Write-Host "  Mesh console→  http://localhost:3131" -ForegroundColor White
}
Write-Host ""
Write-Host "  Start the dashboard:" -ForegroundColor DarkGray
Write-Host "    npm run dashboard" -ForegroundColor Yellow
Write-Host "    (port $serverPort auto-detected from .sdlc-framework/.dev-port)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Run Cypress against this stack:" -ForegroundColor DarkGray
Write-Host "    .\bin\docker-test.ps1 -ServerPort $serverPort -CypressOnly" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Stop the stack:" -ForegroundColor DarkGray
Write-Host "    .\bin\docker-down.ps1" -ForegroundColor Yellow
if (-not $MeshLLM) {
    Write-Host ""
    Write-Host "  Start with MeshLLM:" -ForegroundColor DarkGray
    Write-Host "    .\bin\docker-up.ps1 -MeshLLM" -ForegroundColor Yellow
}
