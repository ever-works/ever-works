import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GoogleAnalyticsMetricsPlugin,
	GoogleAnalyticsMetricsError,
	GA_METRIC_IDS,
	resolveWindowDateRange,
	parseServiceAccountJson,
	normalizePropertyId
} from '../google-analytics-metrics.plugin.js';
import { isMetricsProviderPlugin } from '@ever-works/plugin';
import type { PluginContext, MetricQuery } from '@ever-works/plugin';

const { gaCtorMock, runReportMock } = vi.hoisted(() => {
	const runReportMock = vi.fn();
	// NOTE: implementation must be a `function` (not an arrow) — the plugin
	// `new`s the BetaAnalyticsDataClient constructor.
	const gaCtorMock = vi.fn(function () {
		return { runReport: runReportMock };
	});
	return { gaCtorMock, runReportMock };
});

vi.mock('@google-analytics/data', () => ({ BetaAnalyticsDataClient: gaCtorMock }));

/** A minimal but well-formed service-account key. */
const SERVICE_ACCOUNT = {
	type: 'service_account',
	project_id: 'ever-works-test',
	client_email: 'goals-reader@ever-works-test.iam.gserviceaccount.com',
	private_key: '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n'
};

const SETTINGS = {
	propertyId: '123456789',
	serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT)
};

/** One aggregate row the way a metrics-only runReport returns it. */
const report = (value: string) => [{ rows: [{ metricValues: [{ value }] }] }];

const buildContext = (): PluginContext =>
	({
		pluginId: 'google-analytics-metrics',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue({})
	}) as unknown as PluginContext;

const query = (overrides: Partial<MetricQuery> = {}): MetricQuery => ({
	metricId: GA_METRIC_IDS.ACTIVE_USERS,
	window: 'day',
	windowAnchor: '2026-07-19T15:30:00Z',
	...overrides
});

/** A gax-style error carrying a gRPC status code. */
const grpcError = (code: number, message: string): Error & { code: number } =>
	Object.assign(new Error(message), { code });

