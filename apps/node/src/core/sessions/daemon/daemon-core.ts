import * as fsp from 'node:fs/promises';
import {
	FLEET_SESSION_ACTIVITY_REPORT_MS,
	FLEET_SESSION_DAEMON_IDLE_EXIT_MS,
	FLEET_SESSION_END_GRACE_MS,
	FLEET_SESSION_REPLAY_LINES,
	FLEET_SESSION_SCREEN_PERSIST_MS,
	FLEET_SESSION_TITLE_MAX_LENGTH,
	type FleetSessionEndedReason
} from '@ever-works/contracts';
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonError,
	type DaemonHealth,
	type DaemonSessionInfo,
	type DaemonStartRequest,
	type DaemonWatchEvent
} from './daemon-protocol';
import { DaemonSession, type DaemonAttachment } from './daemon-session';
import type { PtyFactory } from './pty-host';
import { SessionProcess } from './session-process';
import type { SessionStore, StoredSession } from './session-store';

/**
 * Sessions on computers (FL-04) — the daemon's state: every session it owns,
 * what it remembers on disk, and who is listening (spec FR-1 … FR-11).
 *
 * Transport-free — the socket server drives it — so its whole lifecycle is
 * testable with an in-memory PTY. It never composes a command line: the node
 * sends the exact argv and environment, and the daemon only runs them in a
 * terminal, keeps their screen and remembers them.
 *
 * ## Lifecycle
 *
 *  - **boot** loads the store: an ended session the platform had not
 *    acknowledged is restored as ended; one that was RUNNING when the
 *    previous daemon went away is restored as **lost** (its process died
 *    with that daemon), keeping its last persisted screen (FR-11).
 *  - **ended** sessions stay, screen and all, until `ack-ended` (FR-9).
 *  - **idle exit**: no session at all and no node connected for
 *    {@link FLEET_SESSION_DAEMON_IDLE_EXIT_MS} → the daemon exits (FR-2).
 *    While any session exists it never exits on its own.
 */

export interface DaemonCoreOptions {
	version: string;
	ptyFactory: PtyFactory | null;
	/** Why there is no PTY, when there is none. */
	ptyReason?: string;
	store: SessionStore;
	now?: () => number;
	/** The folder check (tests); defaults to the real filesystem. */
	isDirectory?: (path: string) => Promise<boolean>;
	/** Called when the idle rule says the daemon may go. */
	onIdleExit?: () => void;
	idleExitMs?: number;
	screenPersistMs?: number;
	activityReportMs?: number;
	log?: (message: string) => void;
}

