'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { authAPI, type TermsAcceptanceClaim } from '@/lib/api';
import {
    everIdAPI,
    EverIdRequestError,
    toEverIdFailure,
    type EverIdAdminSettingsPatch,
    type EverIdAdminStatus,
    type EverIdCheck,
    type EverIdFailure,
    type EverIdSignUpResponse,
} from '@/lib/api/ever-id';
import { getRedirectCookie, removeAuthAccessCookies, setAuthCookies } from '@/lib/auth';
import {
    EVER_ID_ADMIN_SETTINGS_LIMITS,
    EVER_ID_CHECK_IDS,
    EVER_ID_CONNECTED_NOTICE,
    EVER_ID_HTTPS_URL_PATTERN,
    EVER_ID_LOCAL_CLIENT_KINDS,
    everIdMessageKey,
    everIdSecurityNoticeHref,
    toEverIdReturnTo,
    type EverIdCheckId,
    type EverIdFailureCode,
} from '@/lib/auth/ever-id';
import {
    clearEverIdPending,
    readEverIdPending,
    resolveEverIdReturnTo,
    setEverIdLogoutState,
    setEverIdTransaction,
} from '@/lib/auth/ever-id-cookies';
import { REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';

/**
 * APW-12 (Ever ID) — the server actions of the browser flow (plan §6.1, T22).
 *
 * Kept beside, not inside, `./auth.ts`: every existing sign-in action there stays
 * byte-for-byte as it was, and the Ever ID flow is reviewable as one unit.
 *
 * Rules every action here follows:
 *
 *  - **Translated copy only.** A refusal is reduced to its wire code
 *    (`toEverIdFailure`) and rendered from `auth.error.everId.*`; the API's own
 *    English message is never forwarded (T22 "no action returns an upstream
 *    message verbatim").
 *  - **Nothing secret in an address.** The only off-site addresses are the
 *    provider's own authorization and end-session URLs, exactly as the API
 *    returned them; every other redirect carries an error code or a fixed marker
 *    (spec FR-16, NFR-9).
 *  - **The provider URL is never taken from the browser.** "Also sign out of Ever
 *    ID" asks the API for the end-session address again rather than accepting
 *    one from the client, so no action here can be pointed at an address the
 *    browser chose.
 */

/** What a flow action answers when it does not navigate away. */
export type EverIdActionResult =
    | { success: true }
    | {
          success: false;
          error: string;
          code: EverIdFailureCode | 'terms_required' | 'pending_expired';
      };

export type EverIdAdminTestResult =
    | { success: true; checks: EverIdCheck[] }
    | { success: false; error: string };

export type EverIdAdminToggleResult =
    | { success: true; status: EverIdAdminStatus }
    | { success: false; error: string; checks?: EverIdCheck[] };

export type EverIdAdminSettingsResult =
    | { success: true; status: EverIdAdminStatus }
    | { success: false; error: string };

/** The shape `register` already validates terms claims against (`./auth.ts`). */
const termsClaimsSchema = z
    .array(
        z.object({
            documentId: z.string().min(1),
            version: z.string().min(1),
            // Shape only — the API checks the digest against the published corpus.
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            locale: z.string().min(1),
        }),
    )
    .min(1);

/** A connected identity's id is a UUID; anything else is refused before it reaches a path. */
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** The `state` the API mints is short; anything longer is not its answer. */
const LOGOUT_STATE_MAX_LENGTH = 512;

/**
 * The provider address the API returned, checked to be an absolute http(s) URL
 * (http only matters for a local provider in development, FR-2). Anything else
 * is treated as the provider being unavailable.
 */
function toProviderUrl(value: unknown): string {
    if (typeof value === 'string') {
        try {
            const url = new URL(value);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                return value;
            }
        } catch {
            // fall through
        }
    }
    throw new Error('Ever ID answered without a usable provider address');
}

/** A failure the person can retry with the same pending value. */
function isRetryable(failure: EverIdFailure): boolean {
    return failure.code === 'rate_limited' || failure.code === 'provider_unavailable';
}

async function failureResult(failure: EverIdFailure): Promise<EverIdActionResult> {
    const t = await getTranslations('auth.error.everId');
    const key = everIdMessageKey(failure.code) ?? 'providerUnavailable';
    const error =
        key === 'rateLimited'
            ? t('rateLimited', { seconds: failure.retryAfterSeconds ?? 60 })
            : t(key);
    return { success: false, error, code: failure.code };
}

