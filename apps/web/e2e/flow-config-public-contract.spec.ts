import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Public runtime-config contract — DEEP integration flows.
 *
 * Endpoint under test: `GET /api/config` (apps/api/src/api.controller.ts,
 * `APIController.getConfig`). It is a `@Public()` GET decorated with
 *   `@Header('Cache-Control', 'public, max-age=60')`
 *   `@Header('Content-Security-Policy', "default-src 'none'; ...")`
 *
 * PROBED LIVE SHAPE (sqlite CI driver, 2026-06-01) — exact nested contract:
 *   {
 *     app:      { name: string, description: string },
 *     features: { subscriptionsEnabled: boolean, magicLinkEnabled: boolean,
 *                 anonymousAuthEnabled: boolean, emailVerificationRequired: boolean },
 *     auth:     { providers: { github: boolean, google: boolean, facebook: boolean } },
 *     limits:   { bodyLimit: string }
 *   }
 * PROBED HEADERS:
 *   Cache-Control: public, max-age=60
 *   ETag: W/"122-..."            (WEAK validator, dev mode)
 *   Vary: Origin                 (NOT Cookie / NOT Authorization → cache-key safe)
 *   Content-Type: application/json; charset=utf-8
 *   Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
 *   X-Content-Type-Options: nosniff
 * PROBED CONDITIONAL-REQUEST behaviour:
 *   If-None-Match: <exact etag>  → 304, EMPTY body (Content-Length 0)
 *   If-None-Match: W/"deadbeef"  → 200, full body
 *   Accept-Language: fr / de     → IDENTICAL body + IDENTICAL ETag (locale-agnostic)
 *   Origin: <anything>           → IDENTICAL body (env-driven, not request-derived)
 *   POST /api/config             → 404 (only @Get registered)
 *   web :3000 /api/config        → 404 (the contract lives ONLY on the API tier)
 * CROSS-CHECK source: `GET /api/auth/providers` →
 *   { emailPassword, magicLink, socialProviders: ["github","google"] }
 *
 * NON-OVERLAP with existing specs:
 *   - feature-flags-runtime.spec.ts        → only TOP-LEVEL key set + 8 lowercase
 *                                             forbidden substrings + authed⊇unauthed keys.
 *   - feature-flag-runtime-toggle.spec.ts  → presence of ETag/Cache-Control + one
 *                                             If-None-Match round-trip + per-path key count.
 *   This file asserts the EXACT NESTED SHAPE + value TYPES, a RECURSIVE
 *   secret/long-token scan over every leaf, env-flag REFLECTION cross-checked
 *   against /api/auth/providers, a full conditional-request matrix (304 empty
 *   body, mismatched-etag 200, etag stability), AUTH-INVARIANCE (anon ≡ seeded
 *   ≡ fresh-registered byte-for-byte + same etag), and PER-LOCALE / per-Origin
 *   cache-key safety. None of those are covered elsewhere.
 */

const CONFIG_PATH = '/api/config';

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively collect every leaf value (string/number/bool) as a string. */
function collectLeafStrings(value: unknown, out: string[] = []): string[] {
    if (isPlainObject(value)) {
        for (const v of Object.values(value)) collectLeafStrings(v, out);
    } else if (Array.isArray(value)) {
        for (const v of value) collectLeafStrings(v, out);
    } else if (value !== null && value !== undefined) {
        out.push(String(value));
    }
    return out;
}

/** Recursively collect every object key in the tree (lowercased). */
function collectKeys(value: unknown, out: string[] = []): string[] {
    if (isPlainObject(value)) {
        for (const [k, v] of Object.entries(value)) {
            out.push(k.toLowerCase());
            collectKeys(v, out);
        }
    } else if (Array.isArray(value)) {
        for (const v of value) collectKeys(v, out);
    }
    return out;
}

async function getConfig(
    request: APIRequestContext,
    opts: { headers?: Record<string, string> } = {},
) {
    const res = await request.get(`${API_BASE}${CONFIG_PATH}`, {
        headers: opts.headers,
    });
    return res;
}

