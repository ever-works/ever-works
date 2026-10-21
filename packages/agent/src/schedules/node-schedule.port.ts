import type { FleetScheduleView } from '@ever-works/contracts';

/**
 * Schedules on computers (FL-13, R-2) — how the unified Schedules view reads
 * and controls its eighth source, `node_schedule`, without importing the
 * Fleet module graph (the read model stays importable on its own by Home and
 * the Activity tab).
 *
 * Bound by the API's global Fleet schedules module to
 * `FleetScheduleService` (`@Optional()` everywhere it is read): unbound — the
 * worker, a test, a deployment without Fleet — the source contributes no
 * rows and its controls answer 503, exactly like any other missing domain
 * service.
 */
export interface NodeScheduleSource {
    /** The person's Command schedules (not deleted), optionally on one computer. */
    listForUser(actor: { userId: string }, options?: { nodeId?: string }): Promise<FleetScheduleView[]>;
}

export interface NodeScheduleControl {
    /** Run now (class `confirm`: without `confirm` it answers `confirmation_required`). */
    runNow(
        id: string,
        actor: { userId: string },
        confirm: boolean,
    ): Promise<{ runId: string; startedAt: string; nextRunAt: string | null }>;
    pause(id: string, actor: { userId: string }): Promise<unknown>;
    resume(id: string, actor: { userId: string }): Promise<unknown>;
}

export type NodeSchedulePort = NodeScheduleSource & NodeScheduleControl;

export const NODE_SCHEDULE_PORT = 'NODE_SCHEDULE_PORT' as const;