async function pendingExpiredResult(): Promise<EverIdActionResult> {
    const t = await getTranslations('auth.everId');
    return { success: false, error: t('pendingExpired'), code: 'pending_expired' };
}

/**
 * The terms were not accepted (`changed: false`), or the API refused the claims
 * because the published documents changed under the screen (`changed: true`).
 */
async function termsRequiredResult(changed: boolean): Promise<EverIdActionResult> {
    const t = await getTranslations('auth.everId');
    return {
        success: false,
        error: changed ? t('termsChanged') : t('consentRequired'),
        code: 'terms_required',
    };
}

/** The same session teardown `logout()` performs (`./auth.ts`). */
async function endEverWorksSession(): Promise<void> {
    try {
        await authAPI.logout();
    } catch (error) {
        console.error(error);
    }

    await removeAuthAccessCookies();
}

// =================
// Sign in / sign up
// =================

/**
 * "Sign in with Ever ID" / "Sign up with Ever ID" (spec §6.1). On success the
 * browser is redirected to the provider; the answer is only seen on failure.
 *
 * An explicit, valid relative `returnTo` wins; otherwise a relative destination
 * the app stored before sign-in (an organization invitation, say) is honoured,
 * the way `login` honours it. Absolute destinations are never forwarded, and the
 * session token is never stitched into one (plan §6.2).
 */
export async function startEverIdSignIn(returnTo?: string | null): Promise<EverIdActionResult> {
    const target = toEverIdReturnTo(returnTo) ?? toEverIdReturnTo(await getRedirectCookie());

    let authorizationUrl: string;
    try {
        const response = await everIdAPI.authorize(target ? { returnTo: target } : {});
        authorizationUrl = toProviderUrl(response.authorizationUrl);
        await setEverIdTransaction(response.transaction, 'sign-in');
    } catch (error) {
        console.error('Ever ID sign-in could not start:', error);
        return failureResult(toEverIdFailure(error, 'provider_unavailable'));
    }

    redirect(authorizationUrl);
}

/**
 * "Create account" on the create-account screen (S2, spec §6.2): the pending
 * sign-up plus every currently required terms document, exactly as displayed.
 */
export async function confirmEverIdSignUp(
    terms: TermsAcceptanceClaim[],
): Promise<EverIdActionResult> {
    const claims = termsClaimsSchema.safeParse(terms);
    if (!claims.success) {
        return termsRequiredResult(false);
    }

    const pending = await readEverIdPending('signUp');
    if (!pending) {
        return pendingExpiredResult();
    }

    let response: EverIdSignUpResponse;
    try {
        response = await everIdAPI.confirmSignUp({
            pending: pending.pending,
            terms: claims.data,
        });
    } catch (error) {
        console.error('Ever ID sign-up could not be confirmed:', error);

        if (error instanceof EverIdRequestError && error.code === 'terms_required') {
            // The documents changed under the screen; the pending value is still good.
            return termsRequiredResult(true);
        }

        const failure = toEverIdFailure(error);
        if (!isRetryable(failure)) {
            await clearEverIdPending();
        }
        return failure.code === 'transaction_invalid'
            ? pendingExpiredResult()
            : failureResult(failure);
    }

    await clearEverIdPending();
    await setAuthCookies(response.access_token);

    // A new account lands where `register` sends one, unless a return path was set.
    redirect(await resolveEverIdReturnTo(response.returnTo, `${ROUTES.DASHBOARD}?newUser=true`));
}

/** "Cancel" on the create-account screen: nothing is created (S2). */
export async function cancelEverIdSignUp(): Promise<void> {
    await clearEverIdPending();
    redirect(ROUTES.AUTH_LOGIN);
}

// =================
// Connect / disconnect (Settings → Security)
// =================

/**
 * "Connect Ever ID" (S4). The API refuses with `reauth_required` when the session
 * is older than 12 hours (S15); the card then offers "Sign in again".
 */
export async function startEverIdConnect(): Promise<EverIdActionResult> {
    let authorizationUrl: string;
    try {
        const response = await everIdAPI.connectAuthorize();
        authorizationUrl = toProviderUrl(response.authorizationUrl);
        await setEverIdTransaction(response.transaction, 'connect');
    } catch (error) {
        console.error('Ever ID connection could not start:', error);
        return failureResult(toEverIdFailure(error, 'provider_unavailable'));
    }

    redirect(authorizationUrl);
}

