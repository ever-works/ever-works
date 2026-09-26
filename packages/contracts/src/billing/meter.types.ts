/**
 * Meters and the credit price list (AW-17) — the wire vocabulary that tells
 * an owner which of three ways a unit of spend was paid for, and what a kind
 * of call costs before it is made.
 *
 * Zero-dependency value types only. Classification happens once, when the
 * usage row is written (`@ever-works/agent` usage module); the rows live in
 * the existing `plugin_usage_events` table — there is no second usage store.
 *
 * Honesty rule shared with the runs contracts: a `null` figure means "the
 * platform did not measure this", never "zero".
 */

/** The three meters, named identically on every surface. */
export const USAGE_METER_IDS = ['model', 'credits', 'addon'] as const;
export type UsageMeterId = (typeof USAGE_METER_IDS)[number];

/**
 * Who paid the provider for a call.
 *
 * - `workspace`   — a credential the Workspace owns (its own key, its own machine).
 * - `platform`    — a credential the platform supplied.
 * - `unconfirmed` — the paying credential could not be determined; billed as
 *   `platform` and surfaced as unconfirmed rather than silently treated as free.
 */
export const USAGE_PAYER_IDS = ['workspace', 'platform', 'unconfirmed'] as const;
export type UsagePayerId = (typeof USAGE_PAYER_IDS)[number];

/** Did the call do new work? `cached` and `failed` are always zero-rated. */
export const USAGE_OUTCOME_IDS = ['ok', 'cached', 'failed'] as const;
export type UsageOutcomeId = (typeof USAGE_OUTCOME_IDS)[number];

export type SpendCapScope = 'workspace' | 'agent' | 'mission' | 'work' | 'node';
export type SpendCapState = 'ok' | 'warning' | 'stopped' | 'exceeded';
export type AddonCode = 'agent-inbox' | 'fleet-node' | 'seat';
export type AddonStatus = 'pending' | 'active' | 'removed' | 'failed' | 'orphan';

/** Smallest cap an owner may set, in cents ($1.00). */
export const SPEND_CAP_MIN_CENTS = 100;
/** Percent thresholds that each notify once per cap per period. */
export const SPEND_CAP_THRESHOLDS = [75, 90, 100] as const;
/** How quickly a cap change must reach every executing Agent. */
export const SPEND_CAP_PROPAGATION_MS = 30_000;
export const AUTO_RECHARGE_MONTHLY_CAP_DEFAULT_CENTS = 10_000;
export const AUTO_RECHARGE_MONTHLY_CAP_MIN_CENTS = 1_000;
export const AUTO_RECHARGE_MONTHLY_CAP_MAX_CENTS = 200_000;
export const AUTO_RECHARGE_MAX_CONSECUTIVE_FAILURES = 3;
export const ADDON_MAX_UNITS_PER_KIND = 25;
/** Default freshness window of a cached result, per kind of call. */
export const USAGE_CACHE_FRESHNESS_HOURS = 24;
/** A usage export resolving to more rows than this is refused before it starts. */
export const USAGE_EXPORT_MAX_ROWS = 50_000;
/** A usage export spanning more days than this is refused before it starts. */
export const USAGE_EXPORT_MAX_DAYS = 92;
/** Rows a spend breakdown shows before folding the tail into "Everything else". */
export const BREAKDOWN_TOP_N = 10;
/** Share of metered calls with an unconfirmed payer that should alert (0.1%). */
export const UNCONFIRMED_PAYER_ALERT_RATIO = 0.001;

/** Sentinel key of the folded tail row of a breakdown. Never a real id. */
export const BREAKDOWN_EVERYTHING_ELSE_KEY = 'everything-else';

/** How a price-list entry turns a call into credits. */
export const CREDIT_PRICE_BASES = ['per-unit', 'provider-cost'] as const;
export type CreditPriceBasis = (typeof CREDIT_PRICE_BASES)[number];

