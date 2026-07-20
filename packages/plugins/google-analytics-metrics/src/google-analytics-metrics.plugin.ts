import { BetaAnalyticsDataClient } from '@google-analytics/data';
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
	ConnectionValidationResult,
	ValidationError,
	ValidationResult
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

/**
 * Google Analytics Metrics — `metrics-provider` plugin (Goals PR-9).
 *
 * Reads GA4 aggregate metrics through the **official
 * `@google-analytics/data` SDK** (`BetaAnalyticsDataClient.runReport`) so
 * Goals can evaluate targets like "1000 active users/week" without
 * hard-coding Google anywhere in the platform.
 *
 * READ-ONLY BY CONTRACT (see `metrics-provider.interface.ts`): the GA4
 * Data API is a reporting-only API — `runReport` cannot mutate anything.
 * Pair it with a service account that only has the **Viewer** role on
 * the GA4 property (see the README).
 */

/** Metric ids served by this provider. */
export const GA_METRIC_IDS = {
	ACTIVE_USERS: 'active_users',
	SESSIONS: 'sessions',
	CONVERSIONS: 'conversions'
} as const;

export type GaMetricId = (typeof GA_METRIC_IDS)[keyof typeof GA_METRIC_IDS];

/**
 * Provider metric id → GA4 Data API metric name.
 *
 * NOTE on `conversions`: GA4 renamed "conversions" to **"key events"** in
 * March 2024 — `keyEvents` is the current Data API metric name and the
 * old `conversions` API name is deprecated/removed on newer properties.
 * We keep the provider-facing id `conversions` (that is what Goals users
 * expect) but query `keyEvents` upstream. See the README for the rename
 * background.
 */
const GA_API_METRIC_NAMES: Record<GaMetricId, string> = {
	[GA_METRIC_IDS.ACTIVE_USERS]: 'activeUsers',
	[GA_METRIC_IDS.SESSIONS]: 'sessions',
	[GA_METRIC_IDS.CONVERSIONS]: 'keyEvents'
};

/** Windows every GA metric of this provider supports. */
const RANGE_WINDOWS = ['day', 'week', 'month'] as const;
export type RangeWindow = (typeof RANGE_WINDOWS)[number];

function isRangeWindow(window: MetricWindow): window is RangeWindow {
	return (RANGE_WINDOWS as readonly string[]).includes(window);
}

/** Unit reported for all metrics — they are all plain event/user counts. */
const UNIT = 'count';

/** gRPC status codes the google-gax transport surfaces on auth failures. */
const GRPC_UNAUTHENTICATED = 16;
const GRPC_PERMISSION_DENIED = 7;

/**
 * Stable machine-readable failure codes for
 * {@link GoogleAnalyticsMetricsError} (mirrors the `custom-http-metrics`
 * sibling idiom).
 */
export type GoogleAnalyticsMetricsErrorCode =
	| 'invalid_settings'
	| 'unknown_metric'
	| 'unsupported_window'
	| 'invalid_anchor'
	| 'auth_error'
	| 'http_error'
	| 'invalid_response';

/**
 * Typed error thrown by the plugin. The facade wraps non-FacadeError
 * plugin failures, so the discriminated `code` (not the message) is the
 * stable contract for programmatic handling / tests.
 */
export class GoogleAnalyticsMetricsError extends Error {
	readonly code: GoogleAnalyticsMetricsErrorCode;
	/** HTTP-equivalent status of the upstream failure, when known. */
	readonly status?: number;

	constructor(
		code: GoogleAnalyticsMetricsErrorCode,
		message: string,
		options?: { status?: number; cause?: unknown }
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'GoogleAnalyticsMetricsError';
		this.code = code;
		if (options?.status !== undefined) {
			this.status = options.status;
		}
	}
}

/** The fields of a service-account JSON key this plugin actually uses. */
export interface ServiceAccountCredentials {
	clientEmail: string;
	privateKey: string;
	projectId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse + shape-check a service-account JSON key. Throws a typed
 * `invalid_settings` error on unparsable JSON or a key that is missing
 * `client_email` / `private_key` — the two fields the SDK needs to mint
 * OAuth tokens. Exported for direct unit testing.
 */
export function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			'serviceAccountJson is not valid JSON — paste the full service-account key file downloaded from Google Cloud.',
			{ cause: error }
		);
	}

	if (!isPlainObject(parsed)) {
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			'serviceAccountJson must be a JSON object (the service-account key file), not a bare value.'
		);
	}

	const clientEmail = parsed.client_email;
	const privateKey = parsed.private_key;
	if (
		typeof clientEmail !== 'string' ||
		clientEmail.trim() === '' ||
		typeof privateKey !== 'string' ||
		privateKey.trim() === ''
	) {
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			'serviceAccountJson is missing "client_email" and/or "private_key" — it does not look like a service-account key file.'
		);
	}

	const credentials: ServiceAccountCredentials = { clientEmail, privateKey };
	if (typeof parsed.project_id === 'string' && parsed.project_id.trim() !== '') {
		credentials.projectId = parsed.project_id;
	}
	return credentials;
}

