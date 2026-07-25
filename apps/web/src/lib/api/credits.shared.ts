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
    maxWorks: number;
    allowedCadences: string[];
    /** Decimal string from the API (e.g. `'29'` / `'29.00'`). */
    monthlyPrice: string;
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
    period?: string;
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
