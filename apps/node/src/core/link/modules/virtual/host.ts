import { spawn } from 'node:child_process';
import type {
	FleetJobView,
	FleetVirtualEnrollTokenResponse,
	FleetVirtualPhase,
	FleetVirtualState
} from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import type { Logger } from '../../../logger';
import { firstLine, machineChildEnv } from '../machine-facts/exec';
import { safeOutputLine } from '../machine-facts/docker-ops';
import { DOCKER } from '../machine-facts/docker-cli';
import { GUEST_TOKEN_FILE } from './container-bootstrap';
import { guestRemoveFileArgs, guestTestFileArgs, guestWriteTokenArgs } from './docker-args';
import type { VirtualState } from './state';

/**
 * Virtual computers (FL-16) — what the host's `vm-create` / `vm-control`
 * executors share: their injected IO, the best-effort progress report, the
 * Docker call with a first-line failure, and the token hand-over.
 */

/** The two node-credential calls of a host building a child (`FleetJobClient` implements them). */
export interface VirtualJobClient {
	mintVirtualEnrollToken(
		childNodeId: string,
		jobId: string,
		leaseGeneration?: number
	): Promise<FleetVirtualEnrollTokenResponse>;
	reportVirtualProgress(
		childNodeId: string,
		jobId: string,
		report: {
			phase?: FleetVirtualPhase;
			state?: FleetVirtualState;
			error?: string | null;
			image?: { ref: string; digest: string | null } | null;
			activated?: boolean | null;
		},
		leaseGeneration?: number
	): Promise<void>;
}

/** Run a command with `input` on its stdin (the token hand-over); no shell, scrubbed environment. */
export type StdinRunner = (
	command: string,
	args: string[],
	input: string,
	timeoutMs: number
) => Promise<{ code: number | null; stderr: string }>;

export const defaultStdinRunner: StdinRunner = (command, args, input, timeoutMs) =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (result: { code: number | null; stderr: string }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const child = spawn(command, args, {
			shell: false,
			windowsHide: true,
			env: machineChildEnv(),
			stdio: ['pipe', 'ignore', 'pipe']
		});
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stderr?.on('data', (chunk: Buffer | string) => {
			if (stderr.length < 4096) stderr += String(chunk);
		});
		child.on('error', () => {
			clearTimeout(timer);
			finish({ code: 1, stderr: `${command} could not be started` });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			finish({ code, stderr });
		});
		child.stdin?.on('error', () => undefined);
		child.stdin?.end(input);
	});

export interface VirtualHostDeps {
	state: VirtualState;
	/** The Docker CLI runner (machine-facts: argv only, scrubbed env, deadline). */
	runner: CommandRunner;
	stdin: StdinRunner;
	client: () => VirtualJobClient;
	/** This node's own version: the guest installs the same (`ever-works-node@<version>`). */
	nodeVersion: string;
	/** The Node.js major line this host runs (the guest installs the same line). */
	nodeMajor: number;
	/** The API this host talks to (the guest enrols against it). */
	apiUrl: string;
	env: NodeJS.ProcessEnv;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	now(): number;
	logger?: Logger;
}

/** A host step that failed: the message is the first line a person reads (spec U8). */
export class VirtualHostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VirtualHostError';
	}
}

/** Run Docker; resolve its stdout, or throw a {@link VirtualHostError} with its first stderr line. */
export async function docker(
	deps: Pick<VirtualHostDeps, 'runner'>,
	args: string[],
	timeoutMs: number,
	what: string
): Promise<string> {
	const result = await deps.runner.run(DOCKER, args, { timeoutMs });
	if (result.spawnError) throw new VirtualHostError('Docker was not found on this computer');
	if (result.timedOut) throw new VirtualHostError(`${what} took too long`);
	if (result.code !== 0) {
		throw new VirtualHostError(`${what}: ${safeOutputLine(firstLine(result.stderr || result.stdout, 'failed'))}`);
	}
	return result.stdout;
}

