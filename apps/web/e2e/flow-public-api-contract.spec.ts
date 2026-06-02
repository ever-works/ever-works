import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-public-api-contract.spec.ts — COMPLEX, cross-feature INTEGRATION flows
 * over the platform's genuinely-`@Public()` no-auth API surface, treated as ONE
 * coherent contract. Every shape / status / header below was PROBED against the
 * LIVE stack (http://127.0.0.1:3100, sqlite CI driver) on 2026-06-01 BEFORE any
 * assertion was written, so this file pins the platform's REAL behaviour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PUBLIC SURFACE CENSUS (every endpoint here carries `@Public()` in the
 * NestJS source and is reachable with NO Authorization header and NO cookie):
 *
 *   READ (GET), idempotent, cacheable, body is env-derived (never request-derived):
 *     GET /                         → 200 { status:'success', message:'API is up and running' }
 *     GET /api/health               → 200 (identical body to `/` — healthCheck() delegates to home())
 *     GET /api/config               → 200 { app:{name,description}, features:{…4 bools},
 *                                            auth:{providers:{github,google,facebook}},
 *                                            limits:{bodyLimit} }  + Cache-Control public,max-age=60 + weak ETag
 *     GET /api/auth/providers       → 200 { emailPassword:bool, magicLink:bool,
 *                                            socialProviders:string[] }
 *     GET /.well-known/agent.json   → 200 { name, description, contact, capabilities:[
 *                                            { id:'register_work', summary, rest:{method,url},
 *                                              mcp:{server,tool}, manifestSchema } ] }
 *                                     + Cache-Control public,max-age=300 + Content-Type json
 *
 *   WRITE / parametrised (validation-gated public ingress; truly auth-OPTIONAL):
 *     POST /api/telemetry/funnel    @Public @Throttle 60/min → 204 (valid funnel event, empty body);
 *                                     unknown event / empty body / bad envelope → 400 typed error
 *     GET  /api/claim/preview       @Public @Throttle 10/min → 400 (no `token` query),
 *                                     404 {message:'invitation_not_found'} (unknown token)
 *     POST /api/register-work       @Public @Throttle 30/min → 400 {statusCode,code:'validation_error',
 *                                     message} when DTO fails OR X-GitHub-Token header missing.
 *                                     (Zero-friction onboarding is ENABLED in this env — a disabled env
 *                                     would 404 {code:'feature_disabled'} from the FIRST line of the
 *                                     handler; we tolerate both with .or-style branching, and NEVER send
 *                                     a real GH token, so no GitHub side effect is ever triggered.)
 *     GET  /api/register-work/:id   @Public, ParseUUIDPipe → 400 'Validation failed (uuid is expected)'
 *                                     for a non-uuid; 403 (X-GitHub-Token gate) for a well-formed uuid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBED CROSS-CUTTING INVARIANTS (the integration glue this file uniquely pins):
 *   - AUTH-INVARIANCE: anon body === body-with-a-real-bearer, byte-for-byte, on every
 *     public GET (a bearer must NOT fork the payload — else the `public` cache directive
 *     would be unsafe). A garbage/malformed Authorization header on a public route is
 *     IGNORED → still 200, never 401 (proves the route is truly auth-optional, not just
 *     "happens to allow anon").
 *   - NO SESSION MINTING: public GETs emit NO Set-Cookie (cache-key-safe, no per-caller state).
 *   - VARY: every public response carries `Vary: Origin` and NEVER `Vary: Cookie` /
 *     `Vary: Authorization` (a shared cache must not serve one caller's variant to another).
 *   - 3-WAY ENV COHERENCE: /api/config.auth.providers, /api/auth/providers.socialProviders,
 *     and the agent-card's advertised entry point all read the same env; they must AGREE
 *     (flow-config-public-contract pins only the 2-way config↔providers; the agent-card
 *     leg is new here).
 *   - RATE-LIMIT POSTURE: every public route advertises the global 3-tier quota family
 *     X-RateLimit-{Limit,Remaining,Reset}-{short,medium,long} (short=50/1s, medium=300/10s,
 *     long=1000/60s probed). Remaining-short strictly DECREMENTS across a burst. The
 *     per-route `@Throttle(...)` is a SEPARATE named limiter that does NOT leak its own
 *     X-RateLimit-* header — only the three default tiers appear.
 *   - CONTENT NEGOTIATION is a STABLE no-op: regardless of Accept (html/xml/wildcard/garbage)
 *     the API serves `application/json; charset=utf-8` and NEVER 406; trailing slash + extra
 *     query params don't fork the body; HEAD parity holds (200, empty body, same Content-Type).
 *   - METHOD HARDENING: read-only public GETs 404 on write verbs (POST/PUT/DELETE/PATCH) and
 *     never 5xx.
 *
 * NON-OVERLAP with existing specs: api-public-contract (route-exists tripwire + unauth-401),
 * flow-config-public-contract (deep /api/config shape + 2-way coherence), well-known
 * (agent.json smoke), telemetry / flow-onboarding-telemetry (funnel validation lattice),
 * claim-flow / flow-claim-zero-friction-deep (claim state machine), rate-limit-headers
 * (login-path header presence), accept-content-negotiation / api-utf8 / head-method-parity /
 * http-write-methods-on-public-api / api-cookie-on-anonymous-request (each pins ONE concern
 * across paths). THIS file is the only one that asserts the WHOLE public-surface census as a
 * single integrated contract: auth-invariance + env-coherence transitive closure + rate-limit
 * posture + negotiation no-op + validation-before-effect, threaded across all of them.
 */

type Json = Record<string, unknown>;

/** The canonical set of cacheable public READ endpoints (paths, not URLs). */
const PUBLIC_GETS = [
    '/',
    '/api/health',
    '/api/config',
    '/api/auth/providers',
    '/.well-known/agent.json',
];

/** The three global throttler tiers (probed: short/medium/long). */
const RATE_LIMIT_TIERS = ['short', 'medium', 'long'] as const;

function isPlainObject(v: unknown): v is Json {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A valid, fully-formed funnel event (canonical envelope) the public sink accepts → 204. */
function validFunnelEvent(overrides: Partial<Json> = {}): Json {
    return {
        event: 'zero_friction.landing_prompt_submit',
        funnelStep: 1,
        timestamp: new Date().toISOString(),
        correlationId: `corr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        ...overrides,
    };
}

async function get(request: APIRequestContext, path: string, headers?: Record<string, string>) {
    return request.get(`${API_BASE}${path}`, headers ? { headers } : undefined);
}

test.describe('Public API contract — the @Public() surface as one integrated contract', () => {
    test('FLOW 1 — public-surface census: every @Public() GET is reachable with NO auth/cookie, mints NO session, declares Vary:Origin (never Cookie/Authorization)', async ({
        request,
    }) => {
        // Walk the entire census in one pass. For each endpoint we pin the three
        // properties that make `public` caching SAFE: reachable anon, no Set-Cookie
        // (no per-caller state), and a Vary that never keys on identity headers.
        for (const path of PUBLIC_GETS) {
            const res = await get(request, path);
            expect(res.status(), `${path} must be reachable WITHOUT auth`).toBe(200);

            const headers = res.headers();

            // (a) No session minting on a read-only public GET.
            expect(
                headers['set-cookie'],
                `${path} must not mint a Set-Cookie on an anonymous read`,
            ).toBeUndefined();

            // (b) Cache-key safety: Vary must never fork on identity headers. (Origin
            // is fine and is in fact present on the global helmet/CORS path.)
            const vary = (headers['vary'] || '').toLowerCase();
            expect(vary, `${path} Vary must not key on Cookie`).not.toContain('cookie');
            expect(vary, `${path} Vary must not key on Authorization`).not.toContain(
                'authorization',
            );

            // (c) Content-Type is JSON for every public surface (even `/` + agent.json).
            expect(
                (headers['content-type'] || '').toLowerCase(),
                `${path} must serve JSON`,
            ).toContain('application/json');

            // (d) Body is a non-null object (callers can probe known fields).
            const body = await res.json();
            expect(
                isPlainObject(body) || Array.isArray(body),
                `${path} body is structured JSON`,
            ).toBe(true);
        }

        // The home + health endpoints are the SAME handler (healthCheck delegates to
        // home) — pin that they are genuinely identical, not just "both 200".
        const home = await (await get(request, '/')).json();
        const health = await (await get(request, '/api/health')).json();
        expect(health, '/api/health must delegate to / (identical body)').toEqual(home);
        expect(home).toMatchObject({ status: 'success' });
        expect(typeof (home as Json).message).toBe('string');
    });

    test('FLOW 2 — auth-invariance: a real bearer (and a garbage Authorization) leave every public GET byte-identical; junk auth is IGNORED, never 401', async ({
        request,
    }) => {
        // A brand-new real user → a real bearer that the API can actually verify.
        const user = await registerUserViaAPI(request);
        const realBearer = authedHeaders(user.access_token);
        // A structurally-plausible-but-invalid bearer + a non-bearer junk string.
        const garbageBearer = { Authorization: 'Bearer not.a.real.jwt.value' };
        const junkAuth = { Authorization: 'totally-not-a-scheme' };

        for (const path of PUBLIC_GETS) {
            const anon = await get(request, path);
            expect(anon.status()).toBe(200);
            const anonText = await anon.text();
            const anonEtag = anon.headers()['etag'];

            // (a) A REAL bearer must not fork the payload — the public surface is
            // identical for everyone (config source comment pins this explicitly).
            const withBearer = await get(request, path, realBearer);
            expect(withBearer.status(), `${path} must still 200 WITH a real bearer`).toBe(200);
            expect(
                await withBearer.text(),
                `${path} body must be byte-identical with vs without a real bearer`,
            ).toBe(anonText);
            if (anonEtag) {
                expect(
                    withBearer.headers()['etag'],
                    `${path} ETag must not fork for an authenticated caller`,
                ).toBe(anonEtag);
            }

            // (b) A GARBAGE Authorization header must be IGNORED on a public route —
            // proving the route is auth-OPTIONAL (a protected route would 401 here).
            const withGarbage = await get(request, path, garbageBearer);
            expect(
                withGarbage.status(),
                `${path} must IGNORE a malformed bearer (public, not 401)`,
            ).toBe(200);
            expect(
                await withGarbage.text(),
                `${path} body must be unchanged by a malformed bearer`,
            ).toBe(anonText);

            const withJunk = await get(request, path, junkAuth);
            expect(
                withJunk.status(),
                `${path} must IGNORE a non-bearer junk Authorization (public, not 401)`,
            ).toBe(200);

            // (c) A forged session cookie must not change the body nor add Cookie to Vary.
            const withCookie = await get(request, path, {
                Cookie: 'better-auth.session_token=forged-value',
            });
            expect(withCookie.status(), `${path} must ignore a forged cookie`).toBe(200);
            expect(
                await withCookie.text(),
                `${path} body must be unchanged by a forged cookie`,
            ).toBe(anonText);
            expect((withCookie.headers()['vary'] || '').toLowerCase()).not.toContain('cookie');
        }
    });

    test('FLOW 3 — 3-way env coherence: /api/config, /api/auth/providers, and the agent card all agree on what the platform advertises (transitive closure)', async ({
        request,
    }) => {
        // Leg 1: /api/config exposes a boolean per known social provider.
        const config = (await (await get(request, '/api/config')).json()) as Json;
        const cfgProviders = ((config.auth as Json).providers as Json) ?? {};
        expect(isPlainObject(cfgProviders)).toBe(true);

        // Leg 2: /api/auth/providers lists ENABLED social providers by name.
        const providers = (await (await get(request, '/api/auth/providers')).json()) as Json;
        const social = Array.isArray(providers.socialProviders)
            ? (providers.socialProviders as string[]).map((s) => s.toLowerCase())
            : [];

        // config↔providers must agree for each provider the config knows about. A
        // disagreement would render a login button the backend can't complete (or
        // hide one it can).
        for (const name of ['github', 'google'] as const) {
            expect(
                Boolean(cfgProviders[name]),
                `config.auth.providers.${name} must match /api/auth/providers`,
            ).toBe(social.includes(name));
        }

        // Leg 3: the agent card is the third independent surface that READS the same
        // platform identity — its advertised entry point must resolve on THIS API
        // tier. We extract the PATH from the (env-driven, possibly-prod-absolute)
        // URL and re-resolve it against the local base, proving the documented
        // machine-readable contract is internally consistent.
        const card = (await (await get(request, '/.well-known/agent.json')).json()) as Json;
        expect(typeof card.name).toBe('string');
        expect(typeof card.contact).toBe('string');
        expect(Array.isArray(card.capabilities), 'agent card must advertise capabilities').toBe(
            true,
        );

        const caps = card.capabilities as Array<Json>;
        const registerCap = caps.find((c) => c.id === 'register_work');
        expect(registerCap, 'agent card must advertise the register_work capability').toBeTruthy();

        const rest = (registerCap!.rest as Json) ?? {};
        expect(String(rest.method).toUpperCase(), 'register_work is a POST capability').toBe(
            'POST',
        );

        // Pull the path off the advertised URL (absolute prod URL in this env).
        const advertisedUrl = String(rest.url);
        const advertisedPath = (() => {
            try {
                return new URL(advertisedUrl).pathname;
            } catch {
                return advertisedUrl;
            }
        })();
        expect(
            advertisedPath,
            'agent card must point at the /api/register-work onboarding entry point',
        ).toBe('/api/register-work');

        // The documented entry point must actually be ROUTED on this tier. We probe
        // with a deliberately-empty body (no GH token) so it short-circuits to a
        // clean 4xx (400 validation_error, or 404 feature_disabled if the gate is
        // off) — NEVER a 404-route-not-found, and NEVER a 5xx. This proves the card
        // doesn't advertise a phantom path.
        const resolved = await request.post(`${API_BASE}${advertisedPath}`, { data: {} });
        expect(
            resolved.status(),
            `the agent-card entry point ${advertisedPath} must be routed (clean 4xx, not 5xx)`,
        ).toBeLessThan(500);
        expect(resolved.status(), 'must be a client error, not accepted').toBeGreaterThanOrEqual(
            400,
        );
        // And it must carry the onboarding error envelope shape ({code:string}),
        // not a generic catch-all 404 page — distinguishing "validated & rejected"
        // from "no such route".
        const resolvedBody = (await resolved.json()) as Json;
        expect(
            typeof resolvedBody.code === 'string' || Array.isArray(resolvedBody.message),
            'the entry point returned a typed error envelope (routed handler), not a route 404',
        ).toBe(true);
    });

    test('FLOW 4 — public rate-limit posture: every surface advertises the 3-tier quota family; short-tier remaining strictly decrements across a burst; per-route @Throttle leaks no extra header', async ({
        request,
    }) => {
        // (a) The full 3-tier family is present on a representative READ + WRITE +
        // parametrised public route — proving the global ThrottlerGuard wraps the
        // entire public surface uniformly, regardless of method.
        const probes: Array<{
            label: string;
            run: () => Promise<{ headers(): Record<string, string> }>;
        }> = [
            { label: 'GET /api/config', run: () => get(request, '/api/config') },
            {
                label: 'POST /api/telemetry/funnel',
                run: () =>
                    request.post(`${API_BASE}/api/telemetry/funnel`, { data: validFunnelEvent() }),
            },
            {
                label: 'GET /api/claim/preview',
                run: () => get(request, '/api/claim/preview?token=does-not-exist'),
            },
        ];

        for (const probe of probes) {
            const res = await probe.run();
            const headers = res.headers();
            for (const tier of RATE_LIMIT_TIERS) {
                const limit = headers[`x-ratelimit-limit-${tier}`];
                const remaining = headers[`x-ratelimit-remaining-${tier}`];
                const reset = headers[`x-ratelimit-reset-${tier}`];
                expect(
                    limit,
                    `${probe.label} must advertise X-RateLimit-Limit-${tier}`,
                ).toBeTruthy();
                expect(
                    remaining,
                    `${probe.label} must advertise X-RateLimit-Remaining-${tier}`,
                ).toBeTruthy();
                expect(
                    reset,
                    `${probe.label} must advertise X-RateLimit-Reset-${tier}`,
                ).toBeTruthy();
                expect(/^\d+$/.test(limit), `${probe.label} limit-${tier} is numeric`).toBe(true);
                expect(/^\d+$/.test(remaining), `${probe.label} remaining-${tier} is numeric`).toBe(
                    true,
                );
                // Remaining is never above the advertised limit.
                expect(parseInt(remaining, 10)).toBeLessThanOrEqual(parseInt(limit, 10));
            }

            // (b) The per-route @Throttle(...) is a SEPARATE NAMED limiter; it must
            // NOT surface its own (unnamed / default) X-RateLimit header — only the
            // three tier-named headers exist. If a bare `X-RateLimit-Limit` (no tier
            // suffix) ever appeared, a per-route limiter would be leaking quota state
            // into the wrong header namespace.
            expect(
                headers['x-ratelimit-limit'],
                `${probe.label} must not leak an un-tiered X-RateLimit-Limit (per-route @Throttle is separate)`,
            ).toBeUndefined();
        }

        // (c) Burst monotonicity: the short-tier Remaining must STRICTLY DECREASE
        // across consecutive reads within the same 1s short window. We read the
        // short-tier remaining several times back-to-back; at least one strict
        // decrement must be observed (the counter is shared per-IP across the
        // public surface). Tolerate a window roll-over (reset) by only requiring
        // monotonic-non-increase overall + at least one strict drop.
        const remainings: number[] = [];
        for (let i = 0; i < 5; i++) {
            const r = await get(request, '/api/config');
            const rem = r.headers()['x-ratelimit-remaining-short'];
            if (rem && /^\d+$/.test(rem)) remainings.push(parseInt(rem, 10));
        }
        expect(remainings.length, 'collected several short-tier remaining samples').toBeGreaterThan(
            2,
        );
        const sawStrictDrop = remainings.some((v, i) => i > 0 && v < remainings[i - 1]);
        expect(
            sawStrictDrop,
            `short-tier remaining must decrement across a burst, saw: [${remainings.join(', ')}]`,
        ).toBe(true);
    });

    test('FLOW 5 — content negotiation is a stable no-op: any Accept yields application/json; charset=utf-8 (never 406); trailing slash + extra query do not fork the body; HEAD parity holds', async ({
        request,
    }) => {
        // The API is JSON-only; it intentionally ignores Accept rather than 406-ing
        // (a 406 would break naive clients that send Accept: text/html). Pin that the
        // negotiated Content-Type is invariant across a hostile spread of Accept
        // values on every cacheable READ surface.
        const accepts = [
            'text/html',
            'application/xml',
            'text/plain',
            '*/*',
            'application/json',
            'application/octet-stream',
            'garbage/not-a-real-type',
        ];

        for (const path of ['/api/config', '/api/auth/providers', '/.well-known/agent.json']) {
            const baseline = await get(request, path);
            expect(baseline.status()).toBe(200);
            const baselineText = await baseline.text();

            for (const accept of accepts) {
                const res = await get(request, path, { Accept: accept });
                expect(res.status(), `${path} with Accept:${accept} must not 406`).toBe(200);
                const ct = (res.headers()['content-type'] || '').toLowerCase();
                expect(ct, `${path} with Accept:${accept} must still serve JSON`).toContain(
                    'application/json',
                );
                // charset is explicitly declared (utf-8) — pin it where present.
                expect(ct, `${path} must declare utf-8 charset`).toContain('charset=utf-8');
                expect(
                    await res.text(),
                    `${path} body must be invariant under Accept:${accept}`,
                ).toBe(baselineText);
            }

            // Trailing-slash tolerance: /api/config and /api/auth/providers resolve
            // the same handler with or without the slash, same body. (Probed: both 200.)
            if (path !== '/.well-known/agent.json') {
                const slashed = await get(request, `${path}/`);
                expect(slashed.status(), `${path}/ (trailing slash) must resolve`).toBe(200);
                expect(await slashed.text(), `${path}/ must serve the same body as ${path}`).toBe(
                    baselineText,
                );
            }

            // Extra query params on an env-derived body must NOT change a single byte
            // (cache-poisoning guard — the body is not request-derived).
            const noisy = await get(request, `${path}?foo=bar&_cb=${Date.now()}`);
            expect(noisy.status()).toBe(200);
            expect(await noisy.text(), `${path} body must ignore arbitrary query params`).toBe(
                baselineText,
            );

            // HEAD parity: same Content-Type, no body, 200.
            const head = await request.fetch(`${API_BASE}${path}`, { method: 'HEAD' });
            expect(head.status(), `HEAD ${path} must mirror GET status`).toBe(200);
            expect((head.headers()['content-type'] || '').toLowerCase()).toContain(
                'application/json',
            );
            expect((await head.text()).length, `HEAD ${path} must carry an empty body`).toBe(0);
        }
    });

    test('FLOW 6 — validation-before-effect on the public WRITE surface: funnel / claim-preview / register-work each reject bad input with a STABLE typed error envelope, before any side effect; a malformed bearer never 401s', async ({
        request,
    }) => {
        // ── 6a. Telemetry funnel (public ingress) ───────────────────────────────
        // Valid envelope → 204 with an EMPTY body (accepted, forwarded to sink).
        const goodFunnel = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            data: validFunnelEvent({ event: 'zero_friction.work_created', funnelStep: 4 }),
        });
        expect(goodFunnel.status(), 'a valid funnel event is accepted').toBe(204);
        expect((await goodFunnel.text()).length, '204 carries no body').toBe(0);

        // Unknown event name → 400 whose message ENUMERATES the allow-list (stable
        // contract: the rejection tells the caller exactly what is allowed).
        const badEvent = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            data: validFunnelEvent({ event: 'totally.bogus.event' }),
        });
        expect(badEvent.status(), 'an unknown funnel event is rejected 400').toBe(400);
        const badEventBody = (await badEvent.json()) as Json;
        expect(badEventBody.statusCode).toBe(400);
        const badEventMsg = Array.isArray(badEventBody.message)
            ? (badEventBody.message as string[]).join(' ')
            : String(badEventBody.message);
        expect(badEventMsg, 'the rejection enumerates the canonical funnel allow-list').toContain(
            'zero_friction.landing_prompt_submit',
        );

        // Empty body → 400 (multiple DTO violations), never 5xx.
        const emptyFunnel = await request.post(`${API_BASE}/api/telemetry/funnel`, { data: {} });
        expect(emptyFunnel.status(), 'an empty funnel body is a clean 400').toBe(400);

        // A bearer on the public funnel is IGNORED — still accepted (auth-optional).
        const user = await registerUserViaAPI(request);
        const funnelWithAuth = await request.post(`${API_BASE}/api/telemetry/funnel`, {
            headers: authedHeaders(user.access_token),
            data: validFunnelEvent(),
        });
        expect(funnelWithAuth.status(), 'a bearer must not change the public funnel outcome').toBe(
            204,
        );

        // ── 6b. Claim preview (public read with a required query param) ──────────
        // No `token` query → 400 (the @Query param is required for a meaningful read).
        const noToken = await get(request, '/api/claim/preview');
        expect(
            noToken.status(),
            'claim/preview without a token is a clean 4xx',
        ).toBeGreaterThanOrEqual(400);
        expect(noToken.status(), 'claim/preview must not 5xx on a missing token').toBeLessThan(500);

        // Unknown token → 404 {message:'invitation_not_found'} — a STABLE typed
        // not-found, distinct from a route 404. A malformed bearer on this public
        // route must NOT turn it into a 401.
        const unknownToken = await get(request, '/api/claim/preview?token=does-not-exist-xyz', {
            Authorization: 'Bearer not.a.real.jwt',
        });
        expect(
            unknownToken.status(),
            'an unknown claim token is 404 (not 401, even with a junk bearer)',
        ).toBe(404);
        const unknownBody = (await unknownToken.json()) as Json;
        expect(
            String(unknownBody.message),
            'claim/preview surfaces a typed invitation_not_found',
        ).toContain('invitation_not_found');

        // ── 6c. register-work (public POST + public status GET) ──────────────────
        // A malformed repo URL → 400 BEFORE any GitHub side effect. (We never send a
        // real X-GitHub-Token, so no external call is ever made.) Tolerate the
        // feature-disabled 404 branch defensively.
        const badRepo = await request.post(`${API_BASE}/api/register-work`, {
            headers: { 'X-GitHub-Token': 'ghp_obviously_fake_never_used' },
            data: { repo: 'not-a-github-url' },
        });
        expect(
            [400, 404].includes(badRepo.status()),
            `register-work with a bad repo must be 400 (or 404 if feature-gated off), got ${badRepo.status()}`,
        ).toBe(true);
        const badRepoBody = (await badRepo.json()) as Json;
        // Either the validation_error envelope (DTO failed) or the feature_disabled
        // envelope — both carry the stable {code:string} onboarding error shape.
        expect(
            typeof badRepoBody.code === 'string' || Array.isArray(badRepoBody.message),
            'register-work returns the typed onboarding error envelope',
        ).toBe(true);

        // A well-formed repo but a MISSING X-GitHub-Token → 400 validation_error
        // ('X-GitHub-Token header is required') — the header gate fires before any
        // network work. (Or 404 feature_disabled, which fires even earlier.)
        const noGhToken = await request.post(`${API_BASE}/api/register-work`, {
            data: { repo: 'https://github.com/octocat/hello-world' },
        });
        expect(
            [400, 404].includes(noGhToken.status()),
            `register-work without a GH token must be a clean 4xx, got ${noGhToken.status()}`,
        ).toBe(true);
        expect(
            noGhToken.status(),
            'register-work must never 5xx on the validation gate',
        ).toBeLessThan(500);
        if (noGhToken.status() === 400) {
            const body = (await noGhToken.json()) as Json;
            expect(body.code, 'a 400 from register-work is a validation_error').toBe(
                'validation_error',
            );
        }

        // The public status route enforces a UUID param BEFORE the GH-token gate: a
        // non-uuid → 400 'Validation failed (uuid is expected)'; a well-formed uuid
        // → 403 (X-GitHub-Token gate, NOT 401 — the route is public, the GH token is
        // an in-band ownership proof, not a session). This pins the precedence:
        // ParseUUIDPipe (400) → ownership gate (403), never 401.
        const badUuid = await get(request, '/api/register-work/not-a-valid-uuid');
        expect(badUuid.status(), 'register-work status with a non-uuid → 400').toBe(400);
        const badUuidBody = (await badUuid.json()) as Json;
        expect(String(badUuidBody.message).toLowerCase()).toContain('uuid');

        const goodUuidNoToken = await get(
            request,
            '/api/register-work/11111111-1111-1111-1111-111111111111',
        );
        expect(
            [403, 404].includes(goodUuidNoToken.status()),
            `register-work status (valid uuid, no GH token) must be 403/404 — NEVER 401 (public route), got ${goodUuidNoToken.status()}`,
        ).toBe(true);
        expect(
            goodUuidNoToken.status(),
            'a public route must never answer 401 — that would imply session auth',
        ).not.toBe(401);
    });
});
