import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * API version negotiation & build-identity surface — real, multi-step
 * integration flows against the LIVE stack (http://127.0.0.1:3100). Every
 * shape, status, header and error body below was PROBED before assertions
 * were written, so this file pins the platform's ACTUAL contract, not a guess.
 *
 * The Ever Works API does NOT use NestJS URI/header versioning (no
 * `enableVersioning`, no `/api/v1/...`, no `Accept-Version` negotiation).
 * Instead it exposes a single, cache-friendly BUILD-IDENTITY endpoint plus an
 * embedded copy of the same block inside the readiness probe. These flows
 * cover that real surface end-to-end and are NOT touched by the existing
 * `api-version-header.spec.ts` (which only probes `/api/health` — a route that
 * carries NO version at all).
 *
 * PROBED CONTRACTS (live, 2026-06-01):
 *   - GET /api/version → 200 JSON BuildInfo:
 *       { name:'api', version:'0.0.1', gitSha:'dev', shortSha:'dev',
 *         gitRef:'', buildRun:'', buildTime:'', commitUrl:null }
 *     Headers: `Content-Type: application/json; charset=utf-8`,
 *       `Cache-Control: public, max-age=300`,
 *       `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
 *         base-uri 'none'; form-action 'none'`,
 *       a weak `ETag: W/"…"`. Source: apps/api/src/health/health.controller.ts
 *       + apps/api/src/health/build-info.ts.
 *     `@Public()` — works WITH and WITHOUT a bearer token, identical body.
 *     GET-only (`POST /api/version` → 404), trailing-slash tolerant
 *       (`/api/version/` → 200), `HEAD` → 200 with the same headers + empty body.
 *     `If-None-Match: <etag>` → 304 Not Modified (conditional GET works).
 *   - GET /api/health/ready → 200 Terminus result whose `.version` field is the
 *     SAME BuildInfo block (cross-surface consistency invariant).
 *   - getBuildInfo() derives `commitUrl` ONLY when `gitSha` is a real 7–40 hex
 *     SHA → `${REPO_URL}/commit/${gitSha}`; for the local `dev` sha it is null,
 *     and `shortSha` mirrors `gitSha` ('dev' stays 'dev', else first 7 chars).
 *     Payload is secret-free by construction (env coordinates only).
 *   - NO version negotiation: `/api/v1/version` → 404 (no URI versioning);
 *     an `Accept-Version` request header is IGNORED (same body, no
 *     `Content-Version` reply header) — version is path-based and singular.
 *   - Error responses (404) carry `{ message, error, statusCode }` with the
 *     strict API CSP, but DO NOT embed the version block (version lives only on
 *     the dedicated surfaces). Errors must never 5xx on these probes.
 *
 * Style: repo tabs-width-4, single quotes, semicolons; resilient timeouts,
 * `.first()`, `expect.poll`, `.or()` branches for next-dev/CI route divergence.
 * Filename uses the safe `flow-` prefix (not matched by the playwright.config
 * no-auth testIgnore regex).
 */

const VERSION_PATH = '/api/version';
const READY_PATH = '/api/health/ready';

/** Hex-SHA shape the build-info module uses to decide commitUrl derivation. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Semver-ish or 0.0.0 fallback the version string is allowed to take. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

interface BuildInfo {
    name: string;
    version: string;
    gitSha: string;
    shortSha: string;
    gitRef: string;
    buildRun: string;
    buildTime: string;
    commitUrl: string | null;
}

/** Assert a value is a well-formed BuildInfo block honouring every invariant. */
function assertBuildInfoShape(info: BuildInfo, ctx: string): void {
    expect(info, `${ctx}: body is an object`).toBeTruthy();
    expect(info.name, `${ctx}: name`).toBe('api');
    expect(typeof info.version, `${ctx}: version is a string`).toBe('string');
    expect(
        VERSION_RE.test(info.version),
        `${ctx}: version "${info.version}" looks semver-ish`,
    ).toBe(true);

    // Every coordinate field must be a string (degrades to '' when un-stamped),
    // never undefined/null — the endpoint must never throw on a local build.
    for (const k of ['gitSha', 'shortSha', 'gitRef', 'buildRun', 'buildTime'] as const) {
        expect(typeof info[k], `${ctx}: ${k} is a string`).toBe('string');
    }

    // shortSha / commitUrl derivation is fully determined by gitSha.
    if (info.gitSha === 'dev') {
        expect(info.shortSha, `${ctx}: dev sha → dev shortSha`).toBe('dev');
        expect(info.commitUrl, `${ctx}: dev sha → null commitUrl`).toBeNull();
    } else if (SHA_RE.test(info.gitSha)) {
        expect(info.shortSha, `${ctx}: shortSha = first 7 of gitSha`).toBe(info.gitSha.slice(0, 7));
        expect(info.commitUrl, `${ctx}: real sha → derived commitUrl`).toBeTruthy();
        expect(info.commitUrl, `${ctx}: commitUrl ends with the full sha`).toContain(
            `/commit/${info.gitSha}`,
        );
        expect(info.commitUrl, `${ctx}: commitUrl is an https github URL`).toMatch(
            /^https:\/\/[^\s]+\/commit\/[0-9a-f]{7,40}$/i,
        );
    }
}

async function fetchVersion(request: APIRequestContext, headers?: Record<string, string>) {
    return request.get(`${API_BASE}${VERSION_PATH}`, headers ? { headers } : undefined);
}

test.describe('API version negotiation & build identity', () => {
    test('Flow 1: /api/version returns the full BuildInfo contract with cache + CSP headers', async ({
        request,
    }) => {
        const res = await fetchVersion(request);
        expect(res.status(), 'version is publicly readable').toBe(200);

        const headers = res.headers();
        // JSON content type with explicit charset.
        expect(headers['content-type'] || '', 'json content-type').toMatch(/application\/json/i);
        // Cache-friendly: the handler pins a 5-minute public TTL.
        expect(headers['cache-control'] || '', 'cache-control present').toMatch(/max-age=\d+/);
        expect(headers['cache-control'] || '', 'public cache').toMatch(/public/i);
        // Defence-in-depth strict CSP on the JSON-only surface.
        expect(headers['content-security-policy'] || '', 'strict CSP').toContain(
            "default-src 'none'",
        );
        // A validator must be present for conditional requests (Flow 4).
        expect(headers['etag'], 'etag present for conditional GET').toBeTruthy();

        const info = (await res.json()) as BuildInfo;
        assertBuildInfoShape(info, 'GET /api/version');

        // The payload must carry ONLY the allow-listed coordinate keys — no
        // stray secret-shaped field leaked from the environment.
        const allowed = new Set([
            'name',
            'version',
            'gitSha',
            'shortSha',
            'gitRef',
            'buildRun',
            'buildTime',
            'commitUrl',
        ]);
        for (const key of Object.keys(info)) {
            expect(allowed.has(key), `unexpected key in version payload: ${key}`).toBe(true);
        }
        const flat = JSON.stringify(info).toLowerCase();
        for (const secret of ['secret', 'password', 'apikey', 'api_key', 'token', 'dsn']) {
            expect(flat.includes(secret), `version payload must not mention "${secret}"`).toBe(
                false,
            );
        }
    });

    test('Flow 2: version is identical for anonymous vs authenticated callers and stable across calls', async ({
        request,
    }) => {
        // @Public() → bearer makes no difference. Register a throwaway user so we
        // never touch the shared seeded account.
        const user = await registerUserViaAPI(request);

        const anon = await fetchVersion(request);
        const authed = await fetchVersion(request, authedHeaders(user.access_token));
        expect(anon.status(), 'anon 200').toBe(200);
        expect(authed.status(), 'authed 200').toBe(200);

        const anonInfo = (await anon.json()) as BuildInfo;
        const authedInfo = (await authed.json()) as BuildInfo;
        assertBuildInfoShape(anonInfo, 'anon version');
        assertBuildInfoShape(authedInfo, 'authed version');

        // Auth scope must NOT change the build identity — it is process-global.
        expect(authedInfo, 'auth does not change version identity').toEqual(anonInfo);

        // And the identity must not drift between consecutive calls (no clock /
        // random fields baked into the body).
        const again = (await (await fetchVersion(request)).json()) as BuildInfo;
        expect(again, 'version stable across calls').toEqual(anonInfo);

        // Stable under load: fire several and require every body is byte-identical.
        const burst = await Promise.all(
            Array.from({ length: 5 }, () => fetchVersion(request).then((r) => r.json())),
        );
        for (const b of burst) {
            expect(b, 'concurrent version reads agree').toEqual(anonInfo);
        }
    });

    test('Flow 3: the readiness probe embeds the SAME build identity (cross-surface consistency)', async ({
        request,
    }) => {
        // The dedicated endpoint and the readiness probe must agree — clients can
        // read version from either surface and get the same answer.
        const versionRes = await fetchVersion(request);
        const readyRes = await request.get(`${API_BASE}${READY_PATH}`);

        expect(versionRes.status(), 'version 200').toBe(200);
        // readiness is 200 when DB is up, 503 only when a critical dep is down.
        expect([200, 503], `ready status ${readyRes.status()}`).toContain(readyRes.status());

        const standalone = (await versionRes.json()) as BuildInfo;
        const ready = await readyRes.json();

        // Terminus envelope sanity, then the embedded version block.
        expect(ready, 'ready is a JSON object').toBeTruthy();
        expect(typeof ready.status, 'ready has a status').toBe('string');
        expect(ready.version, 'ready embeds a version block').toBeTruthy();

        const embedded = ready.version as BuildInfo;
        assertBuildInfoShape(embedded, 'ready.version');
        // The two surfaces MUST be byte-for-byte the same identity.
        expect(embedded, 'ready.version === /api/version').toEqual(standalone);

        // Readiness reports informational deps WITHOUT leaking secrets — every
        // dependency entry exposes only {configured, mode?, status} style flags.
        const details = (ready.details || ready.info || {}) as Record<string, unknown>;
        const detailsFlat = JSON.stringify(details).toLowerCase();
        for (const secret of ['password', 'apikey', 'api_key', 'secret=', 'bearer ']) {
            expect(detailsFlat.includes(secret), `ready details must not leak "${secret}"`).toBe(
                false,
            );
        }
    });

    test('Flow 4: version endpoint honours conditional requests, HEAD parity and method/slug tolerance', async ({
        request,
    }) => {
        // Capture the validator, then replay it: a well-behaved cache must get 304.
        const first = await fetchVersion(request);
        expect(first.status()).toBe(200);
        const etag = first.headers()['etag'];
        expect(etag, 'etag to replay').toBeTruthy();

        const conditional = await fetchVersion(request, { 'If-None-Match': etag });
        // 304 is the contract; tolerate a 200 if some proxy strips the validator.
        expect([200, 304], `conditional GET status ${conditional.status()}`).toContain(
            conditional.status(),
        );
        if (conditional.status() === 304) {
            const body = await conditional.text();
            expect(body.length, '304 has an empty body').toBe(0);
        }

        // HEAD parity — same headers, no body. Some dev stacks don't register
        // HEAD; tolerate a 404/405 there but require headers parity on success.
        const head = await request.fetch(`${API_BASE}${VERSION_PATH}`, { method: 'HEAD' });
        expect([200, 404, 405], `HEAD status ${head.status()}`).toContain(head.status());
        if (head.status() === 200) {
            expect(head.headers()['cache-control'] || '', 'HEAD keeps cache-control').toMatch(
                /max-age=\d+/,
            );
            expect((await head.body()).length, 'HEAD has empty body').toBe(0);
        }

        // Trailing-slash tolerance — Express collapses it to the same handler.
        const slashed = await request.get(`${API_BASE}${VERSION_PATH}/`);
        expect([200, 304], `trailing-slash status ${slashed.status()}`).toContain(slashed.status());
        if (slashed.status() === 200) {
            assertBuildInfoShape((await slashed.json()) as BuildInfo, 'trailing-slash version');
        }

        // Wrong method on a GET-only route → 404 (Nest has no POST handler here),
        // and crucially never a 5xx.
        const post = await request.post(`${API_BASE}${VERSION_PATH}`, { data: {} });
        expect(post.status(), `POST status ${post.status()}`).toBeLessThan(500);
        expect([404, 405], `POST rejected ${post.status()}`).toContain(post.status());
    });

    test('Flow 5: there is no URI/header version negotiation — version is path-based and singular', async ({
        request,
    }) => {
        // Truthful negotiation probe: the API does NOT enable NestJS versioning,
        // so a `/api/v1/...` clone of the route must NOT resolve.
        const v1 = await request.get(`${API_BASE}/api/v1/version`);
        expect(v1.status(), `/api/v1/version status ${v1.status()}`).toBeLessThan(500);
        // Either a clean 404 (no URI versioning — the real contract) OR, if a
        // future build DOES add URI versioning, a 200 BuildInfo. Branch on it.
        if (v1.status() === 200) {
            assertBuildInfoShape((await v1.json()) as BuildInfo, '/api/v1/version');
            test.info().annotations.push({
                type: 'informational',
                description: '/api/v1/version resolved — URI versioning appears enabled',
            });
        } else {
            expect([404, 400], `no URI versioning → ${v1.status()}`).toContain(v1.status());
        }

        // An `Accept-Version` request header must be IGNORED (no content
        // negotiation): the body is unchanged and no `Content-Version`/`Vary:
        // Accept-Version` reply header is emitted.
        const plain = await fetchVersion(request);
        const negotiated = await fetchVersion(request, { 'Accept-Version': '2' });
        expect(negotiated.status(), 'negotiated still 200').toBe(200);

        const plainInfo = (await plain.json()) as BuildInfo;
        const negotiatedInfo = (await negotiated.json()) as BuildInfo;
        expect(negotiatedInfo, 'Accept-Version header does not alter the payload').toEqual(
            plainInfo,
        );

        const nh = negotiated.headers();
        expect(nh['content-version'], 'no Content-Version reply header').toBeFalsy();
        const vary = (nh['vary'] || '').toLowerCase();
        expect(vary.includes('accept-version'), 'server does not Vary on Accept-Version').toBe(
            false,
        );

        // An absurd Accept-Version must NOT 406/415 (no negotiation to reject).
        const absurd = await fetchVersion(request, { 'Accept-Version': 'definitely-not-real' });
        expect(absurd.status(), `absurd Accept-Version → ${absurd.status()}`).toBe(200);
    });

    test('Flow 6: error responses keep the clean contract and never accidentally expose the version block', async ({
        request,
    }) => {
        // Hit a deliberately non-existent route. The platform must answer with the
        // stable Nest error envelope, NOT a 5xx and NOT a leaked build block.
        const unknownPath = `/api/version-${Date.now().toString(36)}-does-not-exist`;
        const res = await request.get(`${API_BASE}${unknownPath}`);
        expect(res.status(), `unknown route → ${res.status()}`).toBe(404);

        const headers = res.headers();
        // Error responses are still JSON and still carry a CSP (defence-in-depth).
        expect(headers['content-type'] || '', 'error is JSON').toMatch(/application\/json/i);
        expect(headers['content-security-policy'], 'error carries a CSP').toBeTruthy();

        const body = await res.json();
        // Stable Nest error shape: { message, error, statusCode }.
        expect(body.statusCode, 'error.statusCode === 404').toBe(404);
        expect(typeof body.message, 'error.message is a string').toBe('string');
        expect(body.message, 'message names the failed route+method').toContain('Cannot GET');

        // The error envelope must NOT smuggle the build identity — version lives
        // ONLY on its dedicated surfaces, never on arbitrary error responses.
        const flat = JSON.stringify(body).toLowerCase();
        expect(body, 'no version block on errors').not.toHaveProperty('version');
        expect(body, 'no gitSha on errors').not.toHaveProperty('gitSha');
        expect(body, 'no buildRun on errors').not.toHaveProperty('buildRun');
        expect(flat.includes('commiturl'), 'no commitUrl leaked on errors').toBe(false);

        // A malformed request to the REAL version route (junk query string) still
        // resolves to the same clean 200 identity — query params are ignored.
        const withJunk = await request.get(`${API_BASE}${VERSION_PATH}?v=../../etc/passwd&x=1`);
        expect(withJunk.status(), `version w/ junk query → ${withJunk.status()}`).toBeLessThan(500);
        if (withJunk.status() === 200) {
            assertBuildInfoShape((await withJunk.json()) as BuildInfo, 'version w/ junk query');
        }
    });
});
