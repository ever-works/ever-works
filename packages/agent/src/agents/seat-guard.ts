/**
 * Seats (billing spec §3.6 / FR-28) — the admission check a seat-consuming
 * write asks before it commits.
 *
 * Token + contract only (leaf file, zero imports — same circular-dep dodge
 * as the other agent injection tokens, see
 * `docs/architecture/agent-injection-tokens.md`). `AgentsService` consumes
 * it via `@Optional() @Inject(...)`; the implementation (`SeatsService`,
 * subscriptions/billing) is bound to the token by the api-side `@Global()`
 * SubscriptionsModule.
 *
 * Unbound — unit tests, or an install without the billing stack — agent
 * creation is simply never seat-checked, which is the same fail-open
 * posture as the credits precheck. `SeatsService.assertSeatAvailable` is
 * additionally a no-op whenever `SUBSCRIPTIONS_ENABLED` is off.
 */
export interface SeatGuard {
    /**
     * The billing owner a write by `userId` is charged to (the Tenant
     * owner, or `userId` itself on a solo account). Must never throw.
     */
    resolveBillingOwner(userId: string): Promise<string>;

    /**
     * Throws `SeatLimitExceededError` (mapped to 402 at the API boundary)
     * when the owner has no seat left. Fail-open on every other axis: a
     * billing lookup must never be the reason a write is refused.
     */
    assertSeatAvailable(ownerUserId: string, count?: number): Promise<void>;
}

export const SEAT_GUARD = 'SEAT_GUARD' as const;
