/**
 * Schedules — machine codes carried in the body of a refused control.
 *
 * Kept in their own dependency-free file so both the owning domain services
 * (Tasks, Agents) and the Schedules control service can throw the same code
 * without importing each other. The web client maps each code to a
 * translated sentence; the code itself is never shown.
 */

/** A fire of this Schedule is still queued or running. */
export const SCHEDULE_ALREADY_RUNNING = 'SCHEDULE_ALREADY_RUNNING' as const;

/** No Agent can be resolved to execute the Schedule. */
export const SCHEDULE_NO_AGENT = 'SCHEDULE_NO_AGENT' as const;

/** The Agent (or other owner) that would run the Schedule is archived. */
export const SCHEDULE_OWNER_ARCHIVED = 'SCHEDULE_OWNER_ARCHIVED' as const;

/** The credit balance cannot cover the run — it was parked, not started. */
export const SCHEDULE_CREDITS_EXHAUSTED = 'SCHEDULE_CREDITS_EXHAUSTED' as const;

/**
 * Pausing a Mission tick pauses the whole Mission, so the caller must say
 * explicitly that they understand that before anything is written.
 */
export const MISSION_PAUSE_NOT_ACKNOWLEDGED = 'MISSION_PAUSE_NOT_ACKNOWLEDGED' as const;

/**
 * The control does not apply to this row (for example run-now on an inbound
 * Trigger, which fires on an external event). The body carries the same
 * `reasonKey` the row's control descriptor already declared.
 */
export const SCHEDULE_CONTROL_UNAVAILABLE = 'SCHEDULE_CONTROL_UNAVAILABLE' as const;

/** The addressed Task is not a recurring template. */
export const SCHEDULE_NOT_RECURRING = 'SCHEDULE_NOT_RECURRING' as const;

export type ScheduleControlCode =
    | typeof SCHEDULE_ALREADY_RUNNING
    | typeof SCHEDULE_NO_AGENT
    | typeof SCHEDULE_OWNER_ARCHIVED
    | typeof SCHEDULE_CREDITS_EXHAUSTED
    | typeof MISSION_PAUSE_NOT_ACKNOWLEDGED
    | typeof SCHEDULE_CONTROL_UNAVAILABLE
    | typeof SCHEDULE_NOT_RECURRING;
