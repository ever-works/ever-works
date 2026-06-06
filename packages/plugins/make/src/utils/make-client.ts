import type {
	MakeExecutionStatus,
	MakeHookSummary,
	MakeScenarioRunResponse,
	MakeScenarioSummary,
	MakeSettings,
	MakeWorkflowInput
} from '../types.js';
import { DEFAULT_MAX_POLL_ATTEMPTS, DEFAULT_POLL_INTERVAL_MS } from '../types.js';
// Direct import (NOT via `@ever-works/plugin/helpers`): the SSRF guard pulls in
// `node:net` / `node:dns` and is intentionally excluded from the helpers barrel.
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

export interface MakeExecutionResult {
	output: unknown;
	pollingAttempts: number;
	makeDuration?: number;
	executionId?: string;
}

interface MakeClientOptions {
	apiKey: string;
	baseUrl: string;
	teamId?: string;
	organizationId?: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
}

interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	query?: Record<string, string | number | undefined>;
	body?: unknown;
	signal?: AbortSignal;
}

/**
 * Thin HTTP client for the Make.com REST API.
 *
 * Uses fetch directly (no SDK) and authenticates with a Bearer API token.
 * Covers the subset of endpoints needed by the pipeline: scenarios (list,
 * detail, run) and hooks (list, detail, ping). See:
 *   https://developers.make.com/api-documentation/api-reference/scenarios
 *   https://developers.make.com/api-documentation/api-reference/hooks
 */
