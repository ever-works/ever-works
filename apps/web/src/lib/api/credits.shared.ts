/**
 * Billing + Usage & Credits (Wave 13) — client-safe wire types + pure
 * helpers for the `/settings/billing` and `/settings/usage` pages.
 *
 * Mirrors the API's read-only credits surface
 * (`apps/api/src/subscriptions/credits.controller.ts` +
 * `subscriptions.controller.ts`); kept apart from `credits.ts` (which
 * is `server-only`) so `'use client'` components can import types and
 * helpers without pulling the server guard into the client bundle —
 * same split as `agents.shared.ts`.
 */

// ── Wire types ──────────────────────────────────────────────────────

/** `credit_ledger_entries.kind` — mirrors the agent's CreditLedgerKind. */
export type CreditLedgerKind =
    | 'purchase'
    | 'grant'
    | 'daily-free'
    | 'consumption'
    | 'adjustment'
    | 'expiry';

export const CREDIT_LEDGER_KINDS: readonly CreditLedgerKind[] = [
    'purchase',
    'grant',
    'daily-free',
    'consumption',
    'adjustment',
    'expiry',
];

export interface CreditsBalance {
    status: string;
    balanceCredits: number;
}

export interface CreditLedgerRow {
    id: string;
    kind: CreditLedgerKind;
    /** Signed: positive = credit, negative = debit. */
    amountCredits: number;
    balanceAfter: number;
    costCentsRef: number | null;
    refType: string | null;
    refId: string | null;
    description: string | null;
    createdAt: string;
}

export interface CreditsLedgerPage {
    status: string;
    entries: CreditLedgerRow[];
    total: number;
    page: number;
    pageSize: number;
}

export type UsageSummaryGroupBy = 'day' | 'model' | 'agent' | 'work';

/** Rolling windows offered by the Usage & Credits period selector. */
export const USAGE_ROLLING_PERIODS = ['7d', '30d'] as const;
export type UsageRollingPeriod = (typeof USAGE_ROLLING_PERIODS)[number];

/**
 * B20 — a `YYYY-MM` calendar month.
 *
 * The period selector used to be hard-typed `'7d' | '30d'`, which made
 * the month option the API has always accepted unreachable from the UI.
 * Modelled as a template-literal type (rather than a bare `string`) so a
 * random string still can't be passed where a period is expected; the
 * two-arm split (`-0x` / `-1x`) keeps `2026-07` assignable without
 * relying on `${number}` matching a zero-padded segment. The type can't
 * express "01…12", so `isUsageMonthPeriod` validates at runtime.
 */
export type UsageMonthPeriod = `${number}-0${number}` | `${number}-1${number}`;

/** Everything `GET /credits/usage-summary?period=` accepts. */
export type UsagePeriod = UsageRollingPeriod | UsageMonthPeriod;

const USAGE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface UsageSummaryTotals {
    status: string;
    period: string;
    from: string;
    to: string;
    balanceCredits: number;
    creditsConsumed: number;
    creditsAdded: number;
    spendCents: number;
    tasksCompleted: number;
    worksActive: number;
    agentRuns: number;
}

export interface UsageSummaryGroupRow {
    key: string | null;
    label: string;
    units: number;
    costCents: number;
}

export interface UsageSummaryGrouped {
    status: string;
    period: string;
    from: string;
    to: string;
    groupBy: UsageSummaryGroupBy;
    rows: UsageSummaryGroupRow[];
}

export interface SubscriptionPlanSummary {
    status: string;
    enabled: boolean;
    plan: { code: string; name: string; allowedCadences?: unknown[] };
}

export interface SubscriptionPlanListItem {
    code: string;
    name: string;
    /** `'cloud'` | `'selfhosted'`. Echoed by the API; was silently dropped here. */
    hosting?: string;
    maxWorks: number;
    allowedCadences: string[];
    /** Decimal string from the API (e.g. `'29'` / `'29.00'`). */
    monthlyPrice: string;
    /**
     * The YEARLY total, not a monthly equivalent — cloud Pro is `'204'`.
     * Divide by 12 before rendering it next to a `/mo` suffix.
     */
    annualPrice?: string | null;
    /** One-off perpetual licence price. Only `selfhosted_pro` has one. */
    lifetimePrice?: string | null;
    seatsIncluded?: number | null;
    seatMonthlyPrice?: string | null;
    monthlyCredits?: number | null;
    overagePricePerRun: string;
    currency: string;
    isCurrent: boolean;
    dailyFreeCredits: number;
}

export interface SubscriptionPlanList {
    status: string;
    enabled: boolean;
    currentPlanCode: string;
    plans: SubscriptionPlanListItem[];
    /**
     * Self-hosted commercial editions — a SEPARATE list from `plans`.
     *
     * They are purchasable but never self-assignable: buying one is a
     * licence for a deployment you run yourself and changes nothing about
     * your tier here. Rendering them as cards in the plan switcher would
     * offer buttons whose only possible outcome is a 403. Optional so an
     * older API response still types.
     */
    licences?: SubscriptionPlanListItem[];
}

// ── Pure helpers (unit-tested in credits.shared.unit.spec.ts) ───────

/**
 * Credits are USD-denominated: 1 credit = 1 cent of platform-billed
 * usage at the default conversion (PRD §3.2), so credits render as $.
 */
export function formatCreditsAsDollars(credits: number, currency = 'usd'): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
            maximumFractionDigits: 2,
        }).format(credits / 100);
    } catch {
        return `$${(credits / 100).toFixed(2)}`;
    }
}

