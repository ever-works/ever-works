import { NextRequest } from 'next/server';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import {
    everIdAPI,
    toEverIdFailure,
    type EverIdCallbackResult,
    type EverIdFailure,
} from '@/lib/api/ever-id';
import { setAuthCookies } from '@/lib/auth';
import { everIdErrorPageHref, everIdSecurityNoticeHref } from '@/lib/auth/ever-id';
import {
    resolveEverIdReturnTo,
    setEverIdPending,
    takeEverIdTransaction,
    type EverIdIntent,
} from '@/lib/auth/ever-id-cookies';
import { ROUTES } from '@/lib/constants';

/**
 * APW-12 (Ever ID) — the redirect URI registered at the provider (spec FR-10,
 * plan §6.3, T23). Mirrors `handleOAuthCallback` (`app/api/oauth/`): read the
 * browser-bound transaction, hand the provider's answer to the API, then set a
 * cookie and redirect.
 *
 * | API answer       | Web action                                                        |
 * | ---------------- | ----------------------------------------------------------------- |
 * | `signedIn`       | session cookie, then the validated return path or the dashboard  |
 * | `confirmSignUp`  | pending cookie, then `/auth/ever-id/create-account`               |
 * | `confirmConnect` | pending cookie, then `/settings/security/connect-ever-id`         |
 * | `emailInUse`     | pending cookie, then `/auth/ever-id/account-exists`               |
 * | an error code    | sign-in: `/auth/error?error=ever_id_<code>`; connect: Settings    |
 *
 * Invariants, each asserted by `route.unit.spec.ts`:
 *
 *  - The transaction and intent cookies are cleared on **every** path (FR-9).
 *  - No address this route builds carries a token, the code, the `state` or an
 *    e-mail address: the pending screens read the address from the encrypted
 *    pending cookie, never from the query (FR-16, NFR-9).
 *  - The return path is re-validated here, whatever the API echoed back, and the
 *    session token is never added to it (plan §6.2).
 */
export async function GET(request: NextRequest) {
    const locale = await getLocale();
    const { transaction, intent } = await takeEverIdTransaction();
    const href = await completeEverIdCallback(request.nextUrl.searchParams, transaction, intent);

    return redirect({ locale, href });
}

/** Where an error goes: the auth error page for a sign-in, Settings for a connect. */
function failureHref(intent: EverIdIntent | null, failure: EverIdFailure): string {
    return intent === 'connect'
        ? everIdSecurityNoticeHref(failure.code, failure.retryAfterSeconds)
        : everIdErrorPageHref(failure.code, failure.retryAfterSeconds);
}

async function completeEverIdCallback(
    params: URLSearchParams,
    transaction: string | null,
    intent: EverIdIntent | null,
): Promise<string> {
    const providerError = params.get('error');
    if (providerError) {
        // The person declined at Ever ID: back where they started, quietly.
        if (providerError === 'access_denied') {
            return intent === 'connect' ? ROUTES.DASHBOARD_SETTINGS_SECURITY : ROUTES.AUTH_LOGIN;
        }
        return failureHref(intent, { code: 'transaction_invalid' });
    }

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state || !transaction) {
        // S17: a replayed, expired or foreign callback (no transaction to match).
        return failureHref(intent, { code: 'transaction_invalid' });
    }

    const body: { code: string; state: string; iss?: string; transaction: string } = {
        code,
        state,
        transaction,
    };
    const iss = params.get('iss');
    if (iss) {
        body.iss = iss;
    }

    let result: EverIdCallbackResult;
    try {
        result = await everIdAPI.callback(body);
    } catch (error) {
        console.error('Ever ID callback was refused:', error);
        return failureHref(intent, toEverIdFailure(error));
    }

    try {
        return await applyOutcome(result);
    } catch (error) {
        console.error('Ever ID callback answer could not be applied:', error);
        return failureHref(intent, { code: 'transaction_invalid' });
    }
}

function requireText(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('Ever ID callback answer is missing a field');
    }
    return value;
}

async function applyOutcome(result: EverIdCallbackResult): Promise<string> {
    switch (result.outcome) {
        case 'signedIn':
            await setAuthCookies(requireText(result.access_token));
            return resolveEverIdReturnTo(result.returnTo, ROUTES.DASHBOARD);

        case 'confirmSignUp':
            await setEverIdPending({
                kind: 'signUp',
                pending: requireText(result.pending),
                email: requireText(result.identity?.email),
                name: typeof result.identity?.name === 'string' ? result.identity.name : null,
                accountEmail: null,
            });
            return ROUTES.AUTH_EVER_ID_CREATE_ACCOUNT;

        case 'confirmConnect':
            await setEverIdPending({
                kind: 'connect',
                pending: requireText(result.pending),
                email: requireText(result.identity?.email),
                name: null,
                accountEmail: requireText(result.accountEmail),
            });
            return ROUTES.DASHBOARD_SETTINGS_SECURITY_CONNECT_EVER_ID;

        case 'emailInUse':
            await setEverIdPending({
                kind: 'emailInUse',
                pending: requireText(result.pending),
                email: requireText(result.email),
                name: null,
                accountEmail: null,
            });
            return ROUTES.AUTH_EVER_ID_ACCOUNT_EXISTS;

        default:
            throw new Error('Ever ID callback answered an unknown outcome');
    }
}
