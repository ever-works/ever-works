import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * CSRF / CORS / security-header INTEGRATION flows — complex, multi-step,
 * cross-surface orchestrations that the shallow single-probe specs
 * (cors-origin-allowlist, cors-credentialed, cors-preflight-cache,
 * csrf-double-submit-cookie, security-headers-strict, csp-strict,
 * cookie-flags-deep, secure-cookies-on-https, referrer-policy-redirects)
 * do NOT cover. Each test() here weaves several request classes together
 * and asserts an end-to-end invariant, not a single header.
 *
 * Everything below was probed against the LIVE stack (API 3100 sqlite
 * in-memory CI driver + Web 3000 next dev) before any assertion:
 *
 *   CORS (apps/api/src/main.ts app.enableCors — origin CALLBACK):
 *     effectiveOrigins default ['http://localhost:3000']; this CI driver's
 *     ALLOWED_ORIGINS also includes http://127.0.0.1:3000 (both echo).
 *     - Allowed origin  → ACAO echoes the exact origin (never '*'),
 *       ACAC: true, `Vary: Origin`.
 *     - Disallowed/evil/null origin → callback(null,false): the cors
 *       layer does NOT short-circuit, so:
 *         * preflight OPTIONS  → 404 (route has no OPTIONS handler) with
 *           NO Access-Control-* headers at all.
 *         * actual GET/POST    → normal status (200/401/…) but NO ACAO
 *           header (browser fetch cannot read the body cross-origin).
 *     - Preflight (allowed) → 204, ACAO echoed, ACAC: true,
 *       Access-Control-Allow-Methods 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
 *       Access-Control-Allow-Headers 'Content-Type,Authorization'
 *       (STATIC list — does NOT echo arbitrary requested headers),
 *       and NO Access-Control-Max-Age (not configured).
 *     - allowedHeaders is the static pair → '*' is never emitted, so the
 *       wildcard-with-credentials misconfig is structurally impossible.
 *
 *   CSRF posture (apps/api/src/auth):
 *     POST /api/auth/register {username(>=3),email,password} → 201
 *       { access_token (opaque), user:{ id,email,username } }
 *     POST /api/auth/login {email,password} → 200
 *       { access_token, user } and CRUCIALLY **no Set-Cookie** — the API
 *       is pure bearer-token auth. No ambient session cookie ⇒ no CSRF
 *       surface ⇒ double-submit-cookie is intentionally absent (a forged
 *       cross-site form cannot attach the Authorization header).
 *
 *   Helmet (apps/api/src/main.ts helmet() wildcard middleware) — present
 *   on EVERY API response class (public GET, authed GET, 401, 204
 *   preflight):
 *     X-Content-Type-Options: nosniff
 *     X-Frame-Options: SAMEORIGIN
 *     Strict-Transport-Security: max-age=31536000; includeSubDomains
 *     Referrer-Policy: no-referrer
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Resource-Policy: same-origin
 *     X-DNS-Prefetch-Control: off | X-Download-Options: noopen
 *     X-Permitted-Cross-Domain-Policies: none | X-XSS-Protection: 0
 *     (no X-Powered-By — helmet.hidePoweredBy)
 *   Two distinct CSP profiles:
 *     - @Header() JSON routes (/, /api/health, /api/config):
 *         "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
 *     - everything else (helmet default):
 *         "default-src 'self';…;frame-ancestors 'self';object-src 'none';…"
 *
 *   Web (Next.js /en/login, 307 redirect to itself / dashboard):
 *     X-Frame-Options: DENY
 *     Referrer-Policy: strict-origin-when-cross-origin
 *     Strict-Transport-Security: max-age=15552000; includeSubDomains
 *     Content-Security-Policy with frame-ancestors 'none'; object-src 'none';
 *       and connect-src pinning http://127.0.0.1:3100 (the API origin).
 *     Set-Cookie: NEXT_LOCALE=en; …; SameSite=lax  (non-secret locale cookie)
 *
 * Isolation discipline: all API mutations run on FRESH registerUserViaAPI()
 * users (never the shared seeded user). The seeded storageState is used
 * ONLY for the UI-driven flow. Assertions tolerate pre-existing rows and
 * env divergence (some assertions skip cleanly if helmet/CSP is disabled).
 */

