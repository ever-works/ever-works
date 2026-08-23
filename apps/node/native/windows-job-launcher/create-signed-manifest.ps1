[CmdletBinding()]
param(
	[Parameter(Mandatory)] [string]$SignedArtifactPath,
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

$artifactPath = Resolve-PackagePath $SignedArtifactPath
$metadataPath = Resolve-PackagePath $UnsignedMetadataPath
$manifestPath = Resolve-PackagePath $OutputPath
Assert-Sha256 $ExpectedPublisherCertificateSha256 "publisher certificate pin"
if (
	[string]::IsNullOrWhiteSpace($ExpectedPublisherSubject) -or
	$ExpectedPublisherSubject.Trim() -cne $ExpectedPublisherSubject
) {
	throw "publisher subject must be exact and non-empty"
}

$unsignedMetadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
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
if ($signedArtifactSha256 -eq $unsignedMetadata.unsignedBuildSha256) {
	throw "signed artifact hash must be distinct from the reproducible unsigned build hash"
}
$metadataDirectory = Split-Path -Parent $metadataPath
$sbomPath = Join-Path $metadataDirectory ([string]$unsignedMetadata.sbom)
$provenancePath = Join-Path $metadataDirectory ([string]$unsignedMetadata.provenance)
if (
	(Get-FileHash -Algorithm SHA256 -LiteralPath $sbomPath).Hash -ine $unsignedMetadata.sbomSha256 -or
	(Get-FileHash -Algorithm SHA256 -LiteralPath $provenancePath).Hash -ine $unsignedMetadata.provenanceSha256
) {
	throw "SBOM or provenance digest does not match unsigned release metadata"
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
