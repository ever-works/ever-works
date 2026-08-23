[CmdletBinding()]
param(
	[Parameter(Mandatory)] [string]$SignedArtifactPath,
	[Parameter(Mandatory)] [string]$UnsignedArtifactPath,
	[Parameter(Mandatory)] [string]$ExpectedPublisherSubject,
	[Parameter(Mandatory)] [string]$ExpectedPublisherCertificateSha256,
	[string]$UnsignedMetadataPath = "target\release-metadata\ever-works-windows-job-launcher.json",
	[string]$OutputPath = "target\signed-manifest\ever-works-windows-job-launcher.signed.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
. (Join-Path $packageRoot "pe-authenticode-content.ps1")

function Resolve-PackagePath {
	param([Parameter(Mandatory)] [string]$Path)
	if ([IO.Path]::IsPathRooted($Path)) {
		return [IO.Path]::GetFullPath($Path)
	}
	return [IO.Path]::GetFullPath((Join-Path $packageRoot $Path))
}

function Assert-Sha256 {
	param([Parameter(Mandatory)] [string]$Value, [Parameter(Mandatory)] [string]$Name)
	if ($Value -notmatch '^[A-Fa-f0-9]{64}$') {
		throw "$Name must be an exact SHA-256"
	}
}

function Get-ByteSha256 {
	param([Parameter(Mandatory)] [byte[]]$Bytes)
	$sha256 = [Security.Cryptography.SHA256]::Create()
	try {
		return (
			[BitConverter]::ToString($sha256.ComputeHash($Bytes)) -replace "-", ""
		).ToLowerInvariant()
	} finally {
		$sha256.Dispose()
	}
}

function Test-JsonEquivalent {
	param($Left, $Right)
	if ($null -eq $Left -or $null -eq $Right) {
		return $null -eq $Left -and $null -eq $Right
	}
	$leftIsObject = $Left -is [Management.Automation.PSCustomObject] -or $Left -is [Collections.IDictionary]
	$rightIsObject = $Right -is [Management.Automation.PSCustomObject] -or $Right -is [Collections.IDictionary]
	if ($leftIsObject -or $rightIsObject) {
		if (-not $leftIsObject -or -not $rightIsObject) {
			return $false
		}
		$leftNames = if ($Left -is [Collections.IDictionary]) {
			@($Left.Keys | ForEach-Object { [string]$_ } | Sort-Object)
		} else {
			@($Left.PSObject.Properties.Name | Sort-Object)
		}
		$rightNames = if ($Right -is [Collections.IDictionary]) {
			@($Right.Keys | ForEach-Object { [string]$_ } | Sort-Object)
		} else {
			@($Right.PSObject.Properties.Name | Sort-Object)
		}
		if ($leftNames.Count -ne $rightNames.Count) {
			return $false
		}
		for ($index = 0; $index -lt $leftNames.Count; $index++) {
			if ($leftNames[$index] -cne $rightNames[$index]) {
				return $false
			}
			$name = $leftNames[$index]
			$leftValue = if ($Left -is [Collections.IDictionary]) { $Left[$name] } else { $Left.$name }
			$rightValue = if ($Right -is [Collections.IDictionary]) { $Right[$name] } else { $Right.$name }
			if (-not (Test-JsonEquivalent $leftValue $rightValue)) {
				return $false
			}
		}
		return $true
	}
	$leftIsArray = $Left -is [Array]
	$rightIsArray = $Right -is [Array]
	if ($leftIsArray -or $rightIsArray) {
		if (-not $leftIsArray -or -not $rightIsArray -or $Left.Count -ne $Right.Count) {
			return $false
		}
		for ($index = 0; $index -lt $Left.Count; $index++) {
			if (-not (Test-JsonEquivalent $Left[$index] $Right[$index])) {
				return $false
			}
		}
		return $true
	}
	return $Left.GetType().FullName -ceq $Right.GetType().FullName -and [object]::Equals($Left, $Right)
}

function Assert-TrustedLocalPath {
	param([Parameter(Mandatory)] [string]$LiteralPath, [Parameter(Mandatory)] [string]$Name)
	$fullPath = [IO.Path]::GetFullPath($LiteralPath)
	if ($fullPath.StartsWith("\\", [StringComparison]::Ordinal)) {
		throw "$Name must be local"
	}
	$root = [IO.Path]::GetPathRoot($fullPath)
	$current = $root.TrimEnd([IO.Path]::DirectorySeparatorChar)
	foreach ($component in $fullPath.Substring($root.Length).Split(
		[IO.Path]::DirectorySeparatorChar,
		[StringSplitOptions]::RemoveEmptyEntries
	)) {
		$current = Join-Path $current $component
		$item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
		if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			throw "$Name path contains a reparse point"
		}
	}
	$resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $fullPath).ProviderPath)
	if ($resolved -ine $fullPath) {
		throw "$Name did not resolve to its canonical path"
	}
	return $fullPath
}

