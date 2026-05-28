import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './types.js';

export interface AgentmemoryClientOptions {
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly timeoutMs?: number;
	readonly logger?: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
	/** Optional fetch override — passed in by tests so we don't talk to
	 *  a real server. Falls back to global `fetch` otherwise. */
	readonly fetchImpl?: typeof fetch;
}

export interface AgentmemoryClientRequestOptions {
	readonly method?: 'GET' | 'POST' | 'DELETE';
	readonly body?: unknown;
	readonly query?: Record<string, string | number | undefined>;
	readonly signal?: AbortSignal;
}

/**
 * Thin HTTP wrapper for the `agentmemory` REST API (Node service on
 * `III_REST_PORT`, default 3111). All paths are documented in the
 * upstream `src/triggers/api.ts` — we only call the public, stable
 * subset documented at https://github.com/rohitg00/agentmemory.
 *
 * The client is deliberately UN-opinionated: callers (the plugin class)
 * own request shaping and response normalisation. This keeps it trivial
 * to swap in a different memory backend later — `mem0`, `zep`,
 * `langmem` — by writing a sibling client with the same surface.
 */
export class AgentmemoryClient {
	private readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	private readonly timeoutMs: number;
	private readonly logger: NonNullable<AgentmemoryClientOptions['logger']>;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AgentmemoryClientOptions = {}) {
		this.baseUrl = stripTrailingSlash(options.baseUrl || DEFAULT_BASE_URL);
		this.apiKey = options.apiKey?.trim() || undefined;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.logger = options.logger ?? console;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	/** GET /agentmemory/health — public, no auth required. Used for
	 *  the plugin's `isAvailable` + `validateConnection` checks. */
	async health(signal?: AbortSignal): Promise<{ ok: boolean; raw?: unknown }> {
		const result = await this.request<unknown>('/agentmemory/health', {
			method: 'GET',
			signal
		});
		// agentmemory returns { status: 'ok' } | { ok: true } depending on version.
		if (result && typeof result === 'object') {
			const obj = result as Record<string, unknown>;
			if (obj.ok === true) return { ok: true, raw: result };
			if (typeof obj.status === 'string' && obj.status.toLowerCase() === 'ok') {
				return { ok: true, raw: result };
			}
		}
		return { ok: false, raw: result };
	}

	async sessionStart(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/session/start', { method: 'POST', body, signal });
	}

	async sessionEnd(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/session/end', { method: 'POST', body, signal });
	}

	async observe(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/observe', { method: 'POST', body, signal });
	}

	async remember(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/remember', { method: 'POST', body, signal });
	}

	async smartSearch(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/smart-search', { method: 'POST', body, signal });
	}

	async context(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/context', { method: 'POST', body, signal });
	}

	async forget(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/forget', { method: 'POST', body, signal });
	}

	async listSessions(query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<unknown> {
		return this.request('/agentmemory/sessions', { method: 'GET', query, signal });
	}

	private async request<T>(path: string, options: AgentmemoryClientRequestOptions): Promise<T> {
		const url = buildUrl(this.baseUrl, path, options.query);
		// `const` here matches the activepieces / anthropic plugin
		// convention and the repo's eslint `prefer-const` rule — the
		// reference is never rebound, only properties are added below.
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (this.apiKey) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}

		let body: BodyInit | undefined;
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(options.body);
		}

		const controller = new AbortController();
		const timeoutHandle = setTimeout(
			() => controller.abort(new Error('agentmemory request timed out')),
			this.timeoutMs
		);
		const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Aborted'));
		options.signal?.addEventListener('abort', onAbort, { once: true });

		try {
			const response = await this.fetchImpl(url, {
				method: options.method ?? 'GET',
				headers,
				body,
				signal: controller.signal
			});

			if (!response.ok) {
				throw await buildHttpError(response, url);
			}

			const text = await response.text();
			if (!text) return undefined as T;
			try {
				return JSON.parse(text) as T;
			} catch {
				return text as unknown as T;
			}
		} catch (error) {
			if (isAbortError(error)) {
				if (options.signal?.aborted) {
					throw new Error('agentmemory request cancelled');
				}
				throw new Error(`agentmemory request timed out: ${path}`);
			}
			throw error;
		} finally {
			clearTimeout(timeoutHandle);
			options.signal?.removeEventListener('abort', onAbort);
		}
	}
}

function stripTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
	const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

async function buildHttpError(response: Response, url: string): Promise<Error> {
	let detail = '';
	try {
		const text = await response.text();
		if (text) detail = text.length > 500 ? text.slice(0, 500) + '...' : text;
	} catch {
		// ignore
	}

	const baseMessage = `agentmemory request failed (${response.status} ${response.statusText}) for ${url}`;

	if (response.status === 401 || response.status === 403) {
		return new Error(
			"agentmemory rejected the request — check the `apiKey` setting matches the server's `AGENTMEMORY_SECRET`."
		);
	}
	if (response.status === 404) {
		return new Error(
			`agentmemory endpoint not found at ${url}. ` +
				'Either the server is an older version or the configured `baseUrl` is wrong.'
		);
	}
	if (response.status === 429) {
		return new Error('agentmemory rate-limited the request. Retry after a short delay.');
	}
	return new Error(`${baseMessage}${detail ? ` — ${detail}` : ''}`);
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const name = (error as { name?: string }).name;
	return name === 'AbortError' || name === 'TimeoutError';
}
