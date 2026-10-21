import {
	FLEET_SESSION_REPLAY_LINES,
	FLEET_SESSION_SLOW_VIEWER_BYTES,
	FLEET_SESSION_SLOW_VIEWER_MS,
	type FleetSessionAttachRole,
	type FleetSessionEndedReason,
	type FleetSessionKind,
	type FleetSessionNotice,
	type FleetSessionProvider,
	type FleetSessionStarter
} from '@ever-works/contracts';
import {
	DAEMON_FRAME,
	encodeDaemonExit,
	encodeDaemonFrame,
	encodeDaemonJson,
	type DaemonSessionInfo
} from './daemon-protocol';
import { ScreenGrid, stripTerminalResponses } from './screen-grid';
import type { SessionProcess } from './session-process';

/**
 * Sessions on computers (FL-04) — one session inside the daemon: its process,
 * its headless screen, and everyone attached to it (spec FR-4 … FR-9, U10,
 * U11, U16).
 *
 * Attachments are viewers and drivers. Rules held here:
 *
 *  - **Output fans out** to every attachment as `DATA`; one that cannot keep
 *    up — more than {@link FLEET_SESSION_SLOW_VIEWER_BYTES} queued, or
 *    nothing drained for {@link FLEET_SESSION_SLOW_VIEWER_MS} — is dropped
 *    with a `slow-viewer` notice. Nobody else, and never the process, waits
 *    for a slow tab (FR-7).
 *  - **Replay.** A new attachment gets the screen as of the instant it
 *    attached and then the live stream, with no overlap and no gap (the
 *    grid takes the snapshot at the exact write marker; live output is held
 *    for the attachment meanwhile).
 *  - **Viewers never type.** Input from a viewer is dropped, whatever it is.
 *  - **The newest driver sizes the terminal** (FR-6); a viewer's size is
 *    ignored. When that driver leaves, the next newest one's size applies.
 *  - **Several drivers may type** (U10, OWNER-QUESTIONS A8 default); terminal
 *    answers (cursor reports, device attributes) are taken only from the
 *    newest driver, so a program asking once is answered once.
 *  - **Nobody driving → the grid answers** the program's terminal queries
 *    itself (FR-5).
 *  - **Input blocked** (the kill switch, R-24) drops every keystroke while
 *    leaving the process running.
 */

/** One attached connection, as the session sees it. */
export interface DaemonAttachment {
	readonly id: number;
	readonly mode: FleetSessionAttachRole;
	/** Send one encoded frame. False when the connection is gone. */
	send(frame: Buffer): boolean;
	/** Bytes written but not yet flushed to the peer. */
	bufferedBytes(): number;
	/** Epoch ms the connection last had nothing queued. */
	lastDrainAt(): number;
	close(reason: string): void;
}

interface AttachmentEntry {
	attachment: DaemonAttachment;
	/** Live output held while the replay is being taken; null once live. */
	pending: Buffer[] | null;
	/** Attach order: higher is newer. */
	order: number;
	/** The size a driver last asked for. */
	size: { cols: number; rows: number } | null;
	/** The `EXIT` frame was sent or queued for it. */
	exitSent: boolean;
}

export interface DaemonSessionInit {
	id: string;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	cwd: string;
	title: string;
	startedAt: string;
	startedBy: FleetSessionStarter;
	cols: number;
	rows: number;
}

export interface DaemonSessionHooks {
	now(): number;
	/** Output was printed (the daemon throttles `activity` and marks the screen dirty). */
	onOutput(session: DaemonSession): void;
	onExit(session: DaemonSession): void;
}

export class DaemonSession {
	readonly id: string;
	readonly kind: FleetSessionKind;
	readonly provider: FleetSessionProvider;
	readonly cwd: string;
	readonly startedAt: string;
	readonly startedBy: FleetSessionStarter;
	title: string;
	readonly grid: ScreenGrid;
	private process: SessionProcess | null = null;
	private readonly entries = new Map<number, AttachmentEntry>();
	private nextOrder = 1;
	private exitCode: number | null = null;
	private ended = false;
	private endReason: FleetSessionEndedReason | null = null;
	/** Found in the store after a daemon restart: no process, the persisted screen only. */
	private lostScreen: string | null = null;
	private lostFlag = false;
	private inputBlocked = false;

	constructor(
		init: DaemonSessionInit,
		private readonly hooks: DaemonSessionHooks
	) {
		this.id = init.id;
		this.kind = init.kind;
		this.provider = init.provider;
		this.cwd = init.cwd;
		this.title = init.title;
		this.startedAt = init.startedAt;
		this.startedBy = init.startedBy;
		this.grid = new ScreenGrid(init.cols, init.rows);
		// Nobody driving: the emulator answers the program's questions (FR-5).
		this.grid.onResponse((answer) => {
			if (this.driverCount() === 0) this.process?.write(answer);
		});
	}

