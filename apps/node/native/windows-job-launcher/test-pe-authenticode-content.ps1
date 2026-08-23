[CmdletBinding()]
param(
	[string]$UnsignedArtifactPath = "target\x86_64-pc-windows-msvc\release\ever-works-windows-job-launcher.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
. (Join-Path $packageRoot "pe-authenticode-content.ps1")
$expectedFailureTestFailures = [Collections.Generic.List[string]]::new()

function Assert-Equal {
	param(
		[Parameter(Mandatory)] [object]$Actual,
		[Parameter(Mandatory)] [object]$Expected,
		[Parameter(Mandatory)] [string]$Message
	)
	if ("$Actual" -cne "$Expected") {
		throw "$Message (actual=$Actual expected=$Expected)"
	}
}

function Assert-NotEqual {
	param(
		[Parameter(Mandatory)] [object]$Actual,
		[Parameter(Mandatory)] [object]$Expected,
		[Parameter(Mandatory)] [string]$Message
	)
	if ("$Actual" -ceq "$Expected") {
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
		$expectedFailureTestFailures.Add("$Message (script unexpectedly succeeded)")
	} catch {
		if ($_.Exception.Message -notlike $Pattern) {
			$expectedFailureTestFailures.Add("$Message (unexpected failure: $($_.Exception.Message))")
		}
	}
}

function Copy-TestJsonObject {
	param([Parameter(Mandatory)] [object]$Value)
	return $Value | ConvertTo-Json -Depth 32 -Compress | ConvertFrom-Json
}

function Write-TestMetadataBundle {
	param(
		[Parameter(Mandatory)] [string]$Directory,
		[Parameter(Mandatory)] [object]$Metadata,
		[Parameter(Mandatory)] [object]$Provenance,
		[Parameter(Mandatory)] [string]$SourceMetadataDirectory
	)
	New-Item -ItemType Directory -Force -Path $Directory | Out-Null
	$metadataPath = Join-Path $Directory "ever-works-windows-job-launcher.json"
	$provenancePath = Join-Path $Directory ([string]$Metadata.provenance)
	$provenanceJson = $Provenance | ConvertTo-Json -Depth 32 -Compress
	[IO.File]::WriteAllText($provenancePath, "$provenanceJson`n", [Text.UTF8Encoding]::new($false))
	$Metadata.provenanceSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $provenancePath
	).Hash.ToLowerInvariant()
	Copy-Item `
		-LiteralPath (Join-Path $SourceMetadataDirectory ([string]$Metadata.sbom)) `
		-Destination (Join-Path $Directory ([string]$Metadata.sbom))
	$metadataJson = $Metadata | ConvertTo-Json -Depth 32 -Compress
	[IO.File]::WriteAllText($metadataPath, "$metadataJson`n", [Text.UTF8Encoding]::new($false))
	return $metadataPath
}

