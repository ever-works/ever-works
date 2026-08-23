import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { ModelProcessContainment, ProcessTreeTermination } from '../model-execution/model-process.internal';
import {
	MODEL_EXECUTION_MAX_TIMEOUT_MS,
	MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
	ModelProcessContainmentUnavailableError
} from '../model-execution/model-process.internal';
import type { WindowsJobHelperTrustPolicyInternal } from './windows-job-helper-trust.internal';
import {
	launchWindowsJobInternal,
	type WindowsJobLaunchInternalRequest,
	type WindowsJobRunInternal
} from './windows-job-launcher.internal';

export interface WindowsJobModelContainmentDependenciesInternal {
	readonly launchWindowsJob: (request: WindowsJobLaunchInternalRequest) => Promise<WindowsJobRunInternal>;
}

export class WindowsJobContainmentUnavailableError extends ModelProcessContainmentUnavailableError {
	constructor() {
		super();
		this.name = 'WindowsJobContainmentUnavailableError';
	}
}

const WINDOWS_JOB_CLEANUP_TIMEOUT_MS = 1000;

const defaultDependencies: WindowsJobModelContainmentDependenciesInternal = {
	launchWindowsJob: (request) => launchWindowsJobInternal(request)
};

/** One containment object owns exactly one native Job launch. */
export function createWindowsJobModelProcessContainmentInternal(
	policy: WindowsJobHelperTrustPolicyInternal,
	dependencyOverrides: Partial<WindowsJobModelContainmentDependenciesInternal> = {}
): ModelProcessContainment {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	let run: WindowsJobRunInternal | undefined;
	let spawnAttempted = false;

	return {
		spawn: async (
			executable: string,
			arguments_: readonly string[],
			options: SpawnOptions,
			signal?: AbortSignal
		): Promise<ChildProcess> => {
			if (spawnAttempted) throw new WindowsJobContainmentUnavailableError();
			spawnAttempted = true;
			const workingDirectory = options.cwd;
			const environment = copyStringEnvironment(options.env);
			if (typeof workingDirectory !== 'string' || environment === undefined) {
				throw new WindowsJobContainmentUnavailableError();
			}
			try {
				run = await dependencies.launchWindowsJob({
					helperPath: policy.helperPath,
					helperTrust: {
						expectedSha256: policy.expectedSha256,
						publisherSubject: policy.publisherSubject,
						publisherCertificateSha256: policy.publisherCertificateSha256
					},
					applicationPath: executable,
					workingDirectory,
					arguments: [...arguments_],
					environment,
					timeoutMs: MODEL_EXECUTION_MAX_TIMEOUT_MS,
					cleanupTimeoutMs: WINDOWS_JOB_CLEANUP_TIMEOUT_MS,
					maxOutputBytes: MODEL_EXECUTION_OUTPUT_LIMIT_BYTES,
					helperStartupTimeoutMs: 10_000,
					...(signal === undefined ? {} : { signal })
				});
				return new WindowsJobChildProcessAdapterInternal(run) as unknown as ChildProcess;
			} catch {
				throw new WindowsJobContainmentUnavailableError();
			}
		},
		close: async (): Promise<ProcessTreeTermination> => {
			if (!run) return { verified: true };
			try {
				const completion = await run.cancel();
				if (
					completion.terminationVerified &&
					completion.activeProcesses === 0 &&
					completion.processIds.length === 0 &&
					completion.status !== 'termination-unverified'
				) {
					return { verified: true };
				}
			} catch {
				// The adapter must not infer cleanup from an absent or rejected completion.
			}
			return {
				verified: false,
				detail: 'The Windows Job helper did not prove an empty Job'
			};
		}
	};
}

class WindowsJobChildProcessAdapterInternal extends EventEmitter {
	readonly pid: number;
	readonly stdin;
	readonly stdout;
	readonly stderr;

	constructor(private readonly run: WindowsJobRunInternal) {
		super();
		this.pid = run.rootPid;
		this.stdin = run.stdin;
		this.stdout = run.stdout;
		this.stderr = run.stderr;
		void run.completion.then(
			(completion) => {
				setImmediate(() => {
					const exitCode = completion.exitCode ?? null;
					this.emit('exit', exitCode, null);
					this.emit('close', exitCode, null);
				});
			},
			() => setImmediate(() => this.emit('error', new WindowsJobContainmentUnavailableError()))
		);
	}

	kill(): boolean {
		void this.run.cancel().catch(() => undefined);
		return true;
	}
}

function copyStringEnvironment(environment: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (environment === undefined) return undefined;
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (typeof value !== 'string') return undefined;
		result[name] = value;
	}
	return result;
}