describe('GoogleAnalyticsMetricsPlugin', () => {
	let plugin: GoogleAnalyticsMetricsPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		// Make sure no ambient config leaks into "missing settings" tests.
		vi.stubEnv('GOOGLE_ANALYTICS_PROPERTY_ID', '');
		vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', '');
		plugin = new GoogleAnalyticsMetricsPlugin();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('google-analytics-metrics');
			expect(plugin.name).toBe('Google Analytics Metrics');
			expect(plugin.category).toBe('metrics');
			expect(plugin.providerName).toBe('google-analytics');
			expect(plugin.configurationMode).toBe('hybrid');
		});

		it('declares the metrics-provider capability and passes the type guard', () => {
			expect(plugin.capabilities).toEqual(['metrics-provider']);
			expect(isMetricsProviderPlugin(plugin)).toBe(true);
		});
	});

	describe('settingsSchema', () => {
		it('requires propertyId + serviceAccountJson and marks the key as a secret with an env fallback', () => {
			expect(plugin.settingsSchema.required).toEqual(['propertyId', 'serviceAccountJson']);
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.serviceAccountJson['x-secret']).toBe(true);
			expect(props.serviceAccountJson['x-envVar']).toBe('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON');
			expect(props.propertyId['x-envVar']).toBe('GOOGLE_ANALYTICS_PROPERTY_ID');
		});
	});

	describe('listMetrics', () => {
		it('lists active_users, sessions and conversions with day/week/month windows and unit count', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);
			expect(metrics.map((m) => m.id)).toEqual(['active_users', 'sessions', 'conversions']);
			for (const metric of metrics) {
				expect(metric.supportedWindows).toEqual(['day', 'week', 'month']);
				expect(metric.unit).toBe('count');
			}
		});
	});

	describe('settings resolution', () => {
		it('throws a typed invalid_settings error without config and never constructs the SDK client', async () => {
			const promise = plugin.getMetricValue(query(), {});
			await expect(promise).rejects.toBeInstanceOf(GoogleAnalyticsMetricsError);
			await expect(promise).rejects.toMatchObject({ code: 'invalid_settings' });
			expect(gaCtorMock).not.toHaveBeenCalled();
		});

		it('falls back to the GOOGLE_ANALYTICS_* environment variables', async () => {
			vi.stubEnv('GOOGLE_ANALYTICS_PROPERTY_ID', '987654321');
			vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', JSON.stringify(SERVICE_ACCOUNT));
			runReportMock.mockResolvedValueOnce(report('5'));

			await plugin.getMetricValue(query(), {});

			expect(gaCtorMock).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: {
						client_email: SERVICE_ACCOUNT.client_email,
						private_key: SERVICE_ACCOUNT.private_key
					},
					projectId: SERVICE_ACCOUNT.project_id
				})
			);
			expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({ property: 'properties/987654321' }));
		});

		it('prefers settings over the environment variables', async () => {
			vi.stubEnv('GOOGLE_ANALYTICS_PROPERTY_ID', '987654321');
			vi.stubEnv(
				'GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON',
				JSON.stringify({ ...SERVICE_ACCOUNT, client_email: 'env@example.iam.gserviceaccount.com' })
			);
			runReportMock.mockResolvedValueOnce(report('5'));

			await plugin.getMetricValue(query(), SETTINGS);

			expect(gaCtorMock).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({ client_email: SERVICE_ACCOUNT.client_email })
				})
			);
			expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({ property: 'properties/123456789' }));
		});

		it('accepts a "properties/123" resource name and normalizes it', async () => {
			runReportMock.mockResolvedValueOnce(report('5'));
			await plugin.getMetricValue(query(), { ...SETTINGS, propertyId: 'properties/123456789' });
			expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({ property: 'properties/123456789' }));
		});

		it('throws invalid_settings on unparsable service-account JSON', async () => {
			const promise = plugin.getMetricValue(query(), { ...SETTINGS, serviceAccountJson: '{not json' });
			await expect(promise).rejects.toMatchObject({
				code: 'invalid_settings',
				name: 'GoogleAnalyticsMetricsError'
			});
			expect(gaCtorMock).not.toHaveBeenCalled();
		});

		it('throws invalid_settings when the key lacks client_email/private_key', async () => {
			await expect(
				plugin.getMetricValue(query(), {
					...SETTINGS,
					serviceAccountJson: JSON.stringify({ type: 'service_account' })
				})
			).rejects.toMatchObject({ code: 'invalid_settings' });
			expect(gaCtorMock).not.toHaveBeenCalled();
		});
	});

	describe('runReport request shape', () => {
		it.each([
			[GA_METRIC_IDS.ACTIVE_USERS, 'activeUsers'],
			[GA_METRIC_IDS.SESSIONS, 'sessions'],
			// GA4 renamed conversions → key events in 2024; the Data API metric is keyEvents.
			[GA_METRIC_IDS.CONVERSIONS, 'keyEvents']
		])('queries the %s metric as GA4 "%s"', async (metricId, apiName) => {
			runReportMock.mockResolvedValueOnce(report('1'));
			await plugin.getMetricValue(query({ metricId }), SETTINGS);
			expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({ metrics: [{ name: apiName }] }));
		});

		it('sends a single-day UTC dateRange for the day window', async () => {
			runReportMock.mockResolvedValueOnce(report('1'));
			await plugin.getMetricValue(query({ window: 'day', windowAnchor: '2026-07-19T15:30:00Z' }), SETTINGS);
			expect(runReportMock).toHaveBeenCalledWith({
				property: 'properties/123456789',
				dateRanges: [{ startDate: '2026-07-19', endDate: '2026-07-19' }],
				metrics: [{ name: 'activeUsers' }]
			});
		});

		it('defaults the anchor to "now" when windowAnchor is omitted', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-19T10:00:00Z'));
			runReportMock.mockResolvedValueOnce(report('1'));

			await plugin.getMetricValue(query({ window: 'day', windowAnchor: undefined }), SETTINGS);

			expect(runReportMock).toHaveBeenCalledWith(
				expect.objectContaining({
					dateRanges: [{ startDate: '2026-07-19', endDate: '2026-07-19' }]
				})
			);
		});
	});

	describe('resolveWindowDateRange (UTC boundary math, inclusive GA4 dates)', () => {
		it('day: startDate = endDate = the anchor UTC date', () => {
			expect(resolveWindowDateRange('day', '2026-07-19T23:59:59Z')).toEqual({
				startDate: '2026-07-19',
				endDate: '2026-07-19'
			});
			// An anchor just past midnight UTC belongs to the new UTC day.
			expect(resolveWindowDateRange('day', '2026-07-20T00:00:01Z')).toEqual({
				startDate: '2026-07-20',
				endDate: '2026-07-20'
			});
		});

		it('week: ISO Monday through Sunday containing the anchor', () => {
			// 2026-07-19 is a Sunday — its ISO week is Mon 2026-07-13 .. Sun 2026-07-19.
			expect(resolveWindowDateRange('week', '2026-07-19T12:00:00Z')).toEqual({
				startDate: '2026-07-13',
				endDate: '2026-07-19'
			});
			// A Monday anchor is its own week start.
			expect(resolveWindowDateRange('week', '2026-07-13T00:00:00Z')).toEqual({
				startDate: '2026-07-13',
				endDate: '2026-07-19'
			});
		});

		it('week: crosses a month boundary correctly', () => {
			// 2026-08-01 is a Saturday — its ISO week is Mon 2026-07-27 .. Sun 2026-08-02.
			expect(resolveWindowDateRange('week', '2026-08-01T12:00:00Z')).toEqual({
				startDate: '2026-07-27',
				endDate: '2026-08-02'
			});
		});

		it('month: first through last day, including year rollover and leap February', () => {
			expect(resolveWindowDateRange('month', '2026-07-19T00:00:00Z')).toEqual({
				startDate: '2026-07-01',
				endDate: '2026-07-31'
			});
			expect(resolveWindowDateRange('month', '2026-12-15T08:00:00Z')).toEqual({
				startDate: '2026-12-01',
				endDate: '2026-12-31'
			});
			expect(resolveWindowDateRange('month', '2028-02-10T00:00:00Z')).toEqual({
				startDate: '2028-02-01',
				endDate: '2028-02-29'
			});
		});

		it('throws a typed invalid_anchor error on an unparsable anchor', () => {
			try {
				resolveWindowDateRange('day', 'not-a-date');
				expect.unreachable('should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(GoogleAnalyticsMetricsError);
				expect((error as GoogleAnalyticsMetricsError).code).toBe('invalid_anchor');
			}
		});
	});

	describe('value parsing', () => {
		it('parses rows[0].metricValues[0].value into a number', async () => {
			runReportMock.mockResolvedValueOnce(report('1234'));
			const sample = await plugin.getMetricValue(query(), SETTINGS);
			expect(sample.value).toBe(1234);
			expect(sample.unit).toBe('count');
			expect(Number.isNaN(Date.parse(sample.at))).toBe(false);
		});

		it('treats missing/empty rows as zero (GA omits rows when the range has no data)', async () => {
			runReportMock.mockResolvedValueOnce([{}]);
			expect((await plugin.getMetricValue(query(), SETTINGS)).value).toBe(0);

			runReportMock.mockResolvedValueOnce([{ rows: [] }]);
			expect((await plugin.getMetricValue(query(), SETTINGS)).value).toBe(0);
		});

		it('throws invalid_response when the row carries no metric value', async () => {
			runReportMock.mockResolvedValueOnce([{ rows: [{ metricValues: [] }] }]);
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});
		});

		it('throws invalid_response when the value is not a finite number', async () => {
			runReportMock.mockResolvedValueOnce(report('not-a-number'));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});
		});
	});

	describe('error mapping', () => {
		it('maps gRPC UNAUTHENTICATED (16) to auth_error with status 401', async () => {
			runReportMock.mockRejectedValueOnce(grpcError(16, 'invalid authentication credentials'));
			const promise = plugin.getMetricValue(query(), SETTINGS);
			await expect(promise).rejects.toBeInstanceOf(GoogleAnalyticsMetricsError);
			await expect(promise).rejects.toMatchObject({ code: 'auth_error', status: 401 });
		});

		it('maps gRPC PERMISSION_DENIED (7) to auth_error with status 403', async () => {
			runReportMock.mockRejectedValueOnce(grpcError(7, 'User does not have sufficient permissions'));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'auth_error',
				status: 403
			});
		});

		it('maps other SDK failures to http_error and keeps the message', async () => {
			runReportMock.mockRejectedValueOnce(grpcError(8, 'Exhausted property tokens'));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'http_error',
				message: expect.stringContaining('Exhausted property tokens')
			});
		});
	});

	describe('unsupported window / unknown metric', () => {
		it('rejects point and total windows without calling the API', async () => {
			await expect(plugin.getMetricValue(query({ window: 'point' }), SETTINGS)).rejects.toMatchObject({
				code: 'unsupported_window'
			});
			await expect(plugin.getMetricValue(query({ window: 'total' }), SETTINGS)).rejects.toMatchObject({
				code: 'unsupported_window'
			});
			expect(runReportMock).not.toHaveBeenCalled();
		});

		it('throws unknown_metric listing the available metric ids', async () => {
			await expect(plugin.getMetricValue(query({ metricId: 'bounce_rate' }), SETTINGS)).rejects.toThrow(
				/Unknown metric 'bounce_rate'.*active_users, sessions, conversions/
			);
		});
	});

	describe('validateSettings', () => {
		it('warns (but stays valid) when nothing is configured — env fallback is possible', () => {
			const r = plugin.validateSettings({});
			expect(r.valid).toBe(true);
			expect(r.warnings?.length).toBe(2);
		});

		it('rejects unparsable service-account JSON', () => {
			const r = plugin.validateSettings({ ...SETTINGS, serviceAccountJson: '{oops' });
			expect(r.valid).toBe(false);
			expect(r.errors).toEqual([
				expect.objectContaining({
					path: 'serviceAccountJson',
					message: expect.stringMatching(/not valid JSON/i)
				})
			]);
		});

		it('rejects a JSON key missing client_email/private_key', () => {
			const r = plugin.validateSettings({
				...SETTINGS,
				serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'x@y.iam' })
			});
			expect(r.valid).toBe(false);
			expect(r.errors?.[0]?.path).toBe('serviceAccountJson');
		});

		it('rejects a non-numeric property id', () => {
			const r = plugin.validateSettings({ ...SETTINGS, propertyId: 'GA-123-ABC' });
			expect(r.valid).toBe(false);
			expect(r.errors?.[0]?.path).toBe('propertyId');
		});

		it('accepts a fully valid configuration', () => {
			const r = plugin.validateSettings({ ...SETTINGS });
			expect(r).toEqual({ valid: true });
		});

		it('warns when the key type is not service_account', () => {
			const r = plugin.validateSettings({
				...SETTINGS,
				serviceAccountJson: JSON.stringify({ ...SERVICE_ACCOUNT, type: 'authorized_user' })
			});
			expect(r.valid).toBe(true);
			expect(r.warnings?.[0]?.message).toMatch(/service_account/);
		});
	});

	describe('helpers', () => {
		it('parseServiceAccountJson extracts email/key/projectId', () => {
			expect(parseServiceAccountJson(JSON.stringify(SERVICE_ACCOUNT))).toEqual({
				clientEmail: SERVICE_ACCOUNT.client_email,
				privateKey: SERVICE_ACCOUNT.private_key,
				projectId: SERVICE_ACCOUNT.project_id
			});
		});

		it('normalizePropertyId strips the resource-name prefix and rejects garbage', () => {
			expect(normalizePropertyId('123456789')).toBe('123456789');
			expect(normalizePropertyId('properties/123456789')).toBe('123456789');
			expect(() => normalizePropertyId('abc')).toThrow(GoogleAnalyticsMetricsError);
		});
	});

	describe('isAvailable', () => {
		it('reflects whether both property id and key are resolvable', () => {
			expect(plugin.isAvailable({})).toBe(false);
			expect(plugin.isAvailable({ propertyId: '123' })).toBe(false);
			expect(plugin.isAvailable(SETTINGS)).toBe(true);

			vi.stubEnv('GOOGLE_ANALYTICS_PROPERTY_ID', '123456789');
			vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', JSON.stringify(SERVICE_ACCOUNT));
			expect(plugin.isAvailable({})).toBe(true);
		});
	});

	describe('getPricing', () => {
		it('declares GA4 Data API reads as free', () => {
			expect(plugin.getPricing()).toMatchObject({ costPerCallCents: 0, currency: 'usd' });
		});
	});

	describe('validateConnection', () => {
		it('fails fast without configuration', async () => {
			const r = await plugin.validateConnection({});
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/not configured/i);
			expect(runReportMock).not.toHaveBeenCalled();
		});

		it('succeeds when the read-only probe works', async () => {
			runReportMock.mockResolvedValueOnce(report('0'));
			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(true);
			expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({ metrics: [{ name: 'activeUsers' }] }));
		});

		it('reports the SDK error message on failure', async () => {
			runReportMock.mockRejectedValueOnce(grpcError(7, 'permission denied on property'));
			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/permission denied on property/);
		});
	});

	describe('lifecycle + errors', () => {
		it('logs on load and logs metric read failures through the context', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Google Analytics Metrics Plugin loaded');

			runReportMock.mockRejectedValueOnce(grpcError(14, 'unavailable'));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({ code: 'http_error' });
			expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('active_users'));
		});

		it('reports healthy and exposes a manifest aligned with plugin metadata', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');

			const m = plugin.getManifest();
			expect(m.id).toBe('google-analytics-metrics');
			expect(m.category).toBe('metrics');
			expect(m.capabilities).toEqual(['metrics-provider']);
			expect(m.readme).toMatch(/keyEvents/);
		});
	});
});
