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

    // ── Schedules workspace additions. Every field below is OPTIONAL and is
    // served only by the workspace reads: `GET /api/schedules/page`,
    // `/health`, `findOne`, and the pause/resume responses.
    //
    // The flat `GET /api/schedules` stays at the thirteen keys above, and that
    // is enforced by `narrowScheduleView` in `schedules.service.ts` rather
    // than left to whoever adds the next field. An earlier version of this
    // comment reasoned that adding keys kept the flat list wire-compatible
    // because nothing was removed. That is true of the array shape and false
    // of the row: `health.checkedAt` is computed per request, so the flat read
    // stopped being a pure projection of stored state and began differing
    // between two GETs with no write in between.

    /** Agent that would run this Schedule, or null when the source has none. */
    agentId?: string | null;
    /** Display name of {@link agentId}, when it resolved. */
    agentName?: string | null;
    /** OK / NEVER RUNS verdict, computed at read time. */
    health?: ScheduleHealth;
    /** Which of the six row controls apply, with a reason for each that does not. */
    controls?: ScheduleControls;
    /**
     * ISO instant the Schedule was paused through a pause that preserves the
     * cadence (recurring Task, heartbeat), else null. Sources whose pause is
     * their own status (Mission, inbound Trigger, Work schedule) report it
     * through `status` only.
     */
    pausedAt?: string | null;
    /**
     * One-line explanation when {@link nextRunAt} is null for a reason the
     * surface should say out loud. A translation key under
     * `dashboard.schedules.nextReasons`, never a sentence.
     */
    nextRunReasonKey?: ScheduleNextRunReasonKey | null;
}

/** Why a row has no next fire — see {@link ScheduleView.nextRunReasonKey}. */
export type ScheduleNextRunReasonKey =
    | 'paused'
    | 'eventDriven'
    | 'ended'
    | 'beyondLookahead'
    | 'notScheduledYet'
    | 'ownerInactive';

/** The closed set of NEVER RUNS reasons. */
export type ScheduleHealthReason =
    | 'impossible-date'
    | 'ended'
    | 'exhausted'
    | 'past-one-shot'
    | 'unparseable'
    | 'no-agent'
    | 'owner-archived';

/** How a NEVER RUNS reason can be repaired. */
export type ScheduleRepairClass = 'automatic' | 'choice' | 'none';

export interface ScheduleHealth {
    ok: boolean;
    reason: ScheduleHealthReason | null;
    /** Translation key under `dashboard.schedules.health.reasons`, or null when OK. */
    reasonKey: string | null;
    repair: ScheduleRepairClass;
    /** ISO instant the verdict was computed. */
    checkedAt: string | null;
}

/** The six row controls, in menu order. */
export type ScheduleControlName = 'runNow' | 'pause' | 'resume' | 'edit' | 'duplicate' | 'reassign';

/**
 * Translation keys (under `dashboard.schedules.controlReasons`) explaining
 * why a control is disabled on a row.
 */
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
    /** Pausing this row pauses its whole owner (a Mission tick) — ask first. */
    pauseNeedsAcknowledgement: boolean;
    /** Per-control reason key when that control is false. */
    disabledReasons: Partial<Record<ScheduleControlName, ScheduleControlReasonKey>>;
}

/** A proposed repair — shown before anything is written. */
export interface ScheduleRepairProposal {
    repair: ScheduleRepairClass;
    /** The value a repair would replace (a cadence, an ISO instant, a cap). */
    before: string | null;
    /** The value a repair would write; null for `choice` / `none` repairs. */
    after: string | null;
    /**
     * When the repair REMOVES a value rather than rewriting one (clear the
     * end date, clear the occurrence cap), a translation key under
     * `dashboard.schedules.health.repairs` describing it instead of `after`.
     */
    afterKey?: 'clearEndDate' | 'clearOccurrenceCap' | null;
    /** Stable hash of the before-state, echoed back when a repair is applied. */
    beforeHash: string | null;
}

/** Page filters for `GET /api/schedules/page` (all optional). */
export interface SchedulePageFilters extends ScheduleQueryFilters {
    agentId?: string;
    status?: ScheduleStatus;
    health?: 'ok' | 'never-runs';
    /** Case-insensitive match against the Schedule name, cadence and Agent. */
    q?: string;
}

/** One page of the workspace Schedules list. */
export interface SchedulePage {
    items: ScheduleView[];
    /** Opaque cursor for the next page, or null on the last page. */
    nextCursor: string | null;
    /** Rows matching the filters, across every page. */
    total: number;
    /** Rows before any filter — lets the surface say "you have N in total". */
    unfilteredTotal: number;
    /** Per-source counts WITHIN the current filters. */
    countsBySourceType: Record<ScheduleSourceType, number>;
    /**
     * Per-source counts BEFORE any filter — the breakdown a source picker
     * offers, which `countsBySourceType` cannot answer: that one is taken
     * after `sourceType` itself has been applied, so every other source reads
     * 0 as soon as one is selected and the picker collapses to a single
     * usable entry.
     */
    unfilteredCountsBySourceType: Record<ScheduleSourceType, number>;
    countsByStatus: Record<ScheduleStatus, number>;
    healthCounts: { ok: number; neverRuns: number };
    /** Sources whose query failed; their rows are missing from this page. */
    degradedSources: ScheduleSourceType[];
    /** ISO instant health was computed for this page. */
    healthCheckedAt: string | null;
    /** Server clock, so countdowns do not trust the browser's. */
    generatedAt: string;
}

/** One flagged row in the health summary. */
export interface ScheduleHealthFlag extends ScheduleRepairProposal {
    id: string;
    sourceType: ScheduleSourceType;
    ownerName: string;
    ownerLink: string;
    reason: ScheduleHealthReason;
    reasonKey: string;
}

/** `GET /api/schedules/health` — a side-effect-free dry run. */
export interface ScheduleHealthSummary {
    checkedAt: string;
    counts: {
        ok: number;
        neverRuns: number;
        byReason: Partial<Record<ScheduleHealthReason, number>>;
    };
    /** Capped at {@link SCHEDULE_HEALTH_FLAG_CAP} rows. */
    flagged: ScheduleHealthFlag[];
    degradedSources: ScheduleSourceType[];
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
