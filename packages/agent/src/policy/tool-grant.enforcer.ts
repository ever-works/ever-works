import type { ResolvedToolGrants, ToolGrantDecision } from '@ever-works/contracts';

/**
 * Tool-grant matrix (audit item G4) — injection token + contract for the
 * enforcement half.
 *
 * Token + contract only (leaf file, type-only imports — the same
 * circular-dep dodge as `MERGE_POLICY_ENFORCER` and the other agent
 * injection tokens, see `docs/architecture/agent-injection-tokens.md`).
 * `AgentRunService` and `SkillsService` consume it via
 * `@Optional() @Inject(...)`; `PolicyModule` binds it to
 * `ToolGrantService`.
 *
 * **Left unbound** — unit tests, the worker, any runtime without the
 * policy module — every consumer behaves exactly as it did before this
 * feature landed. That is deliberate: an access matrix that fails CLOSED
 * when its own wiring is missing would take the whole product down on a
 * DI mistake, and the safe default here is the permissive platform default
 * (which is what the resolver returns anyway when there are no rows).
 */

/** Where a resolution starts. Any subset; more specific ids win. */
export interface ToolGrantResolveInput {
    agentId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
    /** Owner of the grant rows. Required — grants are user-scoped. */
    userId: string;
}

export interface ToolGrantEnforcer {
    /** Resolve the effective matrix + the chain that explains it. */
    resolve(input: ToolGrantResolveInput): Promise<ResolvedToolGrants>;
    /**
     * The single decision point: may THIS tool be called in THIS scope?
     * Implementations must never throw for policy reasons — a refusal is
     * `{ allowed: false, code, reason }`.
     */
    decide(input: ToolGrantResolveInput, toolName: string): Promise<ToolGrantDecision>;
}

export const TOOL_GRANT_ENFORCER = 'TOOL_GRANT_ENFORCER' as const;
