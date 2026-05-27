/**
 * EW-657 (Tenants & Organizations Phase 5b) — shape of the
 * request-scoped scope that propagates through every code path that
 * touches Tier C entities.
 *
 * Both fields are nullable:
 *   - `tenantId` is NULL for requests with no authenticated user, and
 *     for users who have not yet been lazy-upgraded to a Tenant
 *     (Phase 6 lands the upgrade flow; until then every existing user
 *     still has `users.tenantId IS NULL`).
 *   - `organizationId` is NULL for the bare-Tenant scope (the
 *     "personal" surface) and for any request that hasn't passed
 *     through Phase 7's slug-resolver middleware (which sets it from
 *     `:slug`).
 *
 * Today both will almost always be NULL in production — the
 * `organizations` table is brand new (Phase 1) and empty. The plumbing
 * is here so that once Tenant/Org rows start existing in Phase 6, the
 * service-layer code is already correctly threading them through.
 */
export interface ScopeContext {
    readonly tenantId: string | null;
    readonly organizationId: string | null;
}

export const EMPTY_SCOPE: ScopeContext = {
    tenantId: null,
    organizationId: null,
};
