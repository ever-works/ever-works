import * as http from 'node:http';
import * as net from 'node:net';
import {
	decodeFleetPortTunnelChunk,
	encodeFleetPortTunnelChunk,
	filterFleetPortTunnelHeaders,
	FLEET_LINK_FRAME_KINDS,
	FLEET_PORT_TUNNEL_CHUNK_BYTES,
	FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS,
	FLEET_PORT_TUNNEL_DROPPED_RESPONSE_HEADERS,
	FLEET_PORT_TUNNEL_MAX_INFLIGHT,
	FLEET_PORT_TUNNEL_METHODS,
	FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS,
	isFleetPortNumber,
	makeFleetLinkError,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import type { NodeChannelContext, NodeChannelHandler, NodeChannelOpenResult } from '../registry';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS R-17, §3.3 `tunnel`) — the
 * node's half of **Preview in my browser**: HTTP requests for ONE port,
 * carried over the outbound node link and made on the machine to
 * `127.0.0.1:<port>` — the loopback, always; there is no host on the wire.
 * The node still listens on nothing.
 *
 * On a `tunnel` channel (`{ tunnelId, port }`), per request:
 *
 *   platform → node   JSON `tunnel.request { requestId, method, path, query, headers }`
 *                     DATA `[request u32][body…]`* then END `[request u32]`
 *   node → platform   JSON `tunnel.response { requestId, status, headers }`
 *                     DATA `[request u32][body…]`* then END `[request u32]`
 *                     — or JSON `tunnel.error { requestId, code, hint }`
 *
 * Several requests share the channel at once (a page loads its assets in
 * parallel), at most {@link FLEET_PORT_TUNNEL_MAX_INFLIGHT}; bodies stream in
 * chunks of at most 64 KiB both ways, never buffered whole; one request waits
 * at most 60 s for its answer. Hop-by-hop headers are dropped both ways and
 * `Host` is the loopback's own (the platform already stripped its cookies and
 * credentials — this side strips `authorization` again, as a second fence).
 * The channel opens only when something listens on the port
 * (`channel.refused not_found` otherwise), and closes on the kill switch.
 */

export interface TunnelChannelOptions {
	/** Test seam: the loopback HTTP client. */
	request?: typeof http.request;
	/** Test seam: "does something listen on the loopback port?" */
	isListening?: (port: number) => Promise<boolean>;
	requestTimeoutMs?: number;
}

