import type { Logger } from './logger';
import {
	MAX_CREDENTIAL_LENGTH,
	MIN_CREDENTIAL_LENGTH,
	type FleetEnrollRequest,
	type FleetEnrollResponse,
	type FleetHeartbeatRequest,
	type FleetHeartbeatResponse,
	type FleetNodeView,
	type NodeSelfDescription
} from './types';

/**
 * HTTP client for the public Fleet endpoints the node apps use:
 *
 *   POST /api/fleet/enroll      one-time token  → { nodeId, secret, node }
 *   POST /api/fleet/heartbeat   nodeId + secret → { ok, node }
 *   POST /api/fleet/pause       nodeId + secret → { ok, node }   (drain/resume)
 *   POST /api/fleet/unenroll    nodeId + secret → { ok }         (retire)
 *
 * Both are `@Public()` and self-authenticating: the credential IS the body.
 * The server answers every invalid credential path with one undifferentiated
 * 401, and this client keeps that posture — it never echoes a server body into
 * an error message, so nothing about which check failed can leak into a log.
 *
 * `fetch` is injected rather than imported so every path is testable without a
 * network, and so the Electron main process can supply its own.
 */

export type FleetErrorKind =
	| 'unauthorized'
	| 'forbidden'
	| 'invalid-request'
	| 'rate-limited'
	| 'server'
	| 'network'
	| 'malformed'
	/**
	 * 409 from a job heartbeat/complete: the platform holds a NEWER lease on
	 * the job than the one this node is renewing or finalizing (suspend-safe
	 * leases). The claim is void; the worker aborts the run at once.
	 */
	| 'stale-lease';

export class FleetClientError extends Error {
	readonly kind: FleetErrorKind;
	readonly status?: number;

	constructor(kind: FleetErrorKind, message: string, status?: number) {
		super(message);
		this.name = 'FleetClientError';
		this.kind = kind;
		if (status !== undefined) {
			this.status = status;
		}
	}
}

