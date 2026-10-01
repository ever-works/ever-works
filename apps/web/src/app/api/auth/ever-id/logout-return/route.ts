import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { removeAuthAccessCookies } from '@/lib/auth';
import { EVER_ID_SIGNED_OUT_PARAM, EVER_ID_SIGNED_OUT_VALUE } from '@/lib/auth/ever-id';
import { takeEverIdLogoutState } from '@/lib/auth/ever-id-cookies';
import { ROUTES } from '@/lib/constants';

/**
 * APW-12 (Ever ID) — where the provider's sign-out returns after "Also sign out
 * of Ever ID" (S7, spec FR-36, T26).
 *
 * The `state` in the address must equal the one `logoutWithEverId` remembered in
 * `ew_everid_logout_state`, compared in constant time (as digests, so neither the
 * value nor its length leaks through timing). The remembered value is cleared on
 * every path.
 *
 *  - Match: the session cookie is cleared (again — the sign-out already did it)
 *    and the sign-in page shows "You're signed out of Ever Works and Ever ID."
 *    through the non-secret `?signedOut=ever-id` marker.
 *  - Absent or mismatched: the ordinary sign-in page, no message, and nothing
 *    else touched — a forged return can neither sign anyone out nor claim the
 *    provider did.
 */

/** The API's `state` is short; a longer value is not its answer. */
const STATE_MAX_LENGTH = 512;

function isSameState(received: string | null, expected: string | null): boolean {
    if (!received || !expected || received.length > STATE_MAX_LENGTH) {
        return false;
    }
    const left = createHash('sha256').update(received, 'utf8').digest();
    const right = createHash('sha256').update(expected, 'utf8').digest();
    return timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
    const locale = await getLocale();
    const expected = await takeEverIdLogoutState();
    const received = request.nextUrl.searchParams.get('state');

    if (!isSameState(received, expected)) {
        return redirect({ locale, href: ROUTES.AUTH_LOGIN });
    }

    await removeAuthAccessCookies();

    const query = new URLSearchParams({ [EVER_ID_SIGNED_OUT_PARAM]: EVER_ID_SIGNED_OUT_VALUE });
    return redirect({ locale, href: `${ROUTES.AUTH_LOGIN}?${query.toString()}` });
}