function Invoke-TestSignedManifest {
	param(
		[Parameter(Mandatory)] [string]$ManifestScript,
		[Parameter(Mandatory)] [string]$SignedArtifactPath,
		[Parameter(Mandatory)] [string]$UnsignedArtifactPath,
		[Parameter(Mandatory)] [string]$ExpectedPublisherSubject,
		[Parameter(Mandatory)] [string]$ExpectedPublisherCertificateSha256,
		[Parameter(Mandatory)] [string]$UnsignedMetadataPath,
		[Parameter(Mandatory)] [string]$OutputPath
	)
	$pwshPath = @(
		Get-Command pwsh.exe -CommandType Application -ErrorAction Stop
	)[0].Source
	$testEnvironment = [ordered]@{
		EVER_WORKS_TEST_MANIFEST_SCRIPT = $ManifestScript
		EVER_WORKS_TEST_SIGNED_ARTIFACT = $SignedArtifactPath
		EVER_WORKS_TEST_UNSIGNED_ARTIFACT = $UnsignedArtifactPath
		EVER_WORKS_TEST_PUBLISHER_SUBJECT = $ExpectedPublisherSubject
		EVER_WORKS_TEST_PUBLISHER_CERTIFICATE = $ExpectedPublisherCertificateSha256
		EVER_WORKS_TEST_UNSIGNED_METADATA = $UnsignedMetadataPath
		EVER_WORKS_TEST_MANIFEST_OUTPUT = $OutputPath
	}
	$previousEnvironment = @{}
	try {
		foreach ($entry in $testEnvironment.GetEnumerator()) {
			$previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable(
				$entry.Key,
				[EnvironmentVariableTarget]::Process
			)
			[Environment]::SetEnvironmentVariable(
				$entry.Key,
				$entry.Value,
				[EnvironmentVariableTarget]::Process
			)
		}
		$command = @'
$ErrorActionPreference = [Management.Automation.ActionPreference]::Stop
try {
	& $env:EVER_WORKS_TEST_MANIFEST_SCRIPT `
		-SignedArtifactPath $env:EVER_WORKS_TEST_SIGNED_ARTIFACT `
		-UnsignedArtifactPath $env:EVER_WORKS_TEST_UNSIGNED_ARTIFACT `
		-ExpectedPublisherSubject $env:EVER_WORKS_TEST_PUBLISHER_SUBJECT `
		-ExpectedPublisherCertificateSha256 $env:EVER_WORKS_TEST_PUBLISHER_CERTIFICATE `
		-UnsignedMetadataPath $env:EVER_WORKS_TEST_UNSIGNED_METADATA `
		-OutputPath $env:EVER_WORKS_TEST_MANIFEST_OUTPUT
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
'@
		$nativeOutput = & $pwshPath -NoLogo -NoProfile -NonInteractive -Command $command 2>&1
		if ($LASTEXITCODE -ne 0) {
			$nativeFailure = @($nativeOutput | ForEach-Object {
				$failureLines = @($_.ToString())
				if ($_ -is [Management.Automation.ErrorRecord]) {
					$failureLines += $_.Exception.Message
					$failureLines += $_.ErrorDetails.Message
				}
				$failureLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
			}) -join "`n"
			throw $nativeFailure
		}
		return $nativeOutput
	} finally {
		foreach ($entry in $previousEnvironment.GetEnumerator()) {
			[Environment]::SetEnvironmentVariable(
				$entry.Key,
				$entry.Value,
				[EnvironmentVariableTarget]::Process
			)
		}
	}
}

function Set-TestUInt16 {
	param([byte[]]$Bytes, [int]$Offset, [uint16]$Value)
	[Array]::Copy([BitConverter]::GetBytes($Value), 0, $Bytes, $Offset, 2)
}

function Set-TestUInt32 {
	param([byte[]]$Bytes, [int]$Offset, [uint32]$Value)
	[Array]::Copy([BitConverter]::GetBytes($Value), 0, $Bytes, $Offset, 4)
}

function New-TestPe32Fixture {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[int]$OverlaySize = 0
	)
	$bytes = [byte[]]::new(0x600 + $OverlaySize)
	$bytes[0] = 0x4d
	$bytes[1] = 0x5a
	Set-TestUInt32 $bytes 0x3c 0x80
	$bytes[0x80] = 0x50
	$bytes[0x81] = 0x45
	Set-TestUInt16 $bytes 0x84 0x14c
	Set-TestUInt16 $bytes 0x86 2
	Set-TestUInt16 $bytes 0x94 0xe0
	Set-TestUInt16 $bytes 0x96 0x0102
	$optional = 0x98
	Set-TestUInt16 $bytes $optional 0x10b
	Set-TestUInt32 $bytes ($optional + 4) 0x200
	Set-TestUInt32 $bytes ($optional + 8) 0x200
	Set-TestUInt32 $bytes ($optional + 16) 0x1000
	Set-TestUInt32 $bytes ($optional + 20) 0x1000
	Set-TestUInt32 $bytes ($optional + 24) 0x2000
	Set-TestUInt32 $bytes ($optional + 28) 0x00400000
	Set-TestUInt32 $bytes ($optional + 32) 0x1000
	Set-TestUInt32 $bytes ($optional + 36) 0x200
	Set-TestUInt16 $bytes ($optional + 40) 6
	Set-TestUInt16 $bytes ($optional + 48) 6
	Set-TestUInt32 $bytes ($optional + 56) 0x3000
	Set-TestUInt32 $bytes ($optional + 60) 0x200
	Set-TestUInt16 $bytes ($optional + 68) 3
	Set-TestUInt32 $bytes ($optional + 72) 0x100000
	Set-TestUInt32 $bytes ($optional + 76) 0x1000
	Set-TestUInt32 $bytes ($optional + 80) 0x100000
	Set-TestUInt32 $bytes ($optional + 84) 0x1000
	Set-TestUInt32 $bytes ($optional + 92) 16
	$firstSection = 0x178
	[Text.Encoding]::ASCII.GetBytes(".text") | ForEach-Object -Begin { $index = 0 } -Process {
		$bytes[$firstSection + $index] = $_
		$index++
	}
	Set-TestUInt32 $bytes ($firstSection + 8) 1
	Set-TestUInt32 $bytes ($firstSection + 12) 0x1000
	Set-TestUInt32 $bytes ($firstSection + 16) 0x200
	Set-TestUInt32 $bytes ($firstSection + 20) 0x200
	Set-TestUInt32 $bytes ($firstSection + 36) 0x60000020
	$secondSection = $firstSection + 40
	[Text.Encoding]::ASCII.GetBytes(".data") | ForEach-Object -Begin { $index = 0 } -Process {
		$bytes[$secondSection + $index] = $_
		$index++
	}
	Set-TestUInt32 $bytes ($secondSection + 8) 1
	Set-TestUInt32 $bytes ($secondSection + 12) 0x2000
	Set-TestUInt32 $bytes ($secondSection + 16) 0x200
	Set-TestUInt32 $bytes ($secondSection + 20) 0x400
	Set-TestUInt32 $bytes ($secondSection + 36) 3221225536
	$bytes[0x200] = 0xc3
	$bytes[0x400] = 0x7f
	for ($offset = 0; $offset -lt $OverlaySize; $offset++) {
		$bytes[0x600 + $offset] = [byte](0xa0 + $offset)
	}
	[IO.File]::WriteAllBytes($LiteralPath, $bytes)
}

