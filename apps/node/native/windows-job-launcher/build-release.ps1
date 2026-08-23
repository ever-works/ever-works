[CmdletBinding()]
param(
	[string]$OutputDirectory = "target\release-metadata"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
$targetTriple = "x86_64-pc-windows-msvc"
$artifactName = "ever-works-windows-job-launcher.exe"
$fixedRustFlags = "-C link-arg=/Brepro"
$metadataDirectory = Join-Path $packageRoot $OutputDirectory
$metadataPath = Join-Path $metadataDirectory "ever-works-windows-job-launcher.json"
$sbomName = "ever-works-windows-job-launcher.sbom.cdx.json"
$sbomPath = Join-Path $metadataDirectory $sbomName
$provenanceName = "ever-works-windows-job-launcher.provenance.intoto.json"
$provenancePath = Join-Path $metadataDirectory $provenanceName
$targetRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot "target"))
$firstTargetDirectory = Join-Path $targetRoot "repro-build-1"
$secondTargetDirectory = Join-Path $targetRoot "repro-build-2"
$isolatedCargoHome = Join-Path $targetRoot "repro-cargo-home"
$isolatedLinkerTemp = Join-Path $targetRoot "repro-linker-temp"
$canonicalBinaryPath = Join-Path $targetRoot "$targetTriple\release\$artifactName"
. (Join-Path $packageRoot "pe-authenticode-content.ps1")

$cargoRustEnvironmentNames = @(
	[Environment]::GetEnvironmentVariables("Process").Keys |
		ForEach-Object { [string]$_ } |
		Where-Object { $_ -match '^(CARGO_|RUST)' } |
		Sort-Object -Unique
)
$clearedCargoProfileOverrideCount = @(
	$cargoRustEnvironmentNames | Where-Object { $_ -match '^CARGO_PROFILE_' }
).Count
$msvcLinkOptionEnvironmentNames = @("LINK", "_LINK_")
$clearedMsvcLinkOptionOverrideCount = @(
	$msvcLinkOptionEnvironmentNames |
		Where-Object { $null -ne [Environment]::GetEnvironmentVariable($_, "Process") }
).Count
$fixedManagedEnvironmentNames = @(
	"CARGO_HOME",
	"CARGO_BUILD_INCREMENTAL",
	"CARGO_BUILD_RUSTC",
	"CARGO_BUILD_RUSTC_WRAPPER",
	"CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
	"CARGO_ENCODED_RUSTFLAGS",
	"CARGO_INCREMENTAL",
	"CARGO_TARGET_DIR",
	"CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER",
	"CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
	"INCLUDE",
	"LIB",
	"LINK",
	"_LINK_",
	"PATH",
	"RUSTC",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTC_WRAPPER",
	"RUSTFLAGS",
	"SOURCE_DATE_EPOCH",
	"TEMP",
	"TMP",
	"UniversalCRTSdkDir",
	"UCRTVersion",
	"VCToolsInstallDir",
	"VCToolsVersion",
	"WindowsSdkDir",
	"WindowsSDKVersion"
)
$managedEnvironmentNames = @(
	$cargoRustEnvironmentNames + $fixedManagedEnvironmentNames |
		Sort-Object -Unique
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironmentNames) {
	$previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Write-DeterministicJson {
	param(
		[Parameter(Mandatory)] [object]$Value,
		[Parameter(Mandatory)] [string]$LiteralPath
	)
	$json = $Value | ConvertTo-Json -Depth 24 -Compress
	[IO.File]::WriteAllText($LiteralPath, "$json`n", [Text.UTF8Encoding]::new($false))
}

function Get-Sha256 {
	param([Parameter(Mandatory)] [string]$LiteralPath)
	return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Get-LibrarySetIdentity {
	param([Parameter(Mandatory)] [string]$LiteralPath)
	$entries = @(
		Get-ChildItem -LiteralPath $LiteralPath -Filter "*.lib" -File |
			Sort-Object -Property Name |
			ForEach-Object { "$($_.Name.ToLowerInvariant())=$(Get-Sha256 $_.FullName)" }
	)
	if ($entries.Count -eq 0) {
		throw "library input directory is empty"
	}
	$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($entries -join "`n") + "`n")
	try {
		$hash = [Security.Cryptography.SHA256]::HashData($bytes)
	} finally {
		[Array]::Clear($bytes, 0, $bytes.Length)
	}
	return [ordered]@{
		libraryCount = $entries.Count
		librarySetSha256 = [Convert]::ToHexString($hash).ToLowerInvariant()
	}
}

function Invoke-CapturedTool {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[Parameter(Mandatory)] [string[]]$Arguments,
		[Parameter(Mandatory)] [string]$Name
	)
	$output = & $LiteralPath @Arguments 2>&1
	if ($LASTEXITCODE -ne 0) {
		throw "$Name failed"
	}
	return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Get-LatestVersionDirectory {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[Parameter(Mandatory)] [scriptblock]$Predicate,
		[Parameter(Mandatory)] [string]$Name
	)
	if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
		throw "$Name root is unavailable"
	}
	$directory = Get-ChildItem -LiteralPath $LiteralPath -Directory |
		Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (& $Predicate $_.FullName) } |
		Sort-Object { [version]$_.Name } |
		Select-Object -Last 1
	if ($null -eq $directory) {
		throw "$Name is unavailable"
	}
	return $directory
}

