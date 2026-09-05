/**
 * Panic controls (EW-778) — thrown by the fleet run router and the
 * fleet-aware dispatcher when the GLOBAL STOP FLAG is set (or cannot be
 * read) and a run has nonetheless reached routing.
 *
 * A leaf file (no imports) so the dispatcher — which must stay a leaf on
 * the dispatch path — can recognise the error without importing the
 * router's DI graph. Recognised by `name` as well as by `instanceof`, the
 * same posture as `JobRuntimeNotConfiguredError`, so a copy that crossed
 * a module boundary still counts.
 *
 * Deliberately NOT a Nest HttpException: it surfaces on the run row as
 * `dispatch-failed: …` (the callers' existing loud-degradation path),
 * never as an HTTP status.
 */
export class FleetKillSwitchActiveError extends Error {
    readonly taskId: string | null;

    constructor(taskId?: string | null) {
        super(`Dispatch refused: the global stop flag is set${taskId ? ` (task ${taskId})` : ''}`);
        this.name = 'FleetKillSwitchActiveError';
        this.taskId = taskId ?? null;
    }
}

export function isFleetKillSwitchActiveError(error: unknown): error is FleetKillSwitchActiveError {
    return (
        error instanceof FleetKillSwitchActiveError ||
        (error instanceof Error && error.name === 'FleetKillSwitchActiveError')
    );
}
