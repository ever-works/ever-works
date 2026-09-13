import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import type { Logger } from '../logger';

/**
 * Self-build slice Z (EW-796) — the node's loopback MCP proxy.
 *
 * ## What it is for
 *
 * A model CLI running on a fleet node has to reach the platform's MCP
 * server with a credential, and there is no way to hand a credential to
 * either CLI that does not put it somewhere it must never be:
 *
 *   - an environment variable — refused by design. `EVER_WORKS_` is on
 *     `NODE_PLATFORM_OWNED_ENV_PATTERN`, which is not grantable even by
 *     an explicit `envPassthrough`, and weakening that to let a token
 *     through would weaken it for every check the node ever runs.
 *   - a header in the MCP config file — the file sits on disk in the run
 *     scratch directory, readable by every process of that user, and
 *     survives a crash that skips cleanup.
 *
 * So the token goes nowhere near either. It lives in the NODE PROCESS'S
 * MEMORY, behind a getter this proxy calls per request, and is attached
 * to the outbound request at the last possible moment. What the model
 * sees is a URL on 127.0.0.1 with no credential in it at all.
 *
 * ```
 *   model CLI ──http──▶ 127.0.0.1:<ephemeral>/mcp/<nonce> ──https──▶ platform MCP
 *                        (no credential)                    + x-ever-works-jwt
 * ```
 *
 * ## Why `x-ever-works-jwt` and not `Authorization`
 *
 * The MCP server's own `ApiKeyGuard` compares `Authorization: Bearer …`
 * against its SHARED key with a constant-time compare — a node holds no
 * such key, so putting the run token there is a guaranteed 401. The
 * per-caller credential channel is `x-ever-works-jwt`, which the guard
 * seeds into its caller context and `ApiClientService` then forwards
 * upstream as `Authorization: Bearer <token>`. That is where the
 * platform's `AuthSessionGuard` finally sees the `ew_run_…` prefix.
 *
 * ## Three independent things keep other local processes out
 *
 *   1. the listener binds `127.0.0.1` only — never `0.0.0.0`, so nothing
 *      off this machine can reach it at all;
 *   2. every request's peer address is re-checked against the loopback
 *      set, because a bind is a promise about interfaces and this is a
 *      check about the actual connection;
 *   3. the URL carries a per-run 32-hex NONCE. Loopback is shared by
 *      every local user, so (1) and (2) do not exclude another account
 *      on the same machine port-scanning 127.0.0.1. The nonce is the
 *      thing they cannot guess, and it is only ever written into the run
 *      scratch dir (0700) and passed to the CLI this run spawned.
 *
 * The proxy is also LIMITED to that one path. It is not a general
 * forwarder: any other path, and any method outside the streamable-HTTP
 * set, is refused before a byte leaves the machine.
 */

/** Peer addresses that are genuinely this machine talking to itself. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether a connection's peer address is this machine.
 *
 * An exact allowlist, never a prefix test: `startsWith('127.')` would
 * admit the whole 127/8 block (harmless) but the same habit applied to
 * `::ffff:` would admit `::ffff:10.0.0.9`, which is an OFF-BOX address
 * wearing an IPv4-mapped costume. Three exact strings is the whole set
 * a loopback bind can legitimately produce.
 */
export function isLoopbackPeer(address: string | undefined | null): boolean {
	return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address);
}

/** Methods the MCP streamable-HTTP transport uses. Everything else is refused. */
const ALLOWED_METHODS = new Set(['POST', 'GET', 'DELETE']);

/**
 * Request headers forwarded upstream. An allowlist rather than a
 * blocklist: a hop-by-hop header, a cookie, or a stray `authorization`
 * the CLI decided to add must never ride along and confuse the MCP
 * server's own auth decision.
 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];

/** Response headers passed back. Same reasoning, in the other direction. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version'];

/** Hard ceiling on one forwarded request body (an MCP call is small). */
export const MCP_BRIDGE_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** How many `tools/call` requests the counter will track before it stops. */
const MCP_BRIDGE_MAX_COUNTED_CALLS = 100_000;

export class McpBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McpBridgeError';
	}
}

