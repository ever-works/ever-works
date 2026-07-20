import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MetricQuery } from '@ever-works/plugin';

const { fetchMock } = vi.hoisted(() => ({
	fetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
}));

// Mock the guard module: keep the real lexical check (so SSRF rejection is
// exercised for real) but route the actual network call to `fetchMock`.
// Same idiom as standard-pipeline's source-validation.step.spec.ts.
vi.mock('@ever-works/plugin/helpers/ssrf-guard', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@ever-works/plugin/helpers/ssrf-guard')>();
	return {
		...actual,
		safeFetchWithDnsPin: vi.fn(async (url: string, init?: RequestInit) => {
			if (!actual.isSafeWebhookUrl(url)) {
				throw new actual.SsrfBlockedError('lexical_blocked', 'URL rejected by lexical SSRF guard');
			}
			return fetchMock(url, init);
		})
	};
});

import {
	CustomHttpMetricsPlugin,
	CustomHttpMetricsError,
	parseValuePath,
	resolveValuePath,
	MAX_RESPONSE_BYTES,
	REQUEST_TIMEOUT_MS
} from './custom-http-metrics.plugin.js';

const ENDPOINT = {
	id: 'mrr',
	label: 'Monthly recurring revenue',
	url: 'https://metrics.example.com/mrr',
	unit: 'usd',
	valuePath: 'data.metrics[0].value',
	headers: { authorization: 'Bearer secret-token' }
};

const SETTINGS = { endpoints: [ENDPOINT] };

const POINT_QUERY: MetricQuery = { metricId: 'mrr', window: 'point' };

function jsonResponse(
	body: unknown,
	init?: { status?: number; contentType?: string; extraHeaders?: Record<string, string> }
): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { 'content-type': init?.contentType ?? 'application/json', ...(init?.extraHeaders ?? {}) }
	});
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<CustomHttpMetricsError> {
	const error = await promise.then(
		() => {
			throw new Error(`Expected rejection with code "${code}" but the promise resolved`);
		},
		(err: unknown) => err
	);
	expect(error).toBeInstanceOf(CustomHttpMetricsError);
	expect((error as CustomHttpMetricsError).code).toBe(code);
	return error as CustomHttpMetricsError;
}