function Get-ActualSourceIdentity {
	$policyPath = Join-Path $packageRoot "trusted-build-toolchain.json"
	$policy = Get-Content -Raw -LiteralPath $policyPath | ConvertFrom-Json
	if (
		$policy.schemaVersion -ne 1 -or
		$policy.publishers.git -isnot [string] -or
		[string]::IsNullOrWhiteSpace($policy.publishers.git)
	) {
		throw "checked-in build toolchain policy is invalid"
	}
	$programFiles = [Environment]::GetFolderPath(
		[Environment+SpecialFolder]::ProgramFiles,
		[Environment+SpecialFolderOption]::DoNotVerify
	)
	$gitPath = Assert-TrustedLocalPath `
		-LiteralPath (Join-Path $programFiles "Git\cmd\git.exe") `
		-Name "Git executable"
	$prefix = [IO.Path]::GetFullPath($programFiles).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
	if (-not $gitPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Git executable escapes the OS-known Program Files root"
	}
	$signature = Get-AuthenticodeSignature -LiteralPath $gitPath
	if (
		$signature.Status -ne "Valid" -or
		$null -eq $signature.SignerCertificate -or
		$signature.SignerCertificate.Subject -cne [string]$policy.publishers.git
	) {
		throw "Git executable identity is not trusted"
	}
	$gitEnvironmentNames = @(
		[Environment]::GetEnvironmentVariables("Process").Keys |
			ForEach-Object { [string]$_ } |
			Where-Object { $_ -match '^GIT_' }
	)
	$previousGitEnvironment = @{}
	try {
		foreach ($name in $gitEnvironmentNames) {
			$previousGitEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
			Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
		}
		$env:GIT_CONFIG_NOSYSTEM = "1"
		$env:GIT_CONFIG_GLOBAL = "NUL"
		$env:GIT_OPTIONAL_LOCKS = "0"
		$env:GIT_PAGER = ""
		Push-Location $packageRoot
		try {
			$commit = (& $gitPath rev-parse HEAD).Trim()
			$commitExitCode = $LASTEXITCODE
			$epoch = (& $gitPath show -s --format=%ct HEAD).Trim()
			$epochExitCode = $LASTEXITCODE
		} finally {
			Pop-Location
		}
		if (
			$commitExitCode -ne 0 -or
			$epochExitCode -ne 0 -or
			$commit -notmatch '^[0-9a-f]{40}$' -or
			$epoch -notmatch '^[0-9]+$'
		) {
			throw "unable to resolve the actual checked-out source identity"
		}
		return [ordered]@{
			commit = $commit
			sourceDateEpoch = $epoch
			toolchainPolicySha256 = (
				Get-FileHash -Algorithm SHA256 -LiteralPath $policyPath
			).Hash.ToLowerInvariant()
		}
	} finally {
		foreach ($name in @("GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OPTIONAL_LOCKS", "GIT_PAGER")) {
			Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
		}
		foreach ($entry in $previousGitEnvironment.GetEnumerator()) {
			[Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
		}
	}
}

$artifactPath = Resolve-PackagePath $SignedArtifactPath
$unsignedArtifactPath = Resolve-PackagePath $UnsignedArtifactPath
$metadataPath = Resolve-PackagePath $UnsignedMetadataPath
$manifestPath = Resolve-PackagePath $OutputPath
Assert-Sha256 $ExpectedPublisherCertificateSha256 "publisher certificate pin"
if (
	[string]::IsNullOrWhiteSpace($ExpectedPublisherSubject) -or
	$ExpectedPublisherSubject.Trim() -cne $ExpectedPublisherSubject
) {
	throw "publisher subject must be exact and non-empty"
}

$metadataJson = Get-Content -Raw -LiteralPath $metadataPath
$schemaPath = Join-Path $packageRoot "unsigned-release-metadata.schema.json"
if ($null -eq (Get-Command Test-Json -CommandType Cmdlet -ErrorAction SilentlyContinue)) {
	throw "unsigned release metadata schema validation is unavailable"
}
try {
	$metadataSchemaValid = $metadataJson | Test-Json -SchemaFile $schemaPath -ErrorAction Stop
} catch {
	throw "unsigned release metadata failed schema validation: $($_.Exception.Message)"
}
if (-not $metadataSchemaValid) {
	throw "unsigned release metadata failed schema validation"
}
$unsignedMetadata = $metadataJson | ConvertFrom-Json
if ($unsignedMetadata.productionEligible -ne $false -or $unsignedMetadata.authenticode.status -ne "unsigned") {
	throw "signed manifest requires unsigned build metadata that is explicitly production-ineligible"
}
$actualSourceIdentity = Get-ActualSourceIdentity
if (
	[string]$unsignedMetadata.sourceCommit -cne $actualSourceIdentity.commit -or
	[string]$unsignedMetadata.sourceDateEpoch -cne $actualSourceIdentity.sourceDateEpoch
) {
	throw "unsigned release metadata source commit or epoch does not match the actual checkout"
}
if (
	[string]$unsignedMetadata.buildInputs.toolTrust.policySha256 -cne
	$actualSourceIdentity.toolchainPolicySha256
) {
	throw "unsigned release metadata toolchain policy digest does not match the actual locked input"
}
$actualCargoLockSha256 = (
	Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "Cargo.lock")
).Hash.ToLowerInvariant()
if ([string]$unsignedMetadata.cargoLockSha256 -cne $actualCargoLockSha256) {
	throw "unsigned release metadata Cargo.lock digest does not match the actual locked input"
}
foreach ($hashName in @("unsignedBuildSha256", "authenticodeContentSha256", "sbomSha256", "provenanceSha256")) {
	Assert-Sha256 ([string]$unsignedMetadata.$hashName) $hashName
}
if (
	$unsignedMetadata.binarySize -isnot [long] -and
	$unsignedMetadata.binarySize -isnot [int]
) {
	throw "unsigned binary size must be an integer"
}
$unsignedBinarySize = [long]$unsignedMetadata.binarySize
if ($unsignedBinarySize -lt 1) {
	throw "unsigned binary size must be positive"
}

