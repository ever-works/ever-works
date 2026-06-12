import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-git-providers-deep — DEEP coverage of the GitProviderController
 * (`apps/api/src/plugins-capabilities/git-provider/`, the `/api/git-providers/*`
 * surface), going well beyond the single-endpoint smoke test in
 * git-providers.spec.ts.
 *
 * This file is intentionally focused on the GIT-PROVIDERS controller's OWN
 * contracts — the list descriptor SHAPE, its provider-id resolution semantics,
 * its sub-resource success-envelope MATRIX, and its route discipline — as
 * distinct from the connection/oauth lifecycle that the connection specs own.
 *
 * NON-DUPLICATION — the existing git-provider specs already own:
 *   · flow-git-provider-connection → two-user connection-record isolation, the
 *       sanitized (EW-721 Wave J) sub-resource error leak matrix, the
 *       connected-as identity ABSENCE UI, the list↔oauth coherence, the
 *       connection GATING git-backed taxonomy writes, the connect-url variant
 *       matrix + idempotent DELETE, and the works/new + settings UI auth gates.
 *   · flow-plugin-git-provider → the SINGLE-user full lifecycle (status →
 *       connect/url → DELETE 204), the read-packages token track, the plugin
 *       callback code-before-creds gate, the web-tier callback redirect
 *       contract, and unknown-provider resolution on BOTH controllers.
 *   · git-providers.spec.ts → a bare 401 + "is an object" smoke on
 *       /github/connection.
 *   · flow-settings-git-providers / git-providers-oauth-happy / github-app →
 *       the settings PAGE, oauth connect/url happy path, and the GitHub-App plane.
 *
 * THIS file deliberately covers what those do NOT (genuinely-uncovered angles):
 *   1. The providers LIST descriptor SHAPE in depth: configured:true exactly,
 *      EXACTLY one advertised provider (github = the sole default), the precise
 *      git-list item key-set (description, enabled, homepage, icon, id — and
 *      notably NO `name` key, unlike the oauth list item), and the structured
 *      `icon` object ({type:'svg', value:'<svg…', darkValue:'<svg…'}).
 *   2. github's connection descriptor is the SAME rich object as its list entry
 *      PLUS connected:false (the list entry and connection descriptor agree).
 *   3. Provider-id resolution is EXACT-MATCH / case-SENSITIVE: 'GITHUB',
 *      'Github', a trailing-space 'github ', and a wholly-unknown id ALL resolve
 *      to the synthetic {name:'Unknown', enabled:false, connected:false} echoing
 *      the verbatim id — proving no normalization/trimming and no crash.
 *   4. The sub-resource success-envelope MATRIX for a disconnected user on the
 *      GIT-PROVIDERS controller: organizations→{success:false,organizations:[]},
 *      repositories→{success:false,repositories:[]}, user→{success:false,
 *      user:null}, each carrying the EXACT collection key + a generic sanitized
 *      error (EW-721 Wave J: no userId/token leak) — pinned on github AND on an
 *      unknown provider (the unknown path degrades identically, never 5xx).
 *   5. repositories pagination-param ROBUSTNESS: NaN params (page=abc&perPage=xyz)
 *      and an over-cap perPage=500 (controller Math.min-clamps to 100) both stay
 *      a graceful 200 success:false envelope — never a 500 from parseInt(NaN).
 *   6. Route discipline ON THE GIT-PROVIDERS CONTROLLER: it is READ-ONLY — there
 *      is no POST /api/git-providers and no DELETE /:p/connection (both 404);
 *      the sub-resources are GET-only (POST :p/user 404). (Disconnect lives on
 *      the SEPARATE oauth controller, which the connection specs pin.)
 *   7. The full anon boundary on EVERY git-providers route (list + connection +
 *      all three sub-resources) → 401, and an invalid bearer → 401.
 *   8. Cross-user isolation of the sub-resource envelopes: two fresh users
 *      fan-out the same sub-resources concurrently and each gets its OWN clean
 *      disconnected envelope with no cross-user id leak.
 *
 * EVERY status/shape/message below was PROBED against the LIVE stack
 * (API 127.0.0.1:3100 sqlite in-memory CI driver; web 127.0.0.1:3000 next-dev)
 * before assertions were written. Upstream github.com is NEVER contacted.
 *
 * PROBED CONTRACTS (live):
 *   POST   /api/auth/register { username(>=3), email, password }
 *            → { access_token (opaque session token), user:{id,email,username} }
 *   GET    /api/git-providers                 (authed) → 200 { configured:true,
 *            providers:[ EXACTLY ONE: { id:'github', enabled:true,
 *              description:'GitHub integration for…', homepage:'https://github.com',
 *              icon:{ type:'svg', value:'<svg…', darkValue:'<svg…' } } ] }
 *            — NOTE: the git-list item carries NO `name` key. (anon/bad-token 401)
 *   GET    /api/git-providers/:p/connection   (authed) → for github: the SAME
 *            rich descriptor (id,enabled,description,homepage,icon) + connected:false
 *            (NO username/email/avatarUrl/authMethod while disconnected). For an
 *            id that does not exactly match an enabled provider id — 'GITHUB',
 *            'Github', 'github ' (trailing space), 'bitbucket', 'gitlab' — the
 *            synthetic { id:<verbatim>, name:'Unknown', enabled:false,
 *            connected:false }. (anon 401)
 *   GET    /api/git-providers/:p/organizations (disconnected) → 200
 *            { success:false, organizations:[], error:'Failed to fetch organizations' }
 *   GET    /api/git-providers/:p/repositories  (disconnected) → 200
 *            { success:false, repositories:[], error:'Failed to fetch repositories' }
 *            — ?page=abc&perPage=xyz and ?perPage=500 also → graceful 200 envelope.
 *   GET    /api/git-providers/:p/user          (disconnected) → 200
 *            { success:false, user:null, error:'Failed to fetch user' }
 *   POST   /api/git-providers                  → 404 (no such route; list is GET-only)
 *   DELETE /api/git-providers/:p/connection    → 404 (no such route on this controller)
 *   POST   /api/git-providers/:p/user          → 404 (sub-resources are GET-only)
 *
 * ISOLATION: every flow uses FRESH registerUserViaAPI() users; all calls here are
 * READ-ONLY against the git-providers controller (no work/connection mutation),
 * so no shared/seeded state is touched.
 */

