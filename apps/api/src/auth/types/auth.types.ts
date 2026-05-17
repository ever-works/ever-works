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
