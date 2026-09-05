import type {
	FleetJobCompleteResponse,
	FleetJobEnvFilesResponse,
	FleetJobHeartbeatResponse,
	FleetJobLeaseResponse,
	FleetJobView,
	FleetRunEnvFileContent,
	FleetRunEnvFileRequestRef
} from '@ever-works/contracts';
import { FleetClientError, joinUrl, normalizeApiUrl, type FetchLike, type FetchRequestInit } from './fleet-client';
import type { Logger } from './logger';
import { MAX_CREDENTIAL_LENGTH, MIN_CREDENTIAL_LENGTH } from './types';
import { extractRunEnvSecretValues } from './workspaces/run-env-files';

/**
 * HTTP client for the three node-facing fleet-job endpoints:
 *
 *   POST /api/fleet/jobs/lease           → claim queued work
 *   POST /api/fleet/jobs/:id/heartbeat   → keep the claim alive
 *   POST /api/fleet/jobs/:id/complete    → report the verdict
 *   POST /api/fleet/jobs/:id/env-files   → fetch the run's seed .env files
 *
 * Same posture as {@link FleetClient}: all three are `@Public()` and
 * self-authenticating (the `(nodeId, secret)` pair in the body IS the
 * credential); the server answers every invalid path with ONE
 * undifferentiated 401, and this client preserves that — it never
 * echoes a server body into an error message, so nothing about which
 * check failed can leak into a node's logs.
 *
 * The one differentiated answer is `409` (suspend-safe leases): the
 * `leaseGeneration` the node echoes on heartbeat/complete is no longer
 * the job's current one, so the claim it holds is void. It is mapped to
 * `FleetClientError('stale-lease')` from the STATUS alone — the body is
 * never read — and it is thrown rather than collapsed to null, because
 * the worker needs the reason to abort the run without reporting.
 *
 * Wire shapes come from `@ever-works/contracts`, not a local mirror:
 * this is the one part of the node↔platform contract that carries
 * executable work, and a silent drift here would mean a node running
 * the wrong thing rather than merely reporting the wrong status.
 *
 * `fetch` is injected rather than imported so every path is testable
 * without a network, and so the Electron main process can supply its own.
 */
export interface FleetJobClientOptions {
	apiUrl: string;
	nodeId: string;
	/** Node secret minted at enroll. NEVER logged. */
	secret: string;
	fetchFn: FetchLike;
	logger?: Logger;
	/**
	 * Sent as `User-Agent`. Non-browser clients MUST send a real one: the
	 * production API sits behind a proxy that answers default/absent
	 * agents with 403.
	 */
	userAgent?: string;
	/** Per-request timeout; 0 disables the abort signal (used in tests). */
	timeoutMs?: number;
}

export const DEFAULT_JOB_REQUEST_TIMEOUT_MS = 30_000;

export class FleetJobClient {
	private readonly apiUrl: string;
	private readonly nodeId: string;
	private readonly secret: string;
	private readonly fetchFn: FetchLike;
	private readonly logger: Logger | undefined;
	private readonly userAgent: string;
	private readonly timeoutMs: number;

	constructor(options: FleetJobClientOptions) {
		if (
			typeof options.secret !== 'string' ||
			options.secret.length < MIN_CREDENTIAL_LENGTH ||
			options.secret.length > MAX_CREDENTIAL_LENGTH
		) {
			throw new FleetClientError(
				'invalid-request',
				`Node secret must be ${MIN_CREDENTIAL_LENGTH}-${MAX_CREDENTIAL_LENGTH} characters`
			);
		}
		this.apiUrl = normalizeApiUrl(options.apiUrl);
		this.nodeId = options.nodeId;
		this.secret = options.secret;
		this.fetchFn = options.fetchFn;
		this.logger = options.logger;
		this.userAgent = options.userAgent ?? 'ever-works-node';
		this.timeoutMs = options.timeoutMs ?? DEFAULT_JOB_REQUEST_TIMEOUT_MS;
		this.logger?.protect(options.secret);
	}

	get baseUrl(): string {
		return this.apiUrl;
	}