function New-TestPe32SigningFixture {
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[int]$OverlaySize = 0
	)
	$sourcePath = Join-Path $env:SystemRoot "SysWOW64\notepad.exe"
	if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
		throw "Windows PE32 fixture source is unavailable"
	}
	$layout = Get-TestPeLayout $sourcePath
	if ($layout.Magic -ne 0x10b) {
		throw "Windows fixture source is not PE32"
	}
	$bytes = $layout.Bytes
	$certificateOffset = [BitConverter]::ToUInt32($bytes, $layout.SecurityDirectoryOffset)
	$certificateSize = [BitConverter]::ToUInt32($bytes, $layout.SecurityDirectoryOffset + 4)
	if ($certificateOffset -ne 0 -or $certificateSize -ne 0) {
		if ($certificateOffset -eq 0 -or $certificateOffset + $certificateSize -ne $bytes.Length) {
			throw "Windows PE32 fixture has an unsupported certificate layout"
		}
		[Array]::Resize([ref]$bytes, [int]$certificateOffset)
	}
	[Array]::Clear($bytes, $layout.OptionalOffset + 64, 4)
	[Array]::Clear($bytes, $layout.SecurityDirectoryOffset, 8)
	$originalSize = $bytes.Length
	[Array]::Resize([ref]$bytes, $originalSize + $OverlaySize)
	for ($offset = 0; $offset -lt $OverlaySize; $offset++) {
		$bytes[$originalSize + $offset] = [byte](0xa0 + $offset)
	}
	[IO.File]::WriteAllBytes($LiteralPath, $bytes)
}

