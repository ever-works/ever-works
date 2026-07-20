/**
 * PR-4 (domain-model evolution) — Idea → Work build executor dispatch
 * contract.
 *
 * Keeps the `@ever-works/agent` package free of a runtime
 * `@trigger.dev/sdk` dependency (mirrors the Tasks-feature
 * `AgentTaskExecuteDispatcher` seam). The platform's Trigger.dev
 * wrapper (`packages/tasks`) supplies the real adapter that fans a
 * freshly-created `WorkBuildRequest` out to the `idea-build-execute`
 * task; unit tests / CLI leave the token unbound.
 *
 * Consumers inject this with `@Optional() @Inject(...)`. When the
 * adapter isn't bound (test, CLI, or the feature flag is off and the
 * platform module never registered it) the enqueue becomes a no-op and
 * the surrounding request continues exactly as it does today — the
 * Goal is still created and the Idea still flips to QUEUED, nothing
 * executes.
 */
export interface IdeaBuildExecuteDispatchPayload {
    /** The freshly-created `WorkBuildRequest` to execute. */
    goalId: string;
    /** Owner scope — every DB access in the executor is scoped to this. */
    userId: string;
    /** The Idea (`WorkProposal`) the Goal is building. */
    ideaId: string;
}

export interface IdeaBuildExecuteDispatcher {
    enqueue(payload: IdeaBuildExecuteDispatchPayload): Promise<{ handleId: string | null }>;
}

export const IDEA_BUILD_EXECUTE_DISPATCHER = 'IDEA_BUILD_EXECUTE_DISPATCHER' as const;
