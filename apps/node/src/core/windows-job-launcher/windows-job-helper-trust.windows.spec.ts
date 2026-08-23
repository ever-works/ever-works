import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTrustedWindowsJobHelperBrokerInternal } from './windows-job-helper-trust.internal';
import { launchWindowsJobInternal, type WindowsJobHelperProcessInternal } from './windows-job-launcher.internal';

const systemRoot = process.env.SystemRoot;
const unsignedHelperPath = join(
	__dirname,
	'../../../native/windows-job-launcher/target/debug/ever-works-windows-job-launcher.exe'
);
const signedHelperPath = process.env.EVER_WORKS_TEST_SIGNED_HELPER_PATH;
const signedHelperSha256 = process.env.EVER_WORKS_TEST_SIGNED_HELPER_SHA256;
const signedPublisherSubject = process.env.EVER_WORKS_TEST_SIGNED_PUBLISHER_SUBJECT;
const signedPublisherCertificateSha256 = process.env.EVER_WORKS_TEST_SIGNED_PUBLISHER_CERTIFICATE_SHA256;
const hasSignedFixture =
	process.platform === 'win32' &&
	typeof systemRoot === 'string' &&
	[signedHelperPath, signedHelperSha256, signedPublisherSubject, signedPublisherCertificateSha256].every(
		(value) => typeof value === 'string' && value.length > 0
	);

describe.skipIf(process.platform !== 'win32')('Windows Job helper broker fail-closed integration', () => {
	it('refuses the reproducible developer helper because it has no valid Authenticode signature', async () => {
		const unsignedHash = await sha256(unsignedHelperPath);
		const failure = await launchWindowsJobInternal({
			helperPath: unsignedHelperPath,
			helperTrust: {
				expectedSha256: unsignedHash,
				publisherSubject: 'CN=Unsigned test fixture',
				publisherCertificateSha256: '0'.repeat(64)
			},
			...modelRequest()
		}).catch((error: unknown) => error);
		expect(failure).toMatchObject({
			code: expect.stringMatching(/^WINDOWS_JOB_(?:HELPER_EXITED|LAUNCH_TIMEOUT)$/)
		});
	}, 40_000);
});

describe.skipIf(!hasSignedFixture)('signed Windows Job helper broker integration', () => {
	const signedPins = () => ({
		expectedSha256: signedHelperSha256!,
		publisherSubject: signedPublisherSubject!,
		publisherCertificateSha256: signedPublisherCertificateSha256!
	});

	it('launches only the signed pinned helper and holds its no-write/no-delete lease through Job completion', async () => {
		const run = await launchWindowsJobInternal({
			helperPath: signedHelperPath!,
			helperTrust: signedPins(),
			...modelRequest({
				applicationPath: join(systemRoot!, 'System32', 'ping.exe'),
				arguments: ['-n', '3', '127.0.0.1'],
				timeoutMs: 10_000
			})
		});
		run.stdout.resume();
		run.stderr.resume();
		run.stdin.end();

		await expect(open(signedHelperPath!, 'r+')).rejects.toBeDefined();
		const completion = await run.completion;
		expect(completion).toMatchObject({
			status: 'exited',
			terminationVerified: true,
			activeProcesses: 0,
			processIds: []
		});
	}, 45_000);

	it.each([
		['hash mismatch', { expectedSha256: '0'.repeat(64) }],
		['publisher mismatch', { publisherSubject: 'CN=Different Publisher' }],
		['leaf certificate mismatch', { publisherCertificateSha256: 'F'.repeat(64) }]
	])(
		'fails closed on %s',
		async (_name, override) => {
			await expect(
				launchWindowsJobInternal({
					helperPath: signedHelperPath!,
					helperTrust: { ...signedPins(), ...override },
					...modelRequest()
				})
			).rejects.toMatchObject({ code: 'WINDOWS_JOB_HELPER_EXITED' });
		},
		45_000
	);

	it('fails closed when the configured helper is missing', async () => {
		const missingPath = join(dirname(signedHelperPath!), 'missing-windows-job-launcher.exe');
		await expect(
			launchWindowsJobInternal({
				helperPath: missingPath,
				helperTrust: {
					expectedSha256: signedHelperSha256!,
					publisherSubject: signedPublisherSubject!,
					publisherCertificateSha256: signedPublisherCertificateSha256!
				},
				...modelRequest()
			})
		).rejects.toMatchObject({ code: 'WINDOWS_JOB_HELPER_EXITED' });
	}, 45_000);

	it('broker death closes native control EOF and the Job removes the model process', async () => {
		let broker: WindowsJobHelperProcessInternal | undefined;
		const run = await launchWindowsJobInternal(
			{
				helperPath: signedHelperPath!,
				helperTrust: signedPins(),
				...modelRequest({
					applicationPath: join(systemRoot!, 'System32', 'ping.exe'),
					arguments: ['-n', '30', '127.0.0.1'],
					timeoutMs: 60_000
				})
			},
			{
				platform: 'win32',
				outputHighWaterMark: 16 * 1024,
				spawnTrustedHelper: (policy) => {
					broker = createTrustedWindowsJobHelperBrokerInternal(policy) as WindowsJobHelperProcessInternal;
					return broker;
				}
			}
		);
		run.stdout.resume();
		run.stderr.resume();
		expect(broker).toBeDefined();

		broker!.kill();

		await expect(run.completion).rejects.toMatchObject({ code: 'WINDOWS_JOB_HELPER_EXITED' });
		await vi.waitFor(
			() => {
				expect(() => process.kill(run.rootPid, 0)).toThrow();
			},
			{ timeout: 10_000, interval: 100 }
		);
	}, 45_000);
});

function modelRequest(
	overrides: Partial<{
		applicationPath: string;
		workingDirectory: string;
		arguments: string[];
		environment: Record<string, string>;
		timeoutMs: number;
		cleanupTimeoutMs: number;
		maxOutputBytes: number;
	}> = {}
) {
	return {
		applicationPath: join(systemRoot!, 'System32', 'whoami.exe'),
		workingDirectory: join(systemRoot!, 'System32'),
		arguments: [],
		environment: {},
		timeoutMs: 10_000,
		cleanupTimeoutMs: 1000,
		maxOutputBytes: 1024 * 1024,
		helperStartupTimeoutMs: 30_000,
		...overrides
	};
}

async function sha256(path: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
}