/**
 * Normalize a GA4 property id: accepts either the bare numeric id
 * (`"123456789"`) or the API resource name (`"properties/123456789"`),
 * returns the bare numeric id. Throws `invalid_settings` on anything else.
 */
export function normalizePropertyId(raw: string): string {
	const trimmed = raw.trim();
	const bare = trimmed.startsWith('properties/') ? trimmed.slice('properties/'.length) : trimmed;
	if (!/^\d+$/.test(bare)) {
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			`Invalid GA4 property id "${raw}" — expected a numeric id like "123456789" (optionally prefixed "properties/").`
		);
	}
	return bare;
}

/**
 * Resolve a metric window + optional ISO-8601 anchor into a GA4
 * `DateRange` — `{ startDate, endDate }` as `YYYY-MM-DD` strings, both
 * ends **inclusive** (that is the GA4 Data API contract, unlike Stripe's
 * exclusive `lt`). Calendar boundaries are computed in **UTC**, mirroring
 * the `stripe-metrics` sibling:
 *
 * - `day`   — the anchor's UTC date; start = end. With no anchor this is
 *   "today (UTC) so far" — GA reports partial data for the current day.
 * - `week`  — ISO week: the Monday on/before the anchor through the
 *   following Sunday (7 days inclusive).
 * - `month` — the 1st through the last day of the anchor's UTC month.
 *
 * CAVEAT (documented choice): the GA4 API interprets these dates in the
 * *property's reporting time zone*, not UTC. We deliberately anchor the
 * calendar math in UTC so all metrics providers (Stripe, GA, …) agree on
 * which day/week/month a given instant belongs to; for properties whose
 * reporting zone differs from UTC the day boundaries are the property's
 * own. Exported for direct unit testing of the boundary math.
 */
export function resolveWindowDateRange(window: RangeWindow, anchor?: string): { startDate: string; endDate: string } {
	const anchorDate = anchor ? new Date(anchor) : new Date();
	if (Number.isNaN(anchorDate.getTime())) {
		throw new GoogleAnalyticsMetricsError(
			'invalid_anchor',
			`Invalid windowAnchor '${anchor}': expected an ISO-8601 date/time string.`
		);
	}

	const y = anchorDate.getUTCFullYear();
	const m = anchorDate.getUTCMonth();
	const d = anchorDate.getUTCDate();

	let startMs: number;
	let endMs: number;

	switch (window) {
		case 'day': {
			startMs = Date.UTC(y, m, d);
			endMs = startMs;
			break;
		}
		case 'week': {
			// getUTCDay(): 0 = Sunday ... 6 = Saturday. ISO weeks start Monday.
			const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
			const daysSinceMonday = (dow + 6) % 7;
			startMs = Date.UTC(y, m, d - daysSinceMonday);
			endMs = Date.UTC(y, m, d - daysSinceMonday + 6); // inclusive Sunday
			break;
		}
		case 'month': {
			startMs = Date.UTC(y, m, 1);
			endMs = Date.UTC(y, m + 1, 0); // day 0 of next month = last day of this month
			break;
		}
	}

	const toIsoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
	return { startDate: toIsoDate(startMs), endDate: toIsoDate(endMs) };
}

/**
 * Google Analytics (GA4) metrics-provider plugin (Goals feature, PR-9).
 *
 * Metrics (all `day` / `week` / `month`, all unit `count`):
 * - `active_users` — GA4 `activeUsers`.
 * - `sessions`     — GA4 `sessions`.
 * - `conversions`  — GA4 `keyEvents` (GA4 renamed conversions → key
 *   events in 2024; see {@link GA_API_METRIC_NAMES}).
 *
 * A metrics-only `runReport` (no dimensions) returns a single aggregate
 * row; `rows[0].metricValues[0].value` is the value. GA omits `rows`
 * entirely when the range has no data — that is a legitimate zero, not
 * an error (new/idle properties would otherwise never evaluate Goals).
 */
