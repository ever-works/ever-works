import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import type { WindowsJobCompletion } from './protocol.internal';
import type { WindowsJobRunInternal } from './windows-job-launcher.internal';
import {
	WindowsJobContainmentUnavailableError,
	createWindowsJobModelProcessContainmentInternal
} from './windows-job-model-containment.internal';

const trust = {
	helperPath: String.raw`C:\Program Files\Ever Works\windows-job-launcher.exe`,
	expectedSha256: 'A'.repeat(64),
	publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
	publisherCertificateSha256: 'B'.repeat(64)
} as const;

const spawnOptions: SpawnOptions = {
	cwd: String.raw`C:\task\workspace`,
	env: { HOME: String.raw`C:\isolated\home`, CODEX_HOME: String.raw`C:\isolated\codex` },
	stdio: ['pipe', 'pipe', 'pipe'],
	shell: false,
	windowsHide: true,
	detached: false
};

describe('model-process Windows Job containment', () => {
	it('launches the exact managed executable through the trusted helper policy and sterile broker', async () => {
		const run = fakeRun(711);
		const launchWindowsJob = vi.fn(async () => run);
		const containment = createWindowsJobModelProcessContainmentInternal(trust, { launchWindowsJob });
		const controller = new AbortController();

		const child = await containment.spawn(
			String.raw`C:\Program Files\Codex\codex.exe`,
			['exec', '--json', '-'],
			spawnOptions,
			controller.signal
		);

		expect(child.pid).toBe(711);
		expect(child.stdin).toBe(run.stdin);
		expect(child.stdout).toBe(run.stdout);
		expect(child.stderr).toBe(run.stderr);
		expect(launchWindowsJob).toHaveBeenCalledWith({
			helperPath: trust.helperPath,
			helperTrust: {
				expectedSha256: trust.expectedSha256,
				publisherSubject: trust.publisherSubject,
				publisherCertificateSha256: trust.publisherCertificateSha256
			},
			applicationPath: String.raw`C:\Program Files\Codex\codex.exe`,
			workingDirectory: String.raw`C:\task\workspace`,
			arguments: ['exec', '--json', '-'],
			environment: {
				HOME: String.raw`C:\isolated\home`,
				CODEX_HOME: String.raw`C:\isolated\codex`
			},
			timeoutMs: 30 * 60 * 1000,
			cleanupTimeoutMs: 1000,
			maxOutputBytes: 1024 * 1024,
			helperStartupTimeoutMs: 10_000,
			signal: controller.signal
		});
	});

	it('maps verified completion to Node child exit/close and preserves DWORD exit codes', async () => {
		const run = fakeRun(712);
		const containment = createWindowsJobModelProcessContainmentInternal(trust, {
			launchWindowsJob: async () => run
		});
		const child = await containment.spawn(String.raw`C:\trusted\codex.exe`, [], spawnOptions);
		const exits: unknown[][] = [];
		child.on('exit', (...arguments_) => exits.push(['exit', ...arguments_]));
		child.on('close', (...arguments_) => exits.push(['close', ...arguments_]));

		run.complete(verified({ rootPid: 712, exitCode: 0xffff_fffe }));
		await run.completion;
		await new Promise((resolve) => setImmediate(resolve));

		expect(exits).toEqual([
			['exit', 0xffff_fffe, null],
			['close', 0xffff_fffe, null]
		]);
		await expect(containment.close()).resolves.toEqual({ verified: true });
	});

	it('cancels through the helper and reports cleanup as unverified unless the Job is proven empty', async () => {
		const run = fakeRun(713);
		const containment = createWindowsJobModelProcessContainmentInternal(trust, {
			launchWindowsJob: async () => run
		});
		const child = await containment.spawn(String.raw`C:\trusted\codex.exe`, [], spawnOptions);

		expect(child.kill()).toBe(true);
		expect(run.cancel).toHaveBeenCalledOnce();
		run.complete(
			verified({
				status: 'termination-unverified',
				rootPid: 713,
				terminationVerified: false,
				activeProcesses: 1,
				processIds: [999],
				exitCode: undefined
			})
		);

		await expect(containment.close()).resolves.toEqual({
			verified: false,
			detail: 'The Windows Job helper did not prove an empty Job'
		});
	});

	it('fails closed on helper trust/startup failure without exposing configured paths or pins', async () => {
		const containment = createWindowsJobModelProcessContainmentInternal(trust, {
			launchWindowsJob: async () => {
				throw new Error(`missing ${trust.helperPath} ${trust.expectedSha256}`);
			}
		});

		const failure = await Promise.resolve(
			containment.spawn(String.raw`C:\trusted\codex.exe`, [], spawnOptions)
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(WindowsJobContainmentUnavailableError);
		expect(String(failure)).not.toContain('Program Files');
		expect(String(failure)).not.toContain(trust.expectedSha256);
		await expect(containment.close()).resolves.toEqual({ verified: true });
	});

	it.each([
		['missing cwd', { ...spawnOptions, cwd: undefined }],
		['URL cwd', { ...spawnOptions, cwd: new URL('file:///C:/task') }],
		['missing environment', { ...spawnOptions, env: undefined }],
		['undefined environment value', { ...spawnOptions, env: { HOME: undefined } }]
	])('rejects %s without invoking the native launcher', async (_name, options) => {
		const launchWindowsJob = vi.fn();
		const containment = createWindowsJobModelProcessContainmentInternal(trust, { launchWindowsJob });
		await expect(
			containment.spawn(String.raw`C:\trusted\codex.exe`, [], options as SpawnOptions)
		).rejects.toBeInstanceOf(WindowsJobContainmentUnavailableError);
		expect(launchWindowsJob).not.toHaveBeenCalled();
	});

	it('refuses containment reuse so probe and model always receive independent Jobs and trust checks', async () => {
		const run = fakeRun(714);
		const launchWindowsJob = vi.fn(async () => run);
		const containment = createWindowsJobModelProcessContainmentInternal(trust, { launchWindowsJob });
		await containment.spawn(String.raw`C:\trusted\codex.exe`, [], spawnOptions);

		await expect(containment.spawn(String.raw`C:\trusted\codex.exe`, [], spawnOptions)).rejects.toBeInstanceOf(
			WindowsJobContainmentUnavailableError
		);
		expect(launchWindowsJob).toHaveBeenCalledOnce();
	});
});

function fakeRun(rootPid: number): WindowsJobRunInternal & { complete(value: WindowsJobCompletion): void } {
	let resolveCompletion!: (value: WindowsJobCompletion) => void;
	const completion = new Promise<WindowsJobCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const cancel = vi.fn(() => completion);
	return {
		rootPid,
		stdin,
		stdout,
		stderr,
		completion,
		cancel,
		complete(value) {
			stdout.end();
			stderr.end();
			resolveCompletion(value);
		}
	};
}

function verified(overrides: Partial<WindowsJobCompletion> = {}): WindowsJobCompletion {
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
