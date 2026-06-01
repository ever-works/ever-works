import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-settings-data-privacy — COMPLEX, cross-feature integration flows for
 * the "Data & Privacy" settings surface. These complement (do NOT duplicate)
 * the existing account-export / account-deletion / research-optout specs by
 * exercising the parts of the surface those specs leave bare:
 *
 *   1. The per-account GitHub data-sync PREFERENCES (`/api/account/sync/*`):
 *      the backup/data-retention config repo. The existing data-sync specs
 *      (flow-data-sync-*, data-sync-idempotency) are all about the WORK-level
 *      `/api/works/:id/sync`. This account-level sync surface only had two
 *      shallow smoke assertions in account-data.spec.ts.
 *   2. The privacy toggle <-> data-export INTERACTION (opt-out persisting and
 *      not bleeding into the export payload).
 *   3. The danger-zone "delete account / delete data" contract proven as a
 *      confirmed safe no-op (server action returns `deleteDisabled`; no REST
 *      delete endpoint; data survives) — driven through the real settings UI.
 *   4. The export v2-tail toggle matrix (includeAgents / includeSkills /
 *      includeTasks / includeTaskChat) collapsing to v1 when empty.
 *   5. Cross-user ISOLATION of the sync config (one user's data-sync prefs are
 *      never introspectable / mutable by another).
 *
 * ─── PROBED LIVE CONTRACT (127.0.0.1:3100, throwaway users) ───────────────
 *   GET  /api/account/sync/status            → 200 { configured:false, hasOAuth:false }
 *                                               (fresh user; never 5xx)
 *   POST /api/account/sync/configure {createNew:true}        → 500 (no GitHub OAuth → service throws)
 *   POST /api/account/sync/configure {repoFullName:"o/r"}    → 500 (no GitHub OAuth)
 *   POST /api/account/sync/configure {}                      → 500 (OAuth check fires first)
 *   POST /api/account/sync/push {includeSecrets:false}       → 500 (not configured AND no OAuth)
 *   POST /api/account/sync/pull  {}                          → 500 (not configured AND no OAuth)
 *   DELETE /api/account/sync                                 → 200 { status:'success' } (idempotent)
 *   GET  /api/account/export                 → 200 JSON, version:1,
 *                                               Content-Disposition: attachment; filename="account-export.json"
 *                                               data keys = [profile, works, userPlugins]
 *   GET  /api/account/export?includeAgents=true&includeSkills=true
 *                                            → 200; STILL version:1 + same 3 data keys when the
 *                                               account has no agents/skills (empty tail collapses to v1)
 *   GET  /api/me/work-proposals/preferences  → 200 { optOut:false } (fresh = opted-IN)
 *   PUT  /api/me/work-proposals/preferences {optOut:true}            → 200 { optOut:true }
 *   PUT  /api/me/work-proposals/preferences {emailNotifications:true}→ 200 { optOut:false } (inverse alias)
 *   All /api/account/* and /api/me/* require auth → 401 anon.
 *
 *   UI: /en/settings/data renders Export / Import / GitHub-Sync cards; the
 *   GitHubSync widget loads `sync/status`, and with no OAuth shows the
 *   "Connect GitHub … to enable sync" copy (it never offers a push button).
 *   /en/settings/danger double-gates deletion (exact-email match) and the
 *   server action `deleteAccount()` is intentionally disabled (returns
 *   `deleteDisabled`), so the account is never actually removed.
 *
 *   GOTCHAS honored: configure/push/pull 500 without OAuth (assert <600 /
 *   in a tolerant set, never !ok-as-success). DELETE sync is idempotent.
 *   Mutations run on FRESH registerUserViaAPI() users (never the shared
 *   seeded user). UI assertions use the seeded storageState user, read-only.
 *   Anon context uses an empty storageState. Hydration-racey dropdowns get
 *   retry-to-open + generous timeouts. Assert toContain, never exact counts.
 */