/** Minimal `fetch` shape the proxy needs — narrower than the DOM's, wide enough to stub. */
export type McpBridgeFetch = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body?: string | Uint8Array;
		signal?: AbortSignal;
	}
) => Promise<McpBridgeUpstreamResponse>;

export interface McpBridgeUpstreamResponse {
	status: number;
	headers: { get(name: string): string | null };
	/** Web stream when the upstream streams (SSE); absent when it does not. */
	body?: unknown;
	text(): Promise<string>;
}

export interface McpLoopbackProxy {
	/** The URL to put in the CLI's MCP config. Carries the nonce, never a credential. */
	readonly url: string;
	/** Interface the listener actually bound to. Always `127.0.0.1`. */
	readonly address: string;
	/** `tools/call` requests forwarded so far (bounded). */
	toolCalls(): number;
	/** Stop listening and destroy every open socket. Idempotent. */
	close(): Promise<void>;
}

export interface McpLoopbackProxyOptions {
	/** Absolute platform MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
	upstreamUrl: string;
	/**
	 * Reads the CURRENT run token out of process memory. A getter, not a
	 * value: the node re-mints as its lease is renewed, and every request
	 * must pick up the newest token rather than a stale closure.
	 * `null` means "no credential right now" — the proxy then refuses the
	 * request rather than forwarding an unauthenticated one.
	 */
	token: () => string | null;
	logger?: Logger;
	fetchFn?: McpBridgeFetch;
	/**
	 * Overrides the generated path nonce. Tests only — a fixed nonce in
	 * production would defeat the point of having one.
	 */
	nonce?: string;
}

/**
 * Start the loopback proxy. Resolves once it is actually listening.
 *
 * Throws `McpBridgeError` on an upstream URL that is not an absolute
 * http(s) URL — validated HERE and not only on the platform, because
 * this process is the one that would otherwise attach a live credential
 * to a request aimed at a host nobody vetted. Plain `http:` is admitted
 * only for a loopback upstream (a developer's local MCP server); a
 * remote upstream must be `https:`.
 */
export async function startMcpLoopbackProxy(options: McpLoopbackProxyOptions): Promise<McpLoopbackProxy> {
	const upstream = assertUpstreamUrl(options.upstreamUrl);
	const fetchFn = options.fetchFn ?? defaultFetch();
	const logger = options.logger;
	const nonce = options.nonce ?? randomBytes(16).toString('hex');
	const path = `/mcp/${nonce}`;

	let toolCalls = 0;
	const sockets = new Set<Socket>();

	const server: Server = createServer((req, res) => {
		handleRequest(req, res).catch((error) => {
			// A proxy failure is never allowed to take the node down, and
			// the reason never reaches the model: it could name an internal
			// host or a header. The node's own log gets the redacted detail.
			logger?.warn(`MCP bridge request failed: ${logger.redact(describeError(error))}`);
			respondJson(res, 502, { error: 'upstream_unavailable' });
		});
	});

	server.on('connection', (socket: Socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// (2) of the three defences — the peer, not the bind.
		if (!isLoopbackPeer(req.socket.remoteAddress)) {
			respondJson(res, 403, { error: 'forbidden' });
			return;
		}
		// (3) — the nonce. Compared against the whole path, so neither a
		// prefix (`/mcp/`) nor a sibling path reaches the upstream.
		const requestPath = (req.url ?? '').split('?')[0] ?? '';
		if (requestPath !== path) {
			respondJson(res, 404, { error: 'not_found' });
			return;
		}
		const method = (req.method ?? '').toUpperCase();
		if (!ALLOWED_METHODS.has(method)) {
			respondJson(res, 405, { error: 'method_not_allowed' });
			return;
		}

		const token = options.token();
		if (!token) {
			// No credential in memory (never minted, or already revoked at
			// finalize). Fail closed: an unauthenticated forward would be a
			// pointless request that also tells the upstream a node is here.
			respondJson(res, 401, { error: 'no_credential' });
			return;
		}

		const body = method === 'POST' ? await readBody(req) : undefined;
		if (body === OVERSIZED) {
			respondJson(res, 413, { error: 'payload_too_large' });
			return;
		}
		if (body && toolCalls < MCP_BRIDGE_MAX_COUNTED_CALLS && isToolCall(body)) {
			toolCalls += 1;
		}

		const headers: Record<string, string> = {};
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = req.headers[name];
			if (typeof value === 'string') headers[name] = value;
		}
		// THE injection point, and the only place the credential is ever
		// attached. It exists in this object for the length of one call.
		headers['x-ever-works-jwt'] = token;

		const upstreamResponse = await fetchFn(upstream, {
			method,
			headers,
			...(body !== undefined ? { body } : {})
		});

		res.statusCode = upstreamResponse.status;
		for (const name of FORWARDED_RESPONSE_HEADERS) {
			const value = upstreamResponse.headers.get(name);
			if (value) res.setHeader(name, value);
		}
		await pipeUpstreamBody(upstreamResponse, res);
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		// 127.0.0.1 explicitly — (1) of the three defences. Port 0 asks the
		// OS for an ephemeral port so two concurrent runs never collide.
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		await closeServer(server, sockets);
		throw new McpBridgeError('MCP bridge listener did not report a port');
	}
	const url = `http://127.0.0.1:${address.port}${path}`;
	logger?.info(`MCP bridge listening on 127.0.0.1:${address.port}`);

	let closed = false;
	return {
		url,
		address: address.address,
		toolCalls: () => toolCalls,
		close: async () => {
			if (closed) return;
			closed = true;
			await closeServer(server, sockets);
			logger?.info('MCP bridge stopped');
		}
	};
}

