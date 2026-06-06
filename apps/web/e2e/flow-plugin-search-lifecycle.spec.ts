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
    disablePluginViaAPI,
    patchPluginSettingsViaAPI,
} from './helpers/plugins';

/**
 * SEARCH plugin lifecycle + the `/api/search/*` capability facade — complex,
 * multi-step INTEGRATION flows. Themed around the search-provider family
 * (tavily default + brave / exa / serpapi / linkup / perplexity / valyu / …),
 * this file pins behaviours that the existing specs do NOT cover:
 *   - `flow-plugin-lifecycle-search.spec.ts` → brave user/work enable + settings
 *     masking + work-capability binding (NOT the /api/search facade, NOT the
 *     default-provider priority, NOT availability transitions).
 *   - `plugins-search.spec.ts` → shallow check-availability boolean-shape + 401
 *     smoke (NOT the rich {status,available,activeProvider,message} contract, NOT
 *     the validation matrix, NOT ownership, NOT the env-skip divergence).
 *
 * Every status/shape/message below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-06-01 before being asserted — never guessed.
 *
 * PROBED CONTRACTS (search facade — apps/api/src/plugins-capabilities/search):
 *   GET /api/search/check-availability  (Bearer; AuthSessionGuard)
 *     • no auth → 401 { message:'Unauthorized', statusCode:401 }.
 *     • fresh user → 200 { status:'success', available:true,
 *       activeProvider:{ id:'tavily', name:'Tavily' } } — tavily is auto-enabled
 *       (autoEnable:true, systemPlugin:true, defaultForCapabilities:['search']),
 *       so a brand-new user already has an "available" search provider.
 *     • The resolver `hasAllRequiredSettings()` SKIPS required fields that carry
 *       `x-envVar` (apiKey on every search plugin does). So availability is
 *       effectively "is any search plugin ENABLED" — it stays true even with no
 *       real API key configured (the KEY-less / unconfigured contract).
 *     • Provider selection sorts `defaultForCapabilities` first: with tavily
 *       (default) enabled, enabling brave too keeps tavily the activeProvider.
 *     • The no-provider message branch reads (source):
 *         enabled>0 → 'Search plugins are enabled but none have all required
 *                      settings configured (e.g. API key).'
 *         enabled=0 → 'No search provider is enabled. Enable a search plugin
 *                      (e.g. Tavily, Linkup, Brave, Exa) in settings.'
 *       (In CI tavily can't be disabled — see below — so available rarely flips
 *        false; we assert the reachable side and the message contract by source.)
 *
 *   POST /api/search  { query, workId?, maxResults?(1..50), includeDomains?[],
 *                       excludeDomains?[] }  (Bearer; SearchDto)
 *     • no auth → 401.
 *     • body {} → 400 { message:['query must be a string'], error:'Bad Request' }.
 *     • { query:'x', workId:'not-a-uuid' } → 400 ['workId must be a UUID'].
 *     • { query:'x', maxResults:999 } → 400 ['maxResults must not be greater than 50'].
 *     • { query:'x', includeDomains:'github.com' } → 400 (array-of-string DTO).
 *     • valid body, tavily resolved, NO PLUGIN_TAVILY_API_KEY (CI) → 400
 *       { status:'error', message:'Tavily API key not configured. Set it in
 *         plugin settings or via PLUGIN_TAVILY_API_KEY environment variable.' }.
 *       With the env key wired (local) → 200 { status:'success', results, provider }.
 *       ENV-ADAPTIVE: assert 200-with-results OR a clean 400 status:error (never 5xx).
 *     • { query, workId:<OWN work> } → ownership.ensureCanView passes, then
 *       provider resolution (same env-adaptive 200/400 as above).
 *     • { query, workId:<valid uuid, EXISTS but NOT owned> } → 403
 *       { status:'error', message:'You do not have permission to access this work' }
 *       — ownership fires BEFORE provider resolution; the work resolves so it's a
 *       membership (Forbidden) denial, not a missing-work (404) one.
 *     • { query, workId:<valid uuid, does NOT exist> } → 404
 *       { status:'error', message:"Work with id '<id>' not found" }.
 *
 *   Search-provider SETTINGS validation (PATCH /api/plugins/:id/settings) —
 *   DIVERGES from the availability resolver on x-envVar:
 *     • PATCH brave|exa { settings:{ maxResults } } missing required apiKey → 400
 *       { message:'Invalid plugin settings', errors:['Missing required fields: apiKey'] }
 *       (the settings validator does NOT skip x-envVar, unlike availability).
 *     • brave maxResults schema bound is 1..20:
 *         maxResults:999 → 400 errors:['/maxResults: must be <= 20 (maximum value 20)']
 *         maxResults:0   → 400 errors:['/maxResults: must be >= 1 (minimum value 1)']
 *     • PATCH brave { settings:{ maxResults }, secretSettings:{ apiKey } } → 200;
 *       resolvedSettings.maxResults round-trips; apiKey echoed MASKED in `settings`
 *       (prefix + '••••' + last 4) and NEVER in resolvedSettings.
 *     • tavily is a system plugin: POST /api/plugins/tavily/disable → 400
 *       { message:'Plugin "tavily" is a system plugin and cannot be disabled' }.
 *       Non-default search plugins (brave) disable idempotently → 200.
 *
 * Cross-spec isolation: every MUTATION runs on a FRESH registerUserViaAPI() user
 * (a user-scoped fake search key would otherwise shadow env keys + break sibling
 * chat/search specs). Unique works use Date.now() suffixes; we assert toContain /
 * presence, never exact catalog counts. No reliance on a real LLM/search key.
 */

