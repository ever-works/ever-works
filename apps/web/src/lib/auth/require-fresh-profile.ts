import 'server-only';
import { getLocale } from 'next-intl/server';
import { authAPI } from '@/lib/api/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export type FreshProfile = Awaited<ReturnType<typeof authAPI.getFreshProfile>>;

/**
 * `authAPI.getFreshProfile()` with the one outcome it was missing.
 *
 * The Settings pages (`/settings`, `/settings/security`, `/settings/danger`)
 * each re-fetch the profile with `getFreshProfile()`, which has no internal
 * catch — so a rejection escaped the Server Component and the ROUTE answered
 * **HTTP 500**. Their own parent `(dashboard)/layout.tsx` makes the identical
 * call guarded (`.catch(() => null)`) and redirects to login when the session
 * is gone, but layout and page render CONCURRENTLY: the page's throw is not
 * reliably pre-empted by the layout's redirect.
 *
 * The missing outcome is specifically the 401. A session that is present but
 * no longer accepted — expired JWT, rotated secret, revoked session — is not a
 * server error, it is a signed-out user, and the correct answer is the login
 * page. That is exactly what the layout does for an *absent* cookie; this
 * makes the page agree for a *rejected* one.
 *
 * Everything else (5xx, network failure) is deliberately rethrown. There is no
 * honest "degraded profile" to render — a fabricated or blank profile on the
 * Danger Zone or Security page would show made-up account state as if it were
 * the user's own — so a real backend failure stays loud and reaches the
 * dashboard error boundary, which offers a retry.
 */
export async function requireFreshProfile(routeLabel: string): Promise<FreshProfile> {
    try {
        return await authAPI.getFreshProfile();
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 401) {
            // Logged, not swallowed — a silent bounce to /login is hard to
            // tell from a user simply signing out.
            console.warn(
                `[${routeLabel}] session rejected by /auth/profile/fresh (401) — redirecting to login`,
            );
            redirect({ locale: await getLocale(), href: ROUTES.AUTH_LOGIN });
        }
        throw error;
    }
}
