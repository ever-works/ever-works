import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { listPluginsViaAPI, enablePluginViaAPI, disablePluginViaAPI } from './helpers/plugins';

/**
 * Screenshot capability CONTRACT — deep, multi-step integration flows for the
 * `/api/screenshot/*` facade that the existing `flow-plugin-screenshot.spec.ts`
 * and `screenshot-and-deploy.spec.ts` do NOT already cover. Every shape below
 * was PROBED against the LIVE stack (http://127.0.0.1:3100) before the
 * assertions were written, so this file asserts the platform's REAL behaviour.
 *
 * Where the sibling file drives the basic enable→availability→get-url lifecycle,
 * THIS file targets the uncovered seams:
 *   - the full class-validator DTO bounds matrix + the exact 400 messages,
 *   - WORK-scoped capability resolution (user-level enable does NOT leak into a
 *     work scope; work-scoped enable flips a work's availability independently),
 *   - cross-user work-scope: the capability LISTING is not ownership-gated
 *     (configured:true leaks across users) yet the SECRET keys never leak —
 *     get-url/capture against another user's work fail without the owner's key,
 *   - provider-specific signed-URL building + per-option honouring
 *     (screenshotone `viewport_width`/`block_ads` vs urlbox `width`/`quality`),
 *   - the precise gating ORDER (DTO → whitelist → "no provider" gate → facade).
 *
 * PROBED CONTRACTS (live, 2026-06-01):
 *   - GET  /api/screenshot/check-availability[?workId=<uuid>] →
 *       { status:'success', available:boolean, providers:ProviderOption[],
 *         activeProvider:ProviderOption|null }. 401 without a bearer.
 *       A NON-uuid `workId` QUERY param is NOT validated (200, empty providers),
 *       UNLIKE the body field below.
 *   - ProviderOption shape: { id, name, description, configured:boolean,
 *       isDefault:boolean, icon:{ type:'lucide', value:'Camera',
 *       backgroundColor:'#4f46e5' } }.
 *   - POST /api/screenshot/get-url and /capture share CaptureScreenshotDto:
 *       url(IsUrl, required), providerOverride?(string), workId?(IsUUID),
 *       viewportWidth?(320..3840), viewportHeight?(240..2160),
 *       format?('png'|'jpg'|'webp'), fullPage?(bool), delay?(0..10000),
 *       blockAds?/blockTrackers?/blockCookieBanners?(bool).
 *       ValidationPipe is whitelist+forbidNonWhitelisted → an unknown property
 *       → 400 "property <x> should not exist". The exact 400 message strings
 *       (e.g. "viewportWidth must not be less than 320",
 *        "format must be one of the following values: png, jpg, webp",
 *        "blockAds must be a boolean value", "workId must be a UUID") are
 *       asserted below.
 *   - POST get-url returns HTTP 201 (Nest POST default — NOT 200).
 *   - With a configured screenshotone, get-url returns a LOCALLY-built
 *       HMAC-signed `https://api.screenshotone.com/take?...&access_key=...&
 *       signature=...` URL — NO outbound HTTP. Honours viewport_width/height,
 *       format, full_page, and block_ads (explicit false ⇒ block_ads=false;
 *       omitted ⇒ block_ads=true). Defaults: 1280x800.
 *   - urlbox builds `https://api.urlbox.io/v1/<key>/<sig>/png?url=...&width=...
 *       &height=...&quality=80&block_ads=true&hide_cookie_banners=true`.
 *   - WORK SCOPE: enabling a plugin at USER level does NOT make a work's
 *       check-availability report it — the work scope is independent. Work
 *       enablement is a DISTINCT route: POST /api/works/:workId/plugins/:id/
 *       enable (200; requires the plugin enabled at user level first; runs
 *       ensureCanEdit → 403 for a non-owner). Once work-enabled, that work's
 *       check-availability reports the provider configured (inheriting the
 *       user-level secret keys).
 *   - CROSS-USER: a non-owner's check-availability?workId=<victim work> DOES
 *       report the provider configured:true (listing is not ownership-gated),
 *       but their get-url → 400 "Failed to generate screenshot URL" and capture
 *       → 400 "...access key not configured..." because the victim's secret
 *       keys are user-scoped and never resolve for the attacker. No leakage.
 *   - GATING: with NO configured provider, capture/get-url → 400
 *       { status:'error', message:'No screenshot provider configured' } BEFORE
 *       any facade work. capture with bogus keys reaches the provider and
 *       surfaces a truthful upstream 400.
 *
 * ISOLATION: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user) — a user-scoped fake screenshot key SHADOWS the env
 * key and would perturb sibling chat/plugin specs. Unique names via Date.now;
 * assertions tolerate registry variance (skip-when-absent, toContain).
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */

