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
$manifestPath = [IO.Path]::GetFullPath((Join-Path $packageRoot "Cargo.toml"))
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
$trustedToolchainPolicyPath = Join-Path $packageRoot "trusted-build-toolchain.json"
$controlledCargoCwd = $null
$controlledCargoIdentity = $null
$osUserProfile = [Environment]::GetFolderPath(
	[Environment+SpecialFolder]::UserProfile,
	[Environment+SpecialFolderOption]::DoNotVerify
)
$osProgramFiles = [Environment]::GetFolderPath(
	[Environment+SpecialFolder]::ProgramFiles,
	[Environment+SpecialFolderOption]::DoNotVerify
)
$osProgramFilesX86 = [Environment]::GetFolderPath(
	[Environment+SpecialFolder]::ProgramFilesX86,
	[Environment+SpecialFolderOption]::DoNotVerify
)
$osLocalApplicationData = [Environment]::GetFolderPath(
	[Environment+SpecialFolder]::LocalApplicationData,
	[Environment+SpecialFolderOption]::DoNotVerify
)
$privateCargoInvocationRoot = [IO.Path]::GetFullPath(
	(Join-Path $osLocalApplicationData "EverWorks\CargoInvocations")
)
. (Join-Path $packageRoot "pe-authenticode-content.ps1")

$cargoRustEnvironmentNames = @(
	[Environment]::GetEnvironmentVariables("Process").Keys |
		ForEach-Object { [string]$_ } |
		Where-Object { $_ -match '^(CARGO_|RUST)' } |
		Sort-Object -Unique
)
$gitEnvironmentNames = @(
	[Environment]::GetEnvironmentVariables("Process").Keys |
		ForEach-Object { [string]$_ } |
		Where-Object { $_ -match '^GIT_' } |
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
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_OPTIONAL_LOCKS",
	"GIT_PAGER",
	"INCLUDE",
	"LIB",
	"LOCALAPPDATA",
	"LINK",
	"_LINK_",
	"PATH",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"RUSTC",
	"RUSTUP_HOME",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTC_WRAPPER",
	"RUSTFLAGS",
	"SOURCE_DATE_EPOCH",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"UniversalCRTSdkDir",
	"UCRTVersion",
	"VCToolsInstallDir",
	"VCToolsVersion",
	"WindowsSdkDir",
	"WindowsSDKVersion"
)
$managedEnvironmentNames = @(
	$cargoRustEnvironmentNames + $gitEnvironmentNames + $fixedManagedEnvironmentNames |
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

function Get-FileSetIdentity {
	param(
		[Parameter(Mandatory)] [string]$BasePath,
		[Parameter(Mandatory)] [string[]]$LiteralPaths,
		[Parameter(Mandatory)] [string]$Name
	)
	$base = [IO.Path]::GetFullPath($BasePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
	$entries = @(
		$LiteralPaths |
			Sort-Object -Unique |
			ForEach-Object {
				$path = [IO.Path]::GetFullPath($_)
				$prefix = $base + [IO.Path]::DirectorySeparatorChar
				if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
					throw "$Name input escapes its trusted root"
				}
				if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
					throw "$Name input is unavailable"
				}
				$relative = [IO.Path]::GetRelativePath($base, $path).Replace("\", "/").ToLowerInvariant()
				"$relative=$(Get-Sha256 $path)"
			} |
			Sort-Object
	)
	if ($entries.Count -eq 0) {
		throw "$Name input set is empty"
	}
	$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($entries -join "`n") + "`n")
	try {
		$hash = [Security.Cryptography.SHA256]::HashData($bytes)
	} finally {
		[Array]::Clear($bytes, 0, $bytes.Length)
	}
	return [ordered]@{
		fileCount = $entries.Count
		fileSetSha256 = [Convert]::ToHexString($hash).ToLowerInvariant()
	}
}

