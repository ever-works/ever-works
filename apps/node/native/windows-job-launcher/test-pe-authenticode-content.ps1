[CmdletBinding()]
param(
	[string]$UnsignedArtifactPath = "target\x86_64-pc-windows-msvc\release\ever-works-windows-job-launcher.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
. (Join-Path $packageRoot "pe-authenticode-content.ps1")

function Assert-Equal {
	param(
		[Parameter(Mandatory)] [object]$Actual,
		[Parameter(Mandatory)] [object]$Expected,
		[Parameter(Mandatory)] [string]$Message
	)
	if ([string]$Actual -cne [string]$Expected) {
		throw "$Message (actual=$Actual expected=$Expected)"
	}
}

function Assert-NotEqual {
	param(
		[Parameter(Mandatory)] [object]$Actual,
		[Parameter(Mandatory)] [object]$Expected,
		[Parameter(Mandatory)] [string]$Message
	)
	if ([string]$Actual -ceq [string]$Expected) {
		throw "$Message (both=$Actual)"
	}
}

function Assert-ScriptFailsLike {
	param(
		[Parameter(Mandatory)] [scriptblock]$Action,
		[Parameter(Mandatory)] [string]$Pattern,
		[Parameter(Mandatory)] [string]$Message
	)
	try {
		& $Action | Out-Null
		throw "$Message (script unexpectedly succeeded)"
	} catch {
		if ($_.Exception.Message -notlike $Pattern) {
			throw "$Message (unexpected failure: $($_.Exception.Message))"
		}
	}
}

$artifactPath = [IO.Path]::GetFullPath((Join-Path $packageRoot $UnsignedArtifactPath))
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
	throw "unsigned launcher artifact is required: $artifactPath"
}

$fixtureRoot = Join-Path $packageRoot "target\pe-authenticode-content-tests"
$goodPath = Join-Path $fixtureRoot "good\ever-works-windows-job-launcher.exe"
$differentPath = Join-Path $fixtureRoot "different\ever-works-windows-job-launcher.exe"
$certificateMutationPath = Join-Path $fixtureRoot "certificate-mutation\ever-works-windows-job-launcher.exe"
$contentMutationPath = Join-Path $fixtureRoot "content-mutation\ever-works-windows-job-launcher.exe"
$checksumMutationPath = Join-Path $fixtureRoot "checksum-mutation\ever-works-windows-job-launcher.exe"
$certificate = $null

