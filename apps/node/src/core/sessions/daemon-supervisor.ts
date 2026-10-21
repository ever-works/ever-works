import type { FleetSessionAttachRole, FleetSessionDaemonReport } from '@ever-works/contracts';
import { systemScheduler, type Scheduler } from '../heartbeat';
import type { Logger } from '../logger';
import {
	DaemonControlClient,
	DaemonRequestError,
	openDaemonAttach,
	type ConnectFn,
	type DaemonAttachStream
} from './daemon-client';
import type { SessionDaemonPaths } from './daemon/daemon-paths';
import type { DaemonHealth, DaemonWatchEvent } from './daemon/daemon-protocol';

/**
 * Sessions on computers (FL-04) — the node's supervision of its session
 * daemon (spec FR-1, FR-2, FR-10, U3; plan §6.5).
 *
 * Started when this process holds `--manage` or `--work`. It connects to a
 * daemon that is already running (a node restart or upgrade finds it alive
 * and loses no session), or spawns one DETACHED and connects to that. While
 * connected it keeps one control connection open — which is also what keeps
 * the daemon from exiting idle — asks for health every
 * {@link SUPERVISOR_HEALTH_INTERVAL_MS}, and after three missed answers
 * drops the connection and starts over, with a 1 s → 30 s backoff between
 * attempts. It never kills the daemon: stopping the node leaves every
 * session running.
 *
 * `healthy` — the daemon answers AND can host a terminal — is what the
 * `sessions` capability tag stands on: advertised only while it is true,
 * withdrawn on the next beat otherwise (FR-10). {@link report} is the
 * heartbeat's `daemon` block, with the node's own diagnosis when it is not
 * running ("could not bind the local socket", "terminal support is missing").
 */

export const SUPERVISOR_HEALTH_INTERVAL_MS = 10_000;
/** How long a freshly spawned daemon has to answer. */
export const SUPERVISOR_SPAWN_WAIT_MS = 10_000;
const SPAWN_POLL_MS = 250;
const MAX_HEALTH_MISSES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface SessionDaemonSupervisorOptions {
	paths: SessionDaemonPaths;
	nodeVersion: string;
	/** Read (or create) the token file. */
	ensureToken: () => Promise<string>;
	/** Spawn the daemon detached; it must outlive this process. */
	spawnDaemon: () => void;
	connect?: ConnectFn;
	logger?: Logger;
	scheduler?: Scheduler;
	healthIntervalMs?: number;
	spawnWaitMs?: number;
	random?: () => number;
}

type SupervisorPhase = 'idle' | 'connecting' | 'connected' | 'failed' | 'stopped';

export class SessionDaemonSupervisor {
	private phase: SupervisorPhase = 'idle';
	private client: DaemonControlClient | null = null;
	private health: DaemonHealth | null = null;
	private failure: string | null = null;
	private token: string | null = null;
	private misses = 0;
	private attempts = 0;
	private timer: unknown = null;
	private stopped = false;
	private readonly scheduler: Scheduler;
	private readonly connectedListeners = new Set<(client: DaemonControlClient) => void>();
	private readonly eventListeners = new Set<(event: DaemonWatchEvent) => void>();
	private readonly changeListeners = new Set<() => void>();

	constructor(private readonly options: SessionDaemonSupervisorOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
	}

	/** True while the daemon answers and can host terminals: what `sessions` stands on. */
	get healthy(): boolean {
		return this.phase === 'connected' && this.health?.pty === 'available';
	}

	/** The heartbeat's `daemon` block (CONTRACTS §1.1). */
	report(): FleetSessionDaemonReport {
		const sessions = this.health?.sessions ?? 0;
		const storage = this.health?.storage;
		if (this.phase === 'connected' && this.health) {
			if (this.health.pty !== 'available') {
				return {
					state: 'failed',
					reason: this.health.ptyReason ?? 'terminal support is missing on this computer',
					sessions,
					...(storage ? { storage } : {})
				};
			}
			return { state: 'running', sessions, ...(storage ? { storage } : {}) };
		}
		if (this.phase === 'failed' || (this.phase === 'connecting' && this.failure)) {
			return { state: 'failed', reason: this.failure ?? 'the session daemon is not running', sessions: 0 };
		}
		return { state: 'stopped', sessions: 0 };
	}

	start(): void {
		if (this.phase !== 'idle' || this.stopped) return;
		this.phase = 'connecting';
		void this.connectOrSpawn();
	}

	/** Stop supervising. The daemon — and every session — keeps running. */
	stop(): void {
		this.stopped = true;
		this.clearTimer();
		const client = this.client;
		this.client = null;
		client?.close();
		this.setPhase('stopped');
	}

	/** Each NEW control connection (a fresh daemon, or the same one reconnected). */
	onConnected(listener: (client: DaemonControlClient) => void): () => void {
		this.connectedListeners.add(listener);
		if (this.client && this.phase === 'connected') listener(this.client);
		return () => {
			this.connectedListeners.delete(listener);
		};
	}

