import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	PostHogMetricsPlugin,
	PostHogMetricsError,
	POSTHOG_METRIC_IDS,
	DEFAULT_API_HOST,
	REQUEST_TIMEOUT_MS,
	resolveWindowRange
} from '../posthog-metrics.plugin.js';
import { isMetricsProviderPlugin } from '@ever-works/plugin';
import type { PluginContext, MetricQuery } from '@ever-works/plugin';

const DAY_SECONDS = 24 * 60 * 60;

const fetchMock = vi.fn();

/** Build a JSON Response the way the PostHog Query API answers. */
const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

/** A HogQLQuery scalar response: one row, one column. */
const scalarResponse = (value: unknown): Response => jsonResponse({ results: [[value]] });

const buildContext = (): PluginContext =>
	({
		pluginId: 'posthog-metrics',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue({})
	}) as unknown as PluginContext;

const SETTINGS = { projectId: '12345', personalApiKey: 'phx_test_abc' };

const query = (overrides: Partial<MetricQuery> = {}): MetricQuery => ({
	metricId: POSTHOG_METRIC_IDS.EVENT_COUNT,
	window: 'day',
	windowAnchor: '2026-07-19T15:30:00Z',
	params: { event: 'signup' },
	...overrides
});

/** Parse the JSON body of the n-th fetch call (0-based). */
const sentBody = (call = 0): { query: { kind: string; query: string; values: Record<string, string> } } => {
	const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
	return JSON.parse(init.body as string);
};

