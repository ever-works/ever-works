import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * SECURITY PIN: sanitized error surfaces — the Wave J / Wave M info-leak
 * contracts. Three planes, one law: an error envelope returned to an API
 * client must stay GENERIC — no userId UUID, no git token, no internal
 * IP/hostname, no raw upstream blob — and must stay BYTE-STABLE across
 * repeated calls so a prober can't shake loose a more detailed variant.
 *
 *   1. git-providers capability sub-resources for a DISCONNECTED user —
 *      especially the `/user` sub-resource and the repeat-call stability
 *      that flow-git-provider-connection left unpinned (EW-721 Wave J,
 *      #1264/#1267: the old detail was 'No connected account found for
 *      user <userId> with provider <p>').
 *   2. the per-Work activity-feed `degraded.directorySite` envelope — the
 *      DirectoryWebsiteClient (apps/api/src/works/activity-feed/
 *      directory-website-client.service.ts) keeps raw Axios messages
 *      (`connect ECONNREFUSED 10.96.0.1:443`) server-side and serialises
 *      only static, safe `detail` strings to the browser (Wave M).
 *   3. the github-app sync surfaces (apps/api/src/integrations/github-app/
 *      github-app-sync.service.ts) — installation responses strip the
 *      `rawPayload` GitHub-webhook audit blob, and every refusal envelope
 *      on the sync plane echoes NOTHING of the probed payload (Wave M).
 *
 * NON-DUPLICATION — read before writing, these siblings already own:
 *   · flow-git-provider-connection → organizations/repositories disconnected
 *       envelopes probed ONCE each (no own/cross userId), oauth/:p/user
 *       'No valid token' envelope, connection-record isolation + lifecycle.
 *       It does NOT touch /api/git-providers/:p/user, nor repeat-call
 *       stability, nor envelope KEY-SET pins — this file owns those.
 *   · flow-oauth-git-providers / flow-plugin-git-provider / git-providers /
 *       flow-settings-git-providers → OAuth discovery/CSRF/lifecycle/UI.
 *   · activity-feed-perwork → feed auth gate (anon 401, stranger 403/404),
 *       array shape, limit honouring. flow-activity-feed-perwork-deep →
 *       merge/cursor semantics. flow-activity-sync-modes → the pull/push/
 *       disabled TRANSPORT lifecycle: it pins the truthful not_provisioned
 *       reason+detail and platformSyncLastError* columns. NONE of them pin
 *       the info-leak NEGATIVES on the degraded envelope (no IP / no socket
 *       errno / no signature material), the degraded-block repeat stability,
 *       the category-routed degraded ABSENCE, or the authed non-UUID 400
 *       no-echo — this file owns those.
 *   · github-app + flow-settings-github-app → receiver gradient rungs
 *       (missing event 400 / unsigned 401), empty-installations array shape,
 *       sync-401-vs-onboard-404 statuses, web setup/callback redirects.
 *       NOT owned there: the rawPayload-free serialization pin, the exact
 *       refusal-envelope key sets, the no-echo of probed payload markers,
 *       and the signature-gate-runs-BEFORE-persistence proof — owned here.
 *
 * PROBED CONTRACTS — every status/shape/message was probed against the LIVE
 * stack (API 127.0.0.1:3100, sqlite in-memory CI driver) before assertion:
 *
 *   GET /api/git-providers/github/user            (authed, disconnected)
 *     → 200 {"success":false,"user":null,"error":"Failed to fetch user"}
 *       exactly — keys {success,user,error}, byte-identical on repeat.
 *   GET /api/git-providers/github/organizations   → 200 {"success":false,
 *       "organizations":[],"error":"Failed to fetch organizations"} (stable)
 *   GET /api/git-providers/github/repositories    → 200 {"success":false,
 *       "repositories":[],"error":"Failed to fetch repositories"} (stable;
 *       hostile ?page=abc&perPage=99999 yields the SAME envelope)
 *   GET /api/git-providers/gitlab/user            → the SAME generic user
 *       envelope (no provider-existence oracle);  anon → 401.
 *
 *   GET /api/works/:id/activity-feed (fresh pull-mode work, no website)
 *     → 200 { entries, nextCursor, serverTime, degraded:{ directorySite:{
 *         reason:'not_provisioned', detail:'Work has no deployed website URL',
 *         lastSuccessAt:null } } } — detail is a STATIC string.
 *   GET …?category=generation → 200 with NO degraded key (directory
 *       transport not consulted for that category).
 *   GET …?category=users      → 200 with the degraded block present.
 *   GET /api/works/not-a-uuid/activity-feed (authed) → 400
 *       {"message":"Validation failed (uuid is expected)","error":"Bad
 *       Request","statusCode":400} — raw id NOT echoed.  anon (valid id) → 401.
 *
 *   GET  /api/github-app/installations (authed fresh user) → 200 `[]` (raw
 *        array, byte-stable on repeat);  anon → 401.
 *   POST /api/github-app/installations/:id/sync (authed, unknown id) → 401
 *        {"message":"GitHub App installation not found for this user",
 *         "error":"Unauthorized","statusCode":401} — exactly these 3 keys.
 *        anon → 401 {"message":"Unauthorized","statusCode":401} (guard shape).
 *   POST /api/github-app/webhooks (installation payload, unsigned OR
 *        wrong sha256=<64-hex> signature) → 401 {"message":"Invalid GitHub
 *        webhook signature","error":"Unauthorized","statusCode":401}; the
 *        payload markers are NOT echoed and NOTHING persists (installations
 *        stays [], sync of that id still the same not-found refusal).
 *
 * ISOLATION: every test registers FRESH users (registerUserViaAPI) and
 * unique timestamp-suffixed works/ids; all assertions are API-contract
 * level (no UI navigation). Anonymous calls use a fresh
 * playwright.request.newContext() — never an inherited browser context.
 */

const GIT = `${API_BASE}/api/git-providers`;
const GH_APP = `${API_BASE}/api/github-app`;

/** v4-style UUID — used to prove no internal id leaks into an envelope. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** GitHub token shapes (ghp_/gho_/ghu_/ghs_/ghr_). */
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{8,}/;
/** Dotted-quad — internal IPs must never surface in client envelopes. */
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
/** Node socket errno names that raw Axios messages embed. */
const SOCKET_ERR_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH/;
/** The pre-Wave-J leaky template — its return would be a regression. */
const LEGACY_LEAK_RE = /connected account found for user/i;

function uniq(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Assert a git-provider sub-resource envelope is fully sanitized. */
function expectSanitized(text: string, label: string): void {
    expect(text, `${label}: no UUID (userId) in envelope`).not.toMatch(UUID_RE);
    expect(text, `${label}: no github token in envelope`).not.toMatch(GH_TOKEN_RE);
    expect(text, `${label}: legacy leaky template never returns`).not.toMatch(LEGACY_LEAK_RE);
    expect(text, `${label}: no socket errno in envelope`).not.toMatch(SOCKET_ERR_RE);
}

interface DegradedBlock {
    reason?: string;
    detail?: string;
    lastSuccessAt?: string | null;
}

interface FeedBody {
    entries?: unknown[];
    nextCursor?: string | null;
    serverTime?: string;
    degraded?: { directorySite?: DegradedBlock };
}

async function getFeed(
    request: APIRequestContext,
    token: string,
    workId: string,
    query = '',
): Promise<{ status: number; body: FeedBody }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/activity-feed${query}`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json()) as FeedBody };
}

test.describe('SEC PIN: git-providers /user sub-resource — disconnected envelope is generic and key-stable (Wave J gap)', () => {
    test('disconnected GET :p/user → 200 exact {success:false,user:null,error:"Failed to fetch user"} with NO userId/token', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${GIT}/github/user`, {
            headers: authedHeaders(u.access_token),
        });
        // The controller catches the no-connection failure and returns a 200
        // envelope — never a 5xx, never the raw service error.
        expect(res.status(), 'disconnected /user is a 200 envelope').toBe(200);
        const text = await res.text();
        const body = JSON.parse(text) as { success: boolean; user: unknown; error: string };
        expect(body.success, 'success:false while disconnected').toBe(false);
        expect(body.user, 'user is null — never a fabricated identity').toBeNull();
        expect(body.error, 'error is the static generic message').toBe('Failed to fetch user');
        // Key-set pin: exactly these three keys — nothing extra can leak.
        expect(Object.keys(body).sort()).toEqual(['error', 'success', 'user']);
        expectSanitized(text, 'github /user envelope');
        expect(text, 'caller own userId never echoed').not.toContain(u.user.id);
    });

    test('repeat-call stability: user/organizations/repositories envelopes are byte-identical across consecutive calls', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        // A prober hammering the endpoint must never shake loose a more
        // detailed variant (attempt counters, upstream attempt errors,
        // alternating messages). Two consecutive calls per sub-resource
        // must produce byte-identical 200 envelopes.
        for (const sub of ['user', 'organizations', 'repositories'] as const) {
            const first = await request.get(`${GIT}/github/${sub}`, { headers: h });
            const second = await request.get(`${GIT}/github/${sub}`, { headers: h });
            expect(first.status(), `${sub} call 1 → 200`).toBe(200);
            expect(second.status(), `${sub} call 2 → 200`).toBe(200);
            const t1 = await first.text();
            const t2 = await second.text();
            expect(t2, `${sub} envelope is byte-stable across calls`).toBe(t1);
            expectSanitized(t1, `${sub} repeat envelope`);
        }
    });

    test('cross-user uniformity: two fresh users receive the IDENTICAL /user envelope — no per-user variance to fingerprint', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        expect(a.user.id, 'two distinct accounts').not.toBe(b.user.id);

        const resA = await request.get(`${GIT}/github/user`, {
            headers: authedHeaders(a.access_token),
        });
        const resB = await request.get(`${GIT}/github/user`, {
            headers: authedHeaders(b.access_token),
        });
        expect(resA.status()).toBe(200);
        expect(resB.status()).toBe(200);
        const tA = await resA.text();
        const tB = await resB.text();
        // Identical bodies — the envelope carries nothing user-derived.
        expect(tB, 'envelope does not vary by account').toBe(tA);
        expect(tA, "does not contain A's userId").not.toContain(a.user.id);
        expect(tA, "does not contain B's userId").not.toContain(b.user.id);
    });

    test('unknown provider /user → the SAME generic envelope (no provider-existence oracle); anon → 401', async ({
        request,
        playwright,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const known = await request.get(`${GIT}/github/user`, { headers: h });
        const unknown = await request.get(`${GIT}/gitlab/user`, { headers: h });
        expect(known.status(), 'known provider → 200 envelope').toBe(200);
        expect(unknown.status(), 'unknown provider → 200 envelope (never 5xx)').toBe(200);
        // Byte-identical: the error message cannot be used to distinguish a
        // configured provider with no connection from a non-existent one.
        expect(await unknown.text(), 'unknown-provider envelope identical to known').toBe(
            await known.text(),
        );

        // Anonymous callers never reach the envelope at all.
        const anon = await playwright.request.newContext();
        try {
            const res = await anon.get(`${GIT}/github/user`);
            expect(res.status(), 'anon /user → 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('hostile pagination on /repositories (?page=abc&perPage=99999) → same generic envelope, no parser artifacts', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const plain = await request.get(`${GIT}/github/repositories`, { headers: h });
        const hostile = await request.get(`${GIT}/github/repositories?page=abc&perPage=99999`, {
            headers: h,
        });
        expect(plain.status()).toBe(200);
        expect(hostile.status(), 'hostile params never 5xx').toBe(200);
        const hostileText = await hostile.text();
        // The NaN page / over-cap perPage are swallowed by the same catch —
        // the envelope is the identical generic one, with no parseInt
        // residue or stack frames.
        expect(hostileText, 'hostile-param envelope identical to plain').toBe(await plain.text());
        expect(hostileText, 'no NaN artifact').not.toContain('NaN');
        expect(hostileText, 'no stack frames').not.toMatch(/\bat\s+\w+.*\.ts:\d+/);
        expectSanitized(hostileText, 'hostile-pagination envelope');
    });
});

test.describe('SEC PIN: activity-feed degraded.directorySite — static sanitized detail, never network internals (Wave M)', () => {
    test('fresh pull-mode work → degraded block is the exact static not_provisioned shape with NO IP/hostname/errno', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `sec-feed-degraded-${uniq()}`,
        });
        expect(work.id).toBeTruthy();

        const { status, body } = await getFeed(request, u.access_token, work.id);
        expect(status, 'feed composes 200 even when the directory pull degrades').toBe(200);
        const block = body.degraded?.directorySite;
        expect(block, 'pull-mode degraded block present').toBeTruthy();
        // Exact static shape — the detail is a hardcoded server-side string,
        // not a pass-through of any network/Axios message.
        expect(block?.reason).toBe('not_provisioned');
        expect(block?.detail).toBe('Work has no deployed website URL');
        expect(block?.lastSuccessAt, 'no fabricated success timestamp').toBeNull();
        expect(Object.keys(block as object).sort()).toEqual(['detail', 'lastSuccessAt', 'reason']);

        const serialized = JSON.stringify(body.degraded);
        expect(serialized, 'no IPv4 address in degraded block').not.toMatch(IPV4_RE);
        expect(serialized, 'no socket errno in degraded block').not.toMatch(SOCKET_ERR_RE);
        expect(serialized, 'no signed-bearer material in degraded block').not.toMatch(
            /Bearer\s+[A-Za-z0-9]/,
        );
        expect(serialized, 'no metadata/loopback hostname in degraded block').not.toMatch(
            /metadata\.google|169\.254\.|localhost/i,
        );
    });

    test('degraded detail is repeat-stable: consecutive composes return the same reason+detail and never accumulate attempt internals', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `sec-feed-stable-${uniq()}`,
        });

        const first = await getFeed(request, u.access_token, work.id);
        const second = await getFeed(request, u.access_token, work.id);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const b1 = first.body.degraded?.directorySite;
        const b2 = second.body.degraded?.directorySite;
        expect(b1?.reason, 'reason stable across composes').toBe(b2?.reason);
        expect(b1?.detail, 'detail stable across composes (static string)').toBe(b2?.detail);
        expect(b2?.detail).toBe('Work has no deployed website URL');
        // Only degraded composes ran against this work — the error-tracking
        // write path must never invent a success timestamp for the client.
        expect(b1?.lastSuccessAt).toBeNull();
        expect(b2?.lastSuccessAt).toBeNull();
        expect(JSON.stringify(second.body.degraded), 'repeat compose stays sanitized').not.toMatch(
            SOCKET_ERR_RE,
        );
    });

    test('category routing: degraded surfaces ONLY when the directory transport is consulted — present for ?category=users, absent for ?category=generation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `sec-feed-category-${uniq()}`,
        });

        // users → DIRECTORY_TYPES non-empty → pull attempted → degraded.
        const users = await getFeed(request, u.access_token, work.id, '?category=users');
        expect(users.status).toBe(200);
        expect(users.body.degraded?.directorySite?.reason).toBe('not_provisioned');
        expect(users.body.degraded?.directorySite?.detail).toBe('Work has no deployed website URL');

        // generation → directory transport never consulted → NO degraded key
        // at all (the absence itself prevents needless detail exposure).
        const gen = await getFeed(request, u.access_token, work.id, '?category=generation');
        expect(gen.status).toBe(200);
        expect(gen.body.degraded, 'no degraded block when transport not consulted').toBeUndefined();
        expect(Array.isArray(gen.body.entries), 'entries array still present').toBe(true);
    });

    test('feed id validation: authed non-UUID id → 400 that never echoes the raw id; anon valid-shape request → 401', async ({
        request,
        playwright,
    }) => {
        const u = await registerUserViaAPI(request);
        const hostileId = 'not-a-uuid-sec-probe';
        const res = await request.get(`${API_BASE}/api/works/${hostileId}/activity-feed`, {
            headers: authedHeaders(u.access_token),
        });
        // ParseUUIDPipe fires before any ORM/ownership lookup.
        expect(res.status(), 'non-UUID id → 400 at the pipe').toBe(400);
        const text = await res.text();
        const body = JSON.parse(text) as { message?: string; error?: string };
        expect(body.message).toBe('Validation failed (uuid is expected)');
        expect(body.error).toBe('Bad Request');
        // The hostile id is NOT reflected back (no reflected-input vector).
        expect(text, 'raw id never echoed').not.toContain(hostileId);

        const anon = await playwright.request.newContext();
        try {
            const anonRes = await anon.get(
                `${API_BASE}/api/works/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/activity-feed`,
            );
            expect(anonRes.status(), 'anon feed read → 401 before validation').toBe(401);
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('SEC PIN: github-app sync plane — rawPayload-free responses and echo-free refusals (Wave M)', () => {
    test('GET /installations for a fresh user → exact raw [] with no rawPayload key anywhere, byte-stable on repeat; anon → 401', async ({
        request,
        playwright,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        const first = await request.get(`${GH_APP}/installations`, { headers: h });
        expect(first.status(), 'installations list → 200').toBe(200);
        const t1 = await first.text();
        const parsed = JSON.parse(t1) as unknown;
        expect(Array.isArray(parsed), 'raw array (no wrapper envelope)').toBe(true);
        expect((parsed as unknown[]).length, 'fresh account owns zero installations').toBe(0);
        // The Wave M strip: the serialized response must never contain the
        // GitHub-webhook audit blob key.
        expect(t1, 'no rawPayload key in serialization').not.toContain('rawPayload');

        const second = await request.get(`${GH_APP}/installations`, { headers: h });
        expect(await second.text(), 'list is byte-stable on repeat').toBe(t1);

        const anon = await playwright.request.newContext();
        try {
            const res = await anon.get(`${GH_APP}/installations`);
            expect(res.status(), 'anon installations → 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('sync refusal envelope is EXACTLY {message,error,statusCode} — generic not-found-for-user text, no installation echo; anon gets the bare guard envelope', async ({
        request,
        playwright,
    }) => {
        const u = await registerUserViaAPI(request);
        const probedId = `9${Date.now()}`; // numeric, never a real installation

        const res = await request.post(`${GH_APP}/installations/${probedId}/sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), 'unknown-installation sync → 401').toBe(401);
        const text = await res.text();
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(body.message).toBe('GitHub App installation not found for this user');
        expect(body.error).toBe('Unauthorized');
        expect(body.statusCode).toBe(401);
        // Key-set pin: nothing else (no installation row, no rawPayload).
        expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
        expect(text, 'no rawPayload key in refusal').not.toContain('rawPayload');
        expect(text, 'probed id not echoed').not.toContain(probedId);
        expect(text, 'no UUID in refusal').not.toMatch(UUID_RE);

        // Anonymous sync stops at the auth guard with the bare envelope —
        // it never reaches the not-found-for-user branch.
        const anon = await playwright.request.newContext();
        try {
            const anonRes = await anon.post(`${GH_APP}/installations/${probedId}/sync`);
            expect(anonRes.status()).toBe(401);
            const anonBody = (await anonRes.json()) as Record<string, unknown>;
            expect(anonBody.message).toBe('Unauthorized');
            expect(anonBody.statusCode).toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('webhook signature gate fails CLOSED before persistence: unsigned and wrong-signature installation payloads are refused without echo, and nothing materializes on the sync plane', async ({
        request,
        playwright,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        const marker = `sec-pin-leak-${uniq()}`;
        const installationId = 8000000 + (Date.now() % 1000000);
        const payload = {
            action: 'suspend',
            installation: {
                id: installationId,
                app_slug: marker,
                target_type: 'User',
                account: { login: marker, type: 'User' },
            },
        };

        const anon = await playwright.request.newContext();
        try {
            // Rung 1 — unsigned: refused with the static signature message.
            const unsigned = await anon.post(`${GH_APP}/webhooks`, {
                headers: { 'x-github-event': 'installation' },
                data: payload,
            });
            expect(unsigned.status(), 'unsigned webhook → 401').toBe(401);
            const unsignedText = await unsigned.text();
            expect(JSON.parse(unsignedText).message).toBe('Invalid GitHub webhook signature');
            // No part of the attacker-controlled payload is reflected.
            expect(unsignedText, 'unsigned refusal echoes no payload marker').not.toContain(marker);
            expect(unsignedText, 'unsigned refusal echoes no installation id').not.toContain(
                String(installationId),
            );

            // Rung 2 — well-formed but WRONG sha256 signature: byte-identical
            // refusal (no oracle distinguishing missing vs wrong signature).
            const wrongSig = await anon.post(`${GH_APP}/webhooks`, {
                headers: {
                    'x-github-event': 'installation',
                    'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
                },
                data: payload,
            });
            expect(wrongSig.status(), 'wrong-signature webhook → 401').toBe(401);
            expect(await wrongSig.text(), 'wrong-sig refusal identical to unsigned').toBe(
                unsignedText,
            );
        } finally {
            await anon.dispose();
        }

        // The gate ran BEFORE any handler side-effect: the probed payload
        // never persisted, so the sync plane shows nothing of it.
        const list = await request.get(`${GH_APP}/installations`, { headers: h });
        expect(list.status()).toBe(200);
        const listText = await list.text();
        expect(JSON.parse(listText), 'installations list still empty').toEqual([]);
        expect(listText, 'list carries no probed marker').not.toContain(marker);

        const sync = await request.post(`${GH_APP}/installations/${installationId}/sync`, {
            headers: h,
        });
        expect(sync.status(), 'sync of the probed id is still the not-found refusal').toBe(401);
        expect(((await sync.json()) as { message?: string }).message).toBe(
            'GitHub App installation not found for this user',
        );
    });
});