	/** Session events from the daemon's watch stream. */
	onEvent(listener: (event: DaemonWatchEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	/** Health or phase changed (for tags and the heartbeat). */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	/** One control op on the current connection, or a typed `unreachable`. */
	request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		const client = this.client;
		if (!client || this.phase !== 'connected') {
			return Promise.reject(
				new DaemonRequestError(
					'unsupported_on_node',
					this.report().reason ?? 'the session daemon is not running'
				)
			);
		}
		return client.request<T>(op, params, timeoutMs);
	}

	/** Attach to one session's terminal. */
	attach(input: {
		sessionId: string;
		mode: FleetSessionAttachRole;
		cols?: number;
		rows?: number;
	}): Promise<DaemonAttachStream> {
		if (!this.token || this.phase !== 'connected') {
			return Promise.reject(
				new DaemonRequestError(
					'unsupported_on_node',
					this.report().reason ?? 'the session daemon is not running'
				)
			);
		}
		return openDaemonAttach({
			socketPath: this.options.paths.socketPath,
			token: this.token,
			nodeVersion: this.options.nodeVersion,
			...(this.options.connect ? { connect: this.options.connect } : {}),
			...input
		});
	}

	// ─── Connecting ────────────────────────────────────────────────────────

	private async connectOrSpawn(): Promise<void> {
		if (this.stopped) return;
		try {
			this.token = await this.options.ensureToken();
		} catch (error) {
			this.fail(`could not write the session daemon token: ${describe(error)}`);
			return;
		}
		const existing = await this.tryConnect();
		if (existing) return this.adopt(existing);
		try {
			this.options.spawnDaemon();
		} catch (error) {
			this.fail(`could not start the session daemon: ${describe(error)}`);
			return;
		}
		const waitMs = this.options.spawnWaitMs ?? SUPERVISOR_SPAWN_WAIT_MS;
		const polls = Math.max(1, Math.ceil(waitMs / SPAWN_POLL_MS));
		for (let poll = 0; poll < polls && !this.stopped; poll += 1) {
			await this.sleep(SPAWN_POLL_MS);
			const spawned = await this.tryConnect();
			if (spawned) return this.adopt(spawned);
		}
		this.fail(this.lastConnectError ?? 'the session daemon did not start');
	}

	private lastConnectError: string | null = null;

	private async tryConnect(): Promise<DaemonControlClient | null> {
		if (this.stopped || !this.token) return null;
		try {
			const client = await DaemonControlClient.connect({
				socketPath: this.options.paths.socketPath,
				token: this.token,
				nodeVersion: this.options.nodeVersion,
				...(this.options.connect ? { connect: this.options.connect } : {}),
				timeoutMs: 3_000
			});
			this.lastConnectError = null;
			return client;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			this.lastConnectError =
				code === 'ENOENT' || code === 'ECONNREFUSED'
					? 'could not reach the local socket'
					: code === 'EACCES' || code === 'EPERM'
						? 'could not open the local socket (permission denied)'
						: describe(error);
			return null;
		}
	}

	private adopt(client: DaemonControlClient): void {
		if (this.stopped) {
			client.close();
			return;
		}
		this.client = client;
		this.health = client.welcome;
		this.misses = 0;
		this.attempts = 0;
		this.failure = null;
		client.onEvent((event) => {
			for (const listener of [...this.eventListeners]) {
				try {
					listener(event);
				} catch {
					// a listener's failure is its own
				}
			}
		});
		client.onClose(() => {
			if (this.client !== client) return;
			this.client = null;
			if (this.stopped) return;
			this.options.logger?.warn('The session daemon connection closed — reconnecting.');
			this.retry('the session daemon connection closed');
		});
		this.setPhase('connected');
		if (client.welcome.pty !== 'available') {
			this.options.logger?.warn(
				`Sessions are unavailable on this computer: ${client.welcome.ptyReason ?? 'terminal support is missing'}.`
			);
		} else {
			this.options.logger?.info(`Session daemon connected (${client.welcome.sessions} session(s)).`);
		}
		for (const listener of [...this.connectedListeners]) {
			try {
				listener(client);
			} catch {
				// a listener's failure is its own
			}
		}
		this.scheduleHealth();
	}

	private scheduleHealth(): void {
		this.clearTimer();
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			void this.checkHealth();
		}, this.options.healthIntervalMs ?? SUPERVISOR_HEALTH_INTERVAL_MS);
	}

	private async checkHealth(): Promise<void> {
		const client = this.client;
		if (!client || this.stopped) return;
		try {
			this.health = await client.request<DaemonHealth>('health', {}, 5_000);
			this.misses = 0;
			this.emitChange();
		} catch {
			this.misses += 1;
			if (this.misses >= MAX_HEALTH_MISSES) {
				this.options.logger?.warn('The session daemon stopped answering — reconnecting.');
				this.client = null;
				client.close();
				this.retry('the session daemon stopped answering');
				return;
			}
		}
		this.scheduleHealth();
	}

	private retry(reason: string, waiting: 'connecting' | 'failed' = 'connecting'): void {
		this.failure = reason;
		this.setPhase(waiting);
		const delay = Math.min(
			BACKOFF_MAX_MS,
			BACKOFF_BASE_MS * 2 ** Math.min(this.attempts, 5) * (0.75 + 0.5 * (this.options.random ?? Math.random)())
		);
		this.attempts += 1;
		this.clearTimer();
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			void this.connectOrSpawn();
		}, delay);
	}

	/** Report the failure (the heartbeat keeps saying why) and try again after the backoff. */
	private fail(reason: string): void {
		this.options.logger?.warn(`Session daemon: ${reason}.`);
		if (this.stopped) {
			this.failure = reason;
			return;
		}
		this.retry(reason, 'failed');
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => this.scheduler.setTimeout(resolve, ms));
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			this.scheduler.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private setPhase(phase: SupervisorPhase): void {
		if (this.phase === phase) return;
		this.phase = phase;
		this.emitChange();
	}

	private emitChange(): void {
		for (const listener of [...this.changeListeners]) {
			try {
				listener();
			} catch {
				// a listener's failure is its own
			}
		}
	}
}

function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0].slice(0, 200);
}
