import 'server-only';
import { cookies } from 'next/headers';
import { isPublicUrlHttps } from './cookies';

/**
 * APW-12 (Ever ID) S6 — carries "you were signed out of Ever ID" across the
 * redirect to the sign-in page when the session cookie is already gone.
 *
 * The API answers `401 { code: 'ever_id_signed_out' }` for a session an Ever ID
 * sign-out notice ended. Where that answer reaches the central 401 handling in
 * `./index.ts` decides how the sign-in page learns about it:
 *
 *  - during a Server Component render the stale session cookie cannot be
 *    removed, so the sign-in page asks the API about it again and records the
 *    same answer for its own request (`wasSignedOutByEverId`);
 *  - in a Server Action or route handler the cookie IS removed, so the sign-in
 *    page that follows has nothing left to ask about. This marker is what it
 *    reads instead.
 *
 * The value is a constant: no token, no code, no address. It lives five
 * minutes: ample for the redirect that normally follows at once, and short
 * enough that a later, unrelated sign-out is unlikely to find it still there.
 */
export const EVER_ID_SIGNED_OUT_COOKIE = 'ew_everid_signed_out';
export const EVER_ID_SIGNED_OUT_MAX_AGE_SECONDS = 300;

const MARKER_VALUE = '1';

/**
 * Leaves the marker. Best-effort: a Server Component render refuses cookie
 * writes, and there the stale session cookie is still in place, so the sign-in
 * page sees the API's answer itself and needs no marker.
 */
export async function rememberEverIdSignOut(): Promise<void> {
    try {
        const store = await cookies();
        store.set(EVER_ID_SIGNED_OUT_COOKIE, MARKER_VALUE, {
            httpOnly: true,
            secure: isPublicUrlHttps(),
            sameSite: 'lax',
            path: '/',
            maxAge: EVER_ID_SIGNED_OUT_MAX_AGE_SECONDS,
        });
    } catch {
        // Not writable from this context; see above.
    }
}

/** Whether the visitor arrived with the marker. */
export async function hasEverIdSignOutMarker(): Promise<boolean> {
    try {
        const store = await cookies();
        return store.get(EVER_ID_SIGNED_OUT_COOKIE)?.value === MARKER_VALUE;
    } catch {
        return false;
    }
}
