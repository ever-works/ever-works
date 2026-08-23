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
$provenanceBuildHashes = @(
	$provenance.predicate.runDetails.metadata.reproducibilityEvidence.buildSha256
)
if (
	$provenance.predicate.runDetails.metadata.reproducible -ne $true -or
	$provenance.predicate.runDetails.metadata.reproducibilityEvidence.verified -ne $true -or
	$provenance.predicate.runDetails.metadata.reproducibilityEvidence.buildCount -ne 2 -or
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
