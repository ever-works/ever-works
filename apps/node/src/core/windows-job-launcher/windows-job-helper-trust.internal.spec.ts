import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
	WINDOWS_JOB_TRUST_BROKER_SOURCE_INTERNAL,
	WindowsJobHelperTrustError,
	createTrustedWindowsJobHelperBrokerInternal,
	normalizeWindowsJobHelperTrustPolicyInternal,
	type WindowsJobHelperTrustPolicyInternal
} from './windows-job-helper-trust.internal';

const policy = (overrides: Partial<WindowsJobHelperTrustPolicyInternal> = {}): WindowsJobHelperTrustPolicyInternal => ({
	helperPath: String.raw`C:\Program Files\Ever Works\windows-job-launcher.exe`,
	expectedSha256: 'a'.repeat(64),
	publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
	publisherCertificateSha256: 'b'.repeat(64),
	...overrides
});

describe('trusted Windows Job helper broker', () => {
	it('normalizes immutable hash pins without changing the configured absolute path or publisher', () => {
		expect(normalizeWindowsJobHelperTrustPolicyInternal(policy())).toEqual({
			helperPath: String.raw`C:\Program Files\Ever Works\windows-job-launcher.exe`,
			expectedSha256: 'A'.repeat(64),
			publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
			publisherCertificateSha256: 'B'.repeat(64)
		});
	});

	it.each([
		['relative', 'windows-job-launcher.exe'],
		['drive-relative', String.raw`C:windows-job-launcher.exe`],
		['UNC', String.raw`\\server\share\windows-job-launcher.exe`],
		['extended UNC', String.raw`\\?\UNC\server\share\windows-job-launcher.exe`],
		['device', String.raw`\\.\C:\trusted\windows-job-launcher.exe`],
		['extended device', String.raw`\\?\C:\trusted\windows-job-launcher.exe`],
		['parent traversal', String.raw`C:\trusted\..\windows-job-launcher.exe`],
		['alternate data stream', String.raw`C:\trusted\windows-job-launcher.exe:payload`],
		['wrong extension', String.raw`C:\trusted\windows-job-launcher.cmd`],
		['NUL', `C:\\trusted\\windows-job-launcher.exe\0payload`]
	])('rejects a %s helper path before a broker can be spawned', (_name, helperPath) => {
		expect(() => normalizeWindowsJobHelperTrustPolicyInternal(policy({ helperPath }))).toThrowError(
			WindowsJobHelperTrustError
		);
	});

	it.each([
		['short helper hash', { expectedSha256: 'A'.repeat(63) }],
		['non-hex helper hash', { expectedSha256: 'G'.repeat(64) }],
		['short certificate hash', { publisherCertificateSha256: 'B'.repeat(63) }],
		['empty publisher', { publisherSubject: '' }],
		['whitespace publisher', { publisherSubject: '   ' }],
		['NUL publisher', { publisherSubject: 'CN=Ever\0Ignored' }]
	])('rejects %s', (_name, override) => {
		expect(() => normalizeWindowsJobHelperTrustPolicyInternal(policy(override))).toThrowError(
			WindowsJobHelperTrustError
		);
	});

	it('spawns only the absolute System32 broker with an integrity-bound command and sterile environment', () => {
		const broker = new FakeBroker();
		const spawnBroker = vi.fn(
			(_executable: string, _arguments: string[], _options: import('node:child_process').SpawnOptions) => broker
		);

		const result = createTrustedWindowsJobHelperBrokerInternal(policy(), {
			platform: 'win32',
			systemRoot: String.raw`C:\Windows`,
			spawnBroker
		});

		expect(result).toBe(broker);
		expect(spawnBroker).toHaveBeenCalledOnce();
		const call = spawnBroker.mock.calls[0];
		expect(call).toBeDefined();
		const [executable, arguments_, options] = call!;
		expect(executable).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
		expect(arguments_.slice(0, -1)).toEqual([
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Mta',
			'-EncodedCommand'
		]);
		expect(Buffer.from(arguments_.at(-1)!, 'base64').toString('utf16le')).toBe(
			WINDOWS_JOB_TRUST_BROKER_SOURCE_INTERNAL
		);
		expect(arguments_.join(' ')).not.toContain('ExecutionPolicy');
		expect(arguments_.join(' ')).not.toContain('windows-job-launcher.exe');
		expect(options).toMatchObject({
			cwd: String.raw`C:\Windows\System32`,
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: true,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		expect(Object.keys(options.env!).sort()).toEqual([
			'EVER_WORKS_WINDOWS_JOB_HELPER_POLICY',
			'SystemRoot',
			'WINDIR'
		]);
		expect(options.env).not.toHaveProperty('PATH');
		expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
		expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
		const encodedPolicy = String(options.env!.EVER_WORKS_WINDOWS_JOB_HELPER_POLICY);
		expect(JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf8'))).toEqual({
			helperPath: String.raw`C:\Program Files\Ever Works\windows-job-launcher.exe`,
			expectedSha256: 'A'.repeat(64),
			publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
			publisherCertificateSha256: 'B'.repeat(64)
		});
	});

	it.each([
		['non-Windows platform', { platform: 'linux' as const, systemRoot: String.raw`C:\Windows` }],
		['relative system root', { platform: 'win32' as const, systemRoot: 'Windows' }],
		['UNC system root', { platform: 'win32' as const, systemRoot: String.raw`\\server\Windows` }]
	])('fails closed for a %s', (_name, overrides) => {
		const spawnBroker = vi.fn();
		expect(() => createTrustedWindowsJobHelperBrokerInternal(policy(), { ...overrides, spawnBroker })).toThrowError(
			WindowsJobHelperTrustError
		);
		expect(spawnBroker).not.toHaveBeenCalled();
	});

	it('maps a missing broker executable to a bounded trust error without disclosing the helper path', () => {
		const failure = (() => {
			try {
				createTrustedWindowsJobHelperBrokerInternal(policy(), {
					platform: 'win32',
					systemRoot: String.raw`C:\Windows`,
					spawnBroker: () => {
						throw new Error('ENOENT C:\\Program Files\\Ever Works\\windows-job-launcher.exe');
					}
				});
			} catch (error) {
				return error;
			}
		})();

		expect(failure).toMatchObject({ code: 'WINDOWS_JOB_TRUST_BROKER_UNAVAILABLE' });
		expect(String(failure)).not.toContain('Program Files');
	});

	it('embeds the fail-closed handle, reparse, hash, Authenticode, and broker-lifecycle contract', () => {
		const source = WINDOWS_JOB_TRUST_BROKER_SOURCE_INTERNAL;
		for (const required of [
			'CreateFileW',
			'GetFinalPathNameByHandleW',
			'GetFileInformationByHandle',
			'FILE_FLAG_OPEN_REPARSE_POINT',
			'FILE_ATTRIBUTE_REPARSE_POINT',
			'FILE_SHARE_READ = 0x00000001',
			'SHA256',
			'Get-AuthenticodeSignature',
			"Status -ne 'Valid'",
			'SignerCertificate.Subject',
			'SignerCertificate.GetCertHashString',
			'EnvironmentVariables.Clear',
			'CopyToAsync',
			'Kill()',
			'WaitForExit'
		]) {
			expect(source).toContain(required);
		}
		expect(source).not.toContain('FILE_SHARE_WRITE');
		expect(source).not.toContain('FILE_SHARE_DELETE');
		expect(source).not.toContain('Invoke-Expression');
		expect(source).not.toContain('-ExecutionPolicy');
		expect(source).not.toContain('Start-Process');
		expect(source).not.toContain('Get-FileHash');
	});
});

class FakeBroker extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn(() => true);
}