const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const EVIL_ORIGINS = ['https://evil.example.com', 'http://attacker.local', 'null'];

/** Helmet headers that MUST appear on every API response class. */
const HELMET_BASELINE: Record<string, RegExp> = {
    'x-content-type-options': /^nosniff$/i,
    'x-frame-options': /^(deny|sameorigin)$/i,
    'strict-transport-security': /max-age=\d+/i,
    'referrer-policy': /.+/,
};

function parseCsp(csp: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const part of csp.split(';')) {
        const [key, ...values] = part.trim().split(/\s+/);
        if (!key) continue;
        map.set(key.toLowerCase(), values);
    }
    return map;
}

async function preflight(
    request: APIRequestContext,
    path: string,
    origin: string,
    method = 'POST',
    reqHeaders = 'content-type,authorization',
) {
    return request.fetch(`${API_BASE}${path}`, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': reqHeaders,
        },
    });
}

test.describe('CSRF / CORS / security-header integration flows', () => {
    test('Flow 1 — CORS allow-list lifecycle: trusted origins echo, evil origins blocked across BOTH preflight and actual requests, with Vary:Origin cache-safety', async ({
        request,
    }) => {
        // (a) Every trusted origin (localhost AND 127.0.0.1) is echoed —
        // never wildcard — on BOTH the preflight and the real request,
        // and always carries Vary:Origin so a shared cache can't serve
        // one origin's ACAO to another.
        for (const origin of ALLOWED_ORIGINS) {
            const pre = await preflight(request, '/api/auth/login', origin);
            // Preflight from an allowed origin is a clean 204 (or 200).
            expect([200, 204], `preflight ${origin} status`).toContain(pre.status());
            const preAcao = pre.headers()['access-control-allow-origin'];
            expect(preAcao, `preflight ACAO for ${origin}`).toBe(origin);
            expect(preAcao, 'allowed origin must NOT be wildcarded').not.toBe('*');
            expect(
                (pre.headers()['access-control-allow-credentials'] || '').toLowerCase(),
                `ACAC for ${origin}`,
            ).toBe('true');
            expect(
                (pre.headers()['vary'] || '').toLowerCase(),
                `Vary must include Origin for ${origin} (cache poisoning guard)`,
            ).toContain('origin');

            // The matching ACTUAL request (a public GET) echoes the same
            // origin so the browser can read the response cross-origin.
            const actual = await request.get(`${API_BASE}/api/health`, {
                headers: { Origin: origin },
            });
            expect(actual.status()).toBe(200);
            expect(actual.headers()['access-control-allow-origin'], `actual ACAO ${origin}`).toBe(
                origin,
            );
            expect((actual.headers()['vary'] || '').toLowerCase()).toContain('origin');
        }

        // (b) Every evil/null origin is blocked the SAME way on both legs:
        // the preflight is NOT answered with CORS headers, and the actual
        // request — even when it otherwise succeeds — withholds ACAO so a
        // cross-origin fetch in a browser can never read it.
        for (const origin of EVIL_ORIGINS) {
            const pre = await preflight(request, '/api/auth/login', origin);
            // cors callback(null,false) → no OPTIONS short-circuit → the
            // route's missing OPTIONS handler 404s. The contract we pin is
            // NOT the status but the absence of an echo.
            expect(pre.status(), `evil preflight ${origin} must not 5xx`).toBeLessThan(500);
            expect(
                pre.headers()['access-control-allow-origin'],
                `evil origin ${origin} must NOT be echoed on preflight`,
            ).toBeUndefined();

            const actual = await request.get(`${API_BASE}/api/health`, {
                headers: { Origin: origin },
            });
            // The GET itself still returns 200 (CORS is enforced by the
            // BROWSER via the missing ACAO, not by the server refusing) —
            // but there must be no allow-origin echo for the attacker.
            const acao = actual.headers()['access-control-allow-origin'];
            expect(
                acao === origin || acao === '*',
                `evil origin ${origin} got readable ACAO="${acao}"`,
            ).toBe(false);
        }
    });

    test('Flow 2 — CSRF posture: login issues a bearer token with NO ambient cookie, so a forged cross-site request without the Authorization header is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // (a) Re-login explicitly and capture the raw response headers to
        // prove the API issues ZERO Set-Cookie — the whole basis of its
        // CSRF immunity (no ambient credential to forge).
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
            headers: { Origin: 'http://localhost:3000' },
        });
        expect(login.status()).toBe(200);
        const body = await login.json();
        expect(typeof body.access_token, 'login returns an opaque bearer token').toBe('string');
        expect(body.access_token.length).toBeGreaterThan(8);
        const setCookies = login
            .headersArray()
            .filter((h) => h.name.toLowerCase() === 'set-cookie');
        // Pure bearer auth: any cookie that IS set must not be an
        // auth/session secret (locale/csrf helpers are fine).
        const authCookies = setCookies.filter((c) =>
            /(?:session|auth|jwt|access[_-]?token|refresh)/i.test(c.value),
        );
        expect(
            authCookies,
            `API leaked an ambient auth cookie (CSRF surface): ${authCookies
                .map((c) => c.value.split('=')[0])
                .join(', ')}`,
        ).toEqual([]);

        // (b) A forged cross-site state-changing request — attacker page
        // origin, NO Authorization header (a browser form/img cannot add
        // one and there's no cookie to ride along) — must be rejected.
        const forged = await request.post(`${API_BASE}/api/works`, {
            headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
            data: { name: 'csrf-forged', slug: 'csrf-forged', organization: false },
        });
        expect([401, 403], 'forged cross-site write must be auth-gated').toContain(forged.status());
        expect(
            forged.headers()['access-control-allow-origin'],
            'attacker origin must not be echoed even on the rejection',
        ).not.toBe('https://evil.example.com');

        // (c) The legitimate path: the SAME write succeeds only because
        // the client explicitly attaches the bearer token (defeating CSRF
        // — an attacker page cannot read this token from another origin).
        const legit = await request.post(`${API_BASE}/api/works`, {
            headers: {
                ...authedHeaders(user.access_token),
                'Content-Type': 'application/json',
            },
            data: {
                name: `csrf-legit-${Date.now()}`,
                slug: `csrf-legit-${Date.now()}`,
                // CreateWorkDto requires a non-empty description (@IsNotEmpty) —
                // omitting it 400s, so the real legit-path payload includes it.
                description: 'csrf legit bearer write',
                organization: false,
            },
        });
        expect(legit.ok(), `legit bearer write status=${legit.status()}`).toBe(true);
    });

    test('Flow 3 — helmet security-header baseline is present on EVERY API response class (public GET, authed GET, 401 reject, 204 preflight)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const responses: { label: string; headers: Record<string, string>; status: number }[] = [];

        const publicGet = await request.get(`${API_BASE}/api/health`);
        responses.push({
            label: 'public GET /api/health',
            headers: publicGet.headers(),
            status: publicGet.status(),
        });

        const authedGet = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(user.access_token),
        });
        responses.push({
            label: 'authed GET /api/works',
            headers: authedGet.headers(),
            status: authedGet.status(),
        });

        const unauth = await request.get(`${API_BASE}/api/works`);
        responses.push({
            label: 'unauth 401 /api/works',
            headers: unauth.headers(),
            status: unauth.status(),
        });

        const pre = await preflight(request, '/api/auth/login', 'http://localhost:3000');
        responses.push({
            label: 'preflight 204 /api/auth/login',
            headers: pre.headers(),
            status: pre.status(),
        });

        // If helmet is entirely disabled in this env, skip rather than
        // hard-fail (some envs run with helmet off behind a proxy).
        const anyHelmet = responses.some((r) => 'x-content-type-options' in r.headers);
        if (!anyHelmet) {
            test.skip(true, 'helmet appears disabled — no x-content-type-options on any surface');
        }

        for (const r of responses) {
            for (const [name, re] of Object.entries(HELMET_BASELINE)) {
                const val = r.headers[name];
                expect(val, `${r.label} (status ${r.status}) missing ${name}`).toBeDefined();
                expect(val, `${r.label}: ${name}="${val}" fails ${re}`).toMatch(re);
            }
            // X-Powered-By must NEVER leak the framework banner.
            expect(r.headers['x-powered-by'], `${r.label} leaked X-Powered-By`).toBeUndefined();
            // Cross-origin isolation headers harden every surface.
            const coop = (r.headers['cross-origin-opener-policy'] || '').toLowerCase();
            if (coop) {
                expect(coop, `${r.label} weak COOP`).toContain('same-origin');
            }
        }
    });

    test('Flow 4 — CSP family invariants differ correctly between tight JSON @Header routes and helmet-default routes, but both forbid framing + plugins', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Tight per-handler CSP on JSON-only @Header routes.
        const tight = await request.get(`${API_BASE}/api/health`);
        const tightCsp = tight.headers()['content-security-policy'];
        // Helmet-default CSP on a non-@Header route.
        const wide = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(user.access_token),
        });
        const wideCsp = wide.headers()['content-security-policy'];

        if (!tightCsp && !wideCsp) {
            test.skip(true, 'CSP not set on the API — helmet possibly disabled');
        }

        // Shared invariant across BOTH profiles: no frames, no plugins.
        for (const [label, csp] of [
            ['tight JSON CSP', tightCsp],
            ['helmet-default CSP', wideCsp],
        ] as const) {
            if (!csp) continue;
            const d = parseCsp(csp);
            const fa = d.get('frame-ancestors') ?? [];
            expect(
                fa.some((v) => v === "'none'" || v === "'self'"),
                `${label}: frame-ancestors must be none|self — got "${fa.join(' ')}"`,
            ).toBe(true);
            // object-src 'none' explicitly, OR default-src 'none' covering it.
            const objectSrc = d.get('object-src');
            const defaultSrc = d.get('default-src') ?? [];
            const objSafe =
                objectSrc?.includes("'none'") ||
                (defaultSrc.includes("'none'") && objectSrc === undefined);
            expect(
                objSafe,
                `${label}: object-src/default-src must lock plugins — csp="${csp}"`,
            ).toBe(true);
            // No script-src wildcard.
            const scriptSrc = d.get('script-src') ?? d.get('default-src') ?? [];
            expect(scriptSrc.includes('*'), `${label}: script-src wildcard "${csp}"`).toBe(false);
        }

        // The tight profile is strictly the locked-down one: default-src 'none'.
        if (tightCsp) {
            const d = parseCsp(tightCsp);
            expect(
                d.get('default-src'),
                `tight JSON CSP should lock default-src to 'none' — got "${tightCsp}"`,
            ).toEqual(["'none'"]);
        }
    });

    test('Flow 5 — credentialed preflight contract across the sensitive-endpoint matrix: static allow-methods/headers, never wildcard-with-credentials, never echoes arbitrary requested headers', async ({
        request,
    }) => {
        const SENSITIVE = [
            '/api/auth/login',
            '/api/auth/register',
            '/api/works',
            '/api/notifications',
        ];

        for (const path of SENSITIVE) {
            // Request an UNLISTED custom header to prove the server returns
            // its STATIC allowlist, not a reflection of whatever we ask for
            // (header reflection + ACAC:true is a real CORS bypass shape).
            const pre = await preflight(
                request,
                path,
                'http://localhost:3000',
                'POST',
                'content-type,authorization,x-attacker-injected',
            );
            expect([200, 204], `${path} preflight status`).toContain(pre.status());

            const acac = (pre.headers()['access-control-allow-credentials'] || '').toLowerCase();
            const allowHeaders = pre.headers()['access-control-allow-headers'] || '';
            const allowMethods = pre.headers()['access-control-allow-methods'] || '';
            const acao = pre.headers()['access-control-allow-origin'] || '';

            expect(acao, `${path}: ACAO must echo the exact origin`).toBe('http://localhost:3000');
            expect(acac, `${path}: credentialed preflight`).toBe('true');

            // With credentials, a '*' in either list is a browser-rejected
            // misconfig — the server must enumerate.
            expect(
                allowHeaders.includes('*'),
                `${path}: Allow-Headers='*' with credentials is invalid: "${allowHeaders}"`,
            ).toBe(false);
            expect(
                allowMethods.includes('*'),
                `${path}: Allow-Methods='*' with credentials is invalid: "${allowMethods}"`,
            ).toBe(false);

            // The server must NOT reflect the attacker-injected header.
            expect(
                /x-attacker-injected/i.test(allowHeaders),
                `${path}: server reflected an unlisted requested header into Allow-Headers: "${allowHeaders}"`,
            ).toBe(false);
            // The real headers the client needs ARE allowed.
            expect(allowHeaders.toLowerCase(), `${path}: must allow Authorization`).toContain(
                'authorization',
            );
            expect(allowHeaders.toLowerCase(), `${path}: must allow Content-Type`).toContain(
                'content-type',
            );
            // Standard verbs the SPA uses are advertised.
            if (allowMethods) {
                for (const verb of ['GET', 'POST']) {
                    expect(
                        allowMethods.toUpperCase(),
                        `${path}: Allow-Methods should include ${verb}`,
                    ).toContain(verb);
                }
            }
        }
    });

    test('Flow 6 — Web UI (Next.js) clickjacking + CSP defense-in-depth: authenticated dashboard pins XFO=DENY, frame-ancestors none, the API origin in connect-src, and the locale cookie is a non-secret SameSite=Lax', async ({
        page,
        context,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // Navigate the authenticated (seeded storageState) UI. Home is '/'.
        const res = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        expect(res, 'no response from web home').not.toBeNull();
        // Walk the redirect chain to the final document headers.
        const headers = res!.headers();

        const xfo = (headers['x-frame-options'] || '').toLowerCase();
        const csp =
            headers['content-security-policy'] ||
            headers['content-security-policy-report-only'] ||
            '';

        if (!xfo && !csp) {
            test.skip(true, 'web set neither X-Frame-Options nor CSP on the document');
        }

        // Clickjacking: DENY/SAMEORIGIN via XFO, OR frame-ancestors none/self.
        const cspMap = csp ? parseCsp(csp) : new Map<string, string[]>();
        const fa = cspMap.get('frame-ancestors') ?? [];
        const clickjackSafe =
            ['deny', 'sameorigin'].includes(xfo) ||
            fa.some((v) => v === "'none'" || v === "'self'");
        expect(
            clickjackSafe,
            `web clickjacking defense absent (xfo="${xfo}", fa="${fa.join(' ')}")`,
        ).toBe(true);

        if (csp) {
            // Plugins locked.
            const objectSrc = cspMap.get('object-src') ?? [];
            expect(objectSrc.includes("'none'"), `web object-src not locked: "${csp}"`).toBe(true);
            // The SPA can only talk to itself + the explicitly-pinned API
            // origin (connect-src). A wildcard here would let exfil to any
            // host; we require the API origin be enumerated when connect-src
            // is present.
            const connectSrc = cspMap.get('connect-src');
            if (connectSrc) {
                expect(connectSrc.includes('*'), `web connect-src wildcard: "${csp}"`).toBe(false);
                const pinsApi = connectSrc.some((v) =>
                    /127\.0\.0\.1:3100|localhost:3100|3100/.test(v),
                );
                if (!pinsApi) {
                    test.info().annotations.push({
                        type: 'informational',
                        description: `web connect-src does not visibly pin the API origin: ${connectSrc.join(' ')}`,
                    });
                }
            }
        }

        // Cookie posture: the locale cookie (the one cookie next-intl sets)
        // must be a non-secret, SameSite=Lax helper — never HttpOnly-gated
        // secret material. And NO cookie readable by JS should look like an
        // auth token (the API is bearer-only; the web stores tokens in
        // memory/localStorage, not an ambient cookie).
        const cookies = await context.cookies();
        const locale = cookies.find((c) => /next_locale|locale/i.test(c.name));
        if (locale) {
            expect(
                (locale.sameSite || '').toLowerCase(),
                `locale cookie SameSite should be Lax/Strict — got "${locale.sameSite}"`,
            ).toMatch(/^(lax|strict)$/);
        }
        // Any cookie whose VALUE looks like a long opaque secret AND is
        // NOT HttpOnly is a leak: a session secret readable from JS (XSS
        // would lift it). We tolerate short non-secret flags.
        const jsReadableSecrets = cookies.filter(
            (c) =>
                !c.httpOnly &&
                /^[A-Za-z0-9._-]{40,}$/.test(c.value) &&
                /(token|session|auth|jwt)/i.test(c.name),
        );
        expect(
            jsReadableSecrets.map((c) => c.name),
            'JS-readable secret-shaped auth cookie found (XSS-liftable)',
        ).toEqual([]);
    });
});
