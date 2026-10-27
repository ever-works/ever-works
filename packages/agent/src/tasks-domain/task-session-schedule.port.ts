import type { Task } from '../entities/task.entity';

/**
 * Schedules on computers (FL-13 P2, spec FR-8, CONTRACTS R-29) — an
 * Agent-session schedule is a recurring Task whose Agent is pinned to a
 * computer; every fire must run as an Agent SESSION on that computer (visible
 * on its Sessions tab), not as a background run. The recurrence dispatcher is
 * the existing one (no second scheduler); only the last step — how one fire
 * of such a Task is started — is handed to the Fleet through this port.
 *
 * Which Tasks: those created by the Schedules dialog, marked with the label
 * {@link FLEET_SESSION_SCHEDULE_LABEL} (copied to every instance by the
 * recurrence clone), plus the agent CLI and the checkout the session works
 * in (`fleet:provider:<p>`, `fleet:checkout:<uuid>`). R-29 rules out a
 * per-Task node column, and labels are the Task's existing free-form facts
 * (lane-log decision 19).
 *
 * Bound by the API (`FleetSessionScheduleDispatcher`) and injected
 * `@Optional()` into `TaskTransitionService`: unbound (the worker, a test, a
 * deployment without Fleet), such a Task dispatches like any other Task.
 */

/** The label every Agent-session schedule's template (and so each instance) carries. */
export const FLEET_SESSION_SCHEDULE_LABEL = 'fleet:session-schedule';

const PROVIDER_PREFIX = 'fleet:provider:';
const CHECKOUT_PREFIX = 'fleet:checkout:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFleetSessionScheduleTask(task: Pick<Task, 'labels'> | null | undefined): boolean {
    return Array.isArray(task?.labels) && task.labels.includes(FLEET_SESSION_SCHEDULE_LABEL);
}

/** The session facts an Agent-session schedule's labels carry. */
export function readFleetSessionScheduleLabels(labels: readonly string[] | null | undefined): {
    provider: 'claude-code' | 'codex';
    checkoutId: string | null;
} {
    let provider: 'claude-code' | 'codex' = 'claude-code';
    let checkoutId: string | null = null;
    for (const label of labels ?? []) {
        if (label.startsWith(PROVIDER_PREFIX)) {
            const value = label.slice(PROVIDER_PREFIX.length);
            if (value === 'codex' || value === 'claude-code') provider = value;
        } else if (label.startsWith(CHECKOUT_PREFIX)) {
            const value = label.slice(CHECKOUT_PREFIX.length);
            if (UUID.test(value)) checkoutId = value.toLowerCase();
        }
    }
    return { provider, checkoutId };
}

/** The labels a new Agent-session schedule's Task is created with. */
export function fleetSessionScheduleLabels(input: {
    provider: 'claude-code' | 'codex';
    checkoutId?: string | null;
}): string[] {
    const labels = [FLEET_SESSION_SCHEDULE_LABEL, `${PROVIDER_PREFIX}${input.provider}`];
    if (input.checkoutId && UUID.test(input.checkoutId))
        labels.push(`${CHECKOUT_PREFIX}${input.checkoutId.toLowerCase()}`);
    return labels;
}

/** What starting one fire answers — `TaskTransitionService.dispatchAgentRun`'s own shape. */
export interface TaskSessionScheduleDispatchResult {
    runId: string | null;
    dispatched: boolean;
    parked: boolean;
    queuedReason?: string;
    error?: string;
}

export interface TaskSessionScheduleDispatcher {
    /** Start one fire of `task` (an instance of an Agent-session schedule) as an Agent session of `agentId`. */
    dispatch(task: Task, agentId: string): Promise<TaskSessionScheduleDispatchResult>;
}

export const TASK_SESSION_SCHEDULE_DISPATCHER = 'TASK_SESSION_SCHEDULE_DISPATCHER' as const;
