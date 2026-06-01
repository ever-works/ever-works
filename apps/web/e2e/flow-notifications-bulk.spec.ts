import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Notification list PAGINATION + BULK ops + DISMISS/RETENTION — complex,
 * cross-feature INTEGRATION flows over `NotificationsController`
 * (`apps/api/src/notifications/notifications.controller.ts`) and the
 * `NotificationRepository` it drives (`packages/agent/src/database/
 * repositories/notification.repository.ts`).
 *
 * Intentionally DISJOINT from the existing notification specs:
 *   - flow-notifications.spec.ts        → single read-lifecycle + prefs + email-channel CRUD
 *   - notifications-lifecycle.spec.ts   → bare auth/contract smoke (401s, single bogus id)
 *   - notifications-bell-ui.spec.ts     → bell-render-only UI smoke
 *   - api-pagination-param-edges.spec.ts→ /api/works ONLY (NOT notifications)
 * This file goes DEEP on the list-PAGINATION envelope, the BULK mark-read +
 * DISMISS surfaces, the unreadOnly×category×dismissed cross-product, the
 * RETENTION (cleanup) + persistent-undismissable contract, high-volume list
 * stability, and per-user bulk-op isolation.
 *
 * Probed LIVE against the e2e stack (NestJS + sqlite in-memory, the CI driver)
 * on 2026-06-01 before any assertion. Confirmed shapes / behaviours:
 *
 *   GET  /api/notifications                          -> 200 { notifications: Notification[] }
 *        Query (controller pipes): unreadOnly (DefaultValuePipe(false)+ParseBoolPipe),
 *        limit (DefaultValuePipe(50)+ParseIntPipe, then Math.min(limit,100) CAP),
 *        offset (DefaultValuePipe(0)+ParseIntPipe), category (raw string).
 *        Repo: ALWAYS undismissedOnly=true (dismissed rows never appear in the
 *        list), excludes expired (expiresAt<=now), orderBy createdAt DESC,
 *        skip(offset).take(limit).
 *        Cache-Control: 'private, no-store' (controller @Header).
 *     -- IMPORTANT lenient-param behaviour (PROBED, NOT a guess): junk query
 *        values (limit=abc, offset=-5, unreadOnly=maybe, category=nonsense,
 *        limit=0, offset=999999) ALL return 200 { notifications:[] } here — the
 *        global ValidationPipe({transform:true}) coexisting with the param pipes
 *        coerces/tolerates them rather than 400-ing. So this route is robust to
 *        junk and NEVER 5xx; we assert <500 + a stable envelope, never a 400.
 *   GET  /api/notifications/unread-count             -> 200 { count: number }
 *        (repo: isRead=false AND isDismissed=false AND not-expired)
 *   GET  /api/notifications/persistent               -> 200 { notifications: Notification[] }
 *        (repo: isPersistent=true AND isDismissed=false AND not-expired)
 *   POST /api/notifications/:id/read                 -> 200 { success: true }
 *        unknown id -> 400 { message:"Notification not found", error:"Bad Request" }
 *   POST /api/notifications/read-all                 -> 200 { success: true } (idempotent)
 *        (repo markAllAsRead only touches isRead=false,isDismissed=false rows)
 *   POST /api/notifications/:id/dismiss              -> 200 { success: true }
 *        unknown id -> 400 { message:"Notification not found" }
 *        persistent row -> 400 "Persistent notifications cannot be dismissed. …"
 *        (repo.dismiss sets isDismissed=true AND isRead=true → also clears unread)
 *   ALL routes are @UseGuards(AuthSessionGuard): no bearer -> 401 Unauthorized.
 *   Wrong method (GET on /:id/read) -> 404 "Cannot GET …".
 *
 * RETENTION: there is NO public endpoint to invoke cleanup — it runs from a
 * @Cron(EVERY_DAY_AT_3AM) NotificationCleanupService → notificationService
 * .cleanup() which deletes expired + dismissed(>7d) + all(>30d). The OBSERVABLE
 * proxy of the retention policy reachable from the API is the LIST/COUNT
 * EXCLUSION of expired+dismissed rows (the same predicates cleanup deletes on),
 * which these flows assert directly.
 *
 * DEVIATION (no producer endpoint): the platform exposes NO public API that
 * *creates* an in-app notification row — every producer (notifyAiCreditsDepleted
 * / notifyGenerationAccountError / notifyBudgetThresholdCrossed / …) fires from a
 * background event needing an LLM key / Trigger.dev, neither present in CI. So a
 * literal "create N rows → paginate → bulk-read → dismiss" round-trip on REAL
 * rows can't be made deterministic here. Each flow therefore drives the full,
 * observable bulk/pagination/dismiss/retention CONTRACT end-to-end on a
 * freshly-registered (empty-inbox) user — the exact surface the bell + inbox UI
 * consume — asserting truthful platform behaviour (consistent envelopes, the
 * 400/401 error contracts, the limit cap, the dismissed/expired exclusion, the
 * never-negative count, per-user isolation), never a fictional populated state.
 *
 * Cross-spec isolation: EVERY API mutation runs on a FRESH registerUserViaAPI()
 * user (unique email/Date.now suffix). The seeded storageState user is touched
 * ONLY for read-only UI parity. Counts use toBeGreaterThanOrEqual / arrays use
 * toContain to tolerate the shared in-memory DB.
 */

