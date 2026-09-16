import type { FleetDelegationScopeRefusalCode } from './fleet-delegation-scope';

/**
 * Agent execution v2 — a fleet run that cannot be planned, and (G9) a fleet
 * run refused because its delegation scope cannot be enforced or verified.
 *
 * A leaf file (one type-only import) for the same reason as
 * `fleet-kill-switch.error.ts`: the fleet-aware dispatcher and the fleet run
 * router both have to THROW the delegation-scope refusal, and neither may
 * import the planner's DI graph to do it. Both classes are re-exported from
 * `fleet-agent-task-planner.service.ts`, so every existing import keeps
 * working.
 *
 * Deliberately NOT Nest HttpExceptions: they surface on the run row through
 * the callers' existing loud-degradation path (`dispatch-failed: …` from the
 * transition service, the dispatch-gate drain and resume; `enqueue-failed: …`
 * from `POST /agents/:id/assign-task`), never as a status chosen here.
 */
export class FleetAgentTaskPlanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FleetAgentTaskPlanError';
    }
}

/**
 * Judgment layer G9 on the fleet — a delegated run the fleet refuses because
 * it cannot enforce (or cannot verify) the run's delegation scope. See
 * `FleetAgentTaskPlannerService.refuseUnenforceableDelegationScope`.
 *
 * A PLAN error by inheritance, so it is recorded exactly like any other
 * planning refusal (the dispatcher lets it propagate; the enqueue sites
 * record its message on the run row). Its own `name` and machine `code` keep
 * it distinguishable in logs and on the run row; neither is the kill switch's
 * error name, so the dispatch-gate drain never mistakes it for a stop to
 * re-park.
 */
export class FleetDelegationScopeRefusedError extends FleetAgentTaskPlanError {
    constructor(
        readonly code: FleetDelegationScopeRefusalCode,
        message: string,
    ) {
        super(`${code}: ${message}`);
        this.name = 'FleetDelegationScopeRefusedError';
    }
}
