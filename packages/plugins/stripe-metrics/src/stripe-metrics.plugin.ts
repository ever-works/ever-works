import Stripe from 'stripe';
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

/** Stripe list page size (Stripe's maximum per page). */
const PAGE_SIZE = 100;
/**
 * Hard cap on auto-paginated pages per `gross_volume` read. Very large
 * accounts can have tens of thousands of charges in a month; walking all
 * of them would be slow (1 network round-trip per page) and hammer the
 * Stripe API. Beyond the cap we fail loudly with {@link MetricTruncatedError}
 * rather than silently returning an undercounted value — an undercount
 * would make Goal evaluation (PR-8) quietly wrong.
 */
const MAX_PAGES = 20;
const MAX_CHARGES = PAGE_SIZE * MAX_PAGES; // 2,000 charges

/**
 * Module-level Stripe client cache keyed by secret key. Constructing a
 * Stripe client per call is wasteful (agent config parsing, retry/telemetry
 * state). Bounded in practice without eviction: there is one entry per
 * distinct tenant secret key — a per-tenant handful, never unbounded
 * user-controlled input — so a plain Map is deliberately kept simple.
 */
const stripeClientCache = new Map<string, Stripe>();

/** Test-only helper: reset the module-level Stripe client cache. */
export function clearStripeClientCache(): void {
	stripeClientCache.clear();
}

/** Metric ids served by this provider. */
export const STRIPE_METRIC_IDS = {
	BALANCE_AVAILABLE: 'balance_available',
	GROSS_VOLUME: 'gross_volume'
	// TODO(metrics, reserved id: 'net_income'): net income is intentionally
	// OUT of scope for PR-7. Computing it correctly requires walking
	// balance transactions (`stripe.balanceTransactions.list`) and summing
	// `net` across many transaction types (charges, refunds, fees, payouts,
	// adjustments, disputes...), with per-type sign conventions and
	// currency-conversion edge cases. `gross_volume` is a well-defined
	// approximation for "income" targets until a dedicated PR lands the
	// balance-transaction walker. The id `net_income` is reserved here so
	// downstream Goal configs won't squat on it with a different meaning.
} as const;

/** Windows that map to a Stripe `created` range filter. */
const RANGE_WINDOWS = ['day', 'week', 'month'] as const;
export type RangeWindow = (typeof RANGE_WINDOWS)[number];

function isRangeWindow(window: MetricWindow): window is RangeWindow {
	return (RANGE_WINDOWS as readonly string[]).includes(window);
}

/**
 * Thrown when a `gross_volume` read would need to walk more than
 * {@link MAX_CHARGES} charges (i.e. more than {@link MAX_PAGES} pages of
 * Stripe auto-pagination). Callers can catch by stable `code`
 * (`'metric-truncated'`) or `name` and either narrow the window (e.g.
 * query per-day instead of per-month) or accept that this metric is not
 * computable for the account size.
 */
export class MetricTruncatedError extends Error {
	readonly code = 'metric-truncated';

	constructor(message: string) {
		super(message);
		this.name = 'MetricTruncatedError';
	}
}

/**
 * Resolve a metric window + optional ISO-8601 anchor into a Stripe
 * `created` range `{ gte, lt }` (inclusive start, exclusive end) in Unix
 * seconds. All boundaries are computed in UTC:
 *
 * - `day`   — 00:00:00 UTC of the anchor's date, +1 day.
 * - `week`  — ISO week: 00:00:00 UTC of the Monday on/before the anchor, +7 days.
 * - `month` — 00:00:00 UTC of the 1st of the anchor's month, +1 month.
 *
 * Exported for direct unit testing of the boundary math.
 */
export function resolveWindowRange(window: RangeWindow, anchor?: string): { gte: number; lt: number } {
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

	return { gte: Math.floor(startMs / 1000), lt: Math.floor(endMs / 1000) };
}

/**
 * Stripe metrics-provider plugin (Goals feature, PR-7).
 *
 * READ-ONLY BY CONTRACT: every Stripe call this plugin makes is a GET-shaped
 * read (`balance.retrieve`, `charges.list`). It never creates, mutates, or
 * deletes any Stripe resource. Pair it with a **restricted API key**
 * (`rk_...`) that grants only read scopes (Balance: Read, Charges: Read) —
 * see the README for how to create one.
 *
 * Metrics:
 * - `balance_available` — current available balance (point-in-time), from
 *   `stripe.balance.retrieve()`, preferring the entry matching the
 *   configured currency; minor units are converted to major (`amount/100`).
 * - `gross_volume` — sum of successful (paid) charges in the configured
 *   currency over a day/week/month UTC window via `charges.list` +
 *   SDK auto-pagination. Refunds are NOT subtracted (that's what makes it
 *   *gross*; net income is reserved — see {@link STRIPE_METRIC_IDS}).
 *   Reads beyond ~2,000 charges/window throw {@link MetricTruncatedError}.
 *
 * NOTE on `amount/100`: all currently supported metric currencies are
 * assumed to be two-decimal ISO-4217 currencies (usd, eur, gbp, ...).
 * Zero-decimal currencies (jpy, krw, ...) would need a divisor table — out
 * of scope until someone needs them; values for those would be 100x off,
 * which is why the README calls this out.
 */
