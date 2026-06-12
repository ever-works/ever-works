import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-quick-create-stats.spec.ts
 *
 * THEME: Works long-tail deep coverage for THREE endpoints whose query/contract
 *        edges are NOT pinned elsewhere:
 *          1. POST /api/works/quick-create  — DTO shape + the AI/search PROVIDER
 *             GATE that fires in keyless CI (a valid body never completes here).
 *          2. GET  /api/works               — the LIST QUERY: ?limit / ?offset /
 *             ?search behaviour, clamp-vs-reject, the {total,limit,offset}
 *             envelope, and cross-user isolation.
 *          3. GET  /api/works/stats         — ONE untouched reconciliation only:
 *             stats.totalWorks == the list envelope's `total` field.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION (read before writing — these already exist, this file AVOIDS them):
 *   - flow-work-stats-aggregation.spec.ts → exhaustively covers GET /works/stats
 *     (six-key shape, +N delta, user-scoping, missions/ideas env-adaptivity,
 *     reconciliation vs the bare `works[]` length). We do NOT re-pin any of that;
 *     our ONE stats touch reconciles totalWorks against the list ENVELOPE'S
 *     `total` integer (a field that spec deliberately ignores via normalizeList).
 *   - work-stats-config.spec.ts → SHALLOW smoke: quick-create anon→401 and a
 *     single "auth + prompt < 500" probe; stats anon→401 + "object" shape. We go
 *     deeper: the exact DTO validation message-array, the providerErrors envelope,
 *     and the keyless-CI gate semantics.
 *   - works-api.spec.ts → route-exists matrix (non-404) + anon /works→401 +
 *     "list-shaped" smoke. NO query params, NO pagination, NO search.
 *   - works.spec.ts → UI-only (page nav, manual-form). No API list params.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (verified LIVE against the CI-mirror API — NestJS + sqlite
 * in-memory, keyless: no OpenRouter / Tavily provider keys configured):
 *
 *   POST /api/works/quick-create   (auth required)
 *     anon (no bearer)                 -> 401 {message:'Unauthorized', statusCode:401}
 *     DTO requires name + slug + description + prompt. Missing fields ->
 *       400 {message: string[], error:'Bad Request', statusCode:400}
 *       (class-validator array; slug also enforces ^[a-z0-9-]+ lowercase regex).
 *     FULL VALID body (all four fields) -> in keyless CI returns
 *       400 { message:'One or more selected providers are not available.',
 *             providerErrors:{ search:'Default provider "Tavily" is not configured…',
 *                              ai:'Default provider "OpenRouter" is not configured…' } }
 *       i.e. quick-create is GENERATION-gated: it eagerly resolves the default AI
 *       + search providers and fails on GENERATION when they are absent. This is
 *       NOT a class-validator array (no `error`/`statusCode` keys, has
 *       `providerErrors`).
 *       => NON-ATOMIC: the Work row is PERSISTED *before* the gate fires (PROBED:
 *          after a gated 400 the work appears in GET /api/works with status:'active'
 *          and generateStatus:null). So we assert the typed GATE on the response AND
 *          that exactly one work persisted — never a successful GENERATION. (On a
 *          keyed env it would proceed to generate; the keyless CI truth is the 400
 *          provider envelope + a created-but-ungenerated work.)
 *
 *   GET /api/works   (auth required; WorkRepository.findAllAccessible — owned OR member)
 *     anon -> 401.
 *     authed -> 200 { status:'success', works: Work[], total:int, limit:int, offset:int }.
 *       NOTE the envelope carries total/limit/offset (the stats spec normalizes to
 *       just `works[]` and ignores these — that is the gap this file fills).
 *     ?limit=N           -> echoes limit:N, returns min(N, remaining) rows; total = full count.
 *     ?offset=M          -> echoes offset:M, skips M rows; total = full count (not page len).
 *     ?limit=2&offset=2  -> page window; total stays the full count.
 *     ?offset past end   -> 200, works:[], total = full count (NO error).
 *     ?limit=0           -> falls back to DEFAULT 20 (echoes limit:20) — 0 is "unset".
 *     ?limit=abc / non-numeric -> 200, falls back to default (NEVER 400 — tolerant parse).
 *     ?limit=-5 / ?offset=-5   -> 200, echoed verbatim, NO effective clamp on the rows
 *       (negative is ignored by the slice) — endpoint is CLAMP/IGNORE, never REJECT.
 *     ?search=term       -> case-INSENSITIVE substring match over name AND slug;
 *                           empty ?search= -> no filter (all rows); no-match -> total:0.
 *     STRICT per-user isolation: user B's list never contains user A's works, and
 *       B searching for A's exact name returns total:0.
 *
 *   POST /api/works   (the canonical create the quick-create contrasts with)
 *     requires { name, slug, description, organization:boolean } -> 200
 *     { status:'success', work:{...} }. Shared createWorkViaAPI() helper sends this.
 *
 * GOTCHAS honoured:
 *   - Full isolation: every test registers a FRESH user (helper's unique email) and
 *     creates its OWN works; a brand-new user owns EXACTLY what the test creates, so
 *     `total` deltas are exact (works have no soft-delete).
 *   - Anon = raw request with NO Authorization header (storageState is irrelevant to
 *     the API `request` fixture, but we never send a bearer for anon assertions).
 *   - Env-adaptive: quick-create's happy path is GENERATION/provider-gated and cannot
 *     complete keyless — we assert the typed GATE (provider envelope) OR a 2xx, never
 *     REQUIRE a created work. throttle (429) is tolerated everywhere; 5xx is never ok.
 *   - Per-test unique suffix derived from a module counter (NOT a module-scope clock).
 */

let __seq = 0;
function uniq(tag: string): string {
    __seq += 1;
    return `${tag}-${__seq}-${Math.random().toString(36).slice(2, 7)}`;
}

type AnyObj = Record<string, unknown>;

function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Register a throwaway user; assert it has a bearer. */
async function freshUser(request: APIRequestContext) {
    const u = await registerUserViaAPI(request);
    expect(u.access_token, 'fresh user must have a bearer token').toBeTruthy();
    return { token: u.access_token, email: u.email };
}

/** GET /api/works with optional query string; returns parsed envelope + status. */
async function listWorks(request: APIRequestContext, token: string, query = '') {
    const url = `${API_BASE}/api/works${query ? `?${query}` : ''}`;
    const res = await request.get(url, { headers: authHeaders(token) });
    const status = res.status();
    let body: AnyObj = {};
    if (status >= 200 && status < 300) body = (await res.json().catch(() => ({}))) as AnyObj;
    const works = Array.isArray(body.works) ? (body.works as AnyObj[]) : [];
    return {
        status,
        body,
        works,
        total: typeof body.total === 'number' ? (body.total as number) : undefined,
        limit: typeof body.limit === 'number' ? (body.limit as number) : undefined,
        offset: typeof body.offset === 'number' ? (body.offset as number) : undefined,
    };
}

/** Create N works for `token` with a shared prefix; return their names + ids. */
async function seedWorks(request: APIRequestContext, token: string, prefix: string, n: number) {
    const created: { id: string; name: string }[] = [];
    for (let i = 0; i < n; i++) {
        const name = `${prefix} ${i}`;
        const { id } = await createWorkViaAPI(request, token, { name });
        expect(id, `seeded work #${i} should expose an id`).toBeTruthy();
        created.push({ id, name });
    }
    return created;
}

test.describe('Works quick-create — DTO + provider gate (keyless CI)', () => {
    test('anon POST /api/works/quick-create → 401 (no bearer)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: { 'Content-Type': 'application/json' },
            data: { name: 'x', slug: 'x', description: 'x', prompt: 'x' },
        });
        expect([401, 403].includes(res.status()), `anon quick-create got ${res.status()}`).toBe(
            true,
        );
    });

    test('empty body → 400 class-validator array naming EVERY required field', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authHeaders(token),
            data: {},
        });
        expect(res.status(), 'empty quick-create body is a validation 400').toBe(400);
        const body = (await res.json().catch(() => ({}))) as AnyObj;
        expect(Array.isArray(body.message), 'validation 400 carries a message array').toBe(true);
        const msg = JSON.stringify(body.message);
        // The DTO is NOT prompt-only: name + slug + description + prompt are all required.
        for (const field of ['slug', 'name', 'description', 'prompt']) {
            expect(msg, `validation should flag missing ${field}`).toContain(field);
        }
        // It is a class-validator BadRequest envelope (NOT the provider envelope).
        expect(body.error, 'class-validator 400 has error:Bad Request').toBe('Bad Request');
        expect(body).not.toHaveProperty('providerErrors');
    });

    test('name+prompt only (no slug/description) → 400 flags exactly the missing fields', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authHeaders(token),
            data: { name: 'Quick Beta', prompt: 'build me a directory' },
        });
        expect(res.status(), 'partial body still a validation 400').toBe(400);
        const body = (await res.json().catch(() => ({}))) as AnyObj;
        expect(Array.isArray(body.message)).toBe(true);
        const msg = JSON.stringify(body.message);
        // slug + description are missing → flagged; name + prompt were supplied → not.
        expect(msg, 'missing slug flagged').toContain('slug');
        expect(msg, 'missing description flagged').toContain('description');
        expect(msg, 'supplied name not flagged').not.toContain('name should not be empty');
        expect(msg, 'supplied prompt not flagged').not.toContain('prompt should not be empty');
    });

    test('FULL valid body is GENERATION-gated: keyless CI returns the providerErrors 400', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const slug = uniq('qc-full').toLowerCase();
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authHeaders(token),
            data: {
                name: 'Quick Create Full',
                slug,
                description: 'a fully-formed quick-create body',
                prompt: 'build me a curated directory of developer tools',
            },
        });
        const status = res.status();
        const body = (await res.json().catch(() => ({}))) as AnyObj;
        // Never a server error — the gate fails CLOSED with a typed 400.
        expect(status, `quick-create must not 5xx (got ${status})`).toBeLessThan(500);

        if (status === 429) {
            test.info().annotations.push({ type: 'throttled', description: 'quick-create 429' });
            return; // throttle is an accepted non-deterministic outcome
        }

        if (status >= 200 && status < 300) {
            // A keyed environment would actually create — accept and sanity-check it.
            test.info().annotations.push({
                type: 'provider-keyed',
                description: 'quick-create completed (AI/search providers ARE configured here)',
            });
            return;
        }

        // KEYLESS CI (the probed reality): a 400 that is the PROVIDER gate, NOT a
        // class-validator array. Distinguish them precisely.
        expect(status, 'keyless quick-create gate is a 400').toBe(400);
        const hasProviderEnvelope =
            body.providerErrors !== undefined &&
            typeof body.message === 'string' &&
            !Array.isArray(body.message);
        expect(
            hasProviderEnvelope,
            `valid-body 400 must be the provider gate, not validation; got ${JSON.stringify(body).slice(0, 200)}`,
        ).toBe(true);
        // The gate names the unconfigured default AI + search providers.
        const pe = (body.providerErrors ?? {}) as AnyObj;
        expect(
            'ai' in pe || 'search' in pe,
            'providerErrors enumerates the missing ai/search defaults',
        ).toBe(true);
    });

    test('quick-create PERSISTS the work first, THEN trips the provider gate (non-atomic 400)', async ({
        request,
    }) => {
        // PROBED REALITY: quick-create creates the Work row BEFORE attempting
        // generation. In keyless CI the provider gate returns a 400, yet the work
        // is already persisted (status:'active', generateStatus:null because
        // generation never started). So the 400 is NOT atomic — assert the row
        // EXISTS, with no generation kicked off.
        const { token } = await freshUser(request);
        const before = await listWorks(request, token);
        expect(before.total, 'fresh user starts with 0 works').toBe(0);

        const name = 'Quick Persist Probe';
        const slug = uniq('qc-persist').toLowerCase();
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authHeaders(token),
            data: {
                name,
                slug,
                description: 'persisted before the gate trips',
                prompt: 'directory of things',
            },
        });
        const status = res.status();
        expect(status, 'quick-create must not 5xx').toBeLessThan(500);
        if (status === 429) {
            test.info().annotations.push({ type: 'throttled', description: 'quick-create 429' });
            return;
        }

        const after = await listWorks(request, token);
        // Whether the gate tripped (keyless 400) or generation kicked off (keyed 2xx),
        // exactly ONE work was created and is owned by this fresh user.
        expect(after.total, 'quick-create persists exactly one work').toBe(1);
        const created = after.works.find((w) => w.slug === slug);
        expect(created, 'the persisted work carries the submitted slug').toBeTruthy();
        expect((created as AnyObj).name, 'persisted work keeps the submitted name').toBe(name);
        if (status === 400) {
            // Gate tripped before generation → no generateStatus was set.
            expect(
                (created as AnyObj).generateStatus,
                'gated quick-create leaves generateStatus unset (generation never started)',
            ).toBeFalsy();
        }
    });
});

