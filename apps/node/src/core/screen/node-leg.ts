import { decodeComputerFrame, encodeComputerFrame, type ComputerFrame } from '@ever-works/contracts';
import type { Logger } from '../logger';
import type { WebSocketFactory, WebSocketLike } from './cdp-connection';

/**
 * Agent computers — this machine's own inbound leg of a live view.
 *
 * Nothing ever connects INTO a node. When the owner asks for a different
 * quality or a fresh picture, the platform's relay holds the request for the
 * machine's leg, and this module is that leg: an OUTBOUND WebSocket from the
 * node to the platform's live-view gateway, authenticated in its first frame
 * with a short-lived `worker` token minted through the node credential
 * (never put in a URL). It only ever listens for `quality` and `refresh`;
 * any other kind is ignored.
 *
 * A dropped socket reconnects with backoff and a fresh token, until closed.
 * The backoff resets only once the relay has ACCEPTED the leg — a socket
 * that opens and is then refused is a failed attempt, not a success.
 *
 * The token travels only over TLS (`wss:`), or over plain `ws:` to this
 * machine's own loopback (local development). A leg aimed at any other
 * plain-`http:` origin is never opened: no token is minted for it and none
 * is sent.
 */

export const NODE_LEG_RECONNECT_BASE_MS = 2000;
export const NODE_LEG_RECONNECT_MAX_MS = 30_000;
/**
 * How long a leg must stay open to count as accepted when no request has
 * arrived on it yet. The relay joins a machine's leg silently (there is no
 * acknowledgement frame), and closes an unauthenticated socket within its
 * five-second auth window, so a socket still open after this long was
 * accepted.
 */
export const NODE_LEG_ACCEPTED_AFTER_MS = 30_000;

export interface NodeLegOptions {
	/** The platform origin the node talks to (as stored at enrollment). */
	apiUrl: string;
	mintToken: () => Promise<{ token: string; wsPath: string }>;
	factory: WebSocketFactory;
	onRequest: (frame: Extract<ComputerFrame, { kind: 'quality' | 'refresh' }>) => void;
	logger?: Logger;
	/** Monotonic-enough clock for the acceptance window; defaults to `Date.now`. */
	now?: () => number;
}

export interface NodeLeg {
	close(): void;
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `https://api.example.com[/api]` + `/ws/computer/<id>` → `wss://api.example.com/ws/computer/<id>`. */
export function toComputerWsUrl(apiUrl: string, wsPath: string): string {
	const origin = new URL(apiUrl).origin;
	return `${origin.replace(/^http/, 'ws')}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`;
}

/**
 * True when a leg to this platform origin may carry a token: `https:`
 * anywhere, plain `http:` only to a loopback host. Anything unparseable or
 * of another scheme is refused.
 */
export function isSecureLegOrigin(apiUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(apiUrl);
	} catch {
		return false;
	}
	if (parsed.protocol === 'https:') return true;
	return parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

export function openNodeLeg(options: NodeLegOptions): NodeLeg {
	if (!isSecureLegOrigin(options.apiUrl)) {
		// The view itself still runs (pictures are published through the
		// node's own API client); only the owner's quality and refresh
		// requests cannot reach this machine.
		options.logger?.warn(
			'Live view leg not opened: the platform is reached over plain http, and a live-view token is only sent over https (or to localhost).'
		);
		return { close: () => undefined };
	}
	const now = options.now ?? (() => Date.now());
	let closed = false;
	let socket: WebSocketLike | null = null;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const schedule = (): void => {
		if (closed) return;
		const wait = Math.min(NODE_LEG_RECONNECT_BASE_MS * 2 ** Math.min(attempt, 8), NODE_LEG_RECONNECT_MAX_MS);
		attempt += 1;
		timer = setTimeout(() => {
			timer = null;
			void connect();
		}, wait);
		timer.unref?.();
	};

	const connect = async (): Promise<void> => {
		if (closed) return;
		let token: string;
		let url: string;
		try {
			const minted = await options.mintToken();
			token = minted.token;
			url = toComputerWsUrl(options.apiUrl, minted.wsPath);
		} catch (error) {
			options.logger?.warn(
				`Live view leg: could not get a token: ${error instanceof Error ? error.message : String(error)}`
			);
			schedule();
			return;
		}
		if (closed) return;
		try {
			socket = options.factory(url);
		} catch {
			schedule();
			return;
		}
		const current = socket;
		let openedAt: number | null = null;
		current.onopen = () => {
			// Opening is not acceptance: the relay has not checked the token
			// yet, so the backoff is NOT reset here.
			openedAt = now();
			const auth = encodeComputerFrame({ kind: 'auth', token });
			if (auth) current.send(auth);
		};
		current.onmessage = (event) => {
			if (typeof event?.data !== 'string') return;
			const frame = decodeComputerFrame(event.data);
			if (frame && (frame.kind === 'quality' || frame.kind === 'refresh')) {
				// The relay routes requests only to an authenticated leg.
				attempt = 0;
				try {
					options.onRequest(frame);
				} catch {
					// the listener's failure is its own
				}
			}
		};
		current.onerror = () => undefined;
		current.onclose = () => {
			if (socket === current) socket = null;
			// A leg that outlived the relay's auth window was accepted: the
			// drop that ended it starts a fresh backoff.
			if (openedAt !== null && now() - openedAt >= NODE_LEG_ACCEPTED_AFTER_MS) attempt = 0;
			schedule();
		};
	};

	void connect();
	return {
		close: () => {
			closed = true;
			if (timer) clearTimeout(timer);
			try {
				socket?.close(1000, 'live view ended');
			} catch {
				// already gone
			}
			socket = null;
		}
	};
}
