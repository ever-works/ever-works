import type { ComposioToolRef, ComposioConnectedAccount, ComposioToolkitEntry } from '../types.js';

export interface ComposioExecutionResult {
	/**
	 * Raw data returned by the Composio tool. Composio v3 wraps every
	 * response in `{ successful, data, error }`; we surface `data` here
	 * and translate `successful=false` into a thrown error in {@link ComposioClient.executeTool}.
	 */
	data: unknown;
	composioDuration: number;
}

interface ComposioClientOptions {
	apiKey: string;
	baseUrl?: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
	/** Test seam — injected by unit tests. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

interface ExecuteToolOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Subset of the v3 envelope returned by `POST /tools/execute/{slug}`.
 *
 * Composio always wraps tool responses; even successful calls flag failures
 * via `successful: false` rather than HTTP status codes, so the client must
 * inspect the envelope, not just `response.ok`.
 */
interface ComposioExecuteEnvelope {
	successful?: boolean;
	data?: unknown;
	error?: string;
	log_id?: string;
}

/**
 * Thin wrapper around the Composio v3 REST API.
 *
 * Avoids the @composio/core SDK to keep dependency footprint small (matches
 * the activepieces / make pattern). Adds abort-signal support and translates
 * Composio's wrapped error envelope into Error instances.
 */
export class ComposioClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly logger: ComposioClientOptions['logger'];
	private readonly fetchImpl: typeof fetch;

	constructor(options: ComposioClientOptions) {
		if (!options.apiKey || options.apiKey.trim() === '') {
			throw new Error('Composio API key is required.');
		}
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? 'https://backend.composio.dev/api/v3').replace(/\/+$/, '');
		this.logger = options.logger;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	/**
	 * Validates that:
	 *  1. The API key is accepted (200 from `/toolkits`).
	 *  2. The toolkit exists.
	 *  3. The user has at least one ACTIVE connected account for the toolkit.
	 *
	 * Throws a user-friendly error explaining which check failed.
	 */
	async validateConnection(ref: ComposioToolRef): Promise<ComposioConnectedAccount> {
		const accounts = await this.listConnectedAccounts(ref.userId, ref.toolkit);
		const active = accounts.find((a) => normalizeStatus(a.status) === 'ACTIVE');
		if (!active) {
			throw new Error(
				`No active Composio connected account found for user "${ref.userId}" on toolkit "${ref.toolkit}". ` +
					`Connect ${ref.toolkit} in the Composio dashboard (or via the plugin's connect flow) and retry.`
			);
		}
		return active;
	}

