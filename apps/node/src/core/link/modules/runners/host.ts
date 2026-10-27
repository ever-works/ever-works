import { execFile } from 'node:child_process';
import type {
	FleetActionsRunnerPhase,
	FleetActionsRunnerState,
	FleetActionsRunnerTokenKind,
	FleetActionsRunnerTokenResponse,
	FleetJobView
} from '@ever-works/contracts';
import type { Logger } from '../../../logger';
import { machineChildEnv } from '../machine-facts/exec';
import type { RunnerState } from './state';

/**
 * Actions runners on computers (FL-18, plan §6.1) — what the node's runner
 * executors and the `runners` module share: their injected IO, the child
 * process runner (argv only, a working folder, an environment — the ONE way
 * the registration token reaches the runner), the best-effort progress report
 * and the typed failure whose first line a person reads.
 */

/** The two node-credential calls of a node installing or controlling a runner (`FleetJobClient` implements them). */
export interface RunnerJobClient {
	mintRunnerToken(
		runnerId: string,
		jobId: string,
		kind: FleetActionsRunnerTokenKind,
		leaseGeneration?: number
	): Promise<FleetActionsRunnerTokenResponse>;
	reportRunnerProgress(
		runnerId: string,
		jobId: string,
		report: {
			phase?: FleetActionsRunnerPhase;
			state?: FleetActionsRunnerState;
			error?: string | null;
			runnerVersion?: string | null;
			serviceUnit?: string | null;
			githubRunnerId?: number | null;
			deregistered?: boolean;
		},
		leaseGeneration?: number
	): Promise<void>;
}

/** One child process: argv only (no shell), a working folder, a scrubbed environment plus `env`. */
export interface RunnerExecRequest {
	command: string;
	args: readonly string[];
	cwd?: string;
	/** Added to the scrubbed environment — the token travels ONLY here (spec FR-7). */
	env?: Readonly<Record<string, string>>;
	timeoutMs: number;
}

export interface RunnerExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	spawnError?: string;
	timedOut?: boolean;
}

export type RunnerExec = (request: RunnerExecRequest) => Promise<RunnerExecResult>;

/** The `execFile`-backed runner: no shell, the machine-facts scrubbed environment, a deadline, an output cap. */
export const defaultRunnerExec: RunnerExec = (request) =>
	new Promise((resolve) => {
		execFile(
			request.command,
			[...request.args],
			{
				shell: false,
				windowsHide: true,
				cwd: request.cwd,
				timeout: request.timeoutMs,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...machineChildEnv(), ...(request.env ?? {}) },
				encoding: 'utf8'
			},
			(error, stdout, stderr) => {
				const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
				resolve({
					code: typeof code === 'number' ? code : 1,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					...(typeof code === 'string' ? { spawnError: code } : {}),
					timedOut: Boolean(error && (error as { killed?: boolean }).killed)
				});
			}
		);
	});

export interface RunnerHostDeps {
	state: RunnerState;
	exec: RunnerExec;
	client: () => RunnerJobClient;
	/** `process.platform` / `process.arch` of this machine. */
	platform: string;
	arch: string;
	/** The node's OS user (the service runs as it on Linux). */
	user: string;
	/** True when the node runs as root (Unix) — then no sudo is needed. */
	isRoot: () => boolean;
	/** Windows: whether the node runs elevated (a service install needs it). */
	isElevated: () => Promise<boolean>;
	/** Linux: whether systemd is PID 1. */
	hasSystemd: () => boolean;
	fetch: typeof fetch;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	now(): number;
	logger?: Logger;
	/** This node's own name, for the sentences a refusal carries ("… on build-01"). */
	nodeName: string;
	/**
	 * P3 (FR-27): whether this machine can run Docker-isolated runners — Linux with a
	 * Docker daemon the node's user reaches. Absent: never.
	 */
	hasDocker?: () => boolean;
	/** P3: `uid:gid` of the node's user, which a runner's container runs as. Absent / null: refused. */
	uidGid?: () => string | null;
}

