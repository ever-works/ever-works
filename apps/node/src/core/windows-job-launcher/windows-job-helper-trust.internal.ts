import { spawn, type SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { win32 as windowsPath } from 'node:path';
import type { Writable } from 'node:stream';

export interface WindowsJobHelperTrustPolicyInternal {
	/** Node-operator-owned, local absolute path. PATH and current-directory lookup are never allowed. */
	readonly helperPath: string;
	/** SHA-256 of the final Authenticode-signed production artifact. */
	readonly expectedSha256: string;
	/** Exact leaf certificate subject expected from Get-AuthenticodeSignature. */
	readonly publisherSubject: string;
	/** SHA-256 of the exact leaf signing certificate. */
	readonly publisherCertificateSha256: string;
}

export interface WindowsJobTrustBrokerProcessInternal extends EventEmitter {
	readonly stdin: Writable;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WindowsJobHelperTrustDependenciesInternal {
	readonly platform: NodeJS.Platform;
	readonly systemRoot: string | undefined;
	readonly spawnBroker: (
		executable: string,
		arguments_: string[],
		options: SpawnOptions
	) => WindowsJobTrustBrokerProcessInternal;
}

export type WindowsJobHelperTrustErrorCode =
	| 'WINDOWS_JOB_INVALID_TRUST_POLICY'
	| 'WINDOWS_JOB_TRUST_BROKER_UNAVAILABLE';

export class WindowsJobHelperTrustError extends Error {
	constructor(readonly code: WindowsJobHelperTrustErrorCode) {
		super(`Windows Job helper trust failed (${code})`);
		this.name = 'WindowsJobHelperTrustError';
	}
}

const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/;
const LOCAL_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:\\/;
const POLICY_ENVIRONMENT_NAME = 'EVER_WORKS_WINDOWS_JOB_HELPER_POLICY';

/**
 * Integrity-bound broker source. It is encoded directly into the PowerShell
 * command line; no mutable .ps1 file, PATH lookup, or execution-policy bypass
 * participates in the production launch.
 */
export const WINDOWS_JOB_TRUST_BROKER_SOURCE_INTERNAL = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class EverWorksWindowsJobTrustNative {
    public const uint GENERIC_READ = 0x80000000;
    public const uint FILE_READ_ATTRIBUTES = 0x00000080;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint DRIVE_FIXED = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string name,
        uint access,
        uint share,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle handle,
        System.Text.StringBuilder path,
        uint pathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetDriveTypeW(string rootPathName);
}
"@ -Language CSharp | Out-Null

function Fail-Closed {
    param([int] $ExitCode)
    [Environment]::Exit($ExitCode)
}

function Normalize-FinalPath {
    param([string] $Path)
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Path.Substring(8)
    }
    if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring(4)
    }
    return $Path
}

function Get-FinalPath {
    param([Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle)
    $buffer = [Text.StringBuilder]::new(32768)
    $length = [EverWorksWindowsJobTrustNative]::GetFinalPathNameByHandleW(
        $Handle,
        $buffer,
        [uint32] $buffer.Capacity,
        0)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'canonical-path-unavailable' }
    return Normalize-FinalPath $buffer.ToString()
}

function Get-StreamSha256 {
    param([IO.FileStream] $Stream)
    $Stream.Position = 0
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '')
    } finally {
        $sha.Dispose()
        $Stream.Position = 0
    }
}