function Assert-LocalCanonicalPath {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[Parameter(Mandatory)] [string]$Name
	)
	$fullPath = [IO.Path]::GetFullPath($LiteralPath)
	if ($fullPath.StartsWith("\\", [StringComparison]::Ordinal)) {
		throw "$Name must be on a local filesystem"
	}
	$root = [IO.Path]::GetPathRoot($fullPath)
	if ([string]::IsNullOrWhiteSpace($root)) {
		throw "$Name is not absolute"
	}
	$current = $root.TrimEnd([IO.Path]::DirectorySeparatorChar)
	if ([string]::IsNullOrEmpty($current)) {
		$current = $root
	}
	$relative = $fullPath.Substring($root.Length)
	foreach ($component in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
		$current = Join-Path $current $component
		if (-not (Test-Path -LiteralPath $current)) {
			throw "$Name path component is unavailable"
		}
		$item = Get-Item -LiteralPath $current -Force
		if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			throw "$Name path contains a reparse point"
		}
	}
	$resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $fullPath).ProviderPath)
	if ($resolved -ine $fullPath) {
		throw "$Name did not resolve to its canonical absolute path"
	}
	return $fullPath
}

function Assert-PathUnderRoot {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[Parameter(Mandatory)] [string]$RootPath,
		[Parameter(Mandatory)] [string]$Name
	)
	$path = Assert-LocalCanonicalPath -LiteralPath $LiteralPath -Name $Name
	$root = Assert-LocalCanonicalPath -LiteralPath $RootPath -Name "$Name root"
	$prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
	if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
		throw "$Name escapes its trusted OS root"
	}
	return $path
}

