import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import {
	WindowsJobLauncherError,
	launchWindowsJobInternal,
	type WindowsJobHelperProcessInternal,
	type WindowsJobLauncherDependenciesInternal
} from './windows-job-launcher.internal';
import type { WindowsJobHelperTrustPolicyInternal } from './windows-job-helper-trust.internal';
import {
	ClientMessageKind,
	ProtocolDecoder,
	ServerMessageKind,
	type DecodedClientMessage,
	type WindowsJobCompletion,
	type WindowsJobLaunchRequest
} from './protocol.internal';

const request = (overrides: Partial<WindowsJobLaunchRequest> = {}): WindowsJobLaunchRequest => ({
	applicationPath: String.raw`C:\trusted\runner.exe`,
	workingDirectory: String.raw`C:\trusted\work`,
	arguments: ['two words', 'prompt fixture only'],
	environment: { FAKE_TOKEN: 'fixture-secret-marker' },
	timeoutMs: 30_000,
	cleanupTimeoutMs: 100,
	maxOutputBytes: 1_048_576,
	...overrides
});

const helperTrust = (): Omit<WindowsJobHelperTrustPolicyInternal, 'helperPath'> => ({
	expectedSha256: 'A'.repeat(64),
	publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
	publisherCertificateSha256: 'B'.repeat(64)
});

