import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    listPluginsViaAPI,
    getPluginViaAPI,
    enablePluginViaAPI,
    disablePluginViaAPI,
} from './helpers/plugins';

/**
 * Screenshot plugin matrix — real, multi-step orchestration of the screenshot
 * capability facade (`/api/screenshot/*`) against the three screenshot
 * providers (screenshotone / urlbox / scrapfly). Every shape below was PROBED
 * against the LIVE stack (http://127.0.0.1:3100) before the assertions were
 * written, so this file asserts the platform's REAL behaviour, not a guess.
 *
 * This complements (does NOT duplicate) the existing shallow smoke in
 * `screenshot-and-deploy.spec.ts` (which only checks the unauth 401 on
 * `/api/screenshot/check-availability`). Here we drive the full enable →
 * configure → availability → capture/get-url → disable lifecycle, plus the
 * per-user isolation and "truthful contract without external call" guarantees.
 *
 * PROBED CONTRACTS (live):
 *   - GET /api/plugins → `plugins[]` includes the screenshot providers
 *       `screenshotone` and `urlbox` (category:'screenshot',
 *       capabilities:['screenshot'], systemPlugin:false). A fresh user sees
 *       them with enabled:false. (scrapfly is registered primarily under
 *       content-extractor and is NOT surfaced in the screenshot list — so we
 *       only drive screenshotone/urlbox here, and tolerate either being absent
 *       with .filter()/length guards.)
 *   - GET /api/plugins/screenshotone →
 *       { id:'screenshotone', category:'screenshot', capabilities:['screenshot'],
 *         systemPlugin:false, builtIn:false,
 *         settingsSchema:{ required:['accessKey'], properties:{ accessKey:
 *           { 'x-secret':true, 'x-envVar':'PLUGIN_SCREENSHOTONE_ACCESS_KEY' }, … } } }.
 *       urlbox's schema instead requires ['apiKey'].
 *   - GET /api/screenshot/check-availability →
 *       { status:'success', available:boolean,
 *         providers:[{ id, name, description, configured:boolean, isDefault:boolean }],
 *         activeProvider:{…}|null }.
 *       A FRESH user with no enabled screenshot plugin → available:false,
 *       providers:[] (per-user isolation — one user's enablement never leaks).
 *       401 without auth.
 *   - POST /api/plugins/screenshotone/enable {} (no key) → 200 + plugin object,
 *       and check-availability then reports the provider as configured:true.
 *       This is because the capability "configured" check SKIPS any required
 *       field carrying an 'x-envVar' fallback (the access key MAY resolve from
 *       the env). It is a *capability* signal, NOT a guarantee a real key
 *       exists — capture truthfully fails when no key actually resolves.
 *   - POST /api/screenshot/capture { url } (provider enabled, NO real key) →
 *       400 { status:'error', message:'ScreenshotOne access key not configured…' }.
 *     POST /api/screenshot/capture (accessKey only, no secretKey) →
 *       400 { message:'Both non-empty access and secret keys are required' }.
 *     POST /api/screenshot/capture (both fake keys present) → 400 with a
 *       TRUTHFUL upstream error (e.g. '…response returned 400 …"access_key" is
 *       invalid') — i.e. it attempts the real provider call and surfaces the
 *       failure rather than fabricating success.
 *   - POST /api/screenshot/get-url { url } (both fake keys present) → 200
 *       { status:'success', imageUrl:'https://api.screenshotone.com/take?…&
 *         access_key=…&signature=…' }. The signed URL is built LOCALLY (HMAC) —
 *       NO external HTTP call — so this is the clean "facade truthful contract
 *       without external call" path. urlbox builds an equivalent signed
 *       https://api.urlbox.io/v1/<key>/<sig>/png?… URL.
 *   - Unknown providerOverride → 500 on BOTH /capture and /get-url
 *       (the override names no resolvable enabled plugin). We assert
 *       [400,500].includes(status) defensively.
 *   - Invalid `url` (IsUrl) → 400; missing `url` → 400.
 *   - POST /api/plugins/:id/disable is idempotent (200 even when not enabled).
 *
 * ISOLATION: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user) — writing a user-scoped fake screenshot key SHADOWS
 * the env key and would perturb sibling specs. Names use Date.now suffixes;
 * assertions use toContain / .some() and tolerate pre-existing rows.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */

const SCREENSHOT_PLUGINS = ['screenshotone', 'urlbox'] as const;

interface ProviderOption {
    id: string;
    name: string;
    description?: string;
    configured: boolean;
    isDefault?: boolean;
}

interface AvailabilityResponse {
    status: string;
    available: boolean;
    providers: ProviderOption[];
    activeProvider: ProviderOption | null;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

async function checkAvailability(
    request: APIRequestContext,
    token: string,
    workId?: string,
): Promise<{ status: number; body: AvailabilityResponse }> {
    const url = workId
        ? `${API_BASE}/api/screenshot/check-availability?workId=${encodeURIComponent(workId)}`
        : `${API_BASE}/api/screenshot/check-availability`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as AvailabilityResponse,
    };
}

async function postScreenshot(
    request: APIRequestContext,
    token: string,
    op: 'capture' | 'get-url',
    data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/screenshot/${op}`, {
        headers: authedHeaders(token),
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

test.describe('Screenshot plugin matrix — capability facade', () => {
    test('Flow 1: registry surfaces screenshot providers with their key-required schema', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // The plugin registry lists the screenshot providers; a fresh user sees
        // them disabled (no enablement leaks in from other accounts).
        const all = await listPluginsViaAPI(request, token);
        const screenshotRows = all.filter((p) => p.category === 'screenshot');
        expect(
            screenshotRows.length,
            'at least one screenshot-category plugin is registered',
        ).toBeGreaterThan(0);

        const ids = screenshotRows.map((p) => p.id);
        expect(ids, 'screenshotone is a known screenshot provider').toContain('screenshotone');

        for (const row of screenshotRows) {
            expect(row.capabilities, `${row.id} declares the screenshot capability`).toContain(
                'screenshot',
            );
            expect(row.enabled ?? false, `${row.id} is disabled for a fresh user`).toBe(false);
        }

        // The single-plugin GET exposes the real settings schema: each provider
        // requires its own secret key (accessKey for screenshotone, apiKey for
        // urlbox), and that field carries the x-secret + x-envVar markers.
        const expectedRequired: Record<string, string> = {
            screenshotone: 'accessKey',
            urlbox: 'apiKey',
        };
        for (const id of SCREENSHOT_PLUGINS) {
            if (!ids.includes(id)) continue; // tolerate registry variance
            const detail = await getPluginViaAPI(request, token, id);
            expect(detail.category, `${id} is in the screenshot category`).toBe('screenshot');
            expect(detail.capabilities, `${id} has the screenshot capability`).toContain(
                'screenshot',
            );
            expect(detail.systemPlugin, `${id} is not a system plugin`).toBe(false);

            const schema = (detail.settingsSchema ?? {}) as {
                required?: string[];
                properties?: Record<string, Record<string, unknown>>;
            };
            const requiredKey = expectedRequired[id];
            expect(schema.required ?? [], `${id} schema requires its secret key field`).toContain(
                requiredKey,
            );

            const keyProp = schema.properties?.[requiredKey] ?? {};
            // PROBED: the API normalises the JSON-Schema `x-` extensions before
            // returning them (`x-secret`→`secret`, `x-envVar`→`envVar`,
            // `x-scope`→`scope`) — assert the REAL emitted markers.
            expect(keyProp['secret'], `${id}.${requiredKey} is marked secret`).toBe(true);
            expect(
                keyProp['envVar'],
                `${id}.${requiredKey} carries an env-var fallback`,
            ).toBeTruthy();
        }
    });

    test('Flow 2: fresh user has NO screenshot provider; unauth is rejected', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Per-user isolation: a brand-new account has nothing enabled, so the
        // capability is unavailable and the provider list is empty.
        const { status, body } = await checkAvailability(request, token);
        expect(status, 'check-availability is authorised for any user').toBe(200);
        expect(body.status).toBe('success');
        expect(body.available, 'no provider enabled → unavailable').toBe(false);
        expect(body.providers, 'no providers listed for a fresh user').toEqual([]);
        expect(body.activeProvider, 'no active provider for a fresh user').toBeNull();

        // Same endpoint without a bearer is rejected (not 404, not 5xx).
        const anon = await request.get(`${API_BASE}/api/screenshot/check-availability`);
        expect(anon.status(), 'unauth check-availability → 401').toBe(401);

        const anonCapture = await request.post(`${API_BASE}/api/screenshot/capture`, {
            data: { url: 'https://example.com' },
        });
        expect(anonCapture.status(), 'unauth capture → 401').toBe(401);
    });

    test('Flow 3: enabling a provider flips availability to configured; disable removes it', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Enable screenshotone WITHOUT a user key. The capability "configured"
        // check skips the accessKey because it carries an x-envVar fallback, so
        // availability reports the provider as configured:true + default.
        const enabled = await enablePluginViaAPI(request, token, 'screenshotone');
        expect(enabled.id, 'enable echoes the plugin id').toBe('screenshotone');
        expect(enabled.category, 'screenshotone is a screenshot plugin').toBe('screenshot');

        await expect
            .poll(async () => (await checkAvailability(request, token)).body.available, {
                timeout: 15_000,
                message: 'availability flips true once the provider is enabled',
            })
            .toBe(true);

        const afterEnable = await checkAvailability(request, token);
        expect(afterEnable.body.providers.length, 'exactly one provider listed').toBe(1);
        const provider = afterEnable.body.providers[0];
        expect(provider.id, 'the enabled provider is screenshotone').toBe('screenshotone');
        expect(provider.configured, 'env-var fallback ⇒ configured:true').toBe(true);
        expect(provider.isDefault, 'the sole enabled provider is the default').toBe(true);
        expect(
            afterEnable.body.activeProvider?.id,
            'activeProvider resolves to screenshotone',
        ).toBe('screenshotone');

        // Disable removes it from the capability surface.
        await disablePluginViaAPI(request, token, 'screenshotone');
        await expect
            .poll(async () => (await checkAvailability(request, token)).body.providers.length, {
                timeout: 15_000,
                message: 'provider drops from availability after disable',
            })
            .toBe(0);
        const afterDisable = await checkAvailability(request, token);
        expect(afterDisable.body.available, 'capability is unavailable post-disable').toBe(false);

        // Disable is idempotent — a second disable on a not-enabled plugin is a
        // clean no-op (200), never a 4xx/5xx.
        const secondDisable = await request.post(`${API_BASE}/api/plugins/screenshotone/disable`, {
            headers: authedHeaders(token),
        });
        expect(secondDisable.status(), 'double-disable is idempotent').toBeLessThan(300);
    });

    test('Flow 4: enabled-but-unconfigured capture fails TRUTHFULLY (no fabricated success)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Enable with NO key at all.
        await enablePluginViaAPI(request, token, 'screenshotone');

        // availability says configured:true (env fallback), yet a capture
        // truthfully reports the missing key rather than returning a fake image.
        const noKey = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
        });
        expect(noKey.status, 'capture without a resolvable key → 400').toBe(400);
        expect(noKey.body.status, 'error envelope').toBe('error');
        expect(String(noKey.body.message ?? ''), 'the 400 names the missing access key').toMatch(
            /access key not configured|not configured|provider configured/i,
        );

        // Provide ONLY the access key (no secret key). screenshotone signed
        // operations need BOTH — capture still fails truthfully.
        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: { accessKey: `fake-access-${Date.now()}` },
        });
        const halfKey = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
        });
        expect(halfKey.status, 'capture with a half-configured key → 400').toBe(400);
        expect(
            String(halfKey.body.message ?? ''),
            'the 400 explains both keys are required',
        ).toMatch(/both .*keys are required|secret key|access key/i);
    });

    test('Flow 5: get-url builds a SIGNED url locally — truthful contract WITHOUT an external call', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Configure both fake keys so the local signed-URL builder has what it
        // needs. get-url performs NO outbound HTTP — it constructs + HMAC-signs
        // the provider URL, so it returns 200 even with bogus credentials.
        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: {
                accessKey: `fake-access-${Date.now()}`,
                secretKey: `fake-secret-${Date.now()}`,
            },
        });

        const url = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            format: 'png',
            viewportWidth: 1280,
            viewportHeight: 800,
        });
        // PROBED: the controller's POST handler carries no @HttpCode, so NestJS
        // returns its POST default 201 (not 200) on success — no external call.
        expect(url.status, 'get-url with both keys → 201 (no external call)').toBe(201);
        expect(url.body.status, 'success envelope').toBe('success');
        const imageUrl = String(url.body.imageUrl ?? '');
        expect(imageUrl, 'a screenshotone take URL is returned').toContain(
            'api.screenshotone.com/take',
        );
        expect(imageUrl, 'the target URL is encoded into the query').toContain(
            encodeURIComponent('https://example.com'),
        );
        expect(imageUrl, 'the access key is embedded').toContain('access_key=');
        expect(imageUrl, 'the URL is HMAC-signed').toContain('signature=');
        expect(imageUrl, 'the requested format is honoured').toContain('format=png');

        // By contrast, /capture DOES reach out to the provider, so with bogus
        // keys it surfaces the upstream rejection as a 400 — never a 200 with a
        // fake image, never an unhandled 5xx.
        const capture = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
        });
        expect(capture.status, 'capture with bogus keys → truthful 400').toBe(400);
        expect(capture.body.status, 'error envelope').toBe('error');
        expect(
            String(capture.body.message ?? ''),
            'the 400 surfaces a real failure reason (not a fabricated success)',
        ).toBeTruthy();
    });

    test('Flow 6: multi-provider sort, providerOverride routing, and DTO validation', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const all = await listPluginsViaAPI(request, token);
        const ids = all.filter((p) => p.category === 'screenshot').map((p) => p.id);
        const hasUrlbox = ids.includes('urlbox');

        // Enable screenshotone first (becomes default), then urlbox if present.
        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: {
                accessKey: `fake-access-${Date.now()}`,
                secretKey: `fake-secret-${Date.now()}`,
            },
        });
        if (hasUrlbox) {
            await enablePluginViaAPI(request, token, 'urlbox', {
                secretSettings: {
                    apiKey: `fake-api-${Date.now()}`,
                    apiSecret: `fake-secret-${Date.now()}`,
                },
            });
        }

        const avail = await checkAvailability(request, token);
        const listedIds = avail.body.providers.map((p) => p.id);
        expect(listedIds, 'screenshotone is in the provider list').toContain('screenshotone');
        // The default provider sorts first and is flagged isDefault.
        expect(avail.body.providers[0].isDefault, 'the first provider is the default').toBe(true);
        expect(
            avail.body.activeProvider?.id,
            'an active provider is resolved when ≥1 is configured',
        ).toBeTruthy();
        if (hasUrlbox) {
            expect(listedIds, 'urlbox also appears once enabled').toContain('urlbox');
            expect(
                avail.body.providers.length,
                'two screenshot providers are listed',
            ).toBeGreaterThanOrEqual(2);

            // providerOverride routes get-url to the chosen plugin's signed-URL
            // builder (still no external call) — urlbox produces an urlbox.io URL.
            const overridden = await postScreenshot(request, token, 'get-url', {
                url: 'https://example.com',
                providerOverride: 'urlbox',
            });
            // PROBED: POST get-url returns NestJS's 201 default (no @HttpCode).
            expect(overridden.status, 'override get-url → 201').toBe(201);
            expect(
                String(overridden.body.imageUrl ?? ''),
                'the override routed to urlbox',
            ).toContain('urlbox.io');
        }

        // An unknown providerOverride names no resolvable plugin → the facade
        // raises and the controller returns a non-2xx (400 or 500). Assert it is
        // rejected, never a 2xx success.
        const badOverride = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            providerOverride: `nonexistent-${Date.now()}`,
        });
        expect(
            [400, 404, 500].includes(badOverride.status),
            `unknown providerOverride rejected (got ${badOverride.status})`,
        ).toBe(true);

        // DTO validation: a non-URL value is rejected by class-validator (IsUrl),
        // and a missing url is likewise a 400 — before any facade work runs.
        const badUrl = await postScreenshot(request, token, 'capture', { url: 'not-a-valid-url' });
        expect(badUrl.status, 'invalid url → 400 DTO rejection').toBe(400);

        const missingUrl = await request.post(`${API_BASE}/api/screenshot/capture`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(missingUrl.status(), 'missing url → 400 DTO rejection').toBe(400);
    });
});
