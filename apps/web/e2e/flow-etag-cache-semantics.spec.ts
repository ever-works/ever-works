import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * ETag & HTTP cache semantics — COMPLEX, multi-step INTEGRATION flows
 * exercising the conditional-request machinery end-to-end (RFC 7232 /
 * RFC 9110). The NestJS API runs behind Express, whose `etag` middleware
 * auto-emits WEAK ETags on JSON bodies and performs the conditional 304
 * short-circuit via the `fresh()` check. These flows prove the full
 * lifecycle: emit → conditional-revalidate → 304 → mutate → ETag rotates
 * → stale conditional now misses (200) — and that none of it leaks data
 * across users (cache-poisoning prevention).
 *
 * Existing sibling specs (do NOT duplicate):
 *   - etag-strong-vs-weak.spec.ts        : weak/strong PRESENCE by resource type
 *   - conditional-request-headers.spec.ts: no-5xx tolerance for INM / IMS values
 *   - cache-poisoning-vary.spec.ts       : Vary/private presence on auth'd JSON
 *   - public-pages-cache.spec.ts         : login/root Cache-Control family
 *   - cors-preflight-cache.spec.ts       : Access-Control-Max-Age
 *   - redis-cache-coherency.spec.ts      : write-then-read body coherency
 * These flows instead drive the conditional-request STATE MACHINE (304 vs
 * 200 transitions), weak-comparison rules, encoding stability, and
 * per-user ETag isolation — none of which the above cover.
 *
 * ── Live-API contract (probed against 127.0.0.1:3100, sqlite-in-mem) ──
 *
 *   POST /api/auth/register { username(>=3), email, password }
 *     → 200 { access_token (opaque 32-char), user:{ id, email, username } }
 *
 *   GET /api/health                       (Public, no auth)
 *     → 200, ETag: W/"36-…"  (STABLE body), NO Cache-Control, Vary: Origin
 *     → with If-None-Match == ETag       → 304, empty body, echoes ETag+Vary,
 *                                          does NOT add Cache-Control
 *     → with If-None-Match == strong form (W/ stripped) → 304  (WEAK compare)
 *     → with If-None-Match: *            → 304  (matches any representation)
 *     → with multi-valued list incl ETag → 304  (proper list parsing)
 *     → HEAD honours conditional too     → 304
 *     → ETag identical for plain vs gzip (--compressed)  (weak = enc-stable)
 *
 *   GET /api/works            (auth)      → 200 { status:'success', works:[…] }
 *     ETag: W/"…", NO Cache-Control. Mutating the collection (POST a work)
 *     ROTATES the list ETag; a conditional GET carrying the PRE-mutation
 *     ETag then returns 200 (cache correctly invalidated), never a stale 304.
 *
 *   GET /api/auth/profile     (auth)      → 200, Cache-Control: private, no-store,
 *     ETag: W/"…". Body is per-user → user B sending user A's profile ETag
 *     gets 200 (no cross-user 304 hand-off = no cache poisoning). NB profile
 *     body drifts (lastSeen) so its OWN ETag is NOT pinned for self-revalidate.
 *
 *   POST /api/works carrying If-None-Match → 200 (mutations never 304).
 *   GET  /api/works carrying If-Match (unmatched) → 200 (If-Match not enforced
 *     on safe GETs by Express — documented, asserted as no-5xx tolerance).
 *
 *   Web tier (127.0.0.1:3000): GET / → 307 → /login; /en/login → no-store.
 */

const HEALTH = '/api/health';

/** Pull the (case-insensitive) ETag header off a Playwright APIResponse. */
function etagOf(headers: Record<string, string>): string | undefined {
    return headers['etag'] ?? headers['ETag'];
}

/**
 * Poll a public GET until two back-to-back reads agree on the same ETag,
 * returning that stable ETag. Guards against bodies whose ETag momentarily
 * drifts (e.g. an uptime counter) so the conditional assertions downstream
 * compare against a genuinely current validator.
 */
async function stableEtag(request: APIRequestContext, path: string): Promise<string> {
    let last = '';
    await expect
        .poll(
            async () => {
                const res = await request.get(`${API_BASE}${path}`);
                const e = etagOf(res.headers()) ?? '';
                const same = e !== '' && e === last;
                last = e;
                return same;
            },
            { timeout: 15_000, intervals: [200, 400, 600] },
        )
        .toBe(true);
    return last;
}