export class GoogleAnalyticsMetricsPlugin implements IMetricsProviderPlugin {
	readonly id = 'google-analytics-metrics';
	readonly name = 'Google Analytics Metrics';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'metrics';
	readonly capabilities: readonly string[] = [PLUGIN_CAPABILITIES.METRICS_PROVIDER];
	readonly providerName = 'google-analytics';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			propertyId: {
				type: 'string',
				title: 'GA4 property ID',
				description:
					'Numeric Google Analytics 4 property id (e.g. "123456789") — find it under Admin → Property settings. ' +
					'A "properties/123456789" resource name is also accepted.',
				'x-envVar': 'GOOGLE_ANALYTICS_PROPERTY_ID'
			},
			serviceAccountJson: {
				type: 'string',
				title: 'Service account key (JSON)',
				description:
					'Paste the full JSON key file of a Google Cloud service account. Grant that account only the Viewer role ' +
					'on the GA4 property — this plugin is read-only and never needs more.',
				'x-secret': true,
				'x-widget': 'textarea',
				'x-envVar': 'GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON',
				'x-scope': 'user'
			}
		},
		required: ['propertyId', 'serviceAccountJson']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Google Analytics Metrics Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async listMetrics(_settings?: PluginSettings): Promise<MetricDescriptor[]> {
		return [
			{
				id: GA_METRIC_IDS.ACTIVE_USERS,
				label: 'Active users',
				unit: UNIT,
				supportedWindows: [...RANGE_WINDOWS]
			},
			{
				id: GA_METRIC_IDS.SESSIONS,
				label: 'Sessions',
				unit: UNIT,
				supportedWindows: [...RANGE_WINDOWS]
			},
			{
				id: GA_METRIC_IDS.CONVERSIONS,
				label: 'Conversions (GA4 key events)',
				unit: UNIT,
				supportedWindows: [...RANGE_WINDOWS]
			}
		];
	}

	async getMetricValue(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		const metricId = query.metricId as GaMetricId;
		const apiMetricName = GA_API_METRIC_NAMES[metricId];
		if (apiMetricName === undefined) {
			throw new GoogleAnalyticsMetricsError(
				'unknown_metric',
				`Unknown metric '${query.metricId}' for provider '${this.providerName}'. ` +
					`Available: ${Object.values(GA_METRIC_IDS).join(', ')}.`
			);
		}

		if (!isRangeWindow(query.window)) {
			throw new GoogleAnalyticsMetricsError(
				'unsupported_window',
				`Metric '${query.metricId}' does not support window '${query.window}'. ` +
					`Supported: ${RANGE_WINDOWS.join(', ')}.`
			);
		}

		const propertyId = this.resolvePropertyId(settings) as string;
		const client = this.getClient(settings);
		const dateRange = resolveWindowDateRange(query.window, query.windowAnchor);

		let report: unknown;
		try {
			const [response] = await client.runReport({
				property: `properties/${propertyId}`,
				dateRanges: [dateRange],
				metrics: [{ name: apiMetricName }]
			});
			report = response;
		} catch (error) {
			const mapped = this.mapSdkError(query.metricId, error);
			this.logError(query.metricId, mapped);
			throw mapped;
		}

		return {
			value: this.extractAggregateValue(query.metricId, report),
			unit: UNIT,
			at: new Date().toISOString()
		};
	}

	isAvailable(settings?: PluginSettings): boolean {
		return (
			Boolean(this.resolvePropertyId(settings, { optional: true })) &&
			Boolean(this.resolveServiceAccountJson(settings, { optional: true }))
		);
	}

	/**
	 * EW-602 — the GA4 Data API is quota-based, not billed per call, so
	 * metric reads are free at the provider level. Usage is still
	 * recorded (units) against PluginUsageEvent by the facade.
	 */
	getPricing(): PluginPricing {
		return {
			costPerCallCents: 0,
			currency: 'usd',
			note: 'Google Analytics Data API calls are free (quota-based); only usage units are tracked.'
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const propertyId = this.resolvePropertyId(settings as PluginSettings, { optional: true });
		const serviceAccountJson = this.resolveServiceAccountJson(settings as PluginSettings, { optional: true });
		if (!propertyId || !serviceAccountJson) {
			return {
				success: false,
				message: 'Google Analytics property id and/or service account key are not configured.'
			};
		}

		try {
			// Read-only probe — a minimal one-metric report over today.
			const client = this.getClient(settings as PluginSettings);
			await client.runReport({
				property: `properties/${propertyId}`,
				dateRanges: [resolveWindowDateRange('day')],
				metrics: [{ name: GA_API_METRIC_NAMES[GA_METRIC_IDS.ACTIVE_USERS] }]
			});
			return { success: true, message: 'Google Analytics connection verified (read-only).' };
		} catch (error) {
			return {
				success: false,
				message: `Google Analytics connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Custom validation beyond JSON Schema: property-id format and
	 * service-account key shape (parseable JSON with `client_email` +
	 * `private_key`). Absent fields only warn — the `GOOGLE_ANALYTICS_*`
	 * env fallbacks may provide them at call time.
	 */
	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: ValidationError[] = [];
		const warnings: ValidationError[] = [];

		const rawPropertyId = settings.propertyId;
		if (rawPropertyId === undefined || rawPropertyId === null || rawPropertyId === '') {
			warnings.push({
				path: 'propertyId',
				message:
					'No GA4 property id configured — the GOOGLE_ANALYTICS_PROPERTY_ID environment variable must be set instead.'
			});
		} else if (typeof rawPropertyId !== 'string') {
			errors.push({ path: 'propertyId', message: 'Must be a string (the numeric GA4 property id).' });
		} else {
			try {
				normalizePropertyId(rawPropertyId);
			} catch (error) {
				errors.push({
					path: 'propertyId',
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}

		const rawJson = settings.serviceAccountJson;
		if (rawJson === undefined || rawJson === null || rawJson === '') {
			warnings.push({
				path: 'serviceAccountJson',
				message:
					'No service account key configured — the GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON environment variable must be set instead.'
			});
		} else if (typeof rawJson !== 'string') {
			errors.push({
				path: 'serviceAccountJson',
				message: 'Must be a string containing the JSON service-account key file.'
			});
		} else {
			try {
				parseServiceAccountJson(rawJson);
				// Shape is fine; nudge if it doesn't look like a service-account key.
				const parsed = JSON.parse(rawJson) as Record<string, unknown>;
				if (parsed.type !== 'service_account') {
					warnings.push({
						path: 'serviceAccountJson',
						message: `Key "type" is ${JSON.stringify(parsed.type)} — expected "service_account". Double-check you pasted a service-account key, not an OAuth client secret.`
					});
				}
			} catch (error) {
				errors.push({
					path: 'serviceAccountJson',
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}

		if (errors.length > 0) {
			return { valid: false, errors, ...(warnings.length > 0 ? { warnings } : {}) };
		}
		return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message:
				'Google Analytics Metrics plugin is ready (GA4 property + service account key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Read-only Google Analytics 4 metrics — active users, sessions and conversions (key events) per day/week/month — for evaluating Goals.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			homepage: 'https://analytics.google.com',
			icon: { type: 'emoji', value: '📈' },
			keywords: ['metrics', 'goals', 'google-analytics', 'ga4', 'analytics'],
			readme: [
				'## What does Google Analytics Metrics do?',
				'',
				'Exposes read-only GA4 metrics so Goals can evaluate targets like "1000 active users/week" or "50 conversions/day".',
				'',
				'## Metrics',
				'',
				'- **Active users** (`active_users`) — GA4 `activeUsers` over a day, week or month (UTC calendar windows).',
				'- **Sessions** (`sessions`) — GA4 `sessions` over the same windows.',
				'- **Conversions** (`conversions`) — GA4 **key events** (`keyEvents`; GA4 renamed conversions to key events in 2024).',
				'',
				'## Read-only by design',
				'',
				'This plugin only calls the GA4 Data API `runReport` — a reporting endpoint that cannot mutate anything. Grant the service account only the **Viewer** role on the property:',
				'',
				'1. In Google Cloud, create a service account and a JSON key; enable the **Google Analytics Data API**',
				'2. In GA4 **Admin → Property access management**, add the service-account email with the **Viewer** role',
				'3. Paste the JSON key in the **Service account key** field and the numeric property id in **GA4 property ID**'
			].join('\n')
		};
	}

	// ── helpers ─────────────────────────────────────────────────────────

	private resolvePropertyId(settings?: PluginSettings, opts?: { optional: boolean }): string | undefined {
		const fromSettings = settings?.propertyId;
		if (typeof fromSettings === 'string' && fromSettings.trim() !== '') {
			return normalizePropertyId(fromSettings);
		}

		const fromEnv = process.env.GOOGLE_ANALYTICS_PROPERTY_ID;
		if (fromEnv && fromEnv.trim() !== '') {
			return normalizePropertyId(fromEnv);
		}

		if (opts?.optional) return undefined;
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			'Google Analytics property id not configured. ' +
				'Set it in plugin settings or via the GOOGLE_ANALYTICS_PROPERTY_ID environment variable.'
		);
	}

	private resolveServiceAccountJson(settings?: PluginSettings, opts?: { optional: boolean }): string | undefined {
		const fromSettings = settings?.serviceAccountJson;
		if (typeof fromSettings === 'string' && fromSettings.trim() !== '') return fromSettings;

		const fromEnv = process.env.GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON;
		if (fromEnv && fromEnv.trim() !== '') return fromEnv;

		if (opts?.optional) return undefined;
		throw new GoogleAnalyticsMetricsError(
			'invalid_settings',
			'Google Analytics service account key not configured. ' +
				'Set it in plugin settings or via the GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON environment variable.'
		);
	}

	private getClient(settings?: PluginSettings): BetaAnalyticsDataClient {
		const credentials = parseServiceAccountJson(this.resolveServiceAccountJson(settings) as string);
		const options: {
			credentials: { client_email: string; private_key: string };
			projectId?: string;
		} = {
			credentials: {
				client_email: credentials.clientEmail,
				private_key: credentials.privateKey
			}
		};
		if (credentials.projectId !== undefined) {
			options.projectId = credentials.projectId;
		}
		return new BetaAnalyticsDataClient(options);
	}

	/**
	 * Extract the single aggregate value of a metrics-only report.
	 * Missing/empty `rows` is a legitimate zero (GA omits rows when the
	 * range has no data); a *present* row that does not carry a finite
	 * numeric `metricValues[0].value` is an `invalid_response`.
	 */
	private extractAggregateValue(metricId: string, report: unknown): number {
		const rows = isPlainObject(report) ? report.rows : undefined;
		if (rows === undefined || rows === null || (Array.isArray(rows) && rows.length === 0)) {
			return 0;
		}
		if (!Array.isArray(rows)) {
			throw new GoogleAnalyticsMetricsError(
				'invalid_response',
				`Google Analytics returned a malformed report for '${metricId}': "rows" is not an array.`
			);
		}

		const row: unknown = rows[0];
		const metricValues = isPlainObject(row) ? row.metricValues : undefined;
		const first: unknown = Array.isArray(metricValues) ? metricValues[0] : undefined;
		const rawValue = isPlainObject(first) ? first.value : undefined;
		const value = typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : NaN;
		if (!Number.isFinite(value)) {
			throw new GoogleAnalyticsMetricsError(
				'invalid_response',
				`Google Analytics returned a malformed report for '${metricId}': ` +
					`rows[0].metricValues[0].value is not a finite number (got ${JSON.stringify(rawValue)}).`
			);
		}
		return value;
	}

	/**
	 * Map an SDK/transport failure to a typed error. google-gax surfaces
	 * gRPC status codes on `error.code` — 16 (UNAUTHENTICATED) and
	 * 7 (PERMISSION_DENIED) are auth failures (HTTP 401/403 equivalents);
	 * everything else is a generic upstream `http_error`.
	 */
	private mapSdkError(metricId: string, error: unknown): GoogleAnalyticsMetricsError {
		if (error instanceof GoogleAnalyticsMetricsError) {
			return error;
		}

		const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
		const message = error instanceof Error ? error.message : String(error);

		if (code === GRPC_UNAUTHENTICATED || code === 401) {
			return new GoogleAnalyticsMetricsError(
				'auth_error',
				`Google Analytics rejected the credentials for '${metricId}' (unauthenticated): ${message}`,
				{ status: 401, cause: error }
			);
		}
		if (code === GRPC_PERMISSION_DENIED || code === 403) {
			return new GoogleAnalyticsMetricsError(
				'auth_error',
				`Google Analytics denied access for '${metricId}' (permission denied — does the service account have Viewer access to the property?): ${message}`,
				{ status: 403, cause: error }
			);
		}

		const options: { status?: number; cause: unknown } = { cause: error };
		if (typeof code === 'number' && code >= 400 && code < 600) {
			options.status = code;
		}
		return new GoogleAnalyticsMetricsError(
			'http_error',
			`Google Analytics request for '${metricId}' failed: ${message}`,
			options
		);
	}

	private logError(metricId: string, error: unknown): void {
		this.context?.logger.error(
			`Google Analytics metrics read failed (${metricId}): ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export default GoogleAnalyticsMetricsPlugin;
