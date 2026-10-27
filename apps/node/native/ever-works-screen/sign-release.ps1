# Sign a release build of the screen helper on Windows (FL-07 P3, owner questions 7 and 17).
#
# Input: the output of build-release.ps1 (<OutDir>\ever-works-screen.exe and its
# unsigned-release-metadata.json). Output: <OutDir>\signed\ever-works-screen.exe and
# <OutDir>\signed\signed-release-metadata.json, which carries the manifest target
# fields a release publishes (sha256, signedSha256, signer). Uploads nothing;
# publishing stays an owner-approved step.
#
# The signature: Authenticode, SHA-256, the chain up to (not including) the root,
# and an RFC 3161 timestamp. It is then checked the way the node checks it
# (helper-signature.ts): Get-AuthenticodeSignature must answer Valid, the chain's
# root must be a MACHINE root (LocalMachine\Root or AuthRoot), and the signer's
# subject is what the manifest publishes as `signer` (and must equal
# release-signing.json win32.subject once that is set).
#
# Environment (nothing secret is read from a file or printed):
#   SCREEN_HELPER_SIGN_CERT_THUMBPRINT  the code-signing certificate, with its private
#                                       key, in Cert:\CurrentUser\My or Cert:\LocalMachine\My
#   SCREEN_HELPER_TIMESTAMP_URL         the RFC 3161 timestamp service of the certificate's CA
# -DryRun signs with a throwaway self-signed certificate (removed again) and checks
# only that a SHA-256 signature by it is present: the CI exercise of this script.
# A dry-run output is never a release.
param(
    [string]$OutDir = 'dist',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$unsigned = Join-Path $OutDir 'ever-works-screen.exe'
$metadataPath = Join-Path $OutDir 'unsigned-release-metadata.json'
if (-not (Test-Path -LiteralPath $unsigned) -or -not (Test-Path -LiteralPath $metadataPath)) {
    throw "run build-release.ps1 first: $unsigned and $metadataPath are needed"
}
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$config = Get-Content -Raw -LiteralPath 'release-signing.json' | ConvertFrom-Json
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $unsigned).Hash.ToLowerInvariant() -ne $metadata.sha256) {
    throw "$unsigned is not the build its metadata describes"
}

$out = Join-Path $OutDir 'signed'
if (Test-Path -LiteralPath $out) { Remove-Item -Recurse -Force -LiteralPath $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$signed = Join-Path $out 'ever-works-screen.exe'
Copy-Item -LiteralPath $unsigned -Destination $signed

function Test-MachineRoot([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = 'NoCheck'
    [void]$chain.Build($Certificate)
    if ($chain.ChainElements.Count -eq 0) { return $false }
    $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
    return (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$root") -or (Test-Path -LiteralPath "Cert:\LocalMachine\AuthRoot\$root")
}

$throwaway = $null
try {
    if ($DryRun) {
        $throwaway = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=ever-works-screen dry run' `
            -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1)
        $certificate = $throwaway
    } else {
        $thumbprint = "$env:SCREEN_HELPER_SIGN_CERT_THUMBPRINT".Trim().ToUpperInvariant()
        if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
            throw 'SCREEN_HELPER_SIGN_CERT_THUMBPRINT must name the code-signing certificate (40 hex characters)'
        }
        $certificate = @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') |
            ForEach-Object { Get-Item -LiteralPath (Join-Path $_ $thumbprint) -ErrorAction SilentlyContinue } |
            Where-Object { $_ -and $_.HasPrivateKey } | Select-Object -First 1
        if (-not $certificate) { throw 'that certificate, with its private key, is not in CurrentUser\My or LocalMachine\My' }
        if (-not $env:SCREEN_HELPER_TIMESTAMP_URL -or $env:SCREEN_HELPER_TIMESTAMP_URL -notmatch '^https?://') {
            throw 'SCREEN_HELPER_TIMESTAMP_URL must name the CA''s RFC 3161 timestamp service'
        }
        if ($config.win32.subject -and $certificate.Subject -ne $config.win32.subject) {
            throw "the certificate's subject is not release-signing.json win32.subject"
        }
    }

    $signArguments = @{
        FilePath      = $signed
        Certificate   = $certificate
        HashAlgorithm = 'SHA256'
        IncludeChain  = 'NotRoot'
    }
    if (-not $DryRun) { $signArguments.TimestampServer = $env:SCREEN_HELPER_TIMESTAMP_URL }
    $result = Set-AuthenticodeSignature @signArguments
    if (-not $result.SignerCertificate -or $result.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
        throw "the file was not signed ($($result.Status): $($result.StatusMessage))"
    }

    $check = Get-AuthenticodeSignature -LiteralPath $signed
    if ($check.Status -eq 'NotSigned' -or $check.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
        throw 'the signed file carries no signature by that certificate'
    }
    if ($DryRun) {
        # A self-signed root is in no machine store: exactly what the node refuses.
        if ($check.Status -eq 'Valid' -and (Test-MachineRoot $check.SignerCertificate)) {
            throw 'a throwaway certificate passed as a machine-trusted signature'
        }
        $signer = ''
    } else {
        if ($check.Status -ne 'Valid') { throw "the signature is not Valid ($($check.Status))" }
        if (-not (Test-MachineRoot $check.SignerCertificate)) { throw 'the signature does not chain to a machine root' }
        if (-not $check.TimeStamperCertificate) { throw 'the signature carries no timestamp' }
        $signer = $check.SignerCertificate.Subject
    }
} finally {
    if ($throwaway) {
        # New-SelfSignedCertificate also files a copy under the intermediate authorities: remove both.
        foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\CA') {
            Remove-Item -LiteralPath (Join-Path $store $throwaway.Thumbprint) -ErrorAction SilentlyContinue
        }
    }
}

$signedSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $signed).Hash.ToLowerInvariant()
$signedMetadata = [ordered]@{
    schemaVersion      = 1
    artifact           = 'ever-works-screen'
    version            = $metadata.version
    target             = $metadata.target
    sha256             = $metadata.sha256
    signedSha256       = $signedSha256
    signer             = $signer
    identifier         = $config.identifier
    dryRun             = [bool]$DryRun
    productionEligible = $false
}
$json = ($signedMetadata | ConvertTo-Json) + "`n"
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path -LiteralPath $out) 'signed-release-metadata.json'), $json)
$mode = if ($DryRun) { ' with a throwaway certificate (dry run)' } else { " by $signer" }
Write-Output "ever-works-screen $($metadata.version) ($($metadata.target)) signed$mode sha256 $signedSha256"