test.describe('Works list — pagination, search, clamp-vs-reject, isolation', () => {
    test('anon GET /api/works → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works`, {
            headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status(), 'anon list is 401').toBe(401);
    });

    test('list envelope exposes {status,works,total,limit,offset} with default limit 20', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        await seedWorks(request, token, uniq('env'), 3);
        const r = await listWorks(request, token);
        expect(r.status).toBe(200);
        expect(r.body.status, 'list envelope status field').toBe('success');
        expect(Array.isArray(r.body.works), 'works is an array').toBe(true);
        expect(r.total, 'total reflects the 3 owned works').toBe(3);
        expect(r.limit, 'default page limit is 20').toBe(20);
        expect(r.offset, 'default offset is 0').toBe(0);
        expect(r.works.length, 'all 3 fit on the default page').toBe(3);
    });

    test('?limit/?offset window the page while total stays the full owned count', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const N = 5;
        await seedWorks(request, token, uniq('page'), N);

        const first = await listWorks(request, token, 'limit=2');
        expect(first.status).toBe(200);
        expect(first.limit, 'limit echoed').toBe(2);
        expect(first.offset, 'offset defaults 0').toBe(0);
        expect(first.works.length, 'page returns exactly limit rows').toBe(2);
        expect(first.total, 'total is the FULL count, not the page length').toBe(N);

        const second = await listWorks(request, token, 'limit=2&offset=2');
        expect(second.limit).toBe(2);
        expect(second.offset, 'offset echoed').toBe(2);
        expect(second.works.length, 'second window also has 2 rows').toBe(2);
        expect(second.total, 'total unchanged across pages').toBe(N);

        // Windows must not overlap — distinct ids across page 1 and page 2.
        const idsA = new Set(first.works.map((w) => w.id as string));
        const idsB = second.works.map((w) => w.id as string);
        for (const id of idsB) {
            expect(idsA.has(id), `offset page must not repeat id ${id}`).toBe(false);
        }
    });

    test('offset past the end → 200 empty page, total still accurate (no error)', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        await seedWorks(request, token, uniq('past'), 3);
        const r = await listWorks(request, token, 'offset=999');
        expect(r.status, 'offset past end is NOT an error').toBe(200);
        expect(r.works.length, 'page is empty past the end').toBe(0);
        expect(r.total, 'total still reflects the real count').toBe(3);
        expect(r.offset, 'offset echoed verbatim').toBe(999);
    });

    test('malformed limit is tolerated, never rejected: limit=0→default20, limit=abc→default, limit=-5→no clamp', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        await seedWorks(request, token, uniq('mal'), 3);

        // limit=0 is treated as UNSET → falls back to the default page size (20).
        const zero = await listWorks(request, token, 'limit=0');
        expect(zero.status, 'limit=0 not rejected').toBe(200);
        expect(zero.limit, 'limit=0 falls back to default 20').toBe(20);
        expect(zero.works.length, 'all 3 returned under default page').toBe(3);

        // non-numeric → 200, default fallback, still returns rows (no 400).
        const nan = await listWorks(request, token, 'limit=abc');
        expect(nan.status, 'non-numeric limit not rejected').toBe(200);
        expect(nan.works.length, 'non-numeric limit falls back to a real page').toBe(3);

        // negative → echoed verbatim but the slice ignores it (no effective clamp).
        const neg = await listWorks(request, token, 'limit=-5');
        expect(neg.status, 'negative limit not rejected').toBe(200);
        expect(neg.works.length, 'negative limit does not zero the page').toBe(3);
    });

    test('?search matches name AND slug, is case-insensitive, and empty/no-match behave correctly', async ({
        request,
    }) => {
        const { token } = await freshUser(request);
        const prefix = uniq('SrchTok'); // mixed case to prove case-insensitivity
        await seedWorks(request, token, prefix, 3);

        // A targeted substring of the unique prefix matches all 3 seeded works.
        const hit = await listWorks(request, token, `search=${encodeURIComponent(prefix)}`);
        expect(hit.status).toBe(200);
        expect(hit.total, 'search matches every seeded work by name').toBe(3);

        // Case-insensitive: lowercasing the prefix yields the same matches.
        const lower = await listWorks(
            request,
            token,
            `search=${encodeURIComponent(prefix.toLowerCase())}`,
        );
        expect(lower.total, 'search is case-insensitive').toBe(3);

        // Slug-side match: createWorkViaAPI derives slug from name, so the
        // lowercase-hyphenated prefix hits the slug column too.
        const slugFrag = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const bySlug = await listWorks(request, token, `search=${encodeURIComponent(slugFrag)}`);
        expect(bySlug.total, 'search also matches the slug column').toBe(3);

        // Empty search = no filter → all rows.
        const empty = await listWorks(request, token, 'search=');
        expect(empty.total, 'empty search is a no-op filter').toBe(3);

        // No match → total 0, empty page, still a 200.
        const miss = await listWorks(request, token, 'search=zzz-no-such-work-xyz');
        expect(miss.status).toBe(200);
        expect(miss.total, 'no-match search returns total 0').toBe(0);
        expect(miss.works.length, 'no-match search returns no rows').toBe(0);
    });

    test('STRICT per-user isolation: B never sees A’s works via list OR search', async ({
        request,
    }) => {
        const a = await freshUser(request);
        const b = await freshUser(request);
        const secret = uniq('SecretA');
        await seedWorks(request, a.token, secret, 2);

        // B's list is empty — A's writes never leak.
        const bList = await listWorks(request, b.token);
        expect(bList.status).toBe(200);
        expect(bList.total, "B's total excludes A's works").toBe(0);
        expect(bList.works.length, "B's page excludes A's works").toBe(0);

        // B searching for A's exact unique token finds nothing (scoping precedes search).
        const bSearch = await listWorks(request, b.token, `search=${encodeURIComponent(secret)}`);
        expect(bSearch.total, "B cannot search into A's works").toBe(0);

        // A still sees its own 2 (sanity: isolation didn't hide A's own data).
        const aList = await listWorks(request, a.token, `search=${encodeURIComponent(secret)}`);
        expect(aList.total, 'A still sees its own works').toBe(2);
    });
});