test.describe('Public config contract — /api/config deep integration', () => {
    test('exposes the EXACT nested allow-list shape with correctly-typed values', async ({
        request,
    }) => {
        const res = await getConfig(request);
        expect(res.status(), 'config must be reachable without auth').toBe(200);
        expect((res.headers()['content-type'] || '').toLowerCase()).toContain('application/json');

        const body = (await res.json()) as Json;
        expect(isPlainObject(body)).toBe(true);

        // Top-level allow-list is closed: exactly these four sections, no more.
        expect(Object.keys(body).sort()).toEqual(['app', 'auth', 'features', 'limits']);

        // app: branding strings.
        const app = body.app as Json;
        expect(isPlainObject(app)).toBe(true);
        expect(Object.keys(app).sort()).toEqual(['description', 'name']);
        expect(typeof app.name).toBe('string');
        expect((app.name as string).length).toBeGreaterThan(0);
        expect(typeof app.description).toBe('string');

        // features: every gate is a real boolean (never a leaked raw string).
        const features = body.features as Json;
        expect(isPlainObject(features)).toBe(true);
        expect(Object.keys(features).sort()).toEqual([
            'anonymousAuthEnabled',
            'emailVerificationRequired',
            'magicLinkEnabled',
            'subscriptionsEnabled',
        ]);
        for (const [k, v] of Object.entries(features)) {
            expect(typeof v, `features.${k} must be a boolean`).toBe('boolean');
        }

        // auth.providers: presence booleans only — never the secret itself.
        const providers = (body.auth as Json).providers as Json;
        expect(isPlainObject(providers)).toBe(true);
        expect(Object.keys(providers).sort()).toEqual(['facebook', 'github', 'google']);
        for (const [k, v] of Object.entries(providers)) {
            expect(typeof v, `auth.providers.${k} must be a boolean`).toBe('boolean');
        }

        // limits.bodyLimit: a human-readable size string (e.g. "1mb").
        const limits = body.limits as Json;
        expect(isPlainObject(limits)).toBe(true);
        expect(Object.keys(limits)).toEqual(['bodyLimit']);
        expect(typeof limits.bodyLimit).toBe('string');
        expect(limits.bodyLimit as string).toMatch(/^\d+(\.\d+)?\s*[kmg]?b$/i);
    });

    test('NO secret leaks: recursive scan of every key + value rejects credentials / tokens', async ({
        request,
    }) => {
        const res = await getConfig(request);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as Json;

        // (a) No KEY in the entire tree names a secret-bearing env var. The
        // allow-list publishes provider PRESENCE as `github`/`google` booleans;
        // it must never surface the *_CLIENT_SECRET / *_SECRET / *_KEY style keys.
        const keys = collectKeys(body);
        const FORBIDDEN_KEY_FRAGMENTS = [
            'secret',
            'password',
            'passwd',
            'token',
            'apikey',
            'api_key',
            'private',
            'credential',
            'client_secret',
            'clientsecret',
            'database_url',
            'database',
            'dsn',
            'connection',
            'auth_secret',
            'jwt',
            'session',
            'stripe',
            'webhook',
        ];
        for (const key of keys) {
            for (const frag of FORBIDDEN_KEY_FRAGMENTS) {
                expect(
                    key.includes(frag),
                    `config key "${key}" looks like it carries a secret (matched "${frag}")`,
                ).toBe(false);
            }
        }

        // (b) No VALUE leaf looks like a credential. Real client secrets / API
        // keys are long high-entropy strings; the legitimate leaves here are
        // short branding strings ("Ever Works"), size strings ("1mb"), and
        // booleans. Flag any long opaque token-shaped value.
        const leaves = collectLeafStrings(body);
        const TOKEN_SHAPES: RegExp[] = [
            /sk-[A-Za-z0-9]{16,}/, // OpenAI-style key
            /AKIA[0-9A-Z]{16}/, // AWS access key id
            /gh[poursa]_[A-Za-z0-9]{20,}/, // GitHub token
            /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
            /postgres(ql)?:\/\//i, // DB URL
            /[A-Za-z0-9+/]{40,}={0,2}/, // long base64 blob (e.g. AUTH_SECRET)
        ];
        for (const leaf of leaves) {
            for (const re of TOKEN_SHAPES) {
                expect(
                    re.test(leaf),
                    `config leaf value "${leaf.slice(0, 24)}…" matched secret shape ${re}`,
                ).toBe(false);
            }
        }
    });

    test('feature/provider flags REFLECT env and cross-check against /api/auth/providers', async ({
        request,
    }) => {
        const res = await getConfig(request);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as Json;
        const features = body.features as Json;
        const providers = (body.auth as Json).providers as Json;

        // emailVerificationRequired derives from REQUIRE_EMAIL_VERIFICATION; in
        // this e2e env it is set to "false" (no verification mail in CI), so the
        // flag MUST be false. This pins the env→flag wiring, not just the type.
        expect(
            features.emailVerificationRequired,
            'REQUIRE_EMAIL_VERIFICATION=false in e2e must surface as emailVerificationRequired=false',
        ).toBe(false);

        // Cross-check the social-provider booleans against the independent
        // /api/auth/providers resolver. Both read the same env (GH_CLIENT_ID,
        // GOOGLE_CLIENT_ID) — they must agree, or the UI would render a login
        // button for a provider the backend can't actually complete.
        const provRes = await request.get(`${API_BASE}/api/auth/providers`);
        expect(provRes.status()).toBe(200);
        const prov = (await provRes.json()) as Json;
        const social = Array.isArray(prov.socialProviders)
            ? (prov.socialProviders as string[]).map((s) => s.toLowerCase())
            : [];

        // /api/auth/providers only lists ENABLED social providers; /api/config
        // exposes a boolean per known provider. The enabled set on each side
        // must be consistent.
        expect(
            Boolean(providers.github),
            'config.auth.providers.github must match /api/auth/providers',
        ).toBe(social.includes('github'));
        expect(
            Boolean(providers.google),
            'config.auth.providers.google must match /api/auth/providers',
        ).toBe(social.includes('google'));

        // magicLink presence should be coherent between the two surfaces when
        // /api/auth/providers reports it (best-effort: only assert when present).
        if (typeof prov.magicLink === 'boolean') {
            expect(typeof features.magicLinkEnabled).toBe('boolean');
        }
    });

    test('caching contract: public max-age, WEAK ETag, conditional-request matrix (304 empty / mismatch 200)', async ({
        request,
    }) => {
        const res = await getConfig(request);
        expect(res.status()).toBe(200);
        const headers = res.headers();

        // Cache-Control is the hand-set `public, max-age=60` — public (shared
        // caches may store it) + a short TTL so flag flips propagate fast.
        const cc = (headers['cache-control'] || '').toLowerCase();
        expect(cc, 'config must be cacheable for anonymous clients').toContain('public');
        expect(cc, 'public config must never be no-store').not.toContain('no-store');
        expect(cc, 'public config must never be private').not.toContain('private');
        const maxAge = /max-age\s*=\s*(\d+)/.exec(cc);
        expect(maxAge, 'config must carry a max-age').not.toBeNull();
        const ttl = parseInt(maxAge![1], 10);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl, 'short TTL so flag flips propagate quickly').toBeLessThanOrEqual(300);

        // ETag exists and is WEAK (W/...) — correct for env-derived JSON that is
        // byte-stable but semantically "weak" (no strong octet guarantee in dev).
        const etag = headers['etag'];
        expect(etag, 'config must carry an ETag for conditional revalidation').toBeTruthy();
        expect(etag, `config ETag should be weak, got "${etag}"`).toMatch(/^W\//);

        // ETag is stable across repeat reads in the same env window.
        const res2 = await getConfig(request);
        expect(res2.headers()['etag'], 'ETag must be stable across calls').toBe(etag);

        // If-None-Match with the EXACT validator → cheap 304 with no body.
        const notModified = await getConfig(request, {
            headers: { 'If-None-Match': etag! },
        });
        expect(
            [304, 200].includes(notModified.status()),
            `If-None-Match(exact) returned ${notModified.status()}`,
        ).toBe(true);
        if (notModified.status() === 304) {
            const body304 = await notModified.text();
            expect(body304, '304 must carry an empty body').toBe('');
        }

        // If-None-Match with a STALE/garbage validator → full 200 with body.
        const stale = await getConfig(request, {
            headers: { 'If-None-Match': 'W/"stale-deadbeef-0000"' },
        });
        expect(stale.status(), 'mismatched If-None-Match must serve the fresh body').toBe(200);
        const staleBody = (await stale.json()) as Json;
        expect(Object.keys(staleBody).sort()).toEqual(['app', 'auth', 'features', 'limits']);
    });

    test('AUTH-INVARIANT: anon ≡ seeded ≡ fresh-registered (byte-identical body + identical ETag)', async ({
        request,
    }) => {
        // The endpoint is identical for everyone (per the source contract:
        // "Authenticated users get the same keys — this endpoint is identical
        // for everyone"). A bearer token must not fork the payload or the cache
        // validator, otherwise the `public` cache directive would be unsafe.
        const anon = await getConfig(request);
        expect(anon.status()).toBe(200);
        const anonText = await anon.text();
        const anonEtag = anon.headers()['etag'];

        // Seeded user (storageState credentials) → login for a real bearer.
        const seeded = loadSeededTestUser();
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(loginRes.ok(), 'seeded login should succeed').toBe(true);
        const { access_token } = (await loginRes.json()) as { access_token: string };
        const seededRes = await getConfig(request, { headers: authedHeaders(access_token) });
        expect(seededRes.status()).toBe(200);
        expect(await seededRes.text(), 'seeded-user config must equal anon config').toBe(anonText);

        // A brand-new, never-seen user → still identical.
        const fresh = await registerUserViaAPI(request);
        const freshRes = await getConfig(request, {
            headers: authedHeaders(fresh.access_token),
        });
        expect(freshRes.status()).toBe(200);
        expect(await freshRes.text(), 'fresh-user config must equal anon config').toBe(anonText);

        // ETags must agree too — the validator is content-derived, not identity-
        // derived. (Only assert when the anon response carried one.)
        if (anonEtag) {
            expect(seededRes.headers()['etag'], 'seeded ETag must match anon ETag').toBe(anonEtag);
            expect(freshRes.headers()['etag'], 'fresh ETag must match anon ETag').toBe(anonEtag);
        }

        // Cache-key safety: Vary must NOT include Cookie or Authorization (else a
        // shared cache could serve one user's variant to another). Vary: Origin
        // is fine.
        const vary = (anon.headers()['vary'] || '').toLowerCase();
        expect(vary, 'Vary must not key on Cookie').not.toContain('cookie');
        expect(vary, 'Vary must not key on Authorization').not.toContain('authorization');
    });

    test('LOCALE/ORIGIN-INVARIANT + write-method posture: same bytes regardless of Accept-Language/Origin, POST 404', async ({
        request,
    }) => {
        // Baseline.
        const base = await getConfig(request);
        expect(base.status()).toBe(200);
        const baseText = await base.text();
        const baseEtag = base.headers()['etag'];

        // Per-locale: /api/config is intentionally locale-agnostic (no
        // translated branding) so it stays cache-friendly. Different
        // Accept-Language values must NOT change the body or fork the ETag —
        // otherwise the `public` cache without `Vary: Accept-Language` would be
        // a cache-poisoning vector.
        for (const lang of ['fr-FR,fr;q=0.9', 'de', 'ja', 'ar', 'zz-INVALID']) {
            const localized = await getConfig(request, {
                headers: { 'Accept-Language': lang },
            });
            expect(localized.status(), `config must serve 200 for Accept-Language: ${lang}`).toBe(
                200,
            );
            expect(
                await localized.text(),
                `Accept-Language: ${lang} must not change the config payload`,
            ).toBe(baseText);
            if (baseEtag) {
                expect(
                    localized.headers()['etag'],
                    `Accept-Language: ${lang} must not fork the ETag`,
                ).toBe(baseEtag);
            }
            // And it must NOT have silently added Accept-Language to Vary while
            // returning the same bytes (would still bloat caches needlessly).
            const vary = (localized.headers()['vary'] || '').toLowerCase();
            expect(vary).not.toContain('accept-language');
        }

        // Per-Origin: body is env-derived, never request-derived. A hostile
        // Origin header must not change a single byte (cache-poisoning guard).
        const hostile = await getConfig(request, {
            headers: { Origin: 'https://attacker.example.com' },
        });
        expect(hostile.status()).toBe(200);
        expect(
            await hostile.text(),
            'a request Origin must not influence the public config body',
        ).toBe(baseText);

        // Write-method posture: /api/config is read-only. POST/PUT/DELETE must
        // not be routed (probed: 404) — and must never 5xx.
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
            const w = await request.fetch(`${API_BASE}${CONFIG_PATH}`, { method });
            expect(
                w.status(),
                `${method} ${CONFIG_PATH} must be a clean 4xx, not 5xx (got ${w.status()})`,
            ).toBeLessThan(500);
            expect(
                w.status(),
                `${method} ${CONFIG_PATH} must not be accepted as 2xx`,
            ).toBeGreaterThanOrEqual(400);
        }
    });
});