describe('value path resolver', () => {
	it('resolves dot paths', () => {
		expect(resolveValuePath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
	});

	it('resolves numeric bracket indices into arrays', () => {
		expect(resolveValuePath({ data: { metrics: [{ value: 42.5 }] } }, 'data.metrics[0].value')).toBe(42.5);
	});

	it('resolves quoted bracket keys (single and double quotes)', () => {
		expect(resolveValuePath({ stats: { 'active users': 12 } }, "stats['active users']")).toBe(12);
		expect(resolveValuePath({ stats: { 'active users': 12 } }, 'stats["active users"]')).toBe(12);
	});

	it('supports an optional leading $ root', () => {
		expect(resolveValuePath({ a: 1 }, '$.a')).toBe(1);
	});

	it('supports chained brackets', () => {
		expect(resolveValuePath({ rows: [[10, 20]] }, 'rows[0][1]')).toBe(20);
	});

	it('returns undefined for missing paths and wrong shapes', () => {
		expect(resolveValuePath({ a: 1 }, 'a.b')).toBeUndefined();
		expect(resolveValuePath({ a: [1] }, 'a[5]')).toBeUndefined();
		expect(resolveValuePath({ a: { b: 1 } }, 'a[0]')).toBeUndefined();
		expect(resolveValuePath(null, 'a')).toBeUndefined();
	});

	it('never walks the prototype chain', () => {
		expect(resolveValuePath({}, 'toString')).toBeUndefined();
	});

	it('rejects forbidden segments', () => {
		expect(() => parseValuePath('__proto__.polluted')).toThrow(/Forbidden/);
		expect(() => parseValuePath('a.constructor')).toThrow(/Forbidden/);
		expect(() => parseValuePath("a['prototype']")).toThrow(/Forbidden/);
	});

	it('rejects invalid syntax', () => {
		expect(() => parseValuePath('')).toThrow();
		expect(() => parseValuePath('a..b')).toThrow(/Empty segment/);
		expect(() => parseValuePath('a[')).toThrow(/Unterminated/);
		expect(() => parseValuePath('a[foo]')).toThrow(/Invalid bracket segment/);
		expect(() => parseValuePath('a.')).toThrow(/Trailing/);
		expect(() => parseValuePath('$')).toThrow();
	});
});

describe('CustomHttpMetricsPlugin', () => {
	let plugin: CustomHttpMetricsPlugin;

	beforeEach(() => {
		plugin = new CustomHttpMetricsPlugin();
		fetchMock.mockReset();
	});

	describe('metadata', () => {
		it('declares the metrics-provider capability', () => {
			expect(plugin.capabilities).toContain('metrics-provider');
			expect(plugin.category).toBe('metrics');
			expect(plugin.providerName).toBe('custom-http');
		});
	});

	describe('listMetrics', () => {
		it('maps configured endpoints to point-window descriptors', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);
			expect(metrics).toEqual([
				{ id: 'mrr', label: 'Monthly recurring revenue', unit: 'usd', supportedWindows: ['point'] }
			]);
		});

		it('defaults the unit to count', async () => {
			const metrics = await plugin.listMetrics({
				endpoints: [{ id: 'x', label: 'X', url: 'https://example.com/x', valuePath: 'v' }]
			});
			expect(metrics[0].unit).toBe('count');
		});

		it('returns an empty list when nothing is configured', async () => {
			await expect(plugin.listMetrics(undefined)).resolves.toEqual([]);
			await expect(plugin.listMetrics({})).resolves.toEqual([]);
		});

		it('throws invalid_settings on malformed endpoints', async () => {
			await expectCode(plugin.listMetrics({ endpoints: 'nope' }), 'invalid_settings');
			await expectCode(plugin.listMetrics({ endpoints: [{ id: 'only-id' }] }), 'invalid_settings');
		});
	});

	describe('getMetricValue — happy path', () => {
		it('fetches the endpoint via GET and extracts the numeric value', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [{ value: 42.5 }] } }));

			const sample = await plugin.getMetricValue(POINT_QUERY, SETTINGS);

			expect(sample.value).toBe(42.5);
			expect(sample.unit).toBe('usd');
			expect(new Date(sample.at).toISOString()).toBe(sample.at);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(ENDPOINT.url);
			expect(init?.method).toBe('GET');
			expect(init?.redirect).toBe('error');
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(init?.headers).toMatchObject({ accept: 'application/json', authorization: 'Bearer secret-token' });
		});

		it('coerces numeric strings to finite numbers', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [{ value: '12.5' }] } }));
			const sample = await plugin.getMetricValue(POINT_QUERY, SETTINGS);
			expect(sample.value).toBe(12.5);
		});
	});

	describe('getMetricValue — query validation', () => {
		it('rejects unknown metric ids', async () => {
			await expectCode(plugin.getMetricValue({ metricId: 'nope', window: 'point' }, SETTINGS), 'unknown_metric');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('rejects non-point windows', async () => {
			await expectCode(plugin.getMetricValue({ metricId: 'mrr', window: 'day' }, SETTINGS), 'unsupported_window');
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('GET-only enforcement', () => {
		it('rejects a configured non-GET method at call time without fetching', async () => {
			const settings = { endpoints: [{ ...ENDPOINT, method: 'POST' }] };
			await expectCode(plugin.getMetricValue(POINT_QUERY, settings), 'method_not_allowed');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('rejects a configured non-GET method at settings validation', () => {
			const result = plugin.validateSettings({ endpoints: [{ ...ENDPOINT, method: 'DELETE' }] });
			expect(result.valid).toBe(false);
			expect(result.errors?.some((e) => e.path === 'endpoints[0].method' && /GET/.test(e.message))).toBe(true);
		});

		it('accepts an explicit GET method', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [{ value: 1 }] } }));
			const settings = { endpoints: [{ ...ENDPOINT, method: 'GET' }] };
			await expect(plugin.getMetricValue(POINT_QUERY, settings)).resolves.toMatchObject({ value: 1 });
		});
	});

	describe('SSRF guard', () => {
		it.each([
			'http://169.254.169.254/latest/meta-data',
			'http://127.0.0.1:8080/metrics',
			'http://10.1.2.3/internal',
			'file:///etc/passwd'
		])('rejects %s at call time without fetching', async (url) => {
			const settings = { endpoints: [{ ...ENDPOINT, url }] };
			await expectCode(plugin.getMetricValue(POINT_QUERY, settings), 'ssrf_blocked');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('flags private URLs at settings validation', () => {
			const result = plugin.validateSettings({ endpoints: [{ ...ENDPOINT, url: 'http://192.168.1.10/x' }] });
			expect(result.valid).toBe(false);
			expect(result.errors?.some((e) => e.path === 'endpoints[0].url')).toBe(true);
		});
	});

	describe('response caps', () => {
		it('rejects responses whose Content-Length exceeds 1MB', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse('{}', { extraHeaders: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })
			);
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'response_too_large');
		});

		it('rejects streamed bodies larger than 1MB', async () => {
			const bigBody = `{"padding":"${'x'.repeat(MAX_RESPONSE_BYTES)}"}`;
			fetchMock.mockResolvedValue(jsonResponse(bigBody));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'response_too_large');
		});

		it('maps fetch timeouts to a typed timeout error', async () => {
			const timeoutError = new Error(`The operation timed out after ${REQUEST_TIMEOUT_MS}ms`);
			timeoutError.name = 'TimeoutError';
			fetchMock.mockRejectedValue(timeoutError);
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'timeout');
		});
	});

	describe('response validation', () => {
		it('rejects non-2xx responses', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, { status: 500 }));
			const error = await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'http_error');
			expect(error.status).toBe(500);
		});

		it('rejects non-JSON content types', async () => {
			fetchMock.mockResolvedValue(jsonResponse('<html></html>', { contentType: 'text/html' }));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'invalid_content_type');
		});

		it('rejects unparseable JSON bodies', async () => {
			fetchMock.mockResolvedValue(jsonResponse('not json at all'));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'invalid_json');
		});

		it('rejects when the value path resolves to nothing', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [] } }));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'value_not_found');
		});

		it('rejects non-numeric values', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [{ value: 'not-a-number' }] } }));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'value_not_numeric');
		});

		it('rejects non-finite numeric values', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ data: { metrics: [{ value: null }] } }));
			await expectCode(plugin.getMetricValue(POINT_QUERY, SETTINGS), 'value_not_numeric');
		});
	});

	describe('validateSettings', () => {
		it('accepts a well-formed configuration', () => {
			expect(plugin.validateSettings(SETTINGS).valid).toBe(true);
		});

		it('treats a missing endpoints list as valid with a warning', () => {
			const result = plugin.validateSettings({});
			expect(result.valid).toBe(true);
			expect(result.warnings?.length).toBeGreaterThan(0);
		});

		it('rejects a non-array endpoints value', () => {
			expect(plugin.validateSettings({ endpoints: 'nope' }).valid).toBe(false);
		});

		it('rejects missing required fields with per-field paths', () => {
			const result = plugin.validateSettings({ endpoints: [{ id: 'x' }] });
			expect(result.valid).toBe(false);
			const paths = (result.errors ?? []).map((e) => e.path);
			expect(paths).toContain('endpoints[0].label');
			expect(paths).toContain('endpoints[0].url');
			expect(paths).toContain('endpoints[0].valuePath');
		});

		it('rejects duplicate metric ids', () => {
			const result = plugin.validateSettings({ endpoints: [ENDPOINT, { ...ENDPOINT, label: 'Copy' }] });
			expect(result.valid).toBe(false);
			expect(result.errors?.some((e) => /Duplicate/.test(e.message))).toBe(true);
		});

		it('rejects invalid value paths', () => {
			const result = plugin.validateSettings({ endpoints: [{ ...ENDPOINT, valuePath: '__proto__.x' }] });
			expect(result.valid).toBe(false);
			expect(result.errors?.some((e) => e.path === 'endpoints[0].valuePath')).toBe(true);
		});

		it('rejects non-string header values', () => {
			const result = plugin.validateSettings({ endpoints: [{ ...ENDPOINT, headers: { auth: 123 } }] });
			expect(result.valid).toBe(false);
			expect(result.errors?.some((e) => e.path === 'endpoints[0].headers.auth')).toBe(true);
		});
	});

	describe('isAvailable', () => {
		it('is true without settings (registry probe)', () => {
			expect(plugin.isAvailable()).toBe(true);
		});

		it('reflects whether endpoints are configured when settings are given', () => {
			expect(plugin.isAvailable(SETTINGS)).toBe(true);
			expect(plugin.isAvailable({})).toBe(false);
			expect(plugin.isAvailable({ endpoints: 'garbage' })).toBe(false);
		});
	});
});