try {
	if (Test-Path -LiteralPath $fixtureRoot) {
		Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
	}
	foreach ($path in @($goodPath, $differentPath, $certificateMutationPath, $contentMutationPath, $checksumMutationPath)) {
		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
	}

	$unsignedIdentity = Get-PeAuthenticodeContentIdentity -LiteralPath $artifactPath -RequireUnsigned
	Assert-Equal $unsignedIdentity.FileSize $unsignedIdentity.UnsignedContentSize "unsigned identity must cover the whole file"

	Copy-Item -LiteralPath $artifactPath -Destination $checksumMutationPath
	$checksumBytes = [IO.File]::ReadAllBytes($checksumMutationPath)
	$checksumBytes[$unsignedIdentity.ChecksumOffset] = $checksumBytes[$unsignedIdentity.ChecksumOffset] -bxor 0x5a
	[IO.File]::WriteAllBytes($checksumMutationPath, $checksumBytes)
	$checksumIdentity = Get-PeAuthenticodeContentIdentity -LiteralPath $checksumMutationPath -RequireUnsigned
	Assert-Equal $checksumIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "PE checksum changes must be canonicalized"

	Copy-Item -LiteralPath $artifactPath -Destination $goodPath
	Copy-Item -LiteralPath $artifactPath -Destination $differentPath
	$differentBytes = [IO.File]::ReadAllBytes($differentPath)
	$differentBytes[$differentBytes.Length - 1] = $differentBytes[$differentBytes.Length - 1] -bxor 0xa5
	[IO.File]::WriteAllBytes($differentPath, $differentBytes)

	$certificate = New-SelfSignedCertificate `
		-Type CodeSigningCert `
		-Subject "CN=Ever Works PE Content Test Only" `
		-CertStoreLocation "Cert:\CurrentUser\My" `
		-KeyAlgorithm RSA `
		-KeyLength 2048 `
		-HashAlgorithm SHA256 `
		-KeyExportPolicy NonExportable `
		-NotAfter (Get-Date).AddHours(1)
	$goodSignature = Set-AuthenticodeSignature -LiteralPath $goodPath -Certificate $certificate -HashAlgorithm SHA256
	$differentSignature = Set-AuthenticodeSignature `
		-LiteralPath $differentPath `
		-Certificate $certificate `
		-HashAlgorithm SHA256
	Assert-Equal $goodSignature.SignerCertificate.Thumbprint $certificate.Thumbprint "good fixture must use the fixture certificate"
	Assert-Equal $differentSignature.SignerCertificate.Thumbprint $certificate.Thumbprint "adversarial fixture must use the same certificate"

	$goodIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $goodPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-Equal $goodIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "Authenticode-only signing must preserve canonical content"

	$differentIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $differentPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-NotEqual $differentIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "a different PE signed by the same certificate must not match"

	Copy-Item -LiteralPath $goodPath -Destination $certificateMutationPath
	$certificateBytes = [IO.File]::ReadAllBytes($certificateMutationPath)
	$certificateMutationOffset = [int]$goodIdentity.CertificateTableOffset + 16
	$certificateBytes[$certificateMutationOffset] = $certificateBytes[$certificateMutationOffset] -bxor 0x3c
	[IO.File]::WriteAllBytes($certificateMutationPath, $certificateBytes)
	$certificateMutationIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $certificateMutationPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-Equal $certificateMutationIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "certificate-table changes must be canonicalized"

	Copy-Item -LiteralPath $goodPath -Destination $contentMutationPath
	$contentBytes = [IO.File]::ReadAllBytes($contentMutationPath)
	$contentMutationOffset = 0x40
	$contentBytes[$contentMutationOffset] = $contentBytes[$contentMutationOffset] -bxor 0xc3
	[IO.File]::WriteAllBytes($contentMutationPath, $contentBytes)
	$contentMutationIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $contentMutationPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-NotEqual $contentMutationIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "changes outside Authenticode fields must change canonical content"

	$sourceMetadataPath = Join-Path $packageRoot "target\release-metadata\ever-works-windows-job-launcher.json"
	$sourceMetadataDirectory = Split-Path -Parent $sourceMetadataPath
	$testMetadataDirectory = Join-Path $fixtureRoot "metadata"
	New-Item -ItemType Directory -Force -Path $testMetadataDirectory | Out-Null
	$unsignedMetadata = Get-Content -Raw -LiteralPath $sourceMetadataPath | ConvertFrom-Json
	$unsignedMetadata | Add-Member `
		-NotePropertyName authenticodeContentSha256 `
		-NotePropertyValue $unsignedIdentity.ContentSha256 `
		-Force
	$testMetadataPath = Join-Path $testMetadataDirectory "ever-works-windows-job-launcher.json"
	$metadataJson = $unsignedMetadata | ConvertTo-Json -Depth 16 -Compress
	[IO.File]::WriteAllText($testMetadataPath, "$metadataJson`n", [Text.UTF8Encoding]::new($false))
	foreach ($name in @([string]$unsignedMetadata.sbom, [string]$unsignedMetadata.provenance)) {
		Copy-Item -LiteralPath (Join-Path $sourceMetadataDirectory $name) -Destination (Join-Path $testMetadataDirectory $name)
	}
	$certificateSha256 = $certificate.GetCertHashString(
		[Security.Cryptography.HashAlgorithmName]::SHA256
	).ToLowerInvariant()
	$manifestScript = Join-Path $packageRoot "create-signed-manifest.ps1"
	$manifestArguments = @{
		ExpectedPublisherSubject = $certificate.Subject
		ExpectedPublisherCertificateSha256 = $certificateSha256
		UnsignedMetadataPath = $testMetadataPath
	}
	Assert-ScriptFailsLike -Pattern "*canonical Authenticode content hash does not match*" -Message "same-signer different PE must be rejected by source derivation" -Action {
		& $manifestScript @manifestArguments `
			-SignedArtifactPath $differentPath `
			-OutputPath (Join-Path $fixtureRoot "different.json")
	}
	Assert-ScriptFailsLike -Pattern "*canonical Authenticode content hash does not match*" -Message "mutation outside the certificate table must be rejected by source derivation" -Action {
		& $manifestScript @manifestArguments `
			-SignedArtifactPath $contentMutationPath `
			-OutputPath (Join-Path $fixtureRoot "content-mutation.json")
	}
	Assert-ScriptFailsLike -Pattern "*Authenticode status is not Valid*" -Message "certificate-table mutation must reach signature verification" -Action {
		& $manifestScript @manifestArguments `
			-SignedArtifactPath $certificateMutationPath `
			-OutputPath (Join-Path $fixtureRoot "certificate-mutation.json")
	}

	Write-Output "PE Authenticode content tests passed"
} finally {
	if ($null -ne $certificate) {
		$certificatePath = "Cert:\CurrentUser\My\$($certificate.Thumbprint)"
		if (Test-Path -LiteralPath $certificatePath) {
			Remove-Item -LiteralPath $certificatePath -Force
		}
	}
	if (Test-Path -LiteralPath $fixtureRoot) {
		Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
	}
}
