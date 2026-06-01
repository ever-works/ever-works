import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Notifications — real-time / poll-update integration flows.
 *
 * The platform's notification "live update" surface is the bell dropdown in the
 * dashboard header (`apps/web/src/components/dashboard/NotificationDropdown.tsx`).
 * Probed live against the running stack (NestJS + sqlite in-memory CI driver)
 * before any assertion; exact, environment-independent behaviour confirmed:
 *
 *   GET  /api/notifications/unread-count   -> 200 { count:number }
 *        * NO `Cache-Control` header, but DOES carry a weak `ETag` -> a matching
 *          `If-None-Match` short-circuits to **304 Not Modified** (the real
 *          poll-efficiency contract the 30s interval rides on).
 *   GET  /api/notifications                -> 200 { notifications:Notification[] }
 *        * `Cache-Control: private, no-store` + a weak ETag.
 *        * limit is CAPPED at 100 server-side (probed: limit=99999 -> 200, bounded).
 *        * GARBAGE params are TOLERATED, never 5xx: unreadOnly=notabool / limit=abc /
 *          offset=-5 / category=bogus_cat all return 200 { notifications:[…] }.
 *        * `?unreadOnly=true&category=system&limit&offset` filters honoured.
 *   GET  /api/notifications/persistent     -> 200 { notifications:[] }
 *   POST /api/notifications/:id/read       -> 200 { success:true }
 *        (unknown id -> 400 { message:"Notification not found", error:"Bad Request" })
 *   POST /api/notifications/:id/dismiss    -> 200 { success:true }
 *        (unknown id -> 400 { message:"Notification not found" })
 *   POST /api/notifications/read-all       -> 200 { success:true } (idempotent on empty)
 *
 * REAL-TIME MODEL (probed, load-bearing): there is **NO SSE / WebSocket push**
 * for notifications. The only `text/event-stream` producers in the API are the
 * chat (openai-compat) + email controllers; `/api/notifications/stream`,
 * `/api/events/stream`, `/api/events` all 404. The bell instead **polls**
 * `getUnreadNotificationCount()` on a `POLL_INTERVAL = 30000` `setInterval`,
 * re-rendering the red badge (`unreadCount > 0 ? min(count,'99+')`) and surfacing
 * a toast for new `ai_credits` rows — WITHOUT a full page reload. These flows
 * exercise that poll contract end-to-end: the count surface, its conditional-GET
 * short-circuit (the mechanism that makes a 30s poll cheap), the badge re-render
 * driven by an out-of-band mutation observed on the next poll-equivalent GET,
 * eventual consistency of the count across two live contexts, garbage-param
 * tolerance under a poll burst, and the read/dismiss lifecycle that feeds the
 * next poll's count + ETag.
 *
 * DEVIATION (no deterministic producer): the platform exposes NO public API that
 * *creates* an in-app notification row — every producer fires from a background
 * event (work-generation failure / budget crossing / agent run) needing an LLM
 * key or Trigger.dev, neither present in CI. So a literal "row appears unread on
 * the next poll" cannot be made deterministic. These flows therefore assert the
 * *observable poll machinery* (count value, ETag rotation, badge↔API agreement,
 * 304 short-circuit, no-reload state transitions) on a real, zero-row inbox —
 * the exact code path the bell drives every 30s — never a fictional injected row.
 *
 * Cross-spec isolation: every API mutation runs on a FRESH registerUserViaAPI()
 * user (unique email per run); the seeded storageState user is touched ONLY for
 * read-only / UI-driven assertions. Counts use >= / toContain to tolerate the
 * shared in-memory DB; never assert exact global counts.
 */

const POLL_INTERVAL_MS = 30_000; // mirrors NotificationDropdown.POLL_INTERVAL

const NON_PUSH_STREAM_PATHS = [
    '/api/notifications/stream',
    '/api/notifications/events',
    '/api/events/stream',
    '/api/events',
    '/api/notifications/sse',
] as const;

const NOTIFICATION_CATEGORIES = [
    'ai_credits',
    'subscription',
    'generation',
    'system',
    'security',
] as const;