function Get-TestPeLayout {
	param([Parameter(Mandatory)] [string]$LiteralPath)
	$bytes = [IO.File]::ReadAllBytes($LiteralPath)
	$peOffset = [int][BitConverter]::ToUInt32($bytes, 0x3c)
	$optionalOffset = $peOffset + 24
	$magic = [BitConverter]::ToUInt16($bytes, $optionalOffset)
	$directoryOffset = if ($magic -eq 0x10b) { $optionalOffset + 96 } else { $optionalOffset + 112 }
	$sectionCount = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
	$optionalSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
	$sections = @(
		for ($index = 0; $index -lt $sectionCount; $index++) {
			$offset = $optionalOffset + $optionalSize + ($index * 40)
			[pscustomobject]@{
				HeaderOffset = $offset
				RawSize = [uint32][BitConverter]::ToUInt32($bytes, $offset + 16)
				RawOffset = [uint32][BitConverter]::ToUInt32($bytes, $offset + 20)
			}
		}
	)
	[pscustomobject]@{
		Bytes = $bytes
		Magic = $magic
		PeOffset = $peOffset
		OptionalOffset = $optionalOffset
		NumberOfSectionsOffset = $peOffset + 6
		SectionAlignmentOffset = $optionalOffset + 32
		FileAlignmentOffset = $optionalOffset + 36
		SizeOfHeadersOffset = $optionalOffset + 60
		SectionTableOffset = $optionalOffset + $optionalSize
		SecurityDirectoryOffset = $directoryOffset + 32
		Sections = $sections
	}
}

