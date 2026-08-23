[CmdletBinding()]
param(
	[ValidateSet("All", "ToolDiscovery", "CargoBoundary")]
	[string]$Scenario = "All"
)

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
$createdAncestorConfigDirectories = [Collections.Generic.List[string]]::new()
$cargoMutationJob = $null
$originalPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
$originalProgramFiles = [Environment]::GetEnvironmentVariable("ProgramFiles", "Process")
$originalProgramFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)", "Process")
$osLocalApplicationData = [Environment]::GetFolderPath(
	[Environment+SpecialFolder]::LocalApplicationData,
	[Environment+SpecialFolderOption]::DoNotVerify
)
$repositoryRoot = (& git -C $packageRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repositoryRoot)) {
	throw "unable to resolve repository root for ancestor Cargo-config testing"
}
$repositoryRoot = [IO.Path]::GetFullPath($repositoryRoot)
$ancestorConfigDirectories = @(
	Join-Path $repositoryRoot ".cargo"
	Join-Path (Split-Path -Parent $packageRoot) ".cargo"
)

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
	@("CARGO_ENCODED_RUSTFLAGS", "PATH", "ProgramFiles", "ProgramFiles(x86)") |
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

function New-HostileAncestorCargoConfigs {
	foreach ($directory in $ancestorConfigDirectories) {
		$resolved = [IO.Path]::GetFullPath($directory)
		$prefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
		if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
			throw "ancestor Cargo-config fixture escapes the isolated repository"
		}
		if (Test-Path -LiteralPath $resolved) {
			throw "refusing to overwrite an existing ancestor Cargo-config directory"
		}
		New-Item -ItemType Directory -Path $resolved | Out-Null
		$createdAncestorConfigDirectories.Add($resolved)
	}
	$repositoryConfig = @'
[profile.release]
opt-level = 0
lto = false
codegen-units = 256
debug = "full"
strip = "none"
panic = "unwind"
'@
	$nearPackageConfig = @'
[build]
rustc-wrapper = 'C:\missing-ancestor-rustc-wrapper.exe'

[target.x86_64-pc-windows-msvc]
linker = 'C:\missing-ancestor-linker.exe'
rustflags = ['-C', 'opt-level=0']
'@
	[IO.File]::WriteAllText(
		(Join-Path $ancestorConfigDirectories[0] "config.toml"),
		$repositoryConfig,
		[Text.UTF8Encoding]::new($false)
	)
	[IO.File]::WriteAllText(
		(Join-Path $ancestorConfigDirectories[1] "config.toml"),
		$nearPackageConfig,
		[Text.UTF8Encoding]::new($false)
	)
}

