import { Injectable } from '@nestjs/common';
import {
    RUN_LEDGER_DEFAULT_LIMIT,
    RUN_LEDGER_MAX_LIMIT,
    RUN_REPEAT_FAILURE_THRESHOLD,
    type RunCalendarDay,
    type RunCalendarMonth,
    type RunLedgerFilters,
    type RunLedgerGranularity,
    type RunLedgerPage,
    type RunLedgerRow,
    type RunLedgerStatus,
    type RunLedgerWindow,
    type RunWindowStats,
} from '@ever-works/contracts';
import {
    AgentRunRepository,
    type RunLedgerQueryFilters,
} from '../database/repositories/agent-run.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import type { AgentRun } from '../entities/agent-run.entity';
import { buildCapturePreview, CAPTURE_MESSAGE_MAX_CHARS } from './run-capture';
import {
    addCalendarDays,
    addCalendarMonths,
    calendarDateInTimezone,
    isValidTimezone,
    parseCalendarDate,
    reachableRange,
    resolveRunWindow,
    startOfCalendarDate,
} from './run-window';
import { computeRunWindowStats, scheduleKeyForRun } from './run-window-stats';

/** Upper bound on runs scanned to paint one calendar month. */
export const RUN_CALENDAR_SCAN_CAP = 20_000;

/** What a ledger caller asks for: a window, filters and (for pages) a cursor. */
export interface RunLedgerRequest {
    granularity?: RunLedgerGranularity | string | null;
    /** `YYYY-MM-DD` anchor in `timezone`; today when omitted. */
    date?: string | null;
    timezone?: string | null;
    filters?: RunLedgerFilters;
    limit?: number | null;
    /** `<epochMillis>_<uuid>` from a previous page. */
    cursor?: string | null;
    /** Injected clock for tests. */
    now?: Date;
}

/**
 * Runs ledger (AW-09) — the calendar-navigated read model over the SAME
 * `agent_runs` rows the Sessions list and the Costs dashboard read. There is
 * no second run store: this service resolves a window, asks the repository
 * (which owns every scope predicate) and maps rows onto the wire shape.
 *
 * A 50-row page costs a bounded number of queries regardless of its
 * content: one page read, one count and one batched label lookup per
 * entity kind.
 */
@Injectable()
export class RunLedgerService {
    constructor(private readonly runs: AgentRunRepository) {}

    /** One cursor page of runs for the window, newest first. */
    async listRuns(
        userId: string,
        request: RunLedgerRequest,
        ownershipScope?: OwnershipScope,
    ): Promise<RunLedgerPage> {
        const window = this.resolveWindow(request);
        const range = toRange(window);
        const filters = toQueryFilters(request.filters);
        const limit = clampLimit(request.limit);
        const cursor = parseLedgerCursor(request.cursor);

        const [fetched, total] = await Promise.all([
            this.runs.listLedgerPage(userId, range, filters, limit + 1, cursor, ownershipScope),
            this.runs.countLedger(userId, range, filters, ownershipScope),
        ]);
        const page = fetched.slice(0, limit);
        const last = page.length > 0 ? page[page.length - 1] : null;
        // Only an empty, unfiltered first page needs to know whether the
        // caller has runs elsewhere — every other page skips the probe.
        const everRan =
            total === 0 && !cursor && !hasActiveFilters(filters)
                ? await this.runs.hasAnyRunForUser(userId, ownershipScope)
                : null;

        return {
            window,
            rows: await this.toRows(page),
            nextCursor: fetched.length > limit && last ? ledgerCursorOf(last) : null,
            total,
            limit,
            everRan,
        };
    }

    /** Headline numbers for the same window + filters the list shows. */
    async getStats(
        userId: string,
        request: RunLedgerRequest,
        ownershipScope?: OwnershipScope,
    ): Promise<RunWindowStats> {
        const window = this.resolveWindow(request);
        const range = toRange(window);
        const filters = toQueryFilters(request.filters);
        const [groups, repeats] = await Promise.all([
            this.runs.aggregateLedger(userId, range, filters, ownershipScope),
            this.runs.countScheduledFailuresByAgent(
                userId,
                range,
                filters,
                RUN_REPEAT_FAILURE_THRESHOLD,
                ownershipScope,
            ),
        ]);
        const labels =
            repeats.length > 0
                ? await this.runs.resolveLedgerLabels({
                      agentIds: repeats.map((row) => row.agentId),
                      taskIds: [],
                      workIds: [],
                  })
                : null;
        const agentNames = new Map<string, string>();
        for (const [id, agent] of labels?.agents ?? []) agentNames.set(id, agent.name);
        return computeRunWindowStats(window, groups, repeats, agentNames);
    }

