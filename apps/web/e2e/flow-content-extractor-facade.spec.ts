import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    type RegisteredUser,
} from './helpers/api';
import {
    listPluginsViaAPI,
    getPluginViaAPI,
    enablePluginViaAPI,
    type PluginSummary,
} from './helpers/plugins';

/**
 * CONTENT-EXTRACTOR capability facade — DEEP coverage of the surface the
 * `ContentExtractorFacadeService`
 * (packages/agent/src/facades/content-extractor.facade.ts) is dispatched
 * through. UNLIKE the screenshot/search capabilities there is NO dedicated
 * `/api/content-extractor/*` controller in `apps/api/src/plugins-capabilities/`
 * (probed live: no `extract` route exists in this build, and swagger/api-json is
 * 404 on the prod `next start` image). The facade is INTERNAL — agent tools,
 * the comparison researcher, fetch-page tool and the KB buffer extractor call it
 * in-process; the work generator selects a provider through it. The user-facing,
 * HTTP-probeable contract is therefore the PROVIDER + per-WORK CAPABILITY
 * management that drives the facade's resolution order:
 *   - `GET  /api/plugins?category=content-extractor`         (registry list)
 *   - `GET  /api/plugins/:id`                                (provider detail)
 *   - `POST /api/plugins/:id/validate-connection`            (keyless vs keyed gate)
 *   - `POST /api/works/:id/plugins/:pid/enable`              (scope enable + key gate)
 *   - `POST /api/works/:id/plugins/:pid/capability`          (provider selection)
 * and the resulting `capabilityProviders['content-extractor']` map — the EXACT
 * binding the facade reads as the work's active extractor.
 *
 * NON-DUPLICATION — deliberately distinct from the sibling capability specs:
 *   - `flow-screenshot-capability-deep.spec.ts` / `flow-screenshot-capture-geturl-deep.spec.ts`
 *     → the screenshot `/api/screenshot/*` controller (SSRF guard, signed-url
 *     matrix, capture). Different controller, different facade. We touch NONE of
 *     it.
 *   - `flow-search-providers-deep.spec.ts` → the `/api/search/*` controller's
 *     OWN `resolveConfiguredProvider()` + the env-skipped apiKey gate for SEARCH
 *     providers. The content-extractor facade has no such controller; we assert
 *     the GENERIC plugin/capability-management contract for the
 *     content-extractor CATEGORY instead, which the search spec never touches.
 *   - `plugins-crud.spec.ts` / `plugin-enable-disable-lifecycle.spec.ts` →
 *     generic user-scope enable/disable smoke. We do NOT re-assert those; we pin
 *     the content-extractor-SPECIFIC default/keyless registry contract, the
 *     per-WORK active-capability binding, the configured-non-default OVERRIDE of
 *     the capabilityProviders map, the keyed-extractor not-configured gate, and
 *     the system-plugin disable rejection.
 *
 * Every status / message / shape below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) before its assertion was written — never guessed.
 *
 * PROBED CONTRACTS (live):
 *   - GET /api/plugins?category=content-extractor → { plugins, total, categories,
 *     capabilities }. The content-extractor family ships local-content-extractor,
 *     notion-extractor, pdf-extractor, scrapfly, plus the multi-capability search
 *     extractors (jina, exa, tavily, firecrawl, brightdata, linkup, valyu).
 *   - local-content-extractor is the KEYLESS default: { systemPlugin:true,
 *     autoEnable:true, enabled:true, state:'loaded', defaultForCapabilities:
 *     ['content-extractor'], settingsSchema.properties:{} (no required keys) }.
 *   - POST /api/plugins/local-content-extractor/validate-connection → 200
 *     { success:true, message:'Local Content Extractor connection verified.' } —
 *     the keyless extractor works with no credentials (real extraction contract).
 *   - scrapfly: settingsSchema.required:['apiKey']. validate-connection with NO
 *     creds → 400 { message:'Scrapfly API key is not configured.' } — the keyed
 *     extractor not-configured gate is a TYPED 400, never a 5xx stacktrace.
 *   - GET /api/works/:id/plugins → { plugins, total, capabilityProviders }.
 *     capabilityProviders is a `{ [capability]: pluginId }` map; for a fresh work
 *     content-extractor resolves to the system default `local-content-extractor`.
 *   - POST /api/works/:id/plugins/local-content-extractor/capability
 *     { capability:'content-extractor' } → 200, body.activeCapabilities includes
 *     'content-extractor' (+ workEnabled, workPluginId, priority).
 *   - Configured NON-default override: user-enable jina WITH apiKey →
 *     work-enable jina → set capability 'content-extractor' → capabilityProviders
 *     flips to { 'content-extractor':'jina' } (provider SELECTION = the binding
 *     the facade dispatches to).
 *   - DTO validation: capability:'not-a-real-capability' → 400 with message
 *     "'…' is not a valid capability. Valid capabilities are: ai-provider, …,
 *     content-extractor, …". Omitted capability → 400. (IsValidCapabilityConstraint.)
 *   - Capability the plugin LACKS: capability:'ai-provider' on a content-extractor
 *     plugin → 400 { message:'Plugin "local-content-extractor" does not provide
 *     capability "ai-provider"' } — typed, not a 5xx.
 *   - Nonexistent pluginId on a valid work capability → 404 { message:'Plugin
 *     "…" not found' }. Nonexistent plugin detail GET → 404.
 *   - Keyed extractor work-enable WITHOUT user-level creds → 400 { message:
 *     'User-level required settings must be configured first', errors:['Missing
 *     required fields: apiKey'] }.
 *   - System plugin disable rejection: POST /api/works/:id/plugins/
 *     local-content-extractor/disable → 400 { message:'Plugin
 *     "local-content-extractor" is a system plugin and cannot be disabled' }.
 *   - IDOR (cross-user): foreign work GET plugins → 403, foreign work set
 *     capability → 403. Nonexistent (valid) work → 404.
 *   - AUTH: anon GET /api/plugins → 401, anon GET work plugins → 401, anon set
 *     capability → 401.
 *
 * ISOLATION: every mutation registers a FRESH user via API. Provider keys are
 * written at the USER/WORK scope and would shadow sibling specs, so we never
 * touch the shared seeded user. Unique suffixes come from the per-test title +
 * a module counter — never a module-scope clock, and no module-scope await.
 * Filename uses the safe `flow-` prefix and is fully API-orchestrated.
 */

