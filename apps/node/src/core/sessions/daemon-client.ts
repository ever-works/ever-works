import * as net from 'node:net';
import type { FleetLinkErrorCode, FleetSessionAttachRole } from '@ever-works/contracts';
import {
	DAEMON_FRAME,
	DaemonFrameReader,
	decodeDaemonJson,
	encodeDaemonFrame,
	encodeDaemonJson,
	encodeDaemonResize,
	type DaemonError,
	type DaemonFrameKind,
	type DaemonHealth,
	type DaemonWatchEvent
} from './daemon/daemon-protocol';

/**
 * Sessions on computers (FL-04) — the node's end of the local socket to its
 * session daemon (CONTRACTS R-26).
 *
 *  - {@link DaemonControlClient}: one request/reply connection (ops by id,
 *    plus the `watch` event stream). The node holds one open for as long as
 *    it runs, which is also what keeps the daemon from its idle exit.
 *  - {@link openDaemonAttach}: one connection per attached viewer, carrying
 *    the terminal's frames both ways.
 *
 * Both send the hello (with the token) first and nothing else until the
 * daemon answered it — the daemon closes a connection that pipelines past
 * an unchecked hello.
 */

export type ConnectFn = (socketPath: string) => net.Socket;

export const defaultConnect: ConnectFn = (socketPath) => net.connect(socketPath);

/** A typed refusal from the daemon. */
export class DaemonRequestError extends Error {
	constructor(
		readonly code: FleetLinkErrorCode,
		readonly hint: string
	) {
		super(hint);
		this.name = 'DaemonRequestError';
	}
}

export interface DaemonConnectOptions {
	socketPath: string;
	token: string;
	nodeVersion?: string;
	connect?: ConnectFn;
	/** How long the hello may take to be answered. */
	timeoutMs?: number;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export class DaemonControlClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly eventListeners = new Set<(event: DaemonWatchEvent) => void>();
	private readonly closeListeners = new Set<() => void>();
	private closed = false;
	private watching = false;

	private constructor(
		private readonly socket: net.Socket,
		readonly welcome: DaemonHealth
	) {}

	/** Connect, say hello, and resolve once the daemon welcomed this node. */
	static connect(options: DaemonConnectOptions): Promise<DaemonControlClient> {
		const connect = options.connect ?? defaultConnect;
		return new Promise((resolve, reject) => {
			let settled = false;
			let client: DaemonControlClient | null = null;
			const socket = connect(options.socketPath);
			const reader = new DaemonFrameReader();
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(new Error('the session daemon did not answer'));
			}, options.timeoutMs ?? 5_000);
			timer.unref?.();
			socket.once('error', (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			});
			socket.on('close', () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error('the session daemon closed the connection'));
				}
				client?.onSocketClosed();
			});
			socket.on('connect', () => {
				socket.write(
					encodeDaemonJson({
						op: 'hello',
						token: options.token,
						role: 'control',
						...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {})
					})
				);
			});
			socket.on('data', (chunk: Buffer) => {
				const frames = reader.push(chunk);
				if (!frames) {
					socket.destroy();
					return;
				}
				for (const frame of frames) {
					if (frame.kind !== DAEMON_FRAME.JSON) continue;
					const message = decodeDaemonJson(frame.payload);
					if (!message) continue;
					if (!client) {
						if (message.type !== 'welcome') continue;
						settled = true;
						clearTimeout(timer);
						const { type: _type, ...health } = message;
						client = new DaemonControlClient(socket, health as unknown as DaemonHealth);
						socket.on('error', () => socket.destroy());
						resolve(client);
						continue;
					}
					client.onMessage(message);
				}
			});
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** One op; resolves its result or rejects a {@link DaemonRequestError}. */
	request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
		if (this.closed)
			return Promise.reject(new DaemonRequestError('unreachable', 'the session daemon is not connected'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new DaemonRequestError('unreachable', 'the session daemon did not answer'));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.socket.write(encodeDaemonJson({ ...params, id, op }));
		});
	}

	/** Subscribe to the session event stream (asks the daemon once). */
	onEvent(listener: (event: DaemonWatchEvent) => void): () => void {
		this.eventListeners.add(listener);
		if (!this.watching) {
			this.watching = true;
			this.request('watch').catch(() => {
				this.watching = false;
			});
		}
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => undefined;
		}
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	close(): void {
		this.socket.destroy();
	}

	private onMessage(message: Record<string, unknown>): void {
		if (message.type === 'event') {
			const { type: _type, ...event } = message;
			for (const listener of [...this.eventListeners]) {
				try {
					listener(event as unknown as DaemonWatchEvent);
				} catch {
					// a listener's failure is its own
				}
			}
			return;
		}
		if (typeof message.id !== 'number') return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok === true) pending.resolve(message.result);
		else {
			const error = (message.error ?? {}) as Partial<DaemonError>;
			pending.reject(
				new DaemonRequestError(
					(typeof error.code === 'string' ? error.code : 'internal') as FleetLinkErrorCode,
					typeof error.hint === 'string' ? error.hint : 'the session daemon refused'
				)
			);
		}
	}

	private onSocketClosed(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new DaemonRequestError('unreachable', 'the session daemon connection closed'));
			this.pending.delete(id);
		}
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch {
				// a listener's failure is its own
			}
		}
		this.closeListeners.clear();
	}
}

