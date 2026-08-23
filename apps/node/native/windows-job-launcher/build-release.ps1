[CmdletBinding()]
param(
	[string]$OutputDirectory = "target\release-metadata"
)

$ErrorActionPreference = "Stop"
$packageRoot = $PSScriptRoot
$targetTriple = "x86_64-pc-windows-msvc"
$binaryPath = Join-Path $packageRoot "target\$targetTriple\release\ever-works-windows-job-launcher.exe"
$metadataDirectory = Join-Path $packageRoot $OutputDirectory
$metadataPath = Join-Path $metadataDirectory "ever-works-windows-job-launcher.json"
$previousRustFlags = $env:RUSTFLAGS
$reproducibleLinkFlag = "-C link-arg=/Brepro"
$env:RUSTFLAGS = if ([string]::IsNullOrWhiteSpace($previousRustFlags)) {
	$reproducibleLinkFlag
} else {
	"$previousRustFlags $reproducibleLinkFlag"
}

try {
	Push-Location $packageRoot
	try {
		$sourceStatus = git status --porcelain=v1 --untracked-files=normal -- .
		if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($sourceStatus -join ""))) {
			throw "release metadata requires a clean package source tree"
		}

		cargo build --locked --release --target $targetTriple
		if ($LASTEXITCODE -ne 0) {
			throw "cargo release build failed"
		}

		$sourceCommit = (git rev-parse HEAD).Trim()
		if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
			throw "unable to resolve source commit"
		}
	} finally {
		Pop-Location
	}

	New-Item -ItemType Directory -Force -Path $metadataDirectory | Out-Null
	$binary = Get-Item -LiteralPath $binaryPath
	$metadata = [ordered]@{
		schemaVersion = 1
		artifact = $binary.Name
		targetTriple = $targetTriple
		rustToolchain = "1.88.0"
		cargoLocked = $true
		sourceCommit = $sourceCommit
		binarySize = $binary.Length
		binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaryPath).Hash.ToLowerInvariant()
		cargoLockSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "Cargo.lock")).Hash.ToLowerInvariant()
		authenticode = [ordered]@{ status = "unsigned"; hook = "phase-2-release-pipeline" }
		sbom = [ordered]@{ status = "not-generated"; hook = "phase-2-release-pipeline" }
	}
	$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
	Write-Output $metadataPath
} finally {
	$env:RUSTFLAGS = $previousRustFlags
}