/**
 * How a run's platform-paid spend turns into a credits debit.
 *
 * - `provider_cost` — the default. Every billable row settles from the
 *   provider's own metered cost at the configured credits-per-dollar rate and
 *   margin, exactly as runs settled before the price list existed. Rows are
 *   still classified and stamped with what the price list would charge, but
 *   no fixed price is debited.
 * - `price_list` — opt-in. A row priced by a fixed `per-unit` entry debits its
 *   published credits (zero when cached or failed); every other row still
 *   settles from its provider cost.
 *
 * Workspace-paid calls are never debited in either mode.
 */
export const CREDIT_SETTLEMENT_MODES = ['provider_cost', 'price_list'] as const;
export type CreditSettlementMode = (typeof CREDIT_SETTLEMENT_MODES)[number];

/** The mode an install that configures nothing settles in. */
export const DEFAULT_CREDIT_SETTLEMENT_MODE: CreditSettlementMode = 'provider_cost';

export function isCreditSettlementMode(value: unknown): value is CreditSettlementMode {
	return typeof value === 'string' && (CREDIT_SETTLEMENT_MODES as readonly string[]).includes(value);
}

/**
 * Display groups of the price list.
 *
 * `hosting` is appended by the App Works programme (APW-10 FR-50, T50): the
 * managed Apps tier's `hosting.*` keys and `relay.messages` need a group of
 * their own rather than being filed under `tools`, so the price list can show
 * what a hosted App Work costs separately from what an agent run costs.
 * Appended, never inserted, so every existing group keeps its position.
 */
export const CREDIT_PRICE_GROUPS = ['research', 'data', 'tools', 'models', 'hosting'] as const;
export type CreditPriceGroup = (typeof CREDIT_PRICE_GROUPS)[number];

/**
 * One kind of call on the credit price list.
 *
 * `key` is `capability.operation` — NEVER a Plugin id — so changing the
 * Plugin behind a capability never changes what the owner pays.
 */
export interface CreditPriceEntry {
	key: string;
	group: CreditPriceGroup;
	basis: CreditPriceBasis;
	/**
	 * Credits per `unit` for a `per-unit` entry. Null for `provider-cost`
	 * entries, which convert the provider's own metered cost at the published
	 * credits-per-dollar rate instead of a fixed number.
	 */
	credits: number | null;
	/** `query` | `page` | `capture` | `call` | `usage` — what one unit is. */
	unit: string;
}

/** One version of the published price list. */
export interface CreditPriceListVersion {
	version: number;
	/** `YYYY-MM-DD` the version took effect. */
	effectiveFrom: string;
	entries: CreditPriceEntry[];
}

/** The price list as the product reads it. */
export interface CreditPriceListView extends CreditPriceListVersion {
	/** Credits per $1 (default 100 → 1 credit = 1 cent). */
	creditsPerDollar: number;
	/** Every version ever published, oldest first; nothing is ever re-priced. */
	versions: number[];
	/**
	 * How runs on this deployment are actually debited. When `provider_cost`
	 * the `per-unit` credits above are reference prices — what the list would
	 * charge — and are not what a run is debited; a surface must say so rather
	 * than present them as charges.
	 */
	settlementMode: CreditSettlementMode;
}

/** Totals for one meter over a window. */
export interface UsageMeterTotals {
	meter: UsageMeterId;
	/** Usage rows classified to this meter. */
	calls: number;
	/** Provider cost the rows carry, in cents; null when none was measured. */
	costCents: number | null;
	/**
	 * Credits the rows account for at the published price list (always 0 for
	 * `model` and `addon`). Debited as such only in the `price_list` settlement
	 * mode; in `provider_cost` mode runs are debited from provider cost and this
	 * is the list-price figure, not the amount taken from the balance.
	 */
	credits: number;
	/** Of `calls`, how many were zero-rated because they came from cache. */
	cachedCalls: number;
	/** Of `calls`, how many failed and cost nothing. */
	failedCalls: number;
	/** Of `calls`, how many had a payer the platform could not confirm. */
	unconfirmedCalls: number;
}

/**
 * Usage recorded before meters were separated. Reported on its own and never
 * folded into a named meter — inferring one would be a guess.
 */
export interface UsagePreMeterResidual {
	calls: number;
	costCents: number;
}
