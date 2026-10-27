# Reproducible release build of the screen helper (FL-07, plan T-10) — Windows.
#
# Builds twice in clean target directories and compares the SHA-256 of both
# binaries; a mismatch fails. Writes unsigned-release-metadata.json with
# productionEligible: false. Uploads nothing. UNVERIFIED: written on a machine
# without a Rust toolchain (see PACKAGING.md). The job launcher's
# build-release.ps1 attests the full toolchain identity; this script is the
# smaller first step and gains that attestation with signed admission (P3).
param(
    [string]$OutDir = 'dist'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath 'Cargo.lock')) {
    throw 'Cargo.lock is missing: generate it once (cargo generate-lockfile), review and commit it first'
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$env:CARGO_INCREMENTAL = '0'
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$env:RUSTFLAGS = "--remap-path-prefix=$((Get-Location).Path)=C:\build\ever-works-screen --remap-path-prefix=$cargoHome=C:\cargo"

$hashes = @()
foreach ($pass in 1, 2) {
    $targetDir = "target-repro-$pass"
    if (Test-Path -LiteralPath $targetDir) { Remove-Item -Recurse -Force -LiteralPath $targetDir }
    cargo build --release --locked --target x86_64-pc-windows-msvc --target-dir $targetDir
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (pass $pass)" }
    $binary = Join-Path $targetDir 'x86_64-pc-windows-msvc\release\ever-works-screen.exe'
    $hashes += (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()
}
if ($hashes[0] -ne $hashes[1]) {
    throw "the two builds differ: $($hashes[0]) vs $($hashes[1])"
}

Copy-Item -LiteralPath 'target-repro-1\x86_64-pc-windows-msvc\release\ever-works-screen.exe' -Destination (Join-Path $OutDir 'ever-works-screen.exe') -Force
$version = (Select-String -LiteralPath 'Cargo.toml' -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$metadata = [ordered]@{
    schemaVersion      = 1
    artifact           = 'ever-works-screen'
    version            = $version
    target             = 'win32-x64'
    sha256             = $hashes[0]
    reproducible       = $true
    productionEligible = $false
}
$metadata | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutDir 'unsigned-release-metadata.json')
Write-Output "ever-works-screen $version (win32-x64) sha256 $($hashes[0])"
