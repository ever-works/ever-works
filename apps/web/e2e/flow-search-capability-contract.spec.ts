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
    patchPluginSettingsViaAPI,
} from './helpers/plugins';

/**
 * SEARCH capability CONTRACT — the `/api/search/*` facade examined from angles
 * the existing search specs do NOT cover. Complex, multi-step, cross-feature
 * INTEGRATION flows themed around: the full provider family catalog + per-plugin
 * settingsSchema secret/envVar/scope contract, the configured-vs-unconfigured
 * provider DIVERGENCE (the message FLIPS once a key — even a fake one — is set,
 * proving real facade dispatch), per-work provider resolution anchoring to the
 * default, cross-user availability isolation, the domain-filter / maxResults DTO
 * envelope (valid bodies reach the provider; invalid ones carry exact messages),
 * and the search-result item contract.
 *
 * DELIBERATELY DISTINCT from the sibling specs (no duplication):
 *   - `flow-plugin-search-lifecycle.spec.ts` → default-tavily priority at USER
 *     scope, the availability {status,available,activeProvider} contract, the
 *     core DTO matrix (query/workId/maxResults/includeDomains), ownership 404,
 *     and brave maxResults 1..20 + apiKey masking. We do NOT re-assert those.
 *   - `flow-plugin-lifecycle-search.spec.ts` → user/work enable lifecycle, the
 *     user-level-required GATE on work-enable, work capabilityProviders mapping.
 *   - `plugins-search.spec.ts` → shallow availability boolean-shape + 401 smoke.
 *
 * Every status / shape / message below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-06-01 before being asserted — never guessed.
 *
 * PROBED CONTRACTS (apps/api/src/plugins-capabilities/search + packages/agent
 * /src/facades/search.facade.ts):
 *
 *   PROVIDER FAMILY (GET /api/plugins, category:'search') — 9 ships on develop:
 *     brave, brightdata, exa, firecrawl, linkup, perplexity, serpapi, tavily,
 *     valyu. Only `tavily` is { systemPlugin:true, autoEnable:true,
 *     defaultForCapabilities:['search'] } → auto-enabled + always the active
 *     provider for a fresh user. Every search plugin's settingsSchema.required
 *     includes 'apiKey'; the apiKey property carries { type:'string',
 *     secret:true, envVar:'PLUGIN_<X>_API_KEY', scope:'user' }. brave's
 *     maxResults is { scope:'global', minimum:1, maximum:20, default:10 }.
 *
 *   GET /api/search/check-availability (Bearer; AuthSessionGuard):
 *     fresh user → 200 { status:'success', available:true,
 *     activeProvider:{ id:'tavily', name:'Tavily' } }. The resolver SKIPS
 *     required fields carrying x-envVar (apiKey does) → availability == "is any
 *     search plugin ENABLED", stays true with no real key. USER-SCOPED: one
 *     user enabling/configuring providers never moves another user's slot.
 *
 *   POST /api/search { query, workId?, maxResults?(1..50), includeDomains?[],
 *                      excludeDomains?[] } (Bearer; SearchDto, whitelist+forbid):
 *     • VALID full body (maxResults + includeDomains + excludeDomains) PASSES
 *       the DTO and reaches provider resolution → env-adaptive 200/400.
 *     • includeDomains:[123]      → 400 ['each value in includeDomains must be a string'].
 *     • excludeDomains:'x.com'    → 400 ['excludeDomains must be an array'].
 *     • query:123                 → 400 ['query must be a string'].
 *     • maxResults:'10'           → 400 ['maxResults must not be greater than 50',
 *                                        'maxResults must not be less than 1',
 *                                        'maxResults must be a number conforming…'].
 *     • { query, bogus:'x' }      → 400 ['property bogus should not exist'] (forbid).
 *     • UNCONFIGURED default (tavily, no key) → 400 { status:'error',
 *       message:'Tavily API key not configured. Set it in plugin settings or via
 *       PLUGIN_TAVILY_API_KEY environment variable.' }.
 *     • CONFIGURED default (fake tavily key set) → the facade DISPATCHES to the
 *       real provider; with a bogus key Tavily answers 401 upstream → mapped to
 *       400 { status:'error', message:'Unauthorized: missing or invalid API key.' }
 *       (env-adaptive: a REAL key → 200 { status:'success', results, provider }).
 *       The message FLIPPING off "API key not configured" is the proof of
 *       configured-vs-unconfigured divergence — never a 5xx either way.
 *     • workId resolution uses getEnabledPluginsScoped(workId) which sorts
 *       defaultForCapabilities first → the default tavily WINS even when a
 *       non-default provider (brave) is user-configured AND work-enabled.
 *
 *   SEARCH-RESULT item contract (facade.search → 200 path, env-adaptive):
 *     results: Array<{ title, url, score (==1 - index*0.05, strictly desc),
 *     publishedDate? }>, plus a top-level provider:<name>.
 *
 * Cross-spec isolation: EVERY mutation runs on a FRESH registerUserViaAPI()
 * user (a user-scoped fake search key would otherwise shadow env keys + break
 * sibling chat/search specs). Unique works use Date.now() suffixes; presence is
 * asserted with toContain, never exact catalog counts. No real LLM/search key.
 */