describe('internal Windows Job launcher adapter', () => {
	it('uses the trusted broker by default and passes all immutable trust pins', async () => {
		const fake = new FakeHelper();
		const spawnTrustedHelper = vi.fn(() => fake);
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) fake.send(launched(4141));
		};

		const run = await launchWindowsJobInternal(
			{
				helperPath: String.raw`C:\trusted\native\windows-job-launcher.exe`,
				helperTrust: helperTrust(),
				...request()
			},
			{ platform: 'win32', spawnTrustedHelper, outputHighWaterMark: 16 * 1024 }
		);

		expect(run.rootPid).toBe(4141);
		expect(spawnTrustedHelper).toHaveBeenCalledWith({
			helperPath: String.raw`C:\trusted\native\windows-job-launcher.exe`,
			...helperTrust()
		});
	});

	it('fails closed before production broker startup when a trust pin is missing', async () => {
		const spawnTrustedHelper = vi.fn();
		await expect(
			launchWindowsJobInternal(
				{ helperPath: String.raw`C:\trusted\native\windows-job-launcher.exe`, ...request() },
				{ platform: 'win32', spawnTrustedHelper, outputHighWaterMark: 16 * 1024 }
			)
		).rejects.toMatchObject({ code: 'WINDOWS_JOB_INVALID_REQUEST' });
		expect(spawnTrustedHelper).not.toHaveBeenCalled();
	});

	it('uses only explicit absolute executables, a scrubbed helper environment, and shell-free stdio pipes', async () => {
		const fake = new FakeHelper();
		const spawnHelper = vi.fn(() => fake);
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(4242));
			}
		};

		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\native\windows-job-launcher.exe`, ...request() },
			dependencies(spawnHelper)
		);

		expect(run.rootPid).toBe(4242);
		expect(spawnHelper).toHaveBeenCalledWith(
			String.raw`C:\trusted\native\windows-job-launcher.exe`,
			[],
			expect.objectContaining({
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: true,
				env: {},
				stdio: ['pipe', 'pipe', 'pipe']
			})
		);
		const launch = fake.messages[0];
		expect(launch).toEqual({ kind: ClientMessageKind.Launch, request: request() });
	});

	it('multiplexes stdin/stdout/stderr and resolves only a verified empty-job completion', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(91));
			}
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);
		const stdout = collect(run.stdout);
		const stderr = collect(run.stderr);

		run.stdin.write(Buffer.from('input-λ'));
		run.stdin.end();
		await finished(run.stdin);
		expect(fake.messages.slice(1)).toEqual([
			{ kind: ClientMessageKind.Stdin, bytes: Buffer.from('input-λ') },
			{ kind: ClientMessageKind.CloseStdin }
		]);

		fake.send(output(ServerMessageKind.Stdout, Buffer.from('out-λ')));
		fake.send(output(ServerMessageKind.Stderr, Buffer.from('err-งาน')));
		fake.send(completed(verifiedCompletion({ rootPid: 91, exitCode: 7 })));

		await expect(run.completion).resolves.toEqual(verifiedCompletion({ rootPid: 91, exitCode: 7 }));
		expect(await stdout).toEqual(Buffer.from('out-λ'));
		expect(await stderr).toEqual(Buffer.from('err-งาน'));
	});

	it.each([
		['relative helper', { helperPath: 'helper.exe' }],
		['UNC helper', { helperPath: String.raw`\\server\share\helper.exe` }],
		['device helper', { helperPath: String.raw`\\?\C:\trusted\helper.exe` }],
		['traversing helper', { helperPath: String.raw`C:\trusted\..\helper.exe` }],
		['PATH application', { applicationPath: 'runner.exe' }],
		['relative cwd', { workingDirectory: 'work' }],
		['cmd shim', { applicationPath: String.raw`C:\trusted\runner.cmd` }],
		['bat shim', { applicationPath: String.raw`C:\trusted\runner.bat` }]
	])('rejects %s before spawning', async (_name, override) => {
		const spawnHelper = vi.fn();
		await expect(
			launchWindowsJobInternal(
				{ helperPath: String.raw`C:\trusted\helper.exe`, ...request(), ...override },
				dependencies(spawnHelper)
			)
		).rejects.toMatchObject({ code: 'WINDOWS_JOB_INVALID_REQUEST' });
		expect(spawnHelper).not.toHaveBeenCalled();
	});

	it('rejects non-Windows hosts before spawning', async () => {
		const spawnHelper = vi.fn();
		await expect(
			launchWindowsJobInternal(
				{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
				dependencies(spawnHelper, { platform: 'linux' })
			)
		).rejects.toMatchObject({ code: 'WINDOWS_JOB_UNSUPPORTED_PLATFORM' });
		expect(spawnHelper).not.toHaveBeenCalled();
	});

	it('never echoes paths, arguments, environment values, or prompts in launch diagnostics', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(
					completed({
						status: 'launch-failed',
						rootPid: 0,
						terminationVerified: false,
						activeProcesses: 0,
						processIds: [],
						failureStage: 'assign-job',
						osError: 5
					})
				);
			}
		};

		const failure = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WindowsJobLauncherError);
		expect(failure).toMatchObject({
			code: 'WINDOWS_JOB_LAUNCH_FAILED',
			failureStage: 'assign-job',
			osError: 5
		});
		for (const sensitive of [
			'runner.exe',
			'two words',
			'prompt fixture only',
			'FAKE_TOKEN',
			'fixture-secret-marker'
		]) {
			expect(String(failure)).not.toContain(sensitive);
		}
	});

	it('cancels idempotently and returns the helper verified result', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(77));
			}
			if (message.kind === ClientMessageKind.Cancel) {
				fake.send(completed(verifiedCompletion({ status: 'cancelled', rootPid: 77 })));
			}
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);

		const [first, second] = await Promise.all([run.cancel(), run.cancel()]);
		expect(first).toEqual(second);
		expect(first.status).toBe('cancelled');
		expect(fake.messages.filter((message) => message.kind === ClientMessageKind.Cancel)).toHaveLength(1);
	});

	it('forwards cancellation during broker startup and closes control instead of orphaning a later helper', async () => {
		const fake = new FakeHelper();
		const controller = new AbortController();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Cancel) {
				fake.send(completed(verifiedCompletion({ status: 'cancelled', rootPid: 0, exitCode: undefined })));
			}
		};
		const launch = launchWindowsJobInternal(
			{
				helperPath: String.raw`C:\trusted\helper.exe`,
				...request(),
				signal: controller.signal
			},
			dependencies(() => fake)
		);
		await vi.waitFor(() =>
			expect(fake.messages.some((message) => message.kind === ClientMessageKind.Launch)).toBe(true)
		);

		controller.abort();

		await expect(launch).rejects.toMatchObject({ code: 'WINDOWS_JOB_PROTOCOL_ERROR' });
		expect(fake.messages.filter((message) => message.kind === ClientMessageKind.Cancel)).toHaveLength(1);
		expect(fake.stdin.writableEnded).toBe(true);
	});

	it.each([
		['output-limit', 'WINDOWS_JOB_OUTPUT_LIMIT'],
		['protocol-error', 'WINDOWS_JOB_PROTOCOL_ERROR']
	] as const)('rejects a verified helper %s completion instead of treating it as success', async (status, code) => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(78));
			}
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);

		fake.send(completed(verifiedCompletion({ status, rootPid: 78, exitCode: undefined })));

		await expect(run.completion).rejects.toMatchObject({ code });
	});

	it('rejects completion unless the root PID matches and both job counters prove empty', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(52));
			}
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);

		fake.send(completed(verifiedCompletion({ rootPid: 52, processIds: [999] })));
		await expect(run.completion).rejects.toMatchObject({ code: 'WINDOWS_JOB_UNVERIFIED' });
		expect(String(await run.completion.catch((error: unknown) => error))).not.toContain('fixture-secret-marker');
	});

	it('rejects a verified exited completion that omits the root DWORD exit code', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) {
				fake.send(launched(53));
			}
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);

		fake.send(completed(verifiedCompletion({ rootPid: 53, exitCode: undefined })));

		await expect(run.completion).rejects.toMatchObject({ code: 'WINDOWS_JOB_PROTOCOL_ERROR' });
	});

	it('fails closed when a helper violates the output cap or a consumer applies backpressure', async () => {
		for (const mode of ['limit', 'backpressure'] as const) {
			const fake = new FakeHelper();
			fake.onMessage = (message) => {
				if (message.kind === ClientMessageKind.Launch) {
					fake.send(launched(64));
				}
			};
			const run = await launchWindowsJobInternal(
				{
					helperPath: String.raw`C:\trusted\helper.exe`,
					...request({ maxOutputBytes: mode === 'limit' ? 4 : 1_048_576 })
				},
				dependencies(() => fake, { outputHighWaterMark: mode === 'backpressure' ? 1 : 16 * 1024 })
			);
			fake.send(output(ServerMessageKind.Stdout, Buffer.from(mode === 'limit' ? '12345' : 'xx')));

			await expect(run.completion).rejects.toMatchObject({
				code: mode === 'limit' ? 'WINDOWS_JOB_OUTPUT_LIMIT' : 'WINDOWS_JOB_OUTPUT_BACKPRESSURE'
			});
			expect(fake.messages.some((message) => message.kind === ClientMessageKind.Cancel)).toBe(true);
		}
	});

	it('kills a helper that ignores cancellation after the bounded cleanup timeout', async () => {
		for (const trigger of ['cancel', 'destroy-stdin'] as const) {
			const fake = new FakeHelper();
			fake.onMessage = (message) => {
				if (message.kind === ClientMessageKind.Launch) {
					fake.send(launched(88));
				}
			};
			const run = await launchWindowsJobInternal(
				{ helperPath: String.raw`C:\trusted\helper.exe`, ...request({ cleanupTimeoutMs: 20 }) },
				dependencies(() => fake)
			);

			let result: Promise<WindowsJobCompletion>;
			if (trigger === 'cancel') {
				result = run.cancel();
			} else {
				run.stdin.destroy();
				result = run.completion;
			}
			await expect(result).rejects.toMatchObject({ code: 'WINDOWS_JOB_CANCEL_TIMEOUT' });
			expect(fake.kill).toHaveBeenCalledTimes(1);
		}
	});

	it('rejects helper exit and malformed protocol without trusting helper diagnostics', async () => {
		for (const mode of ['exit', 'malformed'] as const) {
			const fake = new FakeHelper();
			fake.onMessage = (message) => {
				if (message.kind !== ClientMessageKind.Launch) return;
				if (mode === 'exit') fake.exit(23);
				else fake.stdout.write(Buffer.from('not-a-frame!'));
			};
			await expect(
				launchWindowsJobInternal(
					{ helperPath: String.raw`C:\trusted\helper.exe`, ...request({ cleanupTimeoutMs: 20 }) },
					dependencies(() => fake)
				)
			).rejects.toMatchObject({
				code: mode === 'exit' ? 'WINDOWS_JOB_HELPER_EXITED' : 'WINDOWS_JOB_PROTOCOL_ERROR'
			});
		}
	});

	it('treats broker death after launch as unverified and closes the model streams', async () => {
		const fake = new FakeHelper();
		fake.onMessage = (message) => {
			if (message.kind === ClientMessageKind.Launch) fake.send(launched(909));
		};
		const run = await launchWindowsJobInternal(
			{ helperPath: String.raw`C:\trusted\helper.exe`, ...request() },
			dependencies(() => fake)
		);
		const stdoutFinished = finished(run.stdout);
		const stderrFinished = finished(run.stderr);
		run.stdout.resume();
		run.stderr.resume();

		fake.exit(23);

		await expect(run.completion).rejects.toMatchObject({ code: 'WINDOWS_JOB_HELPER_EXITED' });
		await expect(stdoutFinished).resolves.toBeUndefined();
		await expect(stderrFinished).resolves.toBeUndefined();
	});
});

class FakeHelper extends EventEmitter implements WindowsJobHelperProcessInternal {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly messages: DecodedClientMessage[] = [];
	readonly kill = vi.fn(() => {
		this.exit(1);
		return true;
	});
	onMessage?: (message: DecodedClientMessage) => void;
	private readonly decoder = new ProtocolDecoder();

	constructor() {
		super();
		this.stdin.on('data', (chunk: Buffer) => {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				this.onMessage?.(message);
			}
		});
	}

	send(frame: Buffer): void {
		this.stdout.write(frame);
	}

	exit(code: number): void {
		this.emit('exit', code, null);
		this.emit('close', code, null);
	}
}

function dependencies(
	spawnHelper: NonNullable<WindowsJobLauncherDependenciesInternal['spawnHelper']>,
	overrides: Partial<WindowsJobLauncherDependenciesInternal> = {}
): WindowsJobLauncherDependenciesInternal {
	return {
		platform: 'win32',
		spawnHelper,
		spawnTrustedHelper: () => {
			throw new Error('unexpected trusted helper spawn in a direct-helper test');
		},
		outputHighWaterMark: 16 * 1024,
		...overrides
	};
}

function launched(rootPid: number): Buffer {
	const payload = Buffer.alloc(4);
	payload.writeUInt32LE(rootPid);
	return serverFrame(ServerMessageKind.Launched, payload);
}

function output(kind: ServerMessageKind.Stdout | ServerMessageKind.Stderr, bytes: Buffer): Buffer {
	return serverFrame(kind, bytes);
}

function completed(completion: WindowsJobCompletion): Buffer {
	const payload = Buffer.alloc(25 + completion.processIds.length * 4);
	payload.writeUInt8(
		[
			'exited',
			'cancelled',
			'timed-out',
			'output-limit',
			'launch-failed',
			'protocol-error',
			'termination-unverified'
		].indexOf(completion.status),
		0
	);
	payload.writeUInt8(completion.exitCode === undefined ? 0 : 1, 1);
	payload.writeUInt32LE(completion.exitCode ?? 0, 2);
	payload.writeUInt32LE(completion.rootPid, 6);
	payload.writeUInt8(completion.terminationVerified ? 1 : 0, 10);
	payload.writeUInt32LE(completion.activeProcesses, 11);
	payload.writeUInt32LE(completion.processIds.length, 15);
	completion.processIds.forEach((processId, index) => payload.writeUInt32LE(processId, 19 + index * 4));
	payload.writeUInt16LE(
		[
			'none',
			'create-job',
			'set-limits',
			'create-pipes',
			'create-process',
			'assign-job',
			'verify-membership',
			'resume',
			'runtime',
			'cleanup',
			'protocol'
		].indexOf(completion.failureStage),
		19 + completion.processIds.length * 4
	);
	payload.writeUInt32LE(completion.osError, 21 + completion.processIds.length * 4);
	return serverFrame(ServerMessageKind.Completed, payload);
}

function verifiedCompletion(overrides: Partial<WindowsJobCompletion> = {}): WindowsJobCompletion {
	return {
		status: 'exited',
		exitCode: 0,
		rootPid: 1,
		terminationVerified: true,
		activeProcesses: 0,
		processIds: [],
		failureStage: 'none',
		osError: 0,
		...overrides
	};
}

function serverFrame(kind: ServerMessageKind, payload: Buffer): Buffer {
	const header = Buffer.alloc(12);
	header.write('EWJL', 0, 'ascii');
	header.writeUInt16LE(2, 4);
	header.writeUInt16LE(kind, 6);
	header.writeUInt32LE(payload.length, 8);
	return Buffer.concat([header, payload]);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