// tavily: system + auto-enabled + defaultForCapabilities:['search'].
const DEFAULT_SEARCH = 'tavily';
// brave / exa: non-system, non-auto, ship a { apiKey(user,secret,x-envVar),
// maxResults(global,1..20) } schema — used for settings-validation flows.
const SECONDARY_SEARCH = 'brave';
const TERTIARY_SEARCH = 'exa';

const FAKE_SEARCH_KEY = 'e2e-fake-search-key-1234567890';

interface AvailabilityBody {
    status?: string;
    available?: boolean;
    activeProvider?: { id?: string; name?: string } | null;
    message?: string;
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
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/search`, {
        headers: token ? authedHeaders(token) : undefined,
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/** A SearchDto-valid body that still 400s in CI (tavily, no env key). */
function flatten(msg: unknown): string {
    return Array.isArray(msg) ? msg.join(' | ') : String(msg);
}

test.describe('Search plugin lifecycle + /api/search capability facade', () => {
    test('FLOW 1: fresh-user availability — default tavily wins; enabling a second provider keeps the default; env-skip keeps available:true without a key', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // The catalog carries a family of search providers; tavily is the default.
        const catalog = await listPluginsViaAPI(request, user.access_token);
        const searchPlugins = catalog.filter((p) => p.category === 'search');
        expect(
            searchPlugins.length,
            'multiple search providers ship in the catalog',
        ).toBeGreaterThan(2);
        const ids = searchPlugins.map((p) => p.id);
        expect(ids).toContain(DEFAULT_SEARCH);
        expect(ids).toContain(SECONDARY_SEARCH);

        // tavily is the auto-enabled system default-for-search.
        const tavily = await getPluginViaAPI(request, user.access_token, DEFAULT_SEARCH);
        expect(tavily.enabled, 'tavily is auto-enabled for a fresh user').toBe(true);
        expect(tavily.systemPlugin).toBe(true);
        expect(tavily.defaultForCapabilities).toContain('search');

        // Fresh-user availability: the FULL contract, not just a boolean. NB the key
        // is NOT configured (apiKey is x-envVar → skipped by the availability
        // resolver) yet availability is still TRUE: enabled-ness alone qualifies.
        const fresh = await getAvailability(request, user.access_token);
        expect(fresh.status).toBe(200);
        expect(fresh.body.status).toBe('success');
        expect(fresh.body.available, 'auto-enabled default => available').toBe(true);
        expect(fresh.body.activeProvider?.id).toBe(DEFAULT_SEARCH);
        expect(fresh.body.activeProvider?.name).toBe('Tavily');

        // Enable a SECOND, non-default search provider (brave). The resolver sorts
        // defaultForCapabilities first, so tavily must REMAIN the activeProvider —
        // adding another enabled provider does not steal the default slot.
        const braveBefore = await getPluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        expect(braveBefore.enabled, 'brave starts disabled').toBe(false);
        const enabled = await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        expect(enabled.enabled).toBe(true);
        expect(enabled.installed).toBe(true);

        await expect
            .poll(
                async () =>
                    (await getAvailability(request, user.access_token)).body.activeProvider?.id,
                {
                    timeout: 15_000,
                    message: 'default tavily keeps the active slot even with brave enabled',
                },
            )
            .toBe(DEFAULT_SEARCH);

        const withTwo = await getAvailability(request, user.access_token);
        expect(withTwo.body.available).toBe(true);
        expect(withTwo.body.activeProvider?.id).toBe(DEFAULT_SEARCH);
    });

    test('FLOW 2: system-default tavily cannot be disabled; non-default providers disable idempotently; availability stays anchored to the default', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // tavily is a SYSTEM plugin — disable is rejected, not silently ignored.
        const disableRes = await request.post(`${API_BASE}/api/plugins/${DEFAULT_SEARCH}/disable`, {
            headers: authedHeaders(user.access_token),
        });
        expect(disableRes.status(), 'system plugin disable is a 400').toBe(400);
        const disableBody = (await disableRes.json().catch(() => ({}))) as { message?: string };
        expect(disableBody.message).toContain('system plugin');
        expect(disableBody.message).toContain('cannot be disabled');

        // tavily survives the rejected disable: still enabled + the active provider.
        const stillOn = await getPluginViaAPI(request, user.access_token, DEFAULT_SEARCH);
        expect(stillOn.enabled, 'tavily stays enabled after a rejected disable').toBe(true);
        const avail = await getAvailability(request, user.access_token);
        expect(avail.body.available).toBe(true);
        expect(avail.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        // A NON-default provider (brave): enabling then disabling is idempotent and
        // must NOT disturb the default — availability stays anchored to tavily.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        const off1 = await disablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        expect(off1.enabled).toBe(false);
        // installed survives a disable (the install record is kept).
        expect(off1.installed).toBe(true);
        // Disabling an already-disabled, non-default plugin is idempotent → 200.
        const off2 = await disablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        expect(off2.enabled).toBe(false);

        const afterToggles = await getAvailability(request, user.access_token);
        expect(afterToggles.body.available, 'default keeps search available').toBe(true);
        expect(afterToggles.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        // Contract guard on the "unavailable" message branch: even though CI can't
        // reach available:false (tavily is undisableable), the body must always be
        // well-formed and, IF a message is present, it must be one of the two known
        // human-readable strings — never a leaked stack/null.
        if (afterToggles.body.message) {
            expect(
                /no all required settings configured|none have all required settings|No search provider is enabled/i.test(
                    afterToggles.body.message,
                ),
                `unexpected availability message: ${afterToggles.body.message}`,
            ).toBe(true);
        }
    });

    test('FLOW 3: search execution is environment-adaptive — resolves the default provider, then 200-with-results (keyed) OR a clean 400 status:error (key-less CI), never 5xx', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Availability says "available" (env-skip), but ACTUAL search needs a real
        // key — this is the configured-by-availability vs actually-usable DIVERGENCE.
        const avail = await getAvailability(request, user.access_token);
        expect(avail.body.available, 'availability resolver reports available (env-skip)').toBe(
            true,
        );

        const result = await postSearch(request, user.access_token, {
            query: 'open source software directories',
        });

        // NEVER a server crash — the controller maps facade failures to 400.
        expect(result.status, `search must not 5xx (got ${result.status})`).toBeLessThan(500);
        expect([200, 400]).toContain(result.status);

        if (result.status === 200) {
            // Local / keyed: real provider answered.
            expect(result.body.status).toBe('success');
            expect(result.body.provider, 'a provider name is echoed').toBeTruthy();
            expect('results' in result.body, 'a results payload is present').toBe(true);
        } else {
            // CI / key-less: clean structured 400, tavily (the resolved default)
            // reports its missing key — proving resolution reached the provider.
            expect(result.body.status).toBe('error');
            const msg = flatten(result.body.message);
            expect(
                /Tavily API key not configured|No search provider/i.test(msg),
                `unexpected key-less search message: ${msg}`,
            ).toBe(true);
        }

        // A search with explicit maxResults inside the 1..50 bound is accepted by
        // the DTO and resolves the same way (still env-adaptive 200/400, not a
        // validation 400 — confirming maxResults is not the rejection reason).
        const bounded = await postSearch(request, user.access_token, {
            query: 'directories',
            maxResults: 5,
        });
        expect([200, 400]).toContain(bounded.status);
        if (bounded.status === 400) {
            expect(bounded.body.status).toBe('error');
            // A DTO-validation 400 would carry an array message; the provider 400
            // carries a string status:'error' object — ensure it's the provider one.
            expect(Array.isArray(bounded.body.message)).toBe(false);
        }
    });

    test('FLOW 4: search DTO validation matrix + auth — every malformed request is a 4xx with the exact class-validator message; both endpoints are guarded', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // AUTH: both the read (availability) and write (search) endpoints are guarded.
        const anonAvail = await request.get(`${API_BASE}/api/search/check-availability`);
        expect(anonAvail.status()).toBe(401);
        const anonSearch = await postSearch(request, null, { query: 'x' });
        expect(anonSearch.status).toBe(401);

        // (a) empty body → missing `query` (the only required field).
        const empty = await postSearch(request, user.access_token, {});
        expect(empty.status).toBe(400);
        expect(flatten(empty.body.message)).toContain('query must be a string');

        // (b) non-uuid workId → @IsUUID rejection.
        const badWork = await postSearch(request, user.access_token, {
            query: 'x',
            workId: 'not-a-uuid',
        });
        expect(badWork.status).toBe(400);
        expect(flatten(badWork.body.message)).toContain('workId must be a UUID');

        // (c) maxResults above the @Max(50) bound.
        const tooMany = await postSearch(request, user.access_token, {
            query: 'x',
            maxResults: 999,
        });
        expect(tooMany.status).toBe(400);
        expect(flatten(tooMany.body.message)).toContain('maxResults must not be greater than 50');

        // (d) maxResults below the @Min(1) bound.
        const tooFew = await postSearch(request, user.access_token, {
            query: 'x',
            maxResults: 0,
        });
        expect(tooFew.status).toBe(400);
        expect(flatten(tooFew.body.message)).toMatch(/maxResults must not be less than 1/i);

        // (e) includeDomains must be an array of strings, not a bare string.
        const badDomains = await postSearch(request, user.access_token, {
            query: 'x',
            includeDomains: 'github.com',
        });
        expect(badDomains.status).toBe(400);
        expect(flatten(badDomains.body.message)).toMatch(/includeDomains/i);

        // All validation failures are clean 4xx — never a 5xx.
        for (const r of [empty, badWork, tooMany, tooFew, badDomains]) {
            expect(r.status).toBeGreaterThanOrEqual(400);
            expect(r.status).toBeLessThan(500);
        }
    });

    test('FLOW 5: work-scoped search enforces ownership BEFORE provider resolution — own work resolves (env-adaptive); a foreign valid-uuid work is 403-forbidden while a nonexistent uuid 404s', async ({
        request,
    }) => {
        const owner: RegisteredUser = await registerUserViaAPI(request);
        const stranger: RegisteredUser = await registerUserViaAPI(request);

        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Search Scope Work ${Date.now()}`,
        });
        expect(
            work.id,
            `work created (raw=${JSON.stringify(work.raw).slice(0, 160)})`,
        ).toBeTruthy();

        // (a) OWNER searches with their OWN workId → ownership.ensureCanView passes,
        //     then provider resolution runs (env-adaptive 200 or provider-400).
        const ownScoped = await postSearch(request, owner.access_token, {
            query: 'project tooling',
            workId: work.id,
        });
        expect(
            ownScoped.status,
            `own-work search must not 5xx (got ${ownScoped.status})`,
        ).toBeLessThan(500);
        expect([200, 400]).toContain(ownScoped.status);
        if (ownScoped.status === 400) {
            // A provider-stage 400 (status:error string) — NOT a 404 ownership error.
            expect(ownScoped.body.status).toBe('error');
            expect(flatten(ownScoped.body.message)).not.toContain('not found');
        }

        // (b) STRANGER searches with the OWNER's workId (valid uuid, not theirs) →
        //     ownership fires FIRST. The work EXISTS (findByIdForAccess resolves) but
        //     the stranger is neither creator nor a work_members row → ensureCanView
        //     throws ForbiddenException → 403 "You do not have permission to access
        //     this work" (PROBED 2026-06-01; NOT a 404 — a 404 is reserved for works
        //     that don't resolve at all, see (c)).
        const foreign = await postSearch(request, stranger.access_token, {
            query: 'project tooling',
            workId: work.id,
        });
        expect(foreign.status, 'foreign existing work is rejected by ownership').toBe(403);
        expect(foreign.body.status).toBe('error');
        expect(flatten(foreign.body.message)).toContain('permission to access this work');
        // It's an access (membership) denial, not a "missing work" denial.
        expect(flatten(foreign.body.message)).not.toContain('not found');

        // (c) A well-formed-but-nonexistent workId for the owner → the work simply does
        //     not resolve, so the gate 404s BEFORE the role check. Proves the gate
        //     distinguishes "work missing" (404) from "work exists, no access" (403, b).
        const ghost = '00000000-0000-4000-8000-000000000000';
        const ghostScoped = await postSearch(request, owner.access_token, {
            query: 'x',
            workId: ghost,
        });
        expect(ghostScoped.status).toBe(404);
        expect(flatten(ghostScoped.body.message)).toContain('not found');
    });

    test('FLOW 6: search-provider SETTINGS validation diverges from availability on x-envVar — PATCH still requires apiKey + enforces the maxResults schema bounds, while availability skips it', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // Enable two non-default search providers so we can exercise their schemas.
        await enablePluginViaAPI(request, user.access_token, SECONDARY_SEARCH);
        await enablePluginViaAPI(request, user.access_token, TERTIARY_SEARCH);

        // (a) DIVERGENCE: the settings validator does NOT skip x-envVar. PATCHing
        //     brave with only the global maxResults (no required apiKey) → 400 with
        //     the EXACT errors array — even though apiKey carries x-envVar.
        const missingKey = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SECONDARY_SEARCH,
            {
                settings: { maxResults: 5 },
            },
        );
        expect(missingKey.status).toBe(400);
        const missingBody = missingKey.body as { message?: string; errors?: string[] };
        expect(missingBody.message).toBe('Invalid plugin settings');
        expect(missingBody.errors).toContain('Missing required fields: apiKey');

        // Same divergence on a second provider (exa) — it is not brave-specific.
        const exaMissing = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            TERTIARY_SEARCH,
            {
                settings: { maxResults: 5 },
            },
        );
        expect(exaMissing.status).toBe(400);
        expect((exaMissing.body as { errors?: string[] }).errors).toContain(
            'Missing required fields: apiKey',
        );

        // ...yet availability for this user IS true the whole time, because the
        // availability resolver skips the x-envVar apiKey (the default tavily slot).
        const availDuring = await getAvailability(request, user.access_token);
        expect(availDuring.body.available, 'availability ignores the unconfigured secret').toBe(
            true,
        );
        expect(availDuring.body.activeProvider?.id).toBe(DEFAULT_SEARCH);

        // (b) brave's maxResults is schema-bound to 1..20 — numeric range is
        //     enforced by the JSON-schema validator (distinct from the search DTO's
        //     @Max(50)). Above the bound:
        const overMax = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SECONDARY_SEARCH,
            {
                settings: { maxResults: 999 },
                secretSettings: { apiKey: FAKE_SEARCH_KEY },
            },
        );
        expect(overMax.status).toBe(400);
        expect(flatten((overMax.body as { errors?: string[] }).errors)).toMatch(
            /maxResults.*must be <= 20/i,
        );

        // ...and below the bound:
        const underMin = await patchPluginSettingsViaAPI(
            request,
            user.access_token,
            SECONDARY_SEARCH,
            {
                settings: { maxResults: 0 },
                secretSettings: { apiKey: FAKE_SEARCH_KEY },
            },
        );
        expect(underMin.status).toBe(400);
        expect(flatten((underMin.body as { errors?: string[] }).errors)).toMatch(
            /maxResults.*must be >= 1/i,
        );

        // (c) A valid PATCH (apiKey + in-bounds maxResults) → 200; the global
        //     maxResults round-trips via resolvedSettings; the secret apiKey is
        //     echoed MASKED inside `settings` and is NEVER present in resolvedSettings.
        const ok = await patchPluginSettingsViaAPI(request, user.access_token, SECONDARY_SEARCH, {
            settings: { maxResults: 12 },
            secretSettings: { apiKey: FAKE_SEARCH_KEY },
        });
        expect(ok.status, `patch ok body=${JSON.stringify(ok.body)}`).toBe(200);
        const okBody = ok.body as {
            settings?: Record<string, unknown>;
            resolvedSettings?: Record<string, unknown>;
        };
        expect(okBody.resolvedSettings?.maxResults).toBe(12);
        expect(
            'apiKey' in (okBody.resolvedSettings ?? {}),
            'the raw secret must not leak into resolvedSettings',
        ).toBe(false);
        const echoed = okBody.settings?.apiKey;
        expect(typeof echoed).toBe('string');
        expect(echoed).not.toBe(FAKE_SEARCH_KEY);
        expect(String(echoed)).toContain('••••');

        // Persists across a fresh GET (default search maxResults stays at 12).
        await expect
            .poll(
                async () => {
                    const fresh = await getPluginViaAPI(
                        request,
                        user.access_token,
                        SECONDARY_SEARCH,
                    );
                    return (fresh.resolvedSettings as Record<string, unknown> | undefined)
                        ?.maxResults;
                },
                { timeout: 15_000, message: 'configured default-results count persists' },
            )
            .toBe(12);
    });
});
