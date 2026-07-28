import { Injectable } from '@nestjs/common';
import { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import {
    PluginUsageRepository,
    UserSpendGroupRow,
} from '@src/database/repositories/plugin-usage.repository';
import type { PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';

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
 * B29 — one CSV line of the account-wide usage export. Deliberately an
 * explicit projection of `plugin_usage_events` (never the entity): the
 * scope columns (`tenantId` / `organizationId`) and the free-form
 * `metadata` blob stay server-side.
 */
export interface UsageExportRow {
    occurredAt: string;
    pluginId: string;
    capability: string;
    units: number;
    costCents: number;
    currency: string;
    modelId: string | null;
    workId: string | null;
    agentId: string | null;
    taskId: string | null;
    runId: string | null;
    requestId: string | null;
}

/**
 * CSV column order for the account-wide export. Exported so the API
 * controller writes the header from the same source of truth the rows
 * are projected from (a column added here can never silently drift out
 * of the header).
 */
export const USAGE_EXPORT_COLUMNS = [
    'occurredAt',
    'pluginId',
    'capability',
    'units',
    'costCents',
    'currency',
    'modelId',
    'workId',
    'agentId',
    'taskId',
    'runId',
    'requestId',
] as const satisfies readonly (keyof UsageExportRow)[];

export interface UsageExportOptions {
    /** `YYYY-MM` calendar month (default: current), or rolling `7d`/`30d`. */
    period?: string;
    /**
     * Active Organization from the request scope context. When set, only
     * that org's rows are exported. NEVER caller-supplied.
     */
    organizationId?: string | null;
    /** Rows fetched per DB round-trip while streaming (test seam). */
    pageSize?: number;
}

/** A resolved export: the echoed window plus a lazy chunked row stream. */
export interface UsageExportStream {
    window: UsageSummaryWindow;
    organizationId: string | null;
    /** Yields pages of rows — never the whole period at once. */
    chunks: AsyncIterable<UsageExportRow[]>;
}

/** Rows pulled per DB round-trip while streaming the CSV export. */
const USAGE_EXPORT_PAGE_SIZE = 500;

/** Hard ceiling so a caller-supplied page size can't force a huge read. */
const USAGE_EXPORT_MAX_PAGE_SIZE = 5000;

/** Entity → wire projection. Scope columns + metadata never leave here. */
function toUsageExportRow(event: PluginUsageEvent): UsageExportRow {
    return {
        occurredAt:
            event.occurredAt instanceof Date
                ? event.occurredAt.toISOString()
                : String(event.occurredAt ?? ''),
        pluginId: event.pluginId,
        capability: event.capability,
        units: Number(event.units ?? 0),
        costCents: Number(event.costCents ?? 0),
        currency: event.currency,
        modelId: event.modelId ?? null,
        workId: event.workId ?? null,
        agentId: event.agentId ?? null,
        taskId: event.taskId ?? null,
        runId: event.runId ?? null,
        requestId: event.requestId ?? null,
    };
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

    /**
     * B29 — account-wide usage CSV export (`GET /api/credits/usage/export`).
     *
     * Returns the resolved window synchronously (so the API boundary can
     * map a bad period to a 400 and build the filename BEFORE a single
     * byte is written) plus a lazy async iterable that pages the
     * repository. The whole period is never buffered: the controller
     * writes each chunk out as it arrives, so a year-long export costs
     * one page of rows in memory, not the year.
     *
     * Scope: `userId` is the authenticated caller; `organizationId` is
     * the request's active Organization (from the scope context) and is
     * never caller-supplied — see
     * `PluginUsageRepository.findPageForUserExport`.
     */
    createExport(userId: string, options: UsageExportOptions = {}): UsageExportStream {
        const window = resolveUsageSummaryWindow(options.period);
        const organizationId = options.organizationId ?? null;
        const pageSize = this.resolvePageSize(options.pageSize);
        const repository = this.pluginUsageRepository;

        async function* chunks(): AsyncGenerator<UsageExportRow[]> {
            let offset = 0;
            for (;;) {
                const events = await repository.findPageForUserExport(
                    userId,
                    window.from,
                    window.to,
                    { organizationId, limit: pageSize, offset },
                );
                if (events.length === 0) {
                    return;
                }
                yield events.map(toUsageExportRow);
                if (events.length < pageSize) {
                    return;
                }
                offset += events.length;
            }
        }

        return { window, organizationId, chunks: { [Symbol.asyncIterator]: chunks } };
    }

    private resolvePageSize(requested?: number): number {
        if (!requested || !Number.isFinite(requested) || requested < 1) {
            return USAGE_EXPORT_PAGE_SIZE;
        }
        return Math.min(Math.floor(requested), USAGE_EXPORT_MAX_PAGE_SIZE);
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
