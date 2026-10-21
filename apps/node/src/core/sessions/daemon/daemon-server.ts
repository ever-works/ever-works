import { createHash, timingSafeEqual } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { clampFleetSessionSize } from '@ever-works/contracts';
import type { DaemonCore } from './daemon-core';
import { isNamedPipe } from './daemon-paths';
import {
	clampScreenLines,
	DAEMON_FRAME,
	DAEMON_HELLO_TIMEOUT_MS,
	DAEMON_MAX_HELLO_BYTES,
	DAEMON_MAX_PAYLOAD_BYTES,
	DaemonFrameReader,
	decodeDaemonJson,
	decodeDaemonResize,
	encodeDaemonFrame,
	encodeDaemonJson,
	parseDaemonHello,
	parseDaemonStartRequest,
	parseEndReason,
	type DaemonError,
	type DaemonFrame,
	type DaemonHello
} from './daemon-protocol';
import type { DaemonAttachment } from './daemon-session';

/**
 * Sessions on computers (FL-04) — the daemon's local socket (CONTRACTS R-26,
 * spec FR-3).
 *
 * A Unix domain socket (mode 0600, inside the owner-only state dir) or a
 * Windows named pipe. Every connection must open with a `hello` carrying the
 * token from the token file — compared in constant time, re-read on every
 * hello so a rotated file takes effect without a restart — and NOTHING else
 * is read or answered before it: a frame larger than a hello, an unknown
 * kind, a wrong token or five seconds of silence close the connection.
 *
 * A control connection keeps the daemon from its idle exit for as long as
 * it is open (the node holds one while it runs).
 */

export interface DaemonServerOptions {
	core: DaemonCore;
	socketPath: string;
	/** Read the expected token (the token file), or null when it is missing. */
	readToken: () => Promise<string | null>;
	log?: (message: string) => void;
	now?: () => number;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function tokensMatch(expected: string, presented: string): boolean {
	return timingSafeEqual(digest(expected), digest(presented));
}

export class DaemonServer {
	private server: net.Server | null = null;
	private readonly sockets = new Set<net.Socket>();
	private nextAttachmentId = 1;
	private readonly now: () => number;

