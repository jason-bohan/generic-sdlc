# SDLC Framework TUI - run from any directory
# Usage: sdlc-framework [--test] [subcommand] [options]
# The current directory is passed as --dir so the CLI resolves the agent from workspace config.
# --test runs with local mock integrations; plain `sdlc-framework` stays live unless config/env says otherwise.

$sdlc-frameworkHome = if ($env:SDLC_FRAMEWORK_HOME) { $env:SDLC_FRAMEWORK_HOME } else { "c:\repos\SDLC Framework" }

# Ensure node is on PATH (nvs can strip it when switching directories)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nvsCandidates = @(
        "$env:LOCALAPPDATA\nvs",
        "$env:APPDATA\nvs",
        "$env:ProgramFiles\nvs"
    )
    foreach ($nvsRoot in $nvsCandidates) {
        $nodeDir = Get-ChildItem "$nvsRoot\node" -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($nodeDir) {
            $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
            $nodeBin = Join-Path $nodeDir.FullName $arch
            if (Test-Path (Join-Path $nodeBin "node.exe")) {
                $env:PATH = "$nodeBin;$env:PATH"
                break
            }
        }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "node not found. Install Node.js or set SDLC_FRAMEWORK_HOME to a repo with node_modules."
        exit 1
    }
}

$currentDir = (Get-Location).Path

$hasDir = $false
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq "--dir") {
        $hasDir = $true
        break
    }
}

$tsx = Join-Path $sdlc-frameworkHome "node_modules\.bin\tsx.cmd"
if (-not (Test-Path $tsx)) {
    Write-Error "tsx not found. Run 'npm install' in $sdlc-frameworkHome first."
    exit 1
}

if ($hasDir) {
    & $tsx "$sdlc-frameworkHome\src\tui\index.tsx" @args
} else {
    & $tsx "$sdlc-frameworkHome\src\tui\index.tsx" --dir $currentDir @args
}
