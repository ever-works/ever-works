import 'server-only';
import { serverFetch } from './server-api';

/** Which scheduling mechanism a row projects from (mirrors the API contract). */
export type ScheduleSourceType =
    | 'recurring_task'
    | 'agent_heartbeat'
    | 'work_schedule'
    | 'mission_tick'
    | 'source_validation'
    | 'data_sync'
    | 'inbound_trigger';

export type ScheduleOwnerType = 'task' | 'agent' | 'work' | 'mission' | 'trigger';

export type ScheduleStatus = 'active' | 'paused' | 'disabled' | 'error' | 'ended';

/**
 * One unified schedule row returned by `GET /api/schedules`. Mirrors the
 * agent-side `ScheduleView` (kept as a local interface, matching the
 * `ActivityLogEntry` convention in `lib/api/activity-log.ts`).
 */
export interface ScheduleEntry {
    id: string;
    sourceType: ScheduleSourceType;
    ownerType: ScheduleOwnerType;
    ownerId: string;
    ownerName: string;
    ownerLink: string;
    cadenceRaw: string | null;
    cadenceHuman: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    status: ScheduleStatus;
    enabled: boolean;
}

export interface GetSchedulesParams {
    sourceType?: ScheduleSourceType;
    entityKind?: ScheduleOwnerType;
    enabledOnly?: boolean;
}

export const schedulesAPI = {
    getAll: async (params?: GetSchedulesParams): Promise<ScheduleEntry[]> => {
        const searchParams = new URLSearchParams();
        if (params?.sourceType) searchParams.set('sourceType', params.sourceType);
        if (params?.entityKind) searchParams.set('entityKind', params.entityKind);
        if (params?.enabledOnly) searchParams.set('enabledOnly', 'true');
        const query = searchParams.toString();
        return serverFetch<ScheduleEntry[]>(`/schedules${query ? `?${query}` : ''}`);
    },
};
