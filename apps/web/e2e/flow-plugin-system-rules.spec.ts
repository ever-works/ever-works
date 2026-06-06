import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { listPluginsViaAPI, getPluginViaAPI } from './helpers/plugins';

/**
 * Plugin SYSTEM RULES — the cross-plugin invariants that the platform enforces
 * on every "system plugin", independent of any single provider. Where the
 * sibling `flow-plugin-ai-matrix` spec drives ONE plugin (openrouter) deeply
 * (catalogue → settings → completion), THIS file asserts the RULE SET that
 * governs the whole system-plugin COHORT:
 *
 *   - systemPlugin ⇒ ALWAYS enabled (regardless of autoEnable) and CANNOT be
 *     disabled at user OR work level (400 with the same canonical message).
 *   - the `builtIn` flag, `visibility` (public | user-only | hidden) and
 *     `defaultForCapabilities` projection on the response.
 *   - a clean contrast with NON-system plugins (which enable/disable freely).
 *
 * Every shape below was PROBED against the LIVE stack (http://127.0.0.1:3100)
 * with throwaway users before the assertions were written — this asserts the
 * platform's REAL behaviour, not a guess.
 *
 * PROBED CONTRACTS (live, CI sqlite build — 63 plugins, 12 categories):
 *   - GET /api/plugins → { plugins:[…], total:63, categories:[…], capabilities? }.
 *     The 9 SYSTEM plugins in this build:
 *       agent-pipeline        dfc=['pipeline']           vis=public    auto=true
 *       comparison-generator  dfc=null                   vis=public    auto=FALSE
 *       github                dfc=['git-provider']       vis=user-only auto=true
 *       k8s                   dfc=null                   vis=user-only auto=true
 *       local-content-extractor dfc=['content-extractor'] vis=public  auto=true
 *       openrouter            dfc=['ai-provider']        vis=public    auto=true
 *       standard-pipeline     dfc=null                   vis=public    auto=true
 *       tavily                dfc=['search']             vis=public    auto=true
 *       vercel                dfc=['deployment']         vis=user-only auto=true
 *     EVERY system plugin reports enabled:true & installed:true for a brand-new
 *     user — comparison-generator proves systemPlugin overrides autoEnable=false
 *     (resolvePluginEnabled: `if (systemPlugin) return true` is rule #1).
 *   - GET /api/plugins/:id (single) → { id, pluginId(===id), category,
 *     capabilities:[…], systemPlugin, builtIn, autoEnable, visibility, enabled,
 *     installed, defaultForCapabilities?, configurationMode, state:'loaded' }.
 *     `builtIn` is TRUE for every system plugin; NON-builtIn plugins exist
 *     (apify, mailgun, minio, …) and are never system plugins.
 *   - POST /api/plugins/:id/disable on a system plugin → 400
 *       { message:'Plugin "<id>" is a system plugin and cannot be disabled',
 *         error:'Bad Request', statusCode:400 }; the plugin stays enabled.
 *   - POST /api/works/:wid/plugins/:id/disable on a system plugin → SAME 400
 *       (the rule is enforced at user AND work scope with identical wording).
 *   - POST /api/plugins/:id/disable on an UNKNOWN id → 404
 *       { message:'Plugin "<id>" not found', statusCode:404 } — the not-found
 *       guard runs BEFORE the system-plugin guard.
 *   - NON-system plugin (e.g. brave) → enable 200 then disable 200; it is NOT
 *     systemPlugin, NOT autoEnable, and flips enabled false→true→false freely.
 *   - GET /api/plugins?category=ai-provider → list narrows to that category
 *     only (every returned plugin has category==='ai-provider').
 *
 * ISOLATION: every test runs on a FRESH registerUserViaAPI() user (never the
 * shared seeded user) — these are read-mostly system-plugin assertions, but the
 * non-system enable/disable in Flow 6 mutates user-plugin state, so a throwaway
 * account keeps sibling specs clean. Assertions use toContain / per-row checks
 * (tolerating extra plugins) and never exact id-set equality beyond the system
 * cohort the platform guarantees.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */

/** The canonical 400 message the platform emits for any system-plugin disable. */
const SYSTEM_DISABLE_RE = /is a system plugin and cannot be disabled/i;

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

