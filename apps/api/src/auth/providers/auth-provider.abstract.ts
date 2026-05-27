import type { AuthenticatedUser, TokenResponse } from '../types/auth.types';

/**
 * Pluggable abstraction for the API's authentication backend.
 *
 * One concrete subclass is bound at module-init time (see
 * `auth.module.ts`) and injected via the `AUTH_PROVIDER` token. Every
 * route that handles auth (sign-in, sign-up, password change/reset,
 * session issuance, sign-out) delegates here so the API doesn't bake
 * in a specific provider library.
 *
 * Method semantics worth knowing for implementors:
 *
 * - **`authenticate(headers)`** — read the request headers and
 *   resolve them to an `AuthenticatedUser`. Returns `null` rather
 *   than throwing on missing/invalid credentials so the caller
 *   (`AuthSessionGuard`) can fall through to other auth paths
 *   (e.g. API key).
 *
 * - **`signInEmail` / `signUpEmail`** — return a `TokenResponse`
 *   for the freshly authenticated/registered user. Implementors
 *   MUST hash + verify passwords; never store plaintext.
 *
 * - **`issueSession(userId, clientFingerprint?)`** — mint a session
 *   for an already-identified user, used by the OAuth callback paths
 *   that bypass password verification. `clientFingerprint` (IP +
 *   user-agent) is stored on the session row so an operator can
 *   later attribute / revoke sessions per device.
 *
 * - **`changePassword` (requires current)** vs **`setPassword`
 *   (skips current)**. The latter is for admin overrides and the
 *   password-reset flow where the user couldn't supply the old
 *   password by definition. Implementors MUST gate `setPassword`
 *   on a verified reset token or admin context — there is no
 *   credential check inside the method.
 *
 * - **`signOut(headers)` vs `signOutAll(userId)`** — single-session
 *   logout vs account-wide logout (revoke every active session for
 *   the user; used in account-security flows after suspected
 *   compromise or password reset).
 */
export abstract class AuthProvider {
    abstract authenticate(headers: Headers): Promise<AuthenticatedUser | null>;

    abstract signInEmail(email: string, password: string, headers: Headers): Promise<TokenResponse>;

    abstract signUpEmail(
        name: string,
        email: string,
        password: string,
        headers: Headers,
    ): Promise<TokenResponse>;

    abstract issueSession(
        userId: string,
        clientFingerprint?: { ipAddress?: string | null; userAgent?: string | null },
    ): Promise<TokenResponse>;

    abstract changePassword(
        currentPassword: string,
        newPassword: string,
        headers: Headers,
    ): Promise<void>;

    abstract setPassword(userId: string, newPassword: string): Promise<void>;

    abstract signOut(headers: Headers): Promise<void>;

    abstract signOutAll(userId: string): Promise<void>;
}