function Assert-DisposableTargetDirectory {
	param([Parameter(Mandatory)] [string]$LiteralPath)
	$resolved = [IO.Path]::GetFullPath($LiteralPath)
	$prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
	if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
		throw "isolated build directory escapes the package target root"
	}
	if ($resolved -ne $firstTargetDirectory -and $resolved -ne $secondTargetDirectory) {
		throw "refusing to clean an unexpected build directory"
	}
}

function Reset-IsolatedCargoHome {
	$resolved = [IO.Path]::GetFullPath($isolatedCargoHome)
	$prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
	if (
		-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
		$resolved -cne $isolatedCargoHome
	) {
		throw "refusing to clean an unexpected Cargo home"
	}
	if (Test-Path -LiteralPath $isolatedCargoHome) {
		Remove-Item -LiteralPath $isolatedCargoHome -Recurse -Force
	}
	New-Item -ItemType Directory -Path $isolatedCargoHome | Out-Null
}

function Reset-IsolatedLinkerTemp {
	$resolved = [IO.Path]::GetFullPath($isolatedLinkerTemp)
	$prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
	if (
		-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
		$resolved -cne $isolatedLinkerTemp
	) {
		throw "refusing to clean an unexpected linker temporary directory"
	}
	if (Test-Path -LiteralPath $isolatedLinkerTemp) {
		Remove-Item -LiteralPath $isolatedLinkerTemp -Recurse -Force
	}
	New-Item -ItemType Directory -Path $isolatedLinkerTemp | Out-Null
}

function Invoke-IsolatedReleaseBuild {
	param(
		[Parameter(Mandatory)] [string]$CargoPath,
		[Parameter(Mandatory)] [string]$TargetDirectory
	)
	Assert-DisposableTargetDirectory $TargetDirectory
	if (Test-Path -LiteralPath $TargetDirectory) {
		Remove-Item -LiteralPath $TargetDirectory -Recurse -Force
	}
	$env:CARGO_TARGET_DIR = $TargetDirectory
	$buildOutput = & $CargoPath build --locked --release --target $targetTriple 2>&1
	$buildExitCode = $LASTEXITCODE
	$buildOutput | ForEach-Object { Write-Host ([string]$_) }
	if ($buildExitCode -ne 0) {
		throw "isolated Cargo release build failed"
	}
	$binaryPath = Join-Path $TargetDirectory "$targetTriple\release\$artifactName"
	if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
		throw "isolated Cargo release build did not produce the launcher"
	}
	return $binaryPath
}

function Get-UntrustedInvocationHint {
	param([Parameter(Mandatory)] [string]$Name)
	$value = [Environment]::GetEnvironmentVariable($Name, "Process")
	if ([string]::IsNullOrWhiteSpace($value)) {
		return "unset"
	}
	if ($value.Length -gt 512) {
		return $value.Substring(0, 512)
	}
	return $value
}

