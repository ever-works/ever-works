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
    /**
     * Safety rails (AW-24) — WHICH credential path authenticated this
     * request, stamped by `AuthSessionGuard` in both of its branches.
     *
     * Some controls may only ever be operated by a person in an interactive
     * session: a rung, a workspace pause, a resume (FR-31, FR-47). Nothing in
     * `AuthenticatedUser` could tell a person from a machine credential, even
     * though the guard knows exactly which branch ran — so `HumanActorGuard`
     * had nothing to read.
     *
     * OPTIONAL, so every existing reader is unaffected. A MISSING value is
     * treated as NOT human by `HumanActorGuard`: an older token path that
     * predates the stamp must fail closed, not sneak through.
     *
     * APW-12 (Ever ID) appends exactly one value, `'ever-id-delegated'`: an Ever
     * ID access token carrying a delegated scope (FR-44), admitted ONLY on
     * handlers marked `@DelegatedRead(scope)`. It never opens a session, and both
     * `HumanActorGuard` and `SessionOnlyGuard` refuse it (they admit only
     * `'session'`).
     *
     * EW-P1-2 appends `'integration'`: an integration key (`ew_int_…`). It is
     * NOT a personal credential: the request carries {@link integration}, the
     * integration guards admit it only on routes that declare
     * `@RequireScopes(...)`, and `userId` is the user the request acts for —
     * the validated `X-Act-As-User` on a write, otherwise the key's owner.
     */
    authMethod?: 'session' | 'api-key' | 'ever-id-delegated' | 'integration';
    /**
     * EW-P1-2 — set only when `authMethod === 'integration'`. The key's own
     * facts (scopes, pins, owner) and the act-as resolution of this request.
     */
    integration?: IntegrationPrincipal;
}

/**
 * EW-P1-2 — the integration principal behind an `ew_int_…` key.
 *
 * Built by `AuthSessionGuard` from the key row; `actAsUserId` is filled by
 * `IntegrationPrincipalGuard` once `X-Act-As-User` has been validated (writes
 * only). Never derived from anything the caller controls except that header.
 */
export interface IntegrationPrincipal {
    keyId: string;
    keyName: string;
    /** `'ever-gauzy'` | `'generic'`. */
    integrationKind: string;
    /** The Tenant the key was created in; every pin belongs to it. */
    tenantId: string;
    /** Organizations the key is pinned to. */
    allowedOrganizationIds: string[];
    /** Granted scopes (vocabulary v1). */
    scopes: string[];
    /** The user who created the key — the owner of writes made without act-as. */
    ownerUserId: string;
    /** The validated `X-Act-As-User` of this request, or `null`. */
    actAsUserId: string | null;
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

/**
 * APW-12 (Ever ID, plan §5.3) — what `AuthSessionGuard` stashes on the request
 * when a delegated Ever ID access token authenticated it (FR-44..FR-47).
 * `request.user` is still the person; this block is the extra fact that the
 * caller is another app acting for them with a narrow scope. No token is kept.
 */
export interface EverIdDelegationBinding {
    /** The connected identity the token's subject resolved to. */
    identityId: string;
    /** The token's authorised party (`azp`), when it carried one. */
    clientId: string | null;
    scopes: string[];
}
