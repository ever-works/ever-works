/**
 * Schedules ("Cadence") — unified read-model types.
 *
 * A `ScheduleView` is a synthetic, read-only projection that unifies the
 * six heterogeneous scheduled sources in the platform into one row shape.
 * It is NOT a table — every field is derived on the fly from the owning
 * entity (Task / Agent / Work / Mission). See
 * `docs/specs/features/schedules/spec.md` §1.3.
 *
 * The projection is produced by `SchedulesService.getSchedules` and read
 * by the `GET /api/schedules` controller. It carries no secrets and no
 * cross-user data — every source query filters by the caller's `userId`
 * plus the active Organization scope.
 */

/** Which scheduling mechanism a row projects from (spec §1.3). */
export type ScheduleSourceType =
    | 'recurring_task'
    | 'agent_heartbeat'
    | 'work_schedule'
    | 'mission_tick'
    | 'source_validation'
    | 'data_sync'
    | 'inbound_trigger';

/**
 * The kind of entity that owns the schedule. `trigger` is used by
 * inbound-trigger rows with no target Agent; when a target Agent is
 * set the row reuses `agent` (and links to that Agent).
 */
export type ScheduleOwnerType = 'task' | 'agent' | 'work' | 'mission' | 'trigger';

/**
 * Normalized status label so the UI renders one pill vocabulary across
 * all six sources (spec §4.5). Each source's own status enum maps into
 * one of these.
 */
export type ScheduleStatus = 'active' | 'paused' | 'disabled' | 'error' | 'ended';

/**
 * One unified schedule row. `id` is a synthetic stable key
 * (`${sourceType}:${ownerId}`) — never a DB primary key.
 */
export interface ScheduleView {
    /** Synthetic stable key: `${sourceType}:${ownerId}`. */
    id: string;
    sourceType: ScheduleSourceType;
    ownerType: ScheduleOwnerType;
    /** Owning entity id (taskId | agentId | workId | missionId). */
    ownerId: string;
    /** Owning entity display name (task title / agent name / work name / mission title). */
    ownerName: string;
    /** Web dashboard route to the owning entity (locale-prefixed by the client). */
    ownerLink: string;
    /** Raw cadence (RRULE | cron | WorkScheduleCadence | interval token) or null. */
    cadenceRaw: string | null;
    /** Human-readable cadence ("Every day at 09:00", "Every 15 minutes"). */
    cadenceHuman: string;
    /** ISO 8601 next-run timestamp; computed for cron/RRULE sources. Null when not derivable. */
    nextRunAt: string | null;
    /** ISO 8601 last-run timestamp; null for sources that do not persist it (missions in P1). */
    lastRunAt: string | null;
    /** Last-run outcome label when the source tracks one (agent / work-schedule), else null. */
    lastRunStatus: string | null;
    /** Normalized status pill (spec §4.5). */
    status: ScheduleStatus;
    /** Whether this schedule is currently active/ticking. */
    enabled: boolean;
}

/** Optional server-side filters for the aggregation (all optional). */
export interface ScheduleQueryFilters {
    sourceType?: ScheduleSourceType;
    ownerType?: ScheduleOwnerType;
    /** Drop disabled/paused/ended rows when true. */
    enabledOnly?: boolean;
}

/** Scope the aggregation runs under — mirrors Tier A read conventions (spec §2.2). */
export interface ScheduleScope {
    userId: string;
    /** Active Organization id, or null for the bare-Tenant (personal) scope. */
    organizationId: string | null;
}
