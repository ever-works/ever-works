import { Injectable } from '@nestjs/common';
import { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import {
    PluginUsageRepository,
    UserSpendGroupRow,
} from '@src/database/repositories/plugin-usage.repository';

/** Wave 13 — grouping dimensions for `GET /api/credits/usage-summary`. */
export const USAGE_SUMMARY_GROUP_BYS = ['day', 'model', 'agent', 'work'] as const;
export type UsageSummaryGroupBy = (typeof USAGE_SUMMARY_GROUP_BYS)[number];

/** Resolved half-open `[from, to)` aggregation window. */
export interface UsageSummaryWindow {
    /** Normalized period echo (`YYYY-MM`, `7d`, or `30d`). */
    period: string;
    from: Date;
    to: Date;
}

/** A period expression this surface accepts (`YYYY-MM`, `7d`, `30d`). */
const MONTH_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ROLLING_PERIOD_RE = /^(7|30)d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stable-named error so the API boundary maps a bad period/groupBy to a
 * 400 (never an unmapped 500).
 */
export class InvalidUsagePeriodError extends Error {
    constructor(period: string) {
        super(`Invalid period (expected YYYY-MM, 7d, or 30d): ${period}`);
        this.name = 'InvalidUsagePeriodError';
    }
}

/**
 * Pure, exported for unit tests + the API DTO layer: resolve a period
 * expression to a UTC half-open window. Defaults to the current
 * calendar month (matching the existing usage controllers' semantics).
 * Rolling windows (`7d` / `30d`) end "now" so the by-day chart's
 * 7d/30d toggle shows the most recent activity.
 */
export function resolveUsageSummaryWindow(
    period?: string,
    now: Date = new Date(),
): UsageSummaryWindow {
    if (!period) {
        const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        return { period: month, from, to };
    }

    if (MONTH_PERIOD_RE.test(period)) {
        const [year, month] = period.split('-').map(Number);
        return {
            period,
            from: new Date(Date.UTC(year, month - 1, 1)),
            to: new Date(Date.UTC(year, month, 1)),
        };
    }

    if (ROLLING_PERIOD_RE.test(period)) {
        const days = period === '7d' ? 7 : 30;
        return {
            period,
            from: new Date(now.getTime() - days * DAY_MS),
            to: now,
        };
    }

    throw new InvalidUsagePeriodError(period);
}

/** §4.1 stat-tile totals (credits + counts) for one user + window. */
export interface UsageSummaryTotals {
    period: string;
    from: string;
    to: string;
    /** Current credits balance (not window-bound — the live number). */
    balanceCredits: number;
    /** Debits inside the window, returned positive. */
    creditsConsumed: number;
    /** Credits (purchases/grants/daily-free) inside the window. */
    creditsAdded: number;
    /** Metered spend (`plugin_usage_events.costCents`) in the window. */
    spendCents: number;
    tasksCompleted: number;
    worksActive: number;
    agentRuns: number;
}

/** One grouped row for the §4.3 charts. */
export interface UsageSummaryGroupRow {
    /** Raw grouping key (day / modelId / agentId / workId); null = unattributed. */
    key: string | null;
    /** Display label (day string, model id, Agent/Work name). */
    label: string;
    units: number;
    costCents: number;
}

export interface UsageSummaryGrouped {
    period: string;
    from: string;
    to: string;
    groupBy: UsageSummaryGroupBy;
    rows: UsageSummaryGroupRow[];
}

/**
 * Wave 13 (Billing / Usage & Credits pages) — owner-scoped account-wide
 * usage aggregations behind `GET /api/credits/usage-summary`.
 *
 * Reads ONLY: composes the existing metering source of truth
 * (`plugin_usage_events` via `PluginUsageRepository`) with the credits
 * ledger (`CreditLedgerRepository`). Every aggregation is a single
 * grouped query per dimension (plus at most one `IN` name-resolution
 * query) — never a per-row lookup.
 */
@Injectable()
export class UsageSummaryService {
    constructor(
        private readonly pluginUsageRepository: PluginUsageRepository,
        private readonly creditLedgerRepository: CreditLedgerRepository,
    ) {}

    /** §4.1/§4.2 — stat tiles + consumption counts, one user + window. */
    async getTotals(userId: string, period?: string): Promise<UsageSummaryTotals> {
        const window = resolveUsageSummaryWindow(period);
        const [balanceCredits, ledgerTotals, spendCents, counts] = await Promise.all([
            this.creditLedgerRepository.getBalance(userId),
            this.creditLedgerRepository.getPeriodTotals(userId, window.from, window.to),
            this.pluginUsageRepository.getTotalSpendCentsForUser(userId, window.from, window.to),
            this.pluginUsageRepository.getUsageCountsForUser(userId, window.from, window.to),
        ]);

        return {
            period: window.period,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            balanceCredits,
            creditsConsumed: ledgerTotals.consumedCredits,
            creditsAdded: ledgerTotals.addedCredits,
            spendCents,
            tasksCompleted: counts.tasksCompleted,
            worksActive: counts.worksActive,
            agentRuns: counts.agentRuns,
        };
    }

    /** §4.3 — one chart's data: grouped spend for a dimension. */
    async getGrouped(
        userId: string,
        groupBy: UsageSummaryGroupBy,
        period?: string,
    ): Promise<UsageSummaryGrouped> {
        const window = resolveUsageSummaryWindow(period);
        const rows = await this.resolveRows(userId, groupBy, window);
        return {
            period: window.period,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            groupBy,
            rows,
        };
    }

    private async resolveRows(
        userId: string,
        groupBy: UsageSummaryGroupBy,
        window: UsageSummaryWindow,
    ): Promise<UsageSummaryGroupRow[]> {
        switch (groupBy) {
            case 'day': {
                const buckets = await this.pluginUsageRepository.getDailySpendForUser(
                    userId,
                    window.from,
                    window.to,
                );
                return buckets.map((b) => ({
                    key: b.day,
                    label: b.day,
                    units: 0,
                    costCents: b.costCents,
                }));
            }
            case 'model': {
                const rows = await this.pluginUsageRepository.getSpendByModelForUser(
                    userId,
                    window.from,
                    window.to,
                );
                // modelId IS the display label; null = calls that never
                // went through a model (search/screenshot/… capabilities).
                return rows.map((r) => this.toRow(r, r.key));
            }
            case 'agent': {
                const rows = await this.pluginUsageRepository.getSpendByAgentForUser(
                    userId,
                    window.from,
                    window.to,
                );
                const names = await this.pluginUsageRepository.getAgentNames(
                    rows.map((r) => r.key).filter((k): k is string => k !== null),
                );
                return rows.map((r) => this.toRow(r, r.key ? (names.get(r.key) ?? null) : null));
            }
            case 'work': {
                const rows = await this.pluginUsageRepository.getSpendByWorkForUser(
                    userId,
                    window.from,
                    window.to,
                );
                const names = await this.pluginUsageRepository.getWorkNames(
                    rows.map((r) => r.key).filter((k): k is string => k !== null),
                );
                return rows.map((r) => this.toRow(r, r.key ? (names.get(r.key) ?? null) : null));
            }
        }
    }

    /**
     * Missing labels stay null-keyed but get an honest fallback label —
     * the UI translates `key === null` rows to its localized
     * "unattributed" copy; a resolved-but-deleted entity falls back to
     * the raw id so the row is still identifiable.
     */
    private toRow(row: UserSpendGroupRow, label: string | null): UsageSummaryGroupRow {
        return {
            key: row.key,
            label: label ?? row.key ?? '',
            units: row.units,
            costCents: row.costCents,
        };
    }
}
