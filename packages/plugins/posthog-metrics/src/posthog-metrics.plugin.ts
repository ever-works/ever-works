import type {
	IMetricsProviderPlugin,
	MetricDescriptor,
	MetricQuery,
	MetricSample,
	MetricWindow,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginPricing,
	PluginSettings,
	JsonSchema,
	ConnectionValidationResult
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

/**
 * PostHog metrics-provider plugin (Goals feature, PR-9).
 *
 * OFFICIAL-SDK NOTE (house rule NN #22 — prefer official SDKs): the
 * official `posthog-node` SDK is **ingestion-only** — it covers
 * `capture`, `identify`, aliasing and feature-flag evaluation, but
 * exposes NO surface for the PostHog Query API
 * (`POST /api/projects/:project_id/query`), and PostHog ships no
 * official JS client for querying as of 2025/2026. Per the documented
 * escape hatch ("if no official SDK covers the surface, a documented
 * raw client is allowed"), this plugin implements a minimal fetch
 * client against the documented Query API
 * (https://posthog.com/docs/api/queries) instead of pulling in an SDK
 * that cannot make these calls.
 *
 * READ-ONLY BY CONTRACT (see `metrics-provider.interface.ts`): the
 * Query API is invoked via HTTP POST, but the request is a pure read —
 * it executes a HogQL `SELECT` server-side and mutates nothing. The
 * read-only contract is about side effects, not HTTP verbs. The plugin
 * only ever sends the two fixed `SELECT` statements below; user input
 * (the event name) is passed through HogQL placeholder `values`, never
 * string-interpolated into the query, so it cannot change the query
 * shape (no injection, no writes).
 *
 * Metrics:
 * - `event_count`  — `count()` of a configured event over a
 *   day/week/month UTC window (params: `{ event: string }`).
 * - `active_users` — `count(DISTINCT person_id)` over a day/week/month
 *   UTC window.
 *
 * Pair it with a **personal API key scoped to `Query: Read`** only —
 * see the README for how to create one.
 */

/** Default PostHog Cloud (US) API host. EU Cloud: `https://eu.posthog.com`. */
export const DEFAULT_API_HOST = 'https://us.posthog.com';

/** Hard cap on the request duration (15 s) — mirrors `custom-http-metrics`. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Metric ids served by this provider. */
export const POSTHOG_METRIC_IDS = {
	EVENT_COUNT: 'event_count',
	ACTIVE_USERS: 'active_users'
} as const;

/** Windows that map to a `[from, to)` HogQL timestamp range filter. */
const RANGE_WINDOWS = ['day', 'week', 'month'] as const;
export type RangeWindow = (typeof RANGE_WINDOWS)[number];

function isRangeWindow(window: MetricWindow): window is RangeWindow {
	return (RANGE_WINDOWS as readonly string[]).includes(window);
}

/**
 * Stable machine-readable failure codes for {@link PostHogMetricsError}.
 * Mirrors the `custom-http-metrics` idiom where the codes overlap
 * (`http_error`, `timeout`, `value_not_numeric`, ...).
 */
export type PostHogMetricsErrorCode =
	| 'invalid_settings'
	| 'unknown_metric'
	| 'unsupported_window'
	| 'invalid_params'
	| 'timeout'
	| 'http_error'
	| 'invalid_response'
	| 'value_not_numeric';

/**
 * Typed error thrown by the plugin. The facade wraps non-FacadeError
 * plugin failures, so the discriminated `code` (not the message) is
 * the stable contract for programmatic handling / tests.
 */
export class PostHogMetricsError extends Error {
	readonly code: PostHogMetricsErrorCode;
	/** HTTP status of the upstream response (only for `http_error`). */
	readonly status?: number;

	constructor(code: PostHogMetricsErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'PostHogMetricsError';
		this.code = code;
		if (options?.status !== undefined) {
			this.status = options.status;
		}
	}
}

/**
 * The two fixed HogQL statements this plugin can execute. User input is
 * NEVER concatenated into these strings — the event name and the window
 * boundaries travel via the HogQL placeholder `values` payload, which
 * the Query API substitutes as typed constants server-side.
 *
 * PostHog stores event timestamps in UTC; window boundaries are computed
 * in UTC (see {@link resolveWindowRange}) and passed as
 * `YYYY-MM-DD HH:MM:SS` strings for `toDateTime()`.
 */
export const EVENT_COUNT_HOGQL =
	'SELECT count() FROM events WHERE event = {event} ' +
	'AND timestamp >= toDateTime({date_from}) AND timestamp < toDateTime({date_to})';

export const ACTIVE_USERS_HOGQL =
	'SELECT count(DISTINCT person_id) FROM events ' +
	'WHERE timestamp >= toDateTime({date_from}) AND timestamp < toDateTime({date_to})';

/** Format a Unix-ms instant as a HogQL-friendly `YYYY-MM-DD HH:MM:SS` UTC string. */
function formatUtcDateTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

/**
 * Resolve a metric window + optional ISO-8601 anchor into a
 * `[dateFrom, dateTo)` (inclusive start, exclusive end) pair of
 * `YYYY-MM-DD HH:MM:SS` UTC strings. All boundaries are computed in UTC
 * — same math as the `stripe-metrics` sibling:
 *
 * - `day`   — 00:00:00 UTC of the anchor's date, +1 day.
 * - `week`  — ISO week: 00:00:00 UTC of the Monday on/before the anchor, +7 days.
 * - `month` — 00:00:00 UTC of the 1st of the anchor's month, +1 month.
 *
 * Exported for direct unit testing of the boundary math.
 */
export function resolveWindowRange(window: RangeWindow, anchor?: string): { dateFrom: string; dateTo: string } {
	const anchorDate = anchor ? new Date(anchor) : new Date();
	if (Number.isNaN(anchorDate.getTime())) {
		throw new Error(`Invalid windowAnchor '${anchor}': expected an ISO-8601 date/time string.`);
	}

	const y = anchorDate.getUTCFullYear();
	const m = anchorDate.getUTCMonth();
	const d = anchorDate.getUTCDate();

	let startMs: number;
	let endMs: number;

	switch (window) {
		case 'day': {
			startMs = Date.UTC(y, m, d);
			endMs = Date.UTC(y, m, d + 1);
			break;
		}
		case 'week': {
			// getUTCDay(): 0 = Sunday ... 6 = Saturday. ISO weeks start Monday.
			const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
			const daysSinceMonday = (dow + 6) % 7;
			startMs = Date.UTC(y, m, d - daysSinceMonday);
			endMs = Date.UTC(y, m, d - daysSinceMonday + 7);
			break;
		}
		case 'month': {
			startMs = Date.UTC(y, m, 1);
			endMs = Date.UTC(y, m + 1, 1);
			break;
		}
	}

	return { dateFrom: formatUtcDateTime(startMs), dateTo: formatUtcDateTime(endMs) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a JSON value to a finite number, or `undefined` when impossible. */
function coerceFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * PostHog metrics-provider plugin. See the module doc block for the
 * official-SDK rationale and the read-only argument.
 */
export class PostHogMetricsPlugin implements IMetricsProviderPlugin {
	readonly id = 'posthog-metrics';
	readonly name = 'PostHog Metrics';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'metrics';
	readonly capabilities: readonly string[] = [PLUGIN_CAPABILITIES.METRICS_PROVIDER];
	readonly providerName = 'posthog';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiHost: {
				type: 'string',
				title: 'PostHog API host',
				format: 'uri',
				description:
					'Base URL of your PostHog instance. US Cloud: https://us.posthog.com (default), ' +
					'EU Cloud: https://eu.posthog.com, or your self-hosted URL.',
				default: DEFAULT_API_HOST
			},
			projectId: {
				type: 'string',
				title: 'Project ID',
				description:
					'Numeric PostHog project id metrics are read from (PostHog → Settings → Project → Project ID).',
				'x-envVar': 'POSTHOG_PROJECT_ID'
			},
			personalApiKey: {
				type: 'string',
				title: 'Personal API key',
				description:
					'A personal API key (phx_...) scoped to Query: Read only is strongly recommended. ' +
					'Create one at PostHog → Settings → Personal API keys. Broader keys also work but grant far more than this plugin needs.',
				'x-secret': true,
				'x-envVar': 'POSTHOG_PERSONAL_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['projectId', 'personalApiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('PostHog Metrics Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async listMetrics(_settings?: PluginSettings): Promise<MetricDescriptor[]> {
		return [
			{
				id: POSTHOG_METRIC_IDS.EVENT_COUNT,
				label: 'Event count',
				unit: 'count',
				supportedWindows: [...RANGE_WINDOWS],
				paramsSchema: {
					type: 'object',
					properties: {
						event: {
							type: 'string',
							title: 'Event name',
							description:
								"PostHog event name to count (e.g. '$pageview', 'signup'). " +
								'Passed as a HogQL placeholder value — never interpolated into the query.',
							minLength: 1
						}
					},
					required: ['event']
				}
			},
			{
				id: POSTHOG_METRIC_IDS.ACTIVE_USERS,
				label: 'Active users (unique persons)',
				unit: 'count',
				supportedWindows: [...RANGE_WINDOWS]
			}
		];
	}

	async getMetricValue(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		switch (query.metricId) {
			case POSTHOG_METRIC_IDS.EVENT_COUNT:
				return this.readEventCount(query, settings);
			case POSTHOG_METRIC_IDS.ACTIVE_USERS:
				return this.readActiveUsers(query, settings);
			default:
				throw new PostHogMetricsError(
					'unknown_metric',
					`Unknown metric '${query.metricId}' for provider '${this.providerName}'. ` +
						`Available: ${Object.values(POSTHOG_METRIC_IDS).join(', ')}.`
				);
		}
	}

	isAvailable(settings?: PluginSettings): boolean {
		return Boolean(
			this.resolvePersonalApiKey(settings, { optional: true }) &&
				this.resolveProjectId(settings, { optional: true })
		);
	}

	/**
	 * EW-602 — PostHog does not charge per Query API call, so metric
	 * reads are free at the provider level. Usage is still recorded
	 * (units) against PluginUsageEvent by the MetricsFacadeService.
	 */
	getPricing(): PluginPricing {
		return {
			costPerCallCents: 0,
			currency: 'usd',
			note: 'PostHog Query API calls are free; only usage units are tracked.'
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const resolved = settings as PluginSettings;
		const key = this.resolvePersonalApiKey(resolved, { optional: true });
		const projectId = this.resolveProjectId(resolved, { optional: true });
		if (!key || !projectId) {
			return { success: false, message: 'PostHog personal API key and/or project id are not configured.' };
		}

		try {
			// Read-only probe — a constant SELECT touches no data.
			await this.postScalarQuery('SELECT 1', {}, resolved);
			return { success: true, message: 'PostHog connection verified (read-only query probe).' };
		} catch (error) {
			return {
				success: false,
				message: `PostHog connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'PostHog Metrics plugin is ready (personal API key + project id required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Read-only PostHog product analytics metrics — event counts and unique active users per day/week/month — for evaluating Goals.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			homepage: 'https://posthog.com',
			icon: { type: 'emoji', value: '🦔' },
			keywords: ['metrics', 'goals', 'posthog', 'analytics'],
			readme: [
				'## What does PostHog Metrics do?',
				'',
				'Exposes read-only product analytics metrics from your PostHog project so Goals can evaluate targets like "100 signups/day" or "1000 active users/month".',
				'',
				'## Metrics',
				'',
				"- **Event count** (`event_count`) — how many times a given event (e.g. `$pageview`, `signup`) occurred over a day, week, or month (UTC). Takes a `{ event }` parameter.",
				'- **Active users** (`active_users`) — unique persons (`count(DISTINCT person_id)`) with at least one event over a day, week, or month (UTC).',
				'',
				'## Read-only by design',
				'',
				'This plugin only executes fixed HogQL `SELECT` statements through the PostHog Query API — it never writes to your PostHog project. Use a **personal API key scoped to `Query: Read`** only:',
				'',
				'1. Open PostHog → **Settings** → **Personal API keys**',
				'2. **Create personal API key** → scope it to *Query: Read* on your project',
				'3. Paste the `phx_...` key in the **Personal API key** field below, plus your **Project ID** (Settings → Project)',
				'',
				'EU Cloud or self-hosted? Set **PostHog API host** accordingly (default is `https://us.posthog.com`).'
			].join('\n')
		};
	}

	// ── metric readers ──────────────────────────────────────────────────

	private async readEventCount(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		const window = this.assertRangeWindow(query);

		const event = query.params?.event;
		if (typeof event !== 'string' || event.trim() === '') {
			throw new PostHogMetricsError(
				'invalid_params',
				`Metric '${POSTHOG_METRIC_IDS.EVENT_COUNT}' requires params.event — the PostHog event name to count (e.g. '$pageview').`
			);
		}

		const { dateFrom, dateTo } = resolveWindowRange(window, query.windowAnchor);
		return this.readScalarMetric(
			query.metricId,
			EVENT_COUNT_HOGQL,
			{ event, date_from: dateFrom, date_to: dateTo },
			settings
		);
	}

	private async readActiveUsers(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		const window = this.assertRangeWindow(query);
		const { dateFrom, dateTo } = resolveWindowRange(window, query.windowAnchor);
		return this.readScalarMetric(
			query.metricId,
			ACTIVE_USERS_HOGQL,
			{ date_from: dateFrom, date_to: dateTo },
			settings
		);
	}

	private async readScalarMetric(
		metricId: string,
		hogql: string,
		values: Record<string, string>,
		settings?: PluginSettings
	): Promise<MetricSample> {
		try {
			const raw = await this.postScalarQuery(hogql, values, settings);
			const value = coerceFiniteNumber(raw);
			if (value === undefined) {
				throw new PostHogMetricsError(
					'value_not_numeric',
					`PostHog returned a non-numeric value for metric '${metricId}' (got ${JSON.stringify(raw)}).`
				);
			}
			return {
				value,
				unit: 'count',
				at: new Date().toISOString()
			};
		} catch (error) {
			this.logError(metricId, error);
			throw error;
		}
	}

	// ── minimal Query API client (see the module doc block for why this
	//    is a raw fetch client and not an SDK) ──────────────────────────

	/**
	 * POST one HogQL query to `/api/projects/:projectId/query/` and
	 * return the single scalar at `results[0][0]`.
	 */
	private async postScalarQuery(
		hogql: string,
		values: Record<string, string>,
		settings?: PluginSettings
	): Promise<unknown> {
		const apiHost = this.resolveApiHost(settings);
		const projectId = this.resolveProjectId(settings) as string;
		const personalApiKey = this.resolvePersonalApiKey(settings) as string;

		const url = `${apiHost}/api/projects/${encodeURIComponent(projectId)}/query/`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${personalApiKey}`
				},
				body: JSON.stringify({
					query: { kind: 'HogQLQuery', query: hogql, values }
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch (error) {
			if (isTimeoutError(error)) {
				throw new PostHogMetricsError(
					'timeout',
					`PostHog Query API did not respond within ${REQUEST_TIMEOUT_MS}ms.`,
					{ cause: error }
				);
			}
			throw error;
		}

		if (!response.ok) {
			throw new PostHogMetricsError('http_error', `PostHog Query API responded with HTTP ${response.status}.`, {
				status: response.status
			});
		}

		let data: unknown;
		try {
			data = await response.json();
		} catch (error) {
			throw new PostHogMetricsError('invalid_response', 'PostHog Query API returned invalid JSON.', {
				cause: error
			});
		}

		// HogQLQuery responses carry rows in `results` (array of arrays);
		// a scalar aggregate is a single row with a single column.
		if (!isPlainObject(data) || !Array.isArray(data.results)) {
			throw new PostHogMetricsError(
				'invalid_response',
				'PostHog Query API response has no "results" rows — expected a HogQLQuery response.'
			);
		}
		const firstRow: unknown = data.results[0];
		if (!Array.isArray(firstRow) || firstRow.length === 0) {
			throw new PostHogMetricsError(
				'invalid_response',
				'PostHog Query API response contains no scalar value at results[0][0].'
			);
		}
		return firstRow[0];
	}

	// ── helpers ─────────────────────────────────────────────────────────

	private assertRangeWindow(query: MetricQuery): RangeWindow {
		if (!isRangeWindow(query.window)) {
			throw new PostHogMetricsError(
				'unsupported_window',
				`Metric '${query.metricId}' does not support window '${query.window}'. ` +
					`Supported: ${RANGE_WINDOWS.join(', ')}.`
			);
		}
		return query.window;
	}

	private resolveApiHost(settings?: PluginSettings): string {
		const fromSettings = settings?.apiHost;
		const raw =
			typeof fromSettings === 'string' && fromSettings.trim() !== '' ? fromSettings.trim() : DEFAULT_API_HOST;

		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			throw new PostHogMetricsError('invalid_settings', `apiHost '${raw}' is not a valid URL.`);
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			throw new PostHogMetricsError(
				'invalid_settings',
				`apiHost must be an http(s) URL (got '${parsed.protocol}//').`
			);
		}
		return raw.replace(/\/+$/, '');
	}

	private resolveProjectId(settings?: PluginSettings, opts?: { optional: boolean }): string | undefined {
		const fromSettings = settings?.projectId;
		if (typeof fromSettings === 'string' && fromSettings.trim() !== '') return fromSettings.trim();
		if (typeof fromSettings === 'number' && Number.isFinite(fromSettings)) return String(fromSettings);

		const fromEnv = process.env.POSTHOG_PROJECT_ID;
		if (fromEnv && fromEnv.length > 0) return fromEnv;

		if (opts?.optional) return undefined;
		throw new PostHogMetricsError(
			'invalid_settings',
			'PostHog project id not configured. ' +
				'Set it in plugin settings or via the POSTHOG_PROJECT_ID environment variable.'
		);
	}

	private resolvePersonalApiKey(settings?: PluginSettings, opts?: { optional: boolean }): string | undefined {
		const fromSettings = settings?.personalApiKey;
		if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;

		const fromEnv = process.env.POSTHOG_PERSONAL_API_KEY;
		if (fromEnv && fromEnv.length > 0) return fromEnv;

		if (opts?.optional) return undefined;
		throw new PostHogMetricsError(
			'invalid_settings',
			'PostHog personal API key not configured. ' +
				'Set it in plugin settings or via the POSTHOG_PERSONAL_API_KEY environment variable.'
		);
	}

	private logError(metricId: string, error: unknown): void {
		this.context?.logger.error(
			`PostHog metrics read failed (${metricId}): ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export default PostHogMetricsPlugin;