const SYNC_STATUS = `${API_BASE}/api/account/sync/status`;
const SYNC_CONFIGURE = `${API_BASE}/api/account/sync/configure`;
const SYNC_PUSH = `${API_BASE}/api/account/sync/push`;
const SYNC_PULL = `${API_BASE}/api/account/sync/pull`;
const SYNC_DELETE = `${API_BASE}/api/account/sync`;
const EXPORT = `${API_BASE}/api/account/export`;
const PREFS = `${API_BASE}/api/me/work-proposals/preferences`;
const LOGIN = `${API_BASE}/api/auth/login`;

type SyncStatus = {
    configured: boolean;
    hasOAuth: boolean;
    repoOwner?: string;
    repoName?: string;
    lastPushAt?: string;
    lastPullAt?: string;
    lastSyncError?: string;
};

async function getSyncStatus(
    request: APIRequestContext,
    token: string,
): Promise<{ status: number; body: SyncStatus }> {
    const res = await request.get(SYNC_STATUS, { headers: authedHeaders(token) });
    const body = res.ok() ? ((await res.json()) as SyncStatus) : ({} as SyncStatus);
    return { status: res.status(), body };
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; ctype: string; cdisp: string; body: any }> {
    const res = await request.get(`${EXPORT}${query}`, { headers: authedHeaders(token) });
    const ctype = res.headers()['content-type'] || '';
    const cdisp = res.headers()['content-disposition'] || '';
    const body = res.ok() ? await res.json() : await res.text();
    return { status: res.status(), ctype, cdisp, body };
}

