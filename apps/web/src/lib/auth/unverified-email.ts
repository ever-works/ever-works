/**
 * "This session belongs to an address nobody has confirmed yet."
 *
 * Two flows in this app mint a session for an account whose email is still
 * unconfirmed, and until now neither of them said so:
 *
 *   EW-077  Registration signs the new user straight in. The account works —
 *           for exactly as long as that session lasts. When it ends, the
 *           password gate (`requireEmailVerification`, H-07) refuses them with
 *           "Please verify your email address before signing in", and because
 *           nothing ever told them the address was unconfirmed, a rule that was
 *           in force from the first second reads as a fault that appeared
 *           overnight. The signup flow already emails a verification link and
 *           then behaves as though it does not matter.
 *
 *   EW-080  A magic-link sign-in admits an unconfirmed user that the password
 *           tab on the same page would turn away. That asymmetry is CORRECT —
 *           see the note in `redeemMagicLink` — but it is invisible, so the
 *           two tabs simply disagree in front of the user with no explanation.
 *
 * The fix both share: when the web mints a session for an unconfirmed address,
 * carry that fact to the landing page so it can be stated plainly, along with
 * the consequence. This module is the seam. It is deliberately free of
 * `server-only` so the client component that renders the notice can import the
 * same constants the server actions set — one definition, not two that drift.
 */

/** Query param the landing page reads to know it should say something. */
export const VERIFY_EMAIL_PARAM = 'verifyEmail';

/** The only value that means anything; anything else is ignored. */
export const VERIFY_EMAIL_REQUIRED = 'required';

/**
 * Is this session's address unconfirmed?
 *
 * Deliberately strict about `false`. `emailVerified` is optional on
 * `UserProfile`, and an API response that simply omits it is not evidence that
 * the address is unconfirmed — treating `undefined` as "unverified" would make
 * every user see the notice the moment the field is dropped from a payload.
 * Only an explicit `false` triggers it.
 */
export function isEmailUnconfirmed(user: { emailVerified?: boolean } | null | undefined): boolean {
    return user?.emailVerified === false;
}

/**
 * Tag an in-app destination so the landing page shows the unconfirmed-address
 * notice.
 *
 * Relative paths only. An absolute destination is an allowlisted external host
 * (see `isRelativeOrAllowedRedirectHost`) whose pages know nothing about this
 * param, so it is returned untouched rather than decorated with a query string
 * it will never read. Existing params are preserved — `register` already
 * appends `?newUser=true`, and both notices need to survive.
 */
export function withUnverifiedEmailNotice(href: string): string {
    if (!href.startsWith('/')) {
        return href;
    }

    // Parse against a throwaway base so relative paths, query strings and
    // fragments are all handled by the URL parser rather than by string
    // surgery (`href` may already contain a `?`, a `#`, or both).
    try {
        const url = new URL(href, 'https://placeholder.invalid');
        url.searchParams.set(VERIFY_EMAIL_PARAM, VERIFY_EMAIL_REQUIRED);
        return url.pathname + url.search + url.hash;
    } catch {
        return href;
    }
}