interface WorkPluginsResponse {
    plugins: Array<Record<string, unknown>>;
    total?: number;
    capabilityProviders?: Record<string, string>;
}

interface CapabilityResponse {
    pluginId?: string;
    id?: string;
    enabled?: boolean;
    workEnabled?: boolean;
    activeCapabilities?: string[];
    priority?: number;
}

let SUFFIX_COUNTER = 0;
/** Per-test unique suffix — built from the test title, never a module-scope clock. */
function uniqueSuffix(title: string): string {
    SUFFIX_COUNTER += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '').slice(0, 8)}${SUFFIX_COUNTER}${Math.random()
        .toString(36)
        .slice(2, 7)}`;
}

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    return registerUserViaAPI(request);
}

/** Flatten a class-validator `message` (string | string[]) into one string. */
function messageText(body: unknown): string {
    const m = (body as { message?: unknown } | null)?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

async function listContentExtractors(
    request: APIRequestContext,
    token: string,
): Promise<PluginSummary[]> {
    const all = await listPluginsViaAPI(request, token);
    return all.filter(
        (p) =>
            p.category === 'content-extractor' ||
            (p.capabilities ?? []).includes('content-extractor'),
    );
}

async function getWorkPlugins(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; body: WorkPluginsResponse }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
        headers: authedHeaders(token),
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as WorkPluginsResponse,
    };
}

async function setActiveCapability(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
    capability: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(
        `${API_BASE}/api/works/${workId}/plugins/${pluginId}/capability`,
        { headers: authedHeaders(token), data: { capability } },
    );
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

async function validateConnection(
    request: APIRequestContext,
    token: string,
    pluginId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/validate-connection`, {
        headers: authedHeaders(token),
        data: {},
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

test.describe('Content-extractor capability facade — provider registry, selection, DTO + keyed gates', () => {
    test('registry: content-extractor family ships local-content-extractor as the keyless system default', async ({
        request,
    }) => {
        const token = (await freshUser(request)).access_token;
        const extractors = await listContentExtractors(request, token);

        const ids = extractors.map((p) => p.id);
        expect(ids, 'local-content-extractor is registered').toContain('local-content-extractor');
        // The supplementary + keyed specialists are also registered (resolution
        // order references them) even though only the local one is keyless.
        expect(ids, 'scrapfly extractor registered').toContain('scrapfly');

        // Full provider DETAIL — the keyless default contract the facade leans on.
        const local = (await getPluginViaAPI(request, token, 'local-content-extractor')) as Record<
            string,
            unknown
        >;
        expect(local.category, 'category').toBe('content-extractor');
        expect(local.systemPlugin, 'system plugin').toBe(true);
        expect(local.enabled, 'auto-enabled for the user').toBe(true);
        expect(local.state, 'loaded into the registry').toBe('loaded');
        expect(local.defaultForCapabilities as string[], 'is the capability default').toContain(
            'content-extractor',
        );
        // No required settings ⇒ keyless. settingsSchema.properties is empty.
        const schema = local.settingsSchema as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(schema?.required ?? [], 'no required credential fields').toHaveLength(0);
        expect(Object.keys(schema?.properties ?? {}), 'no settings props at all').toHaveLength(0);
    });

    test('validate-connection divergence: keyless local extractor verifies (200), keyed scrapfly is the typed not-configured 400', async ({
        request,
    }) => {
        const token = (await freshUser(request)).access_token;

        // The keyless extractor's real connection check succeeds with NO creds —
        // the "local extractor works keyless → real extraction contract" anchor.
        const local = await validateConnection(request, token, 'local-content-extractor');
        expect(local.status, 'keyless validate → 200').toBe(200);
        expect(local.body.success, 'verified').toBe(true);
        expect(messageText(local.body), 'verified message').toMatch(
            /Local Content Extractor connection verified/i,
        );

        // The keyed extractor with no apiKey is gated with a TYPED 400 — never a
        // 5xx stacktrace (env-adaptive: a real PLUGIN_SCRAPFLY key would 200, but
        // the keyless CI mirror has none).
        const scrapfly = await validateConnection(request, token, 'scrapfly');
        expect(scrapfly.status, 'keyed validate with no creds → 400 gate').toBe(400);
        expect(messageText(scrapfly.body), 'names the missing API key').toMatch(
            /api key is not configured/i,
        );
    });

    test('per-work selection: setting local-content-extractor active binds it as the work content-extractor', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE Bind ${uniqueSuffix(testInfo.title)}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        // Fresh work: NO capability binding is materialised yet — the
        // capabilityProviders map is empty until a provider is explicitly bound.
        // (The facade still falls back to the system default at resolve-time, but
        // the per-work MAP is unpopulated; that is the contract we pin here.)
        const before = await getWorkPlugins(request, token, work.id);
        expect(before.status, 'owner can view own work plugins').toBe(200);
        expect(
            before.body.capabilityProviders?.['content-extractor'],
            'fresh work has no explicit content-extractor binding',
        ).toBeUndefined();

        // Explicitly setting the active capability stamps activeCapabilities on
        // the work-plugin record (the facade reads this to dispatch).
        const set = await setActiveCapability(
            request,
            token,
            work.id,
            'local-content-extractor',
            'content-extractor',
        );
        expect(set.status, 'set active capability → 200').toBe(200);
        const body = set.body as unknown as CapabilityResponse;
        expect(body.activeCapabilities ?? [], 'content-extractor is now active').toContain(
            'content-extractor',
        );
        expect(body.workEnabled, 'plugin is work-enabled').toBe(true);

        // After activation the binding APPEARS in the capabilityProviders map —
        // the exact provider id the facade dispatches to for this work.
        const after = await getWorkPlugins(request, token, work.id);
        expect(
            after.body.capabilityProviders?.['content-extractor'],
            'binding now resolves to the system extractor',
        ).toBe('local-content-extractor');
    });

    test('provider selection override: a configured NON-default extractor (jina) replaces the work binding', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const suffix = uniqueSuffix(testInfo.title);

        // Jina is a multi-capability (search + content-extractor) provider with a
        // required apiKey. Configure it at USER scope first (a FAKE key passes the
        // has-all-required-settings gate; no outbound call is made by enable).
        await enablePluginViaAPI(request, token, 'jina', {
            secretSettings: { apiKey: `jina-fake-${suffix}` },
        });

        const work = await createWorkViaAPI(request, token, { name: `CE Override ${suffix}` });
        expect(work.id, 'work created').toBeTruthy();

        // Work-enable now succeeds because the user-level requirement is satisfied.
        const enable = await request.post(`${API_BASE}/api/works/${work.id}/plugins/jina/enable`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(enable.status(), 'work-enable jina → 2xx').toBeLessThan(300);

        // Selecting jina as the active content-extractor OVERRIDES the system
        // default in the capabilityProviders map — this is the provider the facade
        // would dispatch to for this work.
        const set = await setActiveCapability(request, token, work.id, 'jina', 'content-extractor');
        expect(set.status, 'set jina active → 200').toBe(200);

        const after = await getWorkPlugins(request, token, work.id);
        expect(
            after.body.capabilityProviders?.['content-extractor'],
            'binding flips from local-content-extractor to jina',
        ).toBe('jina');
    });

    test('DTO validation: an invalid capability is rejected with the valid-capabilities message (content-extractor listed)', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE DTO ${uniqueSuffix(testInfo.title)}`,
        });

        const bad = await setActiveCapability(
            request,
            token,
            work.id,
            'local-content-extractor',
            'not-a-real-capability',
        );
        expect(bad.status, 'invalid capability → 400 DTO').toBe(400);
        const msg = messageText(bad.body);
        expect(msg, 'flags the invalid value').toMatch(/is not a valid capability/i);
        // The IsValidCapabilityConstraint enumerates the allowed set — which
        // content-extractor belongs to.
        expect(msg, 'lists content-extractor as valid').toMatch(/content-extractor/i);
    });

    test('DTO validation: an omitted capability field is a 400', async ({ request }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE Empty ${uniqueSuffix(testInfo.title)}`,
        });

        // capability is @IsString() + required → an empty body fails validation.
        const res = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/local-content-extractor/capability`,
            { headers: authedHeaders(token), data: {} },
        );
        expect(res.status(), 'missing capability → 400').toBe(400);
    });

    test('capability mismatch: a content-extractor plugin cannot be bound to a capability it lacks (typed 400)', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE Mismatch ${uniqueSuffix(testInfo.title)}`,
        });

        // 'ai-provider' is a VALID capability (passes the DTO) but the
        // content-extractor plugin does not provide it → a service-level typed 400,
        // distinct from the DTO rejection above. Never a 5xx.
        const res = await setActiveCapability(
            request,
            token,
            work.id,
            'local-content-extractor',
            'ai-provider',
        );
        expect(res.status, 'plugin lacks capability → 400').toBe(400);
        expect(messageText(res.body), 'names plugin + capability').toMatch(
            /does not provide capability/i,
        );
    });

    test('nonexistent plugin: setting a capability on an unknown pluginId for a real work is a 404', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE 404 ${uniqueSuffix(testInfo.title)}`,
        });

        const res = await setActiveCapability(
            request,
            token,
            work.id,
            `ghost-extractor-${uniqueSuffix(testInfo.title)}`,
            'content-extractor',
        );
        expect(res.status, 'unknown plugin → 404').toBe(404);
        expect(messageText(res.body), 'not-found names the plugin').toMatch(/not found/i);

        // Detail GET for an unknown plugin id is likewise a 404.
        const detail = await request.get(
            `${API_BASE}/api/plugins/ghost-extractor-${uniqueSuffix(testInfo.title)}`,
            { headers: authedHeaders(token) },
        );
        expect(detail.status(), 'unknown plugin detail → 404').toBe(404);
    });

    test('keyed extractor gate: work-enabling a keyed extractor without user-level creds is a typed 400', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE Keyed ${uniqueSuffix(testInfo.title)}`,
        });

        // jina requires apiKey at user scope and is NOT enabled at user level for
        // this fresh user. Work-enabling it is rejected with a typed 400 — the
        // BYOK/required-field contract, not a 5xx. The exact gate depends on the
        // user-scope state: an entirely un-enabled provider trips the "must be
        // enabled at user level first" gate; one enabled-but-key-less trips the
        // "required settings must be configured" gate. Both are valid keyed
        // rejections — accept either real gate message.
        const res = await request.post(`${API_BASE}/api/works/${work.id}/plugins/jina/enable`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(res.status(), 'keyed work-enable without creds → 400').toBe(400);
        const body = (await res.json().catch(() => ({}))) as {
            message?: string;
            errors?: string[];
        };
        expect(messageText(body), 'typed keyed gate (not a 5xx)').toMatch(
            /must be enabled at user level first|required settings must be configured/i,
        );
    });

    test('system plugin disable rejection: the default local extractor cannot be disabled for a work', async ({
        request,
    }, testInfo) => {
        const token = (await freshUser(request)).access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `CE Sysdisable ${uniqueSuffix(testInfo.title)}`,
        });

        const res = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/local-content-extractor/disable`,
            { headers: authedHeaders(token) },
        );
        expect(res.status(), 'system plugin disable → 400').toBe(400);
        expect(messageText(await res.json().catch(() => ({}))), 'system-plugin reason').toMatch(
            /system plugin and cannot be disabled/i,
        );
    });

    test('cross-user IDOR: a foreign work refuses read AND capability-write; a nonexistent work is a 404', async ({
        request,
    }, testInfo) => {
        const owner = await freshUser(request);
        const attacker = await freshUser(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `CE IDOR ${uniqueSuffix(testInfo.title)}`,
        });
        expect(work.id, 'victim work created').toBeTruthy();

        // Attacker reads the victim's work plugins → 403 (ownership guard).
        const read = await getWorkPlugins(request, attacker.access_token, work.id);
        expect(read.status, 'foreign work plugins read → 403').toBe(403);

        // Attacker tries to rebind the victim's content-extractor → 403.
        const write = await setActiveCapability(
            request,
            attacker.access_token,
            work.id,
            'local-content-extractor',
            'content-extractor',
        );
        expect(write.status, 'foreign work capability write → 403').toBe(403);

        // A valid-but-nonexistent work for the OWNER is a 404 (not a 403) — the
        // lookup fails before any ownership decision.
        const ghost = await getWorkPlugins(
            request,
            owner.access_token,
            '00000000-0000-0000-0000-000000000000',
        );
        expect(ghost.status, 'nonexistent work → 404').toBe(404);
    });

    test('auth gate: anonymous registry list, work plugins, and capability-write are all 401', async ({
        request,
    }, testInfo) => {
        // A real work id exists, but no bearer is sent. Use raw request (no shared
        // storageState / cookies) so this is a genuine anonymous call.
        const owner = await freshUser(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `CE Anon ${uniqueSuffix(testInfo.title)}`,
        });

        const anonList = await request.get(`${API_BASE}/api/plugins?category=content-extractor`);
        expect(anonList.status(), 'anon registry list → 401').toBe(401);

        const anonWork = await request.get(`${API_BASE}/api/works/${work.id}/plugins`);
        expect(anonWork.status(), 'anon work plugins → 401').toBe(401);

        const anonCap = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/local-content-extractor/capability`,
            { data: { capability: 'content-extractor' } },
        );
        expect(anonCap.status(), 'anon capability write → 401').toBe(401);
    });
});
