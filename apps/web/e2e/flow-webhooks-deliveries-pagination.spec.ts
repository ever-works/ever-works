/**
 * flow-webhooks-deliveries-pagination — the PAGINATION / FILTER / SORT contract of
 * the outbound-webhook surface (`GET /api/webhooks`, `GET /api/webhooks/deliveries`,
 * `POST /api/webhooks/deliveries/:id/redeliver`), driven end-to-end against the live
 * stack. The theme is the pagination WINDOW itself, not happy-path CRUD.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-webhooks-delivery-deep pins the delivery-RECORD field types + a simple
 *   2-fire "most-recent-first" check and the PATCH/pause matrix. flow-webhooks-
 *   subscriptions-multistep drives the create→…→delete journey + the redeliver
 *   CHAIN + secret hygiene. flow-webhooks-validation-authz-matrix grids the URL /
 *   workId / status DTOs, the path-param uuid pipe, cross-account 404-masking, and
 *   the ROTATE throttle (5/min). NONE of them pin the actual PAGING contract of the
 *   listing endpoints — which is the surprising, load-bearing truth this file
 *   proves: **there is no paging/filter/sort surface at all.** The controller
 *   (`listDeliveries`) calls `deliveries.list(userId)` with NO opts, so the
 *   service-level `{ limit, subscriptionId }` knobs (and the repo's [1,200] clamp
 *   / createdAt-DESC / default-50 window) are NEVER reachable from HTTP. Every
 *   `?limit` / `?offset` / `?status` / `?subscriptionId` / `?sort` / `?cursor`
 *   query param is INERT. This file pins that inertness, the fixed most-recent
 *   createdAt-DESC window (tie-tolerant), the bare no-metadata envelope, the
 *   redeliver fanout (no dedup), and the untested-elsewhere redeliver throttle
 *   (10/min per account).
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE any assertion. Confirmed contract:
 *
 *   SUBSCRIPTIONS  GET /api/webhooks → { subscriptions: View[] }  (bare envelope)
 *     • listActiveForAccount → status==='active' ONLY; paused/deleted excluded.
 *     • No `order` clause → membership is order-agnostic (assert by id set).
 *     • `?limit=0&status=paused&sort=x` is INERT — full active set still returned.
 *
 *   DELIVERIES  GET /api/webhooks/deliveries → { deliveries: View[] }  (bare envelope)
 *     • repo window: createdAt DESC, default take=50, clamp [1,200] — but the
 *       controller passes NO opts, so it is ALWAYS the fixed most-recent-50 window.
 *     • `?limit=1|0|-5|99999|abc`, `?status=delivered`, `?subscriptionId=<other>`,
 *       `?offset=`, `?sort=id;DROP TABLE`, `?cursor=…`, `?limit[]=1` → ALL 200, all
 *       return the identical unfiltered id set (proven: `?subscriptionId=S1` still
 *       returns S2's rows; a SQL-injection-style `?sort` is a harmless no-op).
 *     • row keys: id, subscriptionId, event, status('pending'|'delivered'|'failed'
 *       |'retrying'), attempts, lastResponseStatus, lastOutcome, lastError,
 *       durationMs, triggerRunId, lastAttemptAt, createdAt, updatedAt.
 *     • account-scoped at the repo — a second account NEVER sees the first's rows.
 *
 *   REDELIVER  POST …/deliveries/:id/redeliver → 202 { deliveryId(NEW), enqueued:true,
 *              runId:null } (in-process). Mints a FRESH row reusing the event; NO
 *              dedup (N parallel → N distinct rows). Absent well-formed id → 404
 *              "Webhook delivery not found"; non-uuid → 400 at ParseUUIDPipe;
 *              anon → 401; cross-account real id → 404 (never 403). Throttled
 *              10/min PER ACCOUNT (user-bucketed) → a 13-burst tallies ≤10×202 + 429.
 *
 * GOTCHAS honored: every test mints FRESH registerUserViaAPI() accounts (per-account
 * throttle buckets + per-account delivery scope, so bursts never collide cross-test
 * and a fresh account's OWN listing is fully deterministic — exact counts are safe
 * there, id membership via toContain/Set elsewhere); unique Date.now()/random
 * suffixes; createdAt is second-resolution so ordering is asserted NON-INCREASING
 * (tie-tolerant) with explicit 1.1s spacers only where a STRICT head/interleave is
 * required; delivery status is matched against the tolerant enum set (a freshly
 * redelivered row lists as 'pending' until its async in-process attempt settles to
 * 'failed'); throttle tallies are tolerant (≤10×202 + ≥1×429, never a 5xx). Fully
 * API-orchestrated (safe `flow-` prefix) so it never contends on the shared UI auth
 * state. Local-env API allows http:// webhook URLs (NODE_ENV=test), so example.com
 * targets are valid at create; their real POST 405s, settling rows to 'failed'.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const WEBHOOKS_BASE = `${API_BASE}/api/webhooks`;
const DELIVERIES_URL = `${WEBHOOKS_BASE}/deliveries`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const T = 30_000;

const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'retrying'] as const;
const DELIVERY_VIEW_KEYS = [
    'id',
    'subscriptionId',
    'event',
    'status',
    'attempts',
    'lastResponseStatus',
    'lastOutcome',
    'lastError',
    'durationMs',
    'triggerRunId',
    'lastAttemptAt',
    'createdAt',
    'updatedAt',
] as const;
const SUBSCRIPTION_VIEW_KEYS = [
    'id',
    'accountId',
    'workId',
    'url',
    'status',
    'consecutiveFailures',
    'lastDeliveryAt',
    'createdAt',
    'updatedAt',
] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ── typed HTTP helpers (all account-scoped via the bearer) ──────────────────
interface DeliveryView {
    id: string;
    subscriptionId: string;
    event: string;
    status: string;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    lastAttemptAt: string | null;
    [k: string]: unknown;
}
interface SubscriptionView {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: string;
    createdAt: string;
    [k: string]: unknown;
}

async function createSub(
    request: APIRequestContext,
    user: RegisteredUser,
    urlPath: string,
): Promise<SubscriptionView> {
    const res = await request.post(WEBHOOKS_BASE, {
        headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
        data: { url: `http://example.com/${urlPath}-${stamp()}` },
        timeout: T,
    });
    expect(res.status(), `create sub (${urlPath})`).toBe(201);
    return (await res.json()).subscription as SubscriptionView;
}

/** Synchronous test-fire — records a delivery row and returns its id. */
async function testFire(
    request: APIRequestContext,
    user: RegisteredUser,
    subId: string,
): Promise<string> {
    const res = await request.post(`${WEBHOOKS_BASE}/${subId}/test`, {
        headers: authedHeaders(user.access_token),
        timeout: T,
    });
    expect(res.status(), 'test-fire records a delivery row').toBe(200);
    return (await res.json()).deliveryId as string;
}

