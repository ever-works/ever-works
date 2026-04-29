import type {
	ActivepiecesExecutionResult,
	ActivepiecesFlow,
	ActivepiecesFlowInput,
	ActivepiecesSettings,
	WebhookMode
} from '../types.js';

export interface ActivepiecesClientOptions {
	apiKey: string;
	baseUrl: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
}

interface RequestOptions {
	method?: 'GET' | 'POST' | 'DELETE';
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
	includeAuth?: boolean;
}

/**
 * Thin wrapper around Activepieces REST API endpoints used by the pipeline.
 * Talks directly to the public Activepieces API — no SDK is required.
 *
 * Endpoints used (paths are appended to the configured baseUrl, e.g. `/api/v1`):
 *   - GET    /flows/{id}                          — flow lookup / validation
 *   - GET    /flow-runs?projectId=...&flowId=...  — recent run lookup
 *   - POST   /webhooks/{flowId}                   — async flow trigger
 *   - POST   /webhooks/{flowId}/sync              — sync flow trigger (returns flow output)
 *
 */
export class ActivepiecesClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly logger: ActivepiecesClientOptions['logger'];

	constructor(options: ActivepiecesClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = stripTrailingSlash(options.baseUrl);
		this.logger = options.logger;
	}

	/** Lightweight ping that hits the flows list to verify auth + reachability. */
	async ping(projectId?: string): Promise<void> {
		const query: Record<string, string | number> = { limit: 1 };
		if (projectId) query.projectId = projectId;
		await this.request('/flows', { method: 'GET', query });
	}

	/** Fetches a flow by id and ensures it is enabled. */
	async validateFlow(flowId: string): Promise<ActivepiecesFlow> {
		const flow = await this.request<ActivepiecesFlow>(`/flows/${encodeURIComponent(flowId)}`, {
			method: 'GET'
		});

		if (!flow || typeof flow !== 'object') {
			throw new Error(`Activepieces flow "${flowId}" returned an unexpected response`);
		}

		if (flow.status && flow.status !== 'ENABLED') {
			throw new Error(
				`Activepieces flow "${flowId}" is not enabled (status: ${flow.status}). ` +
					'Enable the flow from the Activepieces dashboard before triggering it.'
			);
		}

		if (!flow.publishedVersionId) {
			this.logger.warn(
				`Activepieces flow "${flowId}" has no published version. ` +
					'Publish the flow before invoking it; the webhook trigger will fail otherwise.'
			);
		}

		return flow;
	}

	/**
	 * Triggers an Activepieces flow webhook with the prepared payload.
	 *
	 * In sync mode (`/sync`), Activepieces holds the request open until the flow returns
	 * its Response action output — this is the recommended mode for pipeline use.
	 *
	 * In async mode, the webhook returns immediately and the plugin cannot retrieve the
	 * flow output. Sync is therefore the only fully supported mode.
	 */
	async executeFlow(
		flowId: string,
		input: ActivepiecesFlowInput,
		settings: ActivepiecesSettings,
		onProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<ActivepiecesExecutionResult> {
		if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

		const startTime = Date.now();
		const path = webhookPath(flowId, settings.webhookMode);
		this.logger.log(`Triggering Activepieces webhook ${path} (mode=${settings.webhookMode})`);

		onProgress?.(1, 'running');

		const response = await this.request<unknown>(path, {
			method: 'POST',
			body: input,
			signal,
			timeoutMs: settings.timeoutMs,
			// Webhook endpoints are public per-flow URLs and do not need the platform token.
			// Sending the bearer is harmless for cloud, but self-hosted gateways may reject it,
			// so we only forward the API key on platform endpoints.
			includeAuth: false
		});

		onProgress?.(1, 'completed');

		const flowDuration = Date.now() - startTime;
		const flowRunId = extractFlowRunId(response);

		return {
			output: response,
			flowRunId,
			flowDuration
		};
	}

	private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const url = buildUrl(this.baseUrl, path, options.query);
		const headers: Record<string, string> = {
			Accept: 'application/json'
		};

		if (options.includeAuth !== false) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}

		let body: BodyInit | undefined;
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(options.body);
		}

		const controller = new AbortController();
		const timeoutHandle = options.timeoutMs
			? setTimeout(() => controller.abort(new Error('Request timed out')), options.timeoutMs)
			: undefined;

		const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Aborted'));
		options.signal?.addEventListener('abort', onAbort, { once: true });

		try {
			const response = await fetch(url, {
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
					throw new Error('Pipeline execution was cancelled');
				}
				throw new Error(`Activepieces request timed out: ${path}`);
			}
			throw error;
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener('abort', onAbort);
		}
	}
}

function stripTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildUrl(
	baseUrl: string,
	path: string,
	query?: Record<string, string | number | boolean | undefined>
): string {
	const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

function webhookPath(flowId: string, mode: WebhookMode): string {
	const encoded = encodeURIComponent(flowId);
	return mode === 'sync' ? `/webhooks/${encoded}/sync` : `/webhooks/${encoded}`;
}

function extractFlowRunId(response: unknown): string | undefined {
	if (!response || typeof response !== 'object') return undefined;
	const obj = response as Record<string, unknown>;
	for (const key of ['runId', 'flowRunId', 'id']) {
		const value = obj[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}

async function buildHttpError(response: Response, url: string): Promise<Error> {
	let detail = '';
	try {
		const text = await response.text();
		if (text) detail = text.length > 500 ? text.slice(0, 500) + '...' : text;
	} catch {
		// ignore
	}

	const baseMessage = `Activepieces request failed (${response.status} ${response.statusText}) for ${url}`;

	if (response.status === 401 || response.status === 403) {
		return new Error('Invalid Activepieces API key. Please update your API key in plugin settings.');
	}
	if (response.status === 404) {
		return new Error(
			'Activepieces resource not found. Verify the flow ID, project ID, and that the flow is published.'
		);
	}
	if (response.status === 429) {
		return new Error('Activepieces rate limit exceeded. Please wait and try again.');
	}
	if (response.status >= 500) {
		return new Error(`${baseMessage}. The Activepieces server returned an error.${detail ? ` Detail: ${detail}` : ''}`);
	}
	return new Error(`${baseMessage}${detail ? ` — ${detail}` : ''}`);
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const name = (error as { name?: string }).name;
	return name === 'AbortError' || name === 'TimeoutError';
}