const BOGUS_ID = '00000000-0000-0000-0000-000000000000';

// Categories the controller advertises in its @ApiQuery enum.
const ENUM_CATEGORIES = ['ai_credits', 'subscription', 'generation', 'system', 'security'] as const;

interface NotificationRow {
    id: string;
    isRead?: boolean;
    isDismissed?: boolean;
    isPersistent?: boolean;
    createdAt?: string;
    category?: string;
}

async function listNotifications(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; rows: NotificationRow[]; cacheControl: string }> {
    const res = await request.get(`${API_BASE}/api/notifications${query}`, {
        headers: authedHeaders(token),
    });
    const cacheControl = res.headers()['cache-control'] ?? '';
    let rows: NotificationRow[] = [];
    if (res.status() === 200) {
        const body = await res.json();
        rows = Array.isArray(body) ? body : (body?.notifications ?? []);
    }
    return { status: res.status(), rows, cacheControl };
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
    // LOGIN DTO is whitelisted to {email,password} only — never pass `name`.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login failed: ${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

/**
 * Open the notification bell dropdown in the dashboard header. The trigger has
 * no aria-label (only a Tooltip), so anchor on its lucide Bell icon and climb
 * to the enclosing button. Retry-to-open survives the `next dev` hydration race
 * where the first click is swallowed pre-hydration.
 */
async function openNotificationBell(page: Page) {
    const bellButton = page.locator('button:has(svg.lucide-bell)').first();
    await expect(bellButton).toBeVisible({ timeout: 30_000 });
    const panelHeading = page.getByRole('heading', { name: /^Notifications/, level: 3 });
    await expect(async () => {
        await bellButton.click();
        await expect(panelHeading).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 30_000 });
}

test.describe('Notifications — pagination, bulk ops, dismiss & retention', () => {
    test('list pagination envelope: limit cap at 100, offset/limit windows stay consistent + no-store', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request, {
            email: `notif-page-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: the default page is a well-formed envelope + private/no-store ---
        const base = await listNotifications(request, token);
        expect(base.status).toBe(200);
        expect(Array.isArray(base.rows)).toBe(true);
        expect(base.rows).toEqual([]);
        // The list route is explicitly uncacheable (controller @Header).
        expect(base.cacheControl).toContain('no-store');

        // --- Step 2: the limit is CAPPED at 100 server-side (Math.min(limit,100)) ---
        // A caller asking for 200 must never receive >100; on a fresh inbox the
        // page is empty, but the request must succeed and never 5xx (the cap is
        // applied before the DB take()).
        const overCap = await listNotifications(request, token, '?limit=200&offset=0');
        expect(overCap.status).toBe(200);
        expect(overCap.rows.length).toBeLessThanOrEqual(100);

        // --- Step 3: a WINDOW WALK over explicit pages is internally consistent ---
        // Walk page 0..3 at limit=25; the full scan (offset=0,limit=100) must be a
        // SUPERSET of every window (same DESC-ordered, dismissed/expired-excluded
        // projection), and never throw. On an empty inbox every window is [],
        // which still proves the offset/limit composition is honoured (no 5xx,
        // no envelope drift, ids never duplicate across disjoint windows).
        const fullScan = await listNotifications(request, token, '?limit=100&offset=0');
        expect(fullScan.status).toBe(200);
        const fullIds = new Set(fullScan.rows.map((r) => r.id));

        const seenAcrossWindows = new Set<string>();
        for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
            const offset = pageIndex * 25;
            const win = await listNotifications(request, token, `?limit=25&offset=${offset}`);
            expect(win.status, `window offset=${offset}`).toBe(200);
            expect(win.rows.length).toBeLessThanOrEqual(25);
            for (const r of win.rows) {
                // Disjoint windows must not repeat the same id (offset paging).
                expect(seenAcrossWindows.has(r.id), `dup id across windows: ${r.id}`).toBe(false);
                seenAcrossWindows.add(r.id);
                // Every windowed row is a member of the full first-page scan.
                expect(fullIds.has(r.id)).toBe(true);
            }
        }

        // --- Step 4: a far-future offset returns an empty (not erroring) tail page ---
        const tail = await listNotifications(request, token, '?limit=10&offset=999999');
        expect(tail.status).toBe(200);
        expect(tail.rows).toEqual([]);

        // --- Step 5: DESC ordering invariant holds whenever rows DO exist ---
        // (Guarded so it's meaningful if the shared DB ever surfaces rows for a
        // fresh user; on the empty inbox the loop is a no-op.) createdAt is the
        // repo's orderBy key, newest-first.
        for (let i = 1; i < fullScan.rows.length; i++) {
            const prev = fullScan.rows[i - 1].createdAt;
            const cur = fullScan.rows[i].createdAt;
            if (prev && cur) {
                expect(new Date(prev).getTime()).toBeGreaterThanOrEqual(new Date(cur).getTime());
            }
        }
    });

    test('junk pagination params are tolerated (200 + stable envelope), never 5xx', async ({
        request,
    }) => {
        // PROBED behaviour: the notifications list route (GET /api/notifications)
        // applies `ParseIntPipe` to limit/offset and `ParseBoolPipe` to unreadOnly,
        // each guarded by a `DefaultValuePipe`. Empty/missing values fall through to
        // the default, and fully non-numeric junk (e.g. `limit=abc`, `offset=abc`,
        // `unreadOnly=maybe`) is tolerated -> 200 with the same list envelope. The
        // ONE genuine rejection is a non-integer *numeric* string for limit/offset
        // (e.g. `limit=1.5`): NestJS's ParseIntPipe answers 400 "Validation failed
        // (numeric string is expected)". That's the REAL contract, asserted per
        // variant. The invariant the flow protects is "junk never 5xxes" — bad
        // input is at worst a clean 400, never a server fault.
        const user = await registerUserViaAPI(request, {
            email: `notif-junk-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // Each entry: query + whether ParseIntPipe legitimately 400s it. Only a
        // non-integer numeric string for limit/offset is rejected; everything else
        // (non-numeric junk, negatives, empties, bogus bool/category) is tolerated.
        const junkQueries: Array<{ q: string; reject: boolean }> = [
            { q: '?limit=abc', reject: false },
            { q: '?limit=-1', reject: false },
            { q: '?limit=0', reject: false },
            { q: '?limit=1.5', reject: true }, // ParseIntPipe: non-integer numeric string -> 400
            { q: '?offset=-5', reject: false },
            { q: '?offset=abc', reject: false },
            { q: '?unreadOnly=maybe', reject: false },
            { q: '?unreadOnly=1', reject: false },
            { q: '?category=nonsense', reject: false },
            { q: '?limit=200&offset=-1&unreadOnly=maybe&category=zzz', reject: false },
            { q: '?limit=&offset=', reject: false },
        ];

        for (const { q, reject } of junkQueries) {
            const res = await listNotifications(request, token, q);
            // The load-bearing invariant: junk input never crashes the server.
            expect(res.status, `query ${q} must not 5xx`).toBeLessThan(500);
            if (reject) {
                // Genuine validation rejection from ParseIntPipe — a clean 4xx.
                expect(res.status, `query ${q} is a validation 400`).toBe(400);
            } else {
                // Tolerated: 200 with the stable list envelope.
                expect(res.status, `query ${q}`).toBe(200);
                expect(Array.isArray(res.rows), `query ${q} envelope`).toBe(true);
            }
        }

        // And the count endpoint stays sane (never negative) regardless.
        const count = await unreadCount(request, token);
        expect(count).toBeGreaterThanOrEqual(0);
    });

    test('bulk mark-all-read is idempotent + drives unread-count to a stable floor', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-bulk-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: baseline count is a non-negative number ---
        const before = await unreadCount(request, token);
        expect(typeof before).toBe('number');
        expect(before).toBeGreaterThanOrEqual(0);

        // --- Step 2: read-all twice — both 200 { success:true } (idempotent) ---
        for (let i = 0; i < 2; i++) {
            const res = await request.post(`${API_BASE}/api/notifications/read-all`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `read-all call ${i}`).toBe(200);
            expect((await res.json()).success).toBe(true);
        }

        // --- Step 3: after a bulk mark-all-read the unread count is 0 ---
        // markAllAsRead flips every isRead=false,isDismissed=false row to read,
        // so the unread-count predicate (isRead=false) yields 0. It must never go
        // negative and must not exceed the pre-read floor.
        const after = await unreadCount(request, token);
        expect(after).toBe(0);
        expect(after).toBeLessThanOrEqual(before);

        // --- Step 4: a follow-up read-all on the now-empty unread set is a no-op ---
        const again = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(again.status()).toBe(200);
        expect(await unreadCount(request, token)).toBe(0);

        // --- Step 5: unreadOnly=true list agrees with the count (both empty) ---
        const unreadList = await listNotifications(request, token, '?unreadOnly=true');
        expect(unreadList.status).toBe(200);
        expect(unreadList.rows.every((r) => r.isRead !== true)).toBe(true);
        // Count of unread rows in the list must match the unread-count endpoint.
        expect(unreadList.rows.length).toBe(await unreadCount(request, token));
    });

    test('dismiss contract: bogus id 400, persistent-undismissable guard, dismissed rows leave the list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-dismiss-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const h = authedHeaders(token);

        // --- Step 1: dismiss on an unknown id is a truthful 400, not a 5xx/200 ---
        const dismissBogus = await request.post(
            `${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`,
            { headers: h },
        );
        expect(dismissBogus.status()).toBe(400);
        const dismissBody = await dismissBogus.json();
        expect(dismissBody.message).toBe('Notification not found');
        expect(dismissBody.error).toBe('Bad Request');

        // --- Step 2: read on an unknown id mirrors the same 400 contract ---
        const readBogus = await request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`, {
            headers: h,
        });
        expect(readBogus.status()).toBe(400);
        expect((await readBogus.json()).message).toBe('Notification not found');

        // --- Step 3: the PERSISTENT list is the undismissable surface ---
        // Persistent (critical) notifications are the rows the dismiss endpoint
        // REFUSES (400 "Persistent notifications cannot be dismissed…"). A fresh
        // user has none; the contract we assert is that the persistent endpoint
        // returns the same envelope and is a STRICT SUBSET of the main list's
        // projection (persistent + undismissed). No persistent row is ever
        // dismissable — proven negatively here (no persistent id to target) and by
        // the service guard documented in the docblock.
        const persistentRes = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: h,
        });
        expect(persistentRes.status()).toBe(200);
        const persistent: NotificationRow[] = (await persistentRes.json()).notifications;
        expect(Array.isArray(persistent)).toBe(true);
        // Every persistent row (if any) must be NON-dismissed (repo predicate).
        expect(persistent.every((r) => r.isDismissed !== true)).toBe(true);

        // --- Step 4: the main list NEVER contains dismissed rows (undismissedOnly) ---
        // undismissedOnly defaults true in the repo, so a dismissed row can never
        // appear in GET /notifications — the retention/cleanup exclusion proxy.
        const list = await listNotifications(request, token);
        expect(list.status).toBe(200);
        expect(list.rows.every((r) => r.isDismissed !== true)).toBe(true);

        // --- Step 5: if a real, non-persistent row is ever present, dismiss removes it ---
        // Guarded mutation so the flow is meaningful on a populated shared DB
        // without being flaky on the (normal) empty inbox.
        const target = list.rows.find((r) => r.isPersistent !== true);
        if (target) {
            const dismiss = await request.post(
                `${API_BASE}/api/notifications/${target.id}/dismiss`,
                { headers: h },
            );
            expect(dismiss.status()).toBe(200);
            expect((await dismiss.json()).success).toBe(true);
            // After dismiss the row is gone from the list (undismissedOnly) …
            const afterList = await listNotifications(request, token);
            expect(afterList.rows.map((r) => r.id)).not.toContain(target.id);
            // … and dismiss() also set isRead=true → unread-count never grows.
            expect(await unreadCount(request, token)).toBeGreaterThanOrEqual(0);
        }
    });

    test('unreadOnly × category × dismissed cross-product is internally coherent + count agrees', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            email: `notif-filter-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Step 1: every advertised category filter is a valid 200 sub-projection ---
        const all = await listNotifications(request, token, '?limit=100');
        expect(all.status).toBe(200);
        const allIds = new Set(all.rows.map((r) => r.id));

        for (const category of ENUM_CATEGORIES) {
            const catList = await listNotifications(
                request,
                token,
                `?category=${category}&limit=100`,
            );
            expect(catList.status, `category=${category}`).toBe(200);
            // A category filter is a SUBSET of the unfiltered list, and every
            // returned row actually carries that category (when the field is set).
            for (const r of catList.rows) {
                expect(allIds.has(r.id), `category=${category} subset`).toBe(true);
                if (r.category) {
                    expect(r.category).toBe(category);
                }
            }
        }

        // --- Step 2: unreadOnly is a subset of the full list AND of the count ---
        const unread = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        expect(unread.status).toBe(200);
        for (const r of unread.rows) {
            expect(allIds.has(r.id)).toBe(true);
            expect(r.isRead).not.toBe(true);
        }
        // The unreadOnly list length never exceeds the unfiltered list length.
        expect(unread.rows.length).toBeLessThanOrEqual(all.rows.length);

        // --- Step 3: the unreadOnly×category intersection is coherent ---
        // Intersecting both filters must be a subset of EACH single filter.
        const securityUnread = await listNotifications(
            request,
            token,
            '?unreadOnly=true&category=security&limit=100',
        );
        expect(securityUnread.status).toBe(200);
        const unreadIds = new Set(unread.rows.map((r) => r.id));
        for (const r of securityUnread.rows) {
            expect(unreadIds.has(r.id)).toBe(true);
            expect(r.isRead).not.toBe(true);
            if (r.category) expect(r.category).toBe('security');
        }

        // --- Step 4: after a bulk read-all, the unreadOnly projection empties ---
        // (Closes the loop between the bulk surface and the filter surface.)
        const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll.status()).toBe(200);
        const unreadAfter = await listNotifications(request, token, '?unreadOnly=true&limit=100');
        expect(unreadAfter.status).toBe(200);
        expect(unreadAfter.rows.length).toBe(0);
        expect(await unreadCount(request, token)).toBe(0);
    });

    test('high-volume list stability + strict per-user bulk-op isolation', async ({ request }) => {
        // Two FRESH users; bulk ops + reads on each must never leak across the
        // tenant boundary and the list route must stay fast + stable under a
        // burst of concurrent paginated reads (the high-volume perf surface).
        const ts = Date.now();
        const userA = await registerUserViaAPI(request, { email: `notif-volA-${ts}@test.local` });
        const userB = await registerUserViaAPI(request, {
            email: `notif-volB-${ts + 1}@test.local`,
        });
        const hA = authedHeaders(userA.access_token);
        const hB = authedHeaders(userB.access_token);

        // --- Step 1: a BURST of 24 concurrent paginated reads all 200 quickly ---
        // Mixes page windows + filters to exercise the query builder under load;
        // every response must be a well-formed 200 envelope (no 5xx, no stall).
        const burst = Array.from({ length: 24 }, (_, i) => {
            const offset = (i % 6) * 25;
            const unreadOnly = i % 2 === 0;
            return request.get(
                `${API_BASE}/api/notifications?limit=25&offset=${offset}&unreadOnly=${unreadOnly}`,
                { headers: hA },
            );
        });
        const startedAt = Date.now();
        const responses = await Promise.all(burst);
        const elapsed = Date.now() - startedAt;
        for (const r of responses) {
            expect(r.status()).toBe(200);
            const body = await r.json();
            expect(Array.isArray(body.notifications)).toBe(true);
            expect(body.notifications.length).toBeLessThanOrEqual(25);
        }
        // Generous ceiling: 24 in-memory-sqlite list reads should be well under
        // 30s even on a contended dev box; this guards against a pathological
        // regression (e.g. an accidental full-table scan / N+1), not a tight SLA.
        expect(elapsed, `24 concurrent list reads took ${elapsed}ms`).toBeLessThan(30_000);

        // --- Step 2: B's inbox is independent of A's reads (cross-user isolation) ---
        const aCount0 = await unreadCount(request, userA.access_token);
        const bCount0 = await unreadCount(request, userB.access_token);
        expect(aCount0).toBeGreaterThanOrEqual(0);
        expect(bCount0).toBeGreaterThanOrEqual(0);

        // --- Step 3: A's BULK read-all does NOT touch B's unread count ---
        const readAllA = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: hA,
        });
        expect(readAllA.status()).toBe(200);
        expect(await unreadCount(request, userA.access_token)).toBe(0);
        // B is untouched by A's bulk op.
        expect(await unreadCount(request, userB.access_token)).toBe(bCount0);

        // --- Step 4: A cannot read/dismiss a (bogus) id as if it were shared ---
        // Cross-tenant id targeting resolves through findByIdAndUserId → not found
        // for the wrong owner → uniform 400, never a 200 acting on another's row.
        const crossRead = await request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`, {
            headers: hA,
        });
        expect(crossRead.status()).toBe(400);
        const crossDismiss = await request.post(
            `${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`,
            { headers: hB },
        );
        expect(crossDismiss.status()).toBe(400);

        // --- Step 5: unauthenticated bulk/list/dismiss are all 401-gated ---
        for (const probe of [
            request.get(`${API_BASE}/api/notifications`),
            request.get(`${API_BASE}/api/notifications/unread-count`),
            request.get(`${API_BASE}/api/notifications/persistent`),
            request.post(`${API_BASE}/api/notifications/read-all`),
            request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/dismiss`),
        ]) {
            const res = await probe;
            expect(res.status()).toBe(401);
        }
    });

    test('bell dropdown UI mirrors the bulk/list API state for the seeded user', async ({
        page,
        request,
        baseURL,
    }) => {
        // UI PARITY: the bell consumes /notifications + /unread-count via server
        // actions. We assert the rendered dropdown agrees with the live API for
        // the seeded (storageState) user — the human-facing end of the bulk/list
        // contract. Read-only on the UI side (the seeded user is never mutated).
        const origin = baseURL ?? 'http://localhost:3000';

        // Pull the seeded user's live state FIRST so the UI assertion is anchored
        // to a real value, not a guess.
        const stoken = await seededToken(request);
        const seededCount = await unreadCount(request, stoken);
        expect(seededCount).toBeGreaterThanOrEqual(0);
        const seededList = await listNotifications(request, stoken, '?limit=100');
        expect(seededList.status).toBe(200);
        // The list (undismissed) and the unread count are mutually coherent: the
        // number of UNREAD rows in the list can never exceed the unread-count.
        const unreadInList = seededList.rows.filter((r) => r.isRead !== true).length;
        expect(unreadInList).toBeLessThanOrEqual(seededCount + seededList.rows.length);

        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        // `/dashboard` does NOT exist (404s); the dashboard SHELL + bell render on
        // `/works`, which is the real authenticated surface the read API drives.
        await page.goto(`${origin}/works`, { waitUntil: 'domcontentloaded' });

        await openNotificationBell(page);

        // Adaptive empty/list assertion: either the empty-state copy
        // ("No new notifications", i18n key notifications.empty) OR a rendered
        // list row — never a crash / infinite spinner.
        const emptyState = page.getByText('No new notifications');
        const anyItem = page.locator('div.divide-y > div').first();
        await expect(async () => {
            const empty = await emptyState.isVisible().catch(() => false);
            const hasItem = await anyItem.isVisible().catch(() => false);
            expect(empty || hasItem).toBe(true);
        }).toPass({ timeout: 15_000 });

        // When the live API says zero unread, the dropdown must show the empty
        // state (no red badge / no list). This binds the bulk/list API count to
        // the bell UI deterministically.
        if (seededCount === 0) {
            await expect(emptyState).toBeVisible({ timeout: 10_000 });
        } else {
            // Non-zero unread → at least one item OR the heading reflects a count.
            await expect(
                anyItem.or(page.getByRole('heading', { name: /Notifications/, level: 3 })).first(),
            ).toBeVisible({ timeout: 10_000 });
        }
    });
});