function Assert-Authenticode {
    param([string] $Path, [object] $Policy)
    $command = Get-Command -Name Get-AuthenticodeSignature -CommandType Cmdlet -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'authenticode-unavailable' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
    if ($null -eq $signature -or $signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw 'authenticode-invalid'
    }
    if (-not [string]::Equals(
        [string] $signature.SignerCertificate.Subject,
        [string] $Policy.publisherSubject,
        [StringComparison]::Ordinal)) {
        throw 'publisher-subject-mismatch'
    }
    $certificateSha256 = $signature.SignerCertificate.GetCertHashString(
        [Security.Cryptography.HashAlgorithmName]::SHA256)
    if (-not [string]::Equals(
        $certificateSha256,
        [string] $Policy.publisherCertificateSha256,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'publisher-certificate-mismatch'
    }
}

$helper = $null
$fileStream = $null
$directoryLeases = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
try {
    $encodedPolicy = [Environment]::GetEnvironmentVariable('EVER_WORKS_WINDOWS_JOB_HELPER_POLICY')
    [Environment]::SetEnvironmentVariable('EVER_WORKS_WINDOWS_JOB_HELPER_POLICY', $null)
    if ([string]::IsNullOrWhiteSpace($encodedPolicy)) { throw 'policy-missing' }
    $policyJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPolicy))
    $policy = ConvertFrom-Json -InputObject $policyJson -ErrorAction Stop
    $configuredPath = [string] $policy.helperPath
    if ($configuredPath -notmatch '^[A-Za-z]:\\' -or
        $configuredPath.StartsWith('\\', [StringComparison]::Ordinal) -or
        $configuredPath.IndexOf([char] 0) -ge 0) {
        throw 'path-invalid'
    }
    $fullPath = [IO.Path]::GetFullPath($configuredPath)
    if (-not [string]::Equals($fullPath, $configuredPath, [StringComparison]::Ordinal)) {
        throw 'path-not-normalized'
    }
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ([EverWorksWindowsJobTrustNative]::GetDriveTypeW($root) -ne [EverWorksWindowsJobTrustNative]::DRIVE_FIXED) {
        throw 'drive-not-local-fixed'
    }

    $targets = [Collections.Generic.List[string]]::new()
    $current = $root
    foreach ($segment in $fullPath.Substring($root.Length).Split([char] '\')) {
        if ([string]::IsNullOrEmpty($segment)) { throw 'path-invalid' }
        $current = [IO.Path]::Combine($current, $segment)
        $targets.Add($current)
    }

    for ($index = 0; $index -lt $targets.Count; $index += 1) {
        $target = $targets[$index]
        $isFile = $index -eq ($targets.Count - 1)
        $access = if ($isFile) {
            [EverWorksWindowsJobTrustNative]::GENERIC_READ
        } else {
            [EverWorksWindowsJobTrustNative]::FILE_READ_ATTRIBUTES
        }
        $handle = [EverWorksWindowsJobTrustNative]::CreateFileW(
            $target,
            $access,
            [EverWorksWindowsJobTrustNative]::FILE_SHARE_READ,
            [IntPtr]::Zero,
            [EverWorksWindowsJobTrustNative]::OPEN_EXISTING,
            [EverWorksWindowsJobTrustNative]::FILE_FLAG_BACKUP_SEMANTICS -bor
                [EverWorksWindowsJobTrustNative]::FILE_FLAG_OPEN_REPARSE_POINT,
            [IntPtr]::Zero)
        if ($handle.IsInvalid) { $handle.Dispose(); throw 'lease-unavailable' }

        $information = [EverWorksWindowsJobTrustNative+BY_HANDLE_FILE_INFORMATION]::new()
        if (-not [EverWorksWindowsJobTrustNative]::GetFileInformationByHandle($handle, [ref] $information)) {
            $handle.Dispose()
            throw 'file-information-unavailable'
        }
        if (($information.FileAttributes -band [EverWorksWindowsJobTrustNative]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
            $handle.Dispose()
            throw 'reparse-point-refused'
        }
        $canonicalPath = Get-FinalPath $handle
        if (-not [string]::Equals($canonicalPath, $target, [StringComparison]::OrdinalIgnoreCase)) {
            $handle.Dispose()
            throw 'canonical-path-mismatch'
        }

        if ($isFile) {
            $fileStream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read, 65536, $false)
        } else {
            $directoryLeases.Add($handle)
        }
    }

    if (-not [string]::Equals(
        (Get-StreamSha256 $fileStream),
        [string] $policy.expectedSha256,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'helper-hash-mismatch'
    }
    Assert-Authenticode $fullPath $policy

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $fullPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($fullPath)
    $startInfo.EnvironmentVariables.Clear()
    $helper = [Diagnostics.Process]::new()
    $helper.StartInfo = $startInfo
    if (-not $helper.Start()) { throw 'helper-start-failed' }

    if (-not [string]::Equals(
        (Get-StreamSha256 $fileStream),
        [string] $policy.expectedSha256,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'post-start-hash-mismatch'
    }
    Assert-Authenticode $fullPath $policy

    $parentInput = [Console]::OpenStandardInput()
    $parentOutput = [Console]::OpenStandardOutput()
    $inputCopy = $parentInput.CopyToAsync($helper.StandardInput.BaseStream)
    $outputCopy = $helper.StandardOutput.BaseStream.CopyToAsync($parentOutput)
    $errorCopy = $helper.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $inputClosed = $false
    while (-not $helper.HasExited) {
        if ($inputCopy.IsFaulted -or $outputCopy.IsFaulted -or $errorCopy.IsFaulted) {
            $helper.Kill()
            throw 'broker-transport-failed'
        }
        if (-not $inputClosed -and $inputCopy.IsCompleted) {
            if ($inputCopy.IsFaulted) { $helper.Kill(); throw 'broker-input-failed' }
            $helper.StandardInput.Close()
            $inputClosed = $true
        }
        [Threading.Thread]::Sleep(10)
    }
    if (-not $inputClosed) {
        $helper.StandardInput.Close()
        $parentInput.Dispose()
    }
    $outputCopy.GetAwaiter().GetResult()
    $errorCopy.GetAwaiter().GetResult()
    $parentOutput.Flush()
    $exitCode = $helper.ExitCode
    $helper.WaitForExit()
    [Environment]::Exit($exitCode)
} catch {
    if ($null -ne $helper -and -not $helper.HasExited) {
        try { $helper.Kill() } catch {}
        try { $helper.WaitForExit() } catch {}
    }
    Fail-Closed 71
} finally {
    if ($null -ne $helper) { $helper.Dispose() }
    if ($null -ne $fileStream) { $fileStream.Dispose() }
    for ($index = $directoryLeases.Count - 1; $index -ge 0; $index -= 1) {
        $directoryLeases[$index].Dispose()
    }
}`;

const WINDOWS_JOB_TRUST_BROKER_ENCODED_COMMAND_INTERNAL = Buffer.from(
	WINDOWS_JOB_TRUST_BROKER_SOURCE_INTERNAL,
	'utf16le'
).toString('base64');

const defaultDependencies: WindowsJobHelperTrustDependenciesInternal = {
	platform: process.platform,
	systemRoot: process.env.SystemRoot,
	spawnBroker: (executable, arguments_, options) =>
		spawn(executable, arguments_, options) as WindowsJobTrustBrokerProcessInternal
};

export function normalizeWindowsJobHelperTrustPolicyInternal(
	policy: WindowsJobHelperTrustPolicyInternal
): WindowsJobHelperTrustPolicyInternal {
	const helperPath = policy.helperPath;
	const normalizedPath = windowsPath.normalize(helperPath);
	const colonAfterDrive = helperPath.indexOf(':', 2);
	if (
		!LOCAL_DRIVE_ABSOLUTE_PATTERN.test(helperPath) ||
		!windowsPath.isAbsolute(helperPath) ||
		helperPath.startsWith('\\\\') ||
		helperPath.includes('/') ||
		helperPath.includes('\0') ||
		helperPath !== normalizedPath ||
		colonAfterDrive !== -1 ||
		windowsPath.extname(helperPath).toLowerCase() !== '.exe'
	) {
		throw new WindowsJobHelperTrustError('WINDOWS_JOB_INVALID_TRUST_POLICY');
	}
	if (
		!SHA256_PATTERN.test(policy.expectedSha256) ||
		!SHA256_PATTERN.test(policy.publisherCertificateSha256) ||
		policy.publisherSubject.trim() !== policy.publisherSubject ||
		policy.publisherSubject.length === 0 ||
		policy.publisherSubject.length > 1024 ||
		/[\0\r\n]/.test(policy.publisherSubject)
	) {
		throw new WindowsJobHelperTrustError('WINDOWS_JOB_INVALID_TRUST_POLICY');
	}
	return Object.freeze({
		helperPath,
		expectedSha256: policy.expectedSha256.toUpperCase(),
		publisherSubject: policy.publisherSubject,
		publisherCertificateSha256: policy.publisherCertificateSha256.toUpperCase()
	});
}

export function createTrustedWindowsJobHelperBrokerInternal(
	policy: WindowsJobHelperTrustPolicyInternal,
	dependencyOverrides: Partial<WindowsJobHelperTrustDependenciesInternal> = {}
): WindowsJobTrustBrokerProcessInternal {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	if (dependencies.platform !== 'win32' || !isNormalizedLocalDriveRoot(dependencies.systemRoot)) {
		throw new WindowsJobHelperTrustError('WINDOWS_JOB_TRUST_BROKER_UNAVAILABLE');
	}
	const normalizedPolicy = normalizeWindowsJobHelperTrustPolicyInternal(policy);
	const systemRoot = dependencies.systemRoot;
	const system32 = windowsPath.join(systemRoot, 'System32');
	const powershellPath = windowsPath.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const encodedPolicy = Buffer.from(JSON.stringify(normalizedPolicy), 'utf8').toString('base64');
	try {
		return dependencies.spawnBroker(
			powershellPath,
			[
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-Mta',
				'-EncodedCommand',
				WINDOWS_JOB_TRUST_BROKER_ENCODED_COMMAND_INTERNAL
			],
			{
				cwd: system32,
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					SystemRoot: systemRoot,
					WINDIR: systemRoot,
					[POLICY_ENVIRONMENT_NAME]: encodedPolicy
				}
			}
		);
	} catch {
		throw new WindowsJobHelperTrustError('WINDOWS_JOB_TRUST_BROKER_UNAVAILABLE');
	}
}

function isNormalizedLocalDriveRoot(value: string | undefined): value is string {
	if (value === undefined) return false;
	return (
		LOCAL_DRIVE_ABSOLUTE_PATTERN.test(`${value}\\`) &&
		windowsPath.isAbsolute(value) &&
		!value.startsWith('\\\\') &&
		!value.includes('/') &&
		!value.includes('\0') &&
		value === windowsPath.normalize(value) &&
		windowsPath.parse(value).root.toLowerCase() !== value.toLowerCase()
	);
}