/** costCents → display dollars (same formatting as the budgets pages). */
export function formatCents(cents: number, currency = 'usd'): string {
    return formatCreditsAsDollars(cents, currency);
}

/**
 * Signed ledger movement → display string with an explicit sign so
 * credits (+) and debits (−) scan at a glance in the ledger table.
 */
export function formatSignedCredits(amountCredits: number, currency = 'usd'): string {
    const sign = amountCredits >= 0 ? '+' : '−';
    return `${sign}${formatCreditsAsDollars(Math.abs(amountCredits), currency)}`;
}

/** Ledger kind → badge tone bucket (colors mapped in the component). */
export type LedgerKindTone = 'positive' | 'negative' | 'neutral';

export function ledgerKindTone(kind: CreditLedgerKind): LedgerKindTone {
    switch (kind) {
        case 'purchase':
        case 'grant':
        case 'daily-free':
            return 'positive';
        case 'consumption':
        case 'expiry':
            return 'negative';
        case 'adjustment':
            return 'neutral';
    }
}

/**
 * Preset top-up amounts (PRD §3.2) with the credits each buys at the
 * default conversion (100 credits per $1 — margin applies at debit
 * time, not purchase time).
 */
export const CREDIT_TOPUP_PRESETS_CENTS: readonly number[] = [1000, 2500, 10000];

export function creditsForTopupCents(amountCents: number, creditsPerDollar = 100): number {
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return 0;
    }
    return Math.floor((amountCents / 100) * creditsPerDollar);
}

/** Build the `/credits/ledger` query string (omits empty filters). */
export function buildLedgerQuery(params: {
    period?: string;
    kinds?: readonly CreditLedgerKind[];
    page?: number;
    pageSize?: number;
}): string {
    const search = new URLSearchParams();
    if (params.period) {
        search.set('period', params.period);
    }
    if (params.kinds && params.kinds.length > 0) {
        search.set('kinds', params.kinds.join(','));
    }
    if (params.page && params.page > 1) {
        search.set('page', String(params.page));
    }
    if (params.pageSize) {
        search.set('pageSize', String(params.pageSize));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

/** Build the `/credits/usage-summary` query string. */
export function buildUsageSummaryQuery(params: {
    groupBy?: UsageSummaryGroupBy;
    period?: UsagePeriod;
}): string {
    const search = new URLSearchParams();
    if (params.groupBy) {
        search.set('groupBy', params.groupBy);
    }
    if (params.period) {
        search.set('period', params.period);
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

// ── B20 period helpers (unit-tested in credits.shared.unit.spec.ts) ──

/** `2026-07` → true; `2026-13` / `7d` / `2026-7` → false. */
export function isUsageMonthPeriod(value: string): value is UsageMonthPeriod {
    return USAGE_MONTH_RE.test(value);
}

/** Runtime guard for anything the selector / a `?period=` deep link yields. */
export function isUsagePeriod(value: string): value is UsagePeriod {
    return (
        (USAGE_ROLLING_PERIODS as readonly string[]).includes(value) || isUsageMonthPeriod(value)
    );
}

/**
 * Normalize an untrusted value (URL param, storage) to a period.
 * Returns `undefined` rather than throwing so callers can fall back to
 * their own default — a bad `?period=` must never blank the page.
 */
export function parseUsagePeriod(value: unknown): UsagePeriod | undefined {
    if (Array.isArray(value)) {
        return parseUsagePeriod(value[0]);
    }
    return typeof value === 'string' && isUsagePeriod(value) ? value : undefined;
}

/** Current UTC calendar month as `YYYY-MM` (matches the API's default). */
export function currentUsageMonth(now: Date = new Date()): UsageMonthPeriod {
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return month as UsageMonthPeriod;
}

/**
 * The `count` most recent calendar months, newest first — the option
 * list for the month picker. UTC throughout so it agrees with the API's
 * window resolution regardless of the viewer's timezone.
 */
export function recentUsageMonths(count = 12, now: Date = new Date()): UsageMonthPeriod[] {
    const months: UsageMonthPeriod[] = [];
    for (let offset = 0; offset < Math.max(0, count); offset += 1) {
        const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
        months.push(currentUsageMonth(cursor));
    }
    return months;
}

/** `2026-07` → `July 2026`. Falls back to the raw value if unformattable. */
export function formatUsageMonthLabel(month: string, locale = 'en-US'): string {
    if (!isUsageMonthPeriod(month)) {
        return month;
    }
    const [year, monthNumber] = month.split('-').map(Number);
    try {
        return new Intl.DateTimeFormat(locale, {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
    } catch {
        return month;
    }
}

/** Build the `/credits/usage/export` query string (B29 CSV download). */
export function buildUsageExportQuery(params: { period?: UsagePeriod } = {}): string {
    const search = new URLSearchParams();
    if (params.period) {
        search.set('period', params.period);
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

/** `'29'` / `'29.00'` → `$29/mo`; `'0'` → localized "free" handled by caller. */
export function formatMonthlyPrice(monthlyPrice: string, currency = 'usd'): string {
    const price = Number(monthlyPrice);
    if (!Number.isFinite(price)) {
        return monthlyPrice;
    }
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
            maximumFractionDigits: price % 1 === 0 ? 0 : 2,
        }).format(price);
    } catch {
        return `$${price}`;
    }
}

/** A plan is free (self-serviceable) only when its price parses to ≤ 0. */
export function isFreePlan(plan: Pick<SubscriptionPlanListItem, 'monthlyPrice'>): boolean {
    const price = Number(plan.monthlyPrice);
    return Number.isFinite(price) && price <= 0;
}
