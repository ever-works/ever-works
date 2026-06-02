import {
    test,
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
} from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * flow-settings-security-deep — the /settings SECURITY surface exercised as deep,
 * multi-step, cross-feature INTEGRATION flows that drive the real UI components
 * (SecuritySettings, ApiKeysSettings, DangerZone) AND verify the side-effects
 * against the live API. The theme is "account-security control plane": password
 * change, API-key management, 2FA / active-sessions surfaces, danger-zone gating.
 *
 * ── PROBED GROUND TRUTH (2026-06-01, CI sqlite driver @ 127.0.0.1:3100) ──────
 *
 * ROUTES (next-intl, /en prefix; unprefixed also resolves):
 *   /settings           → ProfileSettings  (settings index, NOT a dashboard)
 *   /settings/security   → <SecuritySettings/>  — ONLY a change-password form today.
 *   /settings/api-keys   → <ApiKeysSettings initialKeys={…}/> — table + create/revoke dialogs.
 *   /settings/danger     → <DangerZone/> — disabled data-export + delete-account gate.
 *
 * PASSWORD CHANGE — server action `updatePassword` → POST /api/auth/update-password
 *   DTO {currentPassword, newPassword}; @UseGuards(AuthSessionGuard). PROBED:
 *     unauth                       → 401
 *     wrong currentPassword        → 401 {message:"Current password is incorrect"}
 *     weak/short newPassword       → 400 (DTO: MinLength 8 + /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/)
 *     correct currentPassword      → 200 {message:"Password updated successfully"};
 *                                    NEW password then logs in (200 + token), OLD → 401.
 *   The SecuritySettings.tsx client ALSO guards BEFORE the request (toast.error, no POST):
 *     any empty field → "Please fill in all password fields"
 *     newPassword.length < 8 → "New password must be at least 8 characters"
 *     new !== confirm → "New passwords do not match"
 *     new === current → "New password must be different from current password"
 *   A "Show passwords" checkbox flips all three inputs type=password ⇄ text.
 *
 * API KEYS — server actions createApiKey/revokeApiKey → /api/auth/api-keys.
 *   POST {name, expiresAt?} → 201 {id,name,key:"ew_live_<64hex>",prefix:"ew_live_<4hex>",
 *         expiresAt,createdAt}. The plaintext `key` is returned ONCE (reveal-once dialog).
 *   GET  → 200 [{id,name,prefix,expiresAt,lastUsedAt,isActive,createdAt}] (NO secret; masked).
 *   DELETE :id → 200 {message} when owner-match else 404 (also 404 on re-revoke / random uuid).
 *   PROBED guards: name missing → 400; past expiresAt → 400 "Expiration date must be in the
 *   future"; cap MAX_KEYS_PER_USER=10 → 400 "Maximum of 10 API keys allowed per user".
 *   PROBED credential power: a freshly-minted `ew_live_…` key authenticates protected
 *   endpoints via BOTH `Authorization: Bearer <key>` AND `x-api-key: <key>` (200 on
 *   /api/auth/profile and /api/works); after DELETE the same key → 401 immediately.
 *   API keys are SESSION-INDEPENDENT: a session logout / logout-all does NOT kill a key.
 *
 * 2FA + ACTIVE SESSIONS — "Coming Soon". The i18n keys
 *   dashboard.settings.security.{twoFactor,sessions} EXIST but are NOT wired into the
 *   rendered SecuritySettings component, and the API exposes NO 2FA / session-list
 *   surface — PROBED 404 (authed) on /api/auth/{sessions,sessions/list,two-factor/status,
 *   2fa/status,two-factor/enable,totp/setup}. So those legs assert the truthful CURRENT
 *   state (no enroll / no session-list control surface) and skip-up the moment a real
 *   endpoint lands — never a fictional contract.
 *
 * DANGER ZONE — `deleteAccount` server action is INTENTIONALLY a no-op in this build:
 *   it returns {success:false, error:"Account deletion is disabled in demo"} WITHOUT
 *   calling any delete API. So the testable contract is the GATE, not the deletion:
 *   the confirm button stays disabled until the typed email === the account email
 *   exactly; clicking it surfaces the "disabled" error toast and the account SURVIVES
 *   (login still works). The data-export button is permanently `disabled`.
 *
 * ── ANTI-DUPLICATION ─────────────────────────────────────────────────────────
 * Deliberately NOT re-covered (already deep elsewhere):
 *   - security-settings.spec.ts → password form has ≥3 inputs + the API 401/4xx/200
 *     change-password contract (single-axis). This file adds the CLIENT-side
 *     validation MATRIX, the show-passwords toggle, and the UI→API rotation roundtrip.
 *   - flow-api-keys-lifecycle / flow-api-key-scope-enforcement → API-level key
 *     lifecycle, expiry, isolation, scope, header precedence, masking. This file is
 *     the UI-DRIVEN create-dialog/reveal-once/revoke-dialog management + the cap UI.
 *   - flow-2fa-state-machine / security-2fa / recovery-codes → 2FA endpoint probes.
 *     This file asserts the security-PAGE's absence of a 2FA/session control surface.
 *   - flow-account-deletion-deep / account-deletion-flow → the deletion API/flow.
 *     This file is the danger-zone UI GATING state machine (disabled-action contract).
 *
 * RESILIENCE: fresh Date.now-suffixed users for every MUTATION (never the shared
 * seeded user — a password change or key churn would break sibling specs); the seeded
 * `page` fixture is used ONLY for read-only UI smoke where the disabled delete action
 * cannot harm it. Clean browser contexts (empty storageState) for fresh-user UI so the
 * inherited seeded auth cookie can't leak. Generous timeouts, .first(), retry-to-open
 * for hydration-race dialogs, toContain over exact counts, status-band tolerance.
 */