function Start-CargoBoundaryMutationJob {
	param(
		[Parameter(Mandatory)] [string]$HostileConfigDirectory,
		[Parameter(Mandatory)] [string]$MarkerPath
	)
	$packageRootBytes = [Text.UTF8Encoding]::new($false).GetBytes($packageRoot.ToLowerInvariant())
	try {
		$packageRootToken = [Convert]::ToHexString(
			[Security.Cryptography.SHA256]::HashData($packageRootBytes)
		).Substring(0, 16).ToLowerInvariant()
	} finally {
		[Array]::Clear($packageRootBytes, 0, $packageRootBytes.Length)
	}
	$legacyPredictableRoot = [IO.Path]::GetFullPath(
		(Join-Path ([IO.Path]::GetTempPath()) "ever-works-cargo-$packageRootToken")
	)
	$privateInvocationRoot = [IO.Path]::GetFullPath(
		(Join-Path $osLocalApplicationData "EverWorks\CargoInvocations")
	)
	return Start-Job -ArgumentList @(
		$legacyPredictableRoot,
		$privateInvocationRoot,
		$HostileConfigDirectory,
		$MarkerPath
	) -ScriptBlock {
		param($LegacyRoot, $PrivateRoot, $HostileRoot, $Marker)
		$deadline = [DateTime]::UtcNow.AddMinutes(3)
		while ([DateTime]::UtcNow -lt $deadline) {
			$candidates = [Collections.Generic.List[string]]::new()
			if (Test-Path -LiteralPath $LegacyRoot -PathType Container) {
				$candidates.Add($LegacyRoot)
			}
			if (Test-Path -LiteralPath $PrivateRoot -PathType Container) {
				try {
					Get-ChildItem -LiteralPath $PrivateRoot -Directory -ErrorAction Stop |
						ForEach-Object { $candidates.Add($_.FullName) }
				} catch {
					# A private ACL is an acceptable reason for the hostile watcher to see nothing.
				}
			}
			foreach ($candidate in $candidates) {
				$junction = Join-Path $candidate ".cargo"
				if (Test-Path -LiteralPath $junction) {
					continue
				}
				try {
					New-Item -ItemType Junction -Path $junction -Target $HostileRoot -ErrorAction Stop | Out-Null
					[IO.File]::WriteAllText($Marker, $candidate, [Text.UTF8Encoding]::new($false))
					try {
						[IO.Directory]::Delete($junction)
					} catch {
						# The owning build performs bounded cleanup of its own working directory.
					}
					return
				} catch {
					# Expected once the controlled directory has a read-only private boundary.
				}
			}
			Start-Sleep -Milliseconds 5
		}
	}
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

	$controlEnvironment = [ordered]@{
		PATH = $originalPath
		ProgramFiles = $originalProgramFiles
		"ProgramFiles(x86)" = $originalProgramFilesX86
	}
	Set-TestEnvironment -Values $controlEnvironment
	& $buildScript -OutputDirectory $controlMetadataDirectory | Out-Null
	$controlMetadata = Get-ReleaseMetadata $controlMetadataDirectory
	$controlHashes = Get-ActualBuildHashes $controlMetadata
	for ($index = 0; $index -lt $controlMetadata.reproducibility.buildArtifacts.Count; $index++) {
		Copy-Item `
			-LiteralPath (Join-Path $packageRoot $controlMetadata.reproducibility.buildArtifacts[$index]) `
			-Destination (Join-Path $evidenceDirectory "control-$index.exe")
	}
	New-HostileAncestorCargoConfigs

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
	$hostileEnvironment["PATH"] = $originalPath
	$hostileEnvironment["ProgramFiles"] = $originalProgramFiles
	$hostileEnvironment["ProgramFiles(x86)"] = $originalProgramFilesX86

	$toolPoisonMarker = Join-Path $evidenceDirectory "inherited-path-rustc-used.txt"
	if ($Scenario -ne "CargoBoundary") {
		$toolPoisonRoot = Join-Path $evidenceDirectory "hostile-tool-discovery"
		$fakePathDirectory = Join-Path $toolPoisonRoot "path"
		$fakeVswhereDirectory = Join-Path $toolPoisonRoot "program-files-x86\Microsoft Visual Studio\Installer"
		New-Item -ItemType Directory -Force -Path $fakePathDirectory, $fakeVswhereDirectory | Out-Null
		$actualRustcProxy = @(
			Get-Command rustc.exe -CommandType Application -ErrorAction Stop
		)[0].Source
		$rustcWrapper = "@echo off`r`n>`"$toolPoisonMarker`" echo inherited PATH rustc executed`r`n`"$actualRustcProxy`" %*`r`n"
		[IO.File]::WriteAllText(
			(Join-Path $fakePathDirectory "rustc.cmd"),
			$rustcWrapper,
			[Text.Encoding]::ASCII
		)
		Copy-Item `
			-LiteralPath (Join-Path ([Environment]::SystemDirectory) "cmd.exe") `
			-Destination (Join-Path $fakeVswhereDirectory "vswhere.exe")
		$hostileEnvironment["PATH"] = "$fakePathDirectory;$originalPath"
		$hostileEnvironment["ProgramFiles(x86)"] = Join-Path $toolPoisonRoot "program-files-x86"
	}

	$cargoMutationMarker = Join-Path $evidenceDirectory "cargo-boundary-mutated.txt"
	if ($Scenario -ne "ToolDiscovery") {
		$hostileConfigDirectory = Join-Path $evidenceDirectory "hostile-concurrent-cargo-config"
		New-Item -ItemType Directory -Force -Path $hostileConfigDirectory | Out-Null
		[IO.File]::WriteAllText(
			(Join-Path $hostileConfigDirectory "config.toml"),
			"[build]`r`nrustc-wrapper = 'C:\missing-concurrent-wrapper.exe'`r`n",
			[Text.UTF8Encoding]::new($false)
		)
		$cargoMutationJob = Start-CargoBoundaryMutationJob `
			-HostileConfigDirectory $hostileConfigDirectory `
			-MarkerPath $cargoMutationMarker
	}
	Set-TestEnvironment -Values $hostileEnvironment
	& $buildScript -OutputDirectory $hostileMetadataDirectory | Out-Null
	if ($null -ne $cargoMutationJob) {
		Stop-Job -Job $cargoMutationJob -ErrorAction SilentlyContinue
		Receive-Job -Job $cargoMutationJob -ErrorAction SilentlyContinue | Out-Null
		Remove-Job -Job $cargoMutationJob -Force -ErrorAction SilentlyContinue
		$cargoMutationJob = $null
	}
	$hostileMetadata = Get-ReleaseMetadata $hostileMetadataDirectory
	$hostileHashes = Get-ActualBuildHashes $hostileMetadata

	Assert-True ($controlMetadata.reproducibility.verified -eq $true) "control build did not record verified reproducibility"
	Assert-True ($hostileMetadata.reproducibility.verified -eq $true) "hostile build did not record verified reproducibility"
	Assert-True (@($controlHashes | Select-Object -Unique).Count -eq 1) "control build executables differ"
	Assert-True (@($hostileHashes | Select-Object -Unique).Count -eq 1) "hostile build executables differ"
	Assert-True ($controlHashes[0] -ceq $hostileHashes[0]) "hostile Cargo/Rust/MSVC linker environment changed the release executable"
	Assert-True (-not (Test-Path -LiteralPath $toolPoisonMarker)) "build executed rustc selected from inherited PATH"
	Assert-True (-not (Test-Path -LiteralPath $cargoMutationMarker)) "concurrent watcher replaced the controlled Cargo configuration boundary"
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
		$cargoConfigDiscoveryProperty = $environmentPolicyProperty.Value.PSObject.Properties["cargoConfigDiscovery"]
		if ($null -eq $cargoConfigDiscoveryProperty) {
			$failures.Add("controlled Cargo-config discovery evidence is missing")
		} else {
			Assert-True (
				$cargoConfigDiscoveryProperty.Value.mode -ceq "private-acl-controlled-cwd-explicit-manifest"
			) "Cargo was not invoked from a controlled config-discovery root"
			Assert-True (
				$cargoConfigDiscoveryProperty.Value.reparseComponents -ceq "forbidden" -and
				$cargoConfigDiscoveryProperty.Value.mutationAccess -ceq "same-user-owner-can-rewrite-dacl" -and
				$cargoConfigDiscoveryProperty.Value.threatBoundary -ceq "production-forbidden-without-dedicated-builder-identity" -and
				$cargoConfigDiscoveryProperty.Value.revalidation -ceq "immediately-before-each-cargo-command"
			) "controlled Cargo directory did not record its reparse, ACL, and revalidation policy"
		}
		$toolDiscoveryProperty = $environmentPolicyProperty.Value.PSObject.Properties["toolDiscovery"]
		if ($null -eq $toolDiscoveryProperty) {
			$failures.Add("trusted absolute tool-discovery policy evidence is missing")
		} else {
			Assert-True (
				$toolDiscoveryProperty.Value.inheritedPath -ceq "ignored-before-first-external-command"
			) "inherited PATH remained a tool-discovery input"
			Assert-True (
				$toolDiscoveryProperty.Value.externalAttestation -ceq "required"
			) "tool identity metadata overclaimed an authenticated build origin"
		}
	}

	if ($failures.Count -gt 0) {
		throw ("Build environment contract failures:`n- " + ($failures -join "`n- "))
	}
	Write-Output "Build environment contract passed: $($hostileHashes[0])"
} finally {
	if ($null -ne $cargoMutationJob) {
		Stop-Job -Job $cargoMutationJob -ErrorAction SilentlyContinue
		Receive-Job -Job $cargoMutationJob -ErrorAction SilentlyContinue | Out-Null
		Remove-Job -Job $cargoMutationJob -Force -ErrorAction SilentlyContinue
	}
	for ($index = $createdAncestorConfigDirectories.Count - 1; $index -ge 0; $index--) {
		Remove-Item -LiteralPath $createdAncestorConfigDirectories[$index] -Recurse -Force
	}
	foreach ($name in $allManagedNames) {
		if ($null -eq $previousEnvironment[$name]) {
			Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
		} else {
			[Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
		}
	}
}
