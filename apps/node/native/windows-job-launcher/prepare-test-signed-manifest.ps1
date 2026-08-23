[CmdletBinding()]
param(
	[string]$GithubEnvironmentPath = $env:GITHUB_ENV,
	[switch]$Cleanup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
$fixtureDirectory = Join-Path $packageRoot "target\signed-test-fixture"
$fixtureArtifactPath = Join-Path $fixtureDirectory "ever-works-windows-job-launcher.exe"
$certificatePath = Join-Path $fixtureDirectory "ever-works-windows-job-launcher-test.cer"
$thumbprintPath = Join-Path $fixtureDirectory "certificate-thumbprint.txt"

if ($Cleanup) {
	if (Test-Path -LiteralPath $thumbprintPath) {
		$thumbprint = (Get-Content -Raw -LiteralPath $thumbprintPath).Trim()
		if ($thumbprint -match '^[A-Fa-f0-9]{40}$') {
			foreach ($storePath in @(
				"Cert:\CurrentUser\My\$thumbprint",
				"Cert:\CurrentUser\Root\$thumbprint"
			)) {
				if (Test-Path -LiteralPath $storePath) {
					Remove-Item -LiteralPath $storePath -Force
				}
			}
		}
	}
	if (Test-Path -LiteralPath $fixtureDirectory) {
		Remove-Item -LiteralPath $fixtureDirectory -Recurse -Force
	}
	return
}

if ([string]::IsNullOrWhiteSpace($GithubEnvironmentPath)) {
	throw "GitHub environment file is required for the ephemeral signed test fixture"
}
$unsignedMetadataPath = Join-Path $packageRoot "target\release-metadata\ever-works-windows-job-launcher.json"
$unsignedArtifactPath = Join-Path $packageRoot "target\x86_64-pc-windows-msvc\release\ever-works-windows-job-launcher.exe"
if (-not (Test-Path -LiteralPath $unsignedMetadataPath) -or -not (Test-Path -LiteralPath $unsignedArtifactPath)) {
	throw "build-release.ps1 must run before the signed test fixture is prepared"
}

New-Item -ItemType Directory -Force -Path $fixtureDirectory | Out-Null
Copy-Item -LiteralPath $unsignedArtifactPath -Destination $fixtureArtifactPath
$subject = "CN=Ever Works Windows Job Launcher Test Only"
$certificate = New-SelfSignedCertificate `
	-Type CodeSigningCert `
	-Subject $subject `
	-CertStoreLocation "Cert:\CurrentUser\My" `
	-KeyAlgorithm RSA `
	-KeyLength 2048 `
	-HashAlgorithm SHA256 `
	-KeyExportPolicy NonExportable `
	-NotAfter (Get-Date).AddHours(4)
try {
	[IO.File]::WriteAllText(
		$thumbprintPath,
		"$($certificate.Thumbprint)`n",
		[Text.UTF8Encoding]::new($false)
	)
	Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
	Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
	$signature = Set-AuthenticodeSignature `
		-LiteralPath $fixtureArtifactPath `
		-Certificate $certificate `
		-HashAlgorithm SHA256
	if ($signature.Status -ne "Valid") {
		throw "ephemeral test signature did not become Valid"
	}
	$certificateSha256 = $certificate.GetCertHashString(
		[Security.Cryptography.HashAlgorithmName]::SHA256
	).ToLowerInvariant()
	$signedSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArtifactPath
	).Hash.ToLowerInvariant()
	$manifestPath = & (Join-Path $packageRoot "create-signed-manifest.ps1") `
		-SignedArtifactPath $fixtureArtifactPath `
		-ExpectedPublisherSubject $certificate.Subject `
		-ExpectedPublisherCertificateSha256 $certificateSha256 `
		-UnsignedMetadataPath $unsignedMetadataPath `
		-OutputPath (Join-Path $fixtureDirectory "ever-works-windows-job-launcher.signed.json")
	$fixture = [ordered]@{
		testOnly = $true
		productionEligible = $false
		manifest = [IO.Path]::GetFileName([string]$manifestPath)
	}
	$fixtureJson = $fixture | ConvertTo-Json -Compress
	[IO.File]::WriteAllText(
		(Join-Path $fixtureDirectory "fixture.json"),
		"$fixtureJson`n",
		[Text.UTF8Encoding]::new($false)
	)
	@(
		"EVER_WORKS_TEST_SIGNED_HELPER_PATH=$fixtureArtifactPath",
		"EVER_WORKS_TEST_SIGNED_HELPER_SHA256=$signedSha256",
		"EVER_WORKS_TEST_SIGNED_PUBLISHER_SUBJECT=$($certificate.Subject)",
		"EVER_WORKS_TEST_SIGNED_PUBLISHER_CERTIFICATE_SHA256=$certificateSha256"
	) | Add-Content -LiteralPath $GithubEnvironmentPath -Encoding utf8
} catch {
	& $PSCommandPath -Cleanup -GithubEnvironmentPath $GithubEnvironmentPath
	throw
}