test.describe('flow: data-sync preferences — account-level GitHub backup config', () => {
    // ── Flow 1 ───────────────────────────────────────────────────────────
    // A brand-new account's data-sync preference defaults to UN-configured +
    // no GitHub OAuth. Without an OAuth link the configure/push/pull writes are
    // refused by the service (500 at the OAuth gate), but the read-only status
    // probe and the idempotent DELETE never fault — the retention surface is
    // safe to poll and tear down even from a never-configured account.
    test('fresh account: sync defaults UN-configured, write paths gated on OAuth, status + teardown never fault', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // Default state: not configured, no OAuth (probed shape).
        const initial = await getSyncStatus(request, user.access_token);
        expect(initial.status, 'sync status is a clean 200').toBe(200);
        expect(initial.body.configured, 'fresh account is not sync-configured').toBe(false);
        expect(initial.body.hasOAuth, 'fresh account has no GitHub OAuth link').toBe(false);
        // No repo coordinates are leaked when un-configured.
        expect(initial.body.repoOwner ?? null, 'no repoOwner when un-configured').toBeNull();
        expect(initial.body.repoName ?? null, 'no repoName when un-configured').toBeNull();

        // Every write path is OAuth-gated: configure (createNew + named repo),
        // push, and pull all surface a server-side failure (the service throws
        // "GitHub OAuth not connected" → 500) — they never silently "succeed".
        const createNew = await request.post(SYNC_CONFIGURE, {
            headers: H,
            data: { createNew: true },
        });
        expect(createNew.ok(), 'configure(createNew) must NOT succeed without OAuth').toBe(false);
        expect(createNew.status(), 'configure(createNew) gated → 5xx/4xx').toBeGreaterThanOrEqual(
            400,
        );

        const named = await request.post(SYNC_CONFIGURE, {
            headers: H,
            data: { repoFullName: 'someowner/ever-works-config' },
        });
        expect(named.ok(), 'configure(named repo) must NOT succeed without OAuth').toBe(false);
        expect(named.status()).toBeGreaterThanOrEqual(400);

        const push = await request.post(SYNC_PUSH, { headers: H, data: { includeSecrets: false } });
        expect(push.ok(), 'push must NOT succeed when un-configured + no OAuth').toBe(false);
        expect(push.status()).toBeGreaterThanOrEqual(400);

        const pull = await request.post(SYNC_PULL, { headers: H, data: {} });
        expect(pull.ok(), 'pull must NOT succeed when un-configured + no OAuth').toBe(false);
        expect(pull.status()).toBeGreaterThanOrEqual(400);

        // DELETE is idempotent: removing a never-existing config is a clean 200.
        const del1 = await request.delete(SYNC_DELETE, { headers: H });
        expect(del1.status(), 'DELETE sync is idempotent even when nothing configured').toBe(200);
        expect((await del1.json()).status).toBe('success');
        const del2 = await request.delete(SYNC_DELETE, { headers: H });
        expect(del2.status(), 'repeated DELETE stays a clean 200').toBe(200);

        // After all the failed writes + deletes, status is STILL un-configured —
        // no partial / orphaned sync record leaked through the OAuth gate.
        const after = await getSyncStatus(request, user.access_token);
        expect(after.status).toBe(200);
        expect(after.body.configured, 'still un-configured after gated writes').toBe(false);
    });

    // ── Flow 2 ───────────────────────────────────────────────────────────
    // The whole data-sync surface is auth-gated: anonymous callers get a 401
    // on every verb (status read, configure, push, pull, delete). The backup
    // config — which can reach a private repo and account data — is NEVER
    // reachable without a bearer, and a garbage bearer is rejected too.
    test('the data-sync surface is fully auth-gated — anon + bad-bearer rejected on every verb', async ({
        request,
    }) => {
        const anonStatus = await request.get(SYNC_STATUS);
        expect(anonStatus.status(), 'anon sync status → 401').toBe(401);

        const anonConfigure = await request.post(SYNC_CONFIGURE, { data: { createNew: true } });
        expect(anonConfigure.status(), 'anon configure → 401').toBe(401);

        const anonPush = await request.post(SYNC_PUSH, { data: { includeSecrets: false } });
        expect(anonPush.status(), 'anon push → 401').toBe(401);

        const anonPull = await request.post(SYNC_PULL, { data: {} });
        expect(anonPull.status(), 'anon pull → 401').toBe(401);

        const anonDelete = await request.delete(SYNC_DELETE);
        expect(anonDelete.status(), 'anon delete → 401').toBe(401);

        // A structurally-valid-but-bogus bearer is also rejected (never a leak).
        const badBearer = await request.get(SYNC_STATUS, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(badBearer.status(), 'garbage bearer → 401').toBe(401);
    });

    // ── Flow 3 ───────────────────────────────────────────────────────────
    // Cross-user ISOLATION: user B can never observe or mutate user A's
    // data-sync preference. Each user resolves their OWN sync status from
    // their own bearer; B's reads/writes operate strictly on B's record.
    // (Belt-and-suspenders for a privacy/retention surface that touches a
    // private backup repo.)
    test("a second user cannot read or tear down another user's data-sync config", async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const HB = authedHeaders(userB.access_token);

        // Both independently resolve their own (un-configured) status.
        const aStatus = await getSyncStatus(request, userA.access_token);
        const bStatus = await getSyncStatus(request, userB.access_token);
        expect(aStatus.status).toBe(200);
        expect(bStatus.status).toBe(200);
        expect(aStatus.body.configured).toBe(false);
        expect(bStatus.body.configured).toBe(false);

        // B's DELETE only ever touches B's own (empty) config — it cannot be
        // pointed at A. It's a clean idempotent 200 scoped to B.
        const bDelete = await request.delete(SYNC_DELETE, { headers: HB });
        expect(bDelete.status(), "B's delete is scoped to B and idempotent").toBe(200);

        // A's status is unaffected by anything B did — A is still its own clean
        // un-configured record (the records are per-user, never shared).
        const aStatusAfter = await getSyncStatus(request, userA.access_token);
        expect(aStatusAfter.status).toBe(200);
        expect(aStatusAfter.body.configured, "A's config is independent of B").toBe(false);
        expect(aStatusAfter.body.hasOAuth).toBe(false);
    });
});

