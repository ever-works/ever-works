import { FLEET_LINK_BACKOFF_BASE_MS, FLEET_LINK_BACKOFF_MAX_MS } from '@ever-works/contracts';

/**
 * Fleet node link — the socket mechanics every outbound leg shares.
 *
 * Extracted from the computer-session leg (`screen/node-leg.ts`), which
 * keeps its own exports and its 2-second backoff by delegating here:
 *
 *  - **The secure-origin rule.** A token rides a socket only over TLS
 *    (`wss:`), or over plain `ws:` to this machine's own loopback (local
 *    development). A leg aimed at any other plain-`http:` origin is never
 *    opened, no token is minted for it and none is sent.
 *  - **The URL.** The platform origin plus the path the token mint answered
 *    with; never a query string — the token travels in the first frame.
 *  - **The backoff.** Exponential from a base to a ceiling, with jitter,
 *    reset ONLY when the platform accepted the socket (an open that is then
 *    refused is a failed attempt, not a success).
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when a socket to this platform origin may carry a token: `https:`
 * anywhere, plain `http:` only to a loopback host. Anything unparseable or of
 * another scheme is refused.
 */
export function isSecureLinkOrigin(apiUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(apiUrl);
	} catch {
		return false;
	}
	if (parsed.protocol === 'https:') return true;
	return parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/** `https://api.example.com[/api]` + `/ws/fleet/link` → `wss://api.example.com/ws/fleet/link`. */
export function toLinkWsUrl(apiUrl: string, wsPath: string): string {
	const origin = new URL(apiUrl).origin;
	return `${origin.replace(/^http/, 'ws')}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`;
}

export interface LinkBackoffOptions {
	baseMs?: number;
	maxMs?: number;
	/**
	 * Fraction of the nominal wait added or removed at random (0 = none,
	 * 0.2 = ±20 %). The result never drops below `baseMs` — a node must
	 * not retry faster than the backoff (spec U9) — and never exceeds `maxMs`.
	 */
	jitter?: number;
	/** `Math.random` by default; injected so tests can pin the bounds. */
	random?: () => number;
}

/**
 * Exponential reconnect backoff with jitter: `base · 2^attempt`, capped at
 * the ceiling, then spread by ±`jitter`. `next()` answers the wait before
 * the next attempt and counts it; `reset()` is for an ACCEPTED socket only.
 */
export class LinkBackoff {
	private attempt = 0;
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly jitter: number;
	private readonly random: () => number;

	constructor(options: LinkBackoffOptions = {}) {
		this.baseMs = options.baseMs ?? FLEET_LINK_BACKOFF_BASE_MS;
		this.maxMs = Math.max(this.baseMs, options.maxMs ?? FLEET_LINK_BACKOFF_MAX_MS);
		this.jitter = Math.min(Math.max(options.jitter ?? 0.2, 0), 0.9);
		this.random = options.random ?? Math.random;
	}

	/** Attempts made since the last reset. */
	get attempts(): number {
		return this.attempt;
	}

	/** The nominal (un-jittered) wait for attempt `n`. */
	nominal(attempt: number): number {
		return Math.min(this.baseMs * 2 ** Math.min(Math.max(attempt, 0), 20), this.maxMs);
	}

	next(): number {
		const nominal = this.nominal(this.attempt);
		this.attempt += 1;
		const spread = nominal * this.jitter * (this.random() * 2 - 1);
		return Math.round(Math.min(Math.max(nominal + spread, this.baseMs), this.maxMs));
	}

	reset(): void {
		this.attempt = 0;
	}
}

/**
 * The slice of a WebSocket the link uses. Node's global `WebSocket` (and the
 * browser's) satisfies it; tests hand in a fake.
 */
export interface LinkSocketLike {
	readonly readyState: number;
	binaryType?: string;
	send(data: Uint8Array | ArrayBuffer | string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: { code?: number; reason?: string } | unknown) => void) | null;
}

export type LinkSocketFactory = (url: string) => LinkSocketLike;

/** `WebSocket.OPEN`. */
export const LINK_SOCKET_OPEN = 1;

/** Node's built-in WebSocket client set to deliver binary messages as `ArrayBuffer`, or null on a runtime without one. */
export function defaultLinkSocketFactory(): LinkSocketFactory | null {
	const Ctor = (globalThis as { WebSocket?: new (url: string) => LinkSocketLike }).WebSocket;
	if (typeof Ctor !== 'function') return null;
	return (url: string) => {
		const socket = new Ctor(url);
		try {
			socket.binaryType = 'arraybuffer';
		} catch {
			// a socket that cannot switch is handled by the decoder (it refuses non-binary data)
		}
		return socket;
	};
}

/** The bytes of a binary WebSocket message, or null for text and anything else. */
export function linkMessageBytes(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return null;
}

/** The close code of a WebSocket close event, or null. */
export function linkCloseCode(event: unknown): number | null {
	const code = (event as { code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : null;
}