/** Structural subset of the fetch Response we rely on. */
export interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface FetchRequestInit {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

/**
 * The four enroll/heartbeat wire shapes, aliased to the SHARED contract
 * in `@ever-works/contracts` under the names this app has always used.
 *
 * These are deliberately aliases and not re-declarations: adding or
 * renaming a field server-side now fails this app's `tsc` instead of
 * silently producing a request the API rejects at runtime.
 */
export type EnrollRequest = FleetEnrollRequest;
export type EnrollResponse = FleetEnrollResponse;
export type HeartbeatRequest = FleetHeartbeatRequest;
export type HeartbeatResponse = FleetHeartbeatResponse;

export interface NodeCredentialRequest {
	nodeId: string;
	secret: string;
}

export interface PauseRequest extends NodeCredentialRequest {
	/** true drains this node; false resumes it. */
	paused: boolean;
}

export interface PauseResponse {
	ok: true;
	node: FleetNodeView;
}

export interface FleetClientOptions {
	apiUrl: string;
	fetchFn: FetchLike;
	logger?: Logger;
	/**
	 * Sent as `User-Agent`. Non-browser clients MUST send a real one: the
	 * production API sits behind a proxy that answers default/absent agents
	 * with 403 (see the platform's networking notes).
	 */
	userAgent?: string;
	/** Per-request timeout; 0 disables the abort signal (used in tests). */
	timeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Validate and canonicalize an API origin: absolute http(s), no trailing slash. */
export function normalizeApiUrl(raw: string): string {
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (!trimmed) {
		throw new FleetClientError('invalid-request', 'API URL is required');
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new FleetClientError('invalid-request', `API URL is not a valid URL: ${trimmed}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new FleetClientError('invalid-request', `API URL must be http(s): ${trimmed}`);
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Local pre-flight so an obviously malformed credential never leaves the machine. */
function assertCredentialShape(value: string, label: string): void {
	if (typeof value !== 'string' || value.length < MIN_CREDENTIAL_LENGTH || value.length > MAX_CREDENTIAL_LENGTH) {
		throw new FleetClientError(
			'invalid-request',
			`${label} must be ${MIN_CREDENTIAL_LENGTH}-${MAX_CREDENTIAL_LENGTH} characters`
		);
	}
}

/**
 * Map a response status to a stable error kind with a fixed, client-authored
 * message. Server bodies are deliberately NOT surfaced.
 */
function errorForStatus(status: number, operation: string): FleetClientError {
	if (status === 401) {
		return new FleetClientError(
			'unauthorized',
			operation === 'enroll'
				? 'Enrollment token was rejected (unknown, already used, or expired)'
				: 'Node credential was rejected (revoked, deleted, or the node was disabled)',
			status
		);
	}
	if (status === 403) {
		return new FleetClientError(
			'forbidden',
			'Request was refused by the API edge (403) — check the API URL and that outbound requests are not being filtered',
			status
		);
	}
	if (status === 429) {
		return new FleetClientError('rate-limited', 'Rate limited by the API — backing off', status);
	}
	if (status >= 400 && status < 500) {
		return new FleetClientError('invalid-request', `Request rejected by the API (HTTP ${status})`, status);
	}
	return new FleetClientError('server', `API error (HTTP ${status})`, status);
}

export class FleetClient {
	private readonly apiUrl: string;
	private readonly fetchFn: FetchLike;
	private readonly logger: Logger | undefined;
	private readonly userAgent: string;
	private readonly timeoutMs: number;

	constructor(options: FleetClientOptions) {
		this.apiUrl = normalizeApiUrl(options.apiUrl);
		this.fetchFn = options.fetchFn;
		this.logger = options.logger;
		this.userAgent = options.userAgent ?? 'ever-works-node';
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/** The canonicalized origin this client talks to. */
	get baseUrl(): string {
		return this.apiUrl;
	}

	/**
	 * Consume a one-time enrollment token. The returned `secret` is minted
	 * exactly once by the platform — it is immediately registered with the
	 * logger so it can never be printed.
	 */
	async enroll(request: EnrollRequest): Promise<EnrollResponse> {
		assertCredentialShape(request.token, 'Enrollment token');
		this.logger?.protect(request.token);

		const payload = await this.post('api/fleet/enroll', 'enroll', {
			token: request.token,
			...selfDescription(request)
		});

		const nodeId = readString(payload, 'nodeId');
		const secret = readString(payload, 'secret');
		const node = readNode(payload);
		if (!nodeId || !secret || !node) {
			throw new FleetClientError('malformed', 'Enrollment response did not contain a node id and secret');
		}
		this.logger?.protect(secret);
		return { nodeId, secret, node };
	}

	/** Report liveness and refresh the self-description. */
	async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
		assertCredentialShape(request.secret, 'Node secret');
		this.logger?.protect(request.secret);

		const payload = await this.post('api/fleet/heartbeat', 'heartbeat', {
			nodeId: request.nodeId,
			secret: request.secret,
			...selfDescription(request)
		});

		const node = readNode(payload);
		if (!node) {
			throw new FleetClientError('malformed', 'Heartbeat response did not contain a node');
		}
		return { ok: true, node };
	}

	/**
	 * Ask the platform to drain (or resume) this node, authenticated
	 * with the node's own heartbeat secret.
	 *
	 * Draining is a platform-side decision — it is the scheduler that
	 * must stop handing out work — so `ever-works-node pause` cannot be
	 * purely local. The local flag exists too (so a restart comes back
	 * drained), but this call is what actually stops the leases.
	 */
	async pause(request: PauseRequest): Promise<PauseResponse> {
		assertCredentialShape(request.secret, 'Node secret');
		this.logger?.protect(request.secret);

		const payload = await this.post('api/fleet/pause', 'pause', {
			nodeId: request.nodeId,
			secret: request.secret,
			paused: request.paused
		});

		const node = readNode(payload);
		if (!node) {
			throw new FleetClientError('malformed', 'Pause response did not contain a node');
		}
		return { ok: true, node };
	}

	/**
	 * Retire this node's registration. The platform deletes the row,
	 * which is what makes the credential we just presented worthless —
	 * the local config is then safe to erase.
	 */
	async unenroll(request: NodeCredentialRequest): Promise<void> {
		assertCredentialShape(request.secret, 'Node secret');
		this.logger?.protect(request.secret);

		await this.post('api/fleet/unenroll', 'unenroll', {
			nodeId: request.nodeId,
			secret: request.secret
		});
	}

	private async post(path: string, operation: string, body: Record<string, unknown>): Promise<unknown> {
		const url = joinUrl(this.apiUrl, path);
		const init: FetchRequestInit = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': this.userAgent
			},
			body: JSON.stringify(body)
		};
		if (this.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			init.signal = AbortSignal.timeout(this.timeoutMs);
		}

		let response: FetchResponseLike;
		try {
			response = await this.fetchFn(url, init);
		} catch (error) {
			// Redact defensively: a thrown fetch error can embed the request URL.
			const detail = error instanceof Error ? error.message : String(error);
			throw new FleetClientError('network', `Could not reach ${url}: ${this.logger?.redact(detail) ?? detail}`);
		}

		if (!response.ok) {
			throw errorForStatus(response.status, operation);
		}

		let raw: string;
		try {
			raw = await response.text();
		} catch {
			throw new FleetClientError('malformed', 'Could not read the API response body');
		}
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			throw new FleetClientError('malformed', 'API response was not valid JSON');
		}
	}
}

/** Only send self-description fields that are actually set. */
/**
 * Project the self-description onto the wire body.
 *
 * An explicit copy rather than a spread, so an unrelated field on the
 * request object can never leak into a `@Public()` body. That makes it
 * the one place a NEW description field has to be added: a field this
 * function does not name is a field the machine computes, logs and then
 * silently never sends — which is exactly how `cliVersion` /
 * `diskFreeBytes` were wired at the probe end only.
 *
 * `undefined` is preserved as ABSENT, never sent as null: the server's
 * heartbeat reads an absent telemetry field as "leave the stored reading
 * alone", so a transient probe failure must not wipe a good value.
 */
function selfDescription(source: NodeSelfDescription): NodeSelfDescription {
	const out: NodeSelfDescription = {};
	if (source.platform !== undefined) {
		out.platform = source.platform;
	}
	if (source.version !== undefined) {
		out.version = source.version;
	}
	if (source.capabilities !== undefined) {
		out.capabilities = source.capabilities;
	}
	if (source.cliVersion !== undefined) {
		out.cliVersion = source.cliVersion;
	}
	if (source.diskFreeBytes !== undefined) {
		out.diskFreeBytes = source.diskFreeBytes;
	}
	if (source.modelIdentity !== undefined) {
		out.modelIdentity = source.modelIdentity;
	}
	// Fleet health signals (EW-776). Named here for exactly the reason the
	// header above gives: a field this whitelist does not list is a field
	// the machine computes, logs and then silently never sends.
	if (source.workerState !== undefined) {
		out.workerState = source.workerState;
	}
	if (source.workerStateReason !== undefined) {
		out.workerStateReason = source.workerStateReason;
	}
	// Node housekeeping (EW-803). `minFreeDiskBytes` is the ONE field in
	// this whole projection that may legitimately go out as `null` — the
	// server reads absent as "leave alone", so an operator who switched
	// the floor off needs an explicit null to say so, and `!== undefined`
	// (not a truthiness test) is what lets it through.
	if (source.minFreeDiskBytes !== undefined) {
		out.minFreeDiskBytes = source.minFreeDiskBytes;
	}
	if (source.workspaceCount !== undefined) {
		out.workspaceCount = source.workspaceCount;
	}
	if (source.workspaceBytes !== undefined) {
		out.workspaceBytes = source.workspaceBytes;
	}
	if (source.lastReclaimAt !== undefined) {
		out.lastReclaimAt = source.lastReclaimAt;
	}
	if (source.lastReclaimFreedBytes !== undefined) {
		out.lastReclaimFreedBytes = source.lastReclaimFreedBytes;
	}
	return out;
}

function readString(payload: unknown, key: string): string | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === 'string' && value ? value : null;
}

function readNode(payload: unknown): FleetNodeView | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const node = (payload as Record<string, unknown>).node;
	if (!node || typeof node !== 'object') {
		return null;
	}
	const view = node as Partial<FleetNodeView>;
	if (typeof view.id !== 'string') {
		return null;
	}
	return node as FleetNodeView;
}
