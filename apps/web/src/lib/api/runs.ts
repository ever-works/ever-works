import 'server-only';
import type {
    RunCalendarMonth,
    RunLedgerFilters,
    RunLedgerGranularity,
    RunLedgerPage,
    RunReceipt,
    RunWindowStats,
} from '@ever-works/contracts';
import { serverFetch } from './server-api';

/**
 * Runs ledger + run receipt (AW-09) — server-side client for `GET /api/runs*`.
 *
 * `serverFetch` forwards the session and the selected workspace scope, so
 * every read is the caller's own runs in the active Organization; nothing
 * here can name another user or Organization.
 */

export interface RunsWindowQuery {
    granularity?: RunLedgerGranularity;
    /** `YYYY-MM-DD` anchor in `timezone`. */
    date?: string;
    timezone?: string;
    filters?: RunLedgerFilters;
}

export interface RunsListQuery extends RunsWindowQuery {
    limit?: number;
    cursor?: string;
}

/** Build the query string for the shared window + filter fields. */
export function runsWindowParams(query: RunsWindowQuery): URLSearchParams {
    const params = new URLSearchParams();
    if (query.granularity) params.set('granularity', query.granularity);
    if (query.date) params.set('date', query.date);
    if (query.timezone) params.set('timezone', query.timezone);
    const filters = query.filters ?? {};
    for (const id of filters.agentIds ?? []) params.append('agentId', id);
    for (const kind of filters.triggerKinds ?? []) params.append('kind', kind);
    for (const status of filters.statuses ?? []) params.append('status', status);
    if (filters.workId) params.set('workId', filters.workId);
    if (filters.missionId) params.set('missionId', filters.missionId);
    if (filters.search) params.set('q', filters.search);
    return params;
}

function withQuery(path: string, params: URLSearchParams): string {
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
}

export const runsAPI = {
    list: async (query: RunsListQuery = {}): Promise<RunLedgerPage> => {
        const params = runsWindowParams(query);
        if (query.limit != null) params.set('limit', String(query.limit));
        if (query.cursor) params.set('cursor', query.cursor);
        return serverFetch<RunLedgerPage>(withQuery('/runs', params), { method: 'GET' });
    },

    stats: async (query: RunsWindowQuery = {}): Promise<RunWindowStats> => {
        return serverFetch<RunWindowStats>(withQuery('/runs/stats', runsWindowParams(query)), {
            method: 'GET',
        });
    },

    calendar: async (month: string, query: RunsWindowQuery = {}): Promise<RunCalendarMonth> => {
        const params = runsWindowParams({ timezone: query.timezone, filters: query.filters });
        params.set('month', month);
        return serverFetch<RunCalendarMonth>(withQuery('/runs/calendar', params), {
            method: 'GET',
        });
    },

    receipt: async (runId: string): Promise<RunReceipt> => {
        return serverFetch<RunReceipt>(`/runs/${encodeURIComponent(runId)}/receipt`, {
            method: 'GET',
        });
    },
};