const PROVIDER = 'github';

interface IconDescriptor {
    type?: string;
    value?: string;
    darkValue?: string;
}

interface ProviderDescriptor {
    id?: string;
    name?: string;
    enabled?: boolean;
    description?: string;
    homepage?: string;
    icon?: IconDescriptor;
    connected?: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: string;
}

interface SubResourceEnvelope {
    success?: boolean;
    error?: string;
    organizations?: unknown[];
    repositories?: unknown[];
    user?: unknown;
}

/** A github token must never appear in any payload we read back. */
function expectNoTokenLeak(text: string, label: string): void {
    expect(text, `${label} leaks no github token`).not.toMatch(/gh[pousr]_[A-Za-z0-9]{8,}/);
}

test.describe('flow: git-providers LIST descriptor shape (configured flag + the github descriptor)', () => {
    test('the list is authed-only, reports configured:true, advertises github as the SOLE default provider, and each item carries the exact descriptor key-set (id/enabled/description/homepage + a structured svg icon, and NO name key)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // The list rejects anon and a bogus bearer (auth boundary on the list).
        expect(
            (await request.get(`${API_BASE}/api/git-providers`)).status(),
            'git-providers list rejects anon → 401',
        ).toBe(401);
        expect(
            (
                await request.get(`${API_BASE}/api/git-providers`, {
                    headers: authedHeaders('not-a-real-token-deadbeef'),
                })
            ).status(),
            'git-providers list rejects an invalid bearer → 401',
        ).toBe(401);

        const res = await request.get(`${API_BASE}/api/git-providers`, { headers: h });
        expect(res.status(), 'git-providers list → 200').toBe(200);
        const body = (await res.json()) as {
            configured?: unknown;
            providers?: ProviderDescriptor[];
        };

        // The list envelope: a boolean configured flag (true in this env, where the
        // github plugin's default credentials are bundled) + a providers array.
        expect(typeof body.configured, 'list carries a boolean configured flag').toBe('boolean');
        expect(body.configured, 'github plugin is configured in this env → configured:true').toBe(
            true,
        );
        expect(Array.isArray(body.providers), 'providers is an array').toBe(true);

        const providers = body.providers ?? [];
        // github is the SOLE default git provider in this build.
        expect(providers.length, 'exactly one advertised git provider (github = the default)').toBe(
            1,
        );
        const github = providers.find((p) => p.id === PROVIDER);
        expect(github, 'github is present in the list').toBeTruthy();
        expect(github?.enabled, 'github is enabled').toBe(true);

        // The exact descriptor key-set of a git-providers list item. CRUCIALLY this
        // differs from the OAUTH list item (which carries `name`): the git list
        // item surfaces the rich plugin metadata (description/homepage/icon) and
        // has NO `name` key. Pinning the key-set guards against an accidental
        // shape drift between the two controllers.
        expect(
            github && 'name' in github,
            'git-list item has NO name key (unlike the oauth list)',
        ).toBe(false);
        expect(typeof github?.description, 'github descriptor carries a string description').toBe(
            'string',
        );
        expect(String(github?.description), 'description is the real plugin blurb').toMatch(
            /GitHub integration/i,
        );
        expect(github?.homepage, 'github descriptor homepage is github.com').toBe(
            'https://github.com',
        );

        // The structured icon object: { type:'svg', value:'<svg…', darkValue:'<svg…' }.
        // A real plugin descriptor — not a bare string — with both light + dark svgs.
        const icon = github?.icon;
        expect(
            icon && typeof icon === 'object',
            'github descriptor carries a structured icon object',
        ).toBe(true);
        expect(icon?.type, "icon.type is 'svg'").toBe('svg');
        expect(String(icon?.value), 'icon.value is inline svg markup').toMatch(/^<svg\b/);
        expect(
            String(icon?.darkValue),
            'icon.darkValue is inline svg markup (dark variant)',
        ).toMatch(/^<svg\b/);

        // The descriptor never embeds a credential/token (defensive — list is public-ish metadata).
        expectNoTokenLeak(JSON.stringify(github), 'github list descriptor');
    });
});