	constructor(private readonly options: DaemonServerOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Start listening. A stale Unix socket file left by a dead daemon is
	 * replaced; a LIVE one means another daemon already serves this state
	 * dir, which is refused (`EADDRINUSE`) rather than stolen.
	 */
	async listen(): Promise<void> {
		const { socketPath } = this.options;
		if (!isNamedPipe(socketPath)) {
			await fsp.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
			if (await this.isStale(socketPath)) await fsp.rm(socketPath, { force: true });
		}
		const server = net.createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
				server.off('error', reject);
				resolve();
			});
		});
		server.on('error', (error) => this.options.log?.(`daemon socket error: ${error.message}`));
		if (!isNamedPipe(socketPath)) {
			try {
				await fsp.chmod(socketPath, 0o600);
			} catch {
				// the 0700 directory still guards it
			}
		}
		this.server = server;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** A socket file nobody answers on is stale; ENOENT is "nothing there". */
	private async isStale(socketPath: string): Promise<boolean> {
		try {
			await fsp.stat(socketPath);
		} catch {
			return false;
		}
		return new Promise((resolve) => {
			const probe = net.connect(socketPath);
			probe.once('connect', () => {
				probe.destroy();
				resolve(false);
			});
			probe.once('error', () => resolve(true));
		});
	}

	private accept(socket: net.Socket): void {
		this.sockets.add(socket);
		const reader = new DaemonFrameReader(DAEMON_MAX_HELLO_BYTES);
		let stage: 'hello' | 'checking' | 'control' | 'attach' = 'hello';
		let cleanup: (() => void) | null = null;
		let handler: ((frame: DaemonFrame) => void) | null = null;
		const helloTimer = setTimeout(() => socket.destroy(), DAEMON_HELLO_TIMEOUT_MS);
		helloTimer.unref?.();

		const finish = () => {
			clearTimeout(helloTimer);
			this.sockets.delete(socket);
			cleanup?.();
			cleanup = null;
		};
		socket.on('close', finish);
		socket.on('error', () => socket.destroy());

		socket.on('data', (chunk: Buffer) => {
			if (stage === 'checking') {
				// Nothing is read past the hello until the token was checked.
				socket.destroy();
				return;
			}
			const frames = reader.push(chunk);
			if (!frames) {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (stage === 'hello') {
					if (frames.length > 1 || frame.kind !== DAEMON_FRAME.JSON) {
						socket.destroy();
						return;
					}
					const hello = parseDaemonHello(decodeDaemonJson(frame.payload));
					if (!hello) {
						socket.destroy();
						return;
					}
					stage = 'checking';
					void this.authenticate(hello).then((ok) => {
						if (!ok || socket.destroyed) {
							socket.destroy();
							return;
						}
						clearTimeout(helloTimer);
						reader.setMaxPayload(DAEMON_MAX_PAYLOAD_BYTES);
						if (hello.role === 'control') {
							stage = 'control';
							const control = this.controlConnection(socket);
							handler = control.onFrame;
							cleanup = control.cleanup;
						} else {
							stage = 'attach';
							const attach = this.attachConnection(socket, hello);
							handler = attach.onFrame;
							cleanup = attach.cleanup;
						}
					});
					return;
				}
				handler?.(frame);
			}
		});
	}

	private async authenticate(hello: DaemonHello): Promise<boolean> {
		let expected: string | null = null;
		try {
			expected = await this.options.readToken();
		} catch {
			expected = null;
		}
		return expected !== null && expected.length >= 16 && tokensMatch(expected, hello.token);
	}

	// ─── Control ───────────────────────────────────────────────────────────

	private controlConnection(socket: net.Socket): { onFrame: (frame: DaemonFrame) => void; cleanup: () => void } {
		const { core } = this.options;
		const release = core.nodeConnected();
		let unwatch: (() => void) | null = null;
		const send = (message: unknown) => {
			if (!socket.destroyed) socket.write(encodeDaemonJson(message));
		};
		send({ type: 'welcome', ...core.health() });
		const reply = (id: number, result: unknown) => send({ id, ok: true, result });
		const fail = (id: number, error: DaemonError) => send({ id, ok: false, error });
		const isError = (value: unknown): value is DaemonError =>
			typeof value === 'object' && value !== null && 'code' in value && 'hint' in value;

		const onFrame = (frame: DaemonFrame) => {
			if (frame.kind !== DAEMON_FRAME.JSON) return;
			const message = decodeDaemonJson(frame.payload);
			if (!message) return;
			const id = typeof message.id === 'number' && Number.isInteger(message.id) ? message.id : -1;
			if (id < 0 || typeof message.op !== 'string') return;
			void (async () => {
				switch (message.op) {
					case 'health':
						return reply(id, core.health());
					case 'list':
						return reply(id, { sessions: core.list() });
					case 'start': {
						const request = parseDaemonStartRequest(message);
						if (isError(request)) return fail(id, request);
						const started = await core.start(request);
						return isError(started) ? fail(id, started) : reply(id, started);
					}
					case 'rename': {
						if (typeof message.sessionId !== 'string' || typeof message.title !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId and title' });
						const error = await core.rename(message.sessionId, message.title);
						return error ? fail(id, error) : reply(id, { ok: true });
					}
					case 'end': {
						if (typeof message.sessionId !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId' });
						const graceMs =
							typeof message.graceMs === 'number' && Number.isFinite(message.graceMs)
								? Math.min(60_000, Math.max(0, message.graceMs))
								: undefined;
						const ended = core.end(message.sessionId, parseEndReason(message.reason), graceMs);
						return isError(ended) ? fail(id, ended) : reply(id, ended);
					}
					case 'input': {
						if (typeof message.sessionId !== 'string' || typeof message.data !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId and data' });
						const result = core.input(message.sessionId, message.data);
						return isError(result) ? fail(id, result) : reply(id, result);
					}
					case 'resize': {
						if (typeof message.sessionId !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId' });
						const size = clampFleetSessionSize(message.cols, message.rows);
						const error = core.resize(message.sessionId, size.cols, size.rows);
						return error ? fail(id, error) : reply(id, size);
					}
					case 'screen': {
						if (typeof message.sessionId !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId' });
						const screen = await core.screen(message.sessionId, clampScreenLines(message.lines));
						return isError(screen) ? fail(id, screen) : reply(id, screen);
					}
					case 'block-input': {
						core.setInputBlocked(
							message.on === true,
							typeof message.reason === 'string' ? message.reason.slice(0, 300) : undefined
						);
						return reply(id, { ok: true });
					}
					case 'warn': {
						if (typeof message.sessionId !== 'string')
							return fail(id, { code: 'invalid', hint: 'sessionId' });
						const seconds = typeof message.seconds === 'number' ? message.seconds : 60;
						const error = core.warn(message.sessionId, seconds);
						return error ? fail(id, error) : reply(id, { ok: true });
					}
					case 'ack-ended': {
						const ids = Array.isArray(message.sessionIds) ? message.sessionIds : [];
						let forgotten = 0;
						for (const sessionId of ids.slice(0, 256)) {
							if (typeof sessionId === 'string' && (await core.ackEnded(sessionId))) forgotten += 1;
						}
						return reply(id, { forgotten });
					}
					case 'watch': {
						unwatch ??= core.watch((event) => send({ type: 'event', ...event }));
						return reply(id, { ok: true });
					}
					default:
						return fail(id, { code: 'invalid', hint: `unknown op ${String(message.op).slice(0, 40)}` });
				}
			})().catch((error: unknown) => {
				fail(id, { code: 'internal', hint: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
			});
		};
		return {
			onFrame,
			cleanup: () => {
				unwatch?.();
				release();
			}
		};
	}

	// ─── Attach ────────────────────────────────────────────────────────────

	private attachConnection(
		socket: net.Socket,
		hello: DaemonHello
	): { onFrame: (frame: DaemonFrame) => void; cleanup: () => void } {
		const { core } = this.options;
		const target = hello.attach!;
		const attachmentId = this.nextAttachmentId++;
		let lastDrainAt = this.now();
		socket.on('drain', () => {
			lastDrainAt = this.now();
		});
		const attachment: DaemonAttachment = {
			id: attachmentId,
			mode: target.mode,
			send: (frame) => {
				if (socket.destroyed) return false;
				socket.write(frame);
				if (socket.writableLength === 0) lastDrainAt = this.now();
				return true;
			},
			bufferedBytes: () => socket.writableLength,
			lastDrainAt: () => (socket.writableLength === 0 ? this.now() : lastDrainAt),
			close: (reason) => {
				if (socket.destroyed) return;
				socket.end(encodeDaemonFrame(DAEMON_FRAME.CLOSE, Buffer.from(reason, 'utf8')));
				setTimeout(() => socket.destroy(), 1000).unref?.();
			}
		};
		const size =
			target.mode === 'driver' && (target.cols !== undefined || target.rows !== undefined)
				? clampFleetSessionSize(target.cols, target.rows)
				: null;
		const attached = core.attach(target.id, attachment, size);
		if (!(attached instanceof Promise)) {
			socket.write(encodeDaemonJson({ type: 'refused', error: attached }));
			socket.end(encodeDaemonFrame(DAEMON_FRAME.CLOSE, Buffer.from(attached.code, 'utf8')));
			return { onFrame: () => undefined, cleanup: () => undefined };
		}
		attached.catch(() => socket.destroy());
		const onFrame = (frame: DaemonFrame) => {
			switch (frame.kind) {
				case DAEMON_FRAME.DATA:
					core.get(target.id)?.input(attachmentId, Buffer.from(frame.payload).toString('utf8'));
					return;
				case DAEMON_FRAME.RESIZE: {
					const next = decodeDaemonResize(frame.payload);
					if (next) core.get(target.id)?.resizeFrom(attachmentId, next.cols, next.rows);
					return;
				}
				case DAEMON_FRAME.CLOSE:
					socket.end();
					return;
				default:
					return;
			}
		};
		return { onFrame, cleanup: () => core.detach(target.id, attachmentId) };
	}
}
