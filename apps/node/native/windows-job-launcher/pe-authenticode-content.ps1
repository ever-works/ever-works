Set-StrictMode -Version Latest

function Get-PeAuthenticodeContentIdentity {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory)] [string]$LiteralPath,
		[long]$ExpectedUnsignedSize = -1,
		[switch]$RequireUnsigned
	)

	$resolvedPath = [IO.Path]::GetFullPath($LiteralPath)
	if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
		throw "PE artifact does not exist: $resolvedPath"
	}
	$bytes = [IO.File]::ReadAllBytes($resolvedPath)
	if ($bytes.LongLength -gt [int]::MaxValue) {
		throw "PE artifact is too large for canonical content verification"
	}

	function Assert-ByteRange {
		param([long]$Offset, [long]$Length, [string]$Name)
		if ($Offset -lt 0 -or $Length -lt 0 -or $Offset -gt $bytes.LongLength - $Length) {
			throw "$Name lies outside the PE artifact"
		}
	}

	Assert-ByteRange 0 64 "DOS header"
	if ($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
		throw "artifact is not an MZ executable"
	}
	$peOffset = [long][BitConverter]::ToUInt32($bytes, 0x3c)
	Assert-ByteRange $peOffset 24 "PE and COFF headers"
	if (
		$bytes[$peOffset] -ne 0x50 -or
		$bytes[$peOffset + 1] -ne 0x45 -or
		$bytes[$peOffset + 2] -ne 0 -or
		$bytes[$peOffset + 3] -ne 0
	) {
		throw "artifact has an invalid PE signature"
	}

	$optionalHeaderSize = [long][BitConverter]::ToUInt16($bytes, [int]($peOffset + 20))
	$numberOfSections = [long][BitConverter]::ToUInt16($bytes, [int]($peOffset + 6))
	if ($numberOfSections -lt 1 -or $numberOfSections -gt 96) {
		throw "PE COFF section count must be between 1 and 96"
	}
	$optionalHeaderOffset = $peOffset + 24
	Assert-ByteRange $optionalHeaderOffset $optionalHeaderSize "PE optional header"
	$optionalMagic = [BitConverter]::ToUInt16($bytes, [int]$optionalHeaderOffset)
	switch ($optionalMagic) {
		0x10b {
			$numberOfDirectoriesOffset = $optionalHeaderOffset + 92
			$dataDirectoriesOffset = $optionalHeaderOffset + 96
		}
		0x20b {
			$numberOfDirectoriesOffset = $optionalHeaderOffset + 108
			$dataDirectoriesOffset = $optionalHeaderOffset + 112
		}
		default { throw "artifact has an unsupported PE optional-header magic" }
	}
	$checksumOffset = $optionalHeaderOffset + 64
	$sectionAlignmentOffset = $optionalHeaderOffset + 32
	$fileAlignmentOffset = $optionalHeaderOffset + 36
	$sizeOfHeadersOffset = $optionalHeaderOffset + 60
	$securityDirectoryOffset = $dataDirectoriesOffset + (4 * 8)
	Assert-ByteRange $checksumOffset 4 "PE checksum"
	Assert-ByteRange $sectionAlignmentOffset 4 "PE SectionAlignment"
	Assert-ByteRange $fileAlignmentOffset 4 "PE FileAlignment"
	Assert-ByteRange $sizeOfHeadersOffset 4 "PE SizeOfHeaders"
	Assert-ByteRange $numberOfDirectoriesOffset 4 "PE data-directory count"
	Assert-ByteRange $securityDirectoryOffset 8 "PE security directory"
	if ($securityDirectoryOffset + 8 -gt $optionalHeaderOffset + $optionalHeaderSize) {
		throw "PE optional header does not contain the security directory"
	}
	$numberOfDirectories = [BitConverter]::ToUInt32($bytes, [int]$numberOfDirectoriesOffset)
	if ($numberOfDirectories -lt 5) {
		throw "PE optional header does not declare a security directory"
	}
	$sectionAlignment = [long][BitConverter]::ToUInt32($bytes, [int]$sectionAlignmentOffset)
	$fileAlignment = [long][BitConverter]::ToUInt32($bytes, [int]$fileAlignmentOffset)
	$sizeOfHeaders = [long][BitConverter]::ToUInt32($bytes, [int]$sizeOfHeadersOffset)
	$isFileAlignmentPowerOfTwo = $fileAlignment -gt 0 -and ($fileAlignment -band ($fileAlignment - 1)) -eq 0
	if (-not $isFileAlignmentPowerOfTwo) {
		throw "PE FileAlignment must be a nonzero power of two"
	}
	if ($sectionAlignment -lt 0x1000) {
		if ($fileAlignment -ne $sectionAlignment) {
			throw "PE FileAlignment must equal sub-page SectionAlignment"
		}
	} elseif ($fileAlignment -lt 0x200 -or $fileAlignment -gt 0x10000) {
		throw "PE FileAlignment must be between 512 and 65536 bytes"
	}
	if ($sectionAlignment -lt $fileAlignment) {
		throw "PE SectionAlignment must not be smaller than FileAlignment"
	}
	if ($sizeOfHeaders -eq 0 -or $sizeOfHeaders % $fileAlignment -ne 0) {
		throw "PE SizeOfHeaders must be a nonzero FileAlignment multiple"
	}
	$sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
	$sectionTableSize = $numberOfSections * 40
	if ($sectionTableOffset -gt $sizeOfHeaders - $sectionTableSize) {
		throw "PE section table is not fully contained within SizeOfHeaders"
	}
	Assert-ByteRange $sectionTableOffset $sectionTableSize "PE section table"

	$certificateTableOffset = [long][BitConverter]::ToUInt32($bytes, [int]$securityDirectoryOffset)
	$certificateTableSize = [long][BitConverter]::ToUInt32($bytes, [int]($securityDirectoryOffset + 4))
	if (($certificateTableOffset -eq 0) -xor ($certificateTableSize -eq 0)) {
		throw "PE security-directory offset and size must both be zero or both be nonzero"
	}
	$hasCertificateTable = $certificateTableOffset -ne 0

	if ($RequireUnsigned) {
		if ($hasCertificateTable) {
			throw "unsigned PE unexpectedly contains an attribute-certificate table"
		}
		if ($ExpectedUnsignedSize -ge 0 -and $ExpectedUnsignedSize -ne $bytes.LongLength) {
			throw "unsigned PE size does not match the expected size"
		}
		$unsignedContentSize = $bytes.LongLength
	} elseif ($ExpectedUnsignedSize -ge 0) {
		if (-not $hasCertificateTable) {
			throw "signed PE does not contain an attribute-certificate table"
		}
		if ($ExpectedUnsignedSize -lt $securityDirectoryOffset + 8 -or $ExpectedUnsignedSize -gt $bytes.LongLength) {
			throw "expected unsigned PE size is invalid"
		}
		$alignedUnsignedSize = [long]([Math]::Ceiling($ExpectedUnsignedSize / 8.0) * 8)
		if ($certificateTableOffset -ne $alignedUnsignedSize) {
			throw "signed PE certificate table is not the sole aligned append to the unsigned artifact"
		}
		if ($certificateTableOffset % 8 -ne 0 -or $certificateTableSize -lt 8) {
			throw "signed PE certificate table is malformed"
		}
		if ($certificateTableOffset -gt $bytes.LongLength - $certificateTableSize) {
			throw "signed PE certificate table lies outside the artifact"
		}
		if ($certificateTableOffset + $certificateTableSize -ne $bytes.LongLength) {
			throw "signed PE contains bytes outside the recorded unsigned content and certificate table"
		}
		for ($offset = $ExpectedUnsignedSize; $offset -lt $certificateTableOffset; $offset++) {
			if ($bytes[$offset] -ne 0) {
				throw "signed PE alignment padding contains nonzero data"
			}
		}
		$unsignedContentSize = $ExpectedUnsignedSize
	} else {
		if ($hasCertificateTable) {
			throw "ExpectedUnsignedSize is required to verify a signed PE derivation"
		}
		$unsignedContentSize = $bytes.LongLength
	}
	if ($sizeOfHeaders -gt $unsignedContentSize) {
		throw "PE SizeOfHeaders lies outside the recorded unsigned content"
	}

	$sectionRanges = [Collections.Generic.List[object]]::new()
	for ($sectionIndex = 0; $sectionIndex -lt $numberOfSections; $sectionIndex++) {
		$sectionHeaderOffset = $sectionTableOffset + ($sectionIndex * 40)
		$rawDataSize = [long][BitConverter]::ToUInt32($bytes, [int]($sectionHeaderOffset + 16))
		$rawDataOffset = [long][BitConverter]::ToUInt32($bytes, [int]($sectionHeaderOffset + 20))
		if ($rawDataSize -eq 0) {
			continue
		}
		if ($rawDataOffset -eq 0 -or $rawDataOffset % $fileAlignment -ne 0) {
			throw "PE section raw-data offset is not FileAlignment-aligned"
		}
		if ($rawDataSize % $fileAlignment -ne 0) {
			throw "PE section raw-data size is not FileAlignment-aligned"
		}
		if ($rawDataOffset -lt $sizeOfHeaders) {
			throw "PE section raw data overlaps SizeOfHeaders"
		}
		$rawDataEnd = $rawDataOffset + $rawDataSize
		if ($rawDataEnd -gt ([long][uint32]::MaxValue + 1)) {
			throw "PE section raw-data range overflows the 32-bit file address space"
		}
		if (
			$hasCertificateTable -and
			$rawDataOffset -lt $certificateTableOffset + $certificateTableSize -and
			$rawDataEnd -gt $certificateTableOffset
		) {
			throw "PE section raw data overlaps the certificate table"
		}
		if ($rawDataEnd -gt $unsignedContentSize) {
			throw "PE section raw data lies outside the recorded unsigned content"
		}
		$sectionRanges.Add([pscustomobject]@{
			Start = $rawDataOffset
			End = $rawDataEnd
			Index = $sectionIndex
		})
	}
	$orderedSectionRanges = @($sectionRanges | Sort-Object -Property Start, End, Index)
	for ($rangeIndex = 1; $rangeIndex -lt $orderedSectionRanges.Count; $rangeIndex++) {
		if ($orderedSectionRanges[$rangeIndex].Start -lt $orderedSectionRanges[$rangeIndex - 1].End) {
			throw "PE section raw-data ranges overlap"
		}
	}

	$canonicalContent = [byte[]]::new([int]$unsignedContentSize)
	[Array]::Copy($bytes, 0, $canonicalContent, 0, [int]$unsignedContentSize)
	[Array]::Clear($canonicalContent, [int]$checksumOffset, 4)
	[Array]::Clear($canonicalContent, [int]$securityDirectoryOffset, 8)
	$domain = [Text.Encoding]::ASCII.GetBytes("ever-works-pe-authenticode-content-v1`0")
	$hash = [Security.Cryptography.IncrementalHash]::CreateHash(
		[Security.Cryptography.HashAlgorithmName]::SHA256
	)
	try {
		$hash.AppendData($domain)
		$hash.AppendData([BitConverter]::GetBytes([long]$unsignedContentSize))
		$hash.AppendData([BitConverter]::GetBytes([long]$checksumOffset))
		$hash.AppendData([BitConverter]::GetBytes([long]$securityDirectoryOffset))
		$hash.AppendData($canonicalContent)
		$contentSha256 = [BitConverter]::ToString($hash.GetHashAndReset()).Replace("-", "").ToLowerInvariant()
	} finally {
		$hash.Dispose()
	}

	[pscustomobject][ordered]@{
		ContentSha256 = $contentSha256
		FileSize = [long]$bytes.LongLength
		UnsignedContentSize = [long]$unsignedContentSize
		ChecksumOffset = [long]$checksumOffset
		SecurityDirectoryOffset = [long]$securityDirectoryOffset
		CertificateTableOffset = [long]$certificateTableOffset
		CertificateTableSize = [long]$certificateTableSize
		HasCertificateTable = [bool]$hasCertificateTable
		NumberOfSections = [int]$numberOfSections
		FileAlignment = [long]$fileAlignment
		SizeOfHeaders = [long]$sizeOfHeaders
	}
}