export class MakeClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly teamId?: string;
	private readonly organizationId?: string;
	private readonly logger: MakeClientOptions['logger'];

	constructor(options: MakeClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.teamId = options.teamId;
		this.organizationId = options.organizationId;
		this.logger = options.logger;
	}

	// ── Auth check / "who am I" ───────────────────────────────────────────

	async whoAmI(signal?: AbortSignal): Promise<unknown> {
		return this.request('/users/me', { signal });
	}

	// ── Scenarios ────────────────────────────────────────────────────────

	async listScenarios(signal?: AbortSignal): Promise<MakeScenarioSummary[]> {
		const query: Record<string, string | number | undefined> = {};
		if (this.teamId) query.teamId = this.teamId;
		else if (this.organizationId) query.organizationId = this.organizationId;

		const data = (await this.request('/scenarios', { query, signal })) as {
			scenarios?: MakeScenarioSummary[];
		};
		return Array.isArray(data?.scenarios) ? data.scenarios : [];
	}

	async getScenario(scenarioId: string | number, signal?: AbortSignal): Promise<MakeScenarioSummary> {
		const data = (await this.request(`/scenarios/${scenarioId}`, { signal })) as {
			scenario?: MakeScenarioSummary;
		};
		if (!data?.scenario) {
			throw new Error(`Scenario "${scenarioId}" not found`);
		}
		return data.scenario;
	}

	/**
	 * Validates that a scenario exists and is ready to run.
	 * Throws with a user-friendly message when the scenario is missing or inactive.
	 */
	async validateScenario(scenarioId: string | number, signal?: AbortSignal): Promise<MakeScenarioSummary> {
		const scenario = await this.getScenario(scenarioId, signal);
		if (scenario.isActive === false) {
			throw new Error(
				`Make.com scenario "${scenarioId}" is not active. Activate it in the Make.com dashboard first.`
			);
		}
		if (scenario.isPaused === true) {
			this.logger.warn(`Make.com scenario "${scenarioId}" is paused. Resuming may be required.`);
		}
		return scenario;
	}

	/**
	 * Triggers a scenario run and returns the raw response.
	 * Make exposes this as POST /scenarios/{scenarioId}/run
	 */
	async runScenario(
		scenarioId: string | number,
		input: MakeWorkflowInput,
		signal?: AbortSignal
	): Promise<MakeScenarioRunResponse> {
		return (await this.request(`/scenarios/${scenarioId}/run`, {
			method: 'POST',
			body: { data: input, responsive: true },
			signal
		})) as MakeScenarioRunResponse;
	}

	/**
	 * Polls the execution status of a scenario run until it succeeds, errors,
	 * the caller aborts, or we exceed the maximum number of attempts.
	 *
	 * Returns the final execution status alongside the number of poll attempts
	 * made, so callers can surface polling telemetry.
	 */
	async pollExecution(
		scenarioId: string | number,
		executionId: string,
		settings: Pick<MakeSettings, 'pollIntervalMs' | 'maxPollAttempts' | 'timeoutMs'>,
		onProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<{ status: MakeExecutionStatus; attempts: number }> {
		const intervalMs = settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
		const maxAttempts = settings.maxPollAttempts || DEFAULT_MAX_POLL_ATTEMPTS;
		const deadline = Date.now() + (settings.timeoutMs || maxAttempts * intervalMs);

		let attempt = 0;
		while (attempt < maxAttempts) {
			if (signal?.aborted) throw new Error('Pipeline execution was cancelled');
			if (Date.now() > deadline) {
				throw new Error(
					`Make.com scenario execution timed out after ${Math.round((settings.timeoutMs || 0) / 1000)}s`
				);
			}

			attempt += 1;
			const status = (await this.request(`/scenarios/${scenarioId}/executions/${executionId}`, { signal })) as {
				execution?: MakeExecutionStatus;
			};

			const exec = status?.execution ?? (status as unknown as MakeExecutionStatus);
			const normalizedStatus = String(exec?.status ?? 'unknown').toLowerCase();

			onProgress?.(attempt, normalizedStatus);

			if (normalizedStatus === 'success' || normalizedStatus === 'completed') {
				return { status: exec, attempts: attempt };
			}
			if (normalizedStatus === 'error' || normalizedStatus === 'stopped' || normalizedStatus === 'failed') {
				throw new Error(exec?.error || `Make.com scenario execution ${normalizedStatus}`);
			}

			await this.sleep(intervalMs, signal);
		}

		throw new Error(`Make.com scenario execution did not complete after ${maxAttempts} poll attempts`);
	}

	// ── Hooks (webhooks) ──────────────────────────────────────────────────

	async listHooks(signal?: AbortSignal): Promise<MakeHookSummary[]> {
		const query: Record<string, string | number | undefined> = {};
		if (this.teamId) query.teamId = this.teamId;

		const data = (await this.request('/hooks', { query, signal })) as { hooks?: MakeHookSummary[] };
		return Array.isArray(data?.hooks) ? data.hooks : [];
	}

	async getHook(hookId: string | number, signal?: AbortSignal): Promise<MakeHookSummary> {
		const data = (await this.request(`/hooks/${hookId}`, { signal })) as { hook?: MakeHookSummary };
		if (!data?.hook) {
			throw new Error(`Hook "${hookId}" not found`);
		}
		return data.hook;
	}

	async pingHook(hookId: string | number, signal?: AbortSignal): Promise<void> {
		await this.request(`/hooks/${hookId}/ping`, { signal });
	}

	/**
	 * Invokes a Make.com webhook URL with the given input.
	 * Webhook URLs are independent of the REST API and return the scenario's
	 * final output inline when the scenario uses a "Webhook Response" module.
	 */
	async invokeWebhook(webhookUrl: string, input: MakeWorkflowInput, signal?: AbortSignal): Promise<unknown> {
		// SSRF guard: webhookUrl is tenant-controlled (generator form / plugin
		// settings) and the call site at make.plugin.ts also forwards a hook URL
		// returned by the Make REST API. Reject literal private/loopback/
		// link-local/cloud-metadata IPs and non-HTTP(S) schemes before issuing
		// the request, so a malicious config can't make the server POST to (and
		// return the body of) an internal endpoint such as 169.254.169.254 IMDS.
		// Mirrors the content-extractor / pdf-extractor / source-validation guards.
		if (!isSafeWebhookUrl(webhookUrl)) {
			throw new Error('Make.com webhook URL is not safe to call (SSRF guard blocked the destination host).');
		}

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
			signal
		});

		const text = await response.text();
		if (!response.ok) {
			throw new Error(this.describeWebhookError(response.status, response.statusText, text));
		}

		try {
			return text ? JSON.parse(text) : {};
		} catch {
			return text;
		}
	}

	private describeWebhookError(status: number, statusText: string, rawBody: string): string {
		const body = truncate(rawBody);
		const base = `Make.com webhook returned ${status} ${statusText}`;

		if (status === 401 || status === 403) {
			return (
				`${base}. The webhook rejected the request. Verify in the Make.com dashboard that ` +
				`(1) the scenario tied to this webhook is active, ` +
				`(2) the webhook URL zone matches your workspace (e.g. us2 vs eu1), and ` +
				`(3) the webhook module does not require an API key / mandatory headers. ` +
				`Response: ${body}`
			);
		}
		if (status === 404) {
			return `${base}. The webhook URL was not found. It may have been deleted or regenerated in Make.com. Response: ${body}`;
		}
		if (status === 410) {
			return `${base}. The webhook has been disabled in Make.com. Re-enable it or recreate the scenario. Response: ${body}`;
		}
		return `${base}: ${body}`;
	}

	// ── Internal HTTP helpers ────────────────────────────────────────────

	private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
		const { method = 'GET', query, body, signal } = options;
		const url = this.buildUrl(path, query);

		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Token ${this.apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal
		});

		const text = await response.text();

		if (!response.ok) {
			throw this.wrapHttpError(response.status, response.statusText, text);
		}

		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
		const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== '') {
					url.searchParams.append(key, String(value));
				}
			}
		}
		// Security (SSRF): baseUrl is tenant-controlled plugin settings and flows
		// into every authenticated REST call (which carries the Make API token in
		// an `Authorization: Token …` header). Reject literal private/loopback/
		// link-local/cloud-metadata hosts and non-HTTP(S) schemes so a malicious
		// baseUrl (e.g. http://169.254.169.254 or http://10.0.0.1) can't redirect
		// the request — and the bearer token — to an internal endpoint and leak
		// its response back through the error path. Mirrors the invokeWebhook guard.
		const finalUrl = url.toString();
		if (!isSafeWebhookUrl(finalUrl)) {
			throw new Error('Make.com API base URL is not safe to call (SSRF guard blocked the destination host).');
		}
		return finalUrl;
	}

	private wrapHttpError(status: number, statusText: string, rawBody: string): Error {
		const message = extractErrorMessage(rawBody) || statusText || 'Unknown error';

		if (status === 401 || status === 403) {
			return new Error('Invalid Make.com API key or insufficient permissions. Please check the API key scopes.');
		}
		if (status === 404) {
			return new Error(`Make.com resource not found: ${message}`);
		}
		if (status === 429) {
			return new Error('Make.com rate limit exceeded. Please wait and try again.');
		}
		if (status >= 500) {
			return new Error(`Make.com service error (${status}): ${message}`);
		}
		return new Error(`Make.com request failed (${status}): ${message}`);
	}

	private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error('Pipeline execution was cancelled'));
				return;
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new Error('Pipeline execution was cancelled'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}
}

function extractErrorMessage(body: string): string | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as { message?: string; detail?: string; error?: string };
		return parsed.message || parsed.detail || parsed.error || undefined;
	} catch {
		// Raw (non-JSON) upstream bodies are not echoed back to avoid leaking
		// fragments of the request (e.g. auth tokens) that some APIs mirror in
		// their plain-text error responses.
		return undefined;
	}
}

function truncate(str: string, max = 300): string {
	if (!str) return '';
	return str.length > max ? `${str.slice(0, max)}…` : str;
}