	/** Lists toolkits the API key has access to. Used by `isAvailable` and the settings UI. */
	async listToolkits(limit = 50): Promise<ComposioToolkitEntry[]> {
		const url = new URL(`${this.baseUrl}/toolkits`);
		url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 200))));
		const response = await this.request(url.toString(), { method: 'GET' });
		const body = (await response.json()) as unknown;
		return extractList<ComposioToolkitEntry>(body);
	}

	/**
	 * Lists the user's connected accounts, optionally filtered by toolkit.
	 * Returns an empty array if the API key has no access to that user or
	 * if the user has not connected any account yet.
	 */
	async listConnectedAccounts(userId: string, toolkit?: string): Promise<ComposioConnectedAccount[]> {
		const url = new URL(`${this.baseUrl}/connected_accounts`);
		// Composio v3 connected_accounts filters are list parameters — encode them
		// as repeated query params (`?user_ids=a&user_ids=b`) which is the format
		// the Composio Python SDK serializes. `.set()` would replace prior values
		// AND, on Composio side, can be interpreted as a single value rather than
		// a one-element list, which has been seen to filter strictly differently.
		url.searchParams.append('user_ids', userId);
		if (toolkit) url.searchParams.append('toolkit_slugs', toolkit.toUpperCase());
		const response = await this.request(url.toString(), { method: 'GET' });
		const body = (await response.json()) as unknown;
		return extractList<ComposioConnectedAccount>(body);
	}

	/**
	 * Executes a tool against the resolved user. Composio v3's response
	 * envelope is always `{ successful, data, error, log_id }` — we extract
	 * `data` on success and throw on failure with the upstream error text.
	 *
	 * Races against the abort signal so cancellation during long-running
	 * tools still resolves cleanly.
	 */
	async executeTool(
		ref: ComposioToolRef,
		args: Record<string, unknown>,
		options?: ExecuteToolOptions
	): Promise<ComposioExecutionResult> {
		const signal = options?.signal;
		if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

		const startTime = Date.now();
		this.logger.log(`Running Composio tool "${ref.toolSlug}" for user "${ref.userId}"`);

		const url = `${this.baseUrl}/tools/execute/${encodeURIComponent(ref.toolSlug)}`;
		const body: Record<string, unknown> = {
			user_id: ref.userId,
			arguments: args
		};
		if (options?.timeoutMs) body.timeout = Math.ceil(options.timeoutMs / 1000);

		const runPromise = this.request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal
		});

		const response = await runPromise;
		const envelope = (await response.json()) as ComposioExecuteEnvelope;

		if (envelope.successful === false) {
			throw new Error(
				`Composio tool "${ref.toolSlug}" execution failed: ${envelope.error ?? 'unknown error'}` +
					(envelope.log_id ? ` (log_id=${envelope.log_id})` : '')
			);
		}

		return {
			data: envelope.data ?? envelope,
			composioDuration: Date.now() - startTime
		};
	}

	private async request(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('x-api-key', this.apiKey);
		headers.set('accept', 'application/json');

		let response: Response;
		try {
			response = await this.fetchImpl(url, { ...init, headers });
		} catch (error) {
			if (init.signal?.aborted) throw new Error('Pipeline execution was cancelled');
			throw this.wrapNetworkError(error, url);
		}

		if (!response.ok) {
			throw await this.wrapHttpError(response, url);
		}
		return response;
	}

	private wrapNetworkError(error: unknown, url: string): Error {
		if (error instanceof Error) {
			return new Error(`Composio request to ${redactUrl(url)} failed: ${error.message}`);
		}
		return new Error(`Composio request to ${redactUrl(url)} failed: ${String(error)}`);
	}

	private async wrapHttpError(response: Response, url: string): Promise<Error> {
		let body = '';
		try {
			body = await response.text();
		} catch {
			// ignore — best-effort read
		}
		const preview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
		const redacted = redactUrl(url);

		if (response.status === 401 || response.status === 403) {
			return new Error(
				`Composio rejected the API key (HTTP ${response.status}) when calling ${redacted}. ` +
					`Verify COMPOSIO_API_KEY in plugin settings.${preview ? ` Response: ${preview}` : ''}`
			);
		}
		if (response.status === 404) {
			return new Error(
				`Composio returned 404 for ${redacted}. ` +
					`Likely causes: the tool slug or toolkit does not exist, or the user has no connected account.` +
					(preview ? ` Response: ${preview}` : '')
			);
		}
		if (response.status === 408 || response.status === 504) {
			return new Error(`Composio request to ${redacted} timed out (HTTP ${response.status}).`);
		}
		if (response.status === 429) {
			return new Error('Composio rate limit exceeded (HTTP 429). Wait and retry.');
		}
		if (response.status >= 500) {
			return new Error(
				`Composio is returning HTTP ${response.status} for ${redacted}. ` +
					`Check https://status.composio.dev.${preview ? ` Response: ${preview}` : ''}`
			);
		}
		return new Error(
			`Composio request to ${redacted} failed: HTTP ${response.status}${preview ? ` — ${preview}` : ''}`
		);
	}
}

/**
 * Composio v3 list endpoints wrap results in `{ items: [...] }`. Older
 * preview endpoints sometimes returned `{ data: [...] }` or a bare array,
 * so handle all three.
 */
function extractList<T>(body: unknown): T[] {
	if (Array.isArray(body)) return body as T[];
	if (body && typeof body === 'object') {
		const record = body as Record<string, unknown>;
		for (const key of ['items', 'data', 'results', 'records']) {
			const value = record[key];
			if (Array.isArray(value)) return value as T[];
		}
	}
	return [];
}

function normalizeStatus(status: string): string {
	return (status || '').trim().toUpperCase();
}

/**
 * Strips query strings from a URL before logging — Composio never embeds
 * secrets in query strings today, but `user_id` is PII so we redact it.
 */
function redactUrl(url: string): string {
	const idx = url.indexOf('?');
	return idx === -1 ? url : url.slice(0, idx);
}
