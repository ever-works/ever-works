/**
 * Plan-driven concurrency ceiling for the run dispatch gate (H2).
 *
 * Token + contract only (leaf file, zero imports — same circular-dep
 * dodge as the other agent injection tokens, see
 * `docs/architecture/agent-injection-tokens.md`).
 * `RunDispatchGateService` consumes it via `@Optional() @Inject(...)`;
 * the implementation (`PlanRunLimitsService`, subscriptions/credits) is
 * bound to the token by the api-side `@Global()` SubscriptionsModule.
 *
 * ## Why this seam exists at all
 *
 * The gate already had two concurrency valves, but both are plan-blind
 * operator knobs (`AGENT_MAX_CONCURRENT_RUNS_PER_WORK` / `_PER_ORG`).
 * The number the pricing page SELLS — "10 concurrent agent sessions" —
 * lived in `plan_entitlements` under `max-concurrent-runs` and was read
 * by nothing: the entitlement was decorative, and every tier got the
 * same env-wide ceiling.
 *
 * ## Why per USER and not per organization
 *
 * Subscriptions are user-scoped in this schema: `user_subscriptions`
 * hangs off `userId`, `organizationId` is a nullable annotation, and
 * `Organization` carries no plan at all. The entity that buys a plan is
 * therefore the user, and neither existing valve has that scope.
 *
 * ## Contract
 *
 * Implementations must be cheap (this is called once per dispatch, on a
 * one-minute cron loop) and must never throw — the middleware fails
 * OPEN regardless, because a billing lookup that parks every run would
 * be a self-sustaining outage: parked heartbeat runs carry no taskId
 * and can never be drained.
 */
export interface RunPlanLimits {
    /**
     * The user's plan concurrency ceiling.
     *
     * `<= 0` means UNLIMITED, matching the contract the two env valves
     * already publish (a limit of 0 disables that valve and skips its
     * count query entirely). Return `null` when no plan-level ceiling
     * applies, which is also treated as unlimited.
     */
    resolveConcurrencyLimit(userId: string): Promise<number | null>;
}

export const RUN_PLAN_LIMITS = 'RUN_PLAN_LIMITS' as const;
