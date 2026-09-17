/**
 * AW-23 — the AGENT BRAKE port for the run dispatch gate.
 *
 * Token + contract only (leaf file, zero imports — same circular-dep
 * dodge as `run-kill-switch.ts` and `run-credits-precheck.ts`, see
 * `docs/architecture/agent-injection-tokens.md`).
 * `RunDispatchGateService` consumes it via `@Optional() @Inject(...)`;
 * the implementation (`AgentBrakeService`) is bound to the token by the
 * agent-side AgentsModule.
 *
 * Why this exists: until now `Pause` bound on exactly ONE dispatch path —
 * the heartbeat claim. Assigning a task to a paused agent ran it. So did
 * an `@mention` chat reply, and so did delegation from a parent agent.
 * The product's most reassuring control did not do what its label said.
 * Putting the check HERE, in the one admission point every dispatch path
 * already crosses, is what makes the pause total without a check at each
 * call site — and makes every future dispatch path inherit it.
 *
 * Unbound (unit tests, installs without the agent repository) the brake
 * middleware simply passes every run through, exactly like
 * `RUN_KILL_SWITCH`.
 *
 * 🛑 FAIL-CLOSED at the consumer: the middleware parks the run when
 * `shouldHaltForAgent()` resolves `halted` AND when it throws. A brake
 * that fails open is not a brake. Implementations should still never
 * throw — `AgentBrakeService` folds a read failure into `halted: true`
 * itself — but the gate does not depend on that.
 */

export interface AgentBrakeVerdict {
    /** True ⇒ the Agent is stopped (or unreadable) ⇒ park the run. */
    halted: boolean;
    /**
     * `user | credential | failures | cap | platform` — the Agent's stored
     * halt reason, for the run-log line only. Never rendered as the park
     * reason: parked work always reads "the agent is paused".
     */
    reason?: string;
}

export interface RunAgentBrake {
    /** Fail-CLOSED at the consumer: a throw parks the run. */
    shouldHaltForAgent(agentId: string): Promise<AgentBrakeVerdict>;
}

export const RUN_AGENT_BRAKE = 'RUN_AGENT_BRAKE' as const;

/**
 * `Error.name` carried by the api-side `AgentPausedError` (the class
 * lives in `apps/api`, which this package cannot import). Pinned on both
 * sides by spec so a synchronous, user-initiated dispatch can be refused
 * with a named 409 instead of an opaque failure.
 */
export const AGENT_PAUSED_ERROR_NAME = 'AgentPausedError' as const;
