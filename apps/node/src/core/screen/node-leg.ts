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
 */

export const NODE_LEG_RECONNECT_BASE_MS = 2000;
export const NODE_LEG_RECONNECT_MAX_MS = 30_000;

export interface NodeLegOptions {
	/** The platform origin the node talks to (as stored at enrollment). */
	apiUrl: string;
	mintToken: () => Promise<{ token: string; wsPath: string }>;
	factory: WebSocketFactory;
	onRequest: (frame: Extract<ComputerFrame, { kind: 'quality' | 'refresh' }>) => void;
	logger?: Logger;
}

export interface NodeLeg {
	close(): void;
}

/** `https://api.example.com[/api]` + `/ws/computer/<id>` → `wss://api.example.com/ws/computer/<id>`. */
export function toComputerWsUrl(apiUrl: string, wsPath: string): string {
	const origin = new URL(apiUrl).origin;
	return `${origin.replace(/^http/, 'ws')}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`;
}

export function openNodeLeg(options: NodeLegOptions): NodeLeg {
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
		current.onopen = () => {
			attempt = 0;
			const auth = encodeComputerFrame({ kind: 'auth', token });
			if (auth) current.send(auth);
		};
		current.onmessage = (event) => {
			if (typeof event?.data !== 'string') return;
			const frame = decodeComputerFrame(event.data);
			if (frame && (frame.kind === 'quality' || frame.kind === 'refresh')) {
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