test.describe('Works list ↔ stats — envelope `total` reconciliation', () => {
    test('stats.totalWorks equals the list envelope total field exactly (fresh user)', async ({
        request,
    }) => {
        // Gap vs flow-work-stats-aggregation.spec.ts: that file reconciles stats
        // against the bare works[] LENGTH and ignores the list's `total` integer.
        // Here we reconcile against the ENVELOPE `total` field directly, including
        // when a small page limit means works[].length < total.
        const { token } = await freshUser(request);
        const N = 4;
        await seedWorks(request, token, uniq('recon'), N);

        const statsRes = await request.get(`${API_BASE}/api/works/stats`, {
            headers: authHeaders(token),
        });
        expect(statsRes.ok(), 'stats should 200').toBe(true);
        const stats = (await statsRes.json().catch(() => ({}))) as AnyObj;
        const totalWorks = stats.totalWorks;
        expect(typeof totalWorks, 'stats exposes numeric totalWorks').toBe('number');
        expect(totalWorks, 'fresh user totalWorks == N created').toBe(N);

        // Page the list with a SMALL limit so works[].length < total, proving the
        // reconciliation is against `total`, not the page length.
        const paged = await listWorks(request, token, 'limit=1');
        expect(paged.works.length, 'small page returns 1 row').toBe(1);
        expect(paged.total, 'list total matches stats.totalWorks').toBe(totalWorks);
        expect(paged.total, 'list total equals N regardless of page size').toBe(N);
    });
});