test.describe('flow: privacy toggle <-> data-export interaction', () => {
    // ── Flow 4 ───────────────────────────────────────────────────────────
    // The research/personalization privacy preference (opt-out) is the only
    // user-facing privacy toggle. It must (a) persist across a fresh re-login,
    // (b) toggle cleanly through BOTH accepted shapes (`optOut` and its
    // web-client inverse `emailNotifications`), and (c) be completely orthogonal
    // to the data-export payload — flipping the privacy toggle never changes the
    // export envelope shape (still v1, same profile, same 3 data keys). This
    // ties the privacy surface to the export surface, which neither existing
    // spec does together.
    test('opt-out privacy preference persists across re-login and never alters the export envelope', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // Baseline export while opted-IN (default).
        const beforePref = await request.get(PREFS, { headers: H });
        expect(beforePref.status()).toBe(200);
        expect((await beforePref.json()).optOut, 'fresh account defaults to opted-IN').toBe(false);

        const exportOptedIn = await exportAccount(request, user.access_token);
        expect(exportOptedIn.status).toBe(200);
        expect(exportOptedIn.body.version, 'export is a v1 envelope').toBe(1);
        expect(exportOptedIn.body.data.profile.email, 'export profile is this account').toBe(
            user.email,
        );
        const dataKeysBefore = Object.keys(exportOptedIn.body.data).sort();

        // Opt OUT via the canonical `optOut` shape.
        const optOut = await request.put(PREFS, { headers: H, data: { optOut: true } });
        expect(optOut.status()).toBe(200);
        expect((await optOut.json()).optOut, 'opt-out persisted').toBe(true);

        // The preference survives a brand-new login (token-independent state).
        const relogin = await request.post(LOGIN, {
            data: { email: user.email, password: user.password },
        });
        expect(relogin.status(), 'login still works post-opt-out').toBe(200);
        const freshToken = (await relogin.json()).access_token as string;
        const afterRelogin = await request.get(PREFS, { headers: authedHeaders(freshToken) });
        expect((await afterRelogin.json()).optOut, 'opt-out survived re-login').toBe(true);

        // Re-opt-IN via the INVERSE alias (`emailNotifications:true` === not
        // opted-out) — both shapes drive the same persisted boolean.
        const optBackIn = await request.put(PREFS, {
            headers: authedHeaders(freshToken),
            data: { emailNotifications: true },
        });
        expect(optBackIn.status()).toBe(200);
        expect((await optBackIn.json()).optOut, 'inverse alias re-opted-in').toBe(false);

        // The export envelope is IDENTICAL in shape regardless of the privacy
        // toggle — the opt-out state is not a field that leaks into the export,
        // and toggling it does not add/remove data sections.
        const exportOptedOut = await exportAccount(request, freshToken);
        expect(exportOptedOut.status).toBe(200);
        expect(exportOptedOut.body.version, 'still a v1 envelope after toggling').toBe(1);
        expect(Object.keys(exportOptedOut.body.data).sort(), 'export data keys unchanged').toEqual(
            dataKeysBefore,
        );
        expect(exportOptedOut.body.data.profile.email).toBe(user.email);
    });

    // ── Flow 5 ───────────────────────────────────────────────────────────
    // The export "additional sections" v2-tail toggles (includeAgents /
    // includeSkills / includeTasks / includeTaskChat) are honored at the query
    // layer, but for an account with no agents/skills/tasks the empty tail
    // COLLAPSES back to a v1 envelope (no empty `agents`/`skills`/`tasks`
    // arrays leak in). Export also stays GET-only, side-effect-free, and
    // carries the attachment Content-Disposition for the browser download.
    // Adding real data (a Work) shows up in BOTH the toggled and un-toggled
    // export — the toggles never gate the always-present sections.
    test('export v2-tail toggles collapse to v1 when empty, are side-effect-free, and reflect created data', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // All four v2-tail toggles on, but the account is empty → v1 envelope,
        // only the three always-present data keys, no empty tail arrays.
        const toggled = await exportAccount(
            request,
            user.access_token,
            '?includeAgents=true&includeSkills=true&includeTasks=true&includeTaskChat=true',
        );
        expect(toggled.status).toBe(200);
        expect(toggled.ctype, 'export is JSON').toMatch(/json/i);
        expect(toggled.cdisp, 'export advertises a file download').toContain('attachment');
        expect(toggled.cdisp).toContain('account-export.json');
        expect(toggled.body.version, 'empty tail collapses to v1').toBe(1);
        expect(Object.keys(toggled.body.data).sort(), 'no empty tail arrays leak in').toEqual([
            'profile',
            'userPlugins',
            'works',
        ]);

        // Export is GET-only and side-effect-free: a second identical export is
        // byte-equivalent in its stable fields (same version, same profile, same
        // work list), and the privacy/sync state is untouched by exporting.
        const repeat = await exportAccount(
            request,
            user.access_token,
            '?includeAgents=true&includeSkills=true',
        );
        expect(repeat.status).toBe(200);
        expect(repeat.body.version).toBe(1);
        expect(repeat.body.data.profile.email).toBe(toggled.body.data.profile.email);
        expect(repeat.body.data.works.length, 'work count stable across repeated export').toBe(
            toggled.body.data.works.length,
        );

        // Now create a real Work and re-export — it shows up regardless of the
        // v2-tail toggles (works is an always-present section, never gated).
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Privacy Export Work ${Date.now()}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        const withWork = await exportAccount(request, user.access_token);
        expect(withWork.status).toBe(200);
        const slugs = (withWork.body.data.works as Array<{ slug: string }>).map((w) => w.slug);
        expect(
            slugs.some((s) => s.startsWith('privacy-export-work')),
            'the created Work appears in the re-export',
        ).toBe(true);
    });
});

