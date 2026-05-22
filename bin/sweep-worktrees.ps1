# Remove linked git worktrees whose branches are already merged into origin/main or origin/master.
# Usage: .\bin\sweep-worktrees.ps1 [-RepoRoot <path>] [-DryRun] [-Force]
# Default RepoRoot: directory that contains the bin folder (repository root).

param(
    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    Write-Error "RepoRoot not found: $RepoRoot"
    exit 1
}

function Get-DefaultRemoteBranch {
    param([string]$GitRoot)
    try {
        $sym = (& git -C $GitRoot symbolic-ref refs/remotes/origin/HEAD 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $sym) {
            if ($sym -match 'refs/remotes/origin/(.+)$') { return $Matches[1] }
        }
    } catch { <# fall through #> }
    foreach ($b in @('main', 'master')) {
        $null = & git -C $GitRoot rev-parse --verify ("refs/remotes/origin/{0}" -f $b) 2>$null
        if ($LASTEXITCODE -eq 0) { return $b }
    }
    return 'main'
}

function Get-WorktreeEntries {
    param([string]$GitRoot)
    $raw = & git -C $GitRoot worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    $entries = New-Object System.Collections.Generic.List[hashtable]
    $path = $null
    $branch = $null
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match '^worktree (.+)') {
            if ($path) { $entries.Add(@{ Path = $path; Branch = $branch }) }
            $path = $Matches[1]
            $branch = $null
        }
        elseif ($line -match '^branch refs/heads/(.+)$') {
            $branch = $Matches[1]
        }
        elseif ($line -eq 'detached') {
            $branch = $null
        }
    }
    if ($path) { $entries.Add(@{ Path = $path; Branch = $branch }) }
    return $entries
}

function Paths-Equal {
    param([string]$A, [string]$B)
    $ra = [System.IO.Path]::GetFullPath($A)
    $rb = [System.IO.Path]::GetFullPath($B)
    return $ra.Equals($rb, [System.StringComparison]::OrdinalIgnoreCase)
}

$repoRootFull = [System.IO.Path]::GetFullPath($RepoRoot)
$defaultBr = Get-DefaultRemoteBranch -GitRoot $repoRootFull
$removed = 0
$skipped = 0

$entries = Get-WorktreeEntries -GitRoot $repoRootFull
if (-not $entries -or $entries.Count -eq 0) {
    Write-Host "No worktrees found or not a git repository."
    exit 0
}

foreach ($e in $entries) {
    $wtPath = $e.Path
    $br = $e.Branch
    if (Paths-Equal $wtPath $repoRootFull) { continue }

    $merged = $false
    if ($br) {
        $null = & git -C $repoRootFull merge-base --is-ancestor $br ("origin/{0}" -f $defaultBr) 2>$null
        $merged = ($LASTEXITCODE -eq 0)
    }

    $shouldRemove = $false
    if (-not $br) {
        if ($Force) {
            $shouldRemove = $true
            Write-Warning "Force: removing detached worktree at $wtPath"
        } else {
            Write-Warning "Skipping detached worktree (use -Force to remove): $wtPath"
            $skipped++
        }
    }
    elseif ($merged) {
        $shouldRemove = $true
    }
    elseif ($Force) {
        $shouldRemove = $true
        Write-Warning "Force: removing unmerged worktree $wtPath (branch $br)"
    }
    else {
        Write-Warning "Skipping unmerged branch ${br}: $wtPath"
        $skipped++
    }

    if (-not $shouldRemove) { continue }

    if ($DryRun) {
        Write-Host "[DryRun] Would remove worktree: $wtPath"
        if ($br) { Write-Host "[DryRun] Would delete branch: $br" }
        $removed++
        continue
    }

    & git -C $repoRootFull worktree remove $wtPath --force 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "worktree remove failed: $wtPath"
        $skipped++
        continue
    }
    $removed++
    Write-Host "Removed worktree: $wtPath"

    if (-not $br) { continue }

    if ($merged) {
        $null = & git -C $repoRootFull branch -d $br 2>$null
        if ($LASTEXITCODE -ne 0) {
            $null = & git -C $repoRootFull branch -D $br 2>$null
        }
    }
    else {
        $null = & git -C $repoRootFull branch -D $br 2>$null
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Deleted branch: $br"
    } else {
        Write-Warning "Could not delete branch: $br"
    }
}

if (-not $DryRun) {
    $null = & git -C $repoRootFull worktree prune 2>$null
}

Write-Host ("Summary: Removed {0} worktrees, skipped {1} unmerged or blocked" -f $removed, $skipped)
