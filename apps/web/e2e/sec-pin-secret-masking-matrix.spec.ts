import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { getPluginViaAPI, patchPluginSettingsViaAPI } from './helpers/plugins';

/**
 * SECURITY PIN — BYOK / SECRET-AT-REST READ-SURFACE MATRIX (post-#1266).
 *
 * Pins the masking contract for user-supplied plugin secrets on every READ
 * surface the core BYOK spec does NOT cover: the plugin LIST endpoints, the
 * settings-menu projection, the connection-status probe, the user-enable
 * route (the exact surface PR #1266 fixed), the WORK-scoped secretSettings
 * write + its cross-scope isolation, the partial-reveal mask math at the
 * short-key boundary, the clear-an-OPTIONAL-secret path, and the capability
 * FACADES (search / deploy / git-provider). Every status, shape and mask
 * below was PROBED against the LIVE stack (http://127.0.0.1:3100) on
 * 2026-06-11 with throwaway users BEFORE the assertions were written.
 *
 * NON-DUPLICATION — what the siblings already pin (read FIRST, not repeated):
 *   - flow-plugin-ai-byok.spec.ts: the core USER-scope apiKey lifecycle on the
 *     single-plugin GET + settings PATCH — partial-reveal format (4+••••+4 /
 *     2+••••+2 for len 6..8+), fixed '••••••••' resolvedSettings, masked
 *     round-trip stripping, REQUIRED-secret null-clear rejection (400),
 *     rotation, cross-USER isolation, validate-connection statuses.
 *   - flow-plugin-work-level-matrix.spec.ts: the work-vs-user settings LAYER
 *     on brave via the `settings` body field — work override masked distinct
 *     from user in the PATCH ECHO, null-clear reverting the work override,
 *     user-level-required-settings-first ordering (on a non-system plugin),
 *     validation envelope existence.
 *   - flow-plugin-per-work-ai.spec.ts: the per-work enable/disable/capability
 *     RECORD state machine + ownership guards (401/403/404).
 *   THIS file pins only what none of those touch: list-surface masking, the
 *   settings-menu metadata-only projection, connection-status non-leakage,
 *   enable-route secret acceptance + masking (#1266), the secretSettings
 *   route at WORK scope on the SYSTEM plugin + work→user/sibling read
 *   isolation across the single-GET and LIST surfaces, the <=4-char full-mask
 *   edge, OPTIONAL-secret clear-to-gone, and the search/deploy/git facades.
 *
 * PROBED CONTRACTS (live, http 3100, 2026-06-11):
 *   - GET /api/plugins → { plugins[], total, categories, capabilities }. After
 *     PATCH /api/plugins/openrouter/settings {apiKey,defaultModel} the LIST row
 *     carries settings.apiKey partial-reveal masked (first4+'••••'+last4) and
 *     resolvedSettings.apiKey === '••••••••'; the RAW key appears NOWHERE in
 *     the entire list body.
 *   - GET /api/plugins/settings-menu → { categories:[{category,label,plugins}] }
 *     where each plugin entry is EXACTLY the metadata projection
 *     { pluginId, name, icon, enabled, hasRequiredSettings } — no settings, no
 *     secretSettings, no masks ('•' absent from the whole body), no raw key.
 *   - GET /api/plugins/openrouter/connection-status →
 *     { connectionStatus: { connected:false, scope:'user', message } } when the
 *     stored user key is fake (the probe really uses the user key upstream and
 *     fails); the raw key never appears in the body.
 *   - POST /api/plugins/anthropic/enable { settings:{defaultModel},
 *     secretSettings:{apiKey} } → 200 (post-#1266 secrets are ACCEPTED on the
 *     enable route), enabled:true, response settings.apiKey partial-reveal
 *     masked, raw absent; the masked key persists on the single-plugin GET.
 *   - PATCH /api/works/:workId/plugins/openrouter/settings {secretSettings:{apiKey}}:
 *       • WITHOUT a user-level key first → 400 { message:'User-level required
 *         settings must be configured first', errors:['Missing required fields:
 *         apiKey'] } (yes — even though openrouter's apiKey is env-backed).
 *       • WITH the user key set → 200; workSettings.apiKey is the WORK key's
 *         partial-reveal mask, settings.apiKey stays the USER key's mask (the
 *         two differ), resolvedSettings.apiKey === '••••••••', a workPluginId
 *         is minted and a `validation` envelope is attached. Raw work key
 *         absent from the whole echo.
 *   - WORK→USER read isolation: after the work-scope write, the user-scope
 *     single GET /api/plugins/openrouter still shows ONLY the user mask and
 *     the user LIST body contains neither raw key.
 *   - WORK→WORK read isolation: a sibling work of the SAME user shows
 *     workSettings undefined / no workPluginId on its openrouter row and its
 *     whole list body never contains the work raw; the OWNER work's list row
 *     reads back workSettings.apiKey masked.
 *   - partialReveal math at the short boundary (user PATCH echo):
 *       len 3 ('xyz')  → '••••••••' (full fixed mask — nothing revealed)
 *       len 4 ('abcd') → '••••••••' (prefix+suffix >= len ⇒ full mask)
 *       len 5 ('abcde')→ 'ab••••de' (2+'••••'+2 resumes)
 *   - OPTIONAL secret clear-to-gone (apify, no required fields):
 *     POST /api/plugins/apify/enable → 200; PATCH {settings:{apiToken:RAW}} →
 *     200 settings.apiToken partial-reveal masked; PATCH
 *     {settings:{apiToken:null}} → 200 and settings becomes {} (mask GONE) on
 *     the echo, the single GET and the LIST row; raw absent throughout.
 *   - GET /api/search/check-availability → 200 { status:'success',
 *     available:true, activeProvider:{id:'tavily',name:'Tavily'} } even for a
 *     fresh keyless user (env-backed required fields are skipped by the
 *     facade's configured-check, so this is env-independent); after a tavily
 *     BYOK PATCH (echo masked 'tvly••••…') the facade response is unchanged
 *     and never carries settings or the raw key.
 *   - POST /api/search {query} with a fake user key → clean 400
 *     { status:'error', message } — never 5xx, raw key never echoed (probed
 *     message: 'Unauthorized: missing or invalid API key.' — upstream-worded,
 *     so only its non-leakage is pinned, not the wording).
 *   - GET /api/deploy/providers → { status:'success', providers:[{id,name,
 *     enabled,icon,description,homepage,configured}] } — vercel configured:false
 *     for a fresh user; after PATCH /api/plugins/vercel/settings
 *     {secretSettings:{apiToken}} (echo masked) configured flips true; GET
 *     /api/deploy/providers/vercel/configured → 200 { status:'success',
 *     configured:true, available:true, enabled:true, message:"Provider
 *     'vercel' is configured." }. Raw token absent from every facade body.
 *   - GET /api/git-providers → { configured, providers:[{id:'github',enabled,
 *     icon,description,homepage}] } — display-only keys, no settings/secret
 *     material.
 *
 * ENVIRONMENT-ADAPTIVE: this LOCAL stack has NO provider env keys wired, and
 * CI is keyless by design — every assertion here is about how the user's OWN
 * (deliberately fake) key is stored/masked/isolated, plus facade flags that
 * are env-independent (the env-backed-field skip), so the file is green in
 * both. Upstream probes triggered by settings PATCHes (tryValidateConnection)
 * fail truthfully with the fake keys; only their non-leakage is asserted.
 *
 * ISOLATION: every test registers its OWN fresh user (writing a fake BYOK key
 * SHADOWS the env chain and would break sibling chat specs on a shared user);
 * unique timestamped emails/slugs; API-only (no UI navigation).
 */