test.describe('flow: github connection descriptor agrees with its list entry (rich descriptor + connected:false)', () => {
    test('the github connection echoes the same id/enabled/description/homepage/icon as the list entry, plus connected:false and NO leaked identity fields for a fresh disconnected user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Pull the list entry and the connection descriptor; they must agree on the
        // descriptor portion (the connection is the list entry decorated with state).
        const listRes = await request.get(`${API_BASE}/api/git-providers`, { headers: h });
        const listGithub = ((await listRes.json()).providers as ProviderDescriptor[]).find(
            (p) => p.id === PROVIDER,
        );
        expect(listGithub, 'list has a github entry').toBeTruthy();

        const connRes = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(connRes.status(), 'github connection → 200').toBe(200);
        const conn = (await connRes.json()) as ProviderDescriptor;

        // The descriptor portion is identical between the two surfaces.
        expect(conn.id, 'connection echoes the github id').toBe(listGithub?.id);
        expect(conn.enabled, 'connection echoes enabled').toBe(listGithub?.enabled);
        expect(conn.description, 'connection echoes the description').toBe(listGithub?.description);
        expect(conn.homepage, 'connection echoes the homepage').toBe(listGithub?.homepage);
        expect(conn.icon?.type, 'connection echoes the icon.type').toBe(listGithub?.icon?.type);

        // The state decoration: a fresh user is NOT connected, and the descriptor
        // leaks NO identity (no username/email/avatarUrl/authMethod while disconnected).
        expect(conn.connected, 'fresh user is NOT connected').toBe(false);
        expect(conn.username, 'disconnected → no username').toBeUndefined();
        expect(conn.email, 'disconnected → no email').toBeUndefined();
        expect(conn.avatarUrl, 'disconnected → no avatarUrl').toBeUndefined();
        expect(conn.authMethod, 'disconnected → no authMethod').toBeUndefined();

        // The anon boundary on the connection route.
        expect(
            (await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`)).status(),
            'github connection rejects anon → 401',
        ).toBe(401);
    });
});

test.describe('flow: provider-id resolution is EXACT-MATCH / case-sensitive (synthetic Unknown for any non-exact id)', () => {
    test('GITHUB / Github / "github " (trailing space) / bitbucket / gitlab all resolve to the synthetic {name:Unknown, enabled:false, connected:false} echoing the VERBATIM id — no normalization, no trimming, no crash', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // Each of these is NOT an exact, case-sensitive match for the enabled
        // provider id 'github'. The service short-circuits to a synthetic
        // descriptor rather than throwing — proving the lookup is a strict
        // `providers.find(p => p.id === id)` with no normalization.
        const nonExactIds = ['GITHUB', 'Github', 'github ', 'bitbucket', 'gitlab'];

        for (const id of nonExactIds) {
            const res = await request.get(
                `${API_BASE}/api/git-providers/${encodeURIComponent(id)}/connection`,
                { headers: h },
            );
            expect(res.status(), `'${id}' connection never 5xx (graceful)`).toBeLessThan(500);
            expect(res.status(), `'${id}' connection → 200`).toBe(200);
            const body = (await res.json()) as ProviderDescriptor;
            // The verbatim id is echoed back — no trimming/casing applied.
            expect(body.id, `'${id}' connection echoes the VERBATIM id`).toBe(id);
            expect(body.name, `'${id}' → synthetic name 'Unknown'`).toBe('Unknown');
            expect(body.enabled, `'${id}' → enabled:false`).toBe(false);
            expect(body.connected, `'${id}' → connected:false`).toBe(false);
            // The synthetic descriptor carries no rich metadata (no homepage/icon).
            expect(body.homepage, `'${id}' synthetic descriptor has no homepage`).toBeUndefined();
        }
    });
});

test.describe('flow: the disconnected sub-resource success-envelope MATRIX (github + unknown provider)', () => {
    test('organizations→[], repositories→[], user→null — each a 200 {success:false, <exact key>, generic sanitized error} for a disconnected user, identical on github AND an unknown provider, leaking no userId/token', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const h = authedHeaders(userA.access_token);

        // The success-envelope matrix: each sub-resource has a DISTINCT collection
        // key and a distinct empty default (list → [], user → null). The error is
        // a generic sanitized string (EW-721 Wave J: the old detail named the
        // caller's userId — a leak).
        const matrix: Array<{
            path: 'organizations' | 'repositories' | 'user';
            collectionKey: 'organizations' | 'repositories' | 'user';
            isList: boolean;
            error: RegExp;
        }> = [
            {
                path: 'organizations',
                collectionKey: 'organizations',
                isList: true,
                error: /Failed to fetch organizations/i,
            },
            {
                path: 'repositories',
                collectionKey: 'repositories',
                isList: true,
                error: /Failed to fetch repositories/i,
            },
            { path: 'user', collectionKey: 'user', isList: false, error: /Failed to fetch user/i },
        ];

        // Pin the matrix on github (an enabled-but-disconnected provider) AND on an
        // unknown provider id — the controller's try/catch degrades both paths to
        // the SAME success:false envelope (the unknown path can never 5xx either).
        for (const providerId of [PROVIDER, 'bitbucket']) {
            for (const { path, collectionKey, isList, error } of matrix) {
                const res = await request.get(
                    `${API_BASE}/api/git-providers/${providerId}/${path}`,
                    { headers: h },
                );
                expect(
                    res.status(),
                    `${providerId}/${path} never 5xx (got ${res.status()})`,
                ).toBeLessThan(500);
                expect(res.status(), `${providerId}/${path} → 200 envelope`).toBe(200);
                const body = (await res.json()) as SubResourceEnvelope;

                expect(body.success, `${providerId}/${path} → success:false (disconnected)`).toBe(
                    false,
                );
                if (isList) {
                    const coll = body[collectionKey as 'organizations' | 'repositories'];
                    expect(
                        Array.isArray(coll),
                        `${providerId}/${path} → ${collectionKey} is an array`,
                    ).toBe(true);
                    expect(
                        (coll as unknown[]).length,
                        `${providerId}/${path} → empty ${collectionKey}`,
                    ).toBe(0);
                } else {
                    expect(body.user, `${providerId}/${path} → null user`).toBeNull();
                }

                // The error is the generic, sanitized message — non-empty, matches
                // the documented copy, and leaks NEITHER the caller's userId NOR a token.
                const errStr = String(body.error ?? '');
                expect(errStr.length, `${providerId}/${path} error is non-empty`).toBeGreaterThan(
                    0,
                );
                expect(errStr, `${providerId}/${path} error is the generic sanitized copy`).toMatch(
                    error,
                );
                expect(
                    errStr,
                    `${providerId}/${path} error does NOT leak the caller's userId (sanitized)`,
                ).not.toContain(userA.user.id);
                expectNoTokenLeak(errStr, `${providerId}/${path} error`);
            }
        }
    });
});

