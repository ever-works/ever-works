import 'server-only';

/**
 * Which of the four `auth.error.verifyEmail.*` messages is actually true for a
 * failed email verification?
 *
 * EW-078: the route used to answer this question with a constant. Every
 * rejection — an expired link, an unreachable API, a TLS reset — became
 * `verify_email_invalid_token`, which renders as "Email verification link is
 * invalid or has already been used." Three of the four messages were dead
 * strings: `expiredToken` and `failed` were written, translated into all 21
 * locales, wired into the error page's `switch` and its icon table, and could
 * not be reached by any input.
 *
 * That is worse than vague, it is wrong, and it sends people the wrong way. A
 * link that merely aged out is told it was "already used" — so the user goes
 * hunting for the session they think they already spent, instead of clicking
 * the one button that fixes it ("Resend verification"). An API outage is
 * reported as a bad link, so the user requests a new one and gets the same
 * failure, because the link was never the problem.
 *
 * The mapping below mirrors the password-reset route, which has always
 * distinguished expiry (`reset_password_expired_token`) by looking at the
 * API's own wording.
 */
export const VERIFY_EMAIL_ERROR = {
    /** The token was real but past `emailVerificationExpires`. Resend fixes it. */
    EXPIRED: 'verify_email_expired_token',
    /** No such token: never issued, already consumed, or mangled in transit. */
    INVALID: 'verify_email_invalid_token',
    /** Verification never ran. The link may well still be good — retry it. */
    FAILED: 'verify_email_failed',
} as const;

export type VerifyEmailErrorCode = (typeof VERIFY_EMAIL_ERROR)[keyof typeof VERIFY_EMAIL_ERROR];

/**
 * Classify a rejection from `authAPI.verifyEmail`.
 *
 * `serverFetch` throws `ApiResponseError`, which carries the API's own
 * `message` and the HTTP `statusCode`. Anything else that can escape the try
 * block (a transport-level `TypeError`, a cookie write that blew up) arrives
 * as a plain `Error` with no `statusCode` — deliberately handled, because the
 * one thing it definitely is not is evidence about the token.
 *
 * Matching is on the message stem rather than the exact sentence so the API
 * rewording "Verification token expired" does not silently push this back to
 * the constant it replaced. It is still narrow: only the word that carries the
 * meaning, and only on a response that actually came from the API.
 */
export function verifyEmailErrorCode(error: unknown): VerifyEmailErrorCode {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;

    // A 5xx says nothing about the token — verification did not run. Calling
    // the link "invalid or already used" here is a guess, and it points the
    // user away from the fix: retrying the SAME link is the right next step.
    if (typeof statusCode === 'number' && statusCode >= 500) {
        return VERIFY_EMAIL_ERROR.FAILED;
    }

    // No status at all means the request never got an answer (DNS, TLS,
    // connection reset, or a throw on our own side). Same reasoning as the
    // 5xx branch: the token is unjudged, so don't judge it.
    //
    // 🛑 This MUST stay ahead of the /expir/ test below. The docblock promises
    // the stem match happens "only on a response that actually came from the
    // API", and ordering is the only thing that keeps that promise. Reversed,
    // an expired TLS certificate on the API arrives as a plain Error reading
    // "certificate has expired", matches /expir/, and tells the user their
    // VERIFICATION LINK expired — a confident, wrong diagnosis that sends them
    // to request a new link that will fail exactly the same way. That is the
    // very failure mode EW-078 exists to remove, so it would be an unfortunate
    // one to reintroduce here.
    if (typeof statusCode !== 'number') {
        return VERIFY_EMAIL_ERROR.FAILED;
    }

    // `auth.service.ts#verifyEmail` → `BadRequestException('Verification token
    // expired')`. This is the branch EW-078 is about.
    if (/expir/i.test(message)) {
        return VERIFY_EMAIL_ERROR.EXPIRED;
    }

    // A 4xx that the API did answer: the token really was rejected.
    return VERIFY_EMAIL_ERROR.INVALID;
}