function Copy-TestPeMutation {
	param(
		[Parameter(Mandatory)] [string]$Source,
		[Parameter(Mandatory)] [string]$Destination,
		[Parameter(Mandatory)] [scriptblock]$Mutation
	)
	$layout = Get-TestPeLayout $Source
	& $Mutation $layout
	[IO.File]::WriteAllBytes($Destination, $layout.Bytes)
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
$syntheticPe32Path = Join-Path $fixtureRoot "pe32\synthetic-sections.exe"
$pe32Path = Join-Path $fixtureRoot "pe32\legal-overlay.exe"
$pe32SignedPath = Join-Path $fixtureRoot "pe32\legal-overlay-signed.exe"
$pe32TrailingPath = Join-Path $fixtureRoot "pe32\trailing-after-certificate.exe"
$structureFixtureRoot = Join-Path $fixtureRoot "structure"
$certificate = $null

try {
	if (Test-Path -LiteralPath $fixtureRoot) {
		Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
	}
	foreach ($path in @($goodPath, $differentPath, $certificateMutationPath, $contentMutationPath, $checksumMutationPath, $syntheticPe32Path, $pe32Path)) {
		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
	}
	New-Item -ItemType Directory -Force -Path $structureFixtureRoot | Out-Null

	$unsignedIdentity = Get-PeAuthenticodeContentIdentity -LiteralPath $artifactPath -RequireUnsigned
	Assert-Equal $unsignedIdentity.FileSize $unsignedIdentity.UnsignedContentSize "unsigned identity must cover the whole file"
	$pe32PlusLayout = Get-TestPeLayout $artifactPath
	if ([uint16]$pe32PlusLayout.Magic -ne [uint16]0x20b) {
		throw "release helper must exercise PE32+ layout"
	}
	New-TestPe32Fixture -LiteralPath $syntheticPe32Path
	New-TestPe32SigningFixture -LiteralPath $pe32Path -OverlaySize 7
	$pe32Identity = Get-PeAuthenticodeContentIdentity -LiteralPath $pe32Path -RequireUnsigned
	Assert-Equal $pe32Identity.FileSize ((Get-Item -LiteralPath $pe32Path).Length) "PE32 overlay must be part of recorded unsigned content"

	$pe32Mutations = @(
		@{ Name = "pe32-huge-section-count"; Pattern = "*section count*"; Change = { param($layout) Set-TestUInt16 $layout.Bytes $layout.NumberOfSectionsOffset 0xffff } },
		@{ Name = "pe32-truncated-section-table"; Pattern = "*section table*SizeOfHeaders*"; Change = { param($layout) Set-TestUInt16 $layout.Bytes $layout.NumberOfSectionsOffset 4 } },
		@{ Name = "pe32-overlapping-sections"; Pattern = "*section raw-data ranges overlap*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes ($layout.Sections[1].HeaderOffset + 20) $layout.Sections[0].RawOffset } },
		@{ Name = "pe32-raw-range-past-eof"; Pattern = "*section raw data lies outside*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes ($layout.Sections[1].HeaderOffset + 20) 0x600 } },
		@{ Name = "pe32-invalid-file-alignment"; Pattern = "*FileAlignment*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes $layout.FileAlignmentOffset 0x300 } },
		@{ Name = "pe32-header-does-not-cover-table"; Pattern = "*section table*SizeOfHeaders*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes $layout.SectionAlignmentOffset 0x80; Set-TestUInt32 $layout.Bytes $layout.FileAlignmentOffset 0x80; Set-TestUInt32 $layout.Bytes $layout.SizeOfHeadersOffset 0x180 } },
		@{ Name = "pe32-header-past-eof"; Pattern = "*SizeOfHeaders*recorded unsigned*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes $layout.SizeOfHeadersOffset 0x800 } }
	)
	foreach ($case in $pe32Mutations) {
		$path = Join-Path $structureFixtureRoot "$($case.Name).exe"
		Copy-TestPeMutation -Source $syntheticPe32Path -Destination $path -Mutation $case.Change
		Assert-ScriptFailsLike -Pattern $case.Pattern -Message $case.Name -Action {
			Get-PeAuthenticodeContentIdentity -LiteralPath $path -RequireUnsigned
		}
	}

	$nonemptyPe32PlusSections = @($pe32PlusLayout.Sections | Where-Object { $_.RawSize -gt 0 })
	if ($nonemptyPe32PlusSections.Count -lt 2) {
		throw "release helper must have at least two nonempty PE32+ sections"
	}
	$pe32PlusMutations = @(
		@{ Name = "pe32plus-huge-section-count"; Pattern = "*section count*"; Change = { param($layout) Set-TestUInt16 $layout.Bytes $layout.NumberOfSectionsOffset 0xffff } },
		@{ Name = "pe32plus-overlapping-sections"; Pattern = "*section raw-data ranges overlap*"; Change = { param($layout) $nonempty = @($layout.Sections | Where-Object { $_.RawSize -gt 0 }); Set-TestUInt32 $layout.Bytes ($nonempty[1].HeaderOffset + 20) $nonempty[0].RawOffset } },
		@{ Name = "pe32plus-raw-range-past-eof"; Pattern = "*section raw data lies outside*"; Change = { param($layout) $nonempty = @($layout.Sections | Where-Object { $_.RawSize -gt 0 }); $fileAlignment = [BitConverter]::ToUInt32($layout.Bytes, $layout.FileAlignmentOffset); $past = [uint32]([Math]::Ceiling($layout.Bytes.Length / [double]$fileAlignment) * $fileAlignment); Set-TestUInt32 $layout.Bytes ($nonempty[0].HeaderOffset + 20) $past } },
		@{ Name = "pe32plus-invalid-table-bound"; Pattern = "*section table*SizeOfHeaders*"; Change = { param($layout) Set-TestUInt32 $layout.Bytes $layout.SectionAlignmentOffset 0x80; Set-TestUInt32 $layout.Bytes $layout.FileAlignmentOffset 0x80; $truncated = [uint32]([Math]::Floor(($layout.SectionTableOffset + 39) / 128.0) * 128); Set-TestUInt32 $layout.Bytes $layout.SizeOfHeadersOffset $truncated } }
	)
	foreach ($case in $pe32PlusMutations) {
		$path = Join-Path $structureFixtureRoot "$($case.Name).exe"
		Copy-TestPeMutation -Source $artifactPath -Destination $path -Mutation $case.Change
		Assert-ScriptFailsLike -Pattern $case.Pattern -Message $case.Name -Action {
			Get-PeAuthenticodeContentIdentity -LiteralPath $path -RequireUnsigned
		}
	}

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
	if ($certificate -is [array]) {
		throw "test certificate creation returned $($certificate.Count) objects: $($certificate | ForEach-Object { $_.GetType().FullName })"
	}
	$goodSignature = Set-AuthenticodeSignature -LiteralPath $goodPath -Certificate $certificate -HashAlgorithm SHA256
	$differentSignature = Set-AuthenticodeSignature `
		-LiteralPath $differentPath `
		-Certificate $certificate `
		-HashAlgorithm SHA256
	Copy-Item -LiteralPath $pe32Path -Destination $pe32SignedPath
	$pe32Signature = Set-AuthenticodeSignature `
		-LiteralPath $pe32SignedPath `
		-Certificate $certificate `
		-HashAlgorithm SHA256
	if ($null -eq $goodSignature.SignerCertificate) {
		throw "good PE32+ fixture could not be Authenticode signed (status=$($goodSignature.Status); message=$($goodSignature.StatusMessage))"
	}
	if ($null -eq $differentSignature.SignerCertificate) {
		throw "different PE32+ fixture could not be Authenticode signed (status=$($differentSignature.Status); message=$($differentSignature.StatusMessage))"
	}
	Assert-Equal ($goodSignature.SignerCertificate.GetCertHashString()) ($certificate.GetCertHashString()) "good fixture must use the fixture certificate"
	Assert-Equal ($differentSignature.SignerCertificate.GetCertHashString()) ($certificate.GetCertHashString()) "adversarial fixture must use the same certificate"
	if ($null -eq $pe32Signature.SignerCertificate) {
		throw "legal PE32 fixture could not be Authenticode signed (status=$($pe32Signature.Status); message=$($pe32Signature.StatusMessage))"
	}
	Assert-Equal ($pe32Signature.SignerCertificate.GetCertHashString()) ($certificate.GetCertHashString()) "legal PE32 fixture must be signed"

	$goodIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $goodPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-Equal $goodIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "Authenticode-only signing must preserve canonical content"

	$differentIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $differentPath `
		-ExpectedUnsignedSize $unsignedIdentity.FileSize
	Assert-NotEqual $differentIdentity.ContentSha256 $unsignedIdentity.ContentSha256 "a different PE signed by the same certificate must not match"
	$pe32SignedIdentity = Get-PeAuthenticodeContentIdentity `
		-LiteralPath $pe32SignedPath `
		-ExpectedUnsignedSize $pe32Identity.FileSize
	Assert-Equal $pe32SignedIdentity.ContentSha256 $pe32Identity.ContentSha256 "legal signed PE32 overlay derivation must preserve canonical content"

	Copy-Item -LiteralPath $pe32SignedPath -Destination $pe32TrailingPath
	$pe32TrailingBytes = [IO.File]::ReadAllBytes($pe32TrailingPath)
	[Array]::Resize([ref]$pe32TrailingBytes, $pe32TrailingBytes.Length + 1)
	$pe32TrailingBytes[$pe32TrailingBytes.Length - 1] = 0x5a
	[IO.File]::WriteAllBytes($pe32TrailingPath, $pe32TrailingBytes)
	Assert-ScriptFailsLike -Pattern "*bytes outside the recorded unsigned content and certificate table*" -Message "signed PE32 trailing overlay must be rejected" -Action {
		Get-PeAuthenticodeContentIdentity -LiteralPath $pe32TrailingPath -ExpectedUnsignedSize $pe32Identity.FileSize
	}

	$certificateOverlapPath = Join-Path $structureFixtureRoot "pe32plus-section-into-certificate.exe"
	Copy-TestPeMutation -Source $goodPath -Destination $certificateOverlapPath -Mutation {
		param($layout)
		$nonempty = @($layout.Sections | Where-Object { $_.RawSize -gt 0 })
		$certificateOffset = [BitConverter]::ToUInt32($layout.Bytes, $layout.SecurityDirectoryOffset)
		$fileAlignment = [BitConverter]::ToUInt32($layout.Bytes, $layout.FileAlignmentOffset)
		Set-TestUInt32 $layout.Bytes ($nonempty[0].HeaderOffset + 16) $fileAlignment
		Set-TestUInt32 $layout.Bytes ($nonempty[0].HeaderOffset + 20) $certificateOffset
	}
	Assert-ScriptFailsLike -Pattern "*section raw data overlaps the certificate table*" -Message "PE32+ section range into certificate table must be rejected" -Action {
		Get-PeAuthenticodeContentIdentity -LiteralPath $certificateOverlapPath -ExpectedUnsignedSize $unsignedIdentity.FileSize
	}

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
		ManifestScript = $manifestScript
		ExpectedPublisherSubject = $certificate.Subject
		ExpectedPublisherCertificateSha256 = $certificateSha256
		UnsignedArtifactPath = $artifactPath
	}

	$fabricatedSizeMetadata = Copy-TestJsonObject $unsignedMetadata
	$fabricatedSizeMetadata.binarySize = [long]$fabricatedSizeMetadata.binarySize + 1
	$fabricatedSizeProvenance = Get-Content `
		-Raw `
		-LiteralPath (Join-Path $testMetadataDirectory ([string]$unsignedMetadata.provenance)) |
		ConvertFrom-Json
	$fabricatedSizeMetadataPath = Write-TestMetadataBundle `
		-Directory (Join-Path $fixtureRoot "fabricated-size") `
		-Metadata $fabricatedSizeMetadata `
		-Provenance $fabricatedSizeProvenance `
		-SourceMetadataDirectory $sourceMetadataDirectory
	Assert-ScriptFailsLike -Pattern "*unsigned artifact size does not match unsigned release metadata*" -Message "fabricated unsigned artifact size must be rejected" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $goodPath `
			-UnsignedMetadataPath $fabricatedSizeMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "fabricated-size.json")
	}

	$signedAsUnsignedSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $goodPath
	).Hash.ToLowerInvariant()
	$signedAsUnsignedMetadata = Copy-TestJsonObject $unsignedMetadata
	$signedAsUnsignedMetadata.binarySize = (Get-Item -LiteralPath $goodPath).Length
	$signedAsUnsignedMetadata.unsignedBuildSha256 = $signedAsUnsignedSha256
	$signedAsUnsignedMetadata.reproducibility.buildSha256 = @(
		$signedAsUnsignedSha256,
		$signedAsUnsignedSha256
	)
	$signedAsUnsignedProvenance = Get-Content `
		-Raw `
		-LiteralPath (Join-Path $testMetadataDirectory ([string]$unsignedMetadata.provenance)) |
		ConvertFrom-Json
	$signedAsUnsignedProvenance.subject[0].digest.sha256 = $signedAsUnsignedSha256
	$signedAsUnsignedProvenance.predicate.runDetails.metadata.reproducibilityEvidence.buildSha256 = @(
		$signedAsUnsignedSha256,
		$signedAsUnsignedSha256
	)
	$signedAsUnsignedMetadataPath = Write-TestMetadataBundle `
		-Directory (Join-Path $fixtureRoot "signed-as-unsigned") `
		-Metadata $signedAsUnsignedMetadata `
		-Provenance $signedAsUnsignedProvenance `
		-SourceMetadataDirectory $sourceMetadataDirectory
	$signedAsUnsignedArguments = @{}
	foreach ($entry in $manifestArguments.GetEnumerator()) {
		$signedAsUnsignedArguments[$entry.Key] = $entry.Value
	}
	$signedAsUnsignedArguments.UnsignedArtifactPath = $goodPath
	Assert-ScriptFailsLike -Pattern "*unsigned PE unexpectedly contains an attribute-certificate table*" -Message "signed input must not impersonate the required unsigned artifact" -Action {
		Invoke-TestSignedManifest @signedAsUnsignedArguments `
			-SignedArtifactPath $goodPath `
			-UnsignedMetadataPath $signedAsUnsignedMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "signed-as-unsigned.json")
	}

	$fabricatedHash = "1".PadLeft(64, "1")
	$fabricatedMetadata = Copy-TestJsonObject $unsignedMetadata
	$fabricatedProvenance = Get-Content `
		-Raw `
		-LiteralPath (Join-Path $testMetadataDirectory ([string]$unsignedMetadata.provenance)) |
		ConvertFrom-Json
	$fabricatedMetadata.unsignedBuildSha256 = $fabricatedHash
	$fabricatedMetadata.reproducibility.buildSha256 = @($fabricatedHash, $fabricatedHash)
	$fabricatedProvenance.subject[0].digest.sha256 = $fabricatedHash
	$fabricatedProvenance.predicate.runDetails.metadata.reproducibilityEvidence.buildSha256 = @(
		$fabricatedHash,
		$fabricatedHash
	)
	$fabricatedMetadataPath = Write-TestMetadataBundle `
		-Directory (Join-Path $fixtureRoot "fabricated-metadata") `
		-Metadata $fabricatedMetadata `
		-Provenance $fabricatedProvenance `
		-SourceMetadataDirectory $sourceMetadataDirectory
	Assert-ScriptFailsLike -Pattern "*unsigned artifact SHA-256 does not match unsigned release metadata*" -Message "fabricated unsigned metadata and consistently rehashed provenance must be rejected" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $goodPath `
			-UnsignedMetadataPath $fabricatedMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "fabricated-metadata.json")
	}

	$mismatchedProvenanceMetadata = Copy-TestJsonObject $unsignedMetadata
	$mismatchedProvenance = Get-Content `
		-Raw `
		-LiteralPath (Join-Path $testMetadataDirectory ([string]$unsignedMetadata.provenance)) |
		ConvertFrom-Json
	$mismatchedProvenance.subject[0].digest.sha256 = "2".PadLeft(64, "2")
	$mismatchedProvenanceMetadataPath = Write-TestMetadataBundle `
		-Directory (Join-Path $fixtureRoot "mismatched-provenance") `
		-Metadata $mismatchedProvenanceMetadata `
		-Provenance $mismatchedProvenance `
		-SourceMetadataDirectory $sourceMetadataDirectory
	Assert-ScriptFailsLike -Pattern "*provenance subject does not match the verified unsigned artifact*" -Message "rehashed provenance with a fabricated subject must be rejected" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $goodPath `
			-UnsignedMetadataPath $mismatchedProvenanceMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "mismatched-provenance.json")
	}

	$invalidSchemaMetadata = Copy-TestJsonObject $unsignedMetadata
	$invalidSchemaMetadata | Add-Member -NotePropertyName attackerControlled -NotePropertyValue $true
	$invalidSchemaProvenance = Get-Content `
		-Raw `
		-LiteralPath (Join-Path $testMetadataDirectory ([string]$unsignedMetadata.provenance)) |
		ConvertFrom-Json
	$invalidSchemaMetadataPath = Write-TestMetadataBundle `
		-Directory (Join-Path $fixtureRoot "invalid-schema") `
		-Metadata $invalidSchemaMetadata `
		-Provenance $invalidSchemaProvenance `
		-SourceMetadataDirectory $sourceMetadataDirectory
	Assert-ScriptFailsLike -Pattern "*unsigned release metadata failed schema validation*" -Message "unsigned metadata outside the checked-in schema must be rejected" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $goodPath `
			-UnsignedMetadataPath $invalidSchemaMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "invalid-schema.json")
	}

	Assert-ScriptFailsLike -Pattern "*canonical Authenticode content hash does not match*" -Message "same-signer different PE must be rejected by source derivation" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $differentPath `
			-UnsignedMetadataPath $testMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "different.json")
	}
	Assert-ScriptFailsLike -Pattern "*canonical Authenticode content hash does not match*" -Message "mutation outside the certificate table must be rejected by source derivation" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $contentMutationPath `
			-UnsignedMetadataPath $testMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "content-mutation.json")
	}
	Assert-ScriptFailsLike -Pattern "*Authenticode status is not Valid*" -Message "certificate-table mutation must reach signature verification" -Action {
		Invoke-TestSignedManifest @manifestArguments `
			-SignedArtifactPath $certificateMutationPath `
			-UnsignedMetadataPath $testMetadataPath `
			-OutputPath (Join-Path $fixtureRoot "certificate-mutation.json")
	}

	if ($expectedFailureTestFailures.Count -gt 0) {
		throw ("PE Authenticode content test failures:`n- " + ($expectedFailureTestFailures -join "`n- "))
	}
	Write-Output "PE Authenticode content tests passed"
} finally {
	if ($null -ne $certificate -and $null -ne $certificate.PSObject.Methods["GetCertHashString"]) {
		$certificatePath = "Cert:\CurrentUser\My\$($certificate.GetCertHashString())"
		if (Test-Path -LiteralPath $certificatePath) {
			Remove-Item -LiteralPath $certificatePath -Force
		}
	}
	if (Test-Path -LiteralPath $fixtureRoot) {
		Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
	}
}
