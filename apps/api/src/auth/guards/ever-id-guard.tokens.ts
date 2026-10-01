import type { AuthenticatedUser, EverIdDelegationBinding } from '../types/auth.types';

/**
 * APW-12 (Ever ID) — the two collaborators `AuthSessionGuard` reaches for on
 * the Ever ID paths, behind DI tokens so the guard (which every request passes)
 * imports nothing heavier than this file. `AuthModule` binds both; a build
 * without them simply never takes those branches.
 */

/** A token shaped like a compact JWS. An Ever Works session bearer never contains a dot (plan §5.3). */
export const JWT_SHAPED_BEARER = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Verifies a delegated Ever ID access token on a `@DelegatedRead(scope)` handler. */
export const EVER_ID_DELEGATION_VERIFIER = Symbol('EVER_ID_DELEGATION_VERIFIER');

export interface EverIdDelegationVerifier {
    /**
     * `null` for any refusal the guard answers with the plain 401; throws
     * `403 insufficientScope` for a valid token without the scope.
     */
    authenticate(
        token: string,
        scope: string,
        ctx: { ipAddress: string | null; userAgent: string | null },
    ): Promise<{ user: AuthenticatedUser; binding: EverIdDelegationBinding } | null>;
}

/** Tells whether a session bearer was ended by an Ever ID sign-out notice (S6). */
export const EVER_ID_SIGNED_OUT_PROBE = Symbol('EVER_ID_SIGNED_OUT_PROBE');

export interface EverIdSignedOutProbe {
    /** `true` when the session this raw bearer belonged to was ended by a sign-out notice. */
    wasSignedOut(bearer: string): Promise<boolean>;
}