$unsignedLease = [IO.File]::Open(
	$unsignedArtifactPath,
	[IO.FileMode]::Open,
	[IO.FileAccess]::Read,
	[IO.FileShare]::Read
)
try {
	$unsignedArtifactSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $unsignedArtifactPath
	).Hash.ToLowerInvariant()
	if ($unsignedArtifactSha256 -cne [string]$unsignedMetadata.unsignedBuildSha256) {
		throw "unsigned artifact SHA-256 does not match unsigned release metadata"
	}
	if ($unsignedLease.Length -ne $unsignedBinarySize) {
		throw "unsigned artifact size does not match unsigned release metadata"
	}
	$unsignedIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $unsignedArtifactPath `
		-RequireUnsigned
	if ($unsignedIdentity.ContentSha256 -cne [string]$unsignedMetadata.authenticodeContentSha256) {
		throw "unsigned artifact canonical Authenticode content hash does not match unsigned release metadata"
	}
} finally {
	$unsignedLease.Dispose()
}

$recordedBuildHashes = @($unsignedMetadata.reproducibility.buildSha256)
if (
	$recordedBuildHashes.Count -ne 2 -or
	@($recordedBuildHashes | Where-Object { $_ -cne $unsignedArtifactSha256 }).Count -ne 0
) {
	throw "unsigned release metadata reproducibility hashes do not match the verified unsigned artifact"
}
$metadataDirectory = Split-Path -Parent $metadataPath
$sbomPath = Join-Path $metadataDirectory ([string]$unsignedMetadata.sbom)
$provenancePath = Join-Path $metadataDirectory ([string]$unsignedMetadata.provenance)
$sbomSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sbomPath).Hash.ToLowerInvariant()
$provenanceBytes = [IO.File]::ReadAllBytes($provenancePath)
$provenanceSha256 = Get-ByteSha256 $provenanceBytes
if ($sbomSha256 -cne $unsignedMetadata.sbomSha256 -or $provenanceSha256 -cne $unsignedMetadata.provenanceSha256) {
	throw "SBOM or provenance digest does not match unsigned release metadata"
}
try {
	$provenanceJson = [Text.UTF8Encoding]::new($false, $true).GetString($provenanceBytes)
	$provenance = $provenanceJson | ConvertFrom-Json -ErrorAction Stop
} catch {
	throw "unsigned provenance is not valid UTF-8 JSON"
}
$provenanceSubjects = @($provenance.subject)
if (
	$provenance._type -cne "https://in-toto.io/Statement/v1" -or
	$provenance.predicateType -cne "https://slsa.dev/provenance/v1" -or
	$provenanceSubjects.Count -ne 1 -or
	$provenanceSubjects[0].name -cne [string]$unsignedMetadata.artifact -or
	$provenanceSubjects[0].digest.sha256 -cne $unsignedArtifactSha256
) {
	throw "provenance subject does not match the verified unsigned artifact"
}
$buildDefinition = $provenance.predicate.buildDefinition
$runDetails = $provenance.predicate.runDetails
$resolvedDependencies = @($buildDefinition.resolvedDependencies)
if ($resolvedDependencies.Count -ne 3) {
	throw "provenance resolved dependencies do not match unsigned release metadata"
}
$gitDependencies = @($resolvedDependencies | Where-Object {
	$_.uri -ceq "git+https://github.com/ever-co/ever-works.git"
})
$cargoLockDependencies = @($resolvedDependencies | Where-Object { $_.uri -ceq "file:Cargo.lock" })
$sbomDependencies = @($resolvedDependencies | Where-Object {
	$_.uri -ceq "file:$([string]$unsignedMetadata.sbom)"
})
if (
	$gitDependencies.Count -ne 1 -or
	$cargoLockDependencies.Count -ne 1 -or
	$sbomDependencies.Count -ne 1 -or
	[string]$gitDependencies[0].digest.gitCommit -cne [string]$unsignedMetadata.sourceCommit -or
	[string]$cargoLockDependencies[0].digest.sha256 -cne $actualCargoLockSha256 -or
	[string]$sbomDependencies[0].digest.sha256 -cne $sbomSha256
) {
	throw "provenance resolved dependencies do not match unsigned metadata and actual locked inputs"
}
$externalParameters = $buildDefinition.externalParameters
$internalParameters = $buildDefinition.internalParameters
if (
	$buildDefinition.buildType -cne "https://ever.co/build-types/cargo-windows-msvc-brepro/v2" -or
	$externalParameters.targetTriple -cne [string]$unsignedMetadata.targetTriple -or
	$externalParameters.rustToolchain -cne [string]$unsignedMetadata.rustToolchain -or
	$externalParameters.rustFlags -cne [string]$unsignedMetadata.buildInputs.rustFlags -or
	$externalParameters.cargoLocked -ne $unsignedMetadata.cargoLocked -or
	$internalParameters.sourceDateEpoch -cne [string]$unsignedMetadata.sourceDateEpoch -or
	$internalParameters.cargoIncremental -ne $unsignedMetadata.reproducibility.incremental -or
	$internalParameters.compilerCache -cne [string]$unsignedMetadata.reproducibility.compilerCache -or
	$internalParameters.isolatedTargetDirectories -ne $unsignedMetadata.reproducibility.isolatedTargetDirectories -or
	-not (Test-JsonEquivalent $internalParameters.buildInputs $unsignedMetadata.buildInputs)
) {
	throw "provenance build definition or build inputs do not match unsigned release metadata"
}
if (
	-not (Test-JsonEquivalent $runDetails.builder $unsignedMetadata.buildInputs.builder) -or
	-not (Test-JsonEquivalent $runDetails.metadata.invocationHints $unsignedMetadata.invocationHints) -or
	-not (Test-JsonEquivalent $runDetails.metadata.reproducibilityEvidence $unsignedMetadata.reproducibility)
) {
	throw "provenance builder, invocation, environment, or reproducibility claims do not match unsigned release metadata"
}
$provenanceBuildHashes = @(
	$runDetails.metadata.reproducibilityEvidence.buildSha256
)
if (
	$runDetails.metadata.reproducible -ne $true -or
	$runDetails.metadata.reproducibilityEvidence.verified -ne $true -or
	$runDetails.metadata.reproducibilityEvidence.buildCount -ne 2 -or
	$provenanceBuildHashes.Count -ne 2 -or
	@($provenanceBuildHashes | Where-Object { $_ -cne $unsignedArtifactSha256 }).Count -ne 0
) {
	throw "provenance reproducibility evidence does not match the verified unsigned artifact"
}

$signedLease = [IO.File]::Open(
	$artifactPath,
	[IO.FileMode]::Open,
	[IO.FileAccess]::Read,
	[IO.FileShare]::Read
)
try {
	$signedIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $artifactPath `
		-ExpectedUnsignedSize $unsignedBinarySize
	if ($signedIdentity.ContentSha256 -cne [string]$unsignedMetadata.authenticodeContentSha256) {
		throw "signed artifact canonical Authenticode content hash does not match the recorded unsigned PE"
	}

	$signature = Get-AuthenticodeSignature -LiteralPath $artifactPath
	if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
		throw "signed artifact Authenticode status is not Valid"
	}
	if ($signature.SignerCertificate.Subject -cne $ExpectedPublisherSubject) {
		throw "signed artifact publisher subject does not match the exact pin"
	}
	$certificateSha256 = $signature.SignerCertificate.GetCertHashString(
		[Security.Cryptography.HashAlgorithmName]::SHA256
	)
	if ($certificateSha256 -ine $ExpectedPublisherCertificateSha256) {
		throw "signed artifact leaf certificate does not match the SHA-256 pin"
	}

	$signedArtifactSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath
	).Hash.ToLowerInvariant()
	if ($signedArtifactSha256 -eq $unsignedArtifactSha256) {
		throw "signed artifact hash must be distinct from the reproducible unsigned build hash"
	}
} finally {
	$signedLease.Dispose()
}

$manifest = [ordered]@{
	schemaVersion = 1
	productionEligible = $false
	releaseApproval = "required"
	artifact = [IO.Path]::GetFileName($artifactPath)
	signedArtifactSha256 = $signedArtifactSha256
	authenticodeContentSha256 = [string]$unsignedMetadata.authenticodeContentSha256
	unsignedBinarySize = $unsignedBinarySize
	signedBinarySize = $signedIdentity.FileSize
	publisherSubject = $ExpectedPublisherSubject
	publisherCertificateSha256 = $certificateSha256.ToLowerInvariant()
	authenticodeStatus = "Valid"
	sourceCommit = [string]$unsignedMetadata.sourceCommit
	unsignedBuildSha256 = [string]$unsignedMetadata.unsignedBuildSha256
	sbomSha256 = [string]$unsignedMetadata.sbomSha256
	provenanceSha256 = [string]$unsignedMetadata.provenanceSha256
}
$manifestDirectory = Split-Path -Parent $manifestPath
New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null
$json = $manifest | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText($manifestPath, "$json`n", [Text.UTF8Encoding]::new($false))
Write-Output $manifestPath
