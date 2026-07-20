import type { IPlugin } from '../plugin.interface.js';
import type { PluginPricing } from '../pricing.types.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Goals feature — PR-7 (metrics-provider capability).
 *
 * Capability contract for external metrics collectors. Lets plugins
 * surface business/operational metrics (Stripe balance, income,
 * arbitrary HTTP-backed counters, analytics events, …) into the
 * platform so Goals (PR-8) can evaluate targets like "$100/day
 * balance" or "$1000/month income" without hard-coding any vendor.
 *
 * First providers: `custom-http` (GET-only, SSRF-guarded, JSONPath-ish
 * extraction) and `stripe` (official `stripe` SDK — balance + income
 * per day/week/month windows). PostHog + Google Analytics follow in
 * PR-9. The platform's `MetricsFacadeService` routes through enabled
 * `metrics-provider` plugins — multiple providers can be enabled at
 * once; callers address a specific provider by plugin id.
 *
 * **READ-ONLY BY DESIGN.** Implementations MUST NOT mutate any remote
 * state: no POST/PUT/PATCH/DELETE side effects, no writes to the
 * upstream system, no resource creation — only reads. The platform
 * treats any write attempt by a metrics provider as a contract
 * violation.
 *
 * Capability id: `'metrics-provider'`.
 */

/**
 * Aggregation window a metric value can be requested over.
 *
 * - `day` / `week` / `month` — the value aggregated over that period
 *   (anchored by {@link MetricQuery.windowAnchor} when provided).
 * - `total` — the all-time / cumulative value.
 * - `point` — an instantaneous point-in-time reading (e.g. current
 *   Stripe balance) where aggregation windows don't apply.
 */
export type MetricWindow = 'day' | 'week' | 'month' | 'total' | 'point';

/**
 * A metric the provider can serve, returned by
 * {@link IMetricsProviderPlugin.listMetrics}.
 */
export interface MetricDescriptor {
	/** Provider-scoped stable metric identifier (e.g. `'balance'`, `'income'`). */
	id: string;
	/** Human-readable display label (e.g. `'Available balance'`). */
	label: string;
	/** Unit of the metric value (e.g. `'usd'`, `'count'`, `'ms'`). */
	unit: string;
	/** Windows this metric supports being queried over. */
	supportedWindows: MetricWindow[];
	/**
	 * Optional JSON Schema describing extra per-query parameters the
	 * metric accepts via {@link MetricQuery.params} (e.g. a currency
	 * filter). Omitted when the metric takes no parameters.
	 */
	paramsSchema?: Record<string, unknown>;
}

/**
 * A request for one metric value over one window.
 */
export interface MetricQuery {
	/** Which metric to read — a {@link MetricDescriptor.id}. */
	metricId: string;
	/** Aggregation window; must be one of the metric's `supportedWindows`. */
	window: MetricWindow;
	/**
	 * Optional ISO-8601 anchor for the window (e.g. `'2026-07-19'` =
	 * "the day/week/month containing this instant"). Defaults to "now"
	 * when omitted. Ignored for `total` and `point` windows.
	 */
	windowAnchor?: string;
	/** Extra metric-specific parameters (validated by `paramsSchema`). */
	params?: Record<string, unknown>;
}

/**
 * One observed metric value, returned by
 * {@link IMetricsProviderPlugin.getMetricValue}.
 */
export interface MetricSample {
	/** The numeric metric value. */
	value: number;
	/** Unit of `value` (echoes the descriptor's unit). */
	unit: string;
	/** ISO-8601 timestamp the sample was observed / computed at. */
	at: string;
}

/**
 * Metrics-provider plugin interface.
 * Capability: `'metrics-provider'`.
 *
 * The contract is strictly read-only — see the module doc block above.
 * Both methods MAY receive per-call resolved settings from the facade
 * (4-level hierarchy: Work > User > Admin > Plugin defaults);
 * implementations should prefer those over stored defaults, matching
 * the `task-tracker` sibling idiom.
 */
export interface IMetricsProviderPlugin extends IPlugin {
	/** Provider name (e.g. `'stripe'`, `'custom-http'`). */
	readonly providerName: string;

	/**
	 * Enumerate the metrics this provider can serve for the given
	 * settings. MUST be side-effect free.
	 */
	listMetrics(settings?: PluginSettings): Promise<MetricDescriptor[]>;

	/**
	 * Read one metric value. MUST be side-effect free — a pure read of
	 * the upstream system.
	 */
	getMetricValue(query: MetricQuery, settings?: PluginSettings): Promise<MetricSample>;

	/**
	 * Optional: cheap synchronous availability probe (e.g. "is an API
	 * key configured?"). Mirrors `ITaskTrackerPlugin.isAvailable`.
	 */
	isAvailable?(settings?: PluginSettings): boolean;

	/**
	 * Optional: Declare per-call pricing for budget tracking (EW-602).
	 * Returned cost is recorded against PluginUsageEvent on each
	 * `getMetricValue` call. Plugins that don't implement this
	 * contribute units only (cost = 0).
	 */
	getPricing?(): PluginPricing | Promise<PluginPricing>;
}

/**
 * Type guard for metrics-provider plugins
 */
export function isMetricsProviderPlugin(plugin: IPlugin): plugin is IMetricsProviderPlugin {
	return plugin.capabilities.includes('metrics-provider');
}