/** "Connect" on the confirmation screen (spec §6.4). */
export async function confirmEverIdConnect(): Promise<EverIdActionResult> {
    const pending = await readEverIdPending('connect');
    if (!pending) {
        return pendingExpiredResult();
    }

    try {
        await everIdAPI.connectConfirm({ pending: pending.pending });
    } catch (error) {
        console.error('Ever ID connection could not be confirmed:', error);
        const failure = toEverIdFailure(error);
        if (!isRetryable(failure)) {
            await clearEverIdPending();
        }
        return failure.code === 'transaction_invalid'
            ? pendingExpiredResult()
            : failureResult(failure);
    }

    await clearEverIdPending();
    redirect(everIdSecurityNoticeHref(EVER_ID_CONNECTED_NOTICE));
}

/** "Cancel" on the confirmation screen: nothing is connected. */
export async function cancelEverIdConnect(): Promise<void> {
    await clearEverIdPending();
    redirect(ROUTES.DASHBOARD_SETTINGS_SECURITY);
}

/**
 * "Disconnect", after the confirmation (S5). The API refuses the S14 case with
 * `last_sign_in_method`; every other session the identity opened is ended there.
 */
export async function disconnectEverId(id: string): Promise<EverIdActionResult> {
    const t = await getTranslations('dashboard.settings.security.connectedIdentities');

    if (typeof id !== 'string' || !CONNECTION_ID_PATTERN.test(id)) {
        return { success: false, error: t('disconnectFailed'), code: 'transaction_invalid' };
    }

    try {
        await everIdAPI.disconnect(id);
    } catch (error) {
        console.error('Ever ID could not be disconnected:', error);
        const failure = toEverIdFailure(error);
        if (failure.code === 'transaction_invalid') {
            // No code of its own (a 404: already gone, or not this account's).
            return { success: false, error: t('disconnectFailed'), code: failure.code };
        }
        return failureResult(failure);
    }

    revalidatePath(ROUTES.DASHBOARD_SETTINGS_SECURITY);
    return { success: true };
}

/**
 * "Sign in again" (S15): end the stale session and return to Settings after the
 * fresh sign-in, so connecting can start over.
 */
export async function signInAgainToConnectEverId(): Promise<void> {
    await endEverWorksSession();

    const query = new URLSearchParams({
        [REDIRECT_SEARCH_PARAM]: ROUTES.DASHBOARD_SETTINGS_SECURITY,
    });
    redirect(`${ROUTES.AUTH_LOGIN}?${query.toString()}`);
}

// =================
// Sign out (S7)
// =================

/**
 * Whether the current session was opened with Ever ID: the provider's end-session
 * address when it was, `null` on any other answer (a `404` means it was not).
 * The sign-out menu shows "Also sign out of Ever ID" only for a non-null answer.
 */
export async function getEverIdLogoutUrl(): Promise<string | null> {
    try {
        const response = await everIdAPI.logoutUrl();
        return toProviderUrl(response.url);
    } catch {
        return null;
    }
}

/**
 * "Sign out" with "Also sign out of Ever ID" ticked: the same sign-out `logout()`
 * performs, then the provider's end-session page, which returns to
 * `/api/auth/ever-id/logout-return` with the `state` remembered here.
 *
 * The end-session address is asked for again (before the session ends — the
 * route needs it) rather than accepted from the browser. If it cannot be had,
 * the person is still signed out of Ever Works and lands on the sign-in page.
 */
export async function logoutWithEverId(): Promise<void> {
    let endSession: { url: string; state: string } | null = null;
    try {
        const response = await everIdAPI.logoutUrl();
        if (
            typeof response.state !== 'string' ||
            response.state.length === 0 ||
            response.state.length > LOGOUT_STATE_MAX_LENGTH
        ) {
            throw new Error('Ever ID answered without a usable sign-out state');
        }
        endSession = { url: toProviderUrl(response.url), state: response.state };
    } catch (error) {
        console.error('Ever ID sign-out unavailable; signing out of Ever Works only:', error);
    }

    await endEverWorksSession();

    if (!endSession) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    await setEverIdLogoutState(endSession.state);
    redirect(endSession.url);
}

// =================
// Administrator surface (spec §6.7, T51)
// =================

const KNOWN_CHECKS: ReadonlySet<string> = new Set<string>(EVER_ID_CHECK_IDS);

