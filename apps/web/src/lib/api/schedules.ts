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
    // Schedules workspace — additive fields (the API adds them; older
    // responses simply omit them, so every one is optional here).
    agentId?: string | null;
    agentName?: string | null;
    health?: ScheduleHealth;
    controls?: ScheduleControls;
    pausedAt?: string | null;
    nextRunReasonKey?: ScheduleNextRunReasonKey | null;
}

export type ScheduleNextRunReasonKey =
    | 'paused'
    | 'eventDriven'
    | 'ended'
    | 'beyondLookahead'
    | 'notScheduledYet'
    | 'ownerInactive';

export type ScheduleHealthReason =
    | 'impossible-date'
    | 'ended'
    | 'exhausted'
    | 'past-one-shot'
    | 'unparseable'
    | 'no-agent'
    | 'owner-archived';

export type ScheduleRepairClass = 'automatic' | 'choice' | 'none';

/** Translation key (under `dashboard.schedules.health.reasons`) per reason. */
export type ScheduleHealthReasonKey =
    | 'impossibleDate'
    | 'ended'
    | 'exhausted'
    | 'pastOneShot'
    | 'unparseable'
    | 'noAgent'
    | 'ownerArchived';

export interface ScheduleHealth {
    ok: boolean;
    reason: ScheduleHealthReason | null;
    reasonKey: ScheduleHealthReasonKey | null;
    repair: ScheduleRepairClass;
    checkedAt: string | null;
}

export type ScheduleControlName = 'runNow' | 'pause' | 'resume' | 'edit' | 'duplicate' | 'reassign';

export type ScheduleControlReasonKey =
    | 'eventDriven'
    | 'managedOnWork'
    | 'alreadyPaused'
    | 'notPaused'
    | 'ended'
    | 'ownerArchived'
    | 'ownerInactive'
    | 'noAgent'
    | 'noAuthoredForm'
    | 'notAvailableYet';

export interface ScheduleControls {
    runNow: boolean;
    pause: boolean;
    resume: boolean;
    edit: boolean;
    duplicate: boolean;
    reassign: boolean;
    pauseNeedsAcknowledgement: boolean;
    disabledReasons: Partial<Record<ScheduleControlName, ScheduleControlReasonKey>>;
}

/** `GET /api/schedules/page` — one page of the workspace list. */
export interface SchedulePage {
    items: ScheduleEntry[];
    nextCursor: string | null;
    total: number;
    unfilteredTotal: number;
    countsBySourceType: Record<ScheduleSourceType, number>;
    /**
     * Per-source counts taken BEFORE the filters. Optional because an API
     * replica that predates the field simply omits it — callers fall back to
     * `countsBySourceType` rather than crashing on `undefined`.
     */
    unfilteredCountsBySourceType?: Record<ScheduleSourceType, number>;
    countsByStatus: Record<ScheduleStatus, number>;
    healthCounts: { ok: number; neverRuns: number };
    degradedSources: ScheduleSourceType[];
    healthCheckedAt: string | null;
    generatedAt: string;
}

export interface GetSchedulePageParams extends GetSchedulesParams {
    cursor?: string | null;
    limit?: number;
    agentId?: string;
    status?: ScheduleStatus;
    health?: 'ok' | 'never-runs';
    q?: string;
}

export interface ScheduleHealthFlag {
    id: string;
    sourceType: ScheduleSourceType;
    ownerName: string;
    ownerLink: string;
    reason: ScheduleHealthReason;
    reasonKey: ScheduleHealthReasonKey;
    repair: ScheduleRepairClass;
    before: string | null;
    after: string | null;
    afterKey?: 'clearEndDate' | 'clearOccurrenceCap' | null;
    beforeHash: string | null;
}

/** `GET /api/schedules/health` — the side-effect-free NEVER RUNS summary. */
export interface ScheduleHealthSummary {
    checkedAt: string;
    counts: {
        ok: number;
        neverRuns: number;
        byReason: Partial<Record<ScheduleHealthReason, number>>;
    };
    flagged: ScheduleHealthFlag[];
    degradedSources: ScheduleSourceType[];
}

/** `POST /api/schedules/:id/run-now`. A Mission tick carries no run id. */
export type ScheduleRunNowResult =
    | {
          kind: 'run';
          scheduleId: string;
          runIds: string[];
          parked: boolean;
          queuedReason: string | null;
          taskId: string | null;
          nextRunAt: string | null;
      }
    | {
          kind: 'mission-tick';
          scheduleId: string;
          missionId: string;
          ownerLink: string;
          outcome: string;
          ideasCreated: number | null;
          ideasQueued: number | null;
      };

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

    getPage: async (params: GetSchedulePageParams = {}): Promise<SchedulePage> => {
        const searchParams = new URLSearchParams();
        if (params.sourceType) searchParams.set('sourceType', params.sourceType);
        if (params.entityKind) searchParams.set('entityKind', params.entityKind);
        if (params.enabledOnly) searchParams.set('enabledOnly', 'true');
        if (params.cursor) searchParams.set('cursor', params.cursor);
        if (params.limit) searchParams.set('limit', String(params.limit));
        if (params.agentId) searchParams.set('agentId', params.agentId);
        if (params.status) searchParams.set('status', params.status);
        if (params.health) searchParams.set('health', params.health);
        if (params.q) searchParams.set('q', params.q);
        const query = searchParams.toString();
        return serverFetch<SchedulePage>(`/schedules/page${query ? `?${query}` : ''}`);
    },

    getHealth: async (): Promise<ScheduleHealthSummary> =>
        serverFetch<ScheduleHealthSummary>('/schedules/health'),

    runNow: async (id: string): Promise<ScheduleRunNowResult> =>
        serverFetch<ScheduleRunNowResult>(`/schedules/${encodeURIComponent(id)}/run-now`, {
            method: 'POST',
        }),

    pause: async (id: string, acknowledgeMissionPause = false): Promise<ScheduleEntry> =>
        serverFetch<ScheduleEntry>(`/schedules/${encodeURIComponent(id)}/pause`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(acknowledgeMissionPause ? { acknowledgeMissionPause: true } : {}),
        }),

    resume: async (id: string): Promise<ScheduleEntry> =>
        serverFetch<ScheduleEntry>(`/schedules/${encodeURIComponent(id)}/resume`, {
            method: 'POST',
        }),
};