async function realIsDirectory(target: string): Promise<boolean> {
	try {
		return (await fsp.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

interface SessionBook {
	session: DaemonSession;
	/** Output since the last persisted screen: epoch ms of the first unpersisted change, or null. */
	dirtySince: number | null;
	lastActivityReportAt: number;
	record: StoredSession;
}

export class DaemonCore {
	private readonly sessions = new Map<string, SessionBook>();
	/** Ids reserved by a start in flight, so two starts of one id cannot race. */
	private readonly starting = new Set<string>();
	private readonly watchers = new Set<(event: DaemonWatchEvent) => void>();
	private readonly now: () => number;
	private readonly isDirectory: (path: string) => Promise<boolean>;
	private readonly bootedAt: number;
	private nodeConnections = 0;
	private lastNodeSeenAt: number;
	private inputBlocked = false;
	private inputBlockedReason: string | undefined;
	private idleNotified = false;

	constructor(private readonly options: DaemonCoreOptions) {
		this.now = options.now ?? (() => Date.now());
		this.isDirectory = options.isDirectory ?? realIsDirectory;
		this.bootedAt = this.now();
		this.lastNodeSeenAt = this.bootedAt;
	}

	// ─── Boot ──────────────────────────────────────────────────────────────

	/** Restore what the store remembers (ended-but-unacknowledged and lost sessions). */
	async boot(): Promise<void> {
		for (const { record, screen } of await this.options.store.load()) {
			if (this.sessions.has(record.id)) continue;
			const session = this.makeSession(record);
			session.restoreEnded({
				screen,
				exitCode: record.exitCode,
				endReason: record.endReason,
				lost: record.endedAt === null
			});
			if (record.endedAt === null) {
				// Remember it as ended now, so a second restart does not find it "running" again.
				const ended: StoredSession = { ...record, endedAt: new Date(this.now()).toISOString() };
				await this.options.store.save(ended);
				this.sessions.set(record.id, { session, dirtySince: null, lastActivityReportAt: 0, record: ended });
			} else {
				this.sessions.set(record.id, { session, dirtySince: null, lastActivityReportAt: 0, record });
			}
		}
	}

	// ─── Reads ─────────────────────────────────────────────────────────────

	health(): DaemonHealth {
		const health: DaemonHealth = {
			ok: true,
			daemonVersion: this.options.version,
			protocol: DAEMON_PROTOCOL_VERSION,
			pty: this.options.ptyFactory ? 'available' : 'missing',
			sessions: this.sessions.size,
			uptimeSec: Math.max(0, Math.round((this.now() - this.bootedAt) / 1000)),
			storage: this.options.store.storage
		};
		if (!this.options.ptyFactory && this.options.ptyReason) health.ptyReason = this.options.ptyReason;
		return health;
	}

	list(): DaemonSessionInfo[] {
		return [...this.sessions.values()].map((book) => book.session.info());
	}

	get(id: string): DaemonSession | undefined {
		return this.sessions.get(id)?.session;
	}

	async screen(
		id: string,
		lines: number
	): Promise<{ text: string; title: string; cols: number; rows: number; alive: boolean } | DaemonError> {
		const session = this.get(id);
		if (!session) return { code: 'not_found', hint: 'no such session on this computer' };
		return {
			text: await session.screen(lines),
			title: session.title,
			cols: session.grid.cols,
			rows: session.grid.rows,
			alive: session.alive
		};
	}

	get isInputBlocked(): boolean {
		return this.inputBlocked;
	}

	// ─── Writes ────────────────────────────────────────────────────────────

	async start(request: DaemonStartRequest): Promise<{ pid: number | null } | DaemonError> {
		if (!this.options.ptyFactory) {
			return {
				code: 'unsupported_on_node',
				hint: this.options.ptyReason ?? 'terminal support is missing on this computer'
			};
		}
		if (this.sessions.has(request.id) || this.starting.has(request.id)) {
			return { code: 'invalid', hint: 'a session with this id already exists' };
		}
		this.starting.add(request.id);
		try {
			return await this.startReserved(request, this.options.ptyFactory);
		} finally {
			this.starting.delete(request.id);
		}
	}

	private async startReserved(
		request: DaemonStartRequest,
		ptyFactory: PtyFactory
	): Promise<{ pid: number | null } | DaemonError> {
		if (!(await this.isDirectory(request.cwd))) {
			return { code: 'invalid', hint: `${request.cwd} does not exist on this computer` };
		}
		const record: StoredSession = {
			version: 1,
			id: request.id,
			kind: request.kind,
			provider: request.provider,
			cwd: request.cwd,
			title: request.title,
			startedAt: new Date(this.now()).toISOString(),
			startedBy: request.startedBy,
			cols: request.cols,
			rows: request.rows,
			endedAt: null,
			exitCode: null,
			endReason: null
		};
		// Persisted BEFORE the process exists (FR-8), so an exit racing the
		// write can never be overwritten by the "still running" record. A
		// failed write is reported in health, never fatal (U15).
		await this.options.store.save(record);
		let process: SessionProcess;
		try {
			process = new SessionProcess({
				sessionId: request.id,
				command: request.command,
				cwd: request.cwd,
				env: request.env,
				cols: request.cols,
				rows: request.rows,
				factory: ptyFactory
			});
		} catch (error) {
			await this.options.store.forget(request.id);
			const first = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0];
			return { code: 'operation_failed', hint: first.slice(0, 300) || 'the session could not start' };
		}
		const session = this.makeSession(record);
		const book: SessionBook = { session, dirtySince: null, lastActivityReportAt: this.now(), record };
		this.sessions.set(request.id, book);
		// Same tick as the spawn: no output can be printed before this listens.
		session.attachProcess(process);
		if (this.inputBlocked) session.setInputBlocked(true, this.inputBlockedReason);
		this.emit({ event: 'started', id: request.id, at: record.startedAt });
		return { pid: process.pid };
	}

	async rename(id: string, title: string): Promise<DaemonError | null> {
		const book = this.sessions.get(id);
		if (!book) return { code: 'not_found', hint: 'no such session on this computer' };
		const trimmed = title.trim();
		if (trimmed.length === 0 || trimmed.length > FLEET_SESSION_TITLE_MAX_LENGTH) {
			return { code: 'invalid', hint: 'a title is 1–200 characters' };
		}
		book.session.title = trimmed;
		book.record = { ...book.record, title: trimmed };
		await this.options.store.save(book.record);
		this.emit({ event: 'title', id, title: trimmed, at: new Date(this.now()).toISOString() });
		return null;
	}

	end(
		id: string,
		reason: FleetSessionEndedReason,
		graceMs: number = FLEET_SESSION_END_GRACE_MS
	): DaemonError | { alreadyEnded: boolean } {
		const book = this.sessions.get(id);
		if (!book) return { code: 'not_found', hint: 'no such session on this computer' };
		if (!book.session.alive) return { alreadyEnded: true };
		book.session.end(reason, graceMs);
		return { alreadyEnded: false };
	}

	input(id: string, data: string): DaemonError | { accepted: boolean } {
		const session = this.get(id);
		if (!session) return { code: 'not_found', hint: 'no such session on this computer' };
		return { accepted: session.writeInput(data) };
	}

	resize(id: string, cols: number, rows: number): DaemonError | null {
		const session = this.get(id);
		if (!session) return { code: 'not_found', hint: 'no such session on this computer' };
		session.resize(cols, rows);
		return null;
	}

	/** The fleet kill switch (R-24): block every session's input, leave every process running. */
	setInputBlocked(on: boolean, reason?: string): void {
		this.inputBlocked = on;
		this.inputBlockedReason = on ? reason : undefined;
		for (const book of this.sessions.values()) book.session.setInputBlocked(on, reason);
	}

	warn(id: string, seconds: number): DaemonError | null {
		const session = this.get(id);
		if (!session) return { code: 'not_found', hint: 'no such session on this computer' };
		session.warn(seconds);
		return null;
	}

	/** The platform holds the ended session's screen: forget it (FR-9). Live sessions are never forgotten. */
	async ackEnded(id: string): Promise<boolean> {
		const book = this.sessions.get(id);
		if (!book || book.session.alive) return false;
		this.sessions.delete(id);
		book.session.dispose();
		await this.options.store.forget(id);
		return true;
	}

	attach(
		id: string,
		attachment: DaemonAttachment,
		size: { cols: number; rows: number } | null
	): Promise<void> | DaemonError {
		const session = this.get(id);
		if (!session) return { code: 'not_found', hint: 'no such session on this computer' };
		return session.attach(attachment, size);
	}

	detach(id: string, attachmentId: number): void {
		this.get(id)?.detach(attachmentId);
	}

	watch(listener: (event: DaemonWatchEvent) => void): () => void {
		this.watchers.add(listener);
		return () => {
			this.watchers.delete(listener);
		};
	}

	/** A node connected (a control connection authenticated). */
	nodeConnected(): () => void {
		this.nodeConnections += 1;
		this.lastNodeSeenAt = this.now();
		this.idleNotified = false;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.nodeConnections = Math.max(0, this.nodeConnections - 1);
			this.lastNodeSeenAt = this.now();
		};
	}

	/**
	 * One beat of the daemon's clock (the main loop calls it every second):
	 * drop slow viewers, persist screens that changed, and apply the idle rule.
	 */
	async tick(): Promise<void> {
		const now = this.now();
		const persistMs = this.options.screenPersistMs ?? FLEET_SESSION_SCREEN_PERSIST_MS;
		for (const book of this.sessions.values()) {
			book.session.dropSlow(now);
			if (book.dirtySince !== null && now - book.dirtySince >= persistMs) {
				book.dirtySince = null;
				await this.options.store.saveScreen(
					book.record.id,
					await book.session.screen(FLEET_SESSION_REPLAY_LINES)
				);
			}
		}
		const idleMs = this.options.idleExitMs ?? FLEET_SESSION_DAEMON_IDLE_EXIT_MS;
		if (
			!this.idleNotified &&
			this.sessions.size === 0 &&
			this.nodeConnections === 0 &&
			now - this.lastNodeSeenAt >= idleMs
		) {
			this.idleNotified = true;
			this.options.onIdleExit?.();
		}
	}

	/** Persist every screen now (shutdown). */
	async persistAll(): Promise<void> {
		for (const book of this.sessions.values()) {
			if (!book.session.alive && book.dirtySince === null) continue;
			book.dirtySince = null;
			await this.options.store.saveScreen(book.record.id, await book.session.screen(FLEET_SESSION_REPLAY_LINES));
		}
	}

	// ─── Internals ─────────────────────────────────────────────────────────

	private makeSession(record: StoredSession): DaemonSession {
		return new DaemonSession(
			{
				id: record.id,
				kind: record.kind,
				provider: record.provider,
				cwd: record.cwd,
				title: record.title,
				startedAt: record.startedAt,
				startedBy: record.startedBy,
				cols: record.cols,
				rows: record.rows
			},
			{
				now: this.now,
				onOutput: (session) => this.onOutput(session),
				onExit: (session) => {
					const book = this.sessions.get(session.id);
					if (book) void this.onSessionExit(book);
				}
			}
		);
	}

	private onOutput(session: DaemonSession): void {
		const book = this.sessions.get(session.id);
		if (!book) return;
		const now = this.now();
		if (book.dirtySince === null) book.dirtySince = now;
		const reportMs = this.options.activityReportMs ?? FLEET_SESSION_ACTIVITY_REPORT_MS;
		if (now - book.lastActivityReportAt >= reportMs) {
			book.lastActivityReportAt = now;
			this.emit({ event: 'activity', id: session.id, at: new Date(now).toISOString() });
		}
	}

	private async onSessionExit(book: SessionBook): Promise<void> {
		if (book.record.endedAt !== null) return;
		const { exitCode, reason } = book.session.exit;
		const endedAt = new Date(this.now()).toISOString();
		book.record = { ...book.record, endedAt, exitCode, endReason: reason };
		book.dirtySince = null;
		// The last screen at exit (FR-8), then the record, then the event.
		await this.options.store.saveScreen(book.record.id, await book.session.screen(FLEET_SESSION_REPLAY_LINES));
		await this.options.store.save(book.record);
		this.emit({ event: 'exited', id: book.record.id, exitCode, reason, at: endedAt });
	}

	private emit(event: DaemonWatchEvent): void {
		for (const watcher of [...this.watchers]) {
			try {
				watcher(event);
			} catch (error) {
				this.options.log?.(`watch listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
