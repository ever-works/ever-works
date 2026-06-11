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
 * SEARCH providers — DEEP coverage of the `/api/search/*` capability facade +
 * the SearchController's OWN provider-resolution logic
 * (apps/api/src/plugins-capabilities/search/search.controller.ts), which is
 * distinct from (and layered above) the SearchFacadeService resolver
 * (packages/agent/src/facades/base.facade.ts).
 *
 * The controller's `resolveConfiguredProvider()` is the load-bearing, thinly
 * tested piece this file deepens: it enumerates getEnabledPluginsScoped(),
 * sorts `defaultForCapabilities`-first, then returns the FIRST plugin whose
 * required settings pass `hasAllRequiredSettings()` — a check that SKIPS any
 * required field carrying `x-envVar` (every search apiKey does). The resolved
 * id is then forced onto the facade as `providerOverride`. The net contract:
 *   • the system default `tavily` ALWAYS wins resolution (its required apiKey is
 *     env-skipped, so it passes the gate with no real key), even when a fully
 *     key-configured NON-default provider (brave) is enabled — at BOTH user
 *     scope and work scope, and even when brave is the work-ACTIVE binding.
 *   • availability ("any enabled search plugin") therefore stays true with no
 *     key, while an actual POST /api/search reports the resolved provider's gate
 *     — the availability-vs-usability divergence.
 *   • configured-vs-unconfigured DIVERGENCE: once tavily's user-scoped apiKey is
 *     set (even a FAKE one), the facade DISPATCHES to the real Tavily provider,
 *     and the error message FLIPS from the early "API key not configured" gate
 *     to the provider-level "Unauthorized: missing or invalid API key." (a 401
 *     upstream mapped to a clean 400) — never a 5xx, env-adaptive to a 200 when
 *     a real PLUGIN_TAVILY_API_KEY happens to be wired.
 *
 * DELIBERATELY DISTINCT from the sibling specs (NO duplication):
 *   - `flow-search-capability-contract.spec.ts` → spot-checks 5 of the family,
 *     the valid-full-body + malformed DTO matrix, the env-adaptive divergence
 *     (assert only that "not configured" disappears), the per-WORK default
 *     anchor, user-scope availability isolation, and the result-item shape. We
 *     do NOT re-run those; we go further: ALL 9 providers' apiKey contract, the
 *     per-provider maxResults bounds (brave 1..20 vs exa 1..100), the USER-scope
 *     (no-workId) default anchor, the EXACT flipped provider-error message, the
 *     per-USER execution-time key divergence, and empty-query / boundary edges.
 *   - `flow-plugin-search-lifecycle.spec.ts` → fresh availability + 2nd-provider
 *     priority, system-disable rejection, env-adaptive exec, the DTO matrix +
 *     auth, ownership 403/404, and the settings-validation x-envVar divergence.
 *     We do NOT re-assert ownership 403/404, system-disable, or settings PATCH
 *     bounds — we assert the availability-shape STABILITY across mutations and
 *     the controller-level resolution that those specs never isolate.
 *   - `flow-plugin-lifecycle-search.spec.ts` / `plugins-search.spec.ts` → enable
 *     lifecycle + shallow availability smoke.
 *
 * Every status / shape / message below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) before being asserted — never guessed.
 *
 * PROBED CONTRACTS:
 *   GET /api/plugins (category:'search') ships 9 providers: tavily, brave, exa,
 *     serpapi, perplexity, linkup, valyu, brightdata, firecrawl. EVERY one has
 *     required:['apiKey'] with apiKey:{ type:'string', secret:true,
 *     envVar:'PLUGIN_<X>_API_KEY', scope:'user' }. ONLY tavily is
 *     { systemPlugin:true, autoEnable:true, defaultForCapabilities:['search'] }.
 *     brave.maxResults:{ scope:'global', minimum:1, maximum:20, default:10 };
 *     exa.maxResults:{ scope:'global', minimum:1, maximum:100, default:10 }.
 *   GET /api/search/check-availability (Bearer): anon → 401; fresh/any user →
 *     200 { status:'success', available:true, activeProvider:{ id:'tavily',
 *     name:'Tavily' } } — STABLE across enabling/configuring other providers.
 *   POST /api/search { query, workId?, maxResults?(1..50), includeDomains?[],
 *     excludeDomains?[] } (Bearer; SearchDto whitelist+forbidNonWhitelisted):
 *     • anon → 401.
 *     • query:'' (empty string) PASSES the DTO (@IsString) → reaches the
 *       provider gate (env-adaptive 200/400), NOT a validation 400.
 *     • maxResults 50 → valid (provider gate); 51 → 400 ['...not greater than 50'];
 *       0/-5 → 400 ['...not less than 1']; '10' (string) → 400 with the 3-message
 *       not-greater/not-less/must-be-a-number bundle.
 *     • UNCONFIGURED default (tavily, no key) → 400 { status:'error',
 *       message:'Tavily API key not configured. Set it in plugin settings or via
 *       PLUGIN_TAVILY_API_KEY environment variable.' }.
 *     • CONFIGURED default (fake tavily key) → 400 { status:'error',
 *       message:'Unauthorized: missing or invalid API key.' } (401 upstream
 *       mapped) — the message FLIPS off "not configured". (Real key → 200.)
 *     • brave fully configured + tavily NOT → search STILL hits tavily's gate
 *       (default-first resolution), at user scope AND work scope (incl. brave
 *       work-active-bound). provider echo on 200 is the NAME (string).
 *
 * Cross-spec isolation: EVERY mutation runs on a FRESH registerUserViaAPI()
 * user (a user-scoped fake key would otherwise shadow env keys + redden sibling
 * chat/search specs). Unique works/keys derive from a PER-TEST counter (never a
 * module-scope clock). Presence asserted with toContain, never exact catalog
 * counts. No real LLM/search key required.
 */

const DEFAULT_SEARCH = 'tavily';
const SECONDARY_SEARCH = 'brave';
const TERTIARY_SEARCH = 'exa';

// The full search provider family that ships on develop (PROBED). Asserted with
// toContain (presence), never an exact set, to tolerate future additions.
const SEARCH_FAMILY = [
    'tavily',
    'brave',
    'exa',
    'serpapi',
    'perplexity',
    'linkup',
    'valyu',
    'brightdata',
    'firecrawl',
] as const;

// The exact provider-stage messages (PROBED). The FLIP between them is the proof
// the configured path reaches the real provider rather than the early gate.
const MSG_NOT_CONFIGURED = 'Tavily API key not configured';
const MSG_UPSTREAM_401 = 'Unauthorized: missing or invalid API key.';

// Per-test unique suffix WITHOUT a module-scope clock (module scope runs at
// collection on every shard). Each test passes its own seed.
let SUFFIX_COUNTER = 0;
function uniqueSuffix(): string {
    SUFFIX_COUNTER += 1;
    return `${SUFFIX_COUNTER}-${Math.random().toString(36).slice(2, 8)}`;
}

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
    token: string | null,
    data: Record<string, unknown>,
): Promise<{ status: number; body: SearchBody & Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/search`, {
        headers: token ? authedHeaders(token) : undefined,
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

/** A SchemaProp slice for settingsSchema introspection. */
type SchemaProp = Record<string, unknown>;
function schemaOf(plugin: Record<string, unknown>): {
    required?: string[];
    properties?: Record<string, SchemaProp>;
} {
    return (plugin.settingsSchema ?? {}) as {
        required?: string[];
        properties?: Record<string, SchemaProp>;
    };
}

test.describe('Search providers — deep facade + controller resolution', () => {
    test('FLOW 1: the FULL 9-provider family shares one apiKey contract (required, secret, PLUGIN_*_API_KEY env, user-scoped); only tavily is system+auto+default', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        const catalog = await listPluginsViaAPI(request, user.access_token);
        const searchIds = catalog.filter((p) => p.category === 'search').map((p) => p.id);
        for (const id of SEARCH_FAMILY) {
            expect(searchIds, `search family is missing "${id}"`).toContain(id);
        }

        // Walk EVERY family member (siblings only spot-check 5) and pin the shared
        // apiKey settingsSchema contract at the source.
        for (const id of SEARCH_FAMILY) {
            const plugin = await getPluginViaAPI(request, user.access_token, id);
            expect(plugin.category, `${id} is a search plugin`).toBe('search');
            expect(plugin.capabilities as string[], `${id} provides search`).toContain('search');

            const schema = schemaOf(plugin);
            expect(schema.required, `${id} requires apiKey`).toContain('apiKey');
            const apiKey = schema.properties?.apiKey ?? {};
            expect(apiKey.type, `${id} apiKey is a string`).toBe('string');
            expect(apiKey.secret, `${id} apiKey is a secret`).toBe(true);
            expect(apiKey.scope, `${id} apiKey is user-scoped`).toBe('user');
            expect(String(apiKey.envVar ?? ''), `${id} apiKey is env-overridable`).toMatch(
                /^PLUGIN_.+_API_KEY$/,
            );

            // Exactly tavily carries the system/auto/default triple; every other
            // family member is non-system, non-auto and starts disabled.
            if (id === DEFAULT_SEARCH) {
                expect(plugin.systemPlugin).toBe(true);
                expect(plugin.autoEnable).toBe(true);
                expect(plugin.enabled, 'tavily auto-enables for a fresh user').toBe(true);
                expect(plugin.defaultForCapabilities as string[]).toContain('search');
            } else {
                expect(plugin.systemPlugin, `${id} is not a system plugin`).not.toBe(true);
                expect(plugin.autoEnable, `${id} does not auto-enable`).not.toBe(true);
                expect(plugin.enabled, `${id} starts disabled`).toBe(false);
                expect(
                    (plugin.defaultForCapabilities as string[] | undefined) ?? [],
                    `${id} is not default-for-search`,
                ).not.toContain('search');
            }
        }
    });

    test('FLOW 2: per-provider maxResults schema bounds DIVERGE across the family — brave is global 1..20, exa is global 1..100 (distinct from the SearchDto @Max(50))', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        const brave = await getPluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const braveMax = schemaOf(brave).properties?.maxResults ?? {};
        expect(braveMax.scope).toBe('global');
        expect(braveMax.minimum).toBe(1);
        expect(braveMax.maximum).toBe(20);

        const exa = await getPluginViaAPI(request, user.access_token, TERTIARY_SEARCH);
        const exaMax = schemaOf(exa).properties?.maxResults ?? {};
        expect(exaMax.scope).toBe('global');
        expect(exaMax.minimum).toBe(1);
        // exa allows a strictly larger ceiling than brave — proving these are
        // per-provider knobs, not a shared constant.
        expect(exaMax.maximum).toBe(100);
        expect(exaMax.maximum as number).toBeGreaterThan(braveMax.maximum as number);
    });

    test('FLOW 3: check-availability is anon-guarded and returns a STABLE {status,available,activeProvider:tavily} that does NOT move when a second provider is enabled+configured', async ({
        request,
    }) => {
        // Anonymous read is rejected (raw fetch — no inherited cookies).
        const anon = await fetch(`${API_BASE}/api/search/check-availability`);
        expect(anon.status).toBe(401);

        const user: RegisteredUser = await registerUserViaAPI(request);

        const before = await getAvailability(request, user.access_token);
        expect(before.status).toBe(200);
        expect(before.body.status).toBe('success');
        expect(before.body.available).toBe(true);
        expect(before.body.activeProvider).toEqual({ id: 'tavily', name: 'Tavily' });

        // Enable + fully configure a NON-default provider. The activeProvider slot
        // must NOT move off tavily (defaultForCapabilities-first resolution), and
        // the body shape stays identical — availability is anchored to the default.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const cfg = await patchPluginSettingsViaAPI(request, user.access_token, SECONDARY_SEARCH, {
            secretSettings: { apiKey: `fake-brave-${uniqueSuffix()}` },
        });
        expect(cfg.status, `brave patch body=${JSON.stringify(cfg.body)}`).toBe(200);

        await expect
            .poll(
                async () =>
                    (await getAvailability(request, user.access_token)).body.activeProvider?.id,
                { timeout: 15_000, message: 'tavily keeps the active slot' },
            )
            .toBe(DEFAULT_SEARCH);

        const after = await getAvailability(request, user.access_token);
        expect(after.body.available).toBe(true);
        expect(after.body.activeProvider).toEqual({ id: 'tavily', name: 'Tavily' });
        // No message key on the available branch (message is only the no-provider tail).
        expect(after.body.message).toBeUndefined();
    });

    test('FLOW 4: USER-scope (no workId) default anchor — a fully key-configured non-default brave does NOT steal resolution from the unconfigured system default tavily; the search reports TAVILY’s gate', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Wire up brave with a real-looking key, leave tavily WITHOUT a key.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const cfg = await patchPluginSettingsViaAPI(request, user.access_token, SECONDARY_SEARCH, {
            secretSettings: { apiKey: `fake-brave-${uniqueSuffix()}` },
        });
        expect(cfg.status).toBe(200);

        // A plain (no-workId) search. The controller sorts defaultForCapabilities
        // first, so tavily resolves AHEAD of the configured brave — and since
        // tavily's apiKey is x-envVar (env-skipped in hasAllRequiredSettings) it
        // passes the gate and is forced as providerOverride. The facade then hits
        // the real tavily, which reports ITS missing key — NOT brave's.
        const res = await postSearch(request, user.access_token, { query: 'project tooling' });
        expect(res.status, 'search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
            expect(res.body.status).toBe('error');
            const msg = flatten(res.body.message);
            expect(Array.isArray(res.body.message), 'a provider error is a string').toBe(false);
            // The resolved provider is the default tavily (its gate), never brave.
            expect(msg).toContain(MSG_NOT_CONFIGURED);
            expect(msg.toLowerCase()).not.toContain('brave');
        } else {
            // Keyed env: a real key answered; the provider echo names the resolved
            // default, not the non-default brave.
            expect(res.body.status).toBe('success');
            expect(typeof res.body.provider).toBe('string');
        }
    });

    test('FLOW 5: configured-vs-unconfigured message FLIP — the SAME query on the SAME user moves from the exact "API key not configured" gate to the exact "Unauthorized: missing or invalid API key." provider error once a (fake) tavily key is set (env-adaptive, never 5xx)', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const QUERY = 'open source web directories';

        // PHASE A — UNCONFIGURED: the early gate fires with the exact message.
        const before = await postSearch(request, user.access_token, { query: QUERY });
        expect(before.status, 'unconfigured search must not 5xx').toBeLessThan(500);
        let sawGate = false;
        if (before.status === 400) {
            expect(before.body.status).toBe('error');
            const msg = flatten(before.body.message);
            if (msg.includes(MSG_NOT_CONFIGURED)) sawGate = true;
        } else {
            // A real env key is present — phase A's premise doesn't hold; assert success.
            expect(before.status).toBe(200);
            expect(before.body.status).toBe('success');
        }

        // PHASE B — CONFIGURED with a FAKE user-scoped tavily key: the facade now
        // DISPATCHES to the real provider. A bogus key → Tavily 401 upstream →
        // controller maps to 400 with the DISTINCT "Unauthorized..." message. The
        // FLIP off "not configured" proves the configured path reached the provider.
        const patch = await patchPluginSettingsViaAPI(request, user.access_token, DEFAULT_SEARCH, {
            secretSettings: { apiKey: `fake-tavily-${uniqueSuffix()}` },
        });
        expect(patch.status, `tavily patch body=${JSON.stringify(patch.body)}`).toBe(200);

        const after = await postSearch(request, user.access_token, { query: QUERY });
        expect(after.status, 'configured search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(after.status);
        if (after.status === 200) {
            // A real key happened to be wired — the provider answered.
            expect(after.body.status).toBe('success');
            expect(after.body.provider).toBeTruthy();
        } else {
            expect(after.body.status).toBe('error');
            const msg = flatten(after.body.message);
            expect(Array.isArray(after.body.message), 'provider error is a string').toBe(false);
            // The message must NO LONGER be the "not configured" gate...
            expect(msg).not.toContain(MSG_NOT_CONFIGURED);
            // ...and in key-less CI it is the specific upstream-401 mapping. (Guard
            // with sawGate so a fully-keyed env that 200'd in phase A can't fail here.)
            if (sawGate) {
                expect(msg).toBe(MSG_UPSTREAM_401);
            }
        }
    });

    test('FLOW 6: an EMPTY-STRING query passes the @IsString DTO and reaches provider resolution (the gate, not a validation 400) — the resolver, not the validator, owns empty queries', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        const res = await postSearch(request, user.access_token, { query: '' });
        expect(res.status, 'empty-query search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
            // It is the provider-stage error (string status:'error'), NOT a DTO
            // validation array — '' is a valid string, so it sails past @IsString.
            expect(res.body.status).toBe('error');
            expect(Array.isArray(res.body.message), 'not a class-validator array').toBe(false);
            expect(flatten(res.body.message)).toContain(MSG_NOT_CONFIGURED);
        } else {
            expect(res.body.status).toBe('success');
        }
    });

    test('FLOW 7: maxResults boundary contract — 50 is the inclusive ceiling (passes to the provider gate), 51 / 0 / -5 carry their exact @Max/@Min messages, and a string is the 3-message not-a-number bundle', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // 50 is INSIDE the @Max(50) bound → reaches the provider (env-adaptive),
        // proving maxResults is not the rejection reason at the ceiling.
        const atCeiling = await postSearch(request, user.access_token, {
            query: 'directories',
            maxResults: 50,
        });
        expect([200, 400]).toContain(atCeiling.status);
        if (atCeiling.status === 400) {
            expect(atCeiling.body.status).toBe('error');
            expect(Array.isArray(atCeiling.body.message), 'provider 400, not a DTO array').toBe(
                false,
            );
        }

        // 51 is one past the ceiling → exact @Max message.
        const over = await postSearch(request, user.access_token, {
            query: 'q',
            maxResults: 51,
        });
        expect(over.status).toBe(400);
        expect(flatten(over.body.message)).toContain('maxResults must not be greater than 50');

        // 0 and -5 are below @Min(1) → exact @Min message.
        for (const n of [0, -5]) {
            const under = await postSearch(request, user.access_token, {
                query: 'q',
                maxResults: n,
            });
            expect(under.status, `maxResults:${n} → 400`).toBe(400);
            expect(flatten(under.body.message)).toContain('maxResults must not be less than 1');
        }

        // A string carries the full 3-message bundle (the transform yields NaN,
        // tripping not-greater, not-less AND must-be-a-number — PROBED).
        const asString = await postSearch(request, user.access_token, {
            query: 'q',
            maxResults: '10',
        });
        expect(asString.status).toBe(400);
        const msg = flatten(asString.body.message);
        expect(msg).toContain('maxResults must not be greater than 50');
        expect(msg).toContain('maxResults must not be less than 1');
        expect(msg).toMatch(/maxResults must be a number conforming/i);

        // Every malformed maxResults is a clean 4xx — never a 5xx.
        for (const r of [over, asString]) {
            expect(r.status).toBeGreaterThanOrEqual(400);
            expect(r.status).toBeLessThan(500);
        }
    });

    test('FLOW 8: per-USER execution-time key isolation — userA configuring a (fake) tavily key flips ONLY A’s search to the provider-error branch; a fresh userB still hits the unconfigured gate (keys never leak across the user boundary at search time)', async ({
        request,
    }) => {
        const userA: RegisteredUser = await registerUserViaAPI(request);
        const userB: RegisteredUser = await registerUserViaAPI(request);
        const QUERY = 'directories';

        // Baseline: both fresh users hit the SAME unconfigured tavily gate.
        const a0 = await postSearch(request, userA.access_token, { query: QUERY });
        const b0 = await postSearch(request, userB.access_token, { query: QUERY });
        expect(a0.status).toBeLessThan(500);
        expect(b0.status).toBeLessThan(500);

        // userA sets a FAKE user-scoped tavily key.
        const patch = await patchPluginSettingsViaAPI(request, userA.access_token, DEFAULT_SEARCH, {
            secretSettings: { apiKey: `fake-tavily-A-${uniqueSuffix()}` },
        });
        expect(patch.status).toBe(200);

        const aAfter = await postSearch(request, userA.access_token, { query: QUERY });
        const bAfter = await postSearch(request, userB.access_token, { query: QUERY });
        expect(aAfter.status).toBeLessThan(500);
        expect(bAfter.status).toBeLessThan(500);

        // In key-less CI the divergence is observable: A flipped to the provider
        // error, B is unchanged on the gate. (In a fully-keyed env both 200 — then
        // both branches below are skipped and the test still proves no 5xx.)
        if (a0.status === 400 && a0.body.status === 'error') {
            const a0msg = flatten(a0.body.message);
            // A started on the gate; after configuring, A must have moved OFF it.
            if (a0msg.includes(MSG_NOT_CONFIGURED) && aAfter.status === 400) {
                expect(flatten(aAfter.body.message)).not.toContain(MSG_NOT_CONFIGURED);
            }
        }
        if (bAfter.status === 400) {
            // B never configured a key → B is STILL on the unconfigured gate, proving
            // A's user-scoped key never resolved into B's execution context.
            expect(bAfter.body.status).toBe('error');
            expect(flatten(bAfter.body.message)).toContain(MSG_NOT_CONFIGURED);
        }
    });

    test('FLOW 9: WORK-scoped resolution still anchors to the default even when a non-default is the work-ACTIVE binding — work-enabling+activating brave on an owned work does not move the work search off tavily’s gate', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Deep Search Work ${uniqueSuffix()}`,
        });
        expect(
            work.id,
            `work created (raw=${JSON.stringify(work.raw).slice(0, 160)})`,
        ).toBeTruthy();

        // Fully wire brave: user-enable, key it, then make it the work-ACTIVE search
        // provider. This is the strongest case for brave to "win" — yet it doesn't.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const cfg = await patchPluginSettingsViaAPI(request, user.access_token, SECONDARY_SEARCH, {
            secretSettings: { apiKey: `fake-brave-${uniqueSuffix()}` },
        });
        expect(cfg.status).toBe(200);

        const workEnable = await request.post(
            `${API_BASE}/api/works/${work.id}/plugins/${SECONDARY_SEARCH}/enable`,
            { headers: authedHeaders(user.access_token), data: { activeCapability: 'search' } },
        );
        expect(workEnable.status(), `work-enable body=${await workEnable.text()}`).toBe(200);
        const weBody = (await workEnable.json()) as { activeCapabilities?: string[] };
        expect(weBody.activeCapabilities).toContain('search');

        // The work plugin list confirms brave IS the work-active search binding...
        const wList = await request.get(`${API_BASE}/api/works/${work.id}/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        const wlBody = (await wList.json()) as { capabilityProviders?: Record<string, string> };
        expect(wlBody.capabilityProviders?.search).toBe(SECONDARY_SEARCH);

        // ...and YET the controller's resolveConfiguredProvider() (which ignores the
        // work-active binding and sorts defaultForCapabilities-first) still resolves
        // tavily → the work-scoped search reports TAVILY's gate, not brave's.
        const res = await postSearch(request, user.access_token, {
            query: 'project tooling',
            workId: work.id,
        });
        expect(res.status, 'work-scoped search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
            expect(res.body.status).toBe('error');
            const msg = flatten(res.body.message);
            // Owner CAN view their own work → not an ownership 404/403.
            expect(msg).not.toContain('not found');
            expect(msg).not.toContain('permission');
            // The resolved provider is the default tavily.
            expect(msg).toContain(MSG_NOT_CONFIGURED);
        }
    });

    test('FLOW 10: a fully-populated VALID body (maxResults + both domain filters) is accepted by the DTO and reaches provider resolution; the 200 path echoes a provider NAME and a {title,url,score↓} item list, the 400 path is a clean structured error', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Configure tavily so the facade dispatches; the body exercises EVERY
        // optional DTO field at once (distinct from the sibling's bare bodies).
        const patch = await patchPluginSettingsViaAPI(request, user.access_token, DEFAULT_SEARCH, {
            secretSettings: { apiKey: `fake-tavily-${uniqueSuffix()}` },
        });
        expect(patch.status).toBe(200);

        const res = await postSearch(request, user.access_token, {
            query: 'open source software directories',
            maxResults: 5,
            includeDomains: ['github.com', 'stackoverflow.com'],
            excludeDomains: ['pinterest.com'],
        });
        expect(res.status, 'valid full body must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(res.status);

        if (res.status === 200) {
            // Pin the result-item contract from the facade mapping: score == 1 -
            // index*0.05 → strictly non-increasing; provider echo is the NAME string.
            expect(res.body.status).toBe('success');
            expect(typeof res.body.provider, 'provider name echoed').toBe('string');
            expect(Array.isArray(res.body.results)).toBe(true);
            let prev = Number.POSITIVE_INFINITY;
            for (const item of res.body.results ?? []) {
                expect(typeof item.title).toBe('string');
                expect(typeof item.url).toBe('string');
                expect(typeof item.score).toBe('number');
                expect(item.score as number).toBeLessThanOrEqual(prev);
                prev = item.score as number;
                if (item.publishedDate !== undefined) {
                    expect(typeof item.publishedDate).toBe('string');
                }
            }
        } else {
            // The valid body is NOT a validation 400 (which would be an array); it's
            // the provider-stage error string.
            expect(res.body.status).toBe('error');
            expect(Array.isArray(res.body.message), 'provider 400, not a DTO array').toBe(false);
            expect(flatten(res.body.message).length).toBeGreaterThan(0);
        }
    });

    test('FLOW 11: the DTO whitelist forbids unknown props OUTRIGHT even alongside a fully-valid envelope — a bogus key never silently strips, it 400s with "property bogus should not exist"', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // A body that would otherwise be perfectly valid, plus one stray prop.
        const res = await postSearch(request, user.access_token, {
            query: 'directories',
            maxResults: 5,
            includeDomains: ['github.com'],
            bogus: 'x',
        });
        expect(res.status).toBe(400);
        expect(flatten(res.body.message)).toContain('property bogus should not exist');
        // forbidNonWhitelisted means it never reaches the provider — a pure 4xx.
        expect(res.status).toBeLessThan(500);
    });

    test('FLOW 12: a non-default provider secret round-trips MASKED (first4 + bullets + last4) and never appears in resolvedSettings, while its global maxResults does — proving secret/non-secret split on a SEARCH provider', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Use exa (sibling specs mask via brave — distinct provider here) with a key
        // shaped so the first/last 4 chars are easy to assert.
        await enablePluginViaAPI(request, user.access_token, TERTIARY_SEARCH);
        const RAW_KEY = 'abcd1234567890wxyz';
        const patched = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            TERTIARY_SEARCH,
            {
                settings: { maxResults: 7 },
                secretSettings: { apiKey: RAW_KEY },
            },
        );
        expect(patched.status, `exa patch body=${JSON.stringify(patched.body)}`).toBe(200);
        const pBody = patched.body as {
            settings?: Record<string, unknown>;
            resolvedSettings?: Record<string, unknown>;
        };

        const masked = pBody.settings?.apiKey;
        expect(typeof masked).toBe('string');
        expect(masked).not.toBe(RAW_KEY);
        expect(String(masked)).toContain('••••');
        // The mask preserves the first + last 4 chars (PROBED format: abcd••••wxyz).
        expect(String(masked).startsWith('abcd')).toBe(true);
        expect(String(masked).endsWith('wxyz')).toBe(true);
        // The non-secret global maxResults round-trips; the raw secret NEVER does.
        expect(pBody.resolvedSettings?.maxResults).toBe(7);
        expect('apiKey' in (pBody.resolvedSettings ?? {}), 'raw secret stays out of resolved').toBe(
            false,
        );

        // The mask persists across a fresh GET (the secret is stored, surfaced masked).
        await expect
            .poll(
                async () => {
                    const fresh = await getPluginViaAPI(
                        request,
                        user.access_token,
                        TERTIARY_SEARCH,
                    );
                    return (fresh.settings as Record<string, unknown> | undefined)?.apiKey;
                },
                { timeout: 15_000, message: 'masked exa apiKey persists across GET' },
            )
            .toBe(masked);
    });

    test('FLOW 13: POST /api/search is auth-guarded for anonymous callers (raw fetch — no inherited storage state) and rejects with 401 before any DTO validation runs', async ({
        request,
    }) => {
        // Even a body that would FAIL DTO validation (empty object → missing query)
        // is rejected for AUTH first — the guard runs ahead of the ValidationPipe.
        const anon = await fetch(`${API_BASE}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(anon.status).toBe(401);
        const anonBody = (await anon.json().catch(() => ({}))) as { message?: string };
        expect(anonBody.message).toBe('Unauthorized');

        // Sanity: with a valid token the same empty body now reaches the validator
        // and 400s on the missing query (NOT 401) — confirming the 401 above was the
        // guard, not the validator.
        const user: RegisteredUser = await registerUserViaAPI(request);
        const authed = await postSearch(request, user.access_token, {});
        expect(authed.status).toBe(400);
        expect(flatten(authed.body.message)).toContain('query must be a string');
    });

    test('FLOW 14: enabling a non-default provider WITHOUT configuring its key leaves availability anchored to tavily AND search still resolves tavily — adding an unconfigured provider can never displace the system default', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Enable serpapi but DO NOT set its apiKey. serpapi's required apiKey is
        // x-envVar → env-skipped, so it would "pass" hasAllRequiredSettings too —
        // but it sorts AFTER the defaultForCapabilities tavily, so tavily still wins.
        const enabled = await enablePluginViaAPI(request, user.access_token, 'serpapi');
        expect(enabled.enabled).toBe(true);

        // Availability is unchanged: still the tavily default, still available.
        const avail = await getAvailability(request, user.access_token);
        expect(avail.body.available).toBe(true);
        expect(avail.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        // And an actual search resolves tavily (its gate), NOT serpapi — the default
        // beats a later-sorted, also-env-skipped provider.
        const res = await postSearch(request, user.access_token, { query: 'q' });
        expect(res.status, 'search must not 5xx').toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
            expect(res.body.status).toBe('error');
            const msg = flatten(res.body.message);
            expect(msg).toContain(MSG_NOT_CONFIGURED);
            expect(msg.toLowerCase()).not.toContain('serpapi');
        }
    });
});
