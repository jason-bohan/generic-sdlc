param(
    [switch]$Force,
    [string]$HfHome = "C:\ml\hf_cache",
    [string]$OutputDir = "C:\ml\models\sdlc-framework\output"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $root '.venv'
$py = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "Python 3.12 not found at $py - install from python.org"
    exit 1
}

Write-Host "`n[1/5] Checking Python..." -ForegroundColor Cyan
& $py --version

if ((Test-Path $venvPath) -and -not $Force) {
    Write-Host "[2/5] Venv already exists (use -Force to recreate)" -ForegroundColor Yellow
} else {
    if (Test-Path $venvPath) { Remove-Item $venvPath -Recurse -Force }
    Write-Host "[2/5] Creating venv..." -ForegroundColor Cyan
    & $py -m venv $venvPath
}

$pip = Join-Path $venvPath 'Scripts\pip.exe'
$python = Join-Path $venvPath 'Scripts\python.exe'

& $pip install --upgrade pip --quiet

# Step 3: Install PyTorch with CUDA FIRST, from the dedicated index.
# This MUST happen before unsloth, because unsloth's deps will try to
# pull CPU-only torch from PyPI and overwrite the CUDA build.
Write-Host "[3/5] Installing PyTorch with CUDA 12.6..." -ForegroundColor Cyan
& $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126

# Verify CUDA torch before proceeding
$cudaCheck = & $python -c "import torch; print(torch.cuda.is_available())" 2>&1
if ($cudaCheck -ne 'True') {
    Write-Error "PyTorch CUDA install failed - got: $cudaCheck"
    exit 1
}
Write-Host "  PyTorch CUDA verified" -ForegroundColor Green

# Step 4: Install unsloth and remaining deps.
# Unsloth's deps will pull CPU-only torch here - step 5 fixes that.
Write-Host "[4/5] Installing Unsloth and dependencies..." -ForegroundColor Cyan
& $pip install unsloth
& $pip install -r (Join-Path $root 'requirements.txt')

# Step 5: Force-reinstall CUDA torch wheels (pip won't upgrade CPU->CUDA without --force).
Write-Host "[5/5] Re-pinning PyTorch CUDA 12.6 (safety net)..." -ForegroundColor Cyan
& $pip install --no-deps --force-reinstall torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126

Write-Host "`nVerifying installation..." -ForegroundColor Cyan
& $python -c "import torch; print('PyTorch ' + torch.__version__ + ', CUDA: ' + str(torch.cuda.is_available()))"
& $python -c "import torch; print('GPU: ' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None'))"
& $python -c "from unsloth import FastLanguageModel; print('Unsloth OK')"

# Set HF_HOME persistently so export_gguf.py reuses the cache across reboots.
# The ~16 GB base model download only happens once if this is set correctly.
if (-not (Test-Path $HfHome)) {
    New-Item -ItemType Directory -Path $HfHome -Force | Out-Null
}
[System.Environment]::SetEnvironmentVariable("HF_HOME", $HfHome, "User")
$env:HF_HOME = $HfHome
Write-Host "`nHF_HOME set to $HfHome (user env var, persists across reboots)" -ForegroundColor Green

# Create the shared output dir and junction so all worktrees see the same
# large model files without duplicating the ~20 GB across each worktree.
$outputJunction = Join-Path $root 'output'
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "Shared output dir created at $OutputDir" -ForegroundColor Green
}
if (Test-Path $outputJunction) {
    $item = Get-Item $outputJunction -Force
    if ($item.LinkType -eq 'Junction') {
        Write-Host "output\ junction already points to $OutputDir" -ForegroundColor Yellow
    } else {
        Write-Host "output\ is a real directory — leaving it in place" -ForegroundColor Yellow
    }
} else {
    cmd /c "mklink /J `"$outputJunction`" `"$OutputDir`"" | Out-Null
    Write-Host "output\ -> $OutputDir junction created" -ForegroundColor Green
}

Write-Host "`nEnvironment ready. Activate with:" -ForegroundColor Green
Write-Host "  $venvPath\Scripts\Activate.ps1" -ForegroundColor White
Write-Host "`nShared paths (survive worktree deletion, shareable across machines via same drive letter):"
Write-Host "  HF cache : $HfHome"
Write-Host "  ML output: $OutputDir  (junctioned from output\)"
Write-Host "`nTo fine-tune and export:" -ForegroundColor Cyan
Write-Host "  python train.py          # ~16 min, produces output\lora-adapter\"
Write-Host "  python export_gguf.py    # merges + converts to GGUF (~16 GB download, cached to $HfHome)"
Write-Host "  ollama create sdlc-tuned -f Modelfile.tuned"