    /**
     * Days of one calendar month (`YYYY-MM`) that had runs, with how many
     * failed — the mini-calendar's two markers. A month entirely outside the
     * reachable range reads nothing and returns no days.
     *
     * A month the reachable range only partly covers (the one 12 months back,
     * the one 7 days ahead) is read from the first reachable day through the
     * end of the last reachable day, never the whole month: the calendar only
     * marks days that can be jumped to, so a marker can never point at a day
     * the ledger would clamp away and answer with a different day's runs.
     */
    async getCalendar(
        userId: string,
        request: {
            month: string;
            timezone?: string | null;
            filters?: RunLedgerFilters;
            now?: Date;
        },
        ownershipScope?: OwnershipScope,
    ): Promise<RunCalendarMonth> {
        const timezone = isValidTimezone(request.timezone) ? request.timezone : 'UTC';
        const firstDay = `${request.month}-01`;
        if (!parseCalendarDate(firstDay)) {
            return { month: request.month, timezone, days: [], truncated: false };
        }
        const now = request.now ?? new Date();
        const { earliest, latest } = reachableRange(now, timezone);
        const nextMonth = addCalendarMonths(firstDay, 1);
        if (nextMonth <= earliest || firstDay > latest) {
            return { month: request.month, timezone, days: [], truncated: false };
        }

        // Calendar-date strings compare in date order, so clipping is done on
        // dates and only the final bounds are turned into instants.
        const fromDate = firstDay < earliest ? earliest : firstDay;
        const dayAfterLatest = addCalendarDays(latest, 1);
        const toDate = nextMonth > dayAfterLatest ? dayAfterLatest : nextMonth;
        const range = {
            from: startOfCalendarDate(fromDate, timezone),
            to: startOfCalendarDate(toDate, timezone),
        };
        const instants = await this.runs.listLedgerInstants(
            userId,
            range,
            toQueryFilters(request.filters),
            RUN_CALENDAR_SCAN_CAP,
            ownershipScope,
        );

        const byDay = new Map<string, RunCalendarDay>();
        for (const { at, status } of instants) {
            const date = calendarDateInTimezone(at, timezone);
            const day = byDay.get(date) ?? { date, runs: 0, failures: 0 };
            day.runs += 1;
            if (status === 'failed') day.failures += 1;
            byDay.set(date, day);
        }

        return {
            month: request.month,
            timezone,
            days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
            truncated: instants.length >= RUN_CALENDAR_SCAN_CAP,
        };
    }

    /** The resolved window a request describes — exposed so callers echo the same one. */
    resolveWindow(request: RunLedgerRequest): RunLedgerWindow {
        return resolveRunWindow({
            granularity: request.granularity,
            date: request.date,
            timezone: request.timezone,
            now: request.now,
        });
    }

    /** Map runs onto ledger rows with one batched label lookup per entity kind. */
    async toRows(runs: AgentRun[]): Promise<RunLedgerRow[]> {
        if (runs.length === 0) return [];
        const labels = await this.runs.resolveLedgerLabels({
            agentIds: runs.map((run) => run.agentId),
            taskIds: runs.map((run) => run.taskId ?? '').filter(Boolean),
            workIds: runs.map((run) => run.workId ?? '').filter(Boolean),
        });
        return runs.map((run) => {
            const agent = labels.agents.get(run.agentId);
            const task = run.taskId ? labels.tasks.get(run.taskId) : undefined;
            const missionId = task?.missionId ?? null;
            return {
                id: run.id,
                agentId: run.agentId,
                agentName: agent?.name ?? null,
                agentArchived: agent?.archived ?? false,
                triggerKind: run.triggerKind,
                status: run.status as RunLedgerStatus,
                startedAt: toIso(run.startedAt),
                createdAt: toIso(run.createdAt) ?? new Date(0).toISOString(),
                finishedAt: toIso(run.finishedAt),
                durationMs: run.durationMs ?? null,
                costCents: run.costCents ?? null,
                totalTokens: run.totalTokens ?? null,
                summary: run.summary ?? null,
                // Re-redacted at read time: an upstream provider error can
                // echo a credential, and this text leaves the platform.
                errorMessage: run.errorMessage
                    ? (buildCapturePreview(run.errorMessage, CAPTURE_MESSAGE_MAX_CHARS)?.preview ??
                      null)
                    : null,
                currentActivity: run.currentActivity ?? null,
                taskId: run.taskId ?? null,
                taskTitle: task?.title ?? null,
                missionId,
                missionTitle: missionId ? (labels.missions.get(missionId) ?? null) : null,
                workId: run.workId ?? null,
                workName: run.workId ? (labels.works.get(run.workId) ?? null) : null,
                scheduleKey: scheduleKeyForRun(run),
                awaitingInput: run.awaitingInput ?? false,
                queuedReason: run.queuedReason ?? null,
                attentionReason: run.attentionReason ?? null,
            };
        });
    }
}

/** `<epochMillis>_<uuid>` of the instant the ledger placed `run` at. */
export function ledgerCursorOf(run: Pick<AgentRun, 'id' | 'startedAt' | 'createdAt'>): string {
    const at = run.startedAt ?? run.createdAt;
    return `${new Date(at).getTime()}_${run.id}`;
}

/** Parse a ledger cursor; anything unparsable reads as "first page". */
export function parseLedgerCursor(cursor?: string | null): { at: Date; id: string } | undefined {
    if (!cursor) return undefined;
    const separator = cursor.indexOf('_');
    if (separator <= 0) return undefined;
    const ms = Number(cursor.slice(0, separator));
    const id = cursor.slice(separator + 1);
    if (!Number.isFinite(ms) || id.length === 0) return undefined;
    return { at: new Date(ms), id };
}

function clampLimit(limit?: number | null): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
        return RUN_LEDGER_DEFAULT_LIMIT;
    }
    return Math.min(Math.trunc(limit), RUN_LEDGER_MAX_LIMIT);
}

function toRange(window: RunLedgerWindow): { from: Date; to: Date } {
    return { from: new Date(window.from), to: new Date(window.to) };
}

function toQueryFilters(filters?: RunLedgerFilters): RunLedgerQueryFilters {
    if (!filters) return {};
    return {
        agentIds: filters.agentIds,
        triggerKinds: filters.triggerKinds,
        statuses: filters.statuses,
        workId: filters.workId,
        missionId: filters.missionId,
        search: filters.search,
    };
}

function hasActiveFilters(filters: RunLedgerQueryFilters): boolean {
    return Boolean(
        (filters.agentIds && filters.agentIds.length > 0) ||
        (filters.triggerKinds && filters.triggerKinds.length > 0) ||
        (filters.statuses && filters.statuses.length > 0) ||
        filters.workId ||
        filters.missionId ||
        filters.search?.trim(),
    );
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
