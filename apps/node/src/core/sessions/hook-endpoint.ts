import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	FLEET_SESSION_HOOK_BAD_TOKEN_ALERT,
	FLEET_SESSION_HOOK_BODY_MAX_BYTES,
	isFleetDaemonSessionId
} from '@ever-works/contracts';

/**
 * Session status (FL-05, plan §3, §6.1, spec FR-1 … FR-6) — the node's
 * loopback HOOK ENDPOINT: the one channel through which an agent CLI running
 * in a session tells the node what it is doing (a prompt was submitted, a
 * tool wants permission, a question is being asked, the turn stopped).
 *
 * The three defences of the MCP bridge (`executors/mcp-bridge.ts`):
 *
 *  - **loopback only** — bound to `127.0.0.1` on an ephemeral port, and every
 *    request's peer address re-checked (FR-1);
 *  - **a token minted at every start** (`randomBytes(32)`), checked in
 *    constant time BEFORE a byte of the body is read — a bad token is
 *    answered at once and the body is never consumed (FR-3, U4);
 *  - **limited paths** — `POST /hook/claude` and `POST /hook/codex` only.
 *
 * Every authenticated, well-formed request is answered `204` with an empty
 * body, whatever it carried: the endpoint never returns anything a CLI could
 * read as a decision (plan §11 threat b). The body is capped at
 * {@link FLEET_SESSION_HOOK_BODY_MAX_BYTES}; an event for a session this node
 * does not hold is dropped and counted, never guessed (U3).
 *
 * Not a network listener in the README D2 sense: like the session daemon's
 * local socket (R-26) it is reachable only from this machine, and only with a
 * token that sits in a file only the enrolling user can read.
 */

export const HOOK_TOKEN_HEADER = 'x-ever-works-hook-token';
export const HOOK_SESSION_HEADER = 'x-ever-works-session';

/** The CLIs that post here (the path segment). */
export const HOOK_PROVIDERS = ['claude', 'codex'] as const;
export type HookProvider = (typeof HOOK_PROVIDERS)[number];

/** One authenticated event, as the status pipeline receives it. */
export interface HookEndpointEvent {
	sessionId: string;
	provider: HookProvider;
	/** The CLI's payload, parsed (untrusted: every reader checks its shape). */
	body: unknown;
	/** When the node received it (ms) — or, for a spooled event, when the hook fired. */
	at: number;
	/** Applied from the spool after the node was down (U2). */
	spooled?: boolean;
}

export interface HookEndpointCounters {
	ok: number;
	badToken: number;
	unknownSession: number;
	malformed: number;
	/** Events applied from the spool. */
	spooled: number;
}

export interface HookEndpointOptions {
	/** Whether the session daemon holds this session right now (U3). */
	isKnownSession: (sessionId: string) => boolean;
	/** Every accepted event, in arrival order. Must not throw (it is caught and logged anyway). */
	onEvent: (event: HookEndpointEvent) => void;
	now?: () => number;
	/** Test seam: a fixed token. */
	token?: string;
	/** Test seam: the server factory. */
	createServer?: typeof http.createServer;
	warn?: (message: string) => void;
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackPeer(address: string | undefined): boolean {
	return typeof address === 'string' && LOOPBACK_PEERS.has(address);
}

function tokensMatch(expected: string, presented: unknown): boolean {
	if (typeof presented !== 'string' || presented.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
	} catch {
		return false;
	}
}

export class HookEndpoint {
	private server: http.Server | null = null;
	private port: number | null = null;
	private readonly token: string;
	private readonly now: () => number;
	private readonly counters: HookEndpointCounters = {
		ok: 0,
		badToken: 0,
		unknownSession: 0,
		malformed: 0,
		spooled: 0
	};
	/** Times of the most recent bad-token requests (bounded) — FR-6's per-minute count. */
	private readonly badTokenTimes: number[] = [];

	constructor(private readonly options: HookEndpointOptions) {
		this.token = options.token ?? randomBytes(32).toString('hex');
		this.now = options.now ?? (() => Date.now());
	}