	/** Bind the running process. */
	attachProcess(process: SessionProcess): void {
		this.process = process;
		process.onData((data) => this.onOutput(data));
		process.onExit((exit) => this.onProcessExit(exit.exitCode));
	}

	/**
	 * A session the store held but no process backs (the daemon restarted):
	 * either one that ENDED and was not yet acknowledged, or — `lost` — one
	 * that was still running when the daemon went away, whose process is gone
	 * with it. Both keep their last persisted screen.
	 */
	restoreEnded(input: {
		screen: string | null;
		exitCode: number | null;
		endReason: FleetSessionEndedReason | null;
		lost: boolean;
	}): void {
		this.ended = true;
		this.lostFlag = input.lost;
		this.exitCode = input.exitCode;
		this.endReason = input.endReason;
		this.lostScreen = input.screen;
		if (input.screen) this.grid.write(input.screen.split('\n').join('\r\n'));
	}

	get alive(): boolean {
		return !this.ended;
	}

	get lost(): boolean {
		return this.lostFlag;
	}

	get exit(): { exitCode: number | null; reason: FleetSessionEndedReason | null } {
		return { exitCode: this.exitCode, reason: this.endReason };
	}

	get pid(): number | null {
		return this.process?.pid ?? null;
	}

	info(): DaemonSessionInfo {
		return {
			id: this.id,
			kind: this.kind,
			provider: this.provider,
			cwd: this.cwd,
			title: this.title,
			startedAt: this.startedAt,
			startedBy: this.startedBy,
			alive: this.alive,
			exitCode: this.exitCode,
			endReason: this.endReason,
			lost: this.lostFlag,
			cols: this.grid.cols,
			rows: this.grid.rows,
			viewers: [...this.entries.values()].filter((entry) => entry.attachment.mode === 'viewer').length,
			drivers: this.driverCount()
		};
	}

	/** The last lines as plain text (the persisted screen for a lost session). */
	async screen(lines: number = FLEET_SESSION_REPLAY_LINES): Promise<string> {
		if (this.lostFlag && this.lostScreen !== null) return this.lostScreen;
		return this.grid.plainText(lines);
	}

	// ─── Attaching ─────────────────────────────────────────────────────────

	get attachmentCount(): number {
		return this.entries.size;
	}

	/**
	 * Attach a connection: `attached` first, then the replay, then live
	 * output. A driver's size applies at once (it is the newest).
	 */
	async attach(attachment: DaemonAttachment, size: { cols: number; rows: number } | null): Promise<void> {
		const entry: AttachmentEntry = {
			attachment,
			pending: [],
			order: this.nextOrder++,
			size: attachment.mode === 'driver' ? size : null,
			exitSent: false
		};
		this.entries.set(attachment.id, entry);
		if (attachment.mode === 'driver' && size) this.applySize(size.cols, size.rows);
		// The snapshot marker is queued in this same tick as `pending` began.
		const replay = await this.grid.replay(FLEET_SESSION_REPLAY_LINES);
		if (this.entries.get(attachment.id) !== entry) return;
		const ok =
			attachment.send(
				encodeDaemonJson({
					type: 'attached',
					alive: this.alive,
					cols: this.grid.cols,
					rows: this.grid.rows,
					exitCode: this.exitCode
				})
			) &&
			(replay.length === 0 || attachment.send(encodeDaemonFrame(DAEMON_FRAME.DATA, Buffer.from(replay, 'utf8'))));
		const pending = entry.pending ?? [];
		entry.pending = null;
		if (!ok) {
			this.detach(attachment.id);
			return;
		}
		for (const chunk of pending) {
			if (!this.deliver(entry, chunk)) return;
		}
		if (this.inputBlocked) this.sendNotice(entry, { type: 'session.notice', notice: 'paused' });
		if (!this.alive && !entry.exitSent) {
			entry.exitSent = true;
			attachment.send(encodeDaemonExit(this.exitCode));
		}
	}

	detach(attachmentId: number): void {
		const entry = this.entries.get(attachmentId);
		if (!entry) return;
		this.entries.delete(attachmentId);
		if (entry.attachment.mode === 'driver') {
			// The next newest driver's size applies; with none left the size stays.
			const next = this.newestDriver();
			if (next?.size) this.applySize(next.size.cols, next.size.rows);
		}
	}

	/** Keystrokes from an attachment. Dropped from viewers, while blocked, and once ended. */
	input(attachmentId: number, data: string): void {
		const entry = this.entries.get(attachmentId);
		if (!entry || entry.attachment.mode !== 'driver') return;
		this.write(data, entry === this.newestDriver());
	}

	/** Input that does not come from an attachment (the composer, a tool's `send`). */
	writeInput(data: string): boolean {
		if (!this.alive || this.inputBlocked) return false;
		this.process?.write(data);
		return true;
	}

