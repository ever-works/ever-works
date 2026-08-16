/**
 * EW-082 — telling the reset-password failures apart.
 *
 * Lives in its own module rather than beside the action that uses it because
 * `app/actions/auth.ts` carries `'use server'`, and a server-action file may
 * only export async functions — a plain exported helper there would break the
 * build, and an unexported one could not be unit-tested directly.
 */

/** Message keys under `auth.resetPassword.errors` that `resetPassword` returns. */
export type ResetPasswordFailureReason =
    | 'expiredToken'
    | 'invalidToken'
    | 'rateLimited'
    | 'upstream'
    | 'failed';

/**
 * Which reset-password failure is this?
 *
 * The API distinguishes them; the UI threw the distinction away and rendered
 * one flat "Failed to reset password" for all of them. What the server
 * actually emits (apps/api auth.service.ts / auth.controller.ts):
 *
 *   - `400 Reset token expired` — the row is still there, the hour is up.
 *   - `400 Invalid reset token` — no row matches the hash. This is ALSO what an
 *     already-consumed token produces, because `consumePasswordResetToken`
 *     clears the column on success. The API genuinely cannot tell "already
 *     used" from "never valid", so neither can we — which is why the copy for
 *     this branch says the link "may have already been used" instead of
 *     claiming a precision the server does not have.
 *   - `429` — the 5/min throttle on the route. The token was never touched.
 *   - anything else (5xx, an unreachable API, a parse failure) — the link is
 *     probably fine, the platform is not. "Wait and try again" is right here
 *     and wrong for the two dead-link cases above.
 *
 * Matched on status AND on the words that carry the meaning, in the same shape
 * as `isEmailNotVerifiedError` in the actions module, so an unrelated future
 * 400 on this route cannot start telling people their link expired. Anything
 * unrecognised falls through to the original generic string: a new upstream
 * failure is reported vaguely, never wrongly.
 */
export function classifyResetPasswordError(error: unknown): ResetPasswordFailureReason {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;

    if (statusCode === 429) return 'rateLimited';

    if (statusCode === undefined || statusCode === 400) {
        if (/expired/i.test(message)) return 'expiredToken';
        if (/invalid.*token|token.*invalid/i.test(message)) return 'invalidToken';
    }

    if (typeof statusCode === 'number' && statusCode >= 500) return 'upstream';

    return 'failed';
}

/**
 * Is this the kind of failure where retrying the same link can never work?
 *
 * Only a fresh link fixes an expired or no-longer-valid one; the form uses
 * this to decide whether to offer "Request a new reset link" alongside the
 * message, instead of leaving the user to re-press a button that will fail
 * identically forever.
 */
export function resetLinkIsDead(reason: ResetPasswordFailureReason): boolean {
    return reason === 'expiredToken' || reason === 'invalidToken';
}
