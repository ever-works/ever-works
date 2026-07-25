/**
 * Pricing Wave 9 M2 — soft credits-enforcement precheck for the run
 * dispatch gate.
 *
 * Token + contract only (leaf file, zero imports — same circular-dep
 * dodge as the other agent injection tokens, see
 * `docs/architecture/agent-injection-tokens.md`).
 * `RunDispatchGateService` consumes it via `@Optional() @Inject(...)`;
 * the implementation (`RunCostSettlementService`, subscriptions/credits)
 * is bound to the token by the api-side `@Global()` SubscriptionsModule.
 * Unbound (unit tests, installs without the credits stack) the gate's
 * credits precheck simply never runs — and the env kill-switch
 * `CREDITS_ENFORCEMENT` (default OFF) keeps it dark even when bound.
 */
export interface RunCreditsPrecheck {
    /**
     * True ⇒ the user's plan is credit-limited AND the balance is
     * exhausted ⇒ the gate parks the run
     * (`queuedReason='insufficient-credits'`) instead of dispatching.
     * Implementations must be cheap and must never throw (callers
     * fail-open regardless).
     */
    shouldQueueForCredits(userId: string): Promise<boolean>;
}

export const RUN_CREDITS_PRECHECK = 'RUN_CREDITS_PRECHECK' as const;