test.describe('ETag & conditional-request cache semantics (deep)', () => {
    test('Flow 1: full conditional-GET lifecycle on /api/health — emit → 304 → still 304', async ({
        request,
    }) => {
        // 1. First read emits a weak validator with NO Cache-Control
        //    (health is a public liveness probe, freshness driven by ETag).
        const first = await request.get(`${API_BASE}${HEALTH}`);
        expect(first.status()).toBe(200);
        const etag = etagOf(first.headers());
        expect(etag, '/api/health must emit an ETag to revalidate against').toBeTruthy();
        expect(etag!, 'Express auto-ETag on JSON is weak (W/) per its default generator').toMatch(
            /^W\//,
        );

        // 2. Conditional GET carrying that exact validator → 304, empty body.
        const revalidate = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': etag! },
        });
        expect(revalidate.status(), 'matching If-None-Match must 304').toBe(304);
        const body = await revalidate.body();
        expect(body.length, '304 must carry no payload').toBe(0);

        // 3. A 304 MUST still echo the validating ETag (RFC 7232 §4.1) so the
        //    client can keep revalidating, and must NOT inject a Cache-Control
        //    the 200 never carried (would change cacheability on revalidation).
        const echoed = etagOf(revalidate.headers());
        expect(echoed, '304 must echo the ETag it validated').toBe(etag);
        expect(
            revalidate.headers()['cache-control'],
            '304 should not fabricate a Cache-Control the 200 lacked',
        ).toBeUndefined();

        // 4. Health body is stable, so a SECOND revalidation with the same
        //    validator is still 304 (proves the validator is content-derived,
        //    not a per-request nonce).
        const again = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': etag! },
        });
        expect(again.status(), 'stable body → repeat conditional still 304').toBe(304);
    });

    test('Flow 2: collection ETag rotates on mutation — stale validator misses, fresh validator hits', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const H = authedHeaders(u.access_token);
        const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

        // 1. Baseline list (empty for a fresh user) → capture validator V1.
        const before = await request.get(`${API_BASE}/api/works`, { headers: H });
        expect(before.status()).toBe(200);
        const v1 = etagOf(before.headers());
        expect(v1, '/api/works must emit a list ETag').toBeTruthy();

        // 2. Conditional GET with V1 should 304 — the list has not changed.
        const cond1 = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'If-None-Match': v1! },
        });
        expect(cond1.status(), 'unchanged list → conditional 304').toBe(304);

        // 3. MUTATE the collection: create a work. This must invalidate V1.
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: H,
            data: {
                name: `etag-rot-${stamp}`,
                slug: `etag-rot-${stamp}`,
                description: `e2e etag rotation ${stamp}`,
                organization: false,
            },
        });
        expect(create.ok(), `work create failed (${create.status()})`).toBe(true);

        // 4. Re-read: a NEW validator V2 must be issued (content changed).
        const after = await request.get(`${API_BASE}/api/works`, { headers: H });
        expect(after.status()).toBe(200);
        const v2 = etagOf(after.headers());
        expect(v2, '/api/works must still emit an ETag post-mutation').toBeTruthy();
        expect(v2, 'list ETag MUST rotate after a collection mutation').not.toBe(v1);

        // 5. The KEY anti-staleness assertion: a conditional GET still carrying
        //    the PRE-mutation validator V1 must NOT 304 — it must return the
        //    fresh 200 representation. A stale 304 here would be a cache bug.
        const stale = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'If-None-Match': v1! },
        });
        expect(stale.status(), 'stale validator must miss the cache (200, not 304)').toBe(200);
        const staleBody = await stale.json();
        const works = Array.isArray(staleBody)
            ? staleBody
            : (staleBody?.works ?? staleBody?.data ?? []);
        expect(
            works.some((w: { slug?: string; name?: string }) =>
                `${w.slug ?? ''}${w.name ?? ''}`.includes(stamp),
            ),
            '200 served on stale-revalidate must contain the newly created work',
        ).toBe(true);

        // 6. And the FRESH validator V2 now 304s — the cycle is coherent again.
        const cond2 = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'If-None-Match': v2! },
        });
        expect(cond2.status(), 'fresh validator re-establishes 304').toBe(304);
    });

    test('Flow 3: weak comparison + wildcard + list parsing for If-None-Match', async ({
        request,
    }) => {
        // RFC 7232 §3.2: If-None-Match uses the WEAK comparison function. The
        // server's weak validator must therefore match regardless of the W/
        // prefix and must parse a comma-separated candidate list and the `*`
        // wildcard. We pin all three branches against one stable validator.
        const etag = await stableEtag(request, HEALTH);
        expect(etag, 'need a stable validator to compare').toMatch(/^W\//);

        // a) Strong-form candidate (W/ stripped) must STILL 304 under the
        //    mandated weak comparison.
        const strongForm = etag.replace(/^W\//, '');
        const weakCmp = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': strongForm },
        });
        expect(
            weakCmp.status(),
            `weak comparison: strong-form ${strongForm} of weak ${etag} must 304`,
        ).toBe(304);

        // b) Multi-valued list where the real validator is NOT first — proper
        //    list tokenisation must still find it → 304.
        const list = `"nope-aaa", ${etag}, W/"nope-bbb"`;
        const multi = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': list },
        });
        expect(
            multi.status(),
            `multi-valued INM list including the validator must 304: ${list}`,
        ).toBe(304);

        // c) Wildcard `*` matches any existing representation → 304.
        const star = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': '*' },
        });
        expect(star.status(), 'If-None-Match: * must 304 when a representation exists').toBe(304);

        // d) A list of ONLY non-matching validators must MISS → full 200.
        const miss = await request.get(`${API_BASE}${HEALTH}`, {
            headers: { 'If-None-Match': '"x-1", "x-2", W/"x-3"' },
        });
        expect(miss.status(), 'no candidate matches → 200 full response').toBe(200);
        expect((await miss.body()).length, '200 on cache miss must carry the body').toBeGreaterThan(
            0,
        );
    });

    test('Flow 4: cross-user ETag isolation — one user cannot 304-replay another user`s validator', async ({
        request,
    }) => {
        // Cache-poisoning guard: the per-user /api/auth/profile body must be
        // keyed to its owner. If user B can hand user A's profile ETag back to
        // the server and receive a 304, B's client could be served (or could
        // infer) A's representation through a shared cache. The server must
        // instead recompute B's own validator and serve B's 200.
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const profA = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(a.access_token),
        });
        const profB = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(b.access_token),
        });
        expect(profA.status()).toBe(200);
        expect(profB.status()).toBe(200);

        const etagA = etagOf(profA.headers());
        const etagB = etagOf(profB.headers());
        expect(etagA, 'profile A must carry a validator').toBeTruthy();
        expect(etagB, 'profile B must carry a validator').toBeTruthy();
        // Distinct users → distinct identities → distinct validators (even when
        // the serialized lengths coincide).
        expect(etagA, 'distinct users must not share a profile ETag').not.toBe(etagB);

        // Private + no-store is the defence-in-depth that keeps shared caches
        // out of this entirely; assert the contract holds for both users.
        for (const [who, res] of [
            ['A', profA],
            ['B', profB],
        ] as const) {
            expect(
                res.headers()['cache-control'] ?? '',
                `profile ${who} must be private/no-store (not shared-cacheable)`,
            ).toMatch(/\b(private|no-store|no-cache)\b/i);
        }

        // THE poisoning probe: B revalidates using A's validator. Must NOT 304.
        const crossB = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: { ...authedHeaders(b.access_token), 'If-None-Match': etagA! },
        });
        expect(
            crossB.status(),
            'user B presenting user A`s ETag must NOT receive a 304 (would be cross-user cache leak)',
        ).not.toBe(304);
        expect([200, 304]).toContain(crossB.status());
        expect(crossB.status()).toBe(200);

        // And the served body must be B's own profile, never A's.
        const crossBody = await crossB.json();
        const bUser = crossBody?.user ?? crossBody;
        const bEmail = bUser?.email;
        if (bEmail) {
            expect(bEmail, 'cross-user revalidate must return B`s own identity').toBe(b.user.email);
            expect(bEmail, 'must never surface user A`s email').not.toBe(a.user.email);
        }
    });

    test('Flow 5: cache-control discipline — public probe vs private profile, and 304 preservation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // (1) Public health probe: an ETag-revalidatable resource that is NOT
        //     marked private (no per-user secrets) and must not be no-store.
        const health = await request.get(`${API_BASE}${HEALTH}`);
        const healthCC = health.headers()['cache-control'];
        // Express leaves it unset (revalidate purely by ETag). If a policy IS
        // present it must NOT be `private`/`no-store` for a public liveness
        // endpoint — that would defeat shared-cache revalidation pointlessly.
        if (healthCC) {
            expect(
                /\bno-store\b/i.test(healthCC),
                `public /api/health should be ETag-revalidatable, not no-store: "${healthCC}"`,
            ).toBe(false);
        } else {
            test.info().annotations.push({
                type: 'informational',
                description: '/api/health carries no Cache-Control — revalidation is ETag-only',
            });
        }

        // (2) Private profile: per-user data MUST be private/no-store so no
        //     shared cache (CDN/proxy) ever stores it.
        const prof = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(prof.status()).toBe(200);
        const profCC = prof.headers()['cache-control'] ?? '';
        expect(
            profCC,
            `per-user /api/auth/profile must be private/no-store, got "${profCC}"`,
        ).toMatch(/\b(private|no-store|no-cache)\b/i);
        expect(
            /\bpublic\b/i.test(profCC),
            `per-user profile must never be marked publicly cacheable: "${profCC}"`,
        ).toBe(false);

        // (3) On a 304 from a resource that DOES carry Cache-Control, that
        //     directive must be preserved so revalidation does not silently
        //     downgrade cacheability. profile body drifts (lastSeen), so its
        //     own validator may rotate — fetch a fresh one and immediately
        //     revalidate; tolerate the rotation by re-reading once.
        let validator = etagOf(prof.headers());
        let reval = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: { ...authedHeaders(u.access_token), 'If-None-Match': validator! },
        });
        if (reval.status() === 200) {
            // validator rotated between reads — re-grab and retry once.
            validator = etagOf(reval.headers());
            reval = await request.get(`${API_BASE}/api/auth/profile`, {
                headers: { ...authedHeaders(u.access_token), 'If-None-Match': validator! },
            });
        }
        if (reval.status() === 304) {
            const revalCC = reval.headers()['cache-control'] ?? '';
            expect(
                revalCC,
                '304 on a private resource must preserve its private/no-store directive',
            ).toMatch(/\b(private|no-store|no-cache)\b/i);
        } else {
            // Highly dynamic body never settled — assert the freshly served
            // 200 still wears the private policy rather than failing on timing.
            test.info().annotations.push({
                type: 'informational',
                description: `profile validator kept rotating (status ${reval.status()}) — body is per-request dynamic`,
            });
            expect(reval.headers()['cache-control'] ?? '').toMatch(
                /\b(private|no-store|no-cache)\b/i,
            );
        }
    });

    test('Flow 6: validator stability across encoding + verb, and safety against unsafe-verb revalidation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const H = authedHeaders(u.access_token);

        // (1) Weak ETags are content-, not transfer-, derived: requesting the
        //     same resource with and without compression must yield the SAME
        //     weak validator (RFC 9110 §8.8.1 — weak validators are stable
        //     across content-coding). A strong ETag could legitimately differ;
        //     here Express emits weak, so we assert equality.
        const plain = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'Accept-Encoding': 'identity' },
        });
        const gz = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'Accept-Encoding': 'gzip, deflate, br' },
        });
        expect(plain.status()).toBe(200);
        expect(gz.status()).toBe(200);
        const ep = etagOf(plain.headers());
        const eg = etagOf(gz.headers());
        expect(ep, 'works list must carry an ETag').toBeTruthy();
        if (ep && eg && /^W\//.test(ep)) {
            expect(eg, 'weak validator must be identical across content-encoding').toBe(ep);
        }

        // (2) HEAD must support conditional revalidation identically to GET —
        //     a HEAD with the matching validator returns 304, no body, while
        //     a plain HEAD returns 200 + the same validator + zero body.
        const headPlain = await request.head(`${API_BASE}${HEALTH}`);
        expect([200, 304]).toContain(headPlain.status());
        const headEtag = etagOf(headPlain.headers());
        if (headPlain.status() === 200 && headEtag) {
            expect((await headPlain.body()).length, 'HEAD 200 must have empty body').toBe(0);
            const headCond = await request.head(`${API_BASE}${HEALTH}`, {
                headers: { 'If-None-Match': headEtag },
            });
            expect(headCond.status(), 'HEAD honours conditional revalidation → 304').toBe(304);
        }

        // (3) Conditional headers on UNSAFE verbs must not short-circuit the
        //     mutation. A POST carrying If-None-Match must still execute (never
        //     a spurious 304) — conditional GET semantics do not apply to
        //     state-changing requests here.
        const stamp = Date.now().toString(36);
        const postCond = await request.post(`${API_BASE}/api/works`, {
            headers: { ...H, 'If-None-Match': '"irrelevant-for-post"' },
            data: {
                name: `etag-post-${stamp}`,
                slug: `etag-post-${stamp}`,
                description: 'conditional header on POST must be ignored',
                organization: false,
            },
        });
        expect(postCond.status(), 'POST + If-None-Match must not 304').not.toBe(304);
        expect(
            postCond.ok(),
            `mutation must proceed despite conditional header (${postCond.status()})`,
        ).toBe(true);

        // (4) An unmatched If-Match on a SAFE GET must not 5xx. Express does
        //     not enforce If-Match preconditions on GET (it is a no-op for safe
        //     reads), so we assert graceful tolerance rather than a 412.
        const ifMatch = await request.get(`${API_BASE}/api/works`, {
            headers: { ...H, 'If-Match': '"never-the-current-validator"' },
        });
        expect(
            ifMatch.status(),
            'unmatched If-Match on a safe GET must be tolerated (no 5xx)',
        ).toBeLessThan(500);
        expect([200, 304, 412]).toContain(ifMatch.status());
    });
});
