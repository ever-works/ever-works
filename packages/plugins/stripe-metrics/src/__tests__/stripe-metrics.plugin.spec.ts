import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	StripeMetricsPlugin,
	MetricTruncatedError,
	STRIPE_METRIC_IDS,
	resolveWindowRange,
	clearStripeClientCache
} from '../stripe-metrics.plugin.js';
import { isMetricsProviderPlugin } from '@ever-works/plugin';
import type { PluginContext, MetricQuery } from '@ever-works/plugin';

const { stripeCtorMock, balanceRetrieveMock, chargesListMock } = vi.hoisted(() => {
	const balanceRetrieveMock = vi.fn();
	const chargesListMock = vi.fn();
	// NOTE: implementation must be a `function` (not an arrow) — the plugin
	// `new`s the Stripe constructor.
	const stripeCtorMock = vi.fn(function () {
		return {
			balance: { retrieve: balanceRetrieveMock },
			charges: { list: chargesListMock }
		};
	});
	return { stripeCtorMock, balanceRetrieveMock, chargesListMock };
});

vi.mock('stripe', () => ({ default: stripeCtorMock }));

const DAY_SECONDS = 24 * 60 * 60;

interface FakeCharge {
	paid: boolean;
	currency: string;
	amount: number;
}

/** Mimics Stripe's ApiListPromise.autoPagingEach over a fixed charge set. */
const listResult = (charges: FakeCharge[]) => ({
	autoPagingEach: async (cb: (charge: FakeCharge) => unknown | Promise<unknown>) => {
		for (const charge of charges) {
			const r = await cb(charge);
			if (r === false) break;
		}
	}
});

const buildContext = (): PluginContext =>
	({
		pluginId: 'stripe-metrics',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue({})
	}) as unknown as PluginContext;

const SETTINGS = { secretKey: 'sk_test_123' };

const query = (overrides: Partial<MetricQuery> = {}): MetricQuery => ({
	metricId: STRIPE_METRIC_IDS.GROSS_VOLUME,
	window: 'day',
	windowAnchor: '2026-07-19T15:30:00Z',
	...overrides
});