function Get-TrustedAuthenticodeIdentity {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[Parameter(Mandatory)] [string]$ExpectedPublisherSubject,
		[Parameter(Mandatory)] [string]$Name
	)
	$signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
	if (
		$signature.Status -ne "Valid" -or
		$null -eq $signature.SignerCertificate -or
		$signature.SignerCertificate.Subject -cne $ExpectedPublisherSubject
	) {
		throw "$Name does not have a Valid Authenticode signature from the pinned publisher"
	}
	return [ordered]@{
		sha256 = Get-Sha256 $LiteralPath
		authenticodeStatus = "Valid"
		publisherSubject = $signature.SignerCertificate.Subject
		publisherCertificateSha256 = $signature.SignerCertificate.GetCertHashString(
			[Security.Cryptography.HashAlgorithmName]::SHA256
		).ToLowerInvariant()
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

function Assert-ControlledCargoCwd {
	if ([string]::IsNullOrWhiteSpace($controlledCargoCwd)) {
		throw "controlled Cargo working directory is unavailable"
	}
	$resolved = Assert-PathUnderRoot `
		-LiteralPath $controlledCargoCwd `
		-RootPath $privateCargoInvocationRoot `
		-Name "controlled Cargo working directory"
	if ($resolved -cne $controlledCargoCwd) {
		throw "controlled Cargo working directory identity changed"
	}
	$item = Get-Item -LiteralPath $resolved -Force
	if ($item.Name -cne $controlledCargoIdentity) {
		throw "controlled Cargo working directory random identity changed"
	}
	$acl = Get-Acl -LiteralPath $resolved
	if (-not $acl.AreAccessRulesProtected) {
		throw "controlled Cargo working directory ACL inherited mutable permissions"
	}
	$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
	$writeMask = (
		[Security.AccessControl.FileSystemRights]::CreateFiles -bor
		[Security.AccessControl.FileSystemRights]::CreateDirectories -bor
		[Security.AccessControl.FileSystemRights]::WriteAttributes -bor
		[Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
		[Security.AccessControl.FileSystemRights]::Delete -bor
		[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
		[Security.AccessControl.FileSystemRights]::ChangePermissions -bor
		[Security.AccessControl.FileSystemRights]::TakeOwnership
	)
	$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
	foreach ($rule in $rules) {
		if (
			$rule.IdentityReference -eq $currentSid -and
			$rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
			($rule.FileSystemRights -band $writeMask) -ne 0
		) {
			throw "controlled Cargo working directory ACL permits mutation"
		}
	}
	$current = Get-Item -LiteralPath $resolved -Force
	while ($null -ne $current) {
		$cargoDirectory = Join-Path $current.FullName ".cargo"
		if (Test-Path -LiteralPath $cargoDirectory) {
			$cargoItem = Get-Item -LiteralPath $cargoDirectory -Force
			if (($cargoItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
				throw "controlled Cargo working-directory ancestry contains a reparse-point configuration directory"
			}
			foreach ($configName in @("config", "config.toml")) {
				if (Test-Path -LiteralPath (Join-Path $cargoDirectory $configName) -PathType Leaf) {
					throw "controlled Cargo working-directory ancestry contains a configuration file"
				}
			}
		}
		$current = $current.Parent
	}
}

function New-ControlledCargoCwd {
	if (-not (Test-Path -LiteralPath $privateCargoInvocationRoot -PathType Container)) {
		New-Item -ItemType Directory -Force -Path $privateCargoInvocationRoot | Out-Null
	}
	Assert-LocalCanonicalPath `
		-LiteralPath $privateCargoInvocationRoot `
		-Name "private Cargo invocation root" | Out-Null
	$script:controlledCargoIdentity = [Guid]::NewGuid().ToString("N")
	$script:controlledCargoCwd = [IO.Path]::GetFullPath(
		(Join-Path $privateCargoInvocationRoot $script:controlledCargoIdentity)
	)
	New-Item -ItemType Directory -Path $controlledCargoCwd | Out-Null
	$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
	$acl = [Security.AccessControl.DirectorySecurity]::new()
	$acl.SetOwner($currentSid)
	$acl.SetAccessRuleProtection($true, $false)
	$rights = (
		[Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
		[Security.AccessControl.FileSystemRights]::Synchronize
	)
	$inheritance = (
		[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
		[Security.AccessControl.InheritanceFlags]::ObjectInherit
	)
	$rule = [Security.AccessControl.FileSystemAccessRule]::new(
		$currentSid,
		$rights,
		$inheritance,
		[Security.AccessControl.PropagationFlags]::None,
		[Security.AccessControl.AccessControlType]::Allow
	)
	$acl.AddAccessRule($rule)
	Set-Acl -LiteralPath $controlledCargoCwd -AclObject $acl
	Assert-ControlledCargoCwd
}

function Remove-ControlledCargoCwd {
	if ([string]::IsNullOrWhiteSpace($controlledCargoCwd)) {
		return
	}
	try {
		Assert-PathUnderRoot `
			-LiteralPath $controlledCargoCwd `
			-RootPath $privateCargoInvocationRoot `
			-Name "controlled Cargo cleanup directory" | Out-Null
		if ([IO.Directory]::GetFileSystemEntries($controlledCargoCwd).Count -ne 0) {
			throw "refusing to clean a nonempty controlled Cargo working directory"
		}
		$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
		$acl = [Security.AccessControl.DirectorySecurity]::new()
		$acl.SetOwner($currentSid)
		$acl.SetAccessRuleProtection($true, $false)
		$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
			$currentSid,
			[Security.AccessControl.FileSystemRights]::FullControl,
			[Security.AccessControl.InheritanceFlags]::None,
			[Security.AccessControl.PropagationFlags]::None,
			[Security.AccessControl.AccessControlType]::Allow
		))
		Set-Acl -LiteralPath $controlledCargoCwd -AclObject $acl
		Remove-Item -LiteralPath $controlledCargoCwd -Force
	} finally {
		$script:controlledCargoCwd = $null
		$script:controlledCargoIdentity = $null
	}
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
	Assert-ControlledCargoCwd
	Push-Location $controlledCargoCwd
	try {
		Assert-ControlledCargoCwd
		$buildOutput = & $CargoPath build `
			--manifest-path $manifestPath `
			--locked `
			--release `
			--target $targetTriple 2>&1
		$buildExitCode = $LASTEXITCODE
	} finally {
		Pop-Location
	}
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

function Get-TrustedBuildPolicy {
	if (-not (Test-Path -LiteralPath $trustedToolchainPolicyPath -PathType Leaf)) {
		throw "checked-in build toolchain policy is unavailable"
	}
	$policy = Get-Content -Raw -LiteralPath $trustedToolchainPolicyPath | ConvertFrom-Json
	if (
		$policy.schemaVersion -ne 1 -or
		$policy.rustToolchain -cne "1.88.0" -or
		$policy.targetTriple -cne $targetTriple -or
		$policy.attestationBoundary -cne "external-authenticated-runner-attestation-required" -or
		@($policy.rustFiles).Count -lt 4
	) {
		throw "checked-in build toolchain policy is invalid"
	}
	foreach ($hash in @(
		$policy.rustBinarySet.fileSetSha256,
		$policy.rustTargetLibrarySet.fileSetSha256
	)) {
		if ([string]$hash -notmatch '^[0-9a-f]{64}$') {
			throw "checked-in build toolchain policy contains an invalid SHA-256"
		}
	}
	return $policy
}

