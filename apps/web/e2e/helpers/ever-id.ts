import type { APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    makeTestUser,
    registerUserViaAPI,
    type RegisteredUser,
} from './api';

/**
 * APW-12 (Ever ID) — the Playwright helper for the `ever-id-*` suites (T48).
 *
 * The lane starts the fixture provider (`e2e/fakes/ever-id/server.mjs`) before the
 * API and points the API at it (`EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID`,
 * `EVER_ID_CLIENT_SECRET`, `EVER_ID_API_AUDIENCE` in the e2e workflow). Ever ID is
 * still OFF at boot — exactly as on any installation — so this helper turns it on
 * through the administrator route (the same call the administration page makes) with
 * a bootstrap platform admin, and every suite turns it off again in `afterAll`, so no
 * other spec ever sees the button.
 *
 * The suites skip themselves when `EVER_ID_E2E_FAKE_URL` is not set: a lane without
 * the fixture provider must not fail them.
 */

/** The fixture provider's control base URL, or `null` when this lane has none. */
export const EVER_ID_FAKE_CONTROL_URL = process.env.EVER_ID_E2E_FAKE_URL ?? null;

/** Whether the Ever ID suites can run in this lane. */
export const everIdLaneAvailable = (): boolean => !!EVER_ID_FAKE_CONTROL_URL;

/** The person the fixture provider approves next. */
export interface EverIdFakeUser {
    subject: string;
    email: string;
    emailVerified?: boolean;
    name?: string;
}

async function control<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
    if (!EVER_ID_FAKE_CONTROL_URL) throw new Error('EVER_ID_E2E_FAKE_URL is not set');
    const response =
        data === undefined
            ? await request.get(`${EVER_ID_FAKE_CONTROL_URL}${path}`)
            : await request.post(`${EVER_ID_FAKE_CONTROL_URL}${path}`, { data });
    if (!response.ok()) {
        throw new Error(
            `Ever ID fake control ${path} failed (${response.status()}): ${await response.text()}`,
        );
    }
    return (await response.json()) as T;
}

/** Make the fixture provider approve this person next. */
export async function setEverIdUser(
    request: APIRequestContext,
    user: EverIdFakeUser,
): Promise<void> {
    await control(request, '/_control/user', user);
}

/** Extra claims the fixture provider puts on the next ID tokens (`{}` clears them). */
export async function setEverIdClaims(
    request: APIRequestContext,
    claims: Record<string, unknown>,
): Promise<void> {
    await control(request, '/_control/claims', claims);
}

/** The provider session id the next tokens carry. */
export async function setEverIdSessionId(request: APIRequestContext, sid: string): Promise<void> {
    await control(request, '/_control/sid', { sid });
}

/** Have the fixture provider send a back-channel sign-out notice to the API. */
export async function sendEverIdSignOutNotice(
    request: APIRequestContext,
    input: { subject?: string; sid?: string; jti?: string },
): Promise<{ status: number; body: string; cacheControl: string | null }> {
    return control(request, '/_control/backchannel-logout', {
        url: `${API_BASE}/api/auth/ever-id/backchannel-logout`,
        ...input,
    });
}

/** A unique fixture identity, so suites never collide on a subject or an address. */
export function makeEverIdUser(prefix = 'everid'): EverIdFakeUser {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return {
        subject: `${prefix}-subject-${suffix}`,
        email: `${prefix}-${suffix}@test.local`,
        emailVerified: true,
        name: `Ever ${suffix}`,
    };
}

/**
 * A password account whose onboarding wizard is already dismissed, so the wizard's
 * modal never covers the page the suite clicks on (the same server-side dismissal
 * `global-setup.ts` does for the seeded user).
 */
export async function registerPasswordAccount(
    request: APIRequestContext,
    prefix: string,
): Promise<RegisteredUser> {
    const account = await registerUserViaAPI(request, makeTestUser(prefix));
    await request
        .post(`${API_BASE}/api/onboarding/dismiss`, {
            headers: authedHeaders(account.access_token),
        })
        .catch(() => undefined);
    return account;
}

let adminToken: string | null = null;

/**
 * A platform admin's session: the lane's `EVER_WORKS_BOOTSTRAP_PLATFORM_ADMIN_EMAILS`
 * pattern (`e2e-admin-*@test.local`) elevates the account at registration.
 */
async function platformAdmin(request: APIRequestContext): Promise<string> {
    if (adminToken) return adminToken;
    // `e2e-admin-everid-<suffix>@test.local` matches the lane's bootstrap pattern.
    const registered = await registerUserViaAPI(request, makeTestUser('e2e-admin-everid'));
    adminToken = registered.access_token;
    return adminToken;
}

/** Turn Ever ID on (runs Test connection first). Throws when the API refuses. */
export async function enableEverId(request: APIRequestContext): Promise<void> {
    const token = await platformAdmin(request);
    const response = await request.post(`${API_BASE}/api/auth/ever-id/admin/enable`, {
        headers: authedHeaders(token),
    });
    if (!response.ok()) {
        throw new Error(`enableEverId failed (${response.status()}): ${await response.text()}`);
    }
}

/** Turn Ever ID off again. Never throws (it runs in `afterAll`). */
export async function disableEverId(request: APIRequestContext): Promise<void> {
    try {
        const token = await platformAdmin(request);
        await request.post(`${API_BASE}/api/auth/ever-id/admin/disable`, {
            headers: authedHeaders(token),
        });
    } catch {
        // Best effort — a lane whose API is gone has nothing to turn off.
    }
}

/** Configure the terminal clients the device exchange accepts. */
export async function setEverIdLocalClients(
    request: APIRequestContext,
    localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>,
): Promise<void> {
    const token = await platformAdmin(request);
    const response = await request.patch(`${API_BASE}/api/auth/ever-id/admin/settings`, {
        headers: authedHeaders(token),
        data: { localClients },
    });
    if (!response.ok()) {
        throw new Error(
            `setEverIdLocalClients failed (${response.status()}): ${await response.text()}`,
        );
    }
}
