export interface AuthTokenPayload {
    sub: string;
    // EW-617 G2: anonymous (zero-friction) users have a null email until
    // they claim the account via POST /api/auth/claim.
    email: string | null;
    provider: string;
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    /** @deprecated L-01: Ever Works uses opaque bearer tokens, not JWTs.
     *  This field is fabricated by `AuthSessionGuard` at request time and
     *  signs nothing. Remove in a follow-up after consumers (the
     *  `result.iat` assertion in auth-provider.service.spec.ts) are
     *  migrated. */
    iat: number;
    /** @deprecated L-01: see `iat` above — fake JWT claim, no semantic meaning. */
    iss: string;
    /** @deprecated L-01: see `iat` above — fake JWT claim, no semantic meaning. */
    aud: string;
    // EW-617 G2: set to `true` for anonymous JWTs.
    isAnonymous?: boolean;
}

export interface AuthenticatedUser {
    userId: string;
    email: string | null;
    username: string;
    provider: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    /** @deprecated L-01: Ever Works uses opaque bearer tokens, not JWTs.
     *  This field is fabricated by `AuthSessionGuard` at request time and
     *  signs nothing. Remove in a follow-up after consumers are migrated. */
    iat: number;
    /** @deprecated L-01: see `iat` above — fake JWT claim, no semantic meaning. */
    iss: string;
    /** @deprecated L-01: see `iat` above — fake JWT claim, no semantic meaning. */
    aud: string;
    // EW-617 G2: downstream services can gate behavior on this flag
    // (e.g. quotas, claim-account UI nag, OAuth restrictions).
    isAnonymous?: boolean;
    // EW-664 (Phase 12): NOT populated by the auth layer — hydrated at
    // request time by `SessionScopeGuard` (which already loads the user
    // row) so `ScopeOwnershipGuard` can authorize the resolved scope
    // against the user's real Tenant. `undefined` until that guard runs;
    // `null` for users not yet upgraded to a Tenant.
    tenantId?: string | null;
}

export interface TokenResponse {
    access_token: string;
    user: {
        id: string;
        email: string | null;
        username: string;
        isAnonymous?: boolean;
        anonymousExpiresAt?: string | null;
    };
}

/**
 * Self-build slice Z (EW-796) — what `AuthSessionGuard` stashes on the
 * request when a fleet-run MCP credential (`ew_run_…`) authenticated it.
 *
 * `request.user` still describes the OWNER, exactly as an `ew_live_` key
 * would: the run acts as the person whose Task it is, and every
 * ownership check downstream keeps working unchanged. This block is the
 * extra fact those checks do not carry — that the caller is one specific
 * fleet run, and which Organization it is pinned to.
 *
 * `SessionScopeGuard` is the consumer: it seeds the scope from
 * `organizationId` here and refuses any `X-Scope-Slug` that resolves
 * elsewhere, so the token's scope wins over the header and must equal it.
 */
export interface FleetRunCredentialBinding {
    jobId: string;
    nodeId: string;
    runId: string | null;
    /** Organization the token is pinned to; `null` = the owner's personal scope. */
    organizationId: string | null;
}