/** True when a TCP connection to `127.0.0.1:<port>` opens within 1.5 s. */
export function isLoopbackListening(port: number, timeoutMs = 1_500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const done = (answer: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(answer);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

interface InFlight {
	request: http.ClientRequest;
	timer: ReturnType<typeof setTimeout>;
	answered: boolean;
}

const METHODS: ReadonlySet<string> = new Set(FLEET_PORT_TUNNEL_METHODS);

/** Open one `tunnel` channel. */
export async function openTunnelChannel(
	context: NodeChannelContext,
	options: TunnelChannelOptions = {}
): Promise<NodeChannelOpenResult> {
	const port = context.params.port;
	const tunnelId = context.params.tunnelId;
	if (!isFleetPortNumber(port) || typeof tunnelId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(tunnelId)) {
		return { ok: false, error: makeFleetLinkError('invalid', 'a tunnel needs a tunnelId and a port') };
	}
	if (context.control.paused) {
		return { ok: false, error: makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet') };
	}
	const listening = await (options.isListening ?? isLoopbackListening)(port);
	if (!listening) {
		return {
			ok: false,
			error: makeFleetLinkError('not_found', `nothing listens on :${port} on ${context.nodeName}`, { port })
		};
	}

	const requestFn = options.request ?? http.request;
	const timeoutMs = options.requestTimeoutMs ?? FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS;
	const inFlight = new Map<number, InFlight>();
	let closed = false;
	const unwatch = context.control.onChange((state) => {
		if (state.paused) {
			abortAll();
			context.close('kill_switch', 'the fleet was stopped');
		}
	});

	const fail = (requestId: number, code: 'unreachable' | 'timeout' | 'invalid', hint: string): void => {
		context.sendJson({ type: 'tunnel.error', requestId: String(requestId), code, hint });
	};

	const finish = (requestId: number): void => {
		const entry = inFlight.get(requestId);
		if (!entry) return;
		clearTimeout(entry.timer);
		inFlight.delete(requestId);
	};

	const abortAll = (): void => {
		for (const [requestId, entry] of inFlight) {
			clearTimeout(entry.timer);
			entry.request.destroy();
			inFlight.delete(requestId);
		}
	};

	/** Send a body as chunks of at most 64 KiB; false when the link would not take one. */
	const sendBody = (requestId: number, chunk: Buffer): boolean => {
		for (let offset = 0; offset < chunk.length; offset += FLEET_PORT_TUNNEL_CHUNK_BYTES) {
			const piece = chunk.subarray(offset, offset + FLEET_PORT_TUNNEL_CHUNK_BYTES);
			if (!context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, encodeFleetPortTunnelChunk(requestId, piece))) {
				return false;
			}
		}
		return true;
	};

	const start = (message: Record<string, unknown>): void => {
		const requestId = Number(message.requestId);
		if (!Number.isInteger(requestId) || requestId < 0 || requestId > 0xffff_ffff) return;
		if (inFlight.has(requestId)) return fail(requestId, 'invalid', 'this request is already running');
		if (inFlight.size >= FLEET_PORT_TUNNEL_MAX_INFLIGHT) {
			return fail(requestId, 'invalid', `${FLEET_PORT_TUNNEL_MAX_INFLIGHT} requests are already running`);
		}
		const method = typeof message.method === 'string' ? message.method.toUpperCase() : '';
		const path = typeof message.path === 'string' ? message.path : '';
		const query = typeof message.query === 'string' ? message.query : '';
		if (!METHODS.has(method)) return fail(requestId, 'invalid', 'method');
		// An absolute path on THIS port only: never a scheme, never `//host`.
		if (!path.startsWith('/') || path.startsWith('//') || path.length > 8192 || /[\r\n\s]/.test(path)) {
			return fail(requestId, 'invalid', 'path');
		}
		if (query.length > 8192 || /[\r\n\s#]/.test(query)) return fail(requestId, 'invalid', 'query');
		const headers = filterFleetPortTunnelHeaders(
			typeof message.headers === 'object' && message.headers !== null
				? (message.headers as Record<string, unknown>)
				: {},
			FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS
		);
		headers.host = `127.0.0.1:${port}`;

		let request: http.ClientRequest;
		try {
			request = requestFn(
				{
					host: '127.0.0.1',
					port,
					method,
					path: query.length > 0 ? `${path}?${query}` : path,
					headers,
					agent: false
				},
				(response) => {
					const entry = inFlight.get(requestId);
					if (!entry || closed) {
						response.destroy();
						return;
					}
					entry.answered = true;
					context.sendJson({
						type: 'tunnel.response',
						requestId: String(requestId),
						status: response.statusCode ?? 502,
						headers: filterFleetPortTunnelHeaders(
							response.headers as Record<string, unknown>,
							FLEET_PORT_TUNNEL_DROPPED_RESPONSE_HEADERS
						)
					});
					response.on('data', (chunk: Buffer) => {
						if (!sendBody(requestId, chunk)) {
							// The link cannot take more: end this request rather than lose the middle of a body.
							response.destroy();
							finish(requestId);
						}
					});
					response.once('end', () => {
						if (!inFlight.has(requestId)) return;
						context.sendBinary(FLEET_LINK_FRAME_KINDS.END, encodeFleetPortTunnelChunk(requestId));
						finish(requestId);
					});
					response.once('error', () => {
						if (!inFlight.has(requestId)) return;
						context.sendBinary(FLEET_LINK_FRAME_KINDS.END, encodeFleetPortTunnelChunk(requestId));
						finish(requestId);
					});
				}
			);
		} catch (error) {
			return fail(requestId, 'invalid', error instanceof Error ? error.message.slice(0, 200) : 'request');
		}
		const timer = setTimeout(() => {
			const entry = inFlight.get(requestId);
			if (!entry) return;
			entry.request.destroy();
			finish(requestId);
			if (!entry.answered) fail(requestId, 'timeout', `:${port} did not answer within ${Math.round(timeoutMs / 1000)} s`);
		}, timeoutMs);
		inFlight.set(requestId, { request, timer, answered: false });
		request.once('error', (error: NodeJS.ErrnoException) => {
			const entry = inFlight.get(requestId);
			if (!entry) return;
			finish(requestId);
			if (!entry.answered) {
				fail(requestId, 'unreachable', `${context.nodeName} could not reach :${port} — ${error.code ?? error.message}`);
			}
		});
	};

	const handler: NodeChannelHandler = {
		onJson: (message) => {
			if (closed) return;
			if (message.type === 'tunnel.request') start(message);
		},
		onBinary: (kind: FleetLinkFrameKind, payload: Uint8Array) => {
			if (closed) return;
			const chunk = decodeFleetPortTunnelChunk(payload);
			if (!chunk) return;
			const entry = inFlight.get(chunk.request);
			if (!entry) return;
			if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
				if (chunk.bytes.byteLength > 0) entry.request.write(Buffer.from(chunk.bytes));
			} else if (kind === FLEET_LINK_FRAME_KINDS.END) {
				entry.request.end();
			}
		},
		onClose: () => {
			closed = true;
			unwatch();
			abortAll();
		}
	};
	return { ok: true, handler };
}