function Get-UntrustedInvocationHints {
	$claimedProvider = "unmanaged"
	if ((Get-UntrustedInvocationHint "GITHUB_ACTIONS") -ceq "true") {
		$claimedProvider = "github-actions"
	}
	return [ordered]@{
		trust = "untrusted-environment"
		claimedProvider = $claimedProvider
		githubRepository = (Get-UntrustedInvocationHint "GITHUB_REPOSITORY")
		githubRunAttempt = (Get-UntrustedInvocationHint "GITHUB_RUN_ATTEMPT")
		githubRunId = (Get-UntrustedInvocationHint "GITHUB_RUN_ID")
		githubWorkflowRef = (Get-UntrustedInvocationHint "GITHUB_WORKFLOW_REF")
		runnerOs = (Get-UntrustedInvocationHint "RUNNER_OS")
		runnerArch = (Get-UntrustedInvocationHint "RUNNER_ARCH")
		runnerEnvironment = (Get-UntrustedInvocationHint "RUNNER_ENVIRONMENT")
		imageOs = (Get-UntrustedInvocationHint "ImageOS")
		imageVersion = (Get-UntrustedInvocationHint "ImageVersion")
	}
}

try {
	$invocationHints = Get-UntrustedInvocationHints
	foreach ($name in $cargoRustEnvironmentNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	foreach ($name in $msvcLinkOptionEnvironmentNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	Push-Location $packageRoot
	try {
		$sourceStatus = git status --porcelain=v1 --untracked-files=normal -- .
		if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($sourceStatus -join ""))) {
			throw "release metadata requires a clean package source tree"
		}

		$sourceCommit = (git rev-parse HEAD).Trim()
		$sourceDateEpoch = (git show -s --format=%ct HEAD).Trim()
		if (
			$LASTEXITCODE -ne 0 -or
			$sourceCommit -notmatch '^[0-9a-f]{40}$' -or
			$sourceDateEpoch -notmatch '^[0-9]+$'
		) {
			throw "unable to resolve deterministic source identity"
		}

		$rustcProxy = (Get-Command rustc -ErrorAction Stop).Source
		$rustSysroot = (Invoke-CapturedTool -LiteralPath $rustcProxy -Arguments @("--print", "sysroot") -Name "rustc sysroot").Trim()
		$rustcPath = Join-Path $rustSysroot "bin\rustc.exe"
		$cargoPath = Join-Path $rustSysroot "bin\cargo.exe"
		if (-not (Test-Path -LiteralPath $rustcPath -PathType Leaf) -or -not (Test-Path -LiteralPath $cargoPath -PathType Leaf)) {
			throw "pinned Rust toolchain executables are unavailable"
		}
		$rustcVerbose = Invoke-CapturedTool -LiteralPath $rustcPath -Arguments @("-Vv") -Name "rustc version"
		$cargoVerbose = Invoke-CapturedTool -LiteralPath $cargoPath -Arguments @("-Vv") -Name "cargo version"
		if ($rustcVerbose -notmatch '(?m)^release: 1\.88\.0$' -or $cargoVerbose -notmatch '(?m)^cargo 1\.88\.0 ') {
			throw "resolved Rust toolchain does not match rust-toolchain.toml"
		}

		$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
		if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
			throw "vswhere is required to resolve the MSVC linker input"
		}
		$visualStudioPath = (Invoke-CapturedTool `
			-LiteralPath $vswherePath `
			-Arguments @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath") `
			-Name "vswhere installation path").Trim()
		$visualStudioVersion = (Invoke-CapturedTool `
			-LiteralPath $vswherePath `
			-Arguments @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationVersion") `
			-Name "vswhere installation version").Trim()
		$msvcToolsRoot = Join-Path $visualStudioPath "VC\Tools\MSVC"
		$msvcToolset = Get-LatestVersionDirectory `
			-LiteralPath $msvcToolsRoot `
			-Name "MSVC toolset" `
			-Predicate { param($path) Test-Path -LiteralPath (Join-Path $path "bin\Hostx64\x64\link.exe") }
		$linkerPath = Join-Path $msvcToolset.FullName "bin\Hostx64\x64\link.exe"
		$cvtresPath = Join-Path $msvcToolset.FullName "bin\Hostx64\x64\cvtres.exe"
		$msvcLibDirectory = Join-Path $msvcToolset.FullName "lib\x64"
		$msvcRuntimeLibPath = Join-Path $msvcLibDirectory "libvcruntime.lib"
		if (-not (Test-Path -LiteralPath $msvcRuntimeLibPath -PathType Leaf)) {
			throw "MSVC x64 runtime library input is unavailable"
		}
		if (-not (Test-Path -LiteralPath $cvtresPath -PathType Leaf)) {
			throw "MSVC resource-conversion linker input is unavailable"
		}

		$windowsKits = Get-ItemProperty `
			-Path "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows Kits\Installed Roots" `
			-ErrorAction Stop
		$windowsSdkRoot = [string]$windowsKits.KitsRoot10
		$sdkVersionDirectory = Get-LatestVersionDirectory `
			-LiteralPath (Join-Path $windowsSdkRoot "Lib") `
			-Name "Windows SDK x64 libraries" `
			-Predicate {
				param($path)
				(Test-Path -LiteralPath (Join-Path $path "um\x64\kernel32.lib")) -and
				(Test-Path -LiteralPath (Join-Path $path "ucrt\x64\ucrt.lib"))
			}
		$windowsSdkVersion = $sdkVersionDirectory.Name
		$windowsSdkUmLibDirectory = Join-Path $sdkVersionDirectory.FullName "um\x64"
		$windowsSdkUcrtLibDirectory = Join-Path $sdkVersionDirectory.FullName "ucrt\x64"
		$kernel32LibPath = Join-Path $windowsSdkUmLibDirectory "kernel32.lib"
		$ucrtLibPath = Join-Path $windowsSdkUcrtLibDirectory "ucrt.lib"
		$msvcLibrarySet = Get-LibrarySetIdentity $msvcLibDirectory
		$windowsSdkUmLibrarySet = Get-LibrarySetIdentity $windowsSdkUmLibDirectory
		$windowsSdkUcrtLibrarySet = Get-LibrarySetIdentity $windowsSdkUcrtLibDirectory

		Reset-IsolatedCargoHome
		Reset-IsolatedLinkerTemp
		$env:CARGO_HOME = $isolatedCargoHome
		$env:RUSTFLAGS = $fixedRustFlags
		$env:CARGO_INCREMENTAL = "0"
		$env:CARGO_BUILD_INCREMENTAL = "false"
		$env:CARGO_BUILD_RUSTC = $rustcPath
		$env:RUSTC = $rustcPath
		$env:SOURCE_DATE_EPOCH = $sourceDateEpoch
		$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $linkerPath
		$fixedPathDirectories = @(
			Split-Path -Parent $rustcPath
			Split-Path -Parent $linkerPath
			[Environment]::SystemDirectory
		) | Select-Object -Unique
		$env:PATH = $fixedPathDirectories -join ";"
		$env:TMP = $isolatedLinkerTemp
		$env:TEMP = $isolatedLinkerTemp
		$env:VCToolsInstallDir = $msvcToolset.FullName.TrimEnd("\") + "\"
		$env:VCToolsVersion = $msvcToolset.Name
		$env:WindowsSdkDir = $windowsSdkRoot.TrimEnd("\") + "\"
		$env:WindowsSDKVersion = "$windowsSdkVersion\"
		$env:UniversalCRTSdkDir = $windowsSdkRoot.TrimEnd("\") + "\"
		$env:UCRTVersion = $windowsSdkVersion
		$env:LIB = @($msvcLibDirectory, $windowsSdkUcrtLibDirectory, $windowsSdkUmLibDirectory) -join ";"
		$env:INCLUDE = ""

		$firstBinaryPath = Invoke-IsolatedReleaseBuild -CargoPath $cargoPath -TargetDirectory $firstTargetDirectory
		$firstBuildSha256 = Get-Sha256 $firstBinaryPath
		$secondBinaryPath = Invoke-IsolatedReleaseBuild -CargoPath $cargoPath -TargetDirectory $secondTargetDirectory
		$secondBuildSha256 = Get-Sha256 $secondBinaryPath
		if ($firstBuildSha256 -cne $secondBuildSha256) {
			throw "independent clean Cargo builds produced different executable SHA-256 values"
		}

		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $canonicalBinaryPath) | Out-Null
		Copy-Item -LiteralPath $firstBinaryPath -Destination $canonicalBinaryPath -Force
		$unsignedIdentity = Get-PeAuthenticodeContentIdentity -LiteralPath $canonicalBinaryPath -RequireUnsigned
		if ((Get-Sha256 $canonicalBinaryPath) -cne $firstBuildSha256) {
			throw "canonical unsigned artifact differs from the verified reproducible build"
		}

		$cargoMetadataJson = & $cargoPath metadata --locked --format-version 1
		if ($LASTEXITCODE -ne 0) {
			throw "cargo metadata failed"
		}
		$cargoMetadata = ($cargoMetadataJson -join "`n") | ConvertFrom-Json
	} finally {
		Pop-Location
	}

	New-Item -ItemType Directory -Force -Path $metadataDirectory | Out-Null
	$cargoLockSha256 = Get-Sha256 (Join-Path $packageRoot "Cargo.lock")
	$rootPackage = $cargoMetadata.packages |
		Where-Object { $_.name -eq "ever-works-windows-job-launcher" } |
		Select-Object -First 1
	if ($null -eq $rootPackage) {
		throw "launcher package missing from locked Cargo metadata"
	}

	$components = @(
		$cargoMetadata.packages |
			Where-Object { $_.id -ne $rootPackage.id } |
			Sort-Object -Property name, version, source |
			ForEach-Object {
				$component = [ordered]@{
					type = "library"
					"bom-ref" = "pkg:cargo/$($_.name)@$($_.version)"
					name = $_.name
					version = $_.version
					purl = "pkg:cargo/$($_.name)@$($_.version)"
				}
				if (-not [string]::IsNullOrWhiteSpace($_.license)) {
					$component["licenses"] = @([ordered]@{ expression = $_.license })
				}
				$checksumProperty = $_.PSObject.Properties["checksum"]
				if ($null -ne $checksumProperty -and [string]$checksumProperty.Value -match '^[0-9a-f]{64}$') {
					$component["hashes"] = @(
						[ordered]@{ alg = "SHA-256"; content = [string]$checksumProperty.Value }
					)
				}
				$component
			}
	)
	$sbom = [ordered]@{
		bomFormat = "CycloneDX"
		specVersion = "1.5"
		version = 1
		metadata = [ordered]@{
			component = [ordered]@{
				type = "application"
				"bom-ref" = "pkg:cargo/ever-works-windows-job-launcher@$($rootPackage.version)"
				name = "ever-works-windows-job-launcher"
				version = $rootPackage.version
				purl = "pkg:cargo/ever-works-windows-job-launcher@$($rootPackage.version)"
			}
		}
		components = $components
	}
	Write-DeterministicJson -Value $sbom -LiteralPath $sbomPath
	$sbomSha256 = Get-Sha256 $sbomPath

	$builder = [ordered]@{
		kind = "local-untrusted"
		id = "urn:ever-works:builder:build-release-script:v3"
	}
	$environmentPolicy = [ordered]@{
		mode = "isolated-cargo-rust-allowlist"
		cargoHome = "target/repro-cargo-home"
		clearedCargoRustOverrideCount = $cargoRustEnvironmentNames.Count
		clearedCargoProfileOverrideCount = $clearedCargoProfileOverrideCount
		clearedMsvcLinkOptionOverrideCount = $clearedMsvcLinkOptionOverrideCount
		msvcLinkerEnvironment = [ordered]@{
			recognizedInputs = @("LINK", "_LINK_", "LIB", "PATH", "TMP")
			linkOptions = "cleared"
			libraryPath = "fixed-msvc-sdk"
			executableSearchPath = "fixed-rust-msvc-system"
			temporaryDirectory = "target/repro-linker-temp"
		}
		effective = [ordered]@{
			rustFlags = $fixedRustFlags
			cargoIncremental = $false
			cargoBuildIncremental = $false
			rustcWrapper = "disabled"
			rustcWorkspaceWrapper = "disabled"
			cargoTargetDirectory = "per-build-isolated"
		}
	}
	$buildInputs = [ordered]@{
		rustFlags = $fixedRustFlags
		rustc = [ordered]@{
			version = ($rustcVerbose -split "`n" | Select-Object -First 1)
			verboseVersion = $rustcVerbose
			sha256 = Get-Sha256 $rustcPath
		}
		cargo = [ordered]@{
			version = ($cargoVerbose -split "`n" | Select-Object -First 1)
			verboseVersion = $cargoVerbose
			sha256 = Get-Sha256 $cargoPath
		}
		targetTriple = $targetTriple
		msvcToolset = [ordered]@{
			version = $msvcToolset.Name
			visualStudioVersion = $visualStudioVersion
			runtimeLibrarySha256 = Get-Sha256 $msvcRuntimeLibPath
			libraryCount = $msvcLibrarySet.libraryCount
			librarySetSha256 = $msvcLibrarySet.librarySetSha256
		}
		linker = [ordered]@{
			name = "link.exe"
			fileVersion = [string](Get-Item -LiteralPath $linkerPath).VersionInfo.FileVersion
			productVersion = [string](Get-Item -LiteralPath $linkerPath).VersionInfo.ProductVersion
			sha256 = Get-Sha256 $linkerPath
			cvtresSha256 = Get-Sha256 $cvtresPath
		}
		windowsSdk = [ordered]@{
			version = $windowsSdkVersion
			kernel32LibrarySha256 = Get-Sha256 $kernel32LibPath
			ucrtLibrarySha256 = Get-Sha256 $ucrtLibPath
			umLibraryCount = $windowsSdkUmLibrarySet.libraryCount
			umLibrarySetSha256 = $windowsSdkUmLibrarySet.librarySetSha256
			ucrtLibraryCount = $windowsSdkUcrtLibrarySet.libraryCount
			ucrtLibrarySetSha256 = $windowsSdkUcrtLibrarySet.librarySetSha256
		}
		builder = $builder
		environmentPolicy = $environmentPolicy
	}
	$relativeFirstBinary = "target/repro-build-1/$targetTriple/release/$artifactName"
	$relativeSecondBinary = "target/repro-build-2/$targetTriple/release/$artifactName"
	$reproducibility = [ordered]@{
		verified = $true
		buildCount = 2
		buildSha256 = @($firstBuildSha256, $secondBuildSha256)
		buildArtifacts = @($relativeFirstBinary, $relativeSecondBinary)
		isolatedTargetDirectories = $true
		incremental = $false
		compilerCache = "disabled"
	}

	$provenance = [ordered]@{
		"_type" = "https://in-toto.io/Statement/v1"
		subject = @(
			[ordered]@{
				name = $artifactName
				digest = [ordered]@{ sha256 = $firstBuildSha256 }
			}
		)
		predicateType = "https://slsa.dev/provenance/v1"
		predicate = [ordered]@{
			buildDefinition = [ordered]@{
				buildType = "https://ever.co/build-types/cargo-windows-msvc-brepro/v2"
				externalParameters = [ordered]@{
					targetTriple = $targetTriple
					rustToolchain = "1.88.0"
					rustFlags = $fixedRustFlags
					cargoLocked = $true
				}
				internalParameters = [ordered]@{
					sourceDateEpoch = $sourceDateEpoch
					cargoIncremental = $false
					compilerCache = "disabled"
					isolatedTargetDirectories = $true
					buildInputs = $buildInputs
				}
				resolvedDependencies = @(
					[ordered]@{
						uri = "git+https://github.com/ever-co/ever-works.git"
						digest = [ordered]@{ gitCommit = $sourceCommit }
					},
					[ordered]@{
						uri = "file:Cargo.lock"
						digest = [ordered]@{ sha256 = $cargoLockSha256 }
					},
					[ordered]@{
						uri = "file:$sbomName"
						digest = [ordered]@{ sha256 = $sbomSha256 }
					}
				)
			}
			runDetails = [ordered]@{
				builder = $builder
				metadata = [ordered]@{
					reproducible = $true
					reproducibilityEvidence = $reproducibility
					invocationHints = $invocationHints
				}
			}
		}
	}
	Write-DeterministicJson -Value $provenance -LiteralPath $provenancePath
	$provenanceSha256 = Get-Sha256 $provenancePath

	$metadata = [ordered]@{
		schemaVersion = 3
		productionEligible = $false
		artifact = $artifactName
		targetTriple = $targetTriple
		rustToolchain = "1.88.0"
		cargoLocked = $true
		sourceCommit = $sourceCommit
		binarySize = $unsignedIdentity.FileSize
		unsignedBuildSha256 = $firstBuildSha256
		authenticodeContentSha256 = $unsignedIdentity.ContentSha256
		cargoLockSha256 = $cargoLockSha256
		buildInputs = $buildInputs
		invocationHints = $invocationHints
		reproducibility = $reproducibility
		sbom = $sbomName
		sbomSha256 = $sbomSha256
		provenance = $provenanceName
		provenanceSha256 = $provenanceSha256
		authenticode = [ordered]@{ status = "unsigned"; productionUse = "forbidden" }
	}
	Write-DeterministicJson -Value $metadata -LiteralPath $metadataPath
	Write-Output $metadataPath
} finally {
	foreach ($name in $managedEnvironmentNames) {
		[Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
	}
}