test.describe('flow: repositories pagination-param robustness (NaN + over-cap perPage stay a graceful 200 envelope)', () => {
    test('repositories tolerates page=abc&perPage=xyz (parseInt→NaN) AND perPage=500 (controller clamps to 100) — both degrade to the success:false envelope, never a 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // The controller does `page ? parseInt(page,10) : undefined` and
        // `perPage ? Math.min(parseInt(perPage,10),100) : undefined`. A disconnected
        // user never reaches the upstream call, but the param parsing must not
        // explode on NaN or an over-cap value — the envelope stays graceful.
        const paramVariants: Array<{ label: string; query: string }> = [
            { label: 'default (no params)', query: '' },
            { label: 'NaN params', query: '?page=abc&perPage=xyz' },
            { label: 'over-cap perPage', query: '?page=1&perPage=500' },
            { label: 'valid small page', query: '?page=2&perPage=1' },
        ];

        for (const v of paramVariants) {
            const res = await request.get(
                `${API_BASE}/api/git-providers/${PROVIDER}/repositories${v.query}`,
                { headers: h },
            );
            expect(
                res.status(),
                `repositories ${v.label} never 5xx (got ${res.status()})`,
            ).toBeLessThan(500);
            expect(res.status(), `repositories ${v.label} → 200`).toBe(200);
            const body = (await res.json()) as SubResourceEnvelope;
            expect(body.success, `repositories ${v.label} → success:false (disconnected)`).toBe(
                false,
            );
            expect(
                Array.isArray(body.repositories) && body.repositories.length === 0,
                `repositories ${v.label} → empty array`,
            ).toBe(true);
        }
    });
});