interface ProviderOption {
    id: string;
    name: string;
    description?: string;
    configured: boolean;
    isDefault?: boolean;
    icon?: unknown;
}

interface AvailabilityResponse {
    status: string;
    available: boolean;
    providers: ProviderOption[];
    activeProvider: ProviderOption | null;
}

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

/** Flatten the class-validator 400 `message` (string | string[]) into one string. */
function messageText(body: Record<string, unknown>): string {
    const m = body.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

const SCREENSHOTONE_KEYS = () => ({
    accessKey: `fake-access-${Date.now()}`,
    secretKey: `fake-secret-${Date.now()}`,
});

test.describe('Screenshot capability contract — facade, scoping & gating', () => {
    test('Flow 1: full DTO validation matrix — bounds, enum, type, UUID, whitelist (exact 400 messages)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Each row is a single invalid body that must be rejected by class-validator
        // with the SPECIFIC message fragment, BEFORE any provider/facade work runs.
        const rejections: Array<{ data: Record<string, unknown>; fragment: RegExp; why: string }> =
            [
                { data: { url: 'not-a-valid-url' }, fragment: /url/i, why: 'non-URL url' },
                {
                    data: { url: 'https://example.com', viewportWidth: 100 },
                    fragment: /viewportWidth must not be less than 320/i,
                    why: 'viewportWidth below min',
                },
                {
                    data: { url: 'https://example.com', viewportWidth: 5000 },
                    fragment: /viewportWidth must not be greater than 3840/i,
                    why: 'viewportWidth above max',
                },
                {
                    data: { url: 'https://example.com', viewportHeight: 100 },
                    fragment: /viewportHeight must not be less than 240/i,
                    why: 'viewportHeight below min',
                },
                {
                    data: { url: 'https://example.com', viewportHeight: 9000 },
                    fragment: /viewportHeight must not be greater than 2160/i,
                    why: 'viewportHeight above max',
                },
                {
                    data: { url: 'https://example.com', delay: 20000 },
                    fragment: /delay must not be greater than 10000/i,
                    why: 'delay above max',
                },
                {
                    data: { url: 'https://example.com', format: 'gif' },
                    fragment: /format must be one of the following values: png, jpg, webp/i,
                    why: 'format not in enum',
                },
                {
                    data: { url: 'https://example.com', blockAds: 'yes' },
                    fragment: /blockAds must be a boolean value/i,
                    why: 'blockAds wrong type',
                },
                {
                    data: { url: 'https://example.com', workId: 'not-a-uuid' },
                    fragment: /workId must be a UUID/i,
                    why: 'workId not a UUID',
                },
                {
                    data: { url: 'https://example.com', bogusField: 'x' },
                    fragment: /property bogusField should not exist/i,
                    why: 'unknown property (forbidNonWhitelisted)',
                },
            ];

        // Validation is identical for BOTH capture and get-url (shared DTO).
        for (const op of ['capture', 'get-url'] as const) {
            for (const row of rejections) {
                const res = await postScreenshot(request, token, op, row.data);
                expect(res.status, `${op}: ${row.why} → 400 (got ${res.status})`).toBe(400);
                expect(
                    messageText(res.body),
                    `${op}: ${row.why} surfaces the right message`,
                ).toMatch(row.fragment);
            }
        }

        // A missing `url` (required IsUrl) is likewise a DTO 400 on both ops.
        for (const op of ['capture', 'get-url'] as const) {
            const res = await postScreenshot(request, token, op, {});
            expect(res.status, `${op}: missing url → 400`).toBe(400);
        }

        // In CONTRAST, a non-UUID workId in the QUERY string of check-availability
        // is NOT validated (no IsUUID pipe on the query param) — it resolves to an
        // empty, available:false result rather than a 400.
        const q = await checkAvailability(request, token, 'not-a-uuid');
        expect(q.status, 'check-availability tolerates a non-uuid query workId').toBe(200);
        expect(q.body.available, 'unknown work scope → unavailable').toBe(false);
        expect(q.body.providers, 'unknown work scope → no providers').toEqual([]);
    });

    test('Flow 2: user-scoped enable does NOT leak into a work scope; ProviderOption shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A brand-new work owned by this user has no screenshot provider yet.
        const work = await createWorkViaAPI(request, token, {
            name: `SS Scope ${Date.now()}`,
        });
        expect(work.id, 'work was created').toBeTruthy();

        const beforeWork = await checkAvailability(request, token, work.id);
        expect(beforeWork.body.available, 'fresh work has no provider').toBe(false);
        expect(beforeWork.body.providers, 'fresh work provider list empty').toEqual([]);

        // Enable screenshotone at the USER level (global scope) with both keys.
        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: SCREENSHOTONE_KEYS(),
        });

        // User scope now reports the provider configured — and we pin its full
        // ProviderOption shape (the icon descriptor in particular).
        await expect
            .poll(async () => (await checkAvailability(request, token)).body.available, {
                timeout: 15_000,
                message: 'user-scope availability flips true after enable',
            })
            .toBe(true);
        const userScope = await checkAvailability(request, token);
        const provider = userScope.body.providers.find((p) => p.id === 'screenshotone');
        expect(provider, 'screenshotone present in user scope').toBeTruthy();
        expect(provider!.configured, 'env-var fallback ⇒ configured:true').toBe(true);
        expect(provider!.isDefault, 'sole provider is the default').toBe(true);
        expect(provider!.name, 'name is surfaced').toBeTruthy();
        expect(provider!.description, 'description is surfaced').toBeTruthy();
        // The icon descriptor is an object exposed verbatim from the manifest.
        expect(provider!.icon, 'an icon descriptor is exposed').toBeTruthy();

        // CRITICAL: the SAME user querying their OWN work sees NOTHING — the
        // user-level enablement is independent of the work scope.
        const afterUserEnable = await checkAvailability(request, token, work.id);
        expect(
            afterUserEnable.body.available,
            'user-level enable does NOT leak into the work scope',
        ).toBe(false);
        expect(afterUserEnable.body.providers, 'work scope still empty').toEqual([]);
    });

    test('Flow 3: work-scoped enable flips a work independently; ownership gate (403 for non-owner)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const ownerToken = owner.access_token;
        const work = await createWorkViaAPI(request, ownerToken, {
            name: `SS WorkEnable ${Date.now()}`,
        });

        // A plugin must be enabled at the user level before it can be work-enabled.
        await enablePluginViaAPI(request, ownerToken, 'screenshotone', {
            secretSettings: SCREENSHOTONE_KEYS(),
        });

        // Enable it for THIS work via the dedicated work route.
        const enableWork = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/screenshotone/enable`,
            { headers: authedHeaders(ownerToken), data: { settings: {} } },
        );
        expect(enableWork.status(), 'work-scoped enable → 200').toBe(200);
        const enableBody = (await enableWork.json().catch(() => ({}))) as Record<string, unknown>;
        expect(enableBody.id, 'enable echoes the plugin id').toBe('screenshotone');

        // The work scope now reports the provider configured (it inherits the
        // user-level secret keys for signing).
        await expect
            .poll(
                async () => (await checkAvailability(request, ownerToken, work.id)).body.available,
                {
                    timeout: 15_000,
                    message: 'work-scope availability flips true after work enable',
                },
            )
            .toBe(true);
        const workScope = await checkAvailability(request, ownerToken, work.id);
        expect(
            workScope.body.providers.map((p) => p.id),
            'screenshotone now appears for the work',
        ).toContain('screenshotone');

        // A get-url scoped to that work succeeds and signs with the owner's key.
        const ownerUrl = await postScreenshot(request, ownerToken, 'get-url', {
            url: 'https://example.com',
            workId: work.id,
        });
        expect(ownerUrl.status, 'owner work-scoped get-url → 201').toBe(201);
        expect(String(ownerUrl.body.imageUrl ?? ''), 'a signed screenshotone URL').toContain(
            'api.screenshotone.com/take',
        );

        // A DIFFERENT user cannot ENABLE a plugin on a work they do not own —
        // ensureCanEdit rejects with 403 before any plugin work.
        const attacker = await registerUserViaAPI(request);
        const attackerEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/screenshotone/enable`,
            { headers: authedHeaders(attacker.access_token), data: { settings: {} } },
        );
        expect(
            attackerEnable.status(),
            'non-owner cannot enable a plugin on someone else’s work',
        ).toBe(403);
    });

    test('Flow 4: cross-user — capability listing is visible but the SECRET KEYS never leak', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const ownerToken = owner.access_token;
        const work = await createWorkViaAPI(request, ownerToken, {
            name: `SS Leak ${Date.now()}`,
        });

        // Owner enables screenshotone (user-level keys) AND work-scopes it.
        await enablePluginViaAPI(request, ownerToken, 'screenshotone', {
            secretSettings: SCREENSHOTONE_KEYS(),
        });
        const we = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/screenshotone/enable`,
            { headers: authedHeaders(ownerToken), data: { settings: {} } },
        );
        expect(we.status(), 'owner work-enable → 200').toBe(200);
        await expect
            .poll(
                async () => (await checkAvailability(request, ownerToken, work.id)).body.available,
                {
                    timeout: 15_000,
                },
            )
            .toBe(true);

        // An ATTACKER (fresh user, no screenshot plugin) probes the victim's work.
        const attacker = await registerUserViaAPI(request);
        const aToken = attacker.access_token;

        // The capability LISTING is not ownership-gated: the attacker's
        // check-availability for the victim's workId reports the provider as
        // configured:true (the `configured` flag is derived from the env-var
        // fallback, not from a resolved per-user secret).
        const aAvail = await checkAvailability(request, aToken, work.id);
        expect(aAvail.status, 'attacker availability call is authorised').toBe(200);
        expect(
            aAvail.body.providers.map((p) => p.id),
            'listing surfaces the provider cross-user',
        ).toContain('screenshotone');

        // BUT the SECRETS never cross the user boundary: a get-url scoped to the
        // victim's work CANNOT be signed (the attacker has no resolvable key) →
        // 400 "Failed to generate screenshot URL", with NO imageUrl leaked.
        const aUrl = await postScreenshot(request, aToken, 'get-url', {
            url: 'https://evil.example',
            workId: work.id,
        });
        expect(aUrl.status, 'attacker get-url is rejected (no signing key)').toBe(400);
        expect(aUrl.body.status, 'error envelope').toBe('error');
        expect(
            String(aUrl.body.imageUrl ?? ''),
            'NO signed URL (and therefore no key) is leaked to the attacker',
        ).toBe('');
        expect(messageText(aUrl.body)).toMatch(/failed to generate screenshot url/i);

        // Likewise capture cannot reach the provider — it truthfully reports the
        // access key is not configured FOR THIS USER (the owner's key is invisible).
        const aCapture = await postScreenshot(request, aToken, 'capture', {
            url: 'https://evil.example',
            workId: work.id,
        });
        expect(aCapture.status, 'attacker capture is rejected').toBe(400);
        expect(messageText(aCapture.body)).toMatch(/access key not configured|not configured/i);

        // Sanity: the OWNER, by contrast, CAN sign for the same work.
        const oUrl = await postScreenshot(request, ownerToken, 'get-url', {
            url: 'https://example.com',
            workId: work.id,
        });
        expect(oUrl.status, 'owner can sign for their own work → 201').toBe(201);
        expect(String(oUrl.body.imageUrl ?? '')).toContain('access_key=');
    });

    test('Flow 5: provider-specific signed-URL building honours every option (screenshotone vs urlbox)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const all = await listPluginsViaAPI(request, token);
        const ids = all.filter((p) => p.category === 'screenshot').map((p) => p.id);
        const hasUrlbox = ids.includes('urlbox');

        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: SCREENSHOTONE_KEYS(),
        });

        // screenshotone: viewport + format + explicit block flags are encoded into
        // the signed query. Note the LOCAL HMAC build → no outbound HTTP, so even
        // bogus keys yield a 201 with a fully-formed URL.
        const so = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            format: 'webp',
            viewportWidth: 390,
            viewportHeight: 844,
            fullPage: true,
            blockAds: false,
            blockTrackers: false,
        });
        expect(so.status, 'screenshotone get-url → 201').toBe(201);
        const soUrl = String(so.body.imageUrl ?? '');
        expect(soUrl, 'screenshotone take endpoint').toContain('api.screenshotone.com/take');
        expect(soUrl, 'target url encoded').toContain(encodeURIComponent('https://example.com'));
        expect(soUrl, 'viewport width honoured').toContain('viewport_width=390');
        expect(soUrl, 'viewport height honoured').toContain('viewport_height=844');
        expect(soUrl, 'format honoured').toContain('format=webp');
        expect(soUrl, 'fullPage honoured').toContain('full_page=true');
        // An EXPLICIT false must survive into the query (not be dropped/defaulted).
        expect(soUrl, 'explicit blockAds:false honoured').toContain('block_ads=false');
        expect(soUrl, 'HMAC signed').toContain('signature=');
        expect(soUrl, 'access key embedded').toContain('access_key=');

        // Omitting block flags yields the provider default (block_ads=true) — and
        // the viewport defaults to 1280x800.
        const soDefault = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
        });
        const soDefaultUrl = String(soDefault.body.imageUrl ?? '');
        expect(soDefaultUrl, 'default viewport width 1280').toContain('viewport_width=1280');
        expect(soDefaultUrl, 'default viewport height 800').toContain('viewport_height=800');
        expect(soDefaultUrl, 'default block_ads=true when omitted').toContain('block_ads=true');

        // urlbox builds a DIFFERENT URL shape (path-embedded key+sig, width/height,
        // quality, hide_cookie_banners). Routed via providerOverride.
        if (hasUrlbox) {
            await enablePluginViaAPI(request, token, 'urlbox', {
                secretSettings: {
                    apiKey: `fake-api-${Date.now()}`,
                    apiSecret: `fake-secret-${Date.now()}`,
                },
            });
            const ub = await postScreenshot(request, token, 'get-url', {
                url: 'https://example.com',
                providerOverride: 'urlbox',
            });
            expect(ub.status, 'urlbox get-url → 201').toBe(201);
            const ubUrl = String(ub.body.imageUrl ?? '');
            expect(ubUrl, 'urlbox host').toContain('api.urlbox.io/v1/');
            expect(ubUrl, 'urlbox uses width=').toContain('width=');
            expect(ubUrl, 'urlbox uses height=').toContain('height=');
            expect(ubUrl, 'urlbox uses its own cookie-banner param').toContain(
                'hide_cookie_banners',
            );
            // The two providers produce genuinely different URL shapes.
            expect(ubUrl, 'urlbox is NOT a screenshotone URL').not.toContain(
                'api.screenshotone.com',
            );
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'urlbox not registered in this build — skipped its URL-shape assertions',
            });
        }
    });

    test('Flow 6: gating order — DTO → "no provider" gate → provider override routing/rejection', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // With NOTHING enabled, capture/get-url are gated BEFORE any facade call:
        // a 400 { status:'error', message:'No screenshot provider configured' }.
        for (const op of ['capture', 'get-url'] as const) {
            const gated = await postScreenshot(request, token, op, { url: 'https://example.com' });
            expect(gated.status, `${op}: no provider → 400 gate`).toBe(400);
            expect(gated.body.status, `${op}: error envelope`).toBe('error');
            expect(messageText(gated.body), `${op}: names the missing provider`).toMatch(
                /no screenshot provider configured/i,
            );
        }

        // A DTO error STILL wins over the provider gate even with nothing enabled
        // (validation runs first): a bad viewport on a no-provider account is a
        // class-validator 400, not the "no provider configured" envelope.
        const dtoFirst = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            viewportWidth: 1,
        });
        expect(dtoFirst.status, 'DTO failure → 400').toBe(400);
        expect(messageText(dtoFirst.body), 'DTO message wins over the provider gate').toMatch(
            /viewportWidth must not be less than 320/i,
        );

        // Now enable two providers (if urlbox exists) to exercise routing.
        await enablePluginViaAPI(request, token, 'screenshotone', {
            secretSettings: SCREENSHOTONE_KEYS(),
        });
        const ids = (await listPluginsViaAPI(request, token))
            .filter((p) => p.category === 'screenshot')
            .map((p) => p.id);
        const hasUrlbox = ids.includes('urlbox');
        if (hasUrlbox) {
            await enablePluginViaAPI(request, token, 'urlbox', {
                secretSettings: {
                    apiKey: `fake-api-${Date.now()}`,
                    apiSecret: `fake-secret-${Date.now()}`,
                },
            });
        }

        // The default (screenshotone) sorts first and resolves as activeProvider.
        const avail = await checkAvailability(request, token);
        expect(avail.body.providers[0].isDefault, 'default sorts first').toBe(true);
        expect(avail.body.activeProvider?.id, 'an active provider resolves').toBeTruthy();

        // providerOverride routes get-url to the named plugin's signed-URL builder.
        if (hasUrlbox) {
            const routed = await postScreenshot(request, token, 'get-url', {
                url: 'https://example.com',
                providerOverride: 'urlbox',
            });
            expect(routed.status, 'override → 201').toBe(201);
            expect(String(routed.body.imageUrl ?? ''), 'routed to urlbox').toContain(
                'api.urlbox.io',
            );
        }

        // An UNKNOWN providerOverride names no resolvable plugin → a non-2xx
        // rejection (never a fabricated 2xx). Tolerate 400/404/500 across builds.
        const badOverride = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            providerOverride: `nonexistent-${Date.now()}`,
        });
        expect(
            [400, 404, 500].includes(badOverride.status),
            `unknown override rejected (got ${badOverride.status})`,
        ).toBe(true);

        // Finally, disabling the provider re-arms the gate (idempotent disable).
        await disablePluginViaAPI(request, token, 'screenshotone');
        if (hasUrlbox) await disablePluginViaAPI(request, token, 'urlbox');
        await expect
            .poll(async () => (await checkAvailability(request, token)).body.available, {
                timeout: 15_000,
                message: 'availability returns to false after disabling all providers',
            })
            .toBe(false);
    });
});