export class StripeMetricsPlugin implements IMetricsProviderPlugin {
	readonly id = 'stripe-metrics';
	readonly name = 'Stripe Metrics';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'metrics';
	readonly capabilities: readonly string[] = [PLUGIN_CAPABILITIES.METRICS_PROVIDER];
	readonly providerName = 'stripe';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			secretKey: {
				type: 'string',
				title: 'Stripe secret key',
				description:
					'A restricted read-only key (rk_...) with Balance: Read + Charges: Read is strongly recommended. ' +
					'Create one at https://dashboard.stripe.com/apikeys. A full secret key (sk_...) also works but grants far more than this plugin needs.',
				'x-secret': true,
				'x-envVar': 'STRIPE_SECRET_KEY',
				'x-scope': 'user'
			},
			currency: {
				type: 'string',
				title: 'Currency',
				description:
					'Lowercase ISO-4217 currency code metric values are reported in (e.g. usd, eur). ' +
					'Charges in other currencies are excluded from gross_volume.',
				default: 'usd'
			}
		},
		required: ['secretKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Stripe Metrics Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async listMetrics(settings?: PluginSettings): Promise<MetricDescriptor[]> {
		const currency = this.resolveCurrency(settings);
		return [
			{
				id: STRIPE_METRIC_IDS.BALANCE_AVAILABLE,
				label: 'Available balance',
				unit: currency,
				supportedWindows: ['point']
			},
			{
				id: STRIPE_METRIC_IDS.GROSS_VOLUME,
				// Single-currency by contract: only charges in the configured
				// currency are summed; other currencies are excluded.
				label: `Gross volume (sum of successful ${currency} charges; single-currency)`,
				unit: currency,
				supportedWindows: ['day', 'week', 'month']
			}
		];
	}

	async getMetricValue(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		switch (query.metricId) {
			case STRIPE_METRIC_IDS.BALANCE_AVAILABLE:
				return this.readAvailableBalance(query, settings);
			case STRIPE_METRIC_IDS.GROSS_VOLUME:
				return this.readGrossVolume(query, settings);
			default:
				throw new Error(
					`Unknown metric '${query.metricId}' for provider '${this.providerName}'. ` +
						`Available: ${Object.values(STRIPE_METRIC_IDS).join(', ')}.`
				);
		}
	}

	isAvailable(settings?: PluginSettings): boolean {
		return Boolean(this.resolveSecretKey(settings, { optional: true }));
	}

	/**
	 * EW-602 — Stripe does not charge per API call, so metric reads are
	 * free at the provider level. Usage is still recorded (units) against
	 * PluginUsageEvent by the MetricsFacadeService.
	 */
	getPricing(): PluginPricing {
		return {
			costPerCallCents: 0,
			currency: 'usd',
			note: 'Stripe API calls are free; only usage units are tracked.'
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const secretKey = this.resolveSecretKey(settings as PluginSettings, { optional: true });
		if (!secretKey) {
			return { success: false, message: 'Stripe secret key is not configured.' };
		}

		try {
			// Read-only probe — balance.retrieve requires only Balance: Read.
			await this.getClient(settings as PluginSettings).balance.retrieve();
			return { success: true, message: 'Stripe connection verified (read-only).' };
		} catch (error) {
			return {
				success: false,
				message: `Stripe connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Stripe Metrics plugin is ready (secret key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Read-only Stripe business metrics — available balance and gross charge volume per day/week/month — for evaluating Goals.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			homepage: 'https://stripe.com',
			icon: { type: 'emoji', value: '💳' },
			readme: [
				'## What does Stripe Metrics do?',
				'',
				'Exposes read-only business metrics from your Stripe account so Goals can evaluate targets like "$100/day balance" or "$1000/month income".',
				'',
				'## Metrics',
				'',
				'- **Available balance** (`balance_available`) — your current available Stripe balance (point-in-time).',
				'- **Gross volume** (`gross_volume`) — the sum of successful charges over a day, week, or month (UTC).',
				'',
				'## Read-only by design',
				'',
				'This plugin never writes to your Stripe account. Use a **restricted key** (`rk_...`) with only *Balance: Read* and *Charges: Read* scopes:',
				'',
				'1. Open [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)',
				'2. **Create restricted key** → grant *Balance: Read* and *Charges: Read* only',
				'3. Paste the `rk_...` key in the **Stripe secret key** field below'
			].join('\n')
		};
	}

	// ── metric readers ──────────────────────────────────────────────────

	private async readAvailableBalance(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		this.assertWindowSupported(query, ['point']);

		const currency = this.resolveCurrency(settings);
		const stripe = this.getClient(settings);

		try {
			const balance = await stripe.balance.retrieve();
			// `available` is one entry per currency; prefer the configured
			// currency and fall back to the first (single-currency accounts).
			const entry = balance.available.find((a) => a.currency === currency) ?? balance.available[0];

			return {
				value: (entry?.amount ?? 0) / 100,
				unit: entry?.currency ?? currency,
				at: new Date().toISOString()
			};
		} catch (error) {
			this.logError('balance_available', error);
			throw error;
		}
	}

	private async readGrossVolume(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample> {
		this.assertWindowSupported(query, [...RANGE_WINDOWS]);
		if (!isRangeWindow(query.window)) {
			// Unreachable after the assert above; keeps the type narrow.
			throw new Error(`Unsupported window '${query.window}' for gross_volume.`);
		}

		const currency = this.resolveCurrency(settings);
		const stripe = this.getClient(settings);
		const { gte, lt } = resolveWindowRange(query.window, query.windowAnchor);

		let totalMinorUnits = 0;
		let seen = 0;

		try {
			await stripe.charges.list({ created: { gte, lt }, limit: PAGE_SIZE }).autoPagingEach(async (charge) => {
				seen += 1;
				if (seen > MAX_CHARGES) {
					// We already summed MAX_CHARGES charges and Stripe is
					// still feeding more — the window is too large to read
					// accurately within the page cap. Fail loudly instead
					// of returning a silent undercount.
					throw new MetricTruncatedError(
						`gross_volume window contains more than ${MAX_CHARGES} charges ` +
							`(${MAX_PAGES} pages × ${PAGE_SIZE}); narrow the window (e.g. query per day).`
					);
				}
				// SINGLE-CURRENCY metric: only charges in the configured
				// currency are summed (compare lowercased on both sides —
				// `resolveCurrency` lowercases settings; Stripe reports
				// lowercase but we don't rely on it). NOTE: `charges.list`
				// has no currency filter, so foreign-currency charges are
				// still walked and count toward the page cap — unavoidable.
				// Refunds are intentionally NOT excluded/subtracted: the
				// metric is *gross* volume of successful (paid) charges,
				// per the README contract.
				if (charge.paid && charge.currency.toLowerCase() === currency) {
					totalMinorUnits += charge.amount;
				}
			});
		} catch (error) {
			this.logError('gross_volume', error);
			throw error;
		}

		return {
			value: totalMinorUnits / 100,
			unit: currency,
			at: new Date().toISOString()
		};
	}

	// ── helpers ─────────────────────────────────────────────────────────

	private assertWindowSupported(query: MetricQuery, supported: MetricWindow[]): void {
		if (!supported.includes(query.window)) {
			throw new Error(
				`Metric '${query.metricId}' does not support window '${query.window}'. ` +
					`Supported: ${supported.join(', ')}.`
			);
		}
	}

	private resolveCurrency(settings?: PluginSettings): string {
		const fromSettings = settings?.currency;
		if (typeof fromSettings === 'string' && fromSettings.length > 0) {
			return fromSettings.toLowerCase();
		}
		return 'usd';
	}

	private resolveSecretKey(settings?: PluginSettings, opts?: { optional: boolean }): string | undefined {
		const fromSettings = settings?.secretKey;
		if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;

		const fromEnv = process.env.STRIPE_SECRET_KEY;
		if (fromEnv && fromEnv.length > 0) return fromEnv;

		if (opts?.optional) return undefined;
		throw new Error(
			'Stripe secret key not configured. ' +
				'Set it in plugin settings or via the STRIPE_SECRET_KEY environment variable.'
		);
	}

	private getClient(settings?: PluginSettings): Stripe {
		const secretKey = this.resolveSecretKey(settings) as string;
		let client = stripeClientCache.get(secretKey);
		if (!client) {
			client = new Stripe(secretKey, {
				maxNetworkRetries: 2,
				appInfo: { name: 'Ever Works', url: 'https://ever.works' }
			});
			stripeClientCache.set(secretKey, client);
		}
		return client;
	}

	private logError(metricId: string, error: unknown): void {
		this.context?.logger.error(
			`Stripe metrics read failed (${metricId}): ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export default StripeMetricsPlugin;