	/**
	 * Claim up to `max` queued jobs. An authenticated node with nothing
	 * to do gets `[]` — "no work" and "bad credential" are never the same
	 * response, so an empty array must not be treated as an error.
	 */
	async lease(
		request: { max?: number; leaseTtlSec?: number; capabilities?: string[] } = {},
		signal?: AbortSignal
	): Promise<FleetJobView[]> {
		const body: Record<string, unknown> = { nodeId: this.nodeId, secret: this.secret };
		if (request.max !== undefined) body.max = request.max;
		if (request.leaseTtlSec !== undefined) body.leaseTtlSec = request.leaseTtlSec;
		if (request.capabilities !== undefined) body.capabilities = request.capabilities;

		const payload = (await this.post('api/fleet/jobs/lease', 'lease', body, signal)) as FleetJobLeaseResponse;
		if (!payload || !Array.isArray(payload.jobs)) {
			throw new FleetClientError('malformed', 'Lease response did not contain a job list');
		}
		return payload.jobs;
	}

	/**
	 * Extend the claim on a job. Returns the server's refreshed job view —
	 * including its authoritative lease expiry — or null when
	 * the platform refuses (401 — someone else's job, already terminal,
	 * revoked credential). A lost lease is a protocol outcome rather than a
	 * transport exception; the worker aborts the shared task signal before the
	 * platform can offer that job elsewhere.
	 *
	 * `leaseGeneration` is the claim identity the lease came with. Sent
	 * only when the lease carried one (an older API neither issues nor
	 * accepts the field), and a `409` answer — the platform re-issued the
	 * claim while this run kept going — THROWS `stale-lease` rather than
	 * returning null, so the worker can tell "abort, and do not report"
	 * from "abort, and report".
	 */
	async heartbeat(jobId: string, leaseTtlSec?: number, leaseGeneration?: number): Promise<FleetJobView | null> {
		const body: Record<string, unknown> = { nodeId: this.nodeId, secret: this.secret };
		if (leaseTtlSec !== undefined) body.leaseTtlSec = leaseTtlSec;
		if (leaseGeneration !== undefined) body.leaseGeneration = leaseGeneration;
		try {
			const payload = (await this.post(
				`api/fleet/jobs/${encodeURIComponent(jobId)}/heartbeat`,
				'job-heartbeat',
				body
			)) as FleetJobHeartbeatResponse;
			if (!payload?.ok || !payload.job || typeof payload.job !== 'object') {
				throw new FleetClientError('malformed', 'Job heartbeat response did not contain the renewed job');
			}
			return payload.job;
		} catch (error) {
			if (error instanceof FleetClientError && error.kind === 'unauthorized') {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Report the terminal outcome of a job. `leaseGeneration` as for
	 * {@link heartbeat}; a `409` throws `stale-lease` — the platform wrote
	 * nothing, and the worker must not retry with a failure report either.
	 */
	async complete(
		jobId: string,
		outcome: { success: boolean; result?: Record<string, unknown> | null; error?: string | null },
		leaseGeneration?: number
	): Promise<boolean> {
		const body: Record<string, unknown> = {
			nodeId: this.nodeId,
			secret: this.secret,
			success: outcome.success
		};
		if (outcome.success && outcome.result) body.result = outcome.result;
		if (!outcome.success && outcome.error) body.error = outcome.error;
		if (leaseGeneration !== undefined) body.leaseGeneration = leaseGeneration;

		const payload = (await this.post(
			`api/fleet/jobs/${encodeURIComponent(jobId)}/complete`,
			'job-complete',
			body
		)) as FleetJobCompleteResponse;
		return Boolean(payload?.ok);
	}

	/**
	 * Fetch the decrypted seed `.env` files this run's repositories declared
	 * (self-build slice Y, EW-781).
	 *
	 * Same channel, same credential, same four-check proof as heartbeat and
	 * complete — deliberately not a second scheme. The REQUEST carries only
	 * registry row ids and repository-relative paths; the RESPONSE is the
	 * one place in this client where a secret value appears, and every
	 * value is handed to `logger.protect` the moment it arrives, so a later
	 * error message or debug line cannot echo it even by accident.
	 *
	 * Throws rather than returning null on every failure: a run must not
	 * start with a partial environment, so "could not fetch" has to reach
	 * the executor as a refusal, not as an empty list. `409` still means
	 * `stale-lease` from the status alone.
	 */
	async fetchRunEnvFiles(
		jobId: string,
		refs: readonly FleetRunEnvFileRequestRef[],
		leaseGeneration?: number
	): Promise<FleetRunEnvFileContent[]> {
		const body: Record<string, unknown> = {
			nodeId: this.nodeId,
			secret: this.secret,
			refs: refs.map((ref) => ({ repoConnectionId: ref.repoConnectionId, paths: [...ref.paths] }))
		};
		if (leaseGeneration !== undefined) body.leaseGeneration = leaseGeneration;

		const payload = (await this.post(
			`api/fleet/jobs/${encodeURIComponent(jobId)}/env-files`,
			'job-env-files',
			body
		)) as FleetJobEnvFilesResponse;
		if (!payload || !Array.isArray(payload.files)) {
			throw new FleetClientError('malformed', 'Run env-file response did not contain a file list');
		}
		const files: FleetRunEnvFileContent[] = [];
		for (const file of payload.files) {
			if (
				!file ||
				typeof file.repoConnectionId !== 'string' ||
				typeof file.path !== 'string' ||
				typeof file.content !== 'string'
			) {
				throw new FleetClientError('malformed', 'Run env-file response contained a malformed entry');
			}
			// Registered with the redactor BEFORE the value is used anywhere.
			// The file as a WHOLE only ever matches a log line that reproduces
			// it verbatim, which is not how a `.env` leaks — a failing command
			// prints the one variable it read. So each VALUE inside it is
			// registered as well.
			this.logger?.protect(file.content);
			for (const value of extractRunEnvSecretValues(file.content)) this.logger?.protect(value);
			files.push({ repoConnectionId: file.repoConnectionId, path: file.path, content: file.content });
		}
		return files;
	}

	private async post(
		path: string,
		operation: string,
		body: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<unknown> {
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
		const timeoutSignal =
			this.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
				? AbortSignal.timeout(this.timeoutMs)
				: undefined;
		init.signal =
			signal && timeoutSignal && typeof AbortSignal.any === 'function'
				? AbortSignal.any([signal, timeoutSignal])
				: (signal ?? timeoutSignal);

		let response;
		try {
			response = await this.fetchFn(url, init);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new FleetClientError('network', `Could not reach ${url}: ${this.logger?.redact(detail) ?? detail}`);
		}

		if (!response.ok) {
			throw errorForJobStatus(response.status, operation);
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

/**
 * Map a response status to a stable error kind with a fixed,
 * client-authored message. Server bodies are deliberately NOT surfaced.
 */
export function errorForJobStatus(status: number, operation: string): FleetClientError {
	if (status === 401) {
		return new FleetClientError(
			'unauthorized',
			operation === 'lease'
				? 'Node credential was rejected (revoked, deleted, or the node was disabled)'
				: 'The platform refused this job (credential rejected, the job is not ours, or it already finished)',
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
	if (status === 409) {
		// Keyed on the status, never on the body: the reason token in the
		// 409 is stable by contract (`FLEET_JOB_STALE_LEASE_REASON`) but the
		// posture of this client is to surface nothing the server wrote.
		return new FleetClientError(
			'stale-lease',
			'The platform holds a newer lease on this job (stale-lease); the claim this node is renewing or finalizing is void',
			status
		);
	}
	if (status === 422) {
		// Run secrets (slice Y): reachable only by the authenticated holder
		// of an active job, so it leaks nothing the 401 posture protects.
		// The body carries a stable reason token which is logged
		// platform-side against this job; this client still does not read
		// it, because "never surface what the server wrote" is the rule
		// that keeps every other message on this channel honest.
		return new FleetClientError(
			'unresolved',
			'The platform could not resolve the env files this run asked for (unknown or disabled repository ' +
				'connection, a path the repository no longer carries, a decryption failure, or env-file delivery ' +
				'switched off on the instance). The precise reason is recorded platform-side against this job.',
			status
		);
	}
	if (status >= 400 && status < 500) {
		return new FleetClientError('invalid-request', `Request rejected by the API (HTTP ${status})`, status);
	}
	return new FleetClientError('server', `API error (HTTP ${status})`, status);
}