const BULLET = '•';
const FIXED_MASK = BULLET.repeat(8);
const OPENROUTER = 'openrouter';
const MODEL = 'openai/gpt-4o-mini';

/** Partial-reveal mask for keys longer than 8 chars: first4 + '••••' + last4. */
function mask4(raw: string): string {
    return `${raw.slice(0, 4)}${BULLET.repeat(4)}${raw.slice(-4)}`;
}

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-secmask-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
    });
    return u.access_token;
}

/** Authed GET returning status + parsed body + the FULL raw text (for leak scans). */
async function getFull(
    request: APIRequestContext,
    token: string,
    path: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
    const res: APIResponse = await request.get(`${API_BASE}${path}`, {
        headers: authedHeaders(token),
        timeout: 60_000,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
        body = JSON.parse(text) as Record<string, unknown>;
    } catch {
        // non-JSON body — leak scans still use `text`
    }
    return { status: res.status(), body, text };
}

/** Set the user-scope openrouter BYOK key (apiKey + required defaultModel). */
async function setUserKey(
    request: APIRequestContext,
    token: string,
    apiKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await patchPluginSettingsViaAPI(request, token, OPENROUTER, {
        settings: { apiKey, defaultModel: MODEL },
    });
    return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

/** PATCH the WORK-scope settings for a plugin; returns status + body + raw text. */
async function patchWorkSettings(
    request: APIRequestContext,
    token: string,
    workId: string,
    pluginId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
    const res = await request.patch(
        `${API_BASE}/api/works/${workId}/plugins/${pluginId}/settings`,
        {
            headers: authedHeaders(token),
            data,
            timeout: 60_000,
        },
    );
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
        body = JSON.parse(text) as Record<string, unknown>;
    } catch {
        // keep raw text for scans
    }
    return { status: res.status(), body, text };
}

interface PluginRow {
    id: string;
    settings?: Record<string, unknown>;
    workSettings?: Record<string, unknown>;
    resolvedSettings?: Record<string, unknown>;
    workPluginId?: string;
}

function rowById(body: Record<string, unknown>, id: string): PluginRow | undefined {
    const plugins = (body.plugins ?? []) as PluginRow[];
    return plugins.find((p) => p.id === id);
}

test.describe('Secret masking matrix — list surfaces, work scope, facades (post-#1266)', () => {
    test('plugin LIST surface masks a stored BYOK secret — partial-reveal row settings, fixed-bullet resolvedSettings, raw key nowhere in the whole list body', async ({
        request,
    }) => {
        const token = await freshToken(request, 'list');
        const raw = 'sk-or-LISTSURF-rawsecret-11119999';
        const patch = await setUserKey(request, token, raw);
        expect(patch.status, `BYOK PATCH ok; body=${JSON.stringify(patch.body)}`).toBe(200);

        const list = await getFull(request, token, '/api/plugins');
        expect(list.status, 'plugin list loads').toBe(200);
        // Envelope probed: { plugins, total, categories, capabilities }.
        expect(Array.isArray(list.body.plugins), 'list carries a plugins array').toBe(true);

        const row = rowById(list.body, OPENROUTER);
        expect(row, 'the openrouter row is present in the list').toBeTruthy();
        expect(
            row?.settings?.apiKey,
            'the LIST row echoes the user secret as the partial-reveal mask',
        ).toBe(mask4(raw));
        expect(
            row?.resolvedSettings?.apiKey,
            'the LIST row resolvedSettings shows the fixed 8-bullet mask',
        ).toBe(FIXED_MASK);
        // The strongest pin: the raw key appears NOWHERE in the entire list body —
        // not in any other plugin row, schema default, or readme.
        expect(list.text, 'the raw key never appears anywhere in the list body').not.toContain(raw);
    });

    test('settings-menu is a metadata-only projection — entries carry exactly {pluginId,name,icon,enabled,hasRequiredSettings}, never settings values, masks or the raw key', async ({
        request,
    }) => {
        const token = await freshToken(request, 'menu');
        const raw = 'sk-or-MENUSURF-rawsecret-22228888';
        expect((await setUserKey(request, token, raw)).status).toBe(200);

        const menu = await getFull(request, token, '/api/plugins/settings-menu');
        expect(menu.status, 'settings-menu loads').toBe(200);
        const categories = (menu.body.categories ?? []) as Array<{
            category: string;
            plugins: Array<Record<string, unknown>>;
        }>;
        expect(categories.length, 'the menu has categories').toBeGreaterThan(0);

        const ai = categories.find((c) => c.category === 'ai-provider');
        expect(ai, 'the ai-provider category is present').toBeTruthy();
        const orEntry = ai?.plugins.find((p) => p.pluginId === OPENROUTER);
        expect(orEntry, 'the configured openrouter plugin appears in the menu').toBeTruthy();

        // Every entry across every category is the bare metadata projection —
        // no settings bag of any kind ever rides along.
        for (const cat of categories) {
            for (const entry of cat.plugins) {
                expect(
                    entry.settings,
                    `menu entry ${String(entry.pluginId)} has no settings`,
                ).toBeUndefined();
                expect(
                    entry.secretSettings,
                    `menu entry ${String(entry.pluginId)} has no secretSettings`,
                ).toBeUndefined();
                expect(
                    entry.resolvedSettings,
                    `menu entry ${String(entry.pluginId)} has no resolvedSettings`,
                ).toBeUndefined();
            }
        }
        // Probed exact projection keys on the openrouter entry.
        expect(Object.keys(orEntry ?? {}).sort()).toEqual(
            ['enabled', 'hasRequiredSettings', 'icon', 'name', 'pluginId'].sort(),
        );
        // No raw key and not even a mask glyph — the menu carries no secret-derived data.
        expect(menu.text, 'raw key absent from the menu body').not.toContain(raw);
        expect(menu.text, 'no mask bullets in the menu body at all').not.toContain(BULLET);
    });

    test('connection-status probe REALLY uses the stored user key (fake key → connected:false) and never echoes it', async ({
        request,
    }) => {
        const token = await freshToken(request, 'connstat');
        const raw = 'sk-or-CONNSTAT-rawsecret-33337777';
        expect((await setUserKey(request, token, raw)).status).toBe(200);

        const cs = await getFull(request, token, `/api/plugins/${OPENROUTER}/connection-status`);
        expect(cs.status, 'connection-status loads').toBe(200);
        const status = (cs.body.connectionStatus ?? {}) as {
            connected?: boolean;
            scope?: string;
            message?: string;
        };
        // The user's fake key SHADOWS any env key, so the upstream probe must fail
        // truthfully in every environment.
        expect(status.connected, 'a fake stored key can never validate').toBe(false);
        expect(status.scope, 'the probe reports user scope').toBe('user');
        expect(typeof status.message, 'a human-readable message is attached').toBe('string');
        expect(status.message ?? '', 'the failure message never leaks the key').not.toContain(raw);
        expect(cs.text, 'the raw key appears nowhere in the body').not.toContain(raw);
    });

    test('user-enable route ACCEPTS secretSettings (the #1266 contract) and masks the echo — anthropic enable with a BYOK key', async ({
        request,
    }) => {
        const token = await freshToken(request, 'enable');
        const raw = 'sk-ant-ENABLEROUTE-rawsecret-1234';

        const res = await request.post(`${API_BASE}/api/plugins/anthropic/enable`, {
            headers: authedHeaders(token),
            data: {
                settings: { defaultModel: 'claude-3-5-haiku-latest' },
                secretSettings: { apiKey: raw },
            },
            timeout: 60_000,
        });
        const text = await res.text();
        const body = JSON.parse(text) as Record<string, unknown>;
        // Pre-#1266 this was rejected; post-#1266 BYOK secrets are accepted on enable.
        expect(res.status(), `enable with secretSettings is accepted; body=${text}`).toBe(200);
        expect(body.enabled, 'anthropic is enabled for the user').toBe(true);

        const settings = (body.settings ?? {}) as Record<string, unknown>;
        expect(settings.apiKey, 'the enable echo masks the secret partial-reveal').toBe(mask4(raw));
        expect(settings.defaultModel, 'the non-secret setting echoes in the clear').toBe(
            'claude-3-5-haiku-latest',
        );
        expect(text, 'the raw key never appears in the enable response').not.toContain(raw);

        // The masked key persists on the single-plugin GET — the enable route wrote
        // a real user-scope secret, not a transient echo.
        const after = await getPluginViaAPI(request, token, 'anthropic');
        const afterSettings = (after.settings ?? {}) as Record<string, unknown>;
        expect(afterSettings.apiKey, 'the secret persists masked on GET').toBe(mask4(raw));
        expect(JSON.stringify(after), 'raw absent from the GET body').not.toContain(raw);
    });

    test('WORK-scope secretSettings write — requires the user-level key first (400), then masks the work key DISTINCT from the user mask with fixed-bullet resolvedSettings', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workwrite');
        const work = await createWorkViaAPI(request, token, {
            name: `SecMask WW ${Date.now()}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        // ORDERING: a work-scope secret on openrouter is rejected until the USER
        // level key exists — even though openrouter's apiKey is env-backed.
        const workRaw = 'sk-or-WORKSCOPE-rawwork-33334444';
        const early = await patchWorkSettings(request, token, work.id, OPENROUTER, {
            secretSettings: { apiKey: workRaw },
        });
        expect(early.status, 'work secret before user key → 400').toBe(400);
        expect(String(early.body.message ?? ''), 'the 400 demands user-level config first').toMatch(
            /user-level required settings must be configured first/i,
        );
        expect(
            ((early.body.errors as string[]) ?? []).join(' '),
            'the 400 names the missing field',
        ).toContain('apiKey');

        // Configure the USER key, then the WORK-scope secret lands.
        const userRaw = 'sk-or-USERSCOPE-rawuser-11112222';
        expect((await setUserKey(request, token, userRaw)).status).toBe(200);

        const wp = await patchWorkSettings(request, token, work.id, OPENROUTER, {
            secretSettings: { apiKey: workRaw },
        });
        expect(wp.status, `work secret write ok; body=${wp.text}`).toBe(200);

        const workSettings = (wp.body.workSettings ?? {}) as Record<string, unknown>;
        const userSettings = (wp.body.settings ?? {}) as Record<string, unknown>;
        const resolved = (wp.body.resolvedSettings ?? {}) as Record<string, unknown>;
        expect(workSettings.apiKey, 'workSettings carries the WORK key mask').toBe(mask4(workRaw));
        expect(userSettings.apiKey, 'settings still carries the USER key mask').toBe(
            mask4(userRaw),
        );
        expect(workSettings.apiKey, 'the two scopes mask to DIFFERENT values').not.toBe(
            userSettings.apiKey,
        );
        expect(resolved.apiKey, 'resolvedSettings stays the fixed 8-bullet mask').toBe(FIXED_MASK);
        expect(wp.body.workPluginId, 'an explicit per-work record was minted').toBeTruthy();
        expect('validation' in wp.body, 'a validation envelope is attached').toBe(true);
        expect(wp.text, 'the raw WORK key never appears in the echo').not.toContain(workRaw);
        expect(wp.text, 'the raw USER key never appears in the echo').not.toContain(userRaw);
    });

    test('WORK-scoped secret is INVISIBLE at user scope — the single-plugin GET and the user LIST show only the user mask and neither raw key', async ({
        request,
    }) => {
        const token = await freshToken(request, 'workiso');
        const userRaw = 'sk-or-ISOUSER-rawuser-aaaa1111';
        const workRaw = 'sk-or-ISOWORK-rawwork-bbbb2222';
        expect((await setUserKey(request, token, userRaw)).status).toBe(200);
        const work = await createWorkViaAPI(request, token, {
            name: `SecMask ISO ${Date.now()}`,
        });
        const wp = await patchWorkSettings(request, token, work.id, OPENROUTER, {
            secretSettings: { apiKey: workRaw },
        });
        expect(wp.status, 'work secret written').toBe(200);

        // USER-scope single GET: still the USER mask only — the work-scope secret
        // does not bleed into the user projection.
        const single = await getFull(request, token, `/api/plugins/${OPENROUTER}`);
        expect(single.status).toBe(200);
        const singleSettings = (single.body.settings ?? {}) as Record<string, unknown>;
        expect(singleSettings.apiKey, 'user-scope GET shows the USER mask, not the work mask').toBe(
            mask4(userRaw),
        );
        expect(singleSettings.apiKey, 'definitely not the work mask').not.toBe(mask4(workRaw));
        expect(single.text, 'work raw absent from the user-scope GET').not.toContain(workRaw);
        expect(single.text, 'user raw absent from the user-scope GET').not.toContain(userRaw);

        // USER-scope LIST: the whole body is free of both raw keys.
        const list = await getFull(request, token, '/api/plugins');
        expect(list.status).toBe(200);
        expect(rowById(list.body, OPENROUTER)?.settings?.apiKey, 'list row = user mask').toBe(
            mask4(userRaw),
        );
        expect(list.text, 'work raw absent from the user LIST').not.toContain(workRaw);
        expect(list.text, 'user raw absent from the user LIST').not.toContain(userRaw);
    });

    test('WORK-scoped secret does not leak into a SIBLING work — owner work list reads back the mask, the sibling row has no work override at all', async ({
        request,
    }) => {
        const token = await freshToken(request, 'sibling');
        const userRaw = 'sk-or-SIBUSER-rawuser-cccc3333';
        const workRaw = 'sk-or-SIBWORK-rawwork-dddd4444';
        expect((await setUserKey(request, token, userRaw)).status).toBe(200);
        const owner = await createWorkViaAPI(request, token, {
            name: `SecMask Owner ${Date.now()}`,
        });
        const sibling = await createWorkViaAPI(request, token, {
            name: `SecMask Sibling ${Date.now()}`,
        });
        expect(
            (
                await patchWorkSettings(request, token, owner.id, OPENROUTER, {
                    secretSettings: { apiKey: workRaw },
                })
            ).status,
            'owner work secret written',
        ).toBe(200);

        // OWNER work list READ-BACK (not just the PATCH echo): the masked override persists.
        const ownerList = await getFull(request, token, `/api/works/${owner.id}/plugins`);
        expect(ownerList.status).toBe(200);
        const ownerRow = rowById(ownerList.body, OPENROUTER);
        expect(
            ownerRow?.workSettings?.apiKey,
            'the owner work list reads back the masked work override',
        ).toBe(mask4(workRaw));
        expect(ownerList.text, 'raw work key absent from the owner work list').not.toContain(
            workRaw,
        );

        // SIBLING work of the SAME user: no override, no per-work record, no leak.
        const sibList = await getFull(request, token, `/api/works/${sibling.id}/plugins`);
        expect(sibList.status).toBe(200);
        const sibRow = rowById(sibList.body, OPENROUTER);
        expect(sibRow, 'sibling work still lists openrouter').toBeTruthy();
        expect(sibRow?.workSettings, 'sibling work has NO work-scope settings').toBeUndefined();
        expect(sibRow?.workPluginId, 'sibling work has NO per-work record').toBeUndefined();
        expect(sibList.text, 'raw work key absent from the sibling list').not.toContain(workRaw);
        expect(sibList.text, 'raw user key absent from the sibling list').not.toContain(userRaw);
    });

    test('partial-reveal mask math at the short boundary — keys of length <=4 are FULLY masked (no characters revealed), length 5 resumes 2+2', async ({
        request,
    }) => {
        // len 3 and len 4: prefix(2)+suffix(2) >= length ⇒ partialReveal returns the
        // full fixed mask — NOT 'xy••••yz'-style overlap that would leak the key.
        const fullMaskCases = ['xyz', 'abcd'];
        for (const key of fullMaskCases) {
            const token = await freshToken(request, `short${key.length}`);
            const res = await setUserKey(request, token, key);
            expect(res.status, `set len-${key.length} key`).toBe(200);
            const settings = (res.body.settings ?? {}) as Record<string, unknown>;
            expect(
                settings.apiKey,
                `a ${key.length}-char secret masks to the FULL fixed mask`,
            ).toBe(FIXED_MASK);
        }

        // len 5 is the first length with a genuine middle to hide: 2 + •••• + 2.
        const token5 = await freshToken(request, 'short5');
        const res5 = await setUserKey(request, token5, 'abcde');
        expect(res5.status, 'set len-5 key').toBe(200);
        const settings5 = (res5.body.settings ?? {}) as Record<string, unknown>;
        expect(settings5.apiKey, 'a 5-char secret reveals 2+2 around the bullets').toBe(
            `ab${BULLET.repeat(4)}de`,
        );
    });

    test('clearing an OPTIONAL secret removes the mask everywhere — apify apiToken set→masked, null-clear→gone on echo, GET and LIST', async ({
        request,
    }) => {
        const token = await freshToken(request, 'optclear');
        // apify has NO required settings, so its secret is clearable (unlike the
        // REQUIRED openrouter apiKey whose null-clear is rejected — pinned in the
        // core BYOK spec).
        const enable = await request.post(`${API_BASE}/api/plugins/apify/enable`, {
            headers: authedHeaders(token),
            data: {},
            timeout: 60_000,
        });
        expect(enable.status(), 'apify user-enable').toBe(200);

        const raw = 'apify_api_OPTSECRET_abcdef123456';
        const set = await patchPluginSettingsViaAPI(request, token, 'apify', {
            settings: { apiToken: raw },
        });
        expect(set.status, `apify secret set; body=${JSON.stringify(set.body)}`).toBe(200);
        const setSettings = ((set.body as Record<string, unknown>).settings ?? {}) as Record<
            string,
            unknown
        >;
        expect(setSettings.apiToken, 'the optional secret echoes masked').toBe(mask4(raw));
        expect(JSON.stringify(set.body), 'raw absent from the set echo').not.toContain(raw);

        // CLEAR with null → the mask disappears (settings becomes {}), it is not
        // replaced by a bullet placeholder.
        const clear = await patchPluginSettingsViaAPI(request, token, 'apify', {
            settings: { apiToken: null as unknown as string },
        });
        expect(clear.status, 'optional-secret null-clear is accepted').toBe(200);
        const clearedSettings = ((clear.body as Record<string, unknown>).settings ?? {}) as Record<
            string,
            unknown
        >;
        expect(clearedSettings.apiToken, 'the mask is GONE from the clear echo').toBeUndefined();

        // GONE on the single GET …
        const after = await getFull(request, token, '/api/plugins/apify');
        expect(after.status).toBe(200);
        const afterSettings = (after.body.settings ?? {}) as Record<string, unknown>;
        expect(afterSettings.apiToken, 'the mask is GONE on GET').toBeUndefined();
        expect(after.text, 'raw absent from the GET body').not.toContain(raw);

        // … and on the LIST row.
        const list = await getFull(request, token, '/api/plugins');
        const row = rowById(list.body, 'apify');
        expect(row?.settings?.apiToken, 'the mask is GONE from the list row').toBeUndefined();
        expect(list.text, 'raw absent from the whole list').not.toContain(raw);
    });

    test('search facade availability never exposes settings — fresh user is available via tavily, a BYOK key changes nothing in the facade body', async ({
        request,
    }) => {
        const token = await freshToken(request, 'searchavail');

        // BASELINE (env-independent): tavily is the system search default and its
        // required apiKey is env-backed, which the facade's configured-check skips —
        // so a fresh keyless user is already "available".
        const before = await getFull(request, token, '/api/search/check-availability');
        expect(before.status, 'availability loads').toBe(200);
        expect(before.body.status).toBe('success');
        expect(before.body.available, 'fresh user: search reports available').toBe(true);
        const provider = (before.body.activeProvider ?? {}) as { id?: string; name?: string };
        expect(provider.id, 'the active provider is the system default tavily').toBe('tavily');
        expect(provider.name).toBe('Tavily');
        // The facade exposes ONLY identity fields — never a settings bag.
        expect(before.body.settings).toBeUndefined();
        expect(before.body.resolvedSettings).toBeUndefined();
        expect(Object.keys(provider).sort()).toEqual(['id', 'name']);

        // Store a tavily BYOK key (echo masked), then the facade body is unchanged
        // in shape and never carries the raw key or any mask.
        const raw = 'tvly-FACADE-rawsearchkey-5678';
        const patch = await patchPluginSettingsViaAPI(request, token, 'tavily', {
            settings: { apiKey: raw },
        });
        expect(patch.status, 'tavily BYOK PATCH ok').toBe(200);
        const patchSettings = ((patch.body as Record<string, unknown>).settings ?? {}) as Record<
            string,
            unknown
        >;
        expect(patchSettings.apiKey, 'tavily echo masks the key').toBe(mask4(raw));

        const after = await getFull(request, token, '/api/search/check-availability');
        expect(after.status).toBe(200);
        expect(after.body.available, 'still available with a user key').toBe(true);
        expect((after.body.activeProvider as { id?: string } | undefined)?.id, 'still tavily').toBe(
            'tavily',
        );
        expect(after.text, 'the raw key never appears in the facade body').not.toContain(raw);
        expect(after.text, 'not even a mask glyph rides on the facade').not.toContain(BULLET);
    });

    test('search facade EXECUTION with a fake BYOK key fails clean — 400 {status:error}, never 5xx, the key never echoed in the error', async ({
        request,
    }) => {
        const token = await freshToken(request, 'searchexec');
        const raw = 'tvly-EXECFAKE-rawkey-0987654321';
        expect(
            (
                await patchPluginSettingsViaAPI(request, token, 'tavily', {
                    settings: { apiKey: raw },
                })
            ).status,
            'tavily fake key stored',
        ).toBe(200);

        // The facade really USES the stored user key upstream; with a fake key the
        // search fails — and the failure is a clean, sanitized 400.
        const res = await request.post(`${API_BASE}/api/search`, {
            headers: authedHeaders(token),
            data: { query: `ever works secmask probe ${Date.now()}` },
            timeout: 60_000,
        });
        const text = await res.text();
        expect(res.status(), `fake-key search is a clean 400 (got body=${text})`).toBe(400);
        const body = JSON.parse(text) as { status?: string; message?: string };
        expect(body.status, 'the error envelope is status:error').toBe('error');
        expect(typeof body.message, 'a message is attached').toBe('string');
        expect(text, 'the raw key is never echoed in the error').not.toContain(raw);
    });

    test('deploy facade — providers list carries only display fields + a configured flag that flips when a vercel token is stored; raw token absent everywhere', async ({
        request,
    }) => {
        const token = await freshToken(request, 'deploy');

        const before = await getFull(request, token, '/api/deploy/providers');
        expect(before.status, 'deploy providers loads').toBe(200);
        expect(before.body.status).toBe('success');
        const providersBefore = (before.body.providers ?? []) as Array<Record<string, unknown>>;
        const vercelBefore = providersBefore.find((p) => p.id === 'vercel');
        expect(vercelBefore, 'vercel is listed').toBeTruthy();
        expect(vercelBefore?.configured, 'fresh user: vercel not configured').toBe(false);
        // Display-only projection — no settings of any kind on any provider row.
        for (const p of providersBefore) {
            expect(p.settings, `provider ${String(p.id)} carries no settings`).toBeUndefined();
            expect(
                p.secretSettings,
                `provider ${String(p.id)} carries no secretSettings`,
            ).toBeUndefined();
        }

        // Store the vercel token as a user secret (echo masked partial-reveal).
        const raw = 'vercel_tok_FACADE_rawsecret_4455';
        const patch = await patchPluginSettingsViaAPI(request, token, 'vercel', {
            secretSettings: { apiToken: raw },
        });
        expect(patch.status, `vercel token stored; body=${JSON.stringify(patch.body)}`).toBe(200);
        const patchSettings = ((patch.body as Record<string, unknown>).settings ?? {}) as Record<
            string,
            unknown
        >;
        expect(patchSettings.apiToken, 'the token echo is masked').toBe(mask4(raw));

        // The facade now reports configured:true — as a FLAG, never the value.
        const after = await getFull(request, token, '/api/deploy/providers');
        const vercelAfter = ((after.body.providers ?? []) as Array<Record<string, unknown>>).find(
            (p) => p.id === 'vercel',
        );
        expect(vercelAfter?.configured, 'vercel flips to configured:true').toBe(true);
        expect(after.text, 'raw token absent from the providers list').not.toContain(raw);

        const single = await getFull(request, token, '/api/deploy/providers/vercel/configured');
        expect(single.status).toBe(200);
        expect(single.body.status).toBe('success');
        expect(single.body.configured, 'the single-provider probe agrees').toBe(true);
        expect(single.body.available).toBe(true);
        expect(single.body.enabled).toBe(true);
        expect(String(single.body.message ?? ''), 'the message names the provider only').toContain(
            'vercel',
        );
        expect(single.text, 'raw token absent from the configured probe').not.toContain(raw);
    });

    test('git-provider facade lists display-only provider identities — no settings bags or secret material in the body', async ({
        request,
    }) => {
        const token = await freshToken(request, 'git');
        const res = await getFull(request, token, '/api/git-providers');
        expect(res.status, 'git providers loads').toBe(200);
        expect(typeof res.body.configured, 'a top-level configured flag').toBe('boolean');

        const providers = (res.body.providers ?? []) as Array<Record<string, unknown>>;
        expect(providers.length, 'at least the github provider is listed').toBeGreaterThan(0);
        const github = providers.find((p) => p.id === 'github');
        expect(github, 'github is present').toBeTruthy();
        expect(typeof github?.enabled, 'rows carry an enabled flag').toBe('boolean');
        // Probed projection: { id, enabled, icon, description, homepage } — assert
        // the absence of every settings-shaped field on every row.
        for (const p of providers) {
            expect(p.settings, `provider ${String(p.id)} has no settings`).toBeUndefined();
            expect(
                p.secretSettings,
                `provider ${String(p.id)} has no secretSettings`,
            ).toBeUndefined();
            expect(
                p.resolvedSettings,
                `provider ${String(p.id)} has no resolvedSettings`,
            ).toBeUndefined();
            expect(p.clientSecret, `provider ${String(p.id)} has no clientSecret`).toBeUndefined();
            expect(p.token, `provider ${String(p.id)} has no token`).toBeUndefined();
        }
        expect(res.text, 'no mask glyphs in the facade body').not.toContain(BULLET);
    });
});