	private write(data: string, fromNewestDriver: boolean): void {
		if (!this.alive || this.inputBlocked) return;
		const text = fromNewestDriver ? data : stripTerminalResponses(data);
		if (text.length > 0) this.process?.write(text);
	}

	/** A driver asked for a size; only the newest driver's applies. */
	resizeFrom(attachmentId: number, cols: number, rows: number): void {
		const entry = this.entries.get(attachmentId);
		if (!entry || entry.attachment.mode !== 'driver') return;
		entry.size = { cols, rows };
		if (entry === this.newestDriver()) this.applySize(cols, rows);
	}

	/** Resize from the control connection (the platform's own request). */
	resize(cols: number, rows: number): void {
		this.applySize(cols, rows);
	}

	private applySize(cols: number, rows: number): void {
		if (cols === this.grid.cols && rows === this.grid.rows) return;
		this.grid.resize(cols, rows);
		this.process?.resize(cols, rows);
		this.broadcast({ type: 'session.notice', notice: 'size', cols, rows });
	}

	setInputBlocked(blocked: boolean, reason?: string): void {
		if (this.inputBlocked === blocked) return;
		this.inputBlocked = blocked;
		this.broadcast(
			blocked
				? { type: 'session.notice', notice: 'paused', ...(reason ? { reason } : {}) }
				: { type: 'session.notice', notice: 'resumed' }
		);
	}

	warn(seconds: number): void {
		this.broadcast({ type: 'session.notice', notice: 'drain', seconds: Math.max(0, Math.floor(seconds)) });
	}

	/** Stop the process (terminate, then kill after the grace). */
	end(reason: FleetSessionEndedReason, graceMs?: number): boolean {
		if (!this.alive || !this.process) return false;
		if (this.endReason === null) this.endReason = reason;
		this.process.end(graceMs);
		return true;
	}

	/**
	 * Drop attachments that cannot keep up (FR-7): too much queued, or
	 * nothing drained for {@link FLEET_SESSION_SLOW_VIEWER_MS}. Called by the
	 * daemon's tick and after every write.
	 */
	dropSlow(now: number = this.hooks.now()): void {
		for (const entry of [...this.entries.values()]) this.checkSlow(entry, now);
	}

	dispose(): void {
		for (const entry of [...this.entries.values()]) entry.attachment.close('normal');
		this.entries.clear();
		this.grid.dispose();
	}

	// ─── Internals ─────────────────────────────────────────────────────────

	private onOutput(data: string): void {
		this.grid.write(data);
		const frame = encodeDaemonFrame(DAEMON_FRAME.DATA, Buffer.from(data, 'utf8'));
		for (const entry of [...this.entries.values()]) {
			if (entry.pending) entry.pending.push(frame);
			else this.deliver(entry, frame);
		}
		this.hooks.onOutput(this);
	}

	private onProcessExit(exitCode: number | null): void {
		if (this.ended) return;
		this.ended = true;
		this.exitCode = exitCode;
		const frame = encodeDaemonExit(exitCode);
		for (const entry of [...this.entries.values()]) {
			entry.exitSent = true;
			if (entry.pending) entry.pending.push(frame);
			else entry.attachment.send(frame);
		}
		this.hooks.onExit(this);
	}

	private deliver(entry: AttachmentEntry, frame: Buffer): boolean {
		if (!entry.attachment.send(frame)) {
			this.detach(entry.attachment.id);
			return false;
		}
		return this.checkSlow(entry, this.hooks.now());
	}

	/** True when the attachment is still attached afterwards. */
	private checkSlow(entry: AttachmentEntry, now: number): boolean {
		const queued = entry.attachment.bufferedBytes();
		const stalled = queued > 0 && now - entry.attachment.lastDrainAt() >= FLEET_SESSION_SLOW_VIEWER_MS;
		if (queued <= FLEET_SESSION_SLOW_VIEWER_BYTES && !stalled) return true;
		this.entries.delete(entry.attachment.id);
		this.sendNotice(entry, { type: 'session.notice', notice: 'slow-viewer' });
		entry.attachment.close('slow-viewer');
		if (entry.attachment.mode === 'driver') {
			const next = this.newestDriver();
			if (next?.size) this.applySize(next.size.cols, next.size.rows);
		}
		return false;
	}

	private broadcast(notice: FleetSessionNotice): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.pending) entry.pending.push(encodeDaemonJson(notice));
			else this.sendNotice(entry, notice);
		}
	}

	private sendNotice(entry: AttachmentEntry, notice: FleetSessionNotice): void {
		entry.attachment.send(encodeDaemonJson(notice));
	}

	private driverCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) if (entry.attachment.mode === 'driver') count += 1;
		return count;
	}

	private newestDriver(): AttachmentEntry | null {
		let newest: AttachmentEntry | null = null;
		for (const entry of this.entries.values()) {
			if (entry.attachment.mode !== 'driver') continue;
			if (!newest || entry.order > newest.order) newest = entry;
		}
		return newest;
	}
}