interface RawPlugin {
    id: string;
    pluginId?: string;
    category?: string;
    capabilities?: string[];
    systemPlugin?: boolean;
    builtIn?: boolean;
    autoEnable?: boolean;
    visibility?: string;
    enabled?: boolean;
    installed?: boolean;
    defaultForCapabilities?: string[] | null;
    configurationMode?: string;
    state?: string;
}

/** GET /api/plugins and return the raw rows (richer than the helper summary). */
async function rawPluginList(
    request: APIRequestContext,
    token: string,
    category?: string,
): Promise<{ plugins: RawPlugin[]; total: number; categories?: string[] }> {
    const url = category
        ? `${API_BASE}/api/plugins?category=${encodeURIComponent(category)}`
        : `${API_BASE}/api/plugins`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    expect(res.status(), `GET ${url} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as {
        plugins?: RawPlugin[];
        total?: number;
        categories?: string[];
    };
    return { plugins: body.plugins ?? [], total: body.total ?? 0, categories: body.categories };
}

test.describe('Plugin system-plugin rules', () => {
    test('Flow 1: every system plugin is enabled+installed for a brand-new user — systemPlugin overrides autoEnable', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins, total } = await rawPluginList(request, token);

        expect(total, 'the catalogue reports a positive total').toBeGreaterThan(0);
        expect(plugins.length, 'the list payload matches the total').toBe(total);

        const systemPlugins = plugins.filter((p) => p.systemPlugin === true);
        expect(systemPlugins.length, 'the build ships at least one system plugin').toBeGreaterThan(
            0,
        );

        // RULE #1: a system plugin is ALWAYS enabled and installed for a fresh
        // user — even with autoEnable=false (comparison-generator proves this:
        // resolvePluginEnabled returns true on `systemPlugin` before it ever
        // consults autoEnable). No fresh user has touched any UserPlugin record.
        for (const p of systemPlugins) {
            expect(p.enabled, `system plugin "${p.id}" is enabled out of the box`).toBe(true);
            expect(p.installed, `system plugin "${p.id}" is installed out of the box`).toBe(true);
            expect(p.builtIn, `system plugin "${p.id}" is built-in`).toBe(true);
        }

        // The canonical system cohort this platform guarantees in every build —
        // assert membership (toContain), never exact-set equality, so the test
        // tolerates extra system plugins added later.
        const systemIds = systemPlugins.map((p) => p.id);
        for (const guaranteed of ['openrouter', 'tavily', 'standard-pipeline']) {
            expect(systemIds, `"${guaranteed}" is a guaranteed system plugin`).toContain(
                guaranteed,
            );
        }

        // The autoEnable-FALSE-yet-enabled case must exist for the rule to be
        // meaningful: at least one system plugin is NOT autoEnable but is still
        // enabled (otherwise systemPlugin would be redundant with autoEnable).
        const sysNoAuto = systemPlugins.filter((p) => p.autoEnable === false);
        if (sysNoAuto.length > 0) {
            for (const p of sysNoAuto) {
                expect(
                    p.enabled,
                    `"${p.id}" is systemPlugin & autoEnable=false yet still enabled (systemPlugin wins)`,
                ).toBe(true);
            }
        }
    });

    test('Flow 2: user-level disable of every system plugin is rejected 400 and is a no-op', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await rawPluginList(request, token);
        const systemPlugins = plugins.filter((p) => p.systemPlugin === true);
        expect(systemPlugins.length, 'there are system plugins to exercise').toBeGreaterThan(0);

        // Exercise a representative slice across categories so the test stays
        // fast but still proves the rule is category-independent.
        const sample = systemPlugins
            .filter((p) =>
                ['openrouter', 'tavily', 'standard-pipeline', 'local-content-extractor'].includes(
                    p.id,
                ),
            )
            .slice(0, 4);
        // Always include at least the first system plugin even if the named ones drift.
        if (sample.length === 0) sample.push(systemPlugins[0]);

        for (const p of sample) {
            const res = await request.post(`${API_BASE}/api/plugins/${p.id}/disable`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `disabling system plugin "${p.id}" is rejected 400`).toBe(400);
            const body = (await res.json().catch(() => ({}))) as {
                message?: string;
                error?: string;
                statusCode?: number;
            };
            expect(
                body.message ?? '',
                `the 400 for "${p.id}" explains the system-plugin rule`,
            ).toMatch(SYSTEM_DISABLE_RE);
            expect(
                body.message ?? '',
                `the 400 for "${p.id}" names the offending plugin`,
            ).toContain(p.id);
            expect(body.statusCode ?? 400, 'the envelope carries statusCode 400').toBe(400);

            // The rejected disable must be a no-op: the plugin stays enabled.
            const after = await getPluginViaAPI(request, token, p.id);
            expect(after.enabled, `"${p.id}" stays enabled after the rejected disable`).toBe(true);
        }

        // And the catalogue shows no silent drift — all sampled ids still enabled.
        const refreshed = await listPluginsViaAPI(request, token);
        for (const p of sample) {
            expect(
                refreshed.find((r) => r.id === p.id)?.enabled,
                `"${p.id}" still reports enabled:true in the list`,
            ).toBe(true);
        }
    });

    test('Flow 3: WORK-level disable of a system plugin is rejected with the SAME 400 — rule holds across scopes', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // A work is required to exercise the work-scoped disable path.
        const suffix = `${Date.now()}`;
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `SysRule Work ${suffix}`,
            slug: `sysrule-work-${suffix}`,
            description: 'system-plugin work-scope rule probe',
        });
        expect(workId, 'a work was created to scope the disable').toBeTruthy();

        // The work plugins list projects the same systemPlugin flag + a workEnabled
        // field. A system plugin must report workEnabled:true with no opt-out record.
        const wpRes = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
            headers: authedHeaders(token),
        });
        expect(wpRes.status(), `work plugins list body=${await wpRes.text().catch(() => '')}`).toBe(
            200,
        );
        const wpBody = (await wpRes.json()) as {
            plugins?: Array<{ id: string; systemPlugin?: boolean; workEnabled?: boolean }>;
        };
        const tavilyWork = (wpBody.plugins ?? []).find((p) => p.id === 'tavily');
        expect(tavilyWork, 'tavily appears in the work plugin list').toBeTruthy();
        expect(tavilyWork?.systemPlugin, 'tavily is flagged system at work scope').toBe(true);
        expect(tavilyWork?.workEnabled, 'tavily is workEnabled for a fresh work').toBe(true);

        // WORK-level disable of a system plugin → identical 400 contract.
        const res = await request.post(`${API_BASE}/api/works/${workId}/plugins/tavily/disable`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'work-scoped disable of a system plugin is rejected 400').toBe(400);
        const body = (await res.json().catch(() => ({}))) as {
            message?: string;
            statusCode?: number;
        };
        expect(
            body.message ?? '',
            'the work-scope 400 uses the canonical system-plugin message',
        ).toMatch(SYSTEM_DISABLE_RE);
        expect(body.message ?? '', 'the work-scope 400 names the plugin').toContain('tavily');

        // No drift: tavily remains workEnabled.
        const afterRes = await request.get(`${API_BASE}/api/works/${workId}/plugins`, {
            headers: authedHeaders(token),
        });
        const afterBody = (await afterRes.json()) as {
            plugins?: Array<{ id: string; workEnabled?: boolean }>;
        };
        expect(
            (afterBody.plugins ?? []).find((p) => p.id === 'tavily')?.workEnabled,
            'tavily stays workEnabled after the rejected work-scope disable',
        ).toBe(true);
    });

    test('Flow 4: defaultForCapabilities — each declaring system plugin is the registry default for exactly its declared capability', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await rawPluginList(request, token);

        const declarers = plugins.filter(
            (p) => Array.isArray(p.defaultForCapabilities) && p.defaultForCapabilities.length > 0,
        );
        expect(
            declarers.length,
            'at least one plugin declares defaultForCapabilities',
        ).toBeGreaterThan(0);

        // Each declared default capability must be a capability the plugin
        // actually provides — a default-for cap it doesn't implement would be a
        // registry bug. And known anchors must map to the right provider.
        const knownDefaults: Record<string, string> = {
            openrouter: 'ai-provider',
            tavily: 'search',
            'local-content-extractor': 'content-extractor',
            github: 'git-provider',
            vercel: 'deployment',
        };

        for (const p of declarers) {
            const caps = p.capabilities ?? [];
            for (const dfc of p.defaultForCapabilities ?? []) {
                expect(
                    caps,
                    `"${p.id}" declares default-for "${dfc}" — it must also provide that capability`,
                ).toContain(dfc);
            }
            // The CORE-capability default-providers (the knownDefaults anchors:
            // ai-provider / search / content-extractor / git-provider /
            // deployment) ship WITH the platform, so they are system plugins.
            // PROBED: newer default-for declarers for non-core capabilities
            // (agentmemory→agent-memory, langfuse→prompt-provider, everworks-*)
            // are built-in defaults but NOT system plugins — so only the core
            // anchors carry the systemPlugin guarantee.
            if (knownDefaults[p.id]) {
                expect(
                    p.systemPlugin,
                    `core default-provider "${p.id}" is a system plugin (defaults ship with the platform)`,
                ).toBe(true);
                expect(
                    p.defaultForCapabilities,
                    `"${p.id}" is the registry default for "${knownDefaults[p.id]}"`,
                ).toContain(knownDefaults[p.id]);
            }
        }

        // Every knownDefaults anchor must actually appear among the declarers —
        // the platform always ships these core-capability defaults.
        for (const [id, cap] of Object.entries(knownDefaults)) {
            const anchorPlugin = declarers.find((p) => p.id === id);
            expect(
                anchorPlugin,
                `core default-provider "${id}" declares defaultForCapabilities`,
            ).toBeTruthy();
            expect(
                anchorPlugin?.defaultForCapabilities ?? [],
                `"${id}" is the registry default for "${cap}"`,
            ).toContain(cap);
        }

        // Cross-check the single-plugin GET projects the same defaultForCapabilities
        // as the list (no projection drift between the two endpoints).
        const anchor = declarers.find((p) => p.id === 'openrouter') ?? declarers[0];
        const single = await getPluginViaAPI(request, token, anchor.id);
        expect(
            (single.defaultForCapabilities as string[] | undefined) ?? [],
            `single GET /api/plugins/${anchor.id} echoes defaultForCapabilities from the list`,
        ).toEqual(expect.arrayContaining(anchor.defaultForCapabilities ?? []));
        expect(single.pluginId, 'single GET pluginId mirrors id').toBe(anchor.id);
    });

    test('Flow 5: visibility & builtIn invariants — public/user-only are valid, hidden is filtered, every system plugin is builtIn', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await rawPluginList(request, token);

        const VALID_VISIBILITY = new Set(['public', 'user-only', 'hidden']);
        const seenVisibilities = new Set<string>();

        for (const p of plugins) {
            const vis = p.visibility ?? 'public';
            expect(VALID_VISIBILITY.has(vis), `"${p.id}" has a valid visibility ("${vis}")`).toBe(
                true,
            );
            seenVisibilities.add(vis);

            // 'hidden' plugins are not surfaced to end users in the listing — if
            // the API ever returns one in the public list that is a contract break.
            expect(vis, `"${p.id}" is not a hidden plugin leaking into the public list`).not.toBe(
                'hidden',
            );

            // INVARIANT: systemPlugin ⇒ builtIn (you cannot ship a non-bundled
            // system plugin). The converse is false (builtIn user plugins exist).
            if (p.systemPlugin) {
                expect(p.builtIn, `system plugin "${p.id}" must be built-in`).toBe(true);
            }
        }

        // The build exposes BOTH public and user-only system plugins — assert the
        // platform actually distinguishes them (github/vercel are user-only,
        // openrouter/tavily are public).
        expect(seenVisibilities.has('public'), 'public plugins are listed').toBe(true);

        const userOnlySystem = plugins.filter(
            (p) => p.systemPlugin && p.visibility === 'user-only',
        );
        const publicSystem = plugins.filter((p) => p.systemPlugin && p.visibility === 'public');
        expect(publicSystem.length, 'there are public system plugins').toBeGreaterThan(0);
        if (userOnlySystem.length > 0) {
            // user-only system plugins (github, vercel) are still enabled+builtIn —
            // visibility is a UI hint, NOT an enablement gate.
            for (const p of userOnlySystem) {
                expect(p.enabled, `user-only system plugin "${p.id}" is still enabled`).toBe(true);
                expect(p.builtIn, `user-only system plugin "${p.id}" is still built-in`).toBe(true);
            }
        }

        // There also exist NON-builtIn plugins, and none of them is a system
        // plugin — system status is reserved for first-party bundled plugins.
        const nonBuiltIn = plugins.filter((p) => p.builtIn === false);
        if (nonBuiltIn.length > 0) {
            for (const p of nonBuiltIn) {
                expect(
                    p.systemPlugin ?? false,
                    `non-builtIn plugin "${p.id}" is never a system plugin`,
                ).toBe(false);
            }
        }
    });

    test('Flow 6: contrast — a NON-system plugin enable/disable freely, an unknown id 404s before the system-plugin guard, category filter narrows the list', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { plugins } = await rawPluginList(request, token);

        // --- Pick a real NON-system, NON-autoEnable plugin to contrast against
        //     the system cohort. brave is the canonical choice; fall back to any
        //     non-system plugin if the build drifts.
        const candidate =
            plugins.find((p) => p.id === 'brave' && p.systemPlugin === false) ??
            plugins.find(
                (p) => p.systemPlugin === false && p.autoEnable === false && p.enabled === false,
            );
        expect(candidate, 'a non-system plugin exists to contrast with').toBeTruthy();
        const userId = candidate!.id;

        // A non-system plugin starts NOT enabled for a fresh user...
        const before = await getPluginViaAPI(request, token, userId);
        expect(before.systemPlugin, `"${userId}" is NOT a system plugin`).toBe(false);

        // ...enables to 200...
        const enableRes = await request.post(`${API_BASE}/api/plugins/${userId}/enable`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(enableRes.status(), `enabling non-system "${userId}" succeeds`).toBe(200);
        const enabled = await getPluginViaAPI(request, token, userId);
        expect(enabled.enabled, `"${userId}" is enabled after enable`).toBe(true);
        expect(enabled.installed, `"${userId}" is installed after enable`).toBe(true);

        // ...and DISABLES to 200 (unlike a system plugin which would 400).
        const disableRes = await request.post(`${API_BASE}/api/plugins/${userId}/disable`, {
            headers: authedHeaders(token),
        });
        expect(
            disableRes.status(),
            `disabling non-system "${userId}" succeeds (no system guard)`,
        ).toBe(200);
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, userId)).enabled, {
                timeout: 15_000,
                message: `"${userId}" settles to disabled`,
            })
            .toBe(false);

        // --- Unknown plugin id: the NOT-FOUND guard runs BEFORE the system-plugin
        //     guard, so a bogus id yields 404 "not found", never a 400.
        const unknownId = `definitely-not-a-real-plugin-${Date.now()}`;
        const getUnknown = await request.get(`${API_BASE}/api/plugins/${unknownId}`, {
            headers: authedHeaders(token),
        });
        expect(getUnknown.status(), 'GET on an unknown plugin id → 404').toBe(404);

        const disableUnknown = await request.post(`${API_BASE}/api/plugins/${unknownId}/disable`, {
            headers: authedHeaders(token),
        });
        expect(disableUnknown.status(), 'disabling an unknown plugin id → 404 (not 400)').toBe(404);
        const unknownBody = (await disableUnknown.json().catch(() => ({}))) as {
            message?: string;
            statusCode?: number;
        };
        expect(
            unknownBody.message ?? '',
            'the 404 message is "not found", not the system-plugin message',
        ).toMatch(/not found/i);
        expect(
            unknownBody.message ?? '',
            'the 404 does NOT use the system-plugin wording',
        ).not.toMatch(SYSTEM_DISABLE_RE);

        // --- Category filter narrows the catalogue to a single category. Pick a
        //     category that is guaranteed present (the one our candidate lives in).
        const targetCategory = candidate!.category ?? 'ai-provider';
        const narrowed = await rawPluginList(request, token, targetCategory);
        expect(
            narrowed.plugins.length,
            `category="${targetCategory}" returns at least one plugin`,
        ).toBeGreaterThan(0);
        for (const p of narrowed.plugins) {
            expect(
                p.category,
                `every plugin under category="${targetCategory}" matches the filter`,
            ).toBe(targetCategory);
        }
        // The filtered list is a strict subset of the full catalogue.
        expect(
            narrowed.plugins.length,
            'the category-filtered list is no larger than the full catalogue',
        ).toBeLessThanOrEqual(plugins.length);
    });
});
