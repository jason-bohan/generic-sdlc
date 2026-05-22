# import-unsloth-model.ps1
# Converts the Unsloth fine-tuned Qwen3 model to GGUF and imports into Ollama.
# Prerequisites: Python 3.10+, llama.cpp (llama-quantize), Ollama running.
#
# Usage: .\bin\import-unsloth-model.ps1 [-SkipConvert] [-Quantize Q4_K_M]

param(
    [switch]$SkipConvert,
    [string]$Quantize = "Q4_K_M",
    [string]$ModelName = "sdlc-framework-qwen3-ft"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$MergedDir = Join-Path $Root "ml\unsloth\output\gguf"
$GgufOutput = Join-Path $Root "ml\unsloth\output\gguf\model-f16.gguf"
$QuantOutput = Join-Path $Root "ml\unsloth\output\gguf\model-$Quantize.gguf"

Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $MergedDir "config.json"))) {
    Write-Error "Merged model not found at $MergedDir. Run Unsloth merge first."
    exit 1
}

# Check for llama.cpp tools
$convertScript = $null
$llamaQuantize = $null

# Try common locations
$llamaCppPaths = @(
    "$env:USERPROFILE\.local\bin",
    "$env:USERPROFILE\llama.cpp\build\bin\Release",
    "$env:USERPROFILE\llama.cpp\build\bin",
    "C:\tools\llama.cpp\build\bin\Release"
)

foreach ($p in $llamaCppPaths) {
    if (Test-Path (Join-Path $p "llama-quantize.exe")) {
        $llamaQuantize = Join-Path $p "llama-quantize.exe"
        break
    }
}

# Find the convert script (usually in llama.cpp repo or pip-installed)
$convertCandidates = @(
    "$env:USERPROFILE\llama.cpp\convert_hf_to_gguf.py",
    "$env:USERPROFILE\.local\share\llama.cpp\convert_hf_to_gguf.py"
)
foreach ($c in $convertCandidates) {
    if (Test-Path $c) { $convertScript = $c; break }
}

if (-not $SkipConvert) {
    Write-Host "[2/4] Converting SafeTensors to GGUF (f16)..." -ForegroundColor Cyan

    if ($convertScript) {
        python $convertScript $MergedDir --outfile $GgufOutput --outtype f16
        if ($LASTEXITCODE -ne 0) { Write-Error "GGUF conversion failed"; exit 1 }
    } else {
        Write-Warning "convert_hf_to_gguf.py not found. Trying pip-installed llama-cpp-python..."
        python -c "from llama_cpp import Llama; print('llama-cpp-python available')" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Neither llama.cpp convert script nor llama-cpp-python found. Install llama.cpp first."
            exit 1
        }
        Write-Error "Automatic conversion requires convert_hf_to_gguf.py from llama.cpp"
        exit 1
    }
} else {
    Write-Host "[2/4] Skipping conversion (using existing GGUF)..." -ForegroundColor Yellow
    if (-not (Test-Path $GgufOutput)) {
        # Check for any existing GGUF
        $existing = Get-ChildItem -Path $MergedDir -Filter "*.gguf" | Select-Object -First 1
        if ($existing) {
            $GgufOutput = $existing.FullName
            Write-Host "  Found existing: $GgufOutput"
        } else {
            Write-Error "No GGUF file found. Run without -SkipConvert."
            exit 1
        }
    }
}

Write-Host "[3/4] Quantizing to $Quantize..." -ForegroundColor Cyan

if ($llamaQuantize -and (Test-Path $GgufOutput)) {
    & $llamaQuantize $GgufOutput $QuantOutput $Quantize
    if ($LASTEXITCODE -ne 0) { Write-Error "Quantization failed"; exit 1 }
    Write-Host "  Quantized: $QuantOutput"
} else {
    Write-Warning "llama-quantize not found or f16 GGUF missing - skipping quantization, using f16 directly"
    $QuantOutput = $GgufOutput
}

Write-Host "[4/4] Importing into Ollama as $ModelName..." -ForegroundColor Cyan

$ModelfilePath = Join-Path $Root "Modelfile.unsloth"
$ModelfileContent = @"
FROM $QuantOutput

SYSTEM """
You are a product owner AI that generates Agility (VersionOne) story fields as HTML.

## Output contract
Return a SINGLE JSON object - no markdown fences, no explanation, nothing else.

Keys:
  "description"        - HTML: <h2>Summary</h2><p>...</p><h3>Problem</h3><p>...</p><h3>Solution</h3><p>...</p>
  "acceptanceCriteria" - HTML: <ul><li>Given ... When ... Then ...</li></ul>  (3-6 items, specific and testable)
  "frontend"           - HTML: <ul><li>path/to/file.ts - what changes</li></ul>  or null
  "backend"            - HTML: <ul><li>path/to/service.ts - what changes</li></ul>  or null
  "qa"                 - HTML: <ul><li>Test scenario with expected result</li></ul>  or null

## Non-negotiable rules
1. JSON ONLY. Start with { and end with }.
2. File paths must come from the codebase context provided in the prompt. Never invent paths.
3. Acceptance criteria must be testable, not vague ("the feature works" is not acceptable).
4. /no_think
"""

PARAMETER temperature 0.1
PARAMETER repeat_penalty 1.1
PARAMETER num_predict 1500
PARAMETER num_ctx 4096
"@

Set-Content -Path $ModelfilePath -Value $ModelfileContent -Encoding UTF8
ollama create $ModelName -f $ModelfilePath
if ($LASTEXITCODE -ne 0) { Write-Error "Ollama import failed"; exit 1 }

Write-Host ""
Write-Host "Done! Model '$ModelName' is now available in Ollama." -ForegroundColor Green
Write-Host "Test with: ollama run $ModelName" -ForegroundColor Gray
Write-Host ""
Write-Host "To use with MeshLLM, run:" -ForegroundColor Gray
Write-Host "  mesh-llm --model $QuantOutput" -ForegroundColor Gray