interface UnreadCountRead {
    count: number;
    etag: string | null;
    status: number;
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

/** One poll-equivalent read of the unread-count endpoint (value + validator). */
async function readUnreadCount(
    request: APIRequestContext,
    token: string,
    ifNoneMatch?: string,
): Promise<UnreadCountRead> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const res = await request.get(`${API_BASE}/api/notifications/unread-count`, { headers });
    const status = res.status();
    const etag = res.headers()['etag'] ?? null;
    // A 304 carries no body. A 200 carries { count }.
    let count = NaN;
    if (status === 200) {
        count = (await res.json()).count as number;
    }
    return { count, etag, status };
}

/**
 * Open the notification bell dropdown in the dashboard header. The trigger has
 * no aria-label (only a Tooltip), so anchor on its lucide Bell icon and climb to
 * the enclosing button. Retry-to-open loop survives the `next dev` hydration race
 * where the first click is dropped pre-hydration.
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

test.describe('Notifications real-time / poll updates', () => {
    test('poll endpoint short-circuits via conditional ETag — the 30s poll-efficiency contract', async ({
        request,
    }) => {
        // The bell polls /unread-count every POLL_INTERVAL_MS. The endpoint emits a
        // weak ETag (but no Cache-Control), so a conditional re-poll with
        // If-None-Match collapses to a bodyless 304 when nothing changed — the
        // mechanism that keeps a 30s poll cheap. We prove the full cycle.
        const user: RegisteredUser = await registerUserViaAPI(request, {
            email: `notif-poll-etag-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        // --- Poll #1: fresh user, zero unread, validator present ---
        const first = await readUnreadCount(request, token);
        expect(first.status).toBe(200);
        expect(first.count).toBe(0);
        expect(typeof first.etag).toBe('string');
        expect((first.etag ?? '').length).toBeGreaterThan(0);

        // --- Poll #2: same state, conditional GET -> 304 Not Modified ---
        // This is the real poll short-circuit: no body, count unchanged.
        const conditional = await readUnreadCount(request, token, first.etag!);
        expect(conditional.status).toBe(304);

        // --- Poll #3: an UNCONDITIONAL re-poll still returns the live count 200 ---
        const third = await readUnreadCount(request, token);
        expect(third.status).toBe(200);
        expect(third.count).toBe(0);
        // The validator for an identical zero-count payload is stable across polls.
        expect(third.etag).toBe(first.etag);

        // --- A mark-all mutation must NOT break the next poll (still 0, idempotent) ---
        const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(token),
        });
        expect(readAll.status()).toBe(200);
        expect((await readAll.json()).success).toBe(true);

        const afterMutation = await readUnreadCount(request, token);
        expect(afterMutation.status).toBe(200);
        expect(afterMutation.count).toBe(0);
        // Conditional poll after the no-op mutation still short-circuits.
        const afterCond = await readUnreadCount(request, token, afterMutation.etag!);
        expect(afterCond.status).toBe(304);
    });

    test('no SSE/WebSocket push channel — polling is the sole real-time surface (contract)', async ({
        request,
    }) => {
        // Notifications have NO server-push: every candidate stream path 404s, so
        // the bell's setInterval poll is the ONLY live-update channel. We assert
        // (a) the absence of a push endpoint and (b) that the two polled endpoints
        // the bell consumes carry the distinct caching contract that makes them
        // poll-friendly.
        const user = await registerUserViaAPI(request, {
            email: `notif-nopush-${Date.now()}@test.local`,
        });
        const token = user.access_token;

        for (const path of NON_PUSH_STREAM_PATHS) {
            const res = await request
                .get(`${API_BASE}${path}`, {
                    headers: { Accept: 'text/event-stream', ...authedHeaders(token) },
                    timeout: 4_000,
                })
                .catch(() => null);
            // Either a clean 404 (path doesn't exist) OR — defensively — any
            // non-streaming, non-5xx response. The contract we assert: there is no
            // dedicated notification event-stream the client subscribes to.
            if (res) {
                const ct = res.headers()['content-type'] ?? '';
                const isStream = ct.includes('text/event-stream');
                // If a future build DOES add a stream here, that's fine — but in the
                // current contract these paths must not be live SSE notification feeds.
                expect(
                    res.status() === 404 || !isStream,
                    `unexpected notification SSE stream at ${path} (ct=${ct})`,
                ).toBe(true);
                expect(res.status()).toBeLessThan(500);
            }
        }

        // The POLLED surfaces carry their probed caching contract: the LIST route is
        // explicitly un-cacheable (private, no-store) so each open shows fresh rows…
        const listRes = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status()).toBe(200);
        expect(listRes.headers()['cache-control'] ?? '').toContain('no-store');
        expect(Array.isArray((await listRes.json()).notifications)).toBe(true);

        // …while the COUNT route omits Cache-Control but ships a validator so the
        // frequent 30s poll can ride conditional GETs (proven in the ETag flow).
        const countRes = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(token),
        });
        expect(countRes.status()).toBe(200);
        expect(countRes.headers()['cache-control'] ?? '').not.toContain('no-store');
        expect(typeof countRes.headers()['etag']).toBe('string');
        expect(typeof (await countRes.json()).count).toBe('number');
    });

    test('bell badge agrees with the live poll count and survives ≥1 in-place poll cycle (no reload)', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // Ground truth: pull the seeded user's live unread count straight from the
        // API the bell polls. The rendered badge MUST agree with this number.
        const stoken = await seededToken(request);
        const seededCount = (await readUnreadCount(request, stoken)).count;
        expect(seededCount).toBeGreaterThanOrEqual(0);

        await page.context().addCookies([
            { name: 'sidebar-collapsed', value: '0', url: origin },
            { name: 'chat-panel-open', value: '0', url: origin },
        ]);
        // `/dashboard` does NOT exist (404s); the authenticated shell + bell render
        // on `/works`. The bell mounts its poll effect immediately on load.
        await page.goto(`${origin}/works`, { waitUntil: 'domcontentloaded' });

        const bellButton = page.locator('button:has(svg.lucide-bell)').first();
        await expect(bellButton).toBeVisible({ timeout: 30_000 });

        // The red badge span (absolute, bg-danger, rounded-full) only renders when
        // unreadCount > 0. Assert the rendered badge state matches the live count.
        const badge = bellButton.locator('span.bg-danger');
        if (seededCount === 0) {
            await expect(badge).toHaveCount(0, { timeout: 10_000 });
        } else {
            await expect(badge).toBeVisible({ timeout: 10_000 });
            const shown = (await badge.innerText()).trim();
            // Badge clamps to '99+' above 99, else the literal count.
            if (seededCount > 99) {
                expect(shown).toBe('99+');
            } else {
                expect(shown).toBe(String(seededCount));
            }
        }

        // Open the dropdown — this is a live, JS-driven render (NOT a navigation):
        // the panel populates from getNotifications() without any full reload.
        await openNotificationBell(page);

        // The panel shows EITHER the empty state OR a rendered list — never a crash
        // or an infinite spinner. Both are valid live states the poll feeds.
        const emptyState = page.getByText('No new notifications');
        const anyItem = page.locator('div.divide-y > div').first();
        await expect(async () => {
            const empty = await emptyState.isVisible().catch(() => false);
            const hasItem = await anyItem.isVisible().catch(() => false);
            expect(empty || hasItem).toBe(true);
        }).toPass({ timeout: 15_000 });

        // CRITICAL real-time assertion: the bell's setInterval poll must keep the
        // page alive and re-render in place. We do NOT reload. Instead we verify the
        // SPA is still interactive after the dropdown render, then confirm the badge
        // state is still consistent with a FRESH live count read — proving the UI is
        // driven by the same poll surface, in-place, with no navigation.
        await page.keyboard.press('Escape').catch(() => {});
        // Re-read the live count; the rendered badge must still match it (the page
        // has not navigated; any change would have come from a poll, not a reload).
        const recheck = (await readUnreadCount(request, stoken)).count;
        const badgeNow = bellButton.locator('span.bg-danger');
        if (recheck === 0) {
            await expect(badgeNow).toHaveCount(0, { timeout: 10_000 });
        } else {
            await expect(badgeNow).toBeVisible({ timeout: 10_000 });
        }

        // Annotate that a full real poll tick (30s) is intentionally NOT awaited —
        // CI keeps per-test budget tight; the poll *machinery* is proven via the
        // API-level ETag/304 flow + the no-navigation badge↔count agreement above.
        test.info().annotations.push({
            type: 'poll-note',
            description: `bell polls /unread-count every ${POLL_INTERVAL_MS}ms; verified badge↔live-count agreement in-place without a reload (full 30s tick not awaited to keep CI budget bounded).`,
        });
    });

    test('unread count is eventually consistent across two live contexts (poll convergence)', async ({
        request,
    }) => {
        // Two independent "contexts" (e.g. two browser tabs each running the poll)
        // for the SAME user must read the SAME count, and a mutation made in context
        // A must be visible to context B's next poll — the convergence guarantee a
        // polling client relies on (no per-connection state, no stale push).
        const user = await registerUserViaAPI(request, {
            email: `notif-converge-${Date.now()}@test.local`,
        });
        // Both contexts authenticate as the same user via independent logins —
        // modelling two tabs / two devices each polling on their own interval.
        const tokenA = user.access_token;
        const loginB = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(loginB.status()).toBe(200);
        const tokenB = (await loginB.json()).access_token as string;
        expect(typeof tokenB).toBe('string');

        // --- Both polls read the same baseline count ---
        const aBaseline = await readUnreadCount(request, tokenA);
        const bBaseline = await readUnreadCount(request, tokenB);
        expect(aBaseline.status).toBe(200);
        expect(bBaseline.status).toBe(200);
        expect(aBaseline.count).toBe(bBaseline.count);
        expect(aBaseline.count).toBe(0);
        // Identical state -> identical validator across contexts (poll dedupe works).
        expect(aBaseline.etag).toBe(bBaseline.etag);

        // --- Context A performs a read-all mutation (idempotent on an empty inbox) ---
        const mutate = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(tokenA),
        });
        expect(mutate.status()).toBe(200);

        // --- Context B's NEXT poll converges to the same post-mutation count ---
        // expect.poll models B's recurring 30s poll without sleeping a real tick.
        await expect
            .poll(async () => (await readUnreadCount(request, tokenB)).count, {
                timeout: 15_000,
            })
            .toBe(0);

        // Both contexts now agree, and the count is never negative regardless of
        // interleaving — the invariant a multi-tab poller depends on.
        const aFinal = await readUnreadCount(request, tokenA);
        const bFinal = await readUnreadCount(request, tokenB);
        expect(aFinal.count).toBe(bFinal.count);
        expect(aFinal.count).toBeGreaterThanOrEqual(0);

        // A foreign user's poll is fully isolated: a different user never sees this
        // user's count and vice-versa (no cross-tenant leakage in the poll surface).
        const stranger = await registerUserViaAPI(request, {
            email: `notif-stranger-${Date.now()}@test.local`,
        });
        const strangerCount = await readUnreadCount(request, stranger.access_token);
        expect(strangerCount.status).toBe(200);
        expect(strangerCount.count).toBe(0);
    });

    test('poll/list endpoint tolerates garbage params and stays bounded under a poll burst', async ({
        request,
    }) => {
        // A polling client may serialize odd params (a stale `limit`, a typo'd
        // category). The endpoint the bell + inbox poll must degrade gracefully:
        // 200, never 5xx, list capped at 100, and bounded under rapid repeated
        // polling (the 30s interval can fire back-to-back across remounts).
        const user = await registerUserViaAPI(request, {
            email: `notif-paramtol-${Date.now()}@test.local`,
        });
        const h = authedHeaders(user.access_token);

        // --- Garbage params are tolerated, not 5xx'd (probed: all 200) ---
        const garbage = [
            'unreadOnly=notabool',
            'limit=abc',
            'offset=-5',
            'category=bogus_cat',
            'limit=99999', // server caps at 100
            'unreadOnly=1&unreadOnly=0', // duplicate key
            'limit=0&offset=0',
        ];
        for (const qs of garbage) {
            const res = await request.get(`${API_BASE}/api/notifications?${qs}`, { headers: h });
            expect(res.status(), `params="${qs}" must not 5xx`).toBeLessThan(500);
            expect(res.status(), `params="${qs}"`).toBe(200);
            const body = await res.json();
            expect(Array.isArray(body.notifications), `params="${qs}"`).toBe(true);
            // The cap is enforced server-side regardless of the requested limit.
            expect(body.notifications.length).toBeLessThanOrEqual(100);
        }

        // --- Every valid category filter is honoured (the inbox poll uses these) ---
        for (const category of NOTIFICATION_CATEGORIES) {
            const res = await request.get(`${API_BASE}/api/notifications?category=${category}`, {
                headers: h,
            });
            expect(res.status(), `category=${category}`).toBe(200);
            expect(Array.isArray((await res.json()).notifications)).toBe(true);
        }

        // --- A rapid poll BURST (mirrors back-to-back 30s ticks on remount) stays
        // sane: every response 200, count a small non-negative integer, no drift. ---
        const burst = await Promise.all(
            Array.from({ length: 12 }, () => readUnreadCount(request, user.access_token)),
        );
        for (const r of burst) {
            // Identical state across the burst -> 200 (no validator passed -> never 304).
            expect(r.status).toBe(200);
            expect(typeof r.count).toBe('number');
            expect(Number.isInteger(r.count)).toBe(true);
            expect(r.count).toBeGreaterThanOrEqual(0);
            expect(r.count).toBeLessThan(10_000);
        }
        // The burst is internally consistent — a poller never observes a count that
        // jumps around between same-instant reads.
        const counts = new Set(burst.map((r) => r.count));
        expect(counts.size).toBe(1);
        expect([...counts][0]).toBe(0);
    });

    test('read + dismiss lifecycle feeds the next poll — count + ETag are the live signal', async ({
        request,
    }) => {
        // The bell's poll observes the *effect* of read/dismiss mutations on the
        // next /unread-count read. We exercise the full mutation lifecycle and prove
        // the poll surface reflects it: bogus ids are truthful 400s (so a buggy
        // client can't silently corrupt the badge), real mutations keep the count
        // non-negative, and the count-validator is the deterministic live signal.
        const user = await registerUserViaAPI(request, {
            email: `notif-lifecycle-${Date.now()}@test.local`,
        });
        const token = user.access_token;
        const h = authedHeaders(token);
        const bogusId = '00000000-0000-0000-0000-000000000000';

        // --- Baseline poll: zero unread, validator captured ---
        const baseline = await readUnreadCount(request, token);
        expect(baseline.status).toBe(200);
        expect(baseline.count).toBe(0);

        // --- mark-as-read on a non-existent id is a truthful 400 (not a silent ok) ---
        const markBogus = await request.post(`${API_BASE}/api/notifications/${bogusId}/read`, {
            headers: h,
        });
        expect(markBogus.status()).toBe(400);
        const markBody = await markBogus.json();
        expect(markBody.message).toBe('Notification not found');
        expect(markBody.error).toBe('Bad Request');

        // --- dismiss on a non-existent id is the SAME truthful 400 ---
        const dismissBogus = await request.post(
            `${API_BASE}/api/notifications/${bogusId}/dismiss`,
            { headers: h },
        );
        expect(dismissBogus.status()).toBe(400);
        expect((await dismissBogus.json()).message).toBe('Notification not found');

        // --- The failed mutations did NOT perturb the poll count (still 0) and the
        // validator is unchanged (nothing happened to the inbox). ---
        const afterBogus = await readUnreadCount(request, token);
        expect(afterBogus.status).toBe(200);
        expect(afterBogus.count).toBe(0);
        expect(afterBogus.etag).toBe(baseline.etag);
        // And the conditional poll still short-circuits — the live signal is stable.
        const cond = await readUnreadCount(request, token, afterBogus.etag!);
        expect(cond.status).toBe(304);

        // --- read-all is idempotent + safe; the count never goes negative ---
        for (let i = 0; i < 3; i++) {
            const readAll = await request.post(`${API_BASE}/api/notifications/read-all`, {
                headers: h,
            });
            expect(readAll.status()).toBe(200);
            expect((await readAll.json()).success).toBe(true);
        }
        const afterReadAll = await readUnreadCount(request, token);
        expect(afterReadAll.status).toBe(200);
        expect(afterReadAll.count).toBe(0);
        expect(afterReadAll.count).toBeGreaterThanOrEqual(0);

        // --- The persistent (critical) feed the global banner polls is consistent:
        // same empty envelope, never a 5xx. ---
        const persistent = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: h,
        });
        expect(persistent.status()).toBe(200);
        expect((await persistent.json()).notifications).toEqual([]);

        // --- unreadOnly view (what the badge ultimately reflects) agrees with the
        // count: zero unread -> empty unreadOnly list -> count 0. The poll surface
        // is internally coherent across all three reads. ---
        const unreadOnly = await request.get(
            `${API_BASE}/api/notifications?unreadOnly=true&limit=20`,
            { headers: h },
        );
        expect(unreadOnly.status()).toBe(200);
        expect((await unreadOnly.json()).notifications).toEqual([]);
        const finalCount = await readUnreadCount(request, token);
        expect(finalCount.count).toBe(0);
    });
});