test.describe('flow: the git-providers controller is READ-ONLY (route discipline)', () => {
    test('there is no POST /api/git-providers, no DELETE /:p/connection, and the sub-resources are GET-only — all wrong-verb/look-alike routes 404, while the canonical GETs stay 200', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // The list is GET-only — there is no mutation endpoint to create/register a
        // provider. (Disconnect lives on the SEPARATE oauth controller.)
        expect(
            (
                await request.post(`${API_BASE}/api/git-providers`, { headers: h, data: {} })
            ).status(),
            'POST /api/git-providers is not a route → 404',
        ).toBe(404);

        // The look-alike `DELETE /api/git-providers/:p/connection` does NOT exist on
        // THIS controller (connection is GET-only here; the real disconnect is
        // `DELETE /api/oauth/:p`). Pin it so a future route move can't silently
        // graft a destructive verb onto the read-only controller.
        expect(
            (
                await request.delete(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
                    headers: h,
                })
            ).status(),
            'DELETE /api/git-providers/:p/connection is not a route → 404',
        ).toBe(404);

        // The sub-resources are GET-only too — a POST to a read sub-resource 404s.
        expect(
            (
                await request.post(`${API_BASE}/api/git-providers/${PROVIDER}/user`, {
                    headers: h,
                    data: {},
                })
            ).status(),
            'POST /api/git-providers/:p/user is not a route → 404',
        ).toBe(404);

        // The canonical READ routes remain reachable (the controller is not broken,
        // just read-only): list + connection both 200.
        expect(
            (await request.get(`${API_BASE}/api/git-providers`, { headers: h })).status(),
            'GET /api/git-providers stays 200 (read route intact)',
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
                    headers: h,
                })
            ).status(),
            'GET /api/git-providers/:p/connection stays 200',
        ).toBe(200);
    });
});

