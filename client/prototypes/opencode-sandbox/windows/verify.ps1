[CmdletBinding()]
param(
    [string]$OpenCodePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Resolves repository paths without depending on the caller's working directory.
$clientRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $clientRoot "..")).Path
$sourcePath = Join-Path $PSScriptRoot "AppContainerLauncher.cs"
$buildRoot = Join-Path $env:TEMP "yibiao-opencode-sandbox-prototype"
$launcherPath = Join-Path $buildRoot "AppContainerLauncher.exe"
$outsideProbe = Join-Path $repoRoot "AGENTS.md"

if ([string]::IsNullOrWhiteSpace($OpenCodePath)) {
    $OpenCodePath = Join-Path $clientRoot "vendor\opencode\win32-x64\opencode.exe"
}
$OpenCodePath = (Resolve-Path -LiteralPath $OpenCodePath).Path

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw "The Windows .NET Framework C# compiler was not found."
}

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

# Builds the host launcher with the Windows .NET Framework compiler.
& $csc /nologo /target:exe /platform:x64 ("/out:" + $launcherPath) $sourcePath
if ($LASTEXITCODE -ne 0) {
    throw "AppContainerLauncher compilation failed with exit code $LASTEXITCODE."
}


function Invoke-SandboxProbe {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $launcherPath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $text = ($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    [pscustomobject]@{
        ExitCode = $exitCode
        Output = $text
    }
}

try {
    if (-not (Test-Path -LiteralPath $outsideProbe)) {
        throw "The repository probe file does not exist."
    }

    $paths = Invoke-SandboxProbe -Arguments @("--reset", $OpenCodePath, "debug", "paths")
    Write-Host $paths.Output
    if ($paths.ExitCode -ne 0) {
        throw "The sandboxed debug paths probe failed with exit code $($paths.ExitCode)."
    }
    if ($paths.Output -notmatch "S-1-15-2-") {
        throw "The launcher did not report an AppContainer package SID."
    }

    $inside = Invoke-SandboxProbe -Arguments @($env:ComSpec, "/d", "/c", "type", "inside.txt")
    Write-Host $inside.Output
    if ($inside.ExitCode -ne 0 -or $inside.Output -notmatch "sandbox-inside-marker") {
        throw "The native probe could not read the marker inside its sandbox workspace."
    }

    $outside = Invoke-SandboxProbe -Arguments @($env:ComSpec, "/d", "/c", "type", $outsideProbe)
    Write-Host $outside.Output
    if ($outside.ExitCode -eq 0) {
        throw "The native probe unexpectedly read a file outside the AppContainer profile."
    }

    $skills = Invoke-SandboxProbe -Arguments @($OpenCodePath, "debug", "skill")
    Write-Host $skills.Output
    if ($skills.ExitCode -eq 0) {
        throw "OpenCode project initialization unexpectedly succeeded; update the prototype expectation."
    }
    if ($skills.Output -notmatch "EPERM" -or $skills.Output -notmatch "lstat 'C:\\'") {
        throw "OpenCode failed for a reason other than the known inaccessible-ancestor scan."
    }

    Write-Host ""
    Write-Host "PASS: AppContainer allowed the internal marker and denied the repository probe."
    Write-Host "EXPECTED BLOCKER: OpenCode v1.17.8 project commands scan the inaccessible drive root."
}
finally {
    if (Test-Path -LiteralPath $launcherPath) {
        & $launcherPath --delete-profile | Out-Host
    }
}