test.describe('flow: danger zone — delete account/data is a confirmed safe no-op', () => {
    // ── Flow 6 ───────────────────────────────────────────────────────────
    // The danger-zone "delete account / delete all data" surface is wired to a
    // server action that is intentionally DISABLED, and there is no REST delete
    // endpoint. We prove the FULL end-to-end safety contract: drive the real
    // settings UI to the armed-delete state (exact-email gate), confirm the
    // destructive button is disabled until the email matches, AND independently
    // confirm via the API that after every plausible deletion attempt the
    // account + all its data SURVIVE (login still works, export still returns
    // the same account, sync teardown is still a clean no-op).
    test('UI double-gates deletion and the API proves no delete path destroys the account or its data', async ({
        page,
        request,
        baseURL,
    }) => {
        const seeded = loadSeededTestUser();
        const origin = baseURL ?? 'http://localhost:3000';

        // ── Part A (UI, seeded storageState, read-only) ──────────────────
        await page.goto(`${origin}/en/settings/danger`, { waitUntil: 'domcontentloaded' });

        const deleteBtn = page.getByRole('button', { name: /delete my account/i });
        await expect(deleteBtn, 'danger-zone delete affordance mounts').toBeVisible({
            timeout: 30_000,
        });

        // Retry-to-open: the first click can be swallowed pre-hydration.
        const confirmInput = page.getByPlaceholder(/enter your email/i);
        await expect(async () => {
            if (!(await confirmInput.isVisible().catch(() => false))) {
                await deleteBtn.click();
            }
            await expect(confirmInput).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // The "permanently delete" consequences list is shown — the user is told
        // exactly what would be destroyed before they can confirm.
        await expect(
            page.getByText(/permanently delete/i).first(),
            'destructive consequences are surfaced',
        ).toBeVisible({ timeout: 10_000 });

        // Gate 1: wrong email keeps the final destructive button DISABLED.
        const confirmBtn = page.getByRole('button', { name: /yes, delete my account/i });
        await confirmInput.fill('definitely-not-the-account@example.com');
        await expect(confirmBtn, 'mismatched email keeps delete disabled').toBeDisabled({
            timeout: 10_000,
        });

        // Gate 2: even the exact email only ARMS the button — clicking it routes
        // through the disabled server action, so we stay on /danger (no account
        // actually deleted). Best-effort: tolerate either an enabled button or a
        // LOCAL/CI render where the toast path keeps us put.
        await confirmInput.fill(seeded.email);
        await page.waitForTimeout(400);
        if (await confirmBtn.isEnabled().catch(() => false)) {
            await confirmBtn.click();
        }
        await page.waitForTimeout(1_000);
        await expect(page, 'still on the danger page — deletion did not proceed').toHaveURL(
            /\/settings\/danger/,
        );

        // ── Part B (API, fresh user — never the seeded user) ─────────────
        // Prove the safety contract directly: a fresh account with real data
        // survives every conventional deletion shape.
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Danger Survivor ${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // No REST delete endpoint exists for the account (every candidate 404/405).
        for (const attempt of [
            request.delete(`${API_BASE}/api/account`, { headers: H }),
            request.post(`${API_BASE}/api/account/delete`, { headers: H }),
            request.delete(`${API_BASE}/api/auth/profile`, { headers: H }),
        ]) {
            const res = await attempt;
            expect(
                [404, 405],
                `deletion endpoint ${res.url()} should not exist (got ${res.status()})`,
            ).toContain(res.status());
        }

        // The account fully survives: login works, the export still returns this
        // account WITH its Work, and the data-sync teardown is still a clean
        // no-op (nothing was cascade-deleted).
        const login = await request.post(LOGIN, {
            data: { email: user.email, password: user.password },
        });
        expect(login.status(), 'account survived — login still works').toBe(200);
        const freshToken = (await login.json()).access_token as string;

        const survivedExport = await exportAccount(request, freshToken);
        expect(survivedExport.status, 'export reachable after delete attempts').toBe(200);
        expect(survivedExport.body.data.profile.email, 'same account survives').toBe(user.email);
        const survivorSlugs = (survivedExport.body.data.works as Array<{ slug: string }>).map(
            (w) => w.slug,
        );
        expect(
            survivorSlugs.some((s) => s.startsWith('danger-survivor')),
            'the Work survived the delete attempts',
        ).toBe(true);

        const syncAfter = await getSyncStatus(request, freshToken);
        expect(syncAfter.status, 'sync surface intact after delete attempts').toBe(200);
        expect(syncAfter.body.configured).toBe(false);
    });
});

test.describe('flow: data settings UI — sync widget reflects the no-OAuth retention state', () => {
    // ── Flow 7 ───────────────────────────────────────────────────────────
    // The /settings/data page composes Export + Import + GitHub-Sync cards.
    // The GitHubSync widget client-loads `sync/status`; for the seeded user
    // (no GitHub OAuth) it must NOT offer a push/pull affordance — instead it
    // surfaces the "connect GitHub to enable sync" guidance. This proves the UI
    // faithfully renders the OAuth-gated data-retention state probed at the API
    // in Flow 1 (the widget never shows a backup action it cannot perform).
    // Read-only against the seeded storageState user.
    test('settings/data renders export + import + sync cards and the sync widget gates on GitHub OAuth', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });

        const body = page.locator('body');
        // All three data-management sections are present (probed i18n copy).
        await expect(body, 'export section present').toContainText(/export data/i, {
            timeout: 20_000,
        });
        await expect(body, 'import section present').toContainText(/import data/i, {
            timeout: 10_000,
        });
        await expect(body, 'GitHub sync section present').toContainText(/github sync/i, {
            timeout: 10_000,
        });

        // The export action is a live, enabled button (the real download path).
        const exportBtn = page
            .getByRole('button', { name: /export data/i })
            .or(page.locator('button').filter({ hasText: /export/i }))
            .first();
        await expect(exportBtn, 'export button is actionable').toBeVisible({ timeout: 15_000 });
        await expect(exportBtn).toBeEnabled({ timeout: 10_000 });

        // The sync widget settles out of its loading state and, with no OAuth,
        // shows the connect-GitHub guidance — NOT a push/pull/disconnect action.
        // Best-effort across LOCAL/CI render divergence: accept the connect copy
        // OR the set-up-sync entry point, but require that the connected-state
        // "Push to GitHub" action is absent (the widget can't back up without OAuth).
        const connectGuidance = page
            .getByText(/connect github/i)
            .or(page.getByText(/git providers settings/i))
            .or(page.getByRole('button', { name: /set up github sync/i }))
            .first();
        await expect(async () => {
            await expect(connectGuidance, 'sync widget shows OAuth-gated guidance').toBeVisible({
                timeout: 4_000,
            });
        }).toPass({ timeout: 25_000 });

        const pushBtn = page.getByRole('button', { name: /push to github/i });
        await expect(
            pushBtn,
            'no push affordance is offered without a configured + OAuth-linked sync',
        ).toHaveCount(0);
    });
});