test.describe('flow: full anon boundary across EVERY git-providers route', () => {
    test('the list, the connection, and all three sub-resources each reject an anonymous caller with 401 (the whole controller is auth-guarded)', async ({
        request,
    }) => {
        // Every route on the controller is behind AuthSessionGuard. A raw
        // unauthenticated `request` (no Authorization header) must 401 on each.
        const routes = [
            `/api/git-providers`,
            `/api/git-providers/${PROVIDER}/connection`,
            `/api/git-providers/${PROVIDER}/organizations`,
            `/api/git-providers/${PROVIDER}/repositories`,
            `/api/git-providers/${PROVIDER}/user`,
        ];
        for (const route of routes) {
            const res = await request.get(`${API_BASE}${route}`);
            expect(res.status(), `anon ${route} → 401`).toBe(401);
        }
    });
});

test.describe('flow: cross-user isolation of the sub-resource envelopes', () => {
    test('two fresh users fan out the same sub-resources and each receives its OWN clean disconnected envelope with no cross-user id leak', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        expect(userA.user.id, 'two distinct user ids').not.toBe(userB.user.id);
        const hA = authedHeaders(userA.access_token);
        const hB = authedHeaders(userB.access_token);

        // Fan out all three sub-resources per user concurrently — each user's
        // envelope must be its own clean disconnected envelope, and neither user's
        // error may name the OTHER user's id (no cross-user leak through the
        // controller's shared service).
        const subPaths = ['organizations', 'repositories', 'user'] as const;

        const fetchAll = (h: Record<string, string>) =>
            Promise.all(
                subPaths.map((p) =>
                    request.get(`${API_BASE}/api/git-providers/${PROVIDER}/${p}`, { headers: h }),
                ),
            );

        const [aResponses, bResponses] = await Promise.all([fetchAll(hA), fetchAll(hB)]);

        for (let i = 0; i < subPaths.length; i++) {
            const path = subPaths[i];

            const aBody = (await aResponses[i].json()) as SubResourceEnvelope;
            expect(aResponses[i].status(), `A ${path} → 200`).toBe(200);
            expect(aBody.success, `A ${path} → success:false`).toBe(false);
            const aErr = String(aBody.error ?? '');
            expect(aErr, `A ${path} error does not leak A's own id`).not.toContain(userA.user.id);
            expect(aErr, `A ${path} error does not name B's id`).not.toContain(userB.user.id);

            const bBody = (await bResponses[i].json()) as SubResourceEnvelope;
            expect(bResponses[i].status(), `B ${path} → 200`).toBe(200);
            expect(bBody.success, `B ${path} → success:false`).toBe(false);
            const bErr = String(bBody.error ?? '');
            expect(bErr, `B ${path} error does not leak B's own id`).not.toContain(userB.user.id);
            expect(bErr, `B ${path} error does not name A's id`).not.toContain(userA.user.id);
        }
    });
});

/**
 * Keep the APIRequestContext type import load-bearing for envs where the inline
 * helper signatures are tree-shaken by the linter.
 */
export type _GitProvidersDeepFlowRequest = APIRequestContext;