	/** Listen on `127.0.0.1:0`; answers the port and the token for the endpoint file. */
	async start(): Promise<{ port: number; token: string }> {
		if (this.server && this.port !== null) return { port: this.port, token: this.token };
		const create = this.options.createServer ?? http.createServer;
		const server = create((request, response) => this.handle(request, response));
		// A CLI's hook is one short request; nothing here is long-lived.
		server.headersTimeout = 5_000;
		server.requestTimeout = 5_000;
		server.keepAliveTimeout = 1_000;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				server.off('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
		});
		server.on('error', (error) => this.options.warn?.(`Session hook endpoint: ${error.message}`));
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address.port !== 'number') {
			server.close();
			throw new Error('the session hook endpoint did not get a port');
		}
		this.server = server;
		this.port = address.port;
		return { port: address.port, token: this.token };
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.port = null;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** The listening port, or null. */
	get listeningPort(): number | null {
		return this.port;
	}

	snapshotCounters(): HookEndpointCounters {
		return { ...this.counters };
	}

	/** Bad-token requests in the last minute (FR-6: surfaced on the computer page from 20). */
	badTokenLastMinute(): number {
		const cutoff = this.now() - 60_000;
		while (this.badTokenTimes.length > 0 && this.badTokenTimes[0] < cutoff) this.badTokenTimes.shift();
		return this.badTokenTimes.length;
	}

	/** True when the bad-token rate crossed the alert line (FR-6). */
	badTokenAlert(): boolean {
		return this.badTokenLastMinute() >= FLEET_SESSION_HOOK_BAD_TOKEN_ALERT;
	}

	/**
	 * Apply one spooled event (U2) — the same checks as a live request minus
	 * the token (the spool sits in the user-only state folder): a known
	 * session, a known provider, a parsed body.
	 */
	ingestSpooled(sessionId: string, provider: string, raw: string, at: number): boolean {
		if (!isFleetDaemonSessionId(sessionId) || !(HOOK_PROVIDERS as readonly string[]).includes(provider)) {
			this.counters.malformed += 1;
			return false;
		}
		if (!this.options.isKnownSession(sessionId)) {
			this.counters.unknownSession += 1;
			return false;
		}
		const body = parseBody(raw);
		if (body === undefined) {
			this.counters.malformed += 1;
			return false;
		}
		this.counters.spooled += 1;
		this.emit({ sessionId, provider: provider as HookProvider, body, at, spooled: true });
		return true;
	}

	private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
		const refuse = (status: number) => {
			// Answered before the body is read; the connection is not reused.
			response.setHeader('Connection', 'close');
			response.writeHead(status);
			response.end();
		};
		if (!isLoopbackPeer(request.socket.remoteAddress)) {
			refuse(403);
			request.socket.destroy();
			return;
		}
		if (!tokensMatch(this.token, request.headers[HOOK_TOKEN_HEADER])) {
			this.counters.badToken += 1;
			this.badTokenTimes.push(this.now());
			if (this.badTokenTimes.length > 1_000) this.badTokenTimes.shift();
			refuse(403);
			return;
		}
		const url = request.url ?? '';
		const match = /^\/hook\/(claude|codex)\/?(?:\?.*)?$/.exec(url);
		if (request.method !== 'POST' || !match) {
			refuse(404);
			return;
		}
		const provider = match[1] as HookProvider;
		const sessionHeader = request.headers[HOOK_SESSION_HEADER];
		const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
		const receivedAt = this.now();

		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		request.on('data', (chunk: Buffer) => {
			if (overflowed) return;
			size += chunk.byteLength;
			if (size > FLEET_SESSION_HOOK_BODY_MAX_BYTES) {
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		request.on('error', () => undefined);
		request.on('end', () => {
			// Answer first: the CLI never waits on what the node does with the event (FR-3).
			response.writeHead(204);
			response.end();
			if (overflowed) {
				this.counters.malformed += 1;
				return;
			}
			if (!isFleetDaemonSessionId(sessionId) || !this.options.isKnownSession(sessionId)) {
				this.counters.unknownSession += 1;
				return;
			}
			const body = parseBody(Buffer.concat(chunks).toString('utf8'));
			if (body === undefined) {
				this.counters.malformed += 1;
				return;
			}
			this.counters.ok += 1;
			this.emit({ sessionId, provider, body, at: receivedAt });
		});
	}

	private emit(event: HookEndpointEvent): void {
		try {
			this.options.onEvent(event);
		} catch (error) {
			this.options.warn?.(
				`Session hook event for ${event.sessionId} not applied: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}

/** A hook body: JSON (Claude's stdin, Codex's notify argument). `undefined` when it is not JSON. */
function parseBody(raw: string): unknown {
	const text = raw.trim();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