/** Sentinel returned by `readBody` when the request exceeded the cap. */
const OVERSIZED = Symbol('oversized') as unknown as Uint8Array;

async function readBody(req: IncomingMessage): Promise<Uint8Array | typeof OVERSIZED> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MCP_BRIDGE_MAX_REQUEST_BYTES) {
			req.destroy();
			return OVERSIZED;
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

/**
 * Whether this JSON-RPC body is a `tools/call`.
 *
 * Best-effort and deliberately silent on failure: the count is a
 * reporting nicety on the job result, and a body the proxy cannot parse
 * must still be forwarded unchanged. Handles the batch form too, since
 * JSON-RPC allows an array.
 */
function isToolCall(body: Uint8Array): boolean {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		return entries.some(
			(entry) =>
				typeof entry === 'object' && entry !== null && (entry as { method?: unknown }).method === 'tools/call'
		);
	} catch {
		return false;
	}
}

/**
 * Stream the upstream body back when there is one (streamable HTTP
 * answers a POST with SSE unless JSON responses are enabled), otherwise
 * fall back to the buffered text.
 */
async function pipeUpstreamBody(response: McpBridgeUpstreamResponse, res: ServerResponse): Promise<void> {
	const body = response.body;
	if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
		const readable = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
		await new Promise<void>((resolve, reject) => {
			readable.on('error', reject);
			res.on('close', resolve);
			res.on('finish', resolve);
			readable.pipe(res);
		});
		return;
	}
	const text = await response.text();
	res.end(text);
}

function respondJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(payload));
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	// Destroy first: `server.close()` waits for keep-alive connections, and
	// an SSE stream the model left open would hold the run's finalize
	// forever.
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Validate the upstream before a credential is ever attached to a
 * request aimed at it. `https:` anywhere; plain `http:` only for a
 * loopback host, which is the local-development case.
 */
export function assertUpstreamUrl(raw: string): string {
	if (typeof raw !== 'string' || !raw.trim()) {
		throw new McpBridgeError('MCP server URL is empty');
	}
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new McpBridgeError('MCP server URL is not an absolute URL');
	}
	if (parsed.protocol === 'https:') return parsed.toString();
	if (parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
		return parsed.toString();
	}
	throw new McpBridgeError('MCP server URL must be https (or http on localhost)');
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function defaultFetch(): McpBridgeFetch {
	const globalFetch = (globalThis as { fetch?: unknown }).fetch;
	if (typeof globalFetch !== 'function') {
		throw new McpBridgeError('This runtime has no fetch implementation for the MCP bridge');
	}
	return globalFetch as unknown as McpBridgeFetch;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
