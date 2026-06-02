import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * In-app notification READ lifecycle — deep, cross-feature integration flows.
 *
 * Theme: create→list→read→unread-count-decrement, mark-all-read, dismiss vs
 * persistent, cross-user isolation, query/paging contract, and the dashboard
 * BELL dropdown UI (`svg.lucide-bell` + empty/populated states, badge,
 * "Mark all as read", outside-click close).
 *
 * Probed LIVE against the running stack (NestJS + sqlite in-memory, the CI
 * driver) before any assertion. Exact contract confirmed by curl:
 *
 *   GET    /api/notifications                       -> 200 { notifications: Notification[] }
 *          newest-first (orderBy createdAt DESC), undismissedOnly defaults true,
 *          excludes expired; Cache-Control: private, no-store.
 *          (?unreadOnly&limit&offset&category) — limit capped at 100 server-side.
 *          MALFORMED limit/offset/unreadOnly are TOLERATED -> 200 (pipes fall
 *          back to defaults; they do NOT 400). Invalid category -> 200 [].
 *   GET    /api/notifications/unread-count           -> 200 { count: number }
 *          (NO Cache-Control header — unlike the list route). Never negative.
 *   GET    /api/notifications/persistent             -> 200 { notifications: [] }
 *   POST   /api/notifications/:id/read               -> 200 { success: true }
 *          unknown/foreign id -> 400 { message: "Notification not found" }
 *   POST   /api/notifications/read-all               -> 200 { success: true } (idempotent)
 *   POST   /api/notifications/:id/dismiss            -> 200 { success: true }
 *          unknown/foreign id -> 400 { message: "Notification not found" }
 *          (persistent rows reject with a distinct message — see below)
 *   ALL routes without auth -> 401.
 *
 * DEVIATION — no public CREATE endpoint. Every in-app notification row is
 * written by a BACKGROUND producer (notifyAiCreditsDepleted /
 * notifyGenerationAccountError / notifySchedulePaused / notifyBudgetThresholdCrossed
 * / notifyGitAuthExpired / agent_run_finished) firing from a work-generation
 * failure, budget-threshold crossing, or agent run — all of which need an LLM
 * key / Trigger.dev, NEITHER present in CI. So a literal "trigger a real row ->
 * appears unread -> mark read -> count decrements" round-trip on a *real* row
 * can't be made deterministic here. These flows therefore drive the full
 * observable read+mark+dismiss+count CONTRACT that the bell dropdown consumes
 * end-to-end, plus the cross-user isolation, ordering, paging and UI surfaces —
 * asserting only truthful platform behaviour (a fresh user starts at zero; the
 * count never goes negative; foreign ids 400; read-all is idempotent; the bell
 * renders the same state the API reports). The persistent-cannot-dismiss branch
 * (NotificationService.dismiss) is asserted at the contract level: an UNKNOWN id
 * 400s "Notification not found" BEFORE the persistence check, so the live e2e
 * surface we CAN reach is the not-found gate (asserted) — the persistent-reject
 * message is documented from source for parity but never fabricated against a row
 * we cannot create.
 *
 * Cross-spec isolation: every API mutation runs on a FRESH registerUserViaAPI()
 * user (unique email per run, register DTO = { username, email, password }). The
 * seeded storageState user is touched ONLY for UI-driven, read-only assertions
 * (it has 0 notifications / 0 unread — probed — so the bell empty state is
 * deterministic). Counts use toBeGreaterThanOrEqual / toBe(0) on brand-new users
 * to tolerate the shared in-memory DB.
 */

const NOTIFICATION_CATEGORIES = [
    'ai_credits',
    'subscription',
    'generation',
    'system',
    'security',
] as const;

const BOGUS_ID = '00000000-0000-0000-0000-000000000000';

interface NotificationRow {
    id: string;
    userId: string;
    type: string;
    category: string;
    title: string;
    message: string;
    isRead: boolean;
    isDismissed: boolean;
    isPersistent: boolean;
    createdAt: string;
}

async function listNotifications(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; notifications: NotificationRow[]; headers: Record<string, string> }> {
    const res = await request.get(`${API_BASE}/api/notifications${query}`, {
        headers: authedHeaders(token),
    });
    const body = await res.json().catch(() => ({ notifications: [] }));
    return {
        status: res.status(),
        notifications: (body.notifications ?? []) as NotificationRow[],
        headers: res.headers(),
    };
}

