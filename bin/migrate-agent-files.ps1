<#
.SYNOPSIS
  Renames legacy agent status/message files from codename-based to role-based IDs.
.DESCRIPTION
  SDLC Framework v2.1 switched agent IDs from codenames (lasair, vigil, etc.) to
  role-based IDs (frontend, qa, etc.). This script renames any leftover
  .*-status.json and .*-messages.json files in the workspace root so the
  dashboard and watchers pick them up under the new names.

  Only renames when the legacy file exists AND the new-name file does NOT.
.EXAMPLE
  .\bin\migrate-agent-files.ps1            # uses current directory
  .\bin\migrate-agent-files.ps1 -Root C:\repos\MyProject
#>
param(
    [string]$Root = (Get-Location).Path
)

$map = @{
    lasair  = "frontend"
    cairn   = "backend"
    vigil   = "qa"
    prism   = "ux"
    brehon  = "reviewer"
    cairde  = "devops"
}

$suffixes = @("-status.json", "-messages.json")
$renamed  = 0

foreach ($old in $map.Keys) {
    $new = $map[$old]
    foreach ($suffix in $suffixes) {
        $oldFile = Join-Path $Root ".$old$suffix"
        $newFile = Join-Path $Root ".$new$suffix"
        if ((Test-Path $oldFile) -and -not (Test-Path $newFile)) {
            Move-Item $oldFile $newFile
            Write-Host "  Renamed  .$old$suffix  ->  .$new$suffix" -ForegroundColor Green
            $renamed++
        } elseif ((Test-Path $oldFile) -and (Test-Path $newFile)) {
            Write-Host "  Skipped  .$old$suffix  (.$new$suffix already exists)" -ForegroundColor Yellow
        }
    }
}

# Also rename the design spec if it still uses the old name
$oldSpec = Join-Path $Root ".prism-design-spec.md"
$newSpec = Join-Path $Root ".ux-design-spec.md"
if ((Test-Path $oldSpec) -and -not (Test-Path $newSpec)) {
    Move-Item $oldSpec $newSpec
    Write-Host "  Renamed  .prism-design-spec.md  ->  .ux-design-spec.md" -ForegroundColor Green
    $renamed++
} elseif ((Test-Path $oldSpec) -and (Test-Path $newSpec)) {
    Write-Host "  Skipped  .prism-design-spec.md  (.ux-design-spec.md already exists)" -ForegroundColor Yellow
}

if ($renamed -eq 0) {
    Write-Host ""
    Write-Host "Nothing to migrate - all files already use role-based names." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "Migrated $renamed file(s)." -ForegroundColor Cyan
}
