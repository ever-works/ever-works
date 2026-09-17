/**
 * Safety rails (AW-24) — the ONE question every side-effectful action asks.
 *
 * Token + contract only (leaf file, ZERO imports — the same circular-dep
 * dodge as `agents/run-kill-switch.ts`, `policy/tool-grant.enforcer.ts` and
 * `policy/merge-policy.enforcer.ts`; see
 * `docs/architecture/agent-injection-tokens.md`). `AgentRunService` consumes
 * it via `@Optional() @Inject(SAFETY_GATE)`; `SafetyModule` binds it to
 * `SafetyGateService`.
 *
 * ## Why a port and not a Nest guard
 *
 * Guards run on HTTP requests. Most of the actions this gate protects are not
 * HTTP requests — they are tool calls inside a worker process, cron fires and
 * lease responses. A plain injected service consumed through a leaf token
 * lets the worker, the API and the unit tests each bind it, or not, and stay
 * independent.
 *
 * ## The fail posture
 *
 * **Unbound in a unit test ⇒ pass-through.** Every existing constructor call
 * that omits it keeps working and behaves exactly as it did before this epic
 * landed. That is the whole reason the injection is `@Optional()`.
 *
 * **Unbound in a runtime that declares it needs it ⇒ a boot assertion**, not a
 * silent pass. A rail that quietly disappears because of a DI mistake is
 * worse than no rail at all, because the product would still be claiming it.
 * The api-side module that binds this token is what asserts it.
 *
 * **Bound and failing ⇒ fail closed on the stops and the caps, fail open on
 * the delegating rails.** Each rail states its own posture in its own file;
 * `evaluate()` itself never throws.
 */

/** What the caller knows about the action, with nothing the model can write. */
export interface SafetyGateInput {
    /** The platform's id for this action's entry point. */
    entryPointId: string;
    /** The registered tool name, when the entry point is a tool call. */
    toolName?: string | null;
    userId: string;
    agentId?: string | null;
    runId?: string | null;
    /** `run` | `agent` | `mission` | `task` | `schedule` | `trigger`. */
    subjectType?: string | null;
    subjectId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
    /**
     * The plugin exposing this tool, and that plugin's own manifest
     * declaration of tool-pattern → category. Core holds no plugin id.
     */
    pluginId?: string | null;
    manifestCategories?: Readonly<Record<string, string>> | null;
    /**
     * An observation that an instruction, skill body, memory fact or document
     * asserted a permission the ladder does not grant. It changes only the
     * REASON CODE that is recorded — never the decision, which is taken from
     * the persisted rung alone (FR-15, FR-17).
     */
    widenAttemptObserved?: boolean;
}

/** The gate's answer. Structurally `SafetyVerdict` from the contracts package. */
export interface SafetyGateVerdict {
    decision: 'allow' | 'refused' | 'held';
    railId: string | null;
    category: string | null;
    rung: string | null;
    reasonCode: string | null;
    summary: string | null;
    safeMode?: boolean;
    unclassified?: boolean;
    proposalId?: string | null;
}

export interface SafetyGate {
    /**
     * Evaluate every rail, in the published order, and record whatever the
     * verdict was. Never throws for policy reasons: a refusal is a verdict.
     */
    evaluate(input: SafetyGateInput): Promise<SafetyGateVerdict>;
}

export const SAFETY_GATE = 'SAFETY_GATE' as const;
