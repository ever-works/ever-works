import type { LogEntry, ProcessState, ServiceId, ServiceStatus } from '../shared/ipc-contract';

/**
 * Supervises the local platform services (API on :3100, web on :3000) as
 * child processes: start/stop, graceful shutdown, restart-on-crash with
 * exponential backoff and per-service log ring buffers.
 *
 * All effects (spawning, timers, clock) are injected so the state machine is
 * fully unit-testable with fakes.
 */

export interface ChildProcessLike {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
	stdout?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
	stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
}

export type SpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; env?: Record<string, string | undefined>; shell?: boolean }
) => ChildProcessLike;

export interface Scheduler {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ManagedServiceDeps {
	spawnFn: SpawnFn;
	scheduler: Scheduler;
	now?: () => number;
}

export interface ManagedServiceOptions {
	id: ServiceId;
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	/** When set, the service only becomes `running` once a log line matches. */
	readyPattern?: RegExp;
	restartOnCrash?: boolean;
	maxRestarts?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	gracefulTimeoutMs?: number;
	logCapacity?: number;
}

export const DEFAULT_MAX_RESTARTS = 5;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_GRACEFUL_TIMEOUT_MS = 8_000;
export const DEFAULT_LOG_CAPACITY = 1_000;

/** Exponential backoff with a ceiling: base * 2^attempt, capped at maxMs. */
export function computeBackoffMs(
	attempt: number,
	baseMs: number = DEFAULT_BACKOFF_BASE_MS,
	maxMs: number = DEFAULT_BACKOFF_MAX_MS
): number {
	return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/** Fixed-capacity FIFO buffer for service log lines. */
export class LogRingBuffer {
	private entries: LogEntry[] = [];

	constructor(private readonly capacity: number = DEFAULT_LOG_CAPACITY) {}

	push(entry: LogEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.capacity) {
			this.entries.splice(0, this.entries.length - this.capacity);
		}
	}

	toArray(): LogEntry[] {
		return [...this.entries];
	}

	get size(): number {
		return this.entries.length;
	}
}

type StatusListener = (status: ServiceStatus) => void;
type LogListener = (entry: LogEntry) => void;

export class ManagedService {
	readonly id: ServiceId;
	readonly logs: LogRingBuffer;

	private state: ProcessState = 'stopped';
	private restarts = 0;
	private lastExitCode: number | null | undefined;
	private healthy = false;
	private child: ChildProcessLike | undefined;
	private pendingRestart: unknown;
	private killTimer: unknown;
	private stopResolvers: Array<() => void> = [];
	private statusListeners: StatusListener[] = [];
	private logListeners: LogListener[] = [];
	private readonly now: () => number;

	constructor(
		private readonly options: ManagedServiceOptions,
		private readonly deps: ManagedServiceDeps
	) {
		this.id = options.id;
		this.logs = new LogRingBuffer(options.logCapacity ?? DEFAULT_LOG_CAPACITY);
		this.now = deps.now ?? (() => Date.now());
	}

	status(): ServiceStatus {
		return {
			id: this.id,
			state: this.state,
			pid: this.child?.pid,
			restarts: this.restarts,
			lastExitCode: this.lastExitCode,
			healthy: this.healthy
		};
	}

	onStatusChange(listener: StatusListener): () => void {
		this.statusListeners.push(listener);
		return () => {
			this.statusListeners = this.statusListeners.filter((candidate) => candidate !== listener);
		};
	}

	onLog(listener: LogListener): () => void {
		this.logListeners.push(listener);
		return () => {
			this.logListeners = this.logListeners.filter((candidate) => candidate !== listener);
		};
	}

	setHealthy(healthy: boolean): void {
		if (this.healthy !== healthy) {
			this.healthy = healthy;
			this.emitStatus();
		}
	}

	start(): void {
		if (this.state === 'starting' || this.state === 'running' || this.state === 'stopping') {
			return;
		}
		this.cancelPendingRestart();
		this.setState('starting');

		let child: ChildProcessLike;
		try {
			child = this.deps.spawnFn(this.options.command, this.options.args, {
				cwd: this.options.cwd,
				env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
				shell: process.platform === 'win32'
			});
		} catch (error) {
			this.log('system', `spawn failed: ${(error as Error).message}`);
			this.setState('failed');
			return;
		}

		this.child = child;
		child.stdout?.on('data', (chunk) => this.ingest('stdout', chunk));
		child.stderr?.on('data', (chunk) => this.ingest('stderr', chunk));
		child.on('exit', (code) => this.handleExit(code));

		if (!this.options.readyPattern) {
			this.setState('running');
		}
	}

