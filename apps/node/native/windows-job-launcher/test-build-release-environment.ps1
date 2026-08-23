[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
$targetTriple = "x86_64-pc-windows-msvc"
$artifactName = "ever-works-windows-job-launcher.exe"
$controlMetadataDirectory = "target\release-metadata-control"
$hostileMetadataDirectory = "target\release-metadata"
$evidenceDirectory = Join-Path $packageRoot "target\build-environment-proof"
$buildScript = Join-Path $packageRoot "build-release.ps1"
$failures = [Collections.Generic.List[string]]::new()

$githubHintNames = @(
	"GITHUB_ACTIONS",
	"GITHUB_REPOSITORY",
	"GITHUB_RUN_ATTEMPT",
	"GITHUB_RUN_ID",
	"GITHUB_WORKFLOW_REF",
	"ImageOS",
	"ImageVersion",
	"RUNNER_ARCH",
	"RUNNER_ENVIRONMENT",
	"RUNNER_OS"
)
$profileOverrides = [ordered]@{
	CARGO_PROFILE_RELEASE_OPT_LEVEL = "0"
	CARGO_PROFILE_RELEASE_LTO = "false"
	CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "256"
	CARGO_PROFILE_RELEASE_PANIC = "unwind"
	CARGO_PROFILE_RELEASE_STRIP = "none"
	CARGO_PROFILE_RELEASE_DEBUG = "full"
	CARGO_PROFILE_RELEASE_INCREMENTAL = "true"
	CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_OPT_LEVEL = "0"
	CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG = "true"
	CARGO_PROFILE_TEST_OPT_LEVEL = "0"
	CARGO_PROFILE_FUTURE_SENTINEL = "must-be-cleared"
}
$otherHostileOverrides = [ordered]@{
	CARGO_BUILD_RUSTC = "C:\missing-hostile-rustc.exe"
	CARGO_BUILD_RUSTC_WRAPPER = "C:\missing-hostile-cargo-wrapper.exe"
	CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER = "C:\missing-hostile-cargo-workspace-wrapper.exe"
	CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "C:\missing-hostile-linker.exe"
	CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-C opt-level=0"
	RUSTC = "C:\missing-hostile-rustc.exe"
	RUSTC_WRAPPER = "C:\missing-hostile-rustc-wrapper.exe"
	RUSTC_WORKSPACE_WRAPPER = "C:\missing-hostile-rustc-workspace-wrapper.exe"
	RUSTFLAGS = "-C opt-level=0"
}
$linkerHostileOverrides = [ordered]@{
	LINK = "/STACK:12345678"
	_LINK_ = "/VERSION:99.99"
}
$allManagedNames = @($githubHintNames) +
	@($profileOverrides.Keys) +
	@($otherHostileOverrides.Keys) +
	@($linkerHostileOverrides.Keys) +
	@("CARGO_ENCODED_RUSTFLAGS") |
	Select-Object -Unique
$previousEnvironment = @{}
foreach ($name in $allManagedNames) {
	$previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Set-TestEnvironment {
	param([Parameter(Mandatory)] [Collections.IDictionary]$Values)
	foreach ($name in $allManagedNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	foreach ($entry in $Values.GetEnumerator()) {
		[Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, "Process")
	}
}

function Get-ReleaseMetadata {
	param([Parameter(Mandatory)] [string]$RelativeDirectory)
	$path = Join-Path $packageRoot "$RelativeDirectory\ever-works-windows-job-launcher.json"
	return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
}

function Assert-True {
	param([bool]$Condition, [Parameter(Mandatory)] [string]$Message)
	if (-not $Condition) {
		$failures.Add($Message)
	}
}

function Get-ActualBuildHashes {
	param([Parameter(Mandatory)] [object]$Metadata)
	$hashes = @()
	foreach ($relativePath in $Metadata.reproducibility.buildArtifacts) {
		$hashes += (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot $relativePath)).Hash.ToLowerInvariant()
	}
	return $hashes
}

try {
	$resolvedEvidence = [IO.Path]::GetFullPath($evidenceDirectory)
	$targetRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot "target"))
	if (-not $resolvedEvidence.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
		throw "build-environment evidence directory escapes package target"
	}
	if (Test-Path -LiteralPath $evidenceDirectory) {
		Remove-Item -LiteralPath $evidenceDirectory -Recurse -Force
	}
	New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null

	Set-TestEnvironment -Values ([ordered]@{})
	& $buildScript -OutputDirectory $controlMetadataDirectory | Out-Null
	$controlMetadata = Get-ReleaseMetadata $controlMetadataDirectory
	$controlHashes = Get-ActualBuildHashes $controlMetadata
	for ($index = 0; $index -lt $controlMetadata.reproducibility.buildArtifacts.Count; $index++) {
		Copy-Item `
			-LiteralPath (Join-Path $packageRoot $controlMetadata.reproducibility.buildArtifacts[$index]) `
			-Destination (Join-Path $evidenceDirectory "control-$index.exe")
	}

	$hostileEnvironment = [ordered]@{}
	foreach ($entry in $profileOverrides.GetEnumerator()) {
		$hostileEnvironment[$entry.Key] = $entry.Value
	}
	foreach ($entry in $otherHostileOverrides.GetEnumerator()) {
		$hostileEnvironment[$entry.Key] = $entry.Value
	}
	foreach ($entry in $linkerHostileOverrides.GetEnumerator()) {
		$hostileEnvironment[$entry.Key] = $entry.Value
	}
	$hostileEnvironment["CARGO_ENCODED_RUSTFLAGS"] = "-C$([char]0x1f)opt-level=0$([char]0x1f)-C$([char]0x1f)link-arg=/DEBUG"
	$hostileEnvironment["GITHUB_ACTIONS"] = "true"
	$hostileEnvironment["GITHUB_REPOSITORY"] = "attacker/spoofed"
	$hostileEnvironment["GITHUB_RUN_ATTEMPT"] = "999"
	$hostileEnvironment["GITHUB_RUN_ID"] = "999999"
	$hostileEnvironment["GITHUB_WORKFLOW_REF"] = "attacker/spoofed/.github/workflows/fake.yml@refs/heads/main"
	$hostileEnvironment["ImageOS"] = "spoofed-windows"
	$hostileEnvironment["ImageVersion"] = "spoofed-image"
	$hostileEnvironment["RUNNER_ARCH"] = "spoofed-arch"
	$hostileEnvironment["RUNNER_ENVIRONMENT"] = "github-hosted"
	$hostileEnvironment["RUNNER_OS"] = "spoofed-os"
	Set-TestEnvironment -Values $hostileEnvironment
	& $buildScript -OutputDirectory $hostileMetadataDirectory | Out-Null
	$hostileMetadata = Get-ReleaseMetadata $hostileMetadataDirectory
	$hostileHashes = Get-ActualBuildHashes $hostileMetadata

	Assert-True ($controlMetadata.reproducibility.verified -eq $true) "control build did not record verified reproducibility"
	Assert-True ($hostileMetadata.reproducibility.verified -eq $true) "hostile build did not record verified reproducibility"
	Assert-True (@($controlHashes | Select-Object -Unique).Count -eq 1) "control build executables differ"
	Assert-True (@($hostileHashes | Select-Object -Unique).Count -eq 1) "hostile build executables differ"
	Assert-True ($controlHashes[0] -ceq $hostileHashes[0]) "hostile Cargo/Rust/MSVC linker environment changed the release executable"
	for ($index = 0; $index -lt $controlHashes.Count; $index++) {
		$evidenceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $evidenceDirectory "control-$index.exe")).Hash.ToLowerInvariant()
		Assert-True ($evidenceHash -ceq $controlHashes[$index]) "retained control executable $index changed"
	}
	foreach ($metadata in @($controlMetadata, $hostileMetadata)) {
		Assert-True ($metadata.buildInputs.builder.kind -ceq "local-untrusted") "script metadata promoted environment claims into a trusted builder kind"
		Assert-True ($metadata.buildInputs.builder.id -ceq "urn:ever-works:builder:build-release-script:v3") "script builder identity is not stable"
	}
	$invocationHintsProperty = $hostileMetadata.PSObject.Properties["invocationHints"]
	if ($null -eq $invocationHintsProperty) {
		$failures.Add("CI invocation hints are missing")
	} else {
		Assert-True ($invocationHintsProperty.Value.trust -ceq "untrusted-environment") "CI invocation hints are not explicitly untrusted"
		Assert-True ($invocationHintsProperty.Value.claimedProvider -ceq "github-actions") "spoofed CI environment was not retained only as a hint"
	}
	$environmentPolicyProperty = $hostileMetadata.buildInputs.PSObject.Properties["environmentPolicy"]
	if ($null -eq $environmentPolicyProperty) {
		$failures.Add("sanitized build-environment policy evidence is missing")
	} else {
		Assert-True (
			$environmentPolicyProperty.Value.clearedCargoProfileOverrideCount -eq $profileOverrides.Count
		) "not every hostile CARGO_PROFILE_* override was cleared"
		$linkerOverrideCountProperty = $environmentPolicyProperty.Value.PSObject.Properties["clearedMsvcLinkOptionOverrideCount"]
		if ($null -eq $linkerOverrideCountProperty) {
			$failures.Add("MSVC linker option-environment policy evidence is missing")
		} else {
			Assert-True (
				$linkerOverrideCountProperty.Value -eq $linkerHostileOverrides.Count
			) "not every hostile LINK/_LINK_ override was cleared"
		}
	}

	if ($failures.Count -gt 0) {
		throw ("Build environment contract failures:`n- " + ($failures -join "`n- "))
	}
	Write-Output "Build environment contract passed: $($hostileHashes[0])"
} finally {
	foreach ($name in $allManagedNames) {
		if ($null -eq $previousEnvironment[$name]) {
			Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
		} else {
			[Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
		}
	}
}