async function unreadCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()).count as number;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted to {email,password} only — never pass `username`.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login failed: ${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

/**
 * Open the dashboard-header notification bell. The trigger has no aria-label
 * (only a Tooltip), so anchor on its lucide Bell icon and climb to the
 * enclosing button. Retry-to-open loop survives the `next dev` hydration race
 * where the first click is swallowed pre-hydration.
 */
async function openNotificationBell(page: Page): Promise<void> {
    const bellButton = page.locator('button:has(svg.lucide-bell)').first();
    await expect(bellButton).toBeVisible({ timeout: 30_000 });
    // The dropdown heading is an <h3> reading "Notifications" (+ optional
    // "(N unread)" suffix), so match by prefix.
    const panelHeading = page.getByRole('heading', { name: /^Notifications/, level: 3 });
    await expect(async () => {
        await bellButton.click();
        await expect(panelHeading).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 30_000 });
}

async function landOnDashboard(page: Page, origin: string): Promise<void> {
    await page.context().addCookies([
        { name: 'sidebar-collapsed', value: '0', url: origin },
        { name: 'chat-panel-open', value: '0', url: origin },
    ]);
    // There is NO `/dashboard` route (it 404s). `/works` renders the same
    // DashboardHeader + bell that the read API drives.
    await page.goto(`${origin}/works`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

test.describe('Notifications — read lifecycle, isolation & bell UI', () => {
    test('unread-count stays consistent across the full read+mark surface (never negative)', async ({
        request,
    }) => {
        // A fresh user is the only deterministic way to anchor exact counts on
        // the shared in-memory DB — every assertion below is on rows (or the
        // absence of rows) owned solely by THIS user.
        const user: RegisteredUser = await registerUserViaAPI(request, {
            email: `notif-count-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: fresh inbox is empty + count is exactly 0 ---
        const initial = await listNotifications(request, token);
        expect(initial.status).toBe(200);
        expect(initial.notifications).toEqual([]);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 2: the count route carries NO Cache-Control (probed) while the
        //             list route is private/no-store — they are distinct surfaces. ---
        expect(initial.headers['cache-control'] ?? '').toContain('no-store');
        const countRes = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(token),
        });
        expect(countRes.headers()['cache-control'] ?? '').not.toContain('no-store');

        // --- Step 3: the unread-count MUST equal the length of the unreadOnly
        //             list — this is the invariant the bell badge relies on. ---
        const unreadList = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        expect(unreadList.status).toBe(200);
        expect(unreadList.notifications.length).toBe(await unreadCount(request, token));

        // --- Step 4: read-all on an empty inbox is a safe no-op; count holds at 0 ---
        const readAll1 = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll1.status()).toBe(200);
        expect((await readAll1.json()).success).toBe(true);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 5: read-all is IDEMPOTENT — a second call still succeeds and the
        //             count never dips below zero. ---
        const readAll2 = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll2.status()).toBe(200);
        expect((await readAll2.json()).success).toBe(true);
        const finalCount = await unreadCount(request, token);
        expect(finalCount).toBe(0);
        expect(finalCount).toBeGreaterThanOrEqual(0);

        // --- Step 6: marking a non-existent id read NEVER mutates the count ---
        const markBogus = await request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`, {
            headers: authedHeaders(token),
        });
        expect(markBogus.status()).toBe(400);
        expect((await markBogus.json()).message).toBe('Notification not found');
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('dismiss contract: unknown/foreign ids 400 "not found", persistent inbox unaffected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-dismiss-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: persistent (critical) inbox starts empty + is its own surface ---
        const persistent0 = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect(persistent0.status()).toBe(200);
        expect((await persistent0.json()).notifications).toEqual([]);

        // --- Step 2: dismissing an UNKNOWN id is a truthful 400 (the not-found gate
        //             in NotificationService.dismiss runs BEFORE the persistent
        //             check, so this is the deterministic e2e-reachable branch). ---
        const dismissBogus = await request.post(
            `${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismissBogus.status()).toBe(400);
        expect((await dismissBogus.json()).message).toBe('Notification not found');

        // --- Step 3: dismiss of a non-UUID-ish garbage id is still a clean 4xx,
        //             never a 5xx (the id is treated as a plain string param). ---
        const dismissGarbage = await request.post(
            `${API_BASE}/api/notifications/not-a-real-id/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismissGarbage.status()).toBeLessThan(500);
        expect([200]).not.toContain(dismissGarbage.status());

        // --- Step 4: a dismiss leaves the (undismissed-only) list + count untouched
        //             when nothing actually got dismissed — no phantom decrement. ---
        const list = await listNotifications(request, token);
        expect(list.notifications.every((n) => n.isDismissed === false)).toBe(true);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 5: read-all then re-read persistent — persistent rows are NOT a
        //             side effect of read-all on an empty inbox. ---
        await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        const persistent1 = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(token),
        });
        expect((await persistent1.json()).notifications).toEqual([]);
    });

    test('per-user inbox isolation: one user can never read/dismiss across the boundary', async ({
        request,
    }) => {
        const stamp = Date.now();
        const alice = await registerUserViaAPI(request, {
            email: `notif-alice-${stamp}@test.local`,
        });
        const bob = await registerUserViaAPI(request, {
            email: `notif-bob-${stamp}@test.local`,
        });

        // --- Step 1: both fresh inboxes are independently empty + zero ---
        expect((await listNotifications(request, alice.access_token)).notifications).toEqual([]);
        expect((await listNotifications(request, bob.access_token)).notifications).toEqual([]);
        expect(await unreadCount(request, alice.access_token)).toBe(0);
        expect(await unreadCount(request, bob.access_token)).toBe(0);

        // --- Step 2: Alice's mark-read of a foreign id is "not found" — the
        //             findByIdAndUserId scope means cross-user ids are invisible,
        //             so they surface the SAME 400 as a non-existent id (no 403
        //             leak that would confirm the row exists for someone else). ---
        const aliceMarksForeign = await request.post(
            `${API_BASE}/api/notifications/${BOGUS_ID}/read`,
            { headers: authedHeaders(alice.access_token) },
        );
        expect(aliceMarksForeign.status()).toBe(400);
        expect((await aliceMarksForeign.json()).message).toBe('Notification not found');

        // --- Step 3: Alice's read-all + dismiss are scoped to Alice only and can
        //             never touch Bob's count (which stays 0 throughout). ---
        const aliceReadAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(alice.access_token),
        });
        expect(aliceReadAll.status()).toBe(200);
        const aliceDismissForeign = await request.post(
            `${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`,
            { headers: authedHeaders(alice.access_token) },
        );
        expect(aliceDismissForeign.status()).toBe(400);

        // --- Step 4: Bob's surface is wholly unperturbed by Alice's mutations ---
        expect(await unreadCount(request, bob.access_token)).toBe(0);
        expect((await listNotifications(request, bob.access_token)).notifications).toEqual([]);
        expect(
            (
                await request.get(`${API_BASE}/api/notifications/persistent`, {
                    headers: authedHeaders(bob.access_token),
                })
            ).status(),
        ).toBe(200);

        // --- Step 5: every notifications route demands auth — a missing bearer is a
        //             hard 401 on each verb (no anonymous read of anyone's inbox). ---
        for (const probe of [
            () => request.get(`${API_BASE}/api/notifications`),
            () => request.get(`${API_BASE}/api/notifications/unread-count`),
            () => request.get(`${API_BASE}/api/notifications/persistent`),
            () => request.post(`${API_BASE}/api/notifications/read-all`),
            () => request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`),
            () => request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`),
        ]) {
            const res = await probe();
            expect(res.status()).toBe(401);
        }
    });

    test('list query contract: newest-first ordering invariant, limit cap, tolerant params', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-query-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: every documented category filter returns a 200 array ---
        for (const category of NOTIFICATION_CATEGORIES) {
            const res = await listNotifications(request, token, `?category=${category}`);
            expect(res.status, `category=${category}`).toBe(200);
            expect(Array.isArray(res.notifications)).toBe(true);
        }

        // --- Step 2: an UNKNOWN category is tolerated (200 + []), never a 400 ---
        const unknownCat = await listNotifications(request, token, '?category=totally_bogus');
        expect(unknownCat.status).toBe(200);
        expect(unknownCat.notifications).toEqual([]);

        // --- Step 3: malformed numeric/boolean params are TOLERATED -> 200 (probed:
        //             the pipes fall back to defaults instead of rejecting). ---
        for (const q of [
            '?limit=abc',
            '?offset=xyz',
            '?unreadOnly=maybe',
            '?limit=-5',
            '?offset=-9',
        ]) {
            const res = await listNotifications(request, token, q);
            expect(res.status, `query ${q}`).toBe(200);
            expect(Array.isArray(res.notifications)).toBe(true);
        }

        // --- Step 4: limit is clamped to <= 100 server-side; asking for 9999 is
        //             accepted (200) and never errors, returning at most the cap. ---
        const overLimit = await listNotifications(request, token, '?limit=9999');
        expect(overLimit.status).toBe(200);
        expect(overLimit.notifications.length).toBeLessThanOrEqual(100);

        // --- Step 5: the newest-first (createdAt DESC) ordering invariant holds for
        //             whatever rows exist — asserted generically so it stands on an
        //             empty inbox AND if a background producer ever seeds rows. ---
        const full = await listNotifications(request, token, '?limit=100');
        expect(full.status).toBe(200);
        const times = full.notifications.map((n) => new Date(n.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }

        // --- Step 6: paging is stable — page 1 (offset=0) and a deep page never 5xx
        //             and the unreadOnly subset is a subset of the full list. ---
        const page0 = await listNotifications(request, token, '?limit=10&offset=0');
        const pageDeep = await listNotifications(request, token, '?limit=10&offset=1000');
        expect(page0.status).toBe(200);
        expect(pageDeep.status).toBe(200);
        const unreadOnly = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        const fullIds = new Set(full.notifications.map((n) => n.id));
        expect(unreadOnly.notifications.every((n) => fullIds.has(n.id))).toBe(true);
    });

    test('bell dropdown renders the live empty state + agrees with the unread-count API', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        await landOnDashboard(page, origin);

        // The bell is a button wrapping svg.lucide-bell in the dashboard header.
        const bellButton = page.locator('button:has(svg.lucide-bell)').first();
        await expect(bellButton).toBeVisible({ timeout: 30_000 });

        // --- Step 1: pull the seeded user's authoritative count from the API and
        //             require the UI to reflect it (probed: seeded user = 0 unread). ---
        const stoken = await seededToken(request);
        const seededCount = await unreadCount(request, stoken);
        expect(seededCount).toBeGreaterThanOrEqual(0);

        // --- Step 2: the red count badge only appears when count > 0. With a zero
        //             count there is NO badge span inside the bell button. ---
        const badge = bellButton.locator('span.bg-danger');
        if (seededCount === 0) {
            await expect(badge).toHaveCount(0);
        } else {
            await expect(badge).toBeVisible({ timeout: 10_000 });
        }

        // --- Step 3: open the dropdown — the <h3> "Notifications" heading mounts ---
        await openNotificationBell(page);

        // --- Step 4: the panel renders the TRUE state — empty-state copy ("No new
        //             notifications") OR a rendered item list — never crash/spinner. ---
        const emptyState = page.getByText('No new notifications');
        const anyItem = page.locator('div.divide-y > div').first();
        await expect(async () => {
            const empty = await emptyState.isVisible().catch(() => false);
            const hasItem = await anyItem.isVisible().catch(() => false);
            expect(empty || hasItem).toBe(true);
        }).toPass({ timeout: 15_000 });

        // --- Step 5: with a zero count the "Mark all as read" action is hidden
        //             (it only renders when unreadCount > 0) and the heading carries
        //             no "(N unread)" suffix. ---
        if (seededCount === 0) {
            await expect(emptyState).toBeVisible({ timeout: 10_000 });
            await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
            await expect(page.getByText(/\(\d+ unread\)/)).toHaveCount(0);
        }
    });

    test('bell is gated behind auth + closes on outside-click and survives a route change', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // --- Step 1: an ANONYMOUS context (empty storageState — bare newContext
        //             would INHERIT the seeded auth cookie) cannot reach the
        //             dashboard bell at all: /works 307s to /login. ---
        const anonContext = await page
            .context()
            .browser()!
            .newContext({
                storageState: { cookies: [], origins: [] },
            });
        try {
            const anonPage = await anonContext.newPage();
            await anonPage.goto(`${origin}/works`, { waitUntil: 'domcontentloaded' });
            await expect(anonPage).toHaveURL(/\/login/, { timeout: 30_000 });
            // And the API the bell consumes 401s without a bearer.
            const anonApi = await request.get(`${API_BASE}/api/notifications/unread-count`);
            expect(anonApi.status()).toBe(401);
        } finally {
            await anonContext.close();
        }

        // --- Step 2: the AUTHED seeded session lands on the dashboard with the bell ---
        await landOnDashboard(page, origin);
        await openNotificationBell(page);
        const panelHeading = page.getByRole('heading', { name: /^Notifications/, level: 3 });
        await expect(panelHeading).toBeVisible();

        // --- Step 3: clicking OUTSIDE the dropdown closes it (mousedown-outside
        //             handler) — the panel heading disappears. ---
        await page.mouse.click(5, 5);
        await expect(panelHeading).toBeHidden({ timeout: 10_000 });

        // --- Step 4: the bell persists across an authenticated route change and
        //             re-opens cleanly on the new page (its own header instance). ---
        await page.goto(`${origin}/agents`, { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
        const bellOnAgents = page.locator('button:has(svg.lucide-bell)').first();
        await expect(bellOnAgents).toBeVisible({ timeout: 30_000 });
        await openNotificationBell(page);
        await expect(panelHeading).toBeVisible({ timeout: 10_000 });

        // --- Step 5: the re-opened panel STILL agrees with the live API for the
        //             seeded user (zero unread -> empty-state, no badge). ---
        const stoken = await seededToken(request);
        if ((await unreadCount(request, stoken)) === 0) {
            await expect(page.getByText('No new notifications')).toBeVisible({ timeout: 10_000 });
            await expect(bellOnAgents.locator('span.bg-danger')).toHaveCount(0);
        }
    });
});