/** A runner step that failed: the message is the first line a person reads (spec U4–U6). */
export class RunnerHostError extends Error {
	constructor(
		message: string,
		/** The CONTRACTS §8 code the failure stands for (`root_required` carries the exact command). */
		readonly code: 'operation_failed' | 'root_required' | 'unsupported_on_node' | 'invalid' = 'operation_failed'
	) {
		super(message);
		this.name = 'RunnerHostError';
	}
}

/** Best-effort progress: a report that does not land never fails the job (the durable job is the record). */
export async function reportRunner(
	deps: Pick<RunnerHostDeps, 'client' | 'logger'>,
	job: FleetJobView,
	runnerId: string,
	value: Parameters<RunnerJobClient['reportRunnerProgress']>[2]
): Promise<void> {
	try {
		await deps.client().reportRunnerProgress(runnerId, job.id, value, job.leaseGeneration);
	} catch (error) {
		deps.logger?.warn(
			`runner ${runnerId}: progress not delivered (${error instanceof Error ? error.message : String(error)})`
		);
	}
}

/** The first non-empty line of a tool's output, bounded. */
export function firstOutputLine(result: Pick<RunnerExecResult, 'stdout' | 'stderr'>, fallback: string): string {
	for (const line of `${result.stderr}\n${result.stdout}`.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.slice(0, 300);
	}
	return fallback;
}

/** Statuses of a token request worth waiting out (the link or the platform is down, the switch holds). */
const RETRYABLE_TOKEN_FAILURES = new Set(['network', 'server', 'rate-limited', 'stale-lease']);

/** How long the node waits for its token across a link drop (spec U11) — inside the job's queue SLA. */
export const RUNNER_TOKEN_WAIT_MS = 45 * 60 * 1000;
const RUNNER_TOKEN_RETRY_MS = 15_000;

/**
 * Ask the platform for the runner's one-time token NOW (the node is ready,
 * FR-7). A network failure, a platform restart or the kill switch are waited
 * out (U11, U14) until {@link RUNNER_TOKEN_WAIT_MS}; a refusal (the job is no
 * longer ours, a name GitHub lists for another machine) fails at once. The
 * token is protected in the logger the moment it exists.
 */
export async function fetchRunnerToken(
	deps: Pick<RunnerHostDeps, 'client' | 'logger' | 'sleep' | 'now'>,
	job: FleetJobView,
	runnerId: string,
	kind: FleetActionsRunnerTokenKind,
	signal: AbortSignal
): Promise<FleetActionsRunnerTokenResponse> {
	const deadline = deps.now() + RUNNER_TOKEN_WAIT_MS;
	for (;;) {
		if (signal.aborted) throw new RunnerHostError('the job was cancelled while waiting for the registration token');
		try {
			const minted = await deps.client().mintRunnerToken(runnerId, job.id, kind, job.leaseGeneration);
			if (!minted || typeof minted.token !== 'string' || minted.token.length < 8) {
				throw new RunnerHostError('the platform did not hand over a token');
			}
			deps.logger?.protect(minted.token);
			return minted;
		} catch (error) {
			if (error instanceof RunnerHostError) throw error;
			const kindOf = (error as { kind?: unknown })?.kind;
			if (kindOf === 'invalid-request') {
				throw new RunnerHostError(
					'GitHub already has a runner with this name for another machine; choose another name',
					'invalid'
				);
			}
			if (typeof kindOf !== 'string' || !RETRYABLE_TOKEN_FAILURES.has(kindOf) || deps.now() >= deadline) {
				throw new RunnerHostError(
					`the registration token could not be fetched: ${error instanceof Error ? error.message.split(/\r?\n/)[0].slice(0, 200) : String(error)}`
				);
			}
			deps.logger?.info(`runner ${runnerId}: waiting for the platform to hand over its token (${kindOf})`);
			await deps.sleep(RUNNER_TOKEN_RETRY_MS, signal);
		}
	}
}
