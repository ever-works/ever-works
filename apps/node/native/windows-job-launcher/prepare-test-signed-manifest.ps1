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
$certutilPath = Join-Path ([Environment]::SystemDirectory) "certutil.exe"

if ($Cleanup) {
	if (Test-Path -LiteralPath $thumbprintPath) {
		$thumbprint = (Get-Content -Raw -LiteralPath $thumbprintPath).Trim()
		if ($thumbprint -match '^[A-Fa-f0-9]{40}$') {
			$signingStorePath = "Cert:\CurrentUser\My\$thumbprint"
			if (Test-Path -LiteralPath $signingStorePath) {
				Remove-Item -LiteralPath $signingStorePath -Force
			}
			$trustedStorePath = "Cert:\CurrentUser\TrustedPeople\$thumbprint"
			if (Test-Path -LiteralPath $trustedStorePath) {
				& $certutilPath -user -silent -delstore TrustedPeople $thumbprint *> $null
				if ($LASTEXITCODE -ne 0) {
					throw "certutil could not remove the ephemeral test certificate"
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
Write-Host "Creating ephemeral test-only code-signing certificate"
$certificate = New-SelfSignedCertificate `
	-Type CodeSigningCert `
	-Subject $subject `
	-CertStoreLocation "Cert:\CurrentUser\My" `
	-KeyAlgorithm RSA `
	-KeyLength 2048 `
	-HashAlgorithm SHA256 `
	-KeyExportPolicy NonExportable `
	-NotAfter (Get-Date).AddHours(4)
Write-Host "Created ephemeral test-only code-signing certificate"
try {
	[IO.File]::WriteAllText(
		$thumbprintPath,
		"$($certificate.Thumbprint)`n",
		[Text.UTF8Encoding]::new($false)
	)
	$publicCertificateBytes = $certificate.Export(
		[Security.Cryptography.X509Certificates.X509ContentType]::Cert
	)
	[IO.File]::WriteAllBytes($certificatePath, $publicCertificateBytes)
	# Trust only this end-entity signer. Adding a self-signed leaf to Root opens
	# an interactive CA-trust prompt on hosted runners and overstates its role.
	Write-Host "Adding public-only ephemeral certificate with noninteractive certutil"
	& $certutilPath -user -f -addstore TrustedPeople $certificatePath | Out-Null
	if ($LASTEXITCODE -ne 0) {
		throw "certutil could not add the ephemeral public certificate to CurrentUser TrustedPeople"
	}
	Write-Host "Trusted ephemeral certificate for this test runner only"
	Write-Host "Signing copied test-only helper fixture"
	$signature = Set-AuthenticodeSignature `
		-LiteralPath $fixtureArtifactPath `
		-Certificate $certificate `
		-HashAlgorithm SHA256
	if ($signature.Status -ne "Valid") {
		throw "ephemeral test signature did not become Valid"
	}
	Write-Host "Signed copied test-only helper fixture"
	$certificateSha256 = $certificate.GetCertHashString(
		[Security.Cryptography.HashAlgorithmName]::SHA256
	).ToLowerInvariant()
	$signedSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArtifactPath
	).Hash.ToLowerInvariant()
	Write-Host "Verifying test-only signed manifest contract"
	$manifestPath = & (Join-Path $packageRoot "create-signed-manifest.ps1") `
		-SignedArtifactPath $fixtureArtifactPath `
		-UnsignedArtifactPath $unsignedArtifactPath `
		-ExpectedPublisherSubject $certificate.Subject `
		-ExpectedPublisherCertificateSha256 $certificateSha256 `
		-UnsignedMetadataPath $unsignedMetadataPath `
		-OutputPath (Join-Path $fixtureDirectory "ever-works-windows-job-launcher.signed.json")
	Write-Host "Verified test-only signed manifest contract"
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
	Write-Host "Prepared ephemeral signed helper test environment"
} catch {
	& $PSCommandPath -Cleanup -GithubEnvironmentPath $GithubEnvironmentPath
	throw
}