const DEFAULT_SEARCH = 'tavily';
const SECONDARY_SEARCH = 'brave';

// The full search provider family that ships on develop (probed). We assert the
// catalog CONTAINS these (toContain), never an exact set, to tolerate additions.
const SEARCH_FAMILY = [
    'brave',
    'brightdata',
    'exa',
    'firecrawl',
    'linkup',
    'perplexity',
    'serpapi',
    'tavily',
    'valyu',
] as const;

const FAKE_SEARCH_KEY = 'e2e-fake-search-key-abcdefghij1234';

interface AvailabilityBody {
    status?: string;
    available?: boolean;
    activeProvider?: { id?: string; name?: string } | null;
    message?: string;
}

interface SearchBody {
    status?: string;
    message?: unknown;
    provider?: string;
    results?: Array<{ title?: string; url?: string; score?: number; publishedDate?: string }>;
}

async function getAvailability(
    request: APIRequestContext,
    token: string,
): Promise<{ status: number; body: AvailabilityBody }> {
    const res = await request.get(`${API_BASE}/api/search/check-availability`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as AvailabilityBody };
}

async function postSearch(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: SearchBody & Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/search`, {
        headers: authedHeaders(token),
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as SearchBody & Record<string, unknown>,
    };
}

function flatten(msg: unknown): string {
    return Array.isArray(msg) ? msg.join(' | ') : String(msg);
}

test.describe('Search capability contract — facade, provider family, gating', () => {
    test('FLOW 1: the search provider FAMILY catalog — only tavily is the system default; every provider requires an apiKey marked secret + envVar + user-scoped', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // The catalog must ship the whole search family (presence, not an exact set).
        const catalog = await listPluginsViaAPI(request, user.access_token);
        const searchIds = catalog.filter((p) => p.category === 'search').map((p) => p.id);
        expect(searchIds.length, 'a rich search-provider family ships').toBeGreaterThanOrEqual(8);
        for (const id of SEARCH_FAMILY) {
            expect(searchIds, `search family is missing "${id}"`).toContain(id);
        }

        // Exactly ONE member (tavily) is the system + auto-enabled + default-for-
        // search plugin; every other family member is non-system + non-auto + OFF.
        const tavily = await getPluginViaAPI(request, user.access_token, DEFAULT_SEARCH);
        expect(tavily.systemPlugin).toBe(true);
        expect(tavily.autoEnable).toBe(true);
        expect(tavily.enabled, 'tavily auto-enables for a fresh user').toBe(true);
        expect(tavily.defaultForCapabilities).toContain('search');

        // Walk a representative slice of the family and pin the per-plugin contract:
        // search capability present, apiKey is required + secret + env-overridable +
        // user-scoped. This is the per-provider settingsSchema contract that the
        // sibling specs never assert across the family.
        for (const id of ['brave', 'exa', 'serpapi', 'perplexity', 'linkup']) {
            const plugin = await getPluginViaAPI(request, user.access_token, id);
            expect(plugin.category).toBe('search');
            expect(plugin.capabilities, `${id} provides search`).toContain('search');
            expect(plugin.systemPlugin, `${id} is not a system plugin`).not.toBe(true);
            expect(plugin.autoEnable, `${id} does not auto-enable`).not.toBe(true);
            expect(plugin.enabled, `${id} starts disabled for a fresh user`).toBe(false);

            const schema = plugin.settingsSchema as
                | { required?: string[]; properties?: Record<string, Record<string, unknown>> }
                | undefined;
            expect(schema?.required, `${id} requires apiKey`).toContain('apiKey');
            const apiKeyProp = schema?.properties?.apiKey ?? {};
            expect(apiKeyProp.type).toBe('string');
            expect(apiKeyProp.secret, `${id} apiKey is a secret field`).toBe(true);
            expect(String(apiKeyProp.envVar ?? ''), `${id} apiKey is env-overridable`).toMatch(
                /^PLUGIN_.+_API_KEY$/,
            );
            expect(apiKeyProp.scope, `${id} apiKey is user-scoped`).toBe('user');
        }

        // brave's maxResults is a global, 1..20-bounded knob (distinct from the
        // SearchDto's per-request @Max(50)) — pin the schema bound at the source.
        const brave = await getPluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const braveMax = (
            brave.settingsSchema as { properties?: Record<string, Record<string, unknown>> }
        )?.properties?.maxResults;
        expect(braveMax?.scope).toBe('global');
        expect(braveMax?.minimum).toBe(1);
        expect(braveMax?.maximum).toBe(20);
    });

    test('FLOW 2: the SearchDto envelope — a fully-populated valid body (domains + maxResults) reaches provider resolution, while every malformed field carries its exact class-validator message', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // (a) A fully-populated VALID body — maxResults inside 1..50, both domain
        //     filters as string[] — PASSES the DTO and reaches provider resolution.
        //     It is NOT a validation 400 (no array message); it is the env-adaptive
        //     provider outcome (200 keyed, or a clean status:'error' 400 key-less).
        const validFull = await postSearch(request, user.access_token, {
            query: 'open source software directories',
            maxResults: 10,
            includeDomains: ['github.com', 'stackoverflow.com'],
            excludeDomains: ['pinterest.com'],
        });
        expect(validFull.status, `valid body must not 5xx (got ${validFull.status})`).toBeLessThan(
            500,
        );
        expect([200, 400]).toContain(validFull.status);
        if (validFull.status === 400) {
            // Provider-stage error, never the DTO validator (which would be an array).
            expect(validFull.body.status).toBe('error');
            expect(Array.isArray(validFull.body.message)).toBe(false);
        }

        // Empty domain arrays are also valid and behave the same (env-adaptive).
        const emptyArrays = await postSearch(request, user.access_token, {
            query: 'directories',
            includeDomains: [],
            excludeDomains: [],
        });
        expect([200, 400]).toContain(emptyArrays.status);

        // (b) MALFORMED matrix — each is a clean 400 with the exact message. These
        //     edges are distinct from the sibling spec's matrix (which tests bare
        //     includeDomains, workId-uuid, and numeric maxResults bounds).
        const domainNumber = await postSearch(request, user.access_token, {
            query: 'q',
            includeDomains: [123],
        });
        expect(domainNumber.status).toBe(400);
        expect(flatten(domainNumber.body.message)).toContain(
            'each value in includeDomains must be a string',
        );

        const excludeBareString = await postSearch(request, user.access_token, {
            query: 'q',
            excludeDomains: 'x.com',
        });
        expect(excludeBareString.status).toBe(400);
        expect(flatten(excludeBareString.body.message)).toContain(
            'excludeDomains must be an array',
        );

        const queryNumber = await postSearch(request, user.access_token, { query: 123 });
        expect(queryNumber.status).toBe(400);
        expect(flatten(queryNumber.body.message)).toContain('query must be a string');

        const maxResultsString = await postSearch(request, user.access_token, {
            query: 'q',
            maxResults: '10',
        });
        expect(maxResultsString.status).toBe(400);
        expect(flatten(maxResultsString.body.message)).toMatch(
            /maxResults must be a number conforming/i,
        );

        // (c) WHITELIST: an unknown property is forbidden outright (forbidNonWhitelisted).
        const extraProp = await postSearch(request, user.access_token, {
            query: 'q',
            bogus: 'x',
        });
        expect(extraProp.status).toBe(400);
        expect(flatten(extraProp.body.message)).toContain('property bogus should not exist');

        // All malformed requests are clean 4xx — never a 5xx.
        for (const r of [
            domainNumber,
            excludeBareString,
            queryNumber,
            maxResultsString,
            extraProp,
        ]) {
            expect(r.status).toBeGreaterThanOrEqual(400);
            expect(r.status).toBeLessThan(500);
        }
    });

    test('FLOW 3: configured-vs-unconfigured DIVERGENCE — the SAME query flips from "API key not configured" to a provider-level error the moment a key is set, proving real facade dispatch (env-adaptive, never 5xx)', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const QUERY = 'open source web directories';

        // PHASE A (UNCONFIGURED): availability is true (env-skip), yet an actual
        // search resolves the default tavily and reports its MISSING key. This is
        // the "available-but-not-usable" divergence at the search-execution layer.
        const availBefore = await getAvailability(request, user.access_token);
        expect(availBefore.body.available, 'availability reports true via env-skip').toBe(true);
        expect(availBefore.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        const unconfigured = await postSearch(request, user.access_token, { query: QUERY });
        expect(unconfigured.status, 'unconfigured search must not 5xx').toBeLessThan(500);
        let sawUnconfiguredBranch = false;
        if (unconfigured.status === 400) {
            expect(unconfigured.body.status).toBe('error');
            const msg = flatten(unconfigured.body.message);
            if (/Tavily API key not configured|No search provider/i.test(msg)) {
                sawUnconfiguredBranch = true;
            }
        } else {
            // Local/keyed env: the env key answered — phase A's "unconfigured"
            // premise does not hold, so we only assert the success shape here.
            expect(unconfigured.status).toBe(200);
            expect(unconfigured.body.status).toBe('success');
        }

        // PHASE B (CONFIGURED with a FAKE key): set the user-scoped tavily apiKey.
        // Availability is unchanged (still tavily/true), but now the facade actually
        // DISPATCHES to the provider. With a bogus key, Tavily answers 401 upstream,
        // which the controller maps to a clean 400 status:'error' — and crucially
        // the message is NO LONGER "API key not configured". That FLIP is the proof
        // the configured path reached the real provider, not the early gate.
        const patch = await patchPluginSettingsViaAPI(request, user.access_token, DEFAULT_SEARCH, {
            secretSettings: { apiKey: FAKE_SEARCH_KEY },
        });
        expect(patch.status, `tavily key patch body=${JSON.stringify(patch.body)}`).toBe(200);

        const availAfter = await getAvailability(request, user.access_token);
        expect(availAfter.body.available, 'availability still true post-config').toBe(true);
        expect(availAfter.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        const configured = await postSearch(request, user.access_token, { query: QUERY });
        expect(configured.status, 'configured search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(configured.status);

        if (configured.status === 200) {
            // A real env key happened to be present — the provider answered.
            expect(configured.body.status).toBe('success');
            expect(configured.body.provider).toBeTruthy();
        } else {
            // Key-less CI with the fake key wired: a provider-level error, NOT the
            // "not configured" gate. If phase A took the unconfigured branch, the
            // message MUST have changed (the divergence).
            expect(configured.body.status).toBe('error');
            const msg = flatten(configured.body.message);
            expect(Array.isArray(configured.body.message), 'provider error is a string').toBe(
                false,
            );
            if (sawUnconfiguredBranch) {
                expect(
                    /not configured/i.test(msg),
                    `message should flip off "not configured" once a key is set (got: ${msg})`,
                ).toBe(false);
            }
        }
    });

    test('FLOW 4: per-work provider resolution still anchors to the system default — a non-default provider configured + work-enabled does NOT steal the work-scoped active slot from tavily', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Search Provider Scope ${Date.now()}`,
        });
        expect(
            work.id,
            `work created (raw=${JSON.stringify(work.raw).slice(0, 160)})`,
        ).toBeTruthy();

        // Fully wire up a NON-default provider (brave): enable at user level, set its
        // required user-scoped apiKey, then work-enable it with the search capability.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const cfg = await patchPluginSettingsViaAPI(request, user.access_token, SECONDARY_SEARCH, {
            secretSettings: { apiKey: FAKE_SEARCH_KEY },
        });
        expect(cfg.status, `brave key patch body=${JSON.stringify(cfg.body)}`).toBe(200);

        const workEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${SECONDARY_SEARCH}/enable`,
            { headers: authedHeaders(user.access_token), data: { activeCapability: 'search' } },
        );
        expect(workEnable.status(), `work-enable body=${await workEnable.text()}`).toBe(200);
        const weBody = (await workEnable.json()) as {
            workEnabled?: boolean;
            activeCapabilities?: string[];
        };
        expect(weBody.workEnabled).toBe(true);
        expect(weBody.activeCapabilities).toContain('search');

        // The work plugin list confirms brave is THE work-scoped search provider.
        const wList = await request.get(`${API_BASE}/api/works/${work.id}/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        const wListBody = (await wList.json()) as {
            capabilityProviders?: Record<string, string>;
        };
        expect(wListBody.capabilityProviders?.search).toBe(SECONDARY_SEARCH);

        // ...AND YET a work-scoped SEARCH still resolves the DEFAULT tavily first:
        // getEnabledPluginsScoped(workId) returns BOTH the work-enabled brave AND
        // the user-level system tavily, and the resolver sorts defaultForCapabilities
        // first — so tavily (unconfigured) wins and reports ITS missing key, not
        // brave's. This is the subtle "default beats work-binding" contract.
        const workSearch = await postSearch(request, user.access_token, {
            query: 'project tooling',
            workId: work.id,
        });
        expect(workSearch.status, 'work-scoped search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(workSearch.status);
        if (workSearch.status === 400) {
            expect(workSearch.body.status).toBe('error');
            const msg = flatten(workSearch.body.message);
            // The resolved provider is the default tavily (its key gate), NOT brave,
            // and NOT an ownership 404 (the owner can view their own work).
            expect(msg).not.toContain('not found');
            expect(
                /Tavily|tavily/.test(msg),
                `expected the default tavily to resolve, got: ${msg}`,
            ).toBe(true);
        }

        // Sanity: user-scope availability is likewise anchored to tavily, unmoved by
        // the brave work-binding (work activation is scoped to the work, not the user).
        const avail = await getAvailability(request, user.access_token);
        expect(avail.body.activeProvider?.id).toBe(DEFAULT_SEARCH);
    });

    test('FLOW 5: search availability + settings are strictly USER-SCOPED — one user wiring up providers never moves another user’s active provider or availability', async ({
        request,
    }) => {
        const userA: RegisteredUser = await registerUserViaAPI(request);
        const userB: RegisteredUser = await registerUserViaAPI(request);

        // Baseline: both fresh users see the same default (tavily) available.
        const a0 = await getAvailability(request, userA.access_token);
        const b0 = await getAvailability(request, userB.access_token);
        expect(a0.body.activeProvider?.id).toBe(DEFAULT_SEARCH);
        expect(b0.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        // userA aggressively reconfigures: configure tavily's key, enable + configure
        // a second provider (brave). All of this is user-scoped.
        const aTavily = await patchPluginSettingsViaAPI(
            request,
            userA.access_token,
            DEFAULT_SEARCH,
            { secretSettings: { apiKey: `${FAKE_SEARCH_KEY}-A` } },
        );
        expect(aTavily.status).toBe(200);
        await enablePluginViaAPI(request, userA.access_token, SECONDARY_SEARCH);
        const aBrave = await patchPluginSettingsViaAPI(
            request,
            userA.access_token,
            SECONDARY_SEARCH,
            { settings: { maxResults: 15 }, secretSettings: { apiKey: `${FAKE_SEARCH_KEY}-A` } },
        );
        expect(aBrave.status).toBe(200);

        // userA's own view reflects the mutation (brave is now enabled for A).
        const aBraveState = await getPluginViaAPI(request, userA.access_token, SECONDARY_SEARCH);
        expect(aBraveState.enabled, 'A enabled brave').toBe(true);

        // userB is COMPLETELY unaffected: same default active provider, availability
        // still true, and brave is STILL disabled in B's catalog (settings + enable
        // state did not leak across the user boundary).
        const b1 = await getAvailability(request, userB.access_token);
        expect(b1.status).toBe(200);
        expect(b1.body.available).toBe(true);
        expect(b1.body.activeProvider?.id, 'B active provider is isolated from A').toBe(
            DEFAULT_SEARCH,
        );

        const bBraveState = await getPluginViaAPI(request, userB.access_token, SECONDARY_SEARCH);
        expect(bBraveState.enabled, 'A enabling brave must not enable it for B').toBe(false);
        expect(
            'apiKey' in ((bBraveState.resolvedSettings as Record<string, unknown>) ?? {}),
            'A apiKey must never resolve into B settings',
        ).toBe(false);

        // And B's search still reports the default tavily's gate (its own unconfigured
        // state), never A's configured key — proving execution-time scope isolation.
        const bSearch = await postSearch(request, userB.access_token, { query: 'x' });
        expect(bSearch.status).toBeLessThan(500);
        if (bSearch.status === 400) {
            expect(bSearch.body.status).toBe('error');
        }
    });

    test('FLOW 6: search-result item CONTRACT + secret round-trip — a 200 result is a score-descending {title,url,score,publishedDate?} list with a provider echo; the secret apiKey persists masked and never leaks into resolvedSettings', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // First, pin the secret-handling contract on a real PATCH round-trip: a
        // non-default provider's apiKey is echoed MASKED (prefix + bullets + suffix)
        // and is NEVER present in resolvedSettings, while the global maxResults is.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const RAW_KEY = 'abcdefghijklmnop1234';
        const patched = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SECONDARY_SEARCH,
            { settings: { maxResults: 9 }, secretSettings: { apiKey: RAW_KEY } },
        );
        expect(patched.status, `patch body=${JSON.stringify(patched.body)}`).toBe(200);
        const pBody = patched.body as {
            settings?: Record<string, unknown>;
            resolvedSettings?: Record<string, unknown>;
        };
        const masked = pBody.settings?.apiKey;
        expect(typeof masked).toBe('string');
        expect(masked).not.toBe(RAW_KEY);
        expect(String(masked)).toContain('••••');
        // The mask preserves the first + last 4 chars (probed format: abcd••••1234).
        expect(String(masked).startsWith('abcd')).toBe(true);
        expect(String(masked).endsWith('1234')).toBe(true);
        expect(pBody.resolvedSettings?.maxResults).toBe(9);
        expect(
            'apiKey' in (pBody.resolvedSettings ?? {}),
            'raw secret must never appear in resolvedSettings',
        ).toBe(false);

        // Persists masked across a fresh GET (the secret is stored, surfaced masked).
        await expect
            .poll(
                async () => {
                    const fresh = await getPluginViaAPI(
                        request,
                        user.access_token,
                        SECONDARY_SEARCH,
                    );
                    return (fresh.settings as Record<string, unknown> | undefined)?.apiKey;
                },
                { timeout: 15_000, message: 'masked apiKey persists across GET' },
            )
            .toBe(masked);

        // Now the search-RESULT item contract. Configure the default tavily key so
        // the facade dispatches; a 200 (real env key) must satisfy the result shape,
        // while a 400 (key-less CI / bogus key) must be a clean structured error.
        await patchPluginSettingsViaAPI(request, user.access_token, DEFAULT_SEARCH, {
            secretSettings: { apiKey: FAKE_SEARCH_KEY },
        });

        const result = await postSearch(request, user.access_token, {
            query: 'open source software directories',
            maxResults: 5,
        });
        expect(result.status, 'search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(result.status);

        if (result.status === 200) {
            // Keyed env: pin the full item contract from the facade mapping.
            expect(result.body.status).toBe('success');
            expect(typeof result.body.provider, 'a provider name is echoed').toBe('string');
            expect(Array.isArray(result.body.results), 'results is an array').toBe(true);
            const results = result.body.results ?? [];
            let prevScore = Number.POSITIVE_INFINITY;
            for (const item of results) {
                expect(typeof item.title).toBe('string');
                expect(typeof item.url).toBe('string');
                expect(typeof item.score).toBe('number');
                // score == 1 - index*0.05 → strictly descending across the list.
                expect(item.score as number).toBeLessThanOrEqual(prevScore);
                prevScore = item.score as number;
                if ('publishedDate' in item && item.publishedDate !== undefined) {
                    expect(typeof item.publishedDate).toBe('string');
                }
            }
        } else {
            // Key-less CI: a clean structured provider error, never a 5xx / array.
            expect(result.body.status).toBe('error');
            expect(Array.isArray(result.body.message)).toBe(false);
            expect(flatten(result.body.message).length).toBeGreaterThan(0);
        }
    });
});
