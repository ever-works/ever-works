import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Health: liveness vs readiness, dependency-status reporting, version
 * identity, and the public (auth-independent) contract — DEEP.
 *
 * Existing coverage we deliberately do NOT duplicate:
 *   - health-meta.spec.ts        → trivial `GET /api/health` 200 + JSON + latency
 *   - health-degraded-503.spec.ts→ root `/api/health` 200 stability + the
 *     NON-EXISTENT subsystem paths (`/api/health/db`, `/api/health/redis`,
 *     …) which all 404 on this build.
 *
 * This file targets the RICHER Terminus surface those two never touch — the
 * `@nestjs/terminus` HealthController at `apps/api/src/health/`:
 *   - GET /api/health/live   (liveness, no deps)
 *   - GET /api/health/ready  (readiness — DB critical, integrations reported)
 *   - GET /api/version       (build/release identity)
 *
 * Every shape below was probed against the LIVE API (sqlite in-memory, the
 * same driver CI uses) before any assertion was written:
 *
 *   GET /api/health        → 200 { status:'success', message:'API is up and running' }
 *                            (the trivial APIController liveness — kept for k8s)
 *   GET /api/health/live   → 200 { status:'ok', info:{}, error:{}, details:{} }
 *                            Cache-Control: no-cache,no-store,must-revalidate
 *                            CSP: default-src 'none'; …
 *   GET /api/health/ready  → 200 (or 503 when a CRITICAL dep is down) Terminus
 *     HealthCheckResult + an embedded `version` block:
 *       {
 *         status:'ok',
 *         info:    { database:{status:'up'}, ai_provider:{configured,mode,status},
 *                    sentry:{…}, posthog:{…}, trigger_dev:{…}, stripe:{…},
 *                    email:{configured,mode,status}, storage:{configured,mode,status} },
 *         error:   {},
 *         details: { …same as info… },
 *         version: { name:'api', version, gitSha, shortSha, gitRef, buildRun,
 *                    buildTime, commitUrl }
 *       }
 *     • `database` is CRITICAL (a real TypeOrm pingCheck) — it flips status to
 *       'error' + HTTP 503 when down.
 *     • ai_provider / sentry / posthog / trigger_dev / stripe / email / storage
 *       are INFORMATIONAL — ALWAYS reported `up` (they carry { configured, mode }
 *       and never gate readiness; a PostHog/Sentry outage must NOT eject the pod).
 *     • Cache-Control: no-cache,no-store,must-revalidate (must always be fresh).
 *   GET /api/version       → 200 { name:'api', version, gitSha, shortSha, gitRef,
 *                            buildRun, buildTime, commitUrl }
 *                            Cache-Control: public, max-age=300 (cacheable).
 *
 * Auth contract: ALL of /api/health, /api/health/live, /api/health/ready,
 *   /api/version are @Public() — they answer 200 with NO token, with a valid
 *   bearer, AND with a garbage bearer (the probe must never be gated on auth).
 * Method contract: only GET is routed — POST /api/health/ready → 404; HEAD is
 *   parity with GET (200). A bogus subpath /api/health/<x> → 404.
 * Web contract: GET http://web/api/health → 200 { status:'OK', message:… }
 *   (its own Next route, NOT a proxy — must never 5xx).
 *
 * NOTE on "degraded/503": in this sqlite-in-memory CI driver the DB is always
 * up, so the live aggregate is 'ok'/200. We assert the 503 path by CONTRACT —
 * the readiness body is shaped so that `status==='ok' ⇔ HTTP 200` and
 * `error` stays empty while ok — and verify the critical-vs-informational
 * SPLIT (only `database` can ever appear under `error`). We never force a real
 * outage (can't, on this driver) and never hard-assert a 503.
 */

const READINESS_INTEGRATION_KEYS = [
    'ai_provider',
    'sentry',
    'posthog',
    'trigger_dev',
    'stripe',
    'email',
    'storage',
] as const;

type Json = Record<string, unknown>;

async function getJson(
    request: APIRequestContext,
    path: string,
    headers?: Record<string, string>,
): Promise<{ status: number; body: Json; cacheControl: string; csp: string; ctype: string }> {
    const res = await request.get(`${API_BASE}${path}`, headers ? { headers } : undefined);
    const h = res.headers();
    let body: Json = {};
    try {
        body = (await res.json()) as Json;
    } catch {
        body = {};
    }
    return {
        status: res.status(),
        body,
        cacheControl: h['cache-control'] || '',
        csp: h['content-security-policy'] || '',
        ctype: h['content-type'] || '',
    };
}

test.describe('Health — liveness vs readiness, deps, version, public contract', () => {
    test('liveness (/api/health/live) is a cheap dependency-free OK that never embeds deps', async ({
        request,
    }) => {
        // Liveness answers purely on "is the process up" — it must NOT carry
        // any dependency detail (that's readiness' job). Empty info/error/details.
        const live = await getJson(request, '/api/health/live');
        expect(live.status, `live status ${live.status}`).toBe(200);
        expect(live.body.status).toBe('ok');
        expect(live.body.info, 'liveness info must be empty (no deps probed)').toEqual({});
        expect(live.body.error, 'liveness error must be empty').toEqual({});
        expect(live.body.details, 'liveness details must be empty').toEqual({});
        expect(live.ctype.toLowerCase()).toMatch(/json/);

        // Liveness must never be cached — a stale cached 200 would mask a hung
        // process behind a proxy. Contract: no-store.
        expect(
            live.cacheControl.toLowerCase(),
            `live cache-control: "${live.cacheControl}"`,
        ).toContain('no-store');

        // JSON-only API surface still declares the tight CSP (csp-strict sibling).
        expect(live.csp, 'liveness must declare a CSP').toContain("default-src 'none'");

        // Hammer it: liveness is the k8s restart signal — it must never flap.
        for (let i = 0; i < 8; i++) {
            const again = await getJson(request, '/api/health/live');
            expect(again.status, `live iter ${i} → ${again.status}`).toBe(200);
            expect(again.body.status, `live iter ${i} status drift`).toBe('ok');
        }
    });

    test('readiness (/api/health/ready) reports DB + every integration with the right info/error split', async ({
        request,
    }) => {
        const ready = await getJson(request, '/api/health/ready');

        // On the sqlite CI driver the DB is up → aggregate ok → 200. The
        // invariant we pin: status==='ok' MUST mean HTTP 200 (and 'error'
        // MUST mean 503). Branch so this still passes IF a critical dep were
        // ever down in some environment.
        const status = ready.body.status as string;
        expect(['ok', 'error'], `unexpected aggregate status "${status}"`).toContain(status);
        if (status === 'ok') {
            expect(ready.status, 'ok aggregate must be HTTP 200').toBe(200);
            expect(ready.body.error, 'ok aggregate must have empty error map').toEqual({});
        } else {
            // Degraded path (not reachable on this driver, asserted by contract).
            expect(ready.status, 'error aggregate must be HTTP 503').toBe(503);
            expect(
                Object.keys(ready.body.error as Json).length,
                'error aggregate must name >=1 failing dep',
            ).toBeGreaterThan(0);
        }

        const info = ready.body.info as Record<string, Json>;
        const details = ready.body.details as Record<string, Json>;
        expect(info, 'readiness must carry an info block').toBeTruthy();

        // DATABASE is the one critical, actually-pinged dependency. It is always
        // present in the readiness report (under info when up, error when down).
        const dbReported = 'database' in info || 'database' in (ready.body.error as Json);
        expect(dbReported, 'readiness must report the critical `database` dependency').toBe(true);
        if (status === 'ok') {
            expect((info.database as Json)?.status, 'db should be up on the CI driver').toBe('up');
        }

        // Every INFORMATIONAL integration is reported and — by design — ALWAYS
        // `up` (they carry visibility, never gate readiness). Each MUST expose a
        // non-secret { configured:boolean, mode:string } descriptor.
        for (const key of READINESS_INTEGRATION_KEYS) {
            expect(info, `readiness info missing integration "${key}"`).toHaveProperty(key);
            const entry = info[key];
            expect(entry, `${key} entry`).toBeTruthy();
            expect(
                entry.status,
                `informational dep "${key}" must report up (never gates readiness)`,
            ).toBe('up');
            expect(typeof entry.configured, `${key}.configured must be boolean`).toBe('boolean');
            expect(typeof entry.mode, `${key}.mode must be a string label`).toBe('string');
            // Informational deps must NEVER appear under the error map — even if
            // the remote (Sentry/PostHog) is unreachable, they're reported up.
            expect(
                (ready.body.error as Json)[key],
                `informational dep "${key}" must never be in the error map`,
            ).toBeUndefined();
        }

        // info and details mirror each other (Terminus convention).
        expect(Object.keys(details).sort(), 'info/details key sets must match').toEqual(
            Object.keys(info).sort(),
        );

        // Readiness must be uncacheable — load balancers must re-probe each time.
        expect(
            ready.cacheControl.toLowerCase(),
            `ready cache-control: "${ready.cacheControl}"`,
        ).toContain('no-store');
    });

    test('readiness embeds a non-secret build/version block that matches /api/version exactly', async ({
        request,
    }) => {
        // Two independent reads of the same pure getBuildInfo() — readiness
        // embeds it, /api/version exposes it standalone. They must agree.
        const ready = await getJson(request, '/api/health/ready');
        const ver = await getJson(request, '/api/version');

        expect(ver.status).toBe(200);
        const versionBlock = ready.body.version as Json;
        expect(versionBlock, 'readiness must embed a version block').toBeTruthy();

        // Canonical build-info shape (all fields present, name pinned to 'api').
        for (const field of [
            'name',
            'version',
            'gitSha',
            'shortSha',
            'gitRef',
            'buildRun',
            'buildTime',
            'commitUrl',
        ]) {
            expect(versionBlock, `version block missing "${field}"`).toHaveProperty(field);
            expect(ver.body, `/api/version missing "${field}"`).toHaveProperty(field);
        }
        expect(versionBlock.name).toBe('api');
        expect(ver.body.name).toBe('api');

        // The two surfaces must serialize the SAME identity.
        expect(versionBlock, 'embedded vs standalone version must match').toEqual(ver.body);

        // commitUrl is either a real GitHub commit link or null (dev/un-stamped)
        // — never a partial/garbage string.
        const commitUrl = ver.body.commitUrl;
        if (commitUrl !== null) {
            expect(String(commitUrl)).toMatch(
                /^https:\/\/github\.com\/.+\/commit\/[0-9a-f]{7,40}$/i,
            );
        }

        // shortSha is consistent with gitSha (first 7, or 'dev' when unknown).
        const gitSha = String(ver.body.gitSha);
        const shortSha = String(ver.body.shortSha);
        if (gitSha === 'dev') {
            expect(shortSha).toBe('dev');
        } else {
            expect(shortSha).toBe(gitSha.slice(0, 7));
        }

        // Safety: the publishable identity must never leak a secret-looking blob.
        const flat = JSON.stringify(ver.body).toLowerCase();
        expect(flat, 'version payload must not contain secret material').not.toMatch(
            /sk-[a-z0-9]{16}|phc_[a-z0-9]{16}|secret@|bearer\s/,
        );

        // /api/version is explicitly CACHEABLE (public, max-age) — the OPPOSITE
        // of readiness' no-store. This decoupling is the whole point.
        expect(
            ver.cacheControl.toLowerCase(),
            `version cache-control: "${ver.cacheControl}"`,
        ).toMatch(/max-age=\d+/);
        expect(ver.cacheControl.toLowerCase()).toContain('public');
    });

    test('all health/version probes are PUBLIC — answer identically with no token, a valid bearer, and a garbage bearer', async ({
        request,
    }) => {
        // k8s probes + the unauthenticated web footer hit these — they must
        // NEVER be gated on auth. We assert across THREE auth states.
        const fresh = await registerUserViaAPI(request);
        const validAuth = authedHeaders(fresh.access_token);
        const garbageAuth = { Authorization: 'Bearer not.a.real.token.deadbeef' };

        const probes = ['/api/health', '/api/health/live', '/api/health/ready', '/api/version'];

        for (const path of probes) {
            const anon = await getJson(request, path);
            const withValid = await getJson(request, path, validAuth);
            const withGarbage = await getJson(request, path, garbageAuth);

            // Public ⇒ all three return the SAME success status. A garbage
            // bearer in particular must NOT trigger a 401 — that would prove
            // the route is auth-guarded (it isn't / must not be).
            expect(anon.status, `${path} anon status`).toBe(withValid.status);
            expect(withGarbage.status, `${path} garbage-bearer status (must not 401)`).toBe(
                anon.status,
            );
            expect(withGarbage.status, `${path} garbage-bearer must not be 401/403`).not.toBe(401);
            expect([200, 503], `${path} unexpected status ${anon.status}`).toContain(anon.status);
            expect(anon.ctype.toLowerCase(), `${path} content-type`).toMatch(/json/);
        }
    });

    test('liveness and readiness are DECOUPLED and INDEPENDENTLY STABLE under interleaved concurrent load', async ({
        request,
    }) => {
        // The k8s contract: liveness (restart signal) and readiness (traffic
        // signal) are separate probes that can diverge. Fire many of BOTH
        // concurrently and prove neither destabilizes the other.
        const ROUNDS = 14;
        const calls: Promise<{ kind: string; status: number; aggStatus: unknown }>[] = [];
        for (let i = 0; i < ROUNDS; i++) {
            calls.push(
                getJson(request, '/api/health/live').then((r) => ({
                    kind: 'live',
                    status: r.status,
                    aggStatus: r.body.status,
                })),
            );
            calls.push(
                getJson(request, '/api/health/ready').then((r) => ({
                    kind: 'ready',
                    status: r.status,
                    aggStatus: r.body.status,
                })),
            );
        }
        const results = await Promise.all(calls);

        const live = results.filter((r) => r.kind === 'live');
        const ready = results.filter((r) => r.kind === 'ready');
        expect(live.length).toBe(ROUNDS);
        expect(ready.length).toBe(ROUNDS);

        // Liveness is dependency-free → it must be UNCONDITIONALLY 200/ok under
        // any load (it never touches the DB / Redis).
        for (const r of live) {
            expect(r.status, `concurrent live → ${r.status}`).toBe(200);
            expect(r.aggStatus, 'concurrent live aggregate').toBe('ok');
        }

        // Readiness must stay self-consistent: every response respects the
        // ok⇔200 / error⇔503 invariant (no torn states under concurrency).
        for (const r of ready) {
            if (r.aggStatus === 'ok') {
                expect(r.status, 'concurrent ready ok must be 200').toBe(200);
            } else {
                expect(r.status, 'concurrent ready non-ok must be 503').toBe(503);
            }
            expect([200, 503], `concurrent ready unexpected ${r.status}`).toContain(r.status);
        }

        // After the storm, liveness is still trivially healthy (no leaked
        // connections / state corruption from the concurrent readiness pings).
        const after = await getJson(request, '/api/health/live');
        expect(after.status).toBe(200);
        expect(after.body.status).toBe('ok');
    });

    test('health routing: only GET is exposed, HEAD parities GET, wrong method/bogus subpath 404, and web /api/health is its own non-5xx route', async ({
        request,
        baseURL,
    }) => {
        // Method contract — readiness is GET-only; a POST must 404 (route not
        // matched), NOT 405-with-a-body or, worse, a 500.
        const post = await request.post(`${API_BASE}/api/health/ready`);
        expect(post.status(), `POST /api/health/ready → ${post.status()}`).toBe(404);

        // HEAD parity with GET on liveness (probes sometimes use HEAD).
        const head = await request.head(`${API_BASE}/api/health/live`);
        expect(head.status(), `HEAD /api/health/live → ${head.status()}`).toBe(200);

        // A bogus health subpath must 404 — confirms there's no catch-all that
        // would mask a typo'd probe path as healthy.
        const bogus = await request.get(`${API_BASE}/api/health/totally-not-a-real-subsystem`);
        expect(bogus.status(), `bogus subpath → ${bogus.status()}`).toBe(404);

        // The WEB app ships its OWN /api/health (a Next route handler, not an
        // API proxy). It must answer 200 with a JSON body and never 5xx — this
        // is what an external uptime monitor hits on the public origin.
        const origin = baseURL || 'http://localhost:3000';
        const web = await request.get(`${origin}/api/health`);
        expect(web.status(), `web /api/health → ${web.status()}`).toBeLessThan(500);
        if (web.ok()) {
            const ctype = (web.headers()['content-type'] || '').toLowerCase();
            expect(ctype).toMatch(/json/);
            const body = (await web.json()) as Json;
            // Probed shape: { status:'OK', message:'Application is healthy' }.
            expect(body, 'web health must carry a status field').toHaveProperty('status');
            expect(String(body.status).toLowerCase(), `web status: ${body.status}`).toContain('ok');
        }
    });
});
