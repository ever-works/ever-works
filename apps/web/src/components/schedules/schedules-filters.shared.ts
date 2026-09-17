import type {
    GetSchedulePageParams,
    ScheduleSourceType,
    ScheduleStatus,
} from '@/lib/api/schedules';

/**
 * Schedules workspace filter state — shared by the server page (which reads
 * the first page with the filters in the link) and the client shell (which
 * keeps them in the URL). Plain module, no `'use client'`, so both sides can
 * call it.
 */
export interface SchedulesFilterState {
    source: ScheduleSourceType | '';
    status: ScheduleStatus | '';
    health: 'ok' | 'never-runs' | '';
    agent: string;
    q: string;
}

export const EMPTY_SCHEDULE_FILTERS: SchedulesFilterState = {
    source: '',
    status: '',
    health: '',
    agent: '',
    q: '',
};

export const SCHEDULE_FILTER_SOURCES: readonly ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
];

export const SCHEDULE_FILTER_STATUSES: readonly ScheduleStatus[] = [
    'active',
    'paused',
    'disabled',
    'error',
    'ended',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasActiveFilters(filters: SchedulesFilterState): boolean {
    return Boolean(
        filters.source || filters.status || filters.health || filters.agent || filters.q,
    );
}

/**
 * Filters from a link. Anything that is not a known value is dropped rather
 * than sent, so a hand-edited URL can never turn into a 400 from the API.
 */
export function filtersFromSearchParams(params: URLSearchParams | null): SchedulesFilterState {
    const source = params?.get('source') ?? '';
    const status = params?.get('status') ?? '';
    const health = params?.get('health') ?? '';
    const agent = params?.get('agent') ?? '';
    return {
        source: (SCHEDULE_FILTER_SOURCES as readonly string[]).includes(source)
            ? (source as ScheduleSourceType)
            : '',
        status: (SCHEDULE_FILTER_STATUSES as readonly string[]).includes(status)
            ? (status as ScheduleStatus)
            : '',
        health: health === 'ok' || health === 'never-runs' ? health : '',
        agent: UUID.test(agent) ? agent : '',
        q: (params?.get('q') ?? '').slice(0, 120),
    };
}

export function pageParamsFor(filters: SchedulesFilterState): GetSchedulePageParams {
    const params: GetSchedulePageParams = {};
    if (filters.source) params.sourceType = filters.source;
    if (filters.status) params.status = filters.status;
    if (filters.health) params.health = filters.health;
    if (filters.agent) params.agentId = filters.agent;
    if (filters.q) params.q = filters.q;
    return params;
}
