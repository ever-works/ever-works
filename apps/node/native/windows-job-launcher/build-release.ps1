[CmdletBinding()]
param(
	[string]$OutputDirectory = "target\release-metadata"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$packageRoot = $PSScriptRoot
$targetTriple = "x86_64-pc-windows-msvc"
$artifactName = "ever-works-windows-job-launcher.exe"
$binaryPath = Join-Path $packageRoot "target\$targetTriple\release\$artifactName"
$metadataDirectory = Join-Path $packageRoot $OutputDirectory
$metadataPath = Join-Path $metadataDirectory "ever-works-windows-job-launcher.json"
$sbomName = "ever-works-windows-job-launcher.sbom.cdx.json"
$sbomPath = Join-Path $metadataDirectory $sbomName
$provenanceName = "ever-works-windows-job-launcher.provenance.intoto.json"
$provenancePath = Join-Path $metadataDirectory $provenanceName
$previousRustFlags = $env:RUSTFLAGS
$previousSourceDateEpoch = $env:SOURCE_DATE_EPOCH
$previousCargoIncremental = $env:CARGO_INCREMENTAL
$reproducibleLinkFlag = "-C link-arg=/Brepro"
$env:RUSTFLAGS = if ([string]::IsNullOrWhiteSpace($previousRustFlags)) {
	$reproducibleLinkFlag
} else {
	"$previousRustFlags $reproducibleLinkFlag"
}
$env:CARGO_INCREMENTAL = "0"

function Write-DeterministicJson {
	param(
		[Parameter(Mandatory)] [object]$Value,
		[Parameter(Mandatory)] [string]$LiteralPath
	)
	$json = $Value | ConvertTo-Json -Depth 16 -Compress
	[IO.File]::WriteAllText($LiteralPath, "$json`n", [Text.UTF8Encoding]::new($false))
}

try {
	Push-Location $packageRoot
	try {
		$sourceStatus = git status --porcelain=v1 --untracked-files=normal -- .
		if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($sourceStatus -join ""))) {
			throw "release metadata requires a clean package source tree"
		}

		$sourceCommit = (git rev-parse HEAD).Trim()
		$sourceDateEpoch = (git show -s --format=%ct HEAD).Trim()
		if (
			$LASTEXITCODE -ne 0 -or
			$sourceCommit -notmatch '^[0-9a-f]{40}$' -or
			$sourceDateEpoch -notmatch '^[0-9]+$'
		) {
			throw "unable to resolve deterministic source identity"
		}
		$env:SOURCE_DATE_EPOCH = $sourceDateEpoch

		cargo build --locked --release --target $targetTriple
		if ($LASTEXITCODE -ne 0) {
			throw "cargo release build failed"
		}

		$cargoMetadataJson = cargo metadata --locked --format-version 1
		if ($LASTEXITCODE -ne 0) {
			throw "cargo metadata failed"
		}
		$cargoMetadata = ($cargoMetadataJson -join "`n") | ConvertFrom-Json
	} finally {
		Pop-Location
	}

	New-Item -ItemType Directory -Force -Path $metadataDirectory | Out-Null
	$binary = Get-Item -LiteralPath $binaryPath
	$unsignedBuildSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaryPath).Hash.ToLowerInvariant()
	$cargoLockSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "Cargo.lock")
	).Hash.ToLowerInvariant()
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
	$sbomSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sbomPath).Hash.ToLowerInvariant()

	$provenance = [ordered]@{
		"_type" = "https://in-toto.io/Statement/v1"
		subject = @(
			[ordered]@{
				name = $artifactName
				digest = [ordered]@{ sha256 = $unsignedBuildSha256 }
			}
		)
		predicateType = "https://slsa.dev/provenance/v1"
		predicate = [ordered]@{
			buildDefinition = [ordered]@{
				buildType = "https://ever.co/build-types/cargo-windows-msvc-brepro/v1"
				externalParameters = [ordered]@{
					targetTriple = $targetTriple
					rustToolchain = "1.88.0"
					cargoLocked = $true
					msvcReproducibleLink = $true
				}
				internalParameters = [ordered]@{
					sourceDateEpoch = $sourceDateEpoch
					cargoIncremental = $false
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
				builder = [ordered]@{
					id = "https://github.com/ever-co/ever-works/.github/workflows/windows-job-launcher.yml"
				}
				metadata = [ordered]@{ reproducible = $true }
			}
		}
	}
	Write-DeterministicJson -Value $provenance -LiteralPath $provenancePath
	$provenanceSha256 = (
		Get-FileHash -Algorithm SHA256 -LiteralPath $provenancePath
	).Hash.ToLowerInvariant()

	$metadata = [ordered]@{
		schemaVersion = 2
		productionEligible = $false
		artifact = $artifactName
		targetTriple = $targetTriple
		rustToolchain = "1.88.0"
		cargoLocked = $true
		sourceCommit = $sourceCommit
		binarySize = $binary.Length
		unsignedBuildSha256 = $unsignedBuildSha256
		cargoLockSha256 = $cargoLockSha256
		sbom = $sbomName
		sbomSha256 = $sbomSha256
		provenance = $provenanceName
		provenanceSha256 = $provenanceSha256
		authenticode = [ordered]@{ status = "unsigned"; productionUse = "forbidden" }
	}
	Write-DeterministicJson -Value $metadata -LiteralPath $metadataPath
	Write-Output $metadataPath
} finally {
	$env:RUSTFLAGS = $previousRustFlags
	$env:SOURCE_DATE_EPOCH = $previousSourceDateEpoch
	$env:CARGO_INCREMENTAL = $previousCargoIncremental
}