async function listDeliveries(
    request: APIRequestContext,
    user: RegisteredUser,
    query = '',
): Promise<DeliveryView[]> {
    const res = await request.get(`${DELIVERIES_URL}${query}`, {
        headers: authedHeaders(user.access_token),
        timeout: T,
    });
    expect(res.status(), `GET deliveries${query}`).toBe(200);
    const body = await res.json();
    return body.deliveries as DeliveryView[];
}

async function listSubs(
    request: APIRequestContext,
    user: RegisteredUser,
    query = '',
): Promise<SubscriptionView[]> {
    const res = await request.get(`${WEBHOOKS_BASE}${query}`, {
        headers: authedHeaders(user.access_token),
        timeout: T,
    });
    expect(res.status(), `GET webhooks${query}`).toBe(200);
    return (await res.json()).subscriptions as SubscriptionView[];
}

function ids(rows: { id: string }[]): string[] {
    return rows.map((r) => r.id);
}

/** True iff createdAt is monotonically non-increasing (DESC, ties allowed). */
function nonIncreasingByCreatedAt(rows: DeliveryView[]): boolean {
    for (let i = 0; i < rows.length - 1; i++) {
        if (Date.parse(rows[i].createdAt) < Date.parse(rows[i + 1].createdAt)) return false;
    }
    return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// A — SUBSCRIPTIONS listing: bare envelope, active-only, order-agnostic, inert query.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Webhooks subscriptions listing — envelope, membership, inert paging', () => {
    test('a fresh account lists a bare { subscriptions: [] } — empty array, no paging metadata', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(WEBHOOKS_BASE, { headers: authedHeaders(user.access_token) });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.subscriptions), 'subscriptions is an array').toBe(true);
        expect(body.subscriptions).toEqual([]);
        // No pagination envelope is smuggled alongside the array.
        for (const metaKey of ['total', 'meta', 'page', 'nextCursor', 'hasMore', 'count']) {
            expect(
                body[metaKey],
                `no '${metaKey}' paging field on the subscriptions envelope`,
            ).toBeUndefined();
        }
    });

    test('each listed subscription carries exactly the view key set, status "active", and never secret material', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'shape');
        const rows = await listSubs(request, user);
        const mine = rows.find((r) => r.id === sub.id);
        expect(mine, 'the created subscription is listed').toBeTruthy();
        expect(new Set(Object.keys(mine as object))).toEqual(new Set(SUBSCRIPTION_VIEW_KEYS));
        expect(mine!.status, 'the active list only ever surfaces active rows').toBe('active');
        expect(mine!.accountId).toBe(user.user.id);
        expect(mine!.workId).toBeNull();
        // Secret hygiene: no key matches /secret/i and no signingSecret leaks into the list.
        expect(Object.keys(mine as object).some((k) => /secret/i.test(k))).toBe(false);
    });

    test('the listing contains every created id, EXCLUDES paused + deleted, and is order-agnostic', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const keep1 = await createSub(request, user, 'keep-a');
        const paused = await createSub(request, user, 'pause-me');
        const keep2 = await createSub(request, user, 'keep-b');
        const deleted = await createSub(request, user, 'delete-me');

        // Pause one, delete another.
        const pauseRes = await request.patch(`${WEBHOOKS_BASE}/${paused.id}`, {
            headers: { ...authedHeaders(user.access_token), 'content-type': 'application/json' },
            data: { status: 'paused' },
        });
        expect(pauseRes.status()).toBe(200);
        expect((await pauseRes.json()).status).toBe('paused');
        const delRes = await request.delete(`${WEBHOOKS_BASE}/${deleted.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(delRes.status()).toBe(204);

        const listed = ids(await listSubs(request, user));
        expect(listed, 'active kept sub #1 is present').toContain(keep1.id);
        expect(listed, 'active kept sub #2 is present').toContain(keep2.id);
        expect(listed, 'the paused sub is filtered out of the active list').not.toContain(
            paused.id,
        );
        expect(listed, 'the deleted sub is gone from the list').not.toContain(deleted.id);
        // Fresh account → deterministic: exactly the two survivors.
        expect(listed.length, 'exactly the two active survivors remain').toBe(2);
    });

    test('subscriptions paging/filter query params are INERT — ?limit=0&status=paused&sort= returns the full active set', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const a = await createSub(request, user, 'inert-a');
        const b = await createSub(request, user, 'inert-b');
        const c = await createSub(request, user, 'inert-c');

        const baseline = new Set(ids(await listSubs(request, user)));
        const paged = new Set(
            ids(
                await listSubs(request, user, '?limit=0&offset=2&status=paused&sort=createdAt:asc'),
            ),
        );
        expect(paged, 'query params neither shrink nor filter the subscriptions list').toEqual(
            baseline,
        );
        for (const id of [a.id, b.id, c.id]) {
            expect(baseline.has(id), `created sub ${id} is present despite ?limit=0`).toBe(true);
        }
    });

    test('the subscriptions listing is account-scoped — a second account never sees the first account rows', async ({
        request,
    }) => {
        const [ua, ub] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const subA = await createSub(request, ua, 'scoped-a');
        await createSub(request, ub, 'scoped-b');
        const bList = ids(await listSubs(request, ub));
        expect(
            bList,
            "the second account's list omits the first account's subscription",
        ).not.toContain(subA.id);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B — DELIVERIES listing: bare envelope + the (absent) pagination/filter surface.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Webhooks deliveries listing — no paging surface, every query param inert', () => {
    test('a fresh account lists a bare { deliveries: [] } with NO pagination metadata', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(DELIVERIES_URL, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.deliveries)).toBe(true);
        expect(body.deliveries).toEqual([]);
        for (const metaKey of [
            'total',
            'meta',
            'page',
            'nextCursor',
            'hasMore',
            'limit',
            'offset',
        ]) {
            expect(
                body[metaKey],
                `no '${metaKey}' paging field on the deliveries envelope`,
            ).toBeUndefined();
        }
    });

    test('a delivery row exposes exactly the delivery-view key set with the documented types', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'row-shape');
        const deliveryId = await testFire(request, user, sub.id);

        const rows = await listDeliveries(request, user);
        const row = rows.find((r) => r.id === deliveryId);
        expect(row, 'the test-fire row is listed').toBeTruthy();
        expect(new Set(Object.keys(row as object))).toEqual(new Set(DELIVERY_VIEW_KEYS));
        expect(row!.id).toMatch(UUID_RE);
        expect(row!.subscriptionId).toBe(sub.id);
        expect(row!.event, 'a test-fire carries the webhook.test event').toBe('webhook.test');
        expect(DELIVERY_STATUSES).toContain(row!.status);
        expect(typeof row!.attempts).toBe('number');
        expect(typeof row!.createdAt).toBe('string');
        expect(Number.isNaN(Date.parse(row!.createdAt)), 'createdAt parses as a date').toBe(false);
    });

    test('?limit is INERT — limit=1 does NOT shrink a multi-row window to one', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'limit-inert');
        const seed = await testFire(request, user, sub.id);
        // One redeliver → a second row, so a real page-size of 1 WOULD truncate.
        const redeliverRes = await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(redeliverRes.status()).toBe(202);

        const full = await listDeliveries(request, user);
        expect(full.length, 'the fresh account has both rows').toBe(2);
        const limited = await listDeliveries(request, user, '?limit=1');
        expect(limited.length, '?limit=1 is ignored — the full window still comes back').toBe(2);
        expect(new Set(ids(limited))).toEqual(new Set(ids(full)));
    });

    test('degenerate ?limit values (0, -5, 99999, abc, limit[]=1) all 200 with the identical unfiltered set', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'limit-degenerate');
        const seed = await testFire(request, user, sub.id);
        await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });

        const baseline = new Set(ids(await listDeliveries(request, user)));
        expect(baseline.size, 'two rows for this fresh account').toBe(2);
        for (const q of ['?limit=0', '?limit=-5', '?limit=99999', '?limit=abc', '?limit[]=1']) {
            const got = new Set(ids(await listDeliveries(request, user, q)));
            expect(got, `${q} neither errors nor changes the result set`).toEqual(baseline);
        }
    });

    test('?status=<anything> is INERT — a failed/pending row is still returned under ?status=delivered', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'status-inert');
        const deliveryId = await testFire(request, user, sub.id);

        const baseline = new Set(ids(await listDeliveries(request, user)));
        for (const q of ['?status=delivered', '?status=pending', '?status=bogus', '?status=']) {
            const got = await listDeliveries(request, user, q);
            expect(new Set(ids(got)), `${q} does not filter by status`).toEqual(baseline);
        }
        // Prove it concretely: the row exists and is NOT 'delivered', yet ?status=delivered returns it.
        const underDelivered = await listDeliveries(request, user, '?status=delivered');
        const row = underDelivered.find((r) => r.id === deliveryId);
        expect(
            row,
            'the row survives the delivered-status filter that would exclude it',
        ).toBeTruthy();
    });

    test('?subscriptionId=<one sub> is INERT — the account-wide window still spans EVERY subscription', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const s1 = await createSub(request, user, 'span-1');
        const s2 = await createSub(request, user, 'span-2');
        await testFire(request, user, s1.id);
        await testFire(request, user, s2.id);

        const scoped = await listDeliveries(request, user, `?subscriptionId=${s1.id}`);
        const subsSeen = new Set(scoped.map((r) => r.subscriptionId));
        expect(subsSeen, 'the subscriptionId filter is ignored — both subs appear').toEqual(
            new Set([s1.id, s2.id]),
        );
    });

    test('?offset / ?sort / ?order / ?cursor and a SQL-injection-style sort are all harmless no-ops (200, full set)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'sort-inert');
        const seed = await testFire(request, user, sub.id);
        await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });

        const baseline = new Set(ids(await listDeliveries(request, user)));
        const hostileQueries = [
            '?offset=10',
            '?offset=-1',
            '?sort=createdAt:asc',
            '?order=asc',
            '?cursor=not-a-real-cursor',
            '?sort=id;DROP%20TABLE%20webhook_deliveries',
            '?sort=(select%201)',
        ];
        for (const q of hostileQueries) {
            const res = await request.get(`${DELIVERIES_URL}${q}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status(), `${q} → 200 (no hidden paging/sort surface, no injection)`).toBe(
                200,
            );
            const got = new Set(ids((await res.json()).deliveries as DeliveryView[]));
            expect(got, `${q} returns the identical unfiltered window`).toEqual(baseline);
        }
    });

    test('the deliveries listing is account-scoped — a second account never sees the first account rows', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const [ua, ub] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const subA = await createSub(request, ua, 'iso-a');
        const aDelivery = await testFire(request, ua, subA.id);

        const bRows = await listDeliveries(request, ub);
        expect(bRows, "the second account's deliveries window is empty").toEqual([]);
        expect(ids(bRows), "the first account's delivery id never leaks").not.toContain(aDelivery);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C — DELIVERIES ordering: fixed createdAt-DESC window, tie-tolerant.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Webhooks deliveries ordering — most-recent-first by createdAt (tie-tolerant)', () => {
    test('a redeliver burst yields a non-increasing createdAt window containing every minted id', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'order-burst');
        const seed = await testFire(request, user, sub.id);

        // 8 sequential redelivers (< the 10/min cap) → 8 fresh rows, no spacing so
        // several share a createdAt second — the ordering must survive ties.
        const minted: string[] = [];
        for (let i = 0; i < 8; i++) {
            const r = await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
                headers: authedHeaders(user.access_token),
            });
            expect(r.status(), `redeliver #${i} enqueues`).toBe(202);
            minted.push((await r.json()).deliveryId as string);
        }

        const rows = await listDeliveries(request, user);
        // Fresh account → deterministic count: the seed + the 8 redelivered rows.
        expect(rows.length, 'the window holds the seed plus every redelivered row').toBe(9);
        expect(
            nonIncreasingByCreatedAt(rows),
            'window is non-increasing by createdAt (ties ok)',
        ).toBe(true);
        const listed = new Set(ids(rows));
        expect(listed.has(seed), 'the seed row is present').toBe(true);
        for (const id of minted)
            expect(listed.has(id), `minted redelivery ${id} is present`).toBe(true);
    });

    test('the freshest-created row heads the window — a just-minted redelivery leads with the max createdAt', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'order-head');
        const seed = await testFire(request, user, sub.id);
        await sleep(1100); // force a strictly-later createdAt second for the redelivery

        const r = await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(r.status()).toBe(202);
        const freshId = (await r.json()).deliveryId as string;

        const rows = await listDeliveries(request, user);
        expect(rows[0].id, 'the newest-created delivery is element [0]').toBe(freshId);
        const maxCreated = Math.max(...rows.map((x) => Date.parse(x.createdAt)));
        expect(
            Date.parse(rows[0].createdAt),
            'the head row carries the maximum createdAt (DESC by createdAt)',
        ).toBe(maxCreated);
    });

    test('deliveries across MULTIPLE subscriptions share ONE account-wide createdAt-DESC window (not grouped by sub)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const s1 = await createSub(request, user, 'mix-1');
        const s2 = await createSub(request, user, 'mix-2');

        // Interleave creation across subs with 1.1s spacers so createdAt strictly
        // increases s1 < s2 < s1r < s2r. A window grouped by subscription could not
        // also be createdAt-DESC once the timestamps interleave.
        const d1 = await testFire(request, user, s1.id);
        await sleep(1100);
        const d2 = await testFire(request, user, s2.id);
        await sleep(1100);
        const r1 = await request.post(`${DELIVERIES_URL}/${d1}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(r1.status()).toBe(202);
        await sleep(1100);
        const r2 = await request.post(`${DELIVERIES_URL}/${d2}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(r2.status()).toBe(202);

        const rows = await listDeliveries(request, user);
        expect(rows.length, 'four rows across the two subscriptions').toBe(4);
        expect(
            nonIncreasingByCreatedAt(rows),
            'the mixed-sub window is createdAt-DESC ordered',
        ).toBe(true);
        const subsRepresented = new Set(rows.map((x) => x.subscriptionId));
        expect(subsRepresented, 'both subscriptions appear in the single account window').toEqual(
            new Set([s1.id, s2.id]),
        );
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D — REDELIVER: fanout (no dedup), edges, cross-account mask, and the 10/min throttle.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Webhooks redeliver — fanout, edges, and per-account throttle', () => {
    test('redeliver mints a NEW distinct id reusing the event (202 { enqueued:true, runId:null }); the window grows by exactly that one row', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'fanout-one');
        const seed = await testFire(request, user, sub.id);
        const before = new Set(ids(await listDeliveries(request, user)));

        const res = await request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(202);
        const body = await res.json();
        expect(body.enqueued, 'the redelivery is enqueued').toBe(true);
        expect(body.runId, 'in-process dispatch reports a null Trigger.dev runId').toBeNull();
        expect(body.deliveryId).toMatch(UUID_RE);
        expect(body.deliveryId, 'the redelivery id is a FRESH row, not the original').not.toBe(
            seed,
        );

        const afterRows = await listDeliveries(request, user);
        const after = new Set(ids(afterRows));
        expect(after.has(body.deliveryId), 'the new row is in the window').toBe(true);
        expect(after.has(seed), 'the original row survives').toBe(true);
        expect(after.size, 'the window grew by exactly one new row').toBe(before.size + 1);
        // The reused event matches the seed's event.
        const fresh = afterRows.find((r) => r.id === body.deliveryId);
        const original = afterRows.find((r) => r.id === seed);
        expect(fresh!.event, 'the redelivery reuses the original event name').toBe(original!.event);
    });

    test('redeliver of a well-formed but ABSENT delivery id → 404 with the exact not-found message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(
            `${DELIVERIES_URL}/123e4567-e89b-42d3-a456-556642440000/redeliver`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.message).toBe('Webhook delivery not found');
        expect(body.statusCode).toBe(404);
    });

    test('redeliver of a MALFORMED (non-uuid) delivery id → 400 at ParseUUIDPipe (before any lookup)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${DELIVERIES_URL}/not-a-uuid/redeliver`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toBe('Validation failed (uuid is expected)');
    });

    test('redeliver is auth-gated — an anonymous request is 401 (never reaches the pipe)', async ({
        request,
    }) => {
        const res = await request.post(
            `${DELIVERIES_URL}/123e4567-e89b-42d3-a456-556642440000/redeliver`,
        );
        expect(res.status()).toBe(401);
    });

    test('a second account cannot redeliver the first account real delivery id → 404 (never 403); the victim window is untouched', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const [owner, attacker] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const sub = await createSub(request, owner, 'victim');
        const deliveryId = await testFire(request, owner, sub.id);
        const ownerBefore = new Set(ids(await listDeliveries(request, owner)));

        const res = await request.post(`${DELIVERIES_URL}/${deliveryId}/redeliver`, {
            headers: authedHeaders(attacker.access_token),
        });
        // Cross-account is masked as 404 — identical to the absent-id 404, no 403 enumeration.
        expect(res.status(), 'cross-account redeliver is masked as 404').toBe(404);
        expect((await res.json()).message).toBe('Webhook delivery not found');

        // No fresh row was minted in the owner's window by the attacker's attempt.
        const ownerAfter = new Set(ids(await listDeliveries(request, owner)));
        expect(ownerAfter, "the victim's delivery window is unchanged").toEqual(ownerBefore);
        // And the attacker's own window stays empty.
        expect(
            await listDeliveries(request, attacker),
            "the attacker's window stays empty",
        ).toEqual([]);
    });

    test('N parallel redelivers of the SAME seed → each 2xx mints a DISTINCT fresh row (no dedup); the window grows by exactly the number of winners; never a 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'parallel-fanout');
        const seed = await testFire(request, user, sub.id);
        const BURST = 8; // < the 10/min cap so all should win, but tolerate a stray 429

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.filter((s) => s >= 500),
            `no redeliver 5xx'd (statuses=${statuses})`,
        ).toEqual([]);
        const winners = results.filter((r) => r.status() === 202);
        expect(winners.length, 'at least one parallel redeliver won').toBeGreaterThanOrEqual(1);
        const mintedIds = await Promise.all(
            winners.map(async (r) => (await r.json()).deliveryId as string),
        );
        expect(
            new Set(mintedIds).size,
            'every winning redeliver minted a DISTINCT row (no dedup)',
        ).toBe(winners.length);

        const rows = await listDeliveries(request, user);
        // Fresh account → deterministic: the seed plus exactly one row per winner.
        expect(rows.length, 'the window = seed + one fresh row per winner').toBe(
            winners.length + 1,
        );
        const listed = new Set(ids(rows));
        for (const id of mintedIds) expect(listed.has(id), `minted row ${id} landed`).toBe(true);
    });

    test('redeliver is throttled 10/min PER ACCOUNT — a 13-burst tallies ≤10×202 + ≥1×429, never a 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const sub = await createSub(request, user, 'throttle');
        const seed = await testFire(request, user, sub.id);
        const BURST = 13;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${DELIVERIES_URL}/${seed}/redeliver`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const ok = statuses.filter((s) => s === 202).length;
        const limited = statuses.filter((s) => s === 429).length;
        expect(
            statuses.filter((s) => s >= 500),
            `no 5xx under the burst (statuses=${statuses})`,
        ).toEqual([]);
        expect(ok, 'at least one redeliver got through').toBeGreaterThanOrEqual(1);
        expect(
            ok,
            'the per-account 10/min cap is honored — no more than 10 succeed',
        ).toBeLessThanOrEqual(10);
        expect(limited, 'the over-cap requests are rejected with 429').toBeGreaterThanOrEqual(1);
        expect(ok + limited, 'every response is either a 202 or a 429').toBe(BURST);
    });
});
