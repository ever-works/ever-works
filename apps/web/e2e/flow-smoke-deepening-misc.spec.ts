import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Thin-surface contract deepening — the FINAL "convert-remaining-gaps-to-real-
 * coverage" sweep of the +1000 real-flow initiative.
 *
 * Several misc/metadata endpoints were only ever touched at the route-existence
 * / 401-posture level. This file pins their AUTHENTICATED (or public) BODY
 * SHAPES with live-probed assertions so a controller projection or DTO change
 * fires immediately.
 *
 * NON-DUPLICATION (read these first; they cover DIFFERENT axes):
 *   - api-public-contract.spec.ts → route-exists + 401-unauth posture ONLY for
 *     /api/works/stats, /api/auth/profile, /api/account/export, etc. It NEVER
 *     asserts the authed body shape — that is the gap this file fills.
 *   - api-version-header.spec.ts → probes /api/health for a version HEADER/body
 *     field; it never hits the dedicated GET /api/version endpoint. We pin that.
 *   - account-data.spec.ts → /api/account/export returns 200 + JSON + truthy.
 *     It does NOT assert the export ENVELOPE (version/exportedAt/includesSecrets/
 *     data.{profile,works,userPlugins}). We pin the entity-set.
 *   - audit-export-sanitization.spec.ts → export carries NO secret patterns
 *     (negative). We pin the POSITIVE envelope + that includesSecrets===false.
 *   - auth-providers-list.spec.ts → /api/auth/providers. We pin /api/config's
 *     features/auth/limits shape instead (different endpoint).
 *
 * PROBED LIVE (http://127.0.0.1:3100) before every assertion below:
 *   - GET /api/config (PUBLIC, 200, Cache-Control public,max-age=60) →
 *     {app:{name,description}, features:{subscriptionsEnabled,magicLinkEnabled,
 *      anonymousAuthEnabled,emailVerificationRequired}, auth:{providers:{github,
 *      google,facebook}}, limits:{bodyLimit:"1mb"}} — all features booleans.
 *   - GET /api/version (PUBLIC, 200) → {name,version,gitSha,shortSha,gitRef,
 *      buildRun,buildTime,commitUrl} ; commitUrl is null when unset (NOT absent).
 *   - GET /api/health (PUBLIC, 200) → {status:"success", message:"API is up and
 *      running"} — NOT a terminus {status:"ok",info,details} shape.
 *   - GET /api/works/stats (authed, 200) → SIX numeric counters: totalWorks,
 *      totalItems, activeWebsites, generatingCount, totalMissions, totalIdeas.
 *      Fresh user → every counter is 0. Unauth → 401.
 *   - GET /api/auth/profile (authed, 200) → WHITELIST projection per Wave N:
 *      {id,userId,email,username,provider,emailVerified,isActive,avatar,
 *       isAnonymous}. JWT claims (iat/iss/aud/exp/sub/nbf) and password/hash
 *       MUST NOT appear. provider==="local", isAnonymous===false for a registree.
 *   - GET /api/notifications/event-types (authed, 200) → {eventTypes:[...]} where
 *      each entry = {key,category,title,description,urgent,defaultChannels[],
 *      source,pluginId,createdAt,updatedAt}; core catalogue includes
 *      "ai_credits_depleted" (urgent:true) + "work_generation_finished". Unauth→401.
 *   - GET /api/works/website-templates (authed, 200) → {status:"success",
 *      templates:[{id,name,description,sourceType,originType,isDefault}]};
 *      exactly one template has isDefault===true ("classic"). Unauth→401.
 *   - GET /api/account/export (authed, 200) → {version:1, exportedAt:<iso>,
 *      includesSecrets:false, data:{profile:{username,email}, works:[],
 *      userPlugins:[]}}.
 *
 * HOUSE RULES honoured: API-contract assertions (no UI nav); a FRESH
 * registerUserViaAPI per authed test (full isolation); per-test unique suffix
 * derived from the test title (no module-scope clock); anon posture via an
 * explicit empty storageState describe block; TS-strict — non-modeled response
 * fields are read through a single `Record<string, unknown>` cast (the apps/web
 * tsc-gate covers e2e/**​/*.ts). Keyless/no-MailHog/no-Redis safe: every surface
 * here is a read-only metadata/contract probe (no AI/mail/deploy dependency).
 */

type Json = Record<string, unknown>;

test.describe('Misc thin-surface contracts — public metadata', () => {
    test('GET /api/config exposes the public app/features/auth/limits shape', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/config`);
        expect(res.status(), `config status ${res.status()}`).toBe(200);
        // PUBLIC + cacheable — pin the caching contract the SSR layer relies on.
        expect(res.headers()['cache-control'] || '').toMatch(/public/);

        const body = (await res.json()) as Json;
        const app = body.app as Json;
        expect(typeof app.name).toBe('string');
        expect(typeof app.description).toBe('string');

        const features = body.features as Json;
        for (const key of [
            'subscriptionsEnabled',
            'magicLinkEnabled',
            'anonymousAuthEnabled',
            'emailVerificationRequired',
        ]) {
            expect(typeof features[key], `features.${key} must be a boolean`).toBe('boolean');
        }

        const providers = (body.auth as Json).providers as Json;
        for (const p of ['github', 'google', 'facebook']) {
            expect(typeof providers[p], `auth.providers.${p} must be a boolean`).toBe('boolean');
        }

        const limits = body.limits as Json;
        expect(typeof limits.bodyLimit, 'limits.bodyLimit present').toBe('string');
    });

    test('GET /api/config NEVER leaks server secrets (no api keys / db url)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/config`);
        expect(res.status()).toBe(200);
        const raw = await res.text();
        // The public config is consumed by anonymous browsers — assert it carries
        // no secret-bearing keys that a misconfigured serializer might spread in.
        for (const forbidden of [
            'secret',
            'password',
            'apiKey',
            'api_key',
            'databaseUrl',
            'DATABASE_URL',
            'jwtSecret',
            'privateKey',
        ]) {
            expect(
                raw.toLowerCase().includes(forbidden.toLowerCase()),
                `public config leaked "${forbidden}"`,
            ).toBe(false);
        }
    });

    test('GET /api/version returns the build-metadata envelope', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/version`);
        expect(res.status(), `version status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;
        // String fields always present (empty string is a valid "unset" value).
        for (const key of [
            'name',
            'version',
            'gitSha',
            'shortSha',
            'gitRef',
            'buildRun',
            'buildTime',
        ]) {
            expect(typeof body[key], `version.${key} must be a string`).toBe('string');
        }
        // commitUrl is explicitly nullable (null when no commit URL) — NOT absent.
        expect('commitUrl' in body, 'commitUrl key present (nullable)').toBe(true);
        expect(
            body.commitUrl === null || typeof body.commitUrl === 'string',
            'commitUrl is string|null',
        ).toBe(true);
    });

    test('GET /api/health returns the success/message liveness shape', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status(), `health status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;
        expect(body.status, 'health status === "success"').toBe('success');
        expect(typeof body.message, 'health carries a message string').toBe('string');
    });
});

test.describe('Misc thin-surface contracts — authenticated bodies', () => {
    test('GET /api/works/stats returns six numeric counters (all 0 for fresh user)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/stats`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `stats status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;
        const counters = [
            'totalWorks',
            'totalItems',
            'activeWebsites',
            'generatingCount',
            'totalMissions',
            'totalIdeas',
        ];
        for (const key of counters) {
            expect(typeof body[key], `stats.${key} must be a number`).toBe('number');
            // A brand-new user owns nothing yet → every counter is exactly 0.
            expect(body[key], `fresh-user stats.${key} should be 0`).toBe(0);
        }
    });

    test('GET /api/auth/profile is a whitelist projection with NO JWT claims', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `profile status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;

        // Whitelisted fields that MUST be present (Wave N projection).
        for (const key of [
            'id',
            'userId',
            'email',
            'username',
            'provider',
            'emailVerified',
            'isActive',
            'avatar',
            'isAnonymous',
        ]) {
            expect(key in body, `profile must expose "${key}"`).toBe(true);
        }
        expect(body.email, 'profile email matches registree').toBe(u.email);
        expect(body.provider, 'local credential user').toBe('local');
        expect(body.isAnonymous, 'registree is not anonymous').toBe(false);

        // JWT internal claims must NEVER bleed into the profile projection.
        for (const claim of ['iat', 'iss', 'aud', 'exp', 'sub', 'nbf', 'jti']) {
            expect(claim in body, `profile leaked JWT claim "${claim}"`).toBe(false);
        }
        // Nor credential material.
        for (const secret of ['password', 'passwordHash', 'hash', 'salt', 'access_token']) {
            expect(secret in body, `profile leaked credential field "${secret}"`).toBe(false);
        }
    });

    test('GET /api/notifications/event-types returns the catalogue entry shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/event-types`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `event-types status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;
        const types = body.eventTypes as Json[];
        expect(Array.isArray(types), 'eventTypes is an array').toBe(true);
        expect(types.length, 'core catalogue is non-empty').toBeGreaterThan(0);

        const first = types[0];
        for (const key of [
            'key',
            'category',
            'title',
            'description',
            'urgent',
            'defaultChannels',
            'source',
        ]) {
            expect(key in first, `event-type entry must expose "${key}"`).toBe(true);
        }
        expect(typeof first.urgent, 'urgent is boolean').toBe('boolean');
        expect(Array.isArray(first.defaultChannels), 'defaultChannels is array').toBe(true);

        // Pin two stable core catalogue members + their urgency contract.
        const byKey = new Map(types.map((t) => [t.key as string, t]));
        expect(byKey.has('ai_credits_depleted'), 'core has ai_credits_depleted').toBe(true);
        expect(
            (byKey.get('ai_credits_depleted') as Json).urgent,
            'ai_credits_depleted is urgent',
        ).toBe(true);
        expect(byKey.has('work_generation_finished'), 'core has work_generation_finished').toBe(
            true,
        );
    });

    test('GET /api/works/website-templates returns templates with one default', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/website-templates`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `website-templates status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;
        expect(body.status, 'envelope status === "success"').toBe('success');
        const templates = body.templates as Json[];
        expect(Array.isArray(templates), 'templates is array').toBe(true);
        expect(templates.length, 'at least one built-in template').toBeGreaterThan(0);

        for (const key of ['id', 'name', 'description', 'sourceType', 'originType', 'isDefault']) {
            expect(key in templates[0], `template must expose "${key}"`).toBe(true);
        }
        // Exactly one template is the default — the UI relies on this invariant.
        const defaults = templates.filter((t) => t.isDefault === true);
        expect(defaults.length, 'exactly one default template').toBe(1);
    });

    test('GET /api/account/export returns the typed export envelope', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/account/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `export status ${res.status()}`).toBe(200);
        const body = (await res.json()) as Json;

        expect(typeof body.version, 'export carries a numeric version').toBe('number');
        expect(typeof body.exportedAt, 'export carries an exportedAt timestamp').toBe('string');
        // A user-downloadable export must declare it withholds secrets.
        expect(body.includesSecrets, 'self-export withholds secrets').toBe(false);

        const data = body.data as Json;
        expect('profile' in data, 'export.data.profile present').toBe(true);
        expect('works' in data, 'export.data.works present').toBe(true);
        expect('userPlugins' in data, 'export.data.userPlugins present').toBe(true);
        expect(Array.isArray(data.works), 'export.data.works is an array').toBe(true);
        expect(Array.isArray(data.userPlugins), 'export.data.userPlugins is an array').toBe(true);

        const profile = data.profile as Json;
        expect(profile.email, 'export profile email matches registree').toBe(u.email);
    });
});

/**
 * Anonymous posture — explicit EMPTY storageState so the shard's logged-in
 * cookie cannot bleed in. These pin that the AUTHED thin surfaces above reject
 * unauthenticated callers with a clean 401 (NOT 403, NOT 200, NOT a 5xx).
 */
test.describe('Misc thin-surface contracts — anonymous 401 posture', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    const authedPaths = [
        '/api/works/stats',
        '/api/auth/profile',
        '/api/notifications/event-types',
        '/api/works/website-templates',
        '/api/account/export',
    ];

    for (const path of authedPaths) {
        test(`GET ${path} without auth → 401`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} returned ${res.status()}`).toBe(401);
        });
    }
});