/** True when the guest's file exists (`docker exec … test -f`). */
export async function guestHasFile(deps: Pick<VirtualHostDeps, 'runner'>, childNodeId: string, path: string): Promise<boolean> {
	const result = await deps.runner.run(DOCKER, guestTestFileArgs(childNodeId, path), { timeoutMs: 15_000 });
	return result.code === 0;
}

/** Best-effort progress: a report that does not land never fails the build (the durable job is the record). */
export async function report(
	deps: Pick<VirtualHostDeps, 'client' | 'logger'>,
	job: FleetJobView,
	childNodeId: string,
	value: Parameters<VirtualJobClient['reportVirtualProgress']>[2]
): Promise<void> {
	try {
		await deps.client().reportVirtualProgress(childNodeId, job.id, value, job.leaseGeneration);
	} catch (error) {
		deps.logger?.warn(
			`virtual computer ${childNodeId}: progress not delivered (${error instanceof Error ? error.message : String(error)})`
		);
	}
}

/** Wait until `check` answers true, polling every `everyMs`, or throw after `timeoutMs`. */
export async function waitFor(
	deps: Pick<VirtualHostDeps, 'sleep' | 'now'>,
	check: () => Promise<boolean>,
	options: { timeoutMs: number; everyMs: number; signal?: AbortSignal; what: string }
): Promise<void> {
	const deadline = deps.now() + options.timeoutMs;
	for (;;) {
		if (options.signal?.aborted) throw new VirtualHostError(`${options.what} was cancelled`);
		if (await check()) return;
		if (deps.now() >= deadline) throw new VirtualHostError(`${options.what} did not happen in time`);
		await deps.sleep(options.everyMs, options.signal);
	}
}

/** How long the guest gets to install its runtime (first image pull excluded). */
export const RUNTIME_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** How long the guest gets to enrol once it holds its token. */
export const ENROLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Poll cadence while waiting on the guest (spec FR-13: progress at least every 5 s). */
export const GUEST_POLL_MS = 3_000;

/**
 * The late token hand-over (CONTRACTS R-35, FR-14, FR-24): ask the platform
 * for the child's one-time token NOW (the guest said it is ready), write it
 * into the guest's private file through `docker exec -i` (stdin — never a
 * command line, never the host's disk), wait for the guest to enrol, and
 * remove the file whatever happened. The token is protected in the logger
 * the moment it exists and forgotten when the hand-over ends.
 */
export async function handOverToken(
	deps: VirtualHostDeps,
	job: FleetJobView,
	childNodeId: string,
	enrolledMarker: string,
	signal?: AbortSignal
): Promise<void> {
	const minted = await deps.client().mintVirtualEnrollToken(childNodeId, job.id, job.leaseGeneration);
	const token = minted?.token;
	if (typeof token !== 'string' || token.length < 16) throw new VirtualHostError('the platform did not hand over a token');
	deps.logger?.protect(token);
	try {
		const written = await deps.stdin(DOCKER, guestWriteTokenArgs(childNodeId, GUEST_TOKEN_FILE), `${token}\n`, 30_000);
		if (written.code !== 0) {
			throw new VirtualHostError(`could not hand the token over: ${safeOutputLine(firstLine(written.stderr, 'failed'))}`);
		}
		await report(deps, job, childNodeId, { phase: 'enrolling' });
		await waitFor(deps, () => guestHasFile(deps, childNodeId, enrolledMarker), {
			timeoutMs: ENROLL_TIMEOUT_MS,
			everyMs: GUEST_POLL_MS,
			signal,
			what: 'enrolment'
		});
	} finally {
		// The guest's `enroll --token-file` deletes it; this is the belt.
		await deps.runner.run(DOCKER, guestRemoveFileArgs(childNodeId, GUEST_TOKEN_FILE), { timeoutMs: 15_000 }).catch(() => undefined);
		deps.logger?.unprotect?.(token);
	}
}