// ─── Attach ─────────────────────────────────────────────────────────────────

export interface DaemonAttachInfo {
	alive: boolean;
	cols: number;
	rows: number;
	exitCode: number | null;
}

export interface DaemonAttachStream {
	readonly info: DaemonAttachInfo;
	/** Every frame after `attached`: the replay `DATA`, live `DATA`, `RESIZE`, `EXIT`, `JSON` notices, `CLOSE`. */
	onFrame(listener: (kind: DaemonFrameKind, payload: Uint8Array) => void): void;
	onClose(listener: () => void): void;
	/** Keystrokes (a driver's; the daemon drops a viewer's). */
	sendInput(data: Uint8Array): boolean;
	sendResize(cols: number, rows: number): boolean;
	close(): void;
}

export interface DaemonAttachOptions extends DaemonConnectOptions {
	sessionId: string;
	mode: FleetSessionAttachRole;
	cols?: number;
	rows?: number;
}

/**
 * Attach to one session. Resolves after the daemon's `attached` answer; the
 * frames that follow it (the replay first) are delivered to `onFrame` in
 * order — those that arrive before a listener is set are held for it.
 */
export function openDaemonAttach(options: DaemonAttachOptions): Promise<DaemonAttachStream> {
	const connect = options.connect ?? defaultConnect;
	return new Promise((resolve, reject) => {
		const socket = connect(options.socketPath);
		const reader = new DaemonFrameReader();
		let settled = false;
		let frameListener: ((kind: DaemonFrameKind, payload: Uint8Array) => void) | null = null;
		const held: Array<[DaemonFrameKind, Uint8Array]> = [];
		const closeListeners: Array<() => void> = [];
		let closed = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new DaemonRequestError('unreachable', 'the session daemon did not answer'));
		}, options.timeoutMs ?? 5_000);
		timer.unref?.();
		const deliver = (kind: DaemonFrameKind, payload: Uint8Array) => {
			if (frameListener) frameListener(kind, payload);
			else held.push([kind, payload]);
		};
		socket.once('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new DaemonRequestError('unreachable', 'the session daemon closed the connection'));
			}
			if (closed) return;
			closed = true;
			for (const listener of closeListeners) {
				try {
					listener();
				} catch {
					// a listener's failure is its own
				}
			}
		});
		socket.on('connect', () => {
			socket.write(
				encodeDaemonJson({
					op: 'hello',
					token: options.token,
					role: 'attach',
					...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
					attach: {
						id: options.sessionId,
						mode: options.mode,
						...(options.cols !== undefined ? { cols: options.cols } : {}),
						...(options.rows !== undefined ? { rows: options.rows } : {})
					}
				})
			);
		});
		socket.on('data', (chunk: Buffer) => {
			const frames = reader.push(chunk);
			if (!frames) {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (!settled) {
					if (frame.kind !== DAEMON_FRAME.JSON) continue;
					const message = decodeDaemonJson(frame.payload);
					if (message?.type === 'refused') {
						settled = true;
						clearTimeout(timer);
						const error = (message.error ?? {}) as Partial<DaemonError>;
						reject(
							new DaemonRequestError(
								(typeof error.code === 'string' ? error.code : 'internal') as FleetLinkErrorCode,
								typeof error.hint === 'string' ? error.hint : 'the session daemon refused'
							)
						);
						socket.destroy();
						return;
					}
					if (message?.type !== 'attached') continue;
					settled = true;
					clearTimeout(timer);
					const info: DaemonAttachInfo = {
						alive: message.alive === true,
						cols: typeof message.cols === 'number' ? message.cols : 0,
						rows: typeof message.rows === 'number' ? message.rows : 0,
						exitCode: typeof message.exitCode === 'number' ? message.exitCode : null
					};
					resolve({
						info,
						onFrame(listener) {
							frameListener = listener;
							for (const [kind, payload] of held.splice(0)) listener(kind, payload);
						},
						onClose(listener) {
							if (closed) listener();
							else closeListeners.push(listener);
						},
						sendInput(data) {
							if (socket.destroyed) return false;
							socket.write(encodeDaemonFrame(DAEMON_FRAME.DATA, data));
							return true;
						},
						sendResize(cols, rows) {
							if (socket.destroyed) return false;
							socket.write(encodeDaemonResize(cols, rows));
							return true;
						},
						close() {
							if (socket.destroyed) return;
							socket.end(encodeDaemonFrame(DAEMON_FRAME.CLOSE, Buffer.from('normal', 'utf8')));
							setTimeout(() => socket.destroy(), 1000).unref?.();
						}
					});
					continue;
				}
				deliver(frame.kind, frame.payload);
			}
		});
	});
}