/** Keep only well-formed check rows (a 409 body is data, not trusted shape). */
function toChecks(raw: unknown): EverIdCheck[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((row): EverIdCheck[] => {
        if (!row || typeof row !== 'object') return [];
        const { id, ok } = row as { id?: unknown; ok?: unknown };
        if (typeof id !== 'string' || !KNOWN_CHECKS.has(id) || typeof ok !== 'boolean') {
            return [];
        }
        return [{ id: id as EverIdCheckId, ok }];
    });
}

/** **Test connection** — one row per FR-3 check. Platform administrators only. */
export async function testEverIdConnection(): Promise<EverIdAdminTestResult> {
    try {
        return { success: true, checks: toChecks(await everIdAPI.adminTest()) };
    } catch (error) {
        console.error('Ever ID connection test failed to run:', error);
        const t = await getTranslations('dashboard.settings.admin.everId');
        return { success: false, error: t('testFailed') };
    }
}

/**
 * **Turn on**. The API runs the connection test first and answers
 * `409 connection_test_failed` with the rows when a required check fails.
 */
export async function enableEverId(): Promise<EverIdAdminToggleResult> {
    const t = await getTranslations('dashboard.settings.admin.everId');
    try {
        const status = await everIdAPI.adminEnable();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_ADMIN_EVER_ID);
        return { success: true, status };
    } catch (error) {
        console.error('Ever ID could not be turned on:', error);
        if (
            error instanceof EverIdRequestError &&
            error.status === 409 &&
            error.code === 'connection_test_failed'
        ) {
            return {
                success: false,
                error: t('enableBlocked'),
                checks: toChecks(error.body?.checks),
            };
        }
        return { success: false, error: t('actionFailed') };
    }
}

/** **Turn off**. Listing, disconnecting and sign-out notices keep working (FR-5). */
export async function disableEverId(): Promise<EverIdAdminToggleResult> {
    const t = await getTranslations('dashboard.settings.admin.everId');
    try {
        const status = await everIdAPI.adminDisable();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_ADMIN_EVER_ID);
        return { success: true, status };
    } catch (error) {
        console.error('Ever ID could not be turned off:', error);
        return { success: false, error: t('actionFailed') };
    }
}

const SETTINGS_LIMITS = EVER_ID_ADMIN_SETTINGS_LIMITS;

const clientIdSchema = z.string().trim().min(1).max(SETTINGS_LIMITS.clientIdMaxLength);

/**
 * The `PATCH /admin/settings` body, checked before it travels: only the four
 * administrator-managed values (an unknown field is refused here, as the API
 * would), each within the API's bounds. `null` clears the account address.
 */
const settingsPatchSchema = z
    .object({
        displayName: z.string().trim().min(1).max(SETTINGS_LIMITS.displayNameMaxLength),
        accountManagementUrl: z
            .string()
            .trim()
            .max(SETTINGS_LIMITS.accountManagementUrlMaxLength)
            .regex(EVER_ID_HTTPS_URL_PATTERN)
            .nullable(),
        localClients: z
            .array(
                z
                    .object({ kind: z.enum(EVER_ID_LOCAL_CLIENT_KINDS), clientId: clientIdSchema })
                    .strict(),
            )
            .max(SETTINGS_LIMITS.localClientsMax),
        delegatedClientNames: z
            .array(
                z
                    .object({
                        clientId: clientIdSchema,
                        displayName: z
                            .string()
                            .trim()
                            .min(1)
                            .max(SETTINGS_LIMITS.delegatedDisplayNameMaxLength),
                    })
                    .strict(),
            )
            .max(SETTINGS_LIMITS.delegatedClientNamesMax),
    })
    .partial()
    .strict();

/**
 * **Save settings** — the administrator-managed values (display name, account
 * management address, terminal clients, app names). The API answers the new
 * status, which the page re-renders from, and records an Activity row naming
 * the fields it changed. A refused value is one plain line; the API's own
 * validation messages are never forwarded.
 */
export async function saveEverIdSettings(
    input: EverIdAdminSettingsPatch,
): Promise<EverIdAdminSettingsResult> {
    const t = await getTranslations('dashboard.settings.admin.everId.settings');

    const parsed = settingsPatchSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: t('invalid') };
    }

    try {
        const status = await everIdAPI.adminSettings(parsed.data);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_ADMIN_EVER_ID);
        return { success: true, status };
    } catch (error) {
        console.error('Ever ID settings could not be saved:', error);
        if (error instanceof EverIdRequestError && error.status === 400) {
            return { success: false, error: t('invalid') };
        }
        return { success: false, error: t('failed') };
    }
}