function Get-TrustedRustToolchainIdentity {
	param([Parameter(Mandatory)] [object]$Policy)
	$rustRoot = [IO.Path]::GetFullPath(
		(Join-Path $osUserProfile ([string]$Policy.rustRootRelativeToOsUserProfile))
	)
	Assert-PathUnderRoot `
		-LiteralPath $rustRoot `
		-RootPath $osUserProfile `
		-Name "pinned Rust toolchain" | Out-Null
	$rustPaths = [Collections.Generic.List[string]]::new()
	foreach ($entry in @($Policy.rustFiles)) {
		$relativePath = ([string]$entry.path).Replace("/", "\")
		if (
			[IO.Path]::IsPathRooted($relativePath) -or
			$relativePath.Contains("..") -or
			[string]$entry.sha256 -notmatch '^[0-9a-f]{64}$'
		) {
			throw "checked-in Rust file pin is invalid"
		}
		$path = [IO.Path]::GetFullPath((Join-Path $rustRoot $relativePath))
		Assert-PathUnderRoot -LiteralPath $path -RootPath $rustRoot -Name "pinned Rust file" | Out-Null
		if ((Get-Sha256 $path) -cne [string]$entry.sha256) {
			throw "pinned Rust file SHA-256 does not match the checked-in policy"
		}
		$rustPaths.Add($path)
	}
	$binarySet = Get-FileSetIdentity `
		-BasePath $rustRoot `
		-LiteralPaths $rustPaths.ToArray() `
		-Name "pinned Rust binary set"
	if (
		$binarySet.fileCount -ne [int]$Policy.rustBinarySet.fileCount -or
		$binarySet.fileSetSha256 -cne [string]$Policy.rustBinarySet.fileSetSha256
	) {
		throw "pinned Rust binary set does not match the checked-in policy"
	}
	$targetLibraryDirectory = [IO.Path]::GetFullPath(
		(Join-Path $rustRoot ([string]$Policy.rustTargetLibrarySet.relativeDirectory).Replace("/", "\"))
	)
	Assert-PathUnderRoot `
		-LiteralPath $targetLibraryDirectory `
		-RootPath $rustRoot `
		-Name "pinned Rust target library directory" | Out-Null
	$targetLibraries = @(
		Get-ChildItem -LiteralPath $targetLibraryDirectory -File |
			ForEach-Object { $_.FullName }
	)
	$targetLibrarySet = Get-FileSetIdentity `
		-BasePath $rustRoot `
		-LiteralPaths $targetLibraries `
		-Name "pinned Rust target library set"
	if (
		$targetLibrarySet.fileCount -ne [int]$Policy.rustTargetLibrarySet.fileCount -or
		$targetLibrarySet.fileSetSha256 -cne [string]$Policy.rustTargetLibrarySet.fileSetSha256
	) {
		throw "pinned Rust target library set does not match the checked-in policy"
	}
	return [ordered]@{
		root = $rustRoot
		rustcPath = Join-Path $rustRoot "bin\rustc.exe"
		cargoPath = Join-Path $rustRoot "bin\cargo.exe"
		binarySet = $binarySet
		targetLibrarySet = $targetLibrarySet
	}
}

try {
	$invocationHints = Get-UntrustedInvocationHints
	foreach ($name in $cargoRustEnvironmentNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	foreach ($name in $gitEnvironmentNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	foreach ($name in $msvcLinkOptionEnvironmentNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	foreach ($requiredOsPath in @($osUserProfile, $osProgramFiles, $osProgramFilesX86, $osLocalApplicationData)) {
		if ([string]::IsNullOrWhiteSpace($requiredOsPath)) {
			throw "an OS-known build root is unavailable"
		}
		Assert-LocalCanonicalPath -LiteralPath $requiredOsPath -Name "OS-known build root" | Out-Null
	}
	Reset-IsolatedCargoHome
	Reset-IsolatedLinkerTemp
	$env:PATH = [Environment]::SystemDirectory
	$env:TEMP = $isolatedLinkerTemp
	$env:TMP = $isolatedLinkerTemp
	$env:USERPROFILE = $osUserProfile
	$env:LOCALAPPDATA = $osLocalApplicationData
	[Environment]::SetEnvironmentVariable("ProgramFiles", $osProgramFiles, "Process")
	[Environment]::SetEnvironmentVariable("ProgramFiles(x86)", $osProgramFilesX86, "Process")
	$env:GIT_CONFIG_NOSYSTEM = "1"
	$env:GIT_CONFIG_GLOBAL = "NUL"
	$env:GIT_OPTIONAL_LOCKS = "0"
	$env:GIT_PAGER = ""

	$trustedPolicy = Get-TrustedBuildPolicy
	$trustedPolicySha256 = Get-Sha256 $trustedToolchainPolicyPath
	$rustToolchainIdentity = Get-TrustedRustToolchainIdentity -Policy $trustedPolicy
	$rustcPath = $rustToolchainIdentity.rustcPath
	$cargoPath = $rustToolchainIdentity.cargoPath
	$gitPath = [IO.Path]::GetFullPath((Join-Path $osProgramFiles "Git\cmd\git.exe"))
	Assert-PathUnderRoot -LiteralPath $gitPath -RootPath $osProgramFiles -Name "Git executable" | Out-Null
	$gitIdentity = Get-TrustedAuthenticodeIdentity `
		-LiteralPath $gitPath `
		-ExpectedPublisherSubject ([string]$trustedPolicy.publishers.git) `
		-Name "Git executable"
	$vswherePath = [IO.Path]::GetFullPath(
		(Join-Path $osProgramFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe")
	)
	Assert-PathUnderRoot `
		-LiteralPath $vswherePath `
		-RootPath $osProgramFilesX86 `
		-Name "vswhere executable" | Out-Null
	$vswhereIdentity = Get-TrustedAuthenticodeIdentity `
		-LiteralPath $vswherePath `
		-ExpectedPublisherSubject ([string]$trustedPolicy.publishers.microsoft) `
		-Name "vswhere executable"

	Push-Location $packageRoot
	try {
		$sourceStatus = & $gitPath status --porcelain=v1 --untracked-files=normal -- .
		if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($sourceStatus -join ""))) {
			throw "release metadata requires a clean package source tree"
		}

		$sourceCommit = (& $gitPath rev-parse HEAD).Trim()
		$sourceDateEpoch = (& $gitPath show -s --format=%ct HEAD).Trim()
		if (
			$LASTEXITCODE -ne 0 -or
			$sourceCommit -notmatch '^[0-9a-f]{40}$' -or
			$sourceDateEpoch -notmatch '^[0-9]+$'
		) {
			throw "unable to resolve deterministic source identity"
		}

		$rustcVerbose = Invoke-CapturedTool -LiteralPath $rustcPath -Arguments @("-Vv") -Name "rustc version"
		$cargoVerbose = Invoke-CapturedTool -LiteralPath $cargoPath -Arguments @("-Vv") -Name "cargo version"
		if ($rustcVerbose -notmatch '(?m)^release: 1\.88\.0$' -or $cargoVerbose -notmatch '(?m)^cargo 1\.88\.0 ') {
			throw "resolved Rust toolchain does not match rust-toolchain.toml"
		}

		$visualStudioPath = (Invoke-CapturedTool `
			-LiteralPath $vswherePath `
			-Arguments @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath") `
			-Name "vswhere installation path").Trim()
		$visualStudioVersion = (Invoke-CapturedTool `
			-LiteralPath $vswherePath `
			-Arguments @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationVersion") `
			-Name "vswhere installation version").Trim()
		$visualStudioPath = [IO.Path]::GetFullPath($visualStudioPath.Trim())
		Assert-LocalCanonicalPath `
			-LiteralPath $visualStudioPath `
			-Name "Visual Studio installation" | Out-Null
		$visualStudioTrustedRoot = @($osProgramFiles, $osProgramFilesX86) |
			Where-Object {
				$prefix = $_.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
				$visualStudioPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
			} |
			Select-Object -First 1
		if ($null -eq $visualStudioTrustedRoot) {
			throw "Visual Studio installation escapes the trusted OS Program Files roots"
		}
		$msvcToolsRoot = Join-Path $visualStudioPath "VC\Tools\MSVC"
		$msvcToolset = Get-LatestVersionDirectory `
			-LiteralPath $msvcToolsRoot `
			-Name "MSVC toolset" `
			-Predicate { param($path) Test-Path -LiteralPath (Join-Path $path "bin\Hostx64\x64\link.exe") }
		$linkerPath = Join-Path $msvcToolset.FullName "bin\Hostx64\x64\link.exe"
		$cvtresPath = Join-Path $msvcToolset.FullName "bin\Hostx64\x64\cvtres.exe"
		Assert-PathUnderRoot `
			-LiteralPath $linkerPath `
			-RootPath $visualStudioPath `
			-Name "MSVC linker" | Out-Null
		Assert-PathUnderRoot `
			-LiteralPath $cvtresPath `
			-RootPath $visualStudioPath `
			-Name "MSVC resource converter" | Out-Null
		$linkerIdentity = Get-TrustedAuthenticodeIdentity `
			-LiteralPath $linkerPath `
			-ExpectedPublisherSubject ([string]$trustedPolicy.publishers.microsoft) `
			-Name "MSVC linker"
		$cvtresIdentity = Get-TrustedAuthenticodeIdentity `
			-LiteralPath $cvtresPath `
			-ExpectedPublisherSubject ([string]$trustedPolicy.publishers.microsoft) `
			-Name "MSVC resource converter"
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
		$windowsSdkRoot = [IO.Path]::GetFullPath(([string]$windowsKits.KitsRoot10).TrimEnd("\"))
		$expectedWindowsSdkRoot = [IO.Path]::GetFullPath((Join-Path $osProgramFilesX86 "Windows Kits\10"))
		if ($windowsSdkRoot -ine $expectedWindowsSdkRoot) {
			throw "Windows SDK registry root does not match the trusted OS installation root"
		}
		Assert-PathUnderRoot `
			-LiteralPath $windowsSdkRoot `
			-RootPath $osProgramFilesX86 `
			-Name "Windows SDK" | Out-Null
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

		New-ControlledCargoCwd
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

		Get-TrustedRustToolchainIdentity -Policy $trustedPolicy | Out-Null
		$firstBinaryPath = Invoke-IsolatedReleaseBuild -CargoPath $cargoPath -TargetDirectory $firstTargetDirectory
		$firstBuildSha256 = Get-Sha256 $firstBinaryPath
		Get-TrustedRustToolchainIdentity -Policy $trustedPolicy | Out-Null
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

		Get-TrustedRustToolchainIdentity -Policy $trustedPolicy | Out-Null
		Assert-ControlledCargoCwd
		Push-Location $controlledCargoCwd
		try {
			Assert-ControlledCargoCwd
			$cargoMetadataJson = & $cargoPath metadata `
				--manifest-path $manifestPath `
				--locked `
				--format-version 1
			$cargoMetadataExitCode = $LASTEXITCODE
		} finally {
			Pop-Location
		}
		if ($cargoMetadataExitCode -ne 0) {
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
		cargoConfigDiscovery = [ordered]@{
			mode = "private-acl-controlled-cwd-explicit-manifest"
			workingDirectory = "unique-os-known-local-app-data-root"
			manifestPath = "Cargo.toml"
			ancestorConfigFiles = "required-absent"
			reparseComponents = "forbidden"
			mutationAccess = "read-execute-only"
			revalidation = "immediately-before-each-cargo-command"
		}
		toolDiscovery = [ordered]@{
			mode = "absolute-os-roots-repository-pins-and-authenticode"
			inheritedPath = "ignored-before-first-external-command"
			inheritedProgramFiles = "ignored-and-normalized-from-os-special-folders"
			rustToolchain = "checked-in-file-set-sha256"
			osTools = "canonical-os-root-valid-authenticode-exact-publisher"
			externalAttestation = "required"
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
		toolTrust = [ordered]@{
			policy = "repository-reviewed-toolchain-v1"
			policySha256 = $trustedPolicySha256
			rustBinaryFileCount = $rustToolchainIdentity.binarySet.fileCount
			rustBinarySetSha256 = $rustToolchainIdentity.binarySet.fileSetSha256
			rustTargetLibraryFileCount = $rustToolchainIdentity.targetLibrarySet.fileCount
			rustTargetLibrarySetSha256 = $rustToolchainIdentity.targetLibrarySet.fileSetSha256
			git = $gitIdentity
			vswhere = $vswhereIdentity
			linker = $linkerIdentity
			resourceConverter = $cvtresIdentity
			externalAuthenticatedRunnerAttestation = "required"
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
		sourceDateEpoch = $sourceDateEpoch
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
	Remove-ControlledCargoCwd
	foreach ($name in $managedEnvironmentNames) {
		[Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
	}
}
