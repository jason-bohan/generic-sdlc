param(
    [Parameter(Mandatory = $true)]
    [string]$HookName
)

$hooksDir = $PSScriptRoot
# Join-Path accepts only two segments on Windows PowerShell 5.1 (Claude/Cursor hook shells).
$repoRoot = (Resolve-Path (Join-Path $hooksDir '..\..')).Path
$hookPath = Join-Path $hooksDir $HookName

if (-not (Test-Path -LiteralPath $hookPath)) {
    exit 0
}

Set-Location -LiteralPath $repoRoot
& $hookPath
exit $LASTEXITCODE