describe('PostHogMetricsPlugin', () => {
	let plugin: PostHogMetricsPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
		// Make sure no ambient config leaks into "missing settings" tests.
		vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
		vi.stubEnv('POSTHOG_PROJECT_ID', '');
		plugin = new PostHogMetricsPlugin();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('posthog-metrics');
			expect(plugin.name).toBe('PostHog Metrics');
			expect(plugin.category).toBe('metrics');
			expect(plugin.providerName).toBe('posthog');
			expect(plugin.configurationMode).toBe('hybrid');
		});

		it('declares the metrics-provider capability and passes the type guard', () => {
			expect(plugin.capabilities).toEqual(['metrics-provider']);
			expect(isMetricsProviderPlugin(plugin)).toBe(true);
		});
	});

	describe('settingsSchema', () => {
		it('requires projectId + personalApiKey and marks the key as a secret with env fallback', () => {
			expect(plugin.settingsSchema.required).toEqual(['projectId', 'personalApiKey']);
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.personalApiKey['x-secret']).toBe(true);
			expect(props.personalApiKey['x-envVar']).toBe('POSTHOG_PERSONAL_API_KEY');
			expect(props.projectId['x-envVar']).toBe('POSTHOG_PROJECT_ID');
		});

		it('defaults apiHost to PostHog Cloud US', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiHost.default).toBe('https://us.posthog.com');
			expect(DEFAULT_API_HOST).toBe('https://us.posthog.com');
		});
	});

	describe('listMetrics', () => {
		it('lists event_count and active_users with day/week/month windows', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);
			expect(metrics.map((m) => m.id)).toEqual(['event_count', 'active_users']);
			expect(metrics.every((m) => m.unit === 'count')).toBe(true);
			for (const metric of metrics) {
				expect(metric.supportedWindows).toEqual(['day', 'week', 'month']);
			}
		});

		it('documents the required "event" param on event_count only', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);

			const eventCount = metrics.find((m) => m.id === 'event_count');
			expect(eventCount?.paramsSchema).toBeDefined();
			expect(eventCount?.paramsSchema?.required).toEqual(['event']);
			const props = eventCount?.paramsSchema?.properties as Record<string, Record<string, unknown>>;
			expect(props.event.type).toBe('string');

			const activeUsers = metrics.find((m) => m.id === 'active_users');
			expect(activeUsers?.paramsSchema).toBeUndefined();
		});
	});

	describe('settings resolution', () => {
		it('throws invalid_settings without a personal API key and never calls fetch', async () => {
			const promise = plugin.getMetricValue(query(), { projectId: '12345' });
			await expect(promise).rejects.toBeInstanceOf(PostHogMetricsError);
			await expect(promise).rejects.toMatchObject({ code: 'invalid_settings' });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('throws invalid_settings without a project id and never calls fetch', async () => {
			const promise = plugin.getMetricValue(query(), { personalApiKey: 'phx_test_abc' });
			await expect(promise).rejects.toMatchObject({ code: 'invalid_settings' });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('falls back to POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID environment variables', async () => {
			vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_env_key');
			vi.stubEnv('POSTHOG_PROJECT_ID', '777');
			fetchMock.mockResolvedValueOnce(scalarResponse(1));

			await plugin.getMetricValue(query(), {});

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://us.posthog.com/api/projects/777/query/');
			expect((init.headers as Record<string, string>).authorization).toBe('Bearer phx_env_key');
		});

		it('prefers settings over environment variables', async () => {
			vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_env_key');
			vi.stubEnv('POSTHOG_PROJECT_ID', '777');
			fetchMock.mockResolvedValueOnce(scalarResponse(1));

			await plugin.getMetricValue(query(), SETTINGS);

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://us.posthog.com/api/projects/12345/query/');
			expect((init.headers as Record<string, string>).authorization).toBe('Bearer phx_test_abc');
		});

		it('accepts a numeric projectId', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(1));
			await plugin.getMetricValue(query(), { ...SETTINGS, projectId: 98765 });
			expect(fetchMock.mock.calls[0][0]).toBe('https://us.posthog.com/api/projects/98765/query/');
		});

		it('uses a custom apiHost and strips trailing slashes', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(1));
			await plugin.getMetricValue(query(), { ...SETTINGS, apiHost: 'https://eu.posthog.com/' });
			expect(fetchMock.mock.calls[0][0]).toBe('https://eu.posthog.com/api/projects/12345/query/');
		});

		it('rejects a malformed apiHost with invalid_settings before fetching', async () => {
			const promise = plugin.getMetricValue(query(), { ...SETTINGS, apiHost: 'not a url' });
			await expect(promise).rejects.toMatchObject({ code: 'invalid_settings' });
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('event_count query construction', () => {
		it('POSTs a HogQLQuery with the event as a placeholder value and UTC day boundaries', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(42));

			await plugin.getMetricValue(query({ window: 'day', windowAnchor: '2026-07-19T15:30:00Z' }), SETTINGS);

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://us.posthog.com/api/projects/12345/query/');
			expect(init.method).toBe('POST');
			expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

			const body = sentBody();
			expect(body.query.kind).toBe('HogQLQuery');
			expect(body.query.query).toContain('SELECT count() FROM events');
			expect(body.query.query).toContain('event = {event}');
			expect(body.query.query).toContain('timestamp >= toDateTime({date_from})');
			expect(body.query.query).toContain('timestamp < toDateTime({date_to})');
			expect(body.query.values).toEqual({
				event: 'signup',
				date_from: '2026-07-19 00:00:00',
				date_to: '2026-07-20 00:00:00'
			});
		});

		it('never string-interpolates the event name into the HogQL (injection safety)', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(0));
			const hostile = "signup' OR 1=1 --";

			await plugin.getMetricValue(query({ params: { event: hostile } }), SETTINGS);

			const body = sentBody();
			expect(body.query.query).not.toContain(hostile);
			expect(body.query.values.event).toBe(hostile);
		});

		it('sends ISO-week boundaries for the week window', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(0));

			// 2026-07-19 is a Sunday — its ISO week starts Monday 2026-07-13.
			await plugin.getMetricValue(query({ window: 'week', windowAnchor: '2026-07-19T12:00:00Z' }), SETTINGS);

			expect(sentBody().query.values).toMatchObject({
				date_from: '2026-07-13 00:00:00',
				date_to: '2026-07-20 00:00:00'
			});
		});

		it('sends first-of-month boundaries for the month window', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(0));

			await plugin.getMetricValue(query({ window: 'month', windowAnchor: '2026-07-19T00:00:00Z' }), SETTINGS);

			expect(sentBody().query.values).toMatchObject({
				date_from: '2026-07-01 00:00:00',
				date_to: '2026-08-01 00:00:00'
			});
		});

		it('defaults the anchor to "now" when windowAnchor is omitted', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-19T10:00:00Z'));
			fetchMock.mockResolvedValueOnce(scalarResponse(0));

			await plugin.getMetricValue(query({ window: 'day', windowAnchor: undefined }), SETTINGS);

			expect(sentBody().query.values).toMatchObject({
				date_from: '2026-07-19 00:00:00',
				date_to: '2026-07-20 00:00:00'
			});
		});

		it('applies the 15s request timeout', async () => {
			const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
			fetchMock.mockResolvedValueOnce(scalarResponse(0));

			await plugin.getMetricValue(query(), SETTINGS);

			expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
			expect(REQUEST_TIMEOUT_MS).toBe(15_000);
			timeoutSpy.mockRestore();
		});

		it('requires params.event (invalid_params) and never calls fetch without it', async () => {
			const promise = plugin.getMetricValue(query({ params: undefined }), SETTINGS);
			await expect(promise).rejects.toMatchObject({ code: 'invalid_params' });

			await expect(plugin.getMetricValue(query({ params: { event: '  ' } }), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_params'
			});
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('active_users query construction', () => {
		it('counts distinct persons and sends no event placeholder', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(7));

			const sample = await plugin.getMetricValue(
				query({ metricId: 'active_users', params: undefined, window: 'day' }),
				SETTINGS
			);

			const body = sentBody();
			expect(body.query.query).toContain('count(DISTINCT person_id)');
			expect(body.query.query).not.toContain('{event}');
			expect(body.query.values).toEqual({
				date_from: '2026-07-19 00:00:00',
				date_to: '2026-07-20 00:00:00'
			});
			expect(sample.value).toBe(7);
		});
	});

	describe('response parsing', () => {
		it('reads the scalar at results[0][0] (HogQL row shape)', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(1234));

			const sample = await plugin.getMetricValue(query(), SETTINGS);

			expect(sample.value).toBe(1234);
			expect(sample.unit).toBe('count');
			expect(Number.isNaN(Date.parse(sample.at))).toBe(false);
		});

		it('coerces numeric strings (ClickHouse can serialize large counts as strings)', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse('42.5'));
			const sample = await plugin.getMetricValue(query(), SETTINGS);
			expect(sample.value).toBe(42.5);
		});

		it('ignores extra rows/columns beyond results[0][0]', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ results: [[9, 'extra'], [999]], columns: ['count()'] }));
			const sample = await plugin.getMetricValue(query(), SETTINGS);
			expect(sample.value).toBe(9);
		});
	});

	describe('error mapping', () => {
		it('maps a non-2xx response to http_error with the upstream status', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

			const promise = plugin.getMetricValue(query(), SETTINGS);
			await expect(promise).rejects.toBeInstanceOf(PostHogMetricsError);
			await expect(promise).rejects.toMatchObject({ code: 'http_error', status: 401 });
		});

		it('maps invalid JSON to invalid_response', async () => {
			fetchMock.mockResolvedValueOnce(
				new Response('<html>gateway error</html>', {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);

			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});
		});

		it('maps a response without results rows to invalid_response', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ something: 'else' }));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});

			fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});

			fetchMock.mockResolvedValueOnce(jsonResponse({ results: [[]] }));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'invalid_response'
			});
		});

		it('maps a non-numeric scalar to value_not_numeric', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse('not-a-number'));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'value_not_numeric'
			});

			fetchMock.mockResolvedValueOnce(scalarResponse(null));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({
				code: 'value_not_numeric'
			});
		});

		it('maps an aborted request to timeout', async () => {
			fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));

			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({ code: 'timeout' });
		});

		it('rethrows unexpected network errors untouched', async () => {
			const boom = new TypeError('fetch failed');
			fetchMock.mockRejectedValueOnce(boom);
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toBe(boom);
		});

		it('throws unknown_metric listing the available metric ids', async () => {
			const promise = plugin.getMetricValue(query({ metricId: 'revenue' }), SETTINGS);
			await expect(promise).rejects.toMatchObject({ code: 'unknown_metric' });
			await expect(promise).rejects.toThrow(/event_count, active_users/);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('rejects point/total windows with unsupported_window before fetching', async () => {
			await expect(plugin.getMetricValue(query({ window: 'point' }), SETTINGS)).rejects.toMatchObject({
				code: 'unsupported_window'
			});
			await expect(plugin.getMetricValue(query({ window: 'total' }), SETTINGS)).rejects.toMatchObject({
				code: 'unsupported_window'
			});
			await expect(
				plugin.getMetricValue(query({ metricId: 'active_users', window: 'total' }), SETTINGS)
			).rejects.toMatchObject({ code: 'unsupported_window' });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('throws on an unparsable windowAnchor', async () => {
			await expect(
				plugin.getMetricValue(query({ windowAnchor: 'not-a-date' }), SETTINGS)
			).rejects.toThrow(/Invalid windowAnchor/);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('resolveWindowRange (UTC boundary math)', () => {
		it('day: midnight-to-midnight UTC around the anchor', () => {
			const { dateFrom, dateTo } = resolveWindowRange('day', '2026-07-19T23:59:59Z');
			expect(dateFrom).toBe('2026-07-19 00:00:00');
			expect(dateTo).toBe('2026-07-20 00:00:00');
		});

		it('week: starts on the ISO Monday containing the anchor and spans 7 days', () => {
			// 2026-07-19 is a Sunday — its ISO week starts Monday 2026-07-13.
			const { dateFrom, dateTo } = resolveWindowRange('week', '2026-07-19T12:00:00Z');
			expect(dateFrom).toBe('2026-07-13 00:00:00');
			expect(dateTo).toBe('2026-07-20 00:00:00');
			expect((Date.parse(dateTo.replace(' ', 'T') + 'Z') - Date.parse(dateFrom.replace(' ', 'T') + 'Z')) / 1000).toBe(
				7 * DAY_SECONDS
			);

			// A Monday anchor is its own week start.
			const monday = resolveWindowRange('week', '2026-07-13T00:00:00Z');
			expect(monday.dateFrom).toBe('2026-07-13 00:00:00');
		});

		it('week: crosses a month boundary correctly', () => {
			// 2026-08-01 is a Saturday — its ISO week starts Monday 2026-07-27.
			const { dateFrom, dateTo } = resolveWindowRange('week', '2026-08-01T12:00:00Z');
			expect(dateFrom).toBe('2026-07-27 00:00:00');
			expect(dateTo).toBe('2026-08-03 00:00:00');
		});

		it('month: first-of-month to first-of-next-month, including year rollover', () => {
			const july = resolveWindowRange('month', '2026-07-19T00:00:00Z');
			expect(july.dateFrom).toBe('2026-07-01 00:00:00');
			expect(july.dateTo).toBe('2026-08-01 00:00:00');

			const december = resolveWindowRange('month', '2026-12-15T08:00:00Z');
			expect(december.dateFrom).toBe('2026-12-01 00:00:00');
			expect(december.dateTo).toBe('2027-01-01 00:00:00');
		});

		it('throws on an unparsable anchor', () => {
			expect(() => resolveWindowRange('day', 'not-a-date')).toThrow(/Invalid windowAnchor/);
		});
	});

	describe('isAvailable', () => {
		it('requires both a resolvable key and project id', () => {
			expect(plugin.isAvailable({})).toBe(false);
			expect(plugin.isAvailable({ personalApiKey: 'phx_x' })).toBe(false);
			expect(plugin.isAvailable({ projectId: '1' })).toBe(false);
			expect(plugin.isAvailable(SETTINGS)).toBe(true);

			vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_env');
			vi.stubEnv('POSTHOG_PROJECT_ID', '2');
			expect(plugin.isAvailable({})).toBe(true);
		});
	});

	describe('getPricing', () => {
		it('declares PostHog Query API reads as free', () => {
			expect(plugin.getPricing()).toMatchObject({ costPerCallCents: 0, currency: 'usd' });
		});
	});

	describe('validateConnection', () => {
		it('fails fast without configuration', async () => {
			const r = await plugin.validateConnection({});
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/not configured/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('succeeds when the read-only SELECT 1 probe works', async () => {
			fetchMock.mockResolvedValueOnce(scalarResponse(1));

			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(true);
			expect(sentBody().query.query).toBe('SELECT 1');
		});

		it('reports the upstream failure on a bad key', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid token' }, 401));

			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/HTTP 401/);
		});
	});

	describe('lifecycle + errors', () => {
		it('logs on load and logs metric read failures through the context', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('PostHog Metrics Plugin loaded');

			fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'rate limited' }, 429));
			await expect(plugin.getMetricValue(query(), SETTINGS)).rejects.toMatchObject({ code: 'http_error' });
			expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('event_count'));
		});

		it('reports healthy and exposes a manifest aligned with plugin metadata', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');

			const m = plugin.getManifest();
			expect(m.id).toBe('posthog-metrics');
			expect(m.category).toBe('metrics');
			expect(m.capabilities).toEqual(['metrics-provider']);
		});
	});
});
