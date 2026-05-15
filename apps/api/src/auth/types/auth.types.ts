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
    iat: number;
    iss: string;
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
    iat: number;
    iss: string;
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
