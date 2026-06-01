import { test, expect } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    loginViaAPI,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-account-deletion-deep — COMPLEX, cross-feature INTEGRATION flows for the
 * account-deletion / anonymization / grace-window contract.
 *
 * ── Probed live (127.0.0.1:3100) before writing ───────────────────────────────
 *
 * THERE IS NO SELF-DELETE REST ENDPOINT. Every conventional shape 404s (verified
 * live, authed AND unauthed):
 *   DELETE /api/account              → 404
 *   POST   /api/account/delete       → 404
 *   POST   /api/auth/delete-account  → 404
 *   DELETE /api/auth/profile         → 404
 * The `api/account` controller (apps/api/src/account/account.controller.ts) is
 * export / import / github-sync ONLY — deletion is intentionally not wired
 * server-side. Because nothing deletes, the account is fully PRESERVED: login
 * keeps returning 200, profile keeps resolving, owned Works survive.
 *
 * THE DANGER-ZONE UI IS A DELIBERATE NO-OP. apps/web/src/components/settings/
 * DangerZone.tsx renders under /{locale}/settings/danger (i18n ns
 * `dashboard.dangerZone`). The destructive button is double-gated:
 *   - `Delete My Account` (delete.button) reveals a confirm panel with 5 items.
 *   - The final `Yes, Delete My Account` (delete.confirmButton) stays DISABLED
 *     until the typed value === the REAL fresh-profile email.
 *   - On confirm, the server action `deleteAccount()` (apps/web/src/app/actions/
 *     settings.ts) returns { success:false, error:"Account deletion is disabled
 *     in demo" }. A *successful* delete would router.push(ROUTES.AUTH_REGISTER =
 *     '/register'); because it's refused, the user STAYS on /settings/danger.
 *   - A `Cancel` (delete.cancel) button collapses the panel and clears the
 *     typed email.
 *
 * RE-REGISTER AFTER "DELETION": since the email is never freed, re-registering
 * the same email → 409 { message:"User with this email already exists" }. The
 * original credentials still authenticate.
 *
 * ANONYMIZATION + GRACE WINDOW (the platform's only real "soft account
 * lifecycle"): POST /api/auth/anonymous mints a session whose profile carries
 * `isAnonymous:true`, `registrationProvider:'anonymous'`, `email:null`, and a
 * forward-dated `anonymousExpiresAt` (a real grace/expiry window ~3 days out).
 * POST /api/auth/claim (authed, body {email,password,username}) converts an
 * anonymous account → permanent (`isAnonymous:false`, `registrationProvider:
 * 'local'`, `anonymousExpiresAt:null`) — the "cancel the grace clock" analogue.
 * Claiming a NON-anonymous (already-permanent) account → 403.
 *
 * SESSION TEARDOWN = the real "revoke all access" analogue. Bearer tokens are
 * opaque 32/43-char session strings (NOT JWTs). POST /api/auth/logout
 * invalidates the calling session (profile → 401 after). POST /api/auth/
 * logout-all invalidates EVERY session for the user (all tokens → 401). Neither
 * deletes the account: a fresh login re-issues a working session.
 *
 * Mutations run on FRESH registerUserViaAPI() users; the seeded storageState
 * user is used ONLY for UI-driven assertions. Assertions tolerate pre-existing
 * rows (toContain / >= / .or()), use generous timeouts + toPass retry loops for
 * the next-dev hydration race, and never hard-require a delivered email.
 */

const DELETE_ENDPOINTS = [
    { method: 'DELETE', path: '/api/account' },
    { method: 'POST', path: '/api/account/delete' },
    { method: 'POST', path: '/api/auth/delete-account' },
    { method: 'DELETE', path: '/api/auth/profile' },
] as const;

function originFrom(baseURL: string | undefined): string {
    return baseURL ?? 'http://localhost:3000';
}

test.describe('flow: account deletion — initiate/confirm/grace + anonymization contract', () => {
    test('deletion is DOUBLE-GATED in the UI then SERVER-REFUSED — the grace contract preserves the account end-to-end', async ({
        page,
        request,
    }) => {
        // The danger-zone page reads the user from GET /api/auth/profile/fresh,
        // so the confirm-email gate is wired to the REAL account email of the
        // seeded (storageState) user.
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const fresh = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(access_token),
        });
        expect(fresh.status(), 'account exists before any deletion attempt').toBe(200);
        const profileEmail = (await fresh.json()).email as string;
        expect(profileEmail, 'fresh profile carries the seeded email').toBe(seeded.email);

        // Step 1 — open the danger zone (hydration-racey under next dev).
        await page.goto('/en/settings/danger', { waitUntil: 'domcontentloaded' });
        const deleteBtn = page.getByRole('button', { name: /delete my account/i }).first();
        await expect(deleteBtn, 'destructive entry button mounts').toBeVisible({ timeout: 30_000 });

        // Step 2 — reveal the confirm panel. Retry-to-open: the first click is
        // frequently swallowed pre-hydration.
        const confirmInput = page.getByPlaceholder(/enter your email/i);
        await expect(async () => {
            if (!(await confirmInput.isVisible().catch(() => false))) {
                await deleteBtn.click();
            }
            await expect(confirmInput).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // Step 3 — the confirm panel enumerates EXACTLY what a real delete would
        // destroy. We assert the cascade copy is present (account/profile +
        // works), proving the destructive scope is surfaced to the user.
        const panelText = (await page.locator('body').innerText()).toLowerCase();
        expect(
            panelText.includes('permanently delete') || panelText.includes('this will permanently'),
            'confirm panel states the destructive, irreversible scope',
        ).toBe(true);
        expect(
            panelText.includes('account') && panelText.includes('works'),
            'cascade scope enumerates account + works (owned-resource destruction)',
        ).toBe(true);

        // Step 4 — Gate #1: the final button is DISABLED before any input, and
        // stays disabled for a WRONG email (no navigation occurs).
        const confirmBtn = page.getByRole('button', { name: /yes, delete my account/i }).first();
        await expect(confirmBtn, 'destructive button gated before input').toBeDisabled();
        await confirmInput.fill('definitely-not-the-account@example.com');
        await expect(confirmBtn, 'wrong email keeps it disabled').toBeDisabled();
        await expect(page, 'no navigation on a mismatch').toHaveURL(/\/settings\/danger/);

        // Step 5 — Gate #2: typing the EXACT fresh-profile email un-gates it.
        await confirmInput.fill(profileEmail);
        await expect(confirmBtn, 'exact-email match enables deletion').toBeEnabled({
            timeout: 10_000,
        });

        // Step 6 — confirm. The SERVER action is a no-op → { success:false }. The
        // UI surfaces an error toast and DOES NOT redirect to /register (which a
        // *successful* delete would do). The durable invariant is the absence of
        // that navigation; toast copy is transient/i18n-dependent.
        await confirmBtn.click();
        await page.waitForTimeout(1_500);
        await expect(page, 'deletion refused server-side — NOT redirected to /register').toHaveURL(
            /\/settings\/danger/,
        );
        await expect(page, 'still NOT on the register page').not.toHaveURL(/\/register(\/|$|\?)/);

        // Step 7 — END-TO-END grace proof: the account is fully intact. Login
        // still works and the profile still resolves to the same email.
        const reLogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(reLogin.status(), 'account survived the deletion attempt — login works').toBe(200);
        const reFresh = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders((await reLogin.json()).access_token),
        });
        expect(reFresh.status()).toBe(200);
        expect((await reFresh.json()).email, 'same surviving account').toBe(seeded.email);
    });

    test('a user with OWNED resources (Works + API key) cannot be cascade-deleted — every endpoint 404s and nothing is partially destroyed', async ({
        request,
    }) => {
        // Fresh, isolated user so the owned-resource cascade assertions are clean.
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // Own two Works (the primary cascade target the confirm panel enumerates).
        const stamp = Date.now();
        const workA = await createWorkViaAPI(request, user.access_token, {
            name: `Del Cascade A ${stamp}`,
            slug: `del-cascade-a-${stamp}`,
        });
        const workB = await createWorkViaAPI(request, user.access_token, {
            name: `Del Cascade B ${stamp}`,
            slug: `del-cascade-b-${stamp}`,
        });
        expect(workA.id, 'work A created').toBeTruthy();
        expect(workB.id, 'work B created').toBeTruthy();

        // Own an API key too (best-effort — endpoint may be gated differently).
        const keyRes = await request.post(`${API_BASE}/api/auth/api-keys`, {
            headers: H,
            data: { name: `del-cascade-key-${stamp}` },
        });
        const ownsApiKey = keyRes.status() < 300;

        // Attempt EVERY deletion shape with the owner's bearer. A real cascade
        // delete would return 2xx/4xx-with-effect; here every shape 404s because
        // the endpoint does not exist — so the cascade can never fire.
        for (const ep of DELETE_ENDPOINTS) {
            const res =
                ep.method === 'DELETE'
                    ? await request.delete(`${API_BASE}${ep.path}`, { headers: H })
                    : await request.post(`${API_BASE}${ep.path}`, { headers: H, data: {} });
            expect(
                [404, 405],
                `${ep.method} ${ep.path} must 404/405 (no self-delete endpoint)`,
            ).toContain(res.status());
        }

        // Owned Works SURVIVED — no partial cascade. The works list is
        // { status, works, total, limit, offset }.
        const works = await request.get(`${API_BASE}/api/works`, { headers: H });
        expect(works.status(), 'owner can still list works').toBe(200);
        const listed = (await works.json()).works as Array<{ id: string }>;
        const ids = listed.map((w) => w.id);
        expect(ids, 'Work A survived the deletion attempts').toContain(workA.id);
        expect(ids, 'Work B survived the deletion attempts').toContain(workB.id);

        // API key (if created) survived too.
        if (ownsApiKey) {
            const keys = await request.get(`${API_BASE}/api/auth/api-keys`, { headers: H });
            if (keys.status() === 200) {
                const keysText = await keys.text();
                expect(
                    keysText.includes(`del-cascade-key-${stamp}`),
                    'owned API key survived (no cascade)',
                ).toBe(true);
            }
        }

        // And the account record itself survived — login still works.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(login.status(), 'owner account intact after delete attempts').toBe(200);
    });

    test('CANCEL in the grace panel collapses the confirm UI, clears the typed email, and leaves the account untouched', async ({
        page,
        request,
    }) => {
        const seeded = loadSeededTestUser();

        await page.goto('/en/settings/danger', { waitUntil: 'domcontentloaded' });
        const deleteBtn = page.getByRole('button', { name: /delete my account/i }).first();
        await expect(deleteBtn).toBeVisible({ timeout: 30_000 });

        // Open the confirm panel (retry-to-open for the hydration race).
        const confirmInput = page.getByPlaceholder(/enter your email/i);
        await expect(async () => {
            if (!(await confirmInput.isVisible().catch(() => false))) {
                await deleteBtn.click();
            }
            await expect(confirmInput).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // Type the EXACT email so the destructive button is armed — then back out.
        await confirmInput.fill(seeded.email);
        const confirmBtn = page.getByRole('button', { name: /yes, delete my account/i }).first();
        await expect(confirmBtn, 'armed before cancel').toBeEnabled({ timeout: 10_000 });

        // Click Cancel (delete.cancel). The component sets showDeleteConfirm=false
        // AND confirmEmail=''. Retry-to-click for the dev hydration race.
        const cancelBtn = page.getByRole('button', { name: /^cancel$/i }).first();
        await expect(async () => {
            if (await confirmInput.isVisible().catch(() => false)) {
                await cancelBtn.click();
            }
            await expect(confirmInput, 'confirm input torn down by Cancel').toBeHidden({
                timeout: 3_000,
            });
        }).toPass({ timeout: 20_000 });

        // The destructive confirm button is gone and the entry button is back.
        await expect(confirmBtn, 'destructive button removed on cancel').toBeHidden();
        await expect(deleteBtn, 'entry button restored after cancel').toBeVisible({
            timeout: 10_000,
        });
        await expect(page, 'cancel never navigated anywhere').toHaveURL(/\/settings\/danger/);

        // Re-opening shows a CLEARED input (cancel wiped confirmEmail) — the
        // destructive button must be re-disabled, proving no leaked armed state.
        await expect(async () => {
            if (!(await confirmInput.isVisible().catch(() => false))) {
                await deleteBtn.click();
            }
            await expect(confirmInput).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });
        await expect(confirmInput, 'reopened panel has an empty email field').toHaveValue('');
        await expect(
            page.getByRole('button', { name: /yes, delete my account/i }).first(),
            're-disabled because the typed email was cleared on cancel',
        ).toBeDisabled();

        // And the account is provably untouched at the API layer.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.status(), 'cancelled flow left the account fully intact').toBe(200);
    });

    test('RE-REGISTER after a deletion attempt is blocked with 409 — the email is never freed because nothing was deleted', async ({
        request,
    }) => {
        // Register, then run every deletion shape (all 404 → account preserved).
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const ep of DELETE_ENDPOINTS) {
            const res =
                ep.method === 'DELETE'
                    ? await request.delete(`${API_BASE}${ep.path}`, { headers: H })
                    : await request.post(`${API_BASE}${ep.path}`, {
                          headers: H,
                          data: { password: user.password, confirm: user.email },
                      });
            expect([404, 405]).toContain(res.status());
        }

        // Re-registering the SAME email → 409 conflict (the email was never
        // released, so the original account still owns it).
        const dup = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: `dup-${Date.now()}`,
                email: user.email,
                password: 'AnotherPass1!secure',
            },
        });
        expect(dup.status(), 're-register same email → conflict').toBe(409);
        const dupBody = await dup.json();
        expect(
            JSON.stringify(dupBody).toLowerCase(),
            'truthful "already exists" conflict message',
        ).toContain('already exists');

        // The ORIGINAL credentials still authenticate — definitive proof the
        // account survived the deletion attempts intact.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(login.status(), 'original credentials still valid').toBe(200);

        // A genuinely DIFFERENT email still registers fine (the 409 was specific
        // to the existing account, not a global registration block).
        const other = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: `fresh-${Date.now()}`,
                email: `fresh-after-del-${Date.now()}@test.local`,
                password: 'FreshPass1!secure',
            },
        });
        expect(other.status(), 'a new, unused email still registers').toBeLessThan(300);
    });

    test('ANONYMIZED account exposes a real grace/expiry window, and CLAIM converts it to permanent (cancelling the grace clock); claiming a permanent account is refused', async ({
        request,
    }) => {
        // An anonymous account is the platform's only soft, time-boxed account
        // state — the closest real analogue to a "deleted / grace-period" record.
        const anonRes = await request.post(`${API_BASE}/api/auth/anonymous`, { data: {} });
        expect(anonRes.status(), 'anonymous session minted').toBeLessThan(300);
        const anon = await anonRes.json();
        const anonToken = anon.access_token as string;
        expect(anonToken, 'anonymous bearer issued').toBeTruthy();

        const anonProfileRes = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(anonToken),
        });
        expect(anonProfileRes.status()).toBe(200);
        const anonProfile = await anonProfileRes.json();
        expect(anonProfile.isAnonymous, 'account is flagged anonymous').toBe(true);
        expect(anonProfile.registrationProvider).toBe('anonymous');
        expect(anonProfile.email, 'anonymous account has no email yet').toBeFalsy();

        // The grace window: anonymousExpiresAt is a real, FORWARD-DATED instant.
        expect(anonProfile.anonymousExpiresAt, 'a grace/expiry window exists').toBeTruthy();
        const expiresAt = new Date(anonProfile.anonymousExpiresAt as string).getTime();
        expect(Number.isFinite(expiresAt), 'expiry parses as a real date').toBe(true);
        expect(
            expiresAt,
            'expiry is in the future (still inside the grace window)',
        ).toBeGreaterThan(Date.now());

        // CLAIM = cancel the grace clock: convert anon → permanent.
        const claimEmail = `claimed-${Date.now()}@test.local`;
        const claimPassword = 'ClaimedPass1!secure';
        const claimRes = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(anonToken),
            data: { email: claimEmail, password: claimPassword, username: `claimed${Date.now()}` },
        });
        expect(claimRes.status(), 'anonymous account claimed successfully').toBeLessThan(300);

        // Post-claim the profile is permanent: the grace clock is cancelled.
        const claimedProfile = await (
            await request.get(`${API_BASE}/api/auth/profile/fresh`, {
                headers: authedHeaders(anonToken),
            })
        ).json();
        expect(claimedProfile.isAnonymous, 'no longer anonymous after claim').toBe(false);
        expect(claimedProfile.registrationProvider, 'promoted to a local account').toBe('local');
        expect(claimedProfile.anonymousExpiresAt, 'grace clock cleared').toBeFalsy();
        expect(claimedProfile.email, 'now carries the claimed email').toBe(claimEmail);

        // The claimed identity can authenticate with real credentials.
        const claimedLogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: claimEmail, password: claimPassword },
        });
        expect(claimedLogin.status(), 'claimed account logs in like any permanent user').toBe(200);

        // Claiming a NON-anonymous (already-permanent) account is REFUSED — you
        // cannot re-anonymize / re-claim a settled account. Live: 403.
        const permUser = await registerUserViaAPI(request);
        const claimPerm = await request.post(`${API_BASE}/api/auth/claim`, {
            headers: authedHeaders(permUser.access_token),
            data: {
                email: `reclaim-${Date.now()}@test.local`,
                password: 'ReclaimPass1!secure',
                username: `reclaim${Date.now()}`,
            },
        });
        expect([400, 403, 409], 'claim on an already-permanent account is rejected').toContain(
            claimPerm.status(),
        );
        expect(claimPerm.status(), 'specifically not a 5xx').toBeLessThan(500);
    });

    test('session teardown is the real "revoke all access" path: logout-all invalidates EVERY session, yet the account record survives a fresh login', async ({
        request,
        browser,
        baseURL,
    }) => {
        // Two concurrent sessions for one fresh user (e.g. two devices).
        const user = await registerUserViaAPI(request);
        const s1 = await loginViaAPI(request, { email: user.email, password: user.password });
        const s2 = await loginViaAPI(request, { email: user.email, password: user.password });
        expect(s1.access_token, 'two distinct opaque session tokens').not.toBe(s2.access_token);

        // Both sessions are live.
        expect(
            (
                await request.get(`${API_BASE}/api/auth/profile`, {
                    headers: authedHeaders(s1.access_token),
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/auth/profile`, {
                    headers: authedHeaders(s2.access_token),
                })
            ).status(),
        ).toBe(200);

        // logout-all = the fleet-wide "kill every session" action a deletion flow
        // would perform. Both tokens go dead (401) — total access revocation.
        const wipe = await request.post(`${API_BASE}/api/auth/logout-all`, {
            headers: authedHeaders(s1.access_token),
        });
        expect(wipe.status(), 'logout-all accepted').toBe(200);

        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${API_BASE}/api/auth/profile`, {
                            headers: authedHeaders(s1.access_token),
                        })
                    ).status(),
                { timeout: 10_000 },
            )
            .toBe(401);
        expect(
            (
                await request.get(`${API_BASE}/api/auth/profile`, {
                    headers: authedHeaders(s2.access_token),
                })
            ).status(),
            'the OTHER device session was also revoked',
        ).toBe(401);

        // CRITICAL distinction from deletion: the ACCOUNT still exists. A fresh
        // login re-issues a working session — access revoked, identity preserved.
        const relogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(relogin.status(), 'account survives a full session wipe — relogin works').toBe(200);
        const reToken = (await relogin.json()).access_token as string;
        expect(
            (
                await request.get(`${API_BASE}/api/auth/profile`, {
                    headers: authedHeaders(reToken),
                })
            ).status(),
            'the re-issued session is fully usable',
        ).toBe(200);

        // UI cross-check: with NO auth cookie, the danger zone is unreachable and
        // redirects to login — a deleted/revoked visitor cannot reach destructive
        // settings. Bare newContext() inherits the storageState cookie, so pass an
        // EMPTY storageState to get a genuinely anonymous context.
        const anonCtx = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const anonPage = await anonCtx.newPage();
            const origin = originFrom(baseURL);
            await anonPage.goto(`${origin}/en/settings/danger`, {
                waitUntil: 'domcontentloaded',
            });
            await anonPage.waitForTimeout(1_500);
            // next-dev local vs CI route divergence: tolerate either a redirect to
            // /login OR a rendered-but-gated page that lacks the destructive button.
            const url = anonPage.url();
            const onLogin = /\/login/.test(url) || /\/sign-in/.test(url);
            const dangerBtnVisible = await anonPage
                .getByRole('button', { name: /delete my account/i })
                .first()
                .isVisible()
                .catch(() => false);
            expect(
                onLogin || !dangerBtnVisible,
                'an unauthenticated visitor cannot reach the account-deletion affordance',
            ).toBe(true);
        } finally {
            await anonCtx.close();
        }
    });
});