describe('StripeMetricsPlugin', () => {
	let plugin: StripeMetricsPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		// The client cache is module-level — reset it so each test observes
		// its own constructor calls.
		clearStripeClientCache();
		// Make sure no ambient key leaks into "missing key" tests.
		vi.stubEnv('STRIPE_SECRET_KEY', '');
		plugin = new StripeMetricsPlugin();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('stripe-metrics');
			expect(plugin.name).toBe('Stripe Metrics');
			expect(plugin.category).toBe('metrics');
			expect(plugin.providerName).toBe('stripe');
			expect(plugin.configurationMode).toBe('hybrid');
		});

		it('declares the metrics-provider capability and passes the type guard', () => {
			expect(plugin.capabilities).toEqual(['metrics-provider']);
			expect(isMetricsProviderPlugin(plugin)).toBe(true);
		});
	});

	describe('settingsSchema', () => {
		it('requires secretKey and marks it as a secret with STRIPE_SECRET_KEY env fallback', () => {
			expect(plugin.settingsSchema.required).toContain('secretKey');
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.secretKey['x-secret']).toBe(true);
			expect(props.secretKey['x-envVar']).toBe('STRIPE_SECRET_KEY');
		});

		it('defaults currency to usd', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.currency.default).toBe('usd');
		});
	});

	describe('listMetrics', () => {
		it('lists balance_available (point) and gross_volume (day/week/month)', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);
			expect(metrics.map((m) => m.id)).toEqual(['balance_available', 'gross_volume']);

			const balance = metrics.find((m) => m.id === 'balance_available');
			expect(balance?.supportedWindows).toEqual(['point']);
			expect(balance?.unit).toBe('usd');

			const volume = metrics.find((m) => m.id === 'gross_volume');
			expect(volume?.supportedWindows).toEqual(['day', 'week', 'month']);
		});

		it('reports units in the configured currency', async () => {
			const metrics = await plugin.listMetrics({ ...SETTINGS, currency: 'EUR' });
			expect(metrics.every((m) => m.unit === 'eur')).toBe(true);
		});
	});

	describe('secret key resolution', () => {
		it('throws without a secret key and never constructs the SDK client', async () => {
			await expect(
				plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), {})
			).rejects.toThrow(/secret key not configured/i);
			expect(stripeCtorMock).not.toHaveBeenCalled();
		});

		it('falls back to the STRIPE_SECRET_KEY environment variable', async () => {
			vi.stubEnv('STRIPE_SECRET_KEY', 'rk_env_456');
			balanceRetrieveMock.mockResolvedValueOnce({ available: [{ amount: 100, currency: 'usd' }] });

			await plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), {});
			expect(stripeCtorMock).toHaveBeenCalledWith('rk_env_456', expect.objectContaining({ maxNetworkRetries: 2 }));
		});

		it('prefers the settings key over the environment variable', async () => {
			vi.stubEnv('STRIPE_SECRET_KEY', 'rk_env_456');
			balanceRetrieveMock.mockResolvedValueOnce({ available: [{ amount: 100, currency: 'usd' }] });

			await plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), SETTINGS);
			expect(stripeCtorMock).toHaveBeenCalledWith('sk_test_123', expect.anything());
		});

		it('caches the SDK client per secret key (one construction per key)', async () => {
			balanceRetrieveMock.mockResolvedValue({ available: [{ amount: 100, currency: 'usd' }] });

			await plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), SETTINGS);
			await plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), SETTINGS);
			expect(stripeCtorMock).toHaveBeenCalledTimes(1);

			// A different secret key gets its own client.
			await plugin.getMetricValue(
				query({ metricId: 'balance_available', window: 'point' }),
				{ secretKey: 'sk_test_other' }
			);
			expect(stripeCtorMock).toHaveBeenCalledTimes(2);
			expect(stripeCtorMock).toHaveBeenLastCalledWith('sk_test_other', expect.anything());
		});
	});

	describe('balance_available', () => {
		it('converts minor units to major (amount/100) and echoes the currency', async () => {
			balanceRetrieveMock.mockResolvedValueOnce({
				available: [{ amount: 12345, currency: 'usd' }]
			});

			const sample = await plugin.getMetricValue(
				query({ metricId: 'balance_available', window: 'point' }),
				SETTINGS
			);

			expect(sample.value).toBe(123.45);
			expect(sample.unit).toBe('usd');
			expect(Number.isNaN(Date.parse(sample.at))).toBe(false);
		});

		it('picks the entry matching the configured currency on multi-currency accounts', async () => {
			balanceRetrieveMock.mockResolvedValueOnce({
				available: [
					{ amount: 12345, currency: 'usd' },
					{ amount: 678, currency: 'eur' }
				]
			});

			const sample = await plugin.getMetricValue(
				query({ metricId: 'balance_available', window: 'point' }),
				{ ...SETTINGS, currency: 'eur' }
			);

			expect(sample.value).toBe(6.78);
			expect(sample.unit).toBe('eur');
		});

		it('falls back to the first entry when no entry matches the configured currency', async () => {
			balanceRetrieveMock.mockResolvedValueOnce({
				available: [{ amount: 500, currency: 'gbp' }]
			});

			const sample = await plugin.getMetricValue(
				query({ metricId: 'balance_available', window: 'point' }),
				SETTINGS
			);

			expect(sample.value).toBe(5);
			expect(sample.unit).toBe('gbp');
		});

		it('rejects aggregation windows — balance is point-in-time only', async () => {
			await expect(
				plugin.getMetricValue(query({ metricId: 'balance_available', window: 'day' }), SETTINGS)
			).rejects.toThrow(/does not support window 'day'/);
			expect(balanceRetrieveMock).not.toHaveBeenCalled();
		});
	});

	describe('gross_volume', () => {
		it('sums paid charges in the configured currency and skips unpaid/other-currency ones', async () => {
			chargesListMock.mockReturnValueOnce(
				listResult([
					{ paid: true, currency: 'usd', amount: 1050 },
					{ paid: false, currency: 'usd', amount: 99999 },
					{ paid: true, currency: 'eur', amount: 500 },
					{ paid: true, currency: 'usd', amount: 250 }
				])
			);

			const sample = await plugin.getMetricValue(query(), SETTINGS);
			expect(sample.value).toBe(13); // (1050 + 250) / 100
			expect(sample.unit).toBe('usd');
		});

		it('matches the currency case-insensitively (lowercases both sides)', async () => {
			chargesListMock.mockReturnValueOnce(
				listResult([
					{ paid: true, currency: 'usd', amount: 1000 },
					{ paid: true, currency: 'USD', amount: 500 },
					{ paid: true, currency: 'eur', amount: 99999 }
				])
			);

			const sample = await plugin.getMetricValue(query(), { ...SETTINGS, currency: 'USD' });
			expect(sample.value).toBe(15); // (1000 + 500) / 100
			expect(sample.unit).toBe('usd');
		});

		it('labels gross_volume as single-currency in the descriptor', async () => {
			const metrics = await plugin.listMetrics(SETTINGS);
			const volume = metrics.find((m) => m.id === 'gross_volume');
			expect(volume?.label).toMatch(/single-currency/);
			expect(volume?.label).toContain('usd');
		});

		it('queries Stripe with a UTC day range [00:00, next 00:00) and limit 100', async () => {
			chargesListMock.mockReturnValueOnce(listResult([]));

			await plugin.getMetricValue(query({ window: 'day', windowAnchor: '2026-07-19T15:30:00Z' }), SETTINGS);

			expect(chargesListMock).toHaveBeenCalledWith({
				created: {
					gte: Date.UTC(2026, 6, 19) / 1000,
					lt: Date.UTC(2026, 6, 20) / 1000
				},
				limit: 100
			});
		});

		it('defaults the anchor to "now" when windowAnchor is omitted', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-19T10:00:00Z'));
			chargesListMock.mockReturnValueOnce(listResult([]));

			await plugin.getMetricValue(query({ window: 'day', windowAnchor: undefined }), SETTINGS);

			expect(chargesListMock).toHaveBeenCalledWith(
				expect.objectContaining({
					created: {
						gte: Date.UTC(2026, 6, 19) / 1000,
						lt: Date.UTC(2026, 6, 20) / 1000
					}
				})
			);
		});

		it('rejects point/total windows', async () => {
			await expect(plugin.getMetricValue(query({ window: 'point' }), SETTINGS)).rejects.toThrow(
				/does not support window 'point'/
			);
			await expect(plugin.getMetricValue(query({ window: 'total' }), SETTINGS)).rejects.toThrow(
				/does not support window 'total'/
			);
			expect(chargesListMock).not.toHaveBeenCalled();
		});

		it('throws a typed metric-truncated error past the 20-page auto-pagination cap', async () => {
			const charges: FakeCharge[] = Array.from({ length: 2001 }, () => ({
				paid: true,
				currency: 'usd',
				amount: 100
			}));
			chargesListMock.mockReturnValueOnce(listResult(charges));

			const promise = plugin.getMetricValue(query(), SETTINGS);
			await expect(promise).rejects.toBeInstanceOf(MetricTruncatedError);
			await expect(promise).rejects.toMatchObject({
				code: 'metric-truncated',
				name: 'MetricTruncatedError'
			});
		});

		it('does NOT throw at exactly the cap (2000 charges)', async () => {
			const charges: FakeCharge[] = Array.from({ length: 2000 }, () => ({
				paid: true,
				currency: 'usd',
				amount: 100
			}));
			chargesListMock.mockReturnValueOnce(listResult(charges));

			const sample = await plugin.getMetricValue(query(), SETTINGS);
			expect(sample.value).toBe(2000); // 2000 × 100 minor units / 100
		});
	});

	describe('resolveWindowRange (UTC boundary math)', () => {
		it('day: midnight-to-midnight UTC around the anchor', () => {
			const { gte, lt } = resolveWindowRange('day', '2026-07-19T23:59:59Z');
			expect(gte).toBe(Date.UTC(2026, 6, 19) / 1000);
			expect(lt).toBe(Date.UTC(2026, 6, 20) / 1000);
			expect(lt - gte).toBe(DAY_SECONDS);
		});

		it('week: starts on the ISO Monday containing the anchor and spans 7 days', () => {
			// 2026-07-19 is a Sunday — its ISO week starts Monday 2026-07-13.
			const { gte, lt } = resolveWindowRange('week', '2026-07-19T12:00:00Z');
			expect(new Date(gte * 1000).getUTCDay()).toBe(1); // Monday
			expect(gte).toBe(Date.UTC(2026, 6, 13) / 1000);
			expect(lt - gte).toBe(7 * DAY_SECONDS);

			// A Monday anchor is its own week start.
			const monday = resolveWindowRange('week', '2026-07-13T00:00:00Z');
			expect(monday.gte).toBe(Date.UTC(2026, 6, 13) / 1000);
		});

		it('month: first-of-month to first-of-next-month, including year rollover', () => {
			const july = resolveWindowRange('month', '2026-07-19T00:00:00Z');
			expect(july.gte).toBe(Date.UTC(2026, 6, 1) / 1000);
			expect(july.lt).toBe(Date.UTC(2026, 7, 1) / 1000);

			const december = resolveWindowRange('month', '2026-12-15T08:00:00Z');
			expect(december.gte).toBe(Date.UTC(2026, 11, 1) / 1000);
			expect(december.lt).toBe(Date.UTC(2027, 0, 1) / 1000);
		});

		it('week: crosses a month boundary correctly', () => {
			// 2026-08-01 is a Saturday — its ISO week starts Monday 2026-07-27.
			const { gte, lt } = resolveWindowRange('week', '2026-08-01T12:00:00Z');
			expect(gte).toBe(Date.UTC(2026, 6, 27) / 1000);
			expect(lt).toBe(Date.UTC(2026, 7, 3) / 1000);
		});

		it('throws on an unparsable anchor', () => {
			expect(() => resolveWindowRange('day', 'not-a-date')).toThrow(/Invalid windowAnchor/);
		});
	});

	describe('unknown metric', () => {
		it('throws listing the available metric ids', async () => {
			await expect(
				plugin.getMetricValue(query({ metricId: 'net_income' }), SETTINGS)
			).rejects.toThrow(/Unknown metric 'net_income'.*balance_available, gross_volume/);
		});
	});

	describe('isAvailable', () => {
		it('reflects whether a secret key is resolvable', () => {
			expect(plugin.isAvailable({})).toBe(false);
			expect(plugin.isAvailable(SETTINGS)).toBe(true);

			vi.stubEnv('STRIPE_SECRET_KEY', 'rk_env_456');
			expect(plugin.isAvailable({})).toBe(true);
		});
	});

	describe('getPricing', () => {
		it('declares Stripe API reads as free', () => {
			expect(plugin.getPricing()).toMatchObject({ costPerCallCents: 0, currency: 'usd' });
		});
	});

	describe('validateConnection', () => {
		it('fails fast without a key', async () => {
			const r = await plugin.validateConnection({});
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/not configured/i);
			expect(balanceRetrieveMock).not.toHaveBeenCalled();
		});

		it('succeeds when the read-only balance probe works', async () => {
			balanceRetrieveMock.mockResolvedValueOnce({ available: [] });
			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(true);
		});

		it('reports the SDK error message on failure', async () => {
			balanceRetrieveMock.mockRejectedValueOnce(new Error('Invalid API Key provided'));
			const r = await plugin.validateConnection(SETTINGS);
			expect(r.success).toBe(false);
			expect(r.message).toMatch(/Invalid API Key/);
		});
	});

	describe('lifecycle + errors', () => {
		it('logs on load and logs metric read failures through the context', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Stripe Metrics Plugin loaded');

			balanceRetrieveMock.mockRejectedValueOnce(new Error('rate limited'));
			await expect(
				plugin.getMetricValue(query({ metricId: 'balance_available', window: 'point' }), SETTINGS)
			).rejects.toThrow(/rate limited/);
			expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('balance_available'));
		});

		it('reports healthy and exposes a manifest aligned with plugin metadata', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');

			const m = plugin.getManifest();
			expect(m.id).toBe('stripe-metrics');
			expect(m.category).toBe('metrics');
			expect(m.capabilities).toEqual(['metrics-provider']);
		});
	});
});