	/** Graceful stop: SIGTERM, then SIGKILL after `gracefulTimeoutMs`. Resolves once the process exited. */
	stop(): Promise<void> {
		this.cancelPendingRestart();

		if (!this.child) {
			this.setState('stopped');
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.stopResolvers.push(resolve);
			if (this.state === 'stopping') {
				return;
			}
			this.setState('stopping');
			this.child?.kill('SIGTERM');
			this.killTimer = this.deps.scheduler.setTimeout(() => {
				this.log('system', `graceful shutdown timed out after ${this.gracefulTimeoutMs()}ms — sending SIGKILL`);
				this.child?.kill('SIGKILL');
			}, this.gracefulTimeoutMs());
		});
	}

	async restart(): Promise<void> {
		await this.stop();
		this.restarts = 0;
		this.start();
	}

	private handleExit(code: number | null): void {
		this.lastExitCode = code;
		this.child = undefined;
		this.setHealthy(false);

		if (this.killTimer !== undefined) {
			this.deps.scheduler.clearTimeout(this.killTimer);
			this.killTimer = undefined;
		}

		if (this.state === 'stopping') {
			this.setState('stopped');
			this.resolveStops();
			return;
		}

		// Unexpected exit while starting/running.
		this.log('system', `exited unexpectedly with code ${code}`);
		const restartOnCrash = this.options.restartOnCrash ?? true;
		const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;

		if (!restartOnCrash || this.restarts >= maxRestarts) {
			this.setState('failed');
			return;
		}

		const delay = computeBackoffMs(
			this.restarts,
			this.options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
			this.options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
		);
		this.restarts += 1;
		this.setState('restarting');
		this.log('system', `restarting in ${delay}ms (attempt ${this.restarts}/${maxRestarts})`);
		this.pendingRestart = this.deps.scheduler.setTimeout(() => {
			this.pendingRestart = undefined;
			this.setState('crashed');
			this.start();
		}, delay);
	}

	private ingest(stream: 'stdout' | 'stderr', chunk: unknown): void {
		const text = String(chunk);
		for (const line of text.split(/\r?\n/)) {
			if (line.trim() === '') {
				continue;
			}
			this.log(stream, line);
			if (this.state === 'starting' && this.options.readyPattern?.test(line)) {
				this.setState('running');
			}
		}
	}

	private log(stream: LogEntry['stream'], line: string): void {
		const entry: LogEntry = { serviceId: this.id, stream, line, at: this.now() };
		this.logs.push(entry);
		for (const listener of this.logListeners) {
			listener(entry);
		}
	}

	private setState(state: ProcessState): void {
		if (this.state !== state) {
			this.state = state;
			this.emitStatus();
		}
	}

	private emitStatus(): void {
		const status = this.status();
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}

	private cancelPendingRestart(): void {
		if (this.pendingRestart !== undefined) {
			this.deps.scheduler.clearTimeout(this.pendingRestart);
			this.pendingRestart = undefined;
			if (this.state === 'restarting') {
				this.setState('stopped');
			}
		}
	}

	private resolveStops(): void {
		const resolvers = this.stopResolvers;
		this.stopResolvers = [];
		for (const resolve of resolvers) {
			resolve();
		}
	}

	private gracefulTimeoutMs(): number {
		return this.options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
	}
}

/**
 * Resolve how a service should be launched: prefer built output when present
 * (node dist build / next start), fall back to the repo's dev scripts.
 */
export function resolveServiceCommand(
	id: ServiceId,
	repoRoot: string,
	exists: (path: string) => boolean,
	joinPath: (...segments: string[]) => string
): { command: string; args: string[]; cwd: string } {
	if (id === 'api') {
		const distEntry = joinPath(repoRoot, 'apps', 'api', 'dist', 'main.js');
		if (exists(distEntry)) {
			return { command: 'node', args: ['dist/main.js'], cwd: joinPath(repoRoot, 'apps', 'api') };
		}
		return { command: 'pnpm', args: ['dev:api'], cwd: repoRoot };
	}

	const buildMarker = joinPath(repoRoot, 'apps', 'web', '.next', 'BUILD_ID');
	if (exists(buildMarker)) {
		return { command: 'pnpm', args: ['--filter', 'ever-works-web', 'start'], cwd: repoRoot };
	}
	return { command: 'pnpm', args: ['dev:web'], cwd: repoRoot };
}

export class ProcessManager {
	private services = new Map<ServiceId, ManagedService>();

	constructor(private readonly deps: ManagedServiceDeps) {}

	create(options: ManagedServiceOptions): ManagedService {
		const service = new ManagedService(options, this.deps);
		this.services.set(options.id, service);
		return service;
	}

	get(id: ServiceId): ManagedService | undefined {
		return this.services.get(id);
	}

	all(): ManagedService[] {
		return [...this.services.values()];
	}

	statuses(): ServiceStatus[] {
		return this.all().map((service) => service.status());
	}

	startAll(): void {
		for (const service of this.services.values()) {
			service.start();
		}
	}

	/** Stop services in reverse registration order (web before api). */
	async stopAll(): Promise<void> {
		const services = [...this.services.values()].reverse();
		for (const service of services) {
			await service.stop();
		}
	}
}
