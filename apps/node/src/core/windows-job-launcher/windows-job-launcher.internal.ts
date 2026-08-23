import { spawn, type SpawnOptions } from 'node:child_process';
import { win32 as windowsPath } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { EventEmitter } from 'node:events';
import {
	ServerMessageKind,
	ServerProtocolDecoder,
	encodeCancelFrame,
	encodeCloseStdinFrame,
	encodeLaunchFrame,
	encodeStdinFrame,
	type WindowsJobCompletion,
	type WindowsJobFailureStage,
	type WindowsJobLaunchRequest
} from './protocol.internal';

export interface WindowsJobHelperProcessInternal extends EventEmitter {
	stdin: Writable;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WindowsJobLauncherDependenciesInternal {
	platform: NodeJS.Platform;
	spawnHelper: (helperPath: string, arguments_: string[], options: SpawnOptions) => WindowsJobHelperProcessInternal;
	outputHighWaterMark: number;
}

export interface WindowsJobLaunchInternalRequest extends WindowsJobLaunchRequest {
	helperPath: string;
}

export interface WindowsJobRunInternal {
	rootPid: number;
	stdin: Writable;
	stdout: PassThrough;
	stderr: PassThrough;
	completion: Promise<WindowsJobCompletion>;
	cancel(): Promise<WindowsJobCompletion>;
}

export type WindowsJobLauncherErrorCode =
	| 'WINDOWS_JOB_UNSUPPORTED_PLATFORM'
	| 'WINDOWS_JOB_INVALID_REQUEST'
	| 'WINDOWS_JOB_SPAWN_FAILED'
	| 'WINDOWS_JOB_LAUNCH_TIMEOUT'
	| 'WINDOWS_JOB_LAUNCH_FAILED'
	| 'WINDOWS_JOB_PROTOCOL_ERROR'
	| 'WINDOWS_JOB_HELPER_EXITED'
	| 'WINDOWS_JOB_CONTROL_FAILED'
	| 'WINDOWS_JOB_UNVERIFIED'
	| 'WINDOWS_JOB_OUTPUT_LIMIT'
	| 'WINDOWS_JOB_OUTPUT_BACKPRESSURE'
	| 'WINDOWS_JOB_CANCEL_TIMEOUT';

export class WindowsJobLauncherError extends Error {
	constructor(
		readonly code: WindowsJobLauncherErrorCode,
		readonly failureStage?: WindowsJobFailureStage,
		readonly osError?: number
	) {
		super(`Windows Job launcher failed (${code})`);
		this.name = 'WindowsJobLauncherError';
	}
}

const defaultDependencies: WindowsJobLauncherDependenciesInternal = {
	platform: process.platform,
	spawnHelper: (helperPath, arguments_, options) =>
		spawn(helperPath, arguments_, options) as WindowsJobHelperProcessInternal,
	outputHighWaterMark: 16 * 1024
};

export async function launchWindowsJobInternal(
	request: WindowsJobLaunchInternalRequest,
	dependencyOverrides: Partial<WindowsJobLauncherDependenciesInternal> = {}
): Promise<WindowsJobRunInternal> {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	validateTrustedRequest(request, dependencies.platform);

	let launchFrame: Buffer;
	try {
		launchFrame = encodeLaunchFrame(request);
	} catch {
		throw new WindowsJobLauncherError('WINDOWS_JOB_INVALID_REQUEST');
	}

	let helper: WindowsJobHelperProcessInternal;
	try {
		helper = dependencies.spawnHelper(request.helperPath, [], {
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: true,
			env: {},
			stdio: ['pipe', 'pipe', 'pipe']
		});
	} catch {
		throw new WindowsJobLauncherError('WINDOWS_JOB_SPAWN_FAILED');
	}

	const stdout = new PassThrough({ highWaterMark: dependencies.outputHighWaterMark });
	const stderr = new PassThrough({ highWaterMark: dependencies.outputHighWaterMark });
	const decoder = new ServerProtocolDecoder();
	let rootPid: number | undefined;
	let settled = false;
	let cancelSent = false;
	let receivedOutputBytes = 0;
	let cancelTimer: NodeJS.Timeout | undefined;
	let forcedKillTimer: NodeJS.Timeout | undefined;

	let resolveLaunch!: (rootPid: number) => void;
	let rejectLaunch!: (error: WindowsJobLauncherError) => void;
	const launched = new Promise<number>((resolve, reject) => {
		resolveLaunch = resolve;
		rejectLaunch = reject;
	});
	let resolveCompletion!: (completion: WindowsJobCompletion) => void;
	let rejectCompletion!: (error: WindowsJobLauncherError) => void;
	const completion = new Promise<WindowsJobCompletion>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});
	void completion.catch(() => undefined);

	const clearTimers = (): void => {
		if (cancelTimer !== undefined) clearTimeout(cancelTimer);
		if (forcedKillTimer !== undefined) clearTimeout(forcedKillTimer);
	};

	const scheduleForcedKill = (): void => {
		if (forcedKillTimer !== undefined) return;
		forcedKillTimer = setTimeout(() => {
			try {
				helper.kill();
			} catch {
				// The helper may already have closed its exclusive Job handle.
			}
		}, request.cleanupTimeoutMs);
	};

	const sendCancelAndCloseControl = (): void => {
		if (!cancelSent) {
			cancelSent = true;
			try {
				helper.stdin.write(encodeCancelFrame());
			} catch {
				// Closing the control pipe is the fail-closed fallback.
			}
		}
		try {
			helper.stdin.end();
		} catch {
			// The helper may already have observed EOF.
		}
		scheduleForcedKill();
	};

	const fail = (
		code: WindowsJobLauncherErrorCode,
		failureStage?: WindowsJobFailureStage,
		osError?: number,
		terminateHelper = true
	): void => {
		if (settled) return;
		settled = true;
		if (cancelTimer !== undefined) clearTimeout(cancelTimer);
		const error = new WindowsJobLauncherError(code, failureStage, osError);
		stdout.end();
		stderr.end();
		if (rootPid === undefined) rejectLaunch(error);
		rejectCompletion(error);
		if (terminateHelper) sendCancelAndCloseControl();
	};

	const writeControl = (frame: Buffer, callback: (error?: Error | null) => void): void => {
		if (settled) {
			callback(new WindowsJobLauncherError('WINDOWS_JOB_CONTROL_FAILED'));
			return;
		}
		try {
			helper.stdin.write(frame, callback);
		} catch {
			const error = new WindowsJobLauncherError('WINDOWS_JOB_CONTROL_FAILED');
			callback(error);
			fail(error.code);
		}
	};

	const beginCancellation = (): void => {
		if (settled || cancelSent) return;
		cancelSent = true;
		try {
			helper.stdin.write(encodeCancelFrame(), (error?: Error | null) => {
				if (error) fail('WINDOWS_JOB_CONTROL_FAILED');
			});
		} catch {
			fail('WINDOWS_JOB_CONTROL_FAILED');
			return;
		}
		cancelTimer = setTimeout(() => {
			fail('WINDOWS_JOB_CANCEL_TIMEOUT', undefined, undefined, false);
			try {
				helper.kill();
			} catch {
				// The control EOF or KILL_ON_JOB_CLOSE path may already have won the race.
			}
		}, request.cleanupTimeoutMs);
	};

	let childStdinClosed = false;
	const childStdin = new Writable({
		write(chunk: Buffer | string, encoding, callback) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
			let frame: Buffer;
			try {
				frame = encodeStdinFrame(bytes);
			} catch {
				callback(new WindowsJobLauncherError('WINDOWS_JOB_INVALID_REQUEST'));
				return;
			}
			writeControl(frame, callback);
		},
		final(callback) {
			childStdinClosed = true;
			writeControl(encodeCloseStdinFrame(), callback);
		},
		destroy(error, callback) {
			if (!childStdinClosed && !settled) {
				beginCancellation();
			}
			callback(error);
		}
	});

	const finish = (value: WindowsJobCompletion): void => {
		if (settled) return;
		if (
			rootPid === undefined ||
			value.rootPid !== rootPid ||
			!value.terminationVerified ||
			value.activeProcesses !== 0 ||
			value.processIds.length !== 0 ||
			value.status === 'termination-unverified'
		) {
			fail('WINDOWS_JOB_UNVERIFIED', value.failureStage, value.osError);
			return;
		}
		settled = true;
		clearTimers();
		stdout.end();
		stderr.end();
		resolveCompletion(value);
		try {
			helper.stdin.end();
		} catch {
			// A completed helper may have already exited.
		}
	};

	helper.stderr.on('data', () => {
		// Native diagnostics are intentionally discarded: only bounded numeric protocol fields are trusted.
	});
	helper.stdout.on('data', (chunk: Buffer | string) => {
		if (settled) return;
		let messages;
		try {
			messages = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		} catch (error) {
			fail('WINDOWS_JOB_PROTOCOL_ERROR');
			return;
		}
		for (const message of messages) {
			if (settled) break;
			switch (message.kind) {
				case ServerMessageKind.Launched:
					if (rootPid !== undefined || message.rootPid === 0) {
						fail('WINDOWS_JOB_PROTOCOL_ERROR');
						break;
					}
					rootPid = message.rootPid;
					resolveLaunch(rootPid);
					break;
				case ServerMessageKind.Stdout:
				case ServerMessageKind.Stderr: {
					if (rootPid === undefined) {
						fail('WINDOWS_JOB_PROTOCOL_ERROR');
						break;
					}
					receivedOutputBytes += message.bytes.length;
					if (receivedOutputBytes > request.maxOutputBytes) {
						fail('WINDOWS_JOB_OUTPUT_LIMIT');
						break;
					}
					const destination = message.kind === ServerMessageKind.Stdout ? stdout : stderr;
					if (!destination.write(message.bytes)) {
						fail('WINDOWS_JOB_OUTPUT_BACKPRESSURE');
					}
					break;
				}
				case ServerMessageKind.Completed:
					if (rootPid === undefined) {
						if (message.completion.status === 'launch-failed') {
							fail(
								'WINDOWS_JOB_LAUNCH_FAILED',
								message.completion.failureStage,
								message.completion.osError
							);
						} else {
							fail('WINDOWS_JOB_PROTOCOL_ERROR');
						}
						break;
					}
					finish(message.completion);
					break;
			}
		}
	});
	helper.stdout.on('end', () => {
		if (!settled) {
			fail(decoder.hasPendingBytes ? 'WINDOWS_JOB_PROTOCOL_ERROR' : 'WINDOWS_JOB_HELPER_EXITED');
		}
	});
	helper.stdin.on('error', () => fail('WINDOWS_JOB_CONTROL_FAILED'));
	helper.once('error', () => fail('WINDOWS_JOB_SPAWN_FAILED', undefined, undefined, false));
	helper.once('exit', () => {
		if (!settled) fail('WINDOWS_JOB_HELPER_EXITED', undefined, undefined, false);
	});

	const launchTimer = setTimeout(
		() => fail('WINDOWS_JOB_LAUNCH_TIMEOUT'),
		Math.min(request.cleanupTimeoutMs, 30_000)
	);
	void launched.finally(() => clearTimeout(launchTimer)).catch(() => undefined);

	try {
		helper.stdin.write(launchFrame, (error?: Error | null) => {
			if (error) fail('WINDOWS_JOB_CONTROL_FAILED');
		});
	} catch {
		fail('WINDOWS_JOB_CONTROL_FAILED');
	}

	const launchedRootPid = await launched;
	const cancel = (): Promise<WindowsJobCompletion> => {
		beginCancellation();
		return completion;
	};

	return {
		rootPid: launchedRootPid,
		stdin: childStdin,
		stdout,
		stderr,
		completion,
		cancel
	};
}

function validateTrustedRequest(request: WindowsJobLaunchInternalRequest, platform: NodeJS.Platform): void {
	if (platform !== 'win32') {
		throw new WindowsJobLauncherError('WINDOWS_JOB_UNSUPPORTED_PLATFORM');
	}
	const applicationExtension = windowsPath.extname(request.applicationPath).toLowerCase();
	if (
		!windowsPath.isAbsolute(request.helperPath) ||
		windowsPath.extname(request.helperPath).toLowerCase() !== '.exe' ||
		!windowsPath.isAbsolute(request.applicationPath) ||
		applicationExtension !== '.exe' ||
		!windowsPath.isAbsolute(request.workingDirectory) ||
		request.helperPath.includes('\0') ||
		request.applicationPath.includes('\0') ||
		request.workingDirectory.includes('\0')
	) {
		throw new WindowsJobLauncherError('WINDOWS_JOB_INVALID_REQUEST');
	}
}