const T = 30_000;
const LOGIN = `${API_BASE}/api/auth/login`;
const PROFILE = `${API_BASE}/api/auth/profile`;
const LOGOUT_ALL = `${API_BASE}/api/auth/logout-all`;
const API_KEYS = `${API_BASE}/api/auth/api-keys`;

const ORIGINAL_PASSWORD = 'TestPass1!secure';

/** Resolve the web origin from the Playwright baseURL fixture. */
function webOrigin(baseURL: string | undefined): string {
    return (baseURL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/** Authentication cookies the Next web app sets after a successful API login. */
async function loginGetTokens(
    request: APIRequestContext,
    creds: { email: string; password: string },
): Promise<{ access_token: string }> {
    const res = await request.post(LOGIN, { data: creds, timeout: T });
    expect(res.status(), `login ${creds.email}`).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(typeof body.access_token).toBe('string');
    return body;
}

/** /profile status — our session/key liveness oracle (no list endpoint exists). */
async function profileStatus(
    request: APIRequestContext,
    token: string,
    header: 'bearer' | 'x-api-key' = 'bearer',
): Promise<number> {
    const headers = header === 'bearer' ? authedHeaders(token) : { 'x-api-key': token };
    const res = await request.get(PROFILE, { headers, timeout: T });
    return res.status();
}

/** Open a settings sub-route as a FRESH (non-seeded) user in a clean context. */
async function freshUserPage(
    browser: Browser,
    creds: { email: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await loginViaUI(page, creds);
    return { context, page };
}

/**
 * A FRESH (never-onboarded) user is greeted by the first-run onboarding wizard,
 * which renders as a modal OVERLAY on top of every dashboard route (PROBED
 * 2026-06-01: a fresh login lands on `/` with a `role="dialog"` wizard whose
 * panel covers the settings form/buttons — `input[type=password]` stays fillable
 * but the "Update password" / "Create API Key" actions are pointer-intercepted,
 * so a bare `.click()` hangs to the 90s test timeout). It exposes a "Close wizard"
 * button. The seeded storageState user has already completed onboarding, so the
 * button is absent there — hence this is a best-effort no-op for that case.
 */
async function dismissOnboardingWizard(page: Page): Promise<void> {
    const closeWizard = page.getByRole('button', { name: /close wizard/i }).first();
    // The wizard hydrates a beat after the route settles, so poll a short window
    // for it to APPEAR before concluding it is absent (the seeded user, who has
    // finished onboarding, simply exhausts this poll as a no-op).
    let present = false;
    for (let i = 0; i < 12; i++) {
        if ((await closeWizard.count()) > 0) {
            present = true;
            break;
        }
        await page.waitForTimeout(300);
    }
    if (!present) return;
    // Close it (retry — a first click can be swallowed pre-hydration) and wait
    // for the overlay panel to detach so it no longer intercepts pointer events.
    for (let attempt = 0; attempt < 3; attempt++) {
        if ((await closeWizard.count()) === 0) return;
        await closeWizard.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(600);
    }
}

/** Navigate to a settings route, recovering from a transient cold auth-redirect. */
async function gotoSettings(page: Page, route: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }
    await page.waitForTimeout(800);
    // Clear the fresh-user onboarding overlay that would otherwise intercept
    // pointer events over the settings actions below (no-op for the seeded user).
    await dismissOnboardingWizard(page);
}

test.describe('flow-settings-security-deep', () => {
    /**
     * FLOW 1 — Change-password CLIENT-side validation MATRIX on /settings/security.
     *
     * Every guard in SecuritySettings.tsx fires a toast and BLOCKS the POST before
     * the network. We drive the real form for a FRESH user (clean context) and walk
     * each branch: empty fields, too-short, mismatch, same-as-current — asserting the
     * exact i18n message AND that the password did NOT actually rotate (the original
     * still authenticates at the API after every rejected attempt).
     */
    test('password-change form blocks invalid input with the right toast and never rotates the credential', async ({
        browser,
        request,
    }) => {
        const u = makeTestUser('sec-pwval');
        const account = await registerUserViaAPI(request, { email: u.email });
        const { context, page } = await freshUserPage(browser, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });

        try {
            await gotoSettings(page, '/en/settings/security');

            const pw = page.locator('input[type="password"]');
            await expect(pw.first()).toBeVisible({ timeout: T });
            expect(
                await pw.count(),
                'current/new/confirm = 3 password inputs',
            ).toBeGreaterThanOrEqual(3);

            const current = pw.nth(0);
            const next = pw.nth(1);
            const confirm = pw.nth(2);
            const submit = page.getByRole('button', { name: /update password/i }).first();
            await expect(submit).toBeVisible({ timeout: T });

            // Helper: fill the three boxes and submit, RETRYING the gesture until
            // the expected client-side guard toast appears. Every branch here is a
            // pure client guard (no request, no mutation), so re-submitting is fully
            // idempotent — this absorbs the occasional swallowed first click while
            // the page is still settling after the onboarding overlay is dismissed.
            const attempt = async (cur: string, nw: string, cf: string, toast: RegExp) => {
                const guard = page.getByText(toast).first();
                await expect(async () => {
                    await current.fill(cur);
                    await next.fill(nw);
                    await confirm.fill(cf);
                    await submit.click();
                    await expect(guard).toBeVisible({ timeout: 8_000 });
                }).toPass({ timeout: T });
            };

            // (a) all empty → "fill in all password fields"
            await attempt('', '', '', /fill in all password fields/i);

            // (b) too short → "at least 8 characters"
            await attempt(ORIGINAL_PASSWORD, 'short1', 'short1', /at least 8 characters/i);

            // (c) mismatch → "do not match"
            await attempt(ORIGINAL_PASSWORD, 'BrandNew9!ok', 'BrandNew9!NOPE', /do not match/i);

            // (d) same-as-current → "must be different from current"
            await attempt(
                ORIGINAL_PASSWORD,
                ORIGINAL_PASSWORD,
                ORIGINAL_PASSWORD,
                /different from current/i,
            );

            // The page never left /security and the credential is untouched.
            await expect(page).toHaveURL(/\/settings\/security/);
            expect(
                await profileStatus(
                    request,
                    (
                        await loginGetTokens(request, {
                            email: account.email,
                            password: ORIGINAL_PASSWORD,
                        })
                    ).access_token,
                ),
                'original password still authenticates — no rotation happened',
            ).toBe(200);
        } finally {
            await context.close();
        }
    });

    /**
     * FLOW 2 — End-to-end password ROTATION through the UI, verified at the API.
     *
     * A valid change in the SecuritySettings form must (1) clear the inputs +
     * surface the success toast, (2) actually rotate the login credential server-side
     * (NEW password → 200 login, OLD password → 401), and (3) NOT evict the live
     * session that performed the change (changePassword does not signOutAll). Fresh
     * user + clean context so we never mutate the shared seeded account.
     */
    test('valid password change clears the form, rotates the credential at the API, and keeps the live session', async ({
        browser,
        request,
    }) => {
        const u = makeTestUser('sec-pwrot');
        const account = await registerUserViaAPI(request, { email: u.email });
        const newPassword = 'Rotated9!secure';

        // A side session that should SURVIVE the password change (no global logout).
        const side = await loginGetTokens(request, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });
        expect(
            await profileStatus(request, side.access_token),
            'side session live pre-change',
        ).toBe(200);

        const { context, page } = await freshUserPage(browser, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });

        try {
            await gotoSettings(page, '/en/settings/security');

            const pw = page.locator('input[type="password"]');
            await expect(pw.first()).toBeVisible({ timeout: T });

            const submit = page.getByRole('button', { name: /update password/i }).first();
            const successToast = page.getByText(/password updated successfully/i).first();

            // Fill + submit, retrying the whole gesture: immediately after the
            // onboarding overlay is dismissed the page can still be settling, so a
            // first submit click is occasionally swallowed (PROBED: no request, no
            // toast). The retry is idempotent — `toPass` exits the instant the
            // success toast renders, so the re-fill only runs when NO rotation has
            // happened yet (the original password is therefore still current).
            await expect(async () => {
                await pw.nth(0).fill(ORIGINAL_PASSWORD);
                await pw.nth(1).fill(newPassword);
                await pw.nth(2).fill(newPassword);
                await submit.click();
                await expect(successToast).toBeVisible({ timeout: 12_000 });
            }).toPass({ timeout: 40_000 });

            // The form clears (controlled inputs reset to '').
            await expect(pw.nth(0)).toHaveValue('', { timeout: 8_000 });

            // API truth: new password works, old password is dead.
            await expect
                .poll(
                    async () =>
                        (
                            await request.post(LOGIN, {
                                data: { email: account.email, password: newPassword },
                            })
                        ).status(),
                    { message: 'new password should authenticate (200)', timeout: 15_000 },
                )
                .toBe(200);
            expect(
                (
                    await request.post(LOGIN, {
                        data: { email: account.email, password: ORIGINAL_PASSWORD },
                    })
                ).status(),
                'old password must be rejected',
            ).toBe(401);

            // changePassword does NOT global-logout: the side session is still alive.
            expect(
                await profileStatus(request, side.access_token),
                'live session survives a password change',
            ).toBe(200);
        } finally {
            await context.close();
        }
    });

    /**
     * FLOW 3 — API-key MANAGEMENT through the settings UI: create-dialog → reveal-once
     * secret → masked list row → revoke-dialog, with the revealed key proven to be a
     * REAL credential at the API and proven DEAD after the UI revoke.
     *
     * This is the UI surface of the key lifecycle (the API-level lifecycle lives in
     * flow-api-keys-lifecycle). The create/revoke calls run inside Next SERVER actions
     * (`server-only` fetch to API_URL), so the browser never sees the /api/auth/api-keys
     * request — we read the once-shown plaintext from the rendered reveal `<pre>` and
     * confirm side-effects with the `request` API client, the real observable contract.
     */
    test('create-key dialog reveals a working ew_live_ secret once, lists it masked, and the revoke dialog kills it', async ({
        browser,
        request,
    }) => {
        const u = makeTestUser('sec-keyui');
        const account = await registerUserViaAPI(request, { email: u.email });
        const keyName = `UI Key ${Date.now().toString(36)}`;

        const { context, page } = await freshUserPage(browser, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });

        try {
            await gotoSettings(page, '/en/settings/api-keys');

            // Open the create dialog (retry — first click can be swallowed pre-hydration).
            const createBtn = page.getByRole('button', { name: /create api key/i }).first();
            await expect(createBtn).toBeVisible({ timeout: T });

            const nameField = page.getByPlaceholder(/my integration/i).first();
            await expect(async () => {
                await createBtn.click({ timeout: 5_000 }).catch(() => {});
                await expect(nameField).toBeVisible({ timeout: 5_000 });
            }).toPass({ timeout: T });

            await nameField.fill(keyName);

            await page
                .getByRole('button', { name: /^create$/i })
                .first()
                .click();

            // The reveal-once panel shows the secret + the warning. The secret lives in
            // a <pre> block (createdKey) — read it straight from the DOM (server action,
            // no browser-visible network request to intercept).
            await expect(page.getByText(/be able to see it again/i).first()).toBeVisible({
                timeout: 15_000,
            });
            const secretPre = page
                .locator('pre')
                .filter({ hasText: /ew_live_/ })
                .first();
            await expect(secretPre).toBeVisible({ timeout: 10_000 });
            const revealedKey = ((await secretPre.textContent()) ?? '').trim();
            expect(
                revealedKey.startsWith('ew_live_'),
                'revealed plaintext is an ew_live_ key',
            ).toBe(true);
            expect(revealedKey.length, 'ew_live_ + 64 hex chars').toBeGreaterThan(60);

            // The minted key is a real credential: authenticates via Bearer AND x-api-key.
            expect(await profileStatus(request, revealedKey, 'bearer'), 'key auths as Bearer').toBe(
                200,
            );
            expect(
                await profileStatus(request, revealedKey, 'x-api-key'),
                'key auths as x-api-key',
            ).toBe(200);

            // Cross-check the masked list contract via the API client: the row exists,
            // carries the non-secret prefix fingerprint, and NEVER echoes the plaintext.
            const listJson = (await (
                await request.get(API_KEYS, {
                    headers: authedHeaders(account.access_token),
                    timeout: T,
                })
            ).json()) as Array<{ id: string; name: string; prefix: string }>;
            const mine = listJson.find((k) => k.name === keyName);
            expect(mine, 'created key appears in the owner list').toBeTruthy();
            expect(
                revealedKey.startsWith(mine!.prefix),
                'prefix is a real fingerprint of the key',
            ).toBe(true);
            expect(
                JSON.stringify(listJson).includes(revealedKey),
                'the list response never leaks the secret',
            ).toBe(false);
            const keyId = mine!.id;

            // Close the dialog; the new row appears in the table, MASKED (prefix… only).
            await page
                .getByRole('button', { name: /^done$/i })
                .first()
                .click();
            await expect(page.getByText(keyName).first()).toBeVisible({ timeout: 10_000 });
            await expect(page.getByText(`${mine!.prefix}...`).first()).toBeVisible({
                timeout: 10_000,
            });
            // The full secret is NOT rendered anywhere in the masked list.
            await expect(page.getByText(revealedKey, { exact: true })).toHaveCount(0);

            // Revoke via the trash → confirm dialog → row removed; key dies at the API.
            const row = page.getByRole('row').filter({ hasText: keyName }).first();
            const trash = row.getByRole('button').last();
            await expect(async () => {
                await trash.click({ timeout: 5_000 }).catch(() => {});
                await expect(page.getByRole('button', { name: /^revoke$/i }).first()).toBeVisible({
                    timeout: 5_000,
                });
            }).toPass({ timeout: T });

            await page
                .getByRole('button', { name: /^revoke$/i })
                .first()
                .click();

            // The row is removed from the table optimistically...
            await expect(page.getByText(keyName)).toHaveCount(0, { timeout: 12_000 });
            // ...and the key is genuinely revoked server-side (401) + gone from the list.
            await expect
                .poll(async () => profileStatus(request, revealedKey, 'bearer'), {
                    message: 'revoked key must stop authenticating (401)',
                    timeout: 15_000,
                })
                .toBe(401);
            const afterList = (await (
                await request.get(API_KEYS, {
                    headers: authedHeaders(account.access_token),
                    timeout: T,
                })
            ).json()) as Array<{ id: string }>;
            expect(
                afterList.some((k) => k.id === keyId),
                'revoked key is gone from the list',
            ).toBe(false);
        } finally {
            await context.close();
        }
    });

    /**
     * FLOW 4 — DANGER-ZONE gating state machine on /settings/danger.
     *
     * The deleteAccount server action is a deliberate no-op (returns the "disabled"
     * error without calling any delete API), so the real contract is the GATE: the
     * confirm button is disabled until the typed email matches EXACTLY, a wrong email
     * is rejected, and clicking the (enabled) button surfaces the "disabled" toast
     * while the account SURVIVES. Run on a FRESH user so even an accidental deletion
     * could never harm the seeded account; we then prove the account still logs in.
     */
    test('delete-account gate stays disabled until email matches, then the disabled action keeps the account alive', async ({
        browser,
        request,
    }) => {
        const u = makeTestUser('sec-danger');
        const account = await registerUserViaAPI(request, { email: u.email });

        const { context, page } = await freshUserPage(browser, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });

        try {
            await gotoSettings(page, '/en/settings/danger');

            // The data-export button is permanently disabled (coming soon).
            const exportBtn = page.getByRole('button', { name: /export data/i }).first();
            if (await exportBtn.count()) {
                await expect(exportBtn).toBeDisabled();
            }

            // Expand the delete confirmation panel (retry pre-hydration).
            const openDelete = page.getByRole('button', { name: /delete my account/i }).first();
            await expect(openDelete).toBeVisible({ timeout: T });
            const emailField = page.getByPlaceholder(/enter your email/i).first();
            await expect(async () => {
                await openDelete.click({ timeout: 5_000 }).catch(() => {});
                await expect(emailField).toBeVisible({ timeout: 5_000 });
            }).toPass({ timeout: T });

            // The confirm button (separate from the opener) is disabled while empty.
            const confirmBtn = page
                .getByRole('button', { name: /yes, delete my account/i })
                .first();
            await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
            await expect(confirmBtn).toBeDisabled();

            // A WRONG email keeps it disabled.
            await emailField.fill(`not-${account.email}`);
            await page.waitForTimeout(400);
            await expect(confirmBtn).toBeDisabled();

            // The EXACT email enables it.
            await emailField.fill(account.email);
            await expect(confirmBtn).toBeEnabled({ timeout: 8_000 });

            // Clicking the enabled-but-disabled-server-action button surfaces the
            // "disabled in demo" error toast — and the account is NOT deleted.
            await confirmBtn.click();
            const errorToast = page.getByText(/disabled in demo/i).first();
            const failToast = page.getByText(/failed to delete account/i).first();
            await expect(errorToast.or(failToast)).toBeVisible({ timeout: 12_000 });

            // Ground truth: the account still authenticates after the "delete".
            await expect
                .poll(
                    async () =>
                        (
                            await request.post(LOGIN, {
                                data: { email: account.email, password: ORIGINAL_PASSWORD },
                            })
                        ).status(),
                    { message: 'account must survive the disabled delete (200)', timeout: 15_000 },
                )
                .toBe(200);
        } finally {
            await context.close();
        }
    });

    /**
     * FLOW 5 — The 2FA + ACTIVE-SESSIONS "Coming Soon" reality, asserted truthfully.
     *
     * The /settings/security PAGE renders ONLY a password form: no 2FA enroll control
     * and no active-sessions list/revoke control are wired in, and the API exposes no
     * 2FA or session-list endpoint. We assert the current absence on BOTH surfaces and
     * skip-up the moment a real control/endpoint appears, so this flow auto-upgrades
     * to a genuine enroll/list assertion without ever encoding a fictional contract.
     */
    test('security page exposes no live 2FA-enroll or session-list control, mirroring the absent API surface', async ({
        page,
        request,
        baseURL,
    }) => {
        // --- API surface: every 2FA / session candidate path 404s for a valid bearer.
        const fresh = await registerUserViaAPI(request, { email: makeTestUser('sec-2fa').email });
        const tok = fresh.access_token;
        const candidates = [
            '/api/auth/sessions',
            '/api/auth/sessions/list',
            '/api/auth/two-factor/status',
            '/api/auth/2fa/status',
            '/api/auth/two-factor/enable',
            '/api/auth/totp/setup',
        ];
        let anyExists = false;
        for (const path of candidates) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(tok),
                timeout: T,
            });
            // Never a 5xx; today every candidate is 404. If one starts resolving
            // (2xx/4xx-other), the feature has landed and we flag it for an upgrade.
            expect(res.status(), `${path} should not 5xx`).toBeLessThan(500);
            if (res.status() !== 404) anyExists = true;
        }
        test.skip(
            anyExists,
            'A 2FA/session API surface now resolves — upgrade this flow to assert the real enroll/list contract.',
        );

        // --- UI surface: the security page is just the change-password form.
        await gotoSettings(page, '/en/settings/security');
        await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: T });

        // No interactive 2FA-enable control (the "Coming Soon" i18n is not rendered).
        const enable2fa = page.getByRole('button', {
            name: /enable two-factor|set up 2fa|scan qr|verify code|authenticator/i,
        });
        expect(await enable2fa.count(), 'no live 2FA-enroll control on the security page').toBe(0);

        // No active-session list / revoke control (only logout exists, elsewhere).
        const sessionRevoke = page.getByRole('button', {
            name: /revoke session|sign out device|revoke all sessions|end session/i,
        });
        expect(
            await sessionRevoke.count(),
            'no active-session revoke control on the security page',
        ).toBe(0);

        // Anchor: the page is reachable and stable (no hard error), not a 404/login bounce.
        expect(webOrigin(baseURL)).toContain('http');
        await expect(page).toHaveURL(/\/settings\/security/);
    });

    /**
     * FLOW 6 — CROSS-SURFACE credential integration: API keys vs sessions, and the
     * MAX-KEYS cap surfaced through the create dialog.
     *
     * (a) A key minted in API-keys settings is INDEPENDENT of the session that made
     *     it: a global session logout-all leaves the key fully working — keys are a
     *     separate credential class, only revocation kills them.
     * (b) The MAX_KEYS_PER_USER=10 cap is enforced; the 11th create attempt through
     *     the dialog surfaces the "Maximum of 10" error toast and adds no row.
     *
     * Fresh user (clean context for the UI leg). The cap-filling 10 keys are created
     * via the API for speed; only the 11th (the boundary) is exercised through the UI.
     */
    test('an API key outlives a global session logout, and the 11th key is capped with a truthful error toast', async ({
        browser,
        request,
    }) => {
        const u = makeTestUser('sec-cap');
        const account = await registerUserViaAPI(request, { email: u.email });

        // --- (a) Key independence from the session.
        const session = await loginGetTokens(request, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });
        const minted = await request.post(API_KEYS, {
            headers: authedHeaders(session.access_token),
            data: { name: 'independence-probe' },
            timeout: T,
        });
        expect(minted.status(), 'mint key → 201').toBe(201);
        const independenceKey = ((await minted.json()) as { key: string }).key;
        expect(
            await profileStatus(request, independenceKey, 'bearer'),
            'key live before logout',
        ).toBe(200);

        const logoutAll = await request.post(LOGOUT_ALL, {
            headers: authedHeaders(session.access_token),
            timeout: T,
        });
        expect(logoutAll.status(), 'logout-all → 200').toBe(200);
        expect(
            await profileStatus(request, session.access_token),
            'the session token is dead after logout-all',
        ).toBe(401);
        // The key is a different credential class — it SURVIVES the global logout.
        expect(
            await profileStatus(request, independenceKey, 'bearer'),
            'API key survives a global session logout',
        ).toBe(200);

        // --- (b) Fill to the cap via API (we already have 1 key → create 9 more = 10).
        const fresh = await loginGetTokens(request, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });
        for (let i = 0; i < 9; i++) {
            const r = await request.post(API_KEYS, {
                headers: authedHeaders(fresh.access_token),
                data: { name: `cap-fill-${i}` },
                timeout: T,
            });
            expect(r.status(), `cap-fill ${i} → 201`).toBe(201);
        }
        const listRes = await request.get(API_KEYS, {
            headers: authedHeaders(fresh.access_token),
            timeout: T,
        });
        expect(((await listRes.json()) as unknown[]).length, 'exactly at the cap (10)').toBe(10);

        // The 11th create through the UI dialog must fail with the cap toast.
        const { context, page } = await freshUserPage(browser, {
            email: account.email,
            password: ORIGINAL_PASSWORD,
        });
        try {
            await gotoSettings(page, '/en/settings/api-keys');

            const createBtn = page.getByRole('button', { name: /create api key/i }).first();
            await expect(createBtn).toBeVisible({ timeout: T });
            const nameField = page.getByPlaceholder(/my integration/i).first();
            await expect(async () => {
                await createBtn.click({ timeout: 5_000 }).catch(() => {});
                await expect(nameField).toBeVisible({ timeout: 5_000 });
            }).toPass({ timeout: T });

            await nameField.fill('over-the-cap');
            await page
                .getByRole('button', { name: /^create$/i })
                .first()
                .click();

            // The create runs in a server action (no browser-visible request); the cap
            // rejection surfaces as a truthful error toast — the cap message OR the
            // generic fallback the component maps a failed create to.
            const capToast = page.getByText(/maximum of 10 api keys/i).first();
            const genericToast = page.getByText(/failed to create api key/i).first();
            await expect(capToast.or(genericToast)).toBeVisible({ timeout: 15_000 });

            // The reveal-once panel must NOT appear — nothing was created.
            await expect(page.getByText(/be able to see it again/i)).toHaveCount(0);

            // Still exactly 10 keys server-side — the failed create added nothing.
            const after = await request.get(API_KEYS, {
                headers: authedHeaders(fresh.access_token),
                timeout: T,
            });
            expect(((await after.json()) as unknown[]).length, 'still capped at 10').toBe(10);
        } finally {
            await context.close();
        }
    });
});
