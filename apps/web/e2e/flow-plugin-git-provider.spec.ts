import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-plugin-git-provider — COMPLEX, multi-step git-provider (github) capability
 * flows that go BEYOND the single-endpoint smoke probes already shipped in
 * git-providers.spec.ts, git-providers-oauth-happy.spec.ts, github-app.spec.ts,
 * github-storage-plugin.spec.ts, and the connection/CSRF flows in
 * flow-oauth-git-providers.spec.ts.
 *
 * Gap covered here (NONE of which the existing specs assert end-to-end):
 *   - the REAL disconnect contract: `DELETE /api/oauth/:p` → 204 (the existing
 *     happy-path spec hits the WRONG path `DELETE /api/oauth/:p/connection`
 *     which is a 404 — proving the right verb matters).
 *   - the read-packages OAuth VARIANT (`:p/read-packages/connect/url` +
 *     `:p/callback/plugins/read-packages`) which stores a token in plugin
 *     settings independently of the main connection.
 *   - the plugin connect callback (`:p/callback/plugins`) no-code / unconfigured
 *     contract.
 *   - unknown-provider GRACEFUL resolution (`{ name:'Unknown', enabled:false }`)
 *     on BOTH the git-providers and oauth controllers.
 *   - "work creation is NOT git-gated, but git-backed taxonomy WRITES are" — a
 *     work is created with gitProvider:'github' + githubAppInstalled:false, then
 *     a category write (which needs a git commit) 500s for the unconnected user
 *     while the connection stays false.
 *   - the WEB-tier `callback/plugins` redirect contract (oauth_missing_code /
 *     oauth_invalid_state) + the git-provider settings page auth gate.
 *
 * EVERY shape/status/message below was PROBED against the LIVE stack
 * (API 127.0.0.1:3100 sqlite in-memory CI driver; web 127.0.0.1:3000 next-dev)
 * before the assertions were written. Upstream github.com is NEVER contacted.
 *
 * PROBED CONTRACTS (live):
 *   GET    /api/git-providers                         (authed) → { configured:true,
 *            providers:[{ id:'github', enabled:true, icon, description, homepage }] }
 *   GET    /api/git-providers/:p/connection           (authed) → provider object + { connected:false }
 *            for an UNKNOWN p → 200 { id:p, name:'Unknown', enabled:false, connected:false }
 *   GET    /api/git-providers/:p/{organizations|repositories|user}
 *            (disconnected) → 200 { success:false, <collection>:[]/null,
 *              error:'No connected account found for user <uuid> with provider <p>' }
 *   GET    /api/oauth/providers                        (authed) → { configured:true,
 *            providers:[{ id:'github', name:'GitHub', enabled:true }] }
 *   GET    /api/oauth/:p/connection                    (authed) → { id, name, enabled, connected:false }
 *            unknown p → { id:p, name:'Unknown', enabled:false, connected:false }
 *   GET    /api/oauth/:p/connect/url                   (authed) → in THIS env: 400
 *            { message:'OAuth credentials not configured for provider: <p>', ... }
 *   GET    /api/oauth/:p/read-packages/connect/url     (authed) → same 400 (no clientId/secret)
 *   GET    /api/oauth/:p/user                          (authed, no token) → 200
 *            { success:false, user:null, error:'No valid token for provider <p>' }
 *   GET    /api/oauth/:p/callback/plugins              (authed) →
 *            no code → 400 { message:'Authorization code is required' };
 *            code present + no creds → 400 'OAuth credentials not configured for provider: <p>'
 *   GET    /api/oauth/:p/callback/plugins/read-packages (authed) → same code/creds contract
 *   DELETE /api/oauth/:p                               (authed) → 204 (idempotent disconnect)
 *   DELETE /api/oauth/:p/connection                    → 404 (NOT a route)
 *   POST   /api/works { name, slug, description, organization:false } → 200
 *            { status:'success', work:{ id, gitProvider:'github',
 *              storageProvider:'user-github', githubAppInstalled:false, ... } }
 *   POST   /api/works/:id/categories { name }          → 500 for an unconnected user
 *            (git-backed taxonomy write fails to commit with no connected account)
 *   ALL of the above reject anon with 401.
 *
 * WEB tier (next-dev):
 *   GET /api/oauth/:p/callback/plugins                 → 307 →
 *         /settings/plugins/git-provider?oauth_error=oauth_missing_code&oauth_provider=:p   (no code)
 *         …?oauth_error=oauth_invalid_state&oauth_provider=:p                              (code + bad state)
 *   GET /api/oauth/:p/callback/plugins/read-packages   → 307 (CI) OR 404 (LOCAL next-dev catch-all)
 *   GET /settings/plugins/git-provider                 (anon) → redirects to /login
 *
 * ISOLATION: every MUTATING flow runs on a FRESH registerUserViaAPI() user, never
 * the shared seeded user (a user-scoped disconnect/work would otherwise pollute
 * the seeded account that sibling specs assert against). The seeded user
 * (storageState) is used ONLY for the UI-driven assertion in the final flow.
 */

const PROVIDER = 'github';

interface ProviderListItem {
    id?: string;
    name?: string;
    enabled?: boolean;
}

interface GitConnection {
    id?: string;
    name?: string;
    enabled?: boolean;
    connected?: boolean;
    username?: string;
}

/**
 * The plugin-capability OAuth connect endpoints depend on a clientId/clientSecret
 * credential set that is legitimately absent in CI (the list-level `configured`
 * flag is a SEPARATE facade check). Recognise ONLY the known "not configured"
 * 400 so a genuinely broken endpoint still fails loudly.
 */
async function isUnconfiguredCreds(res: import('@playwright/test').APIResponse): Promise<boolean> {
    if (res.status() !== 400) return false;
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return false;
    }
    const message =
        typeof body === 'object' && body !== null && 'message' in body
            ? String((body as { message: unknown }).message ?? '')
            : '';
    return /not configured|credentials/i.test(message);
}

test.describe('flow: git-provider full connection lifecycle (status → connect entry → disconnect)', () => {
    test('fresh user: capability list agrees with both connection views, connect/url is truthfully unconfigured, every sub-resource fails gracefully, and the REAL disconnect verb is idempotent', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — Anon boundary on the whole surface. The list, the connection,
        // and the disconnect verb are ALL auth-gated.
        expect(
            (await request.get(`${API_BASE}/api/git-providers`)).status(),
            'git-providers list rejects anon',
        ).toBe(401);
        expect(
            (await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`)).status(),
            'connection rejects anon',
        ).toBe(401);
        expect(
            (await request.delete(`${API_BASE}/api/oauth/${PROVIDER}`)).status(),
            'disconnect rejects anon',
        ).toBe(401);

        // STEP 2 — Capability list. github is the DEFAULT git provider: present,
        // enabled, and carries a real descriptor (description + homepage), not a
        // bare id.
        const listRes = await request.get(`${API_BASE}/api/git-providers`, { headers: h });
        expect(listRes.status(), 'git-providers list 200').toBe(200);
        const listBody = await listRes.json();
        expect(typeof listBody.configured, 'list has configured flag').toBe('boolean');
        expect(Array.isArray(listBody.providers), 'list providers is an array').toBe(true);
        const github = (listBody.providers as ProviderListItem[]).find((p) => p.id === PROVIDER);
        expect(github, 'github is the default git provider').toBeTruthy();
        expect(github?.enabled, 'github git provider is enabled').toBe(true);
        expect(
            typeof (github as { homepage?: string }).homepage,
            'github descriptor carries a homepage (real plugin metadata)',
        ).toBe('string');

        // STEP 3 — Two independent NOT-connected views must AGREE. The git-provider
        // view echoes the rich descriptor; the oauth view echoes the display name.
        const gpConn = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(gpConn.status(), 'git-providers connection 200').toBe(200);
        const gpConnBody = (await gpConn.json()) as GitConnection;
        expect(gpConnBody.id, 'git-providers connection echoes id').toBe(PROVIDER);
        expect(gpConnBody.connected, 'fresh user NOT connected (git view)').toBe(false);
        // No connection → no leaked username/email.
        expect(gpConnBody.username, 'disconnected connection leaks no username').toBeUndefined();

        const oauthConn = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(oauthConn.status(), 'oauth connection 200').toBe(200);
        const oauthConnBody = (await oauthConn.json()) as GitConnection;
        expect(oauthConnBody.id, 'oauth connection echoes id').toBe(PROVIDER);
        expect(oauthConnBody.name, 'oauth connection echoes display name').toBe('GitHub');
        expect(oauthConnBody.connected, 'fresh user NOT connected (oauth view) — views agree').toBe(
            false,
        );

        // STEP 4 — The connect entry-point. ENVIRONMENT-ADAPTIVE: when the
        // plugin-capability OAuth clientId/secret are wired it returns { url,state };
        // in THIS CI env it returns a truthful 400 'OAuth credentials not
        // configured'. Both are valid — never 5xx, never a fabricated url.
        const connectRes = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connect/url`, {
            headers: h,
        });
        expect(
            connectRes.status(),
            `connect/url never 5xx (got ${connectRes.status()})`,
        ).toBeLessThan(500);
        if (await isUnconfiguredCreds(connectRes)) {
            const body = await connectRes.json();
            expect(String(body.message), 'unconfigured connect/url names the provider').toMatch(
                new RegExp(`not configured for provider: ${PROVIDER}`, 'i'),
            );
        } else {
            expect(connectRes.status(), 'configured connect/url 200').toBe(200);
            const body = await connectRes.json();
            expect(typeof body.url, 'connect/url returns a string url').toBe('string');
            expect(body.url, 'connect/url points at github authorize').toMatch(
                /^https:\/\/github\.com\/login\/oauth\/authorize/i,
            );
            expect(
                new URL(body.url).searchParams.get('state'),
                'connect/url embeds its state',
            ).toBe(body.state);
        }

        // STEP 5 — Every downstream sub-resource degrades gracefully (200 envelope
        // with success:false; NEVER 5xx, NEVER a leaked token). The list-type
        // resources default to [] and the user resource to null.
        const subResources: Array<{
            path: string;
            key: 'organizations' | 'repositories' | 'user';
        }> = [
            { path: 'organizations', key: 'organizations' },
            { path: 'repositories', key: 'repositories' },
            { path: 'user', key: 'user' },
        ];
        for (const { path, key } of subResources) {
            const r = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/${path}`, {
                headers: h,
            });
            expect(r.status(), `git-providers/${path} never 5xx`).toBeLessThan(500);
            if (r.status() === 200) {
                const body = await r.json();
                expect(typeof body.success, `git-providers/${path} has a success flag`).toBe(
                    'boolean',
                );
                if (body.success === false) {
                    if (key === 'user') {
                        expect(body.user, `disconnected ${path} → null user`).toBeNull();
                    } else {
                        expect(Array.isArray(body[key]), `disconnected ${path} → array`).toBe(true);
                        expect(body[key].length, `disconnected ${path} → empty`).toBe(0);
                    }
                    // EW-721 Wave J (#1264): the error is a SANITIZED generic
                    // message (the old detail named the provider AND the
                    // caller's userId — an identifier leak). It must be
                    // non-empty and must NOT leak a token.
                    expect(
                        String(body.error).length,
                        `disconnected ${path} error is a non-empty generic message`,
                    ).toBeGreaterThan(0);
                    expect(
                        String(body.error),
                        `disconnected ${path} error leaks no token`,
                    ).not.toMatch(/gh[pousr]_[A-Za-z0-9]/);
                }
            }
        }

        // STEP 6 — Disconnect. The CORRECT verb is `DELETE /api/oauth/:p` (→ 204),
        // idempotent for an already-disconnected user. The look-alike
        // `DELETE /api/oauth/:p/connection` is NOT a route (404) — pin both so a
        // future route rename can't silently swap them.
        const wrongDisconnect = await request.delete(
            `${API_BASE}/api/oauth/${PROVIDER}/connection`,
            { headers: h },
        );
        expect(wrongDisconnect.status(), 'DELETE :p/connection is not a route (404)').toBe(404);

        const disconnect = await request.delete(`${API_BASE}/api/oauth/${PROVIDER}`, {
            headers: h,
        });
        expect(disconnect.status(), 'DELETE :p disconnects idempotently (204)').toBe(204);

        // STEP 7 — Disconnect is a no-op for a user who never connected: the
        // connection still reports false afterwards.
        const afterConn = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(afterConn.status(), 'post-disconnect connection 200').toBe(200);
        expect(
            ((await afterConn.json()) as GitConnection).connected,
            'still NOT connected after idempotent disconnect',
        ).toBe(false);
    });
});

test.describe('flow: read-packages OAuth variant is a SEPARATE token track from the main connection', () => {
    test('read-packages connect/url + callback are independently gated and never mutate the main git connection', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — Anon boundary on the read-packages variant.
        expect(
            (
                await request.get(`${API_BASE}/api/oauth/${PROVIDER}/read-packages/connect/url`)
            ).status(),
            'read-packages connect/url rejects anon',
        ).toBe(401);
        expect(
            (
                await request.get(
                    `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins/read-packages?code=x`,
                )
            ).status(),
            'read-packages callback rejects anon',
        ).toBe(401);

        // STEP 2 — The read-packages connect/url shares the same credential
        // requirement as the main connect/url. Both are environment-adaptive: a
        // truthful "not configured" 400 here OR a github authorize url. The
        // resulting token (when configured) requests read:packages+write:packages
        // and lands in plugin settings, NOT the main OAuth connection.
        const rpUrl = await request.get(
            `${API_BASE}/api/oauth/${PROVIDER}/read-packages/connect/url`,
            { headers: h },
        );
        expect(rpUrl.status(), `read-packages connect/url never 5xx`).toBeLessThan(500);
        if (await isUnconfiguredCreds(rpUrl)) {
            expect(
                String((await rpUrl.json()).message),
                'read-packages connect/url names the provider when unconfigured',
            ).toMatch(new RegExp(`not configured for provider: ${PROVIDER}`, 'i'));
        } else {
            const body = await rpUrl.json();
            expect(typeof body.url, 'configured read-packages url is a string').toBe('string');
            expect(body.url, 'configured read-packages url points at github').toMatch(
                /^https:\/\/github\.com\/login\/oauth\/authorize/i,
            );
        }

        // STEP 3 — The read-packages callback requires a code FIRST (before any
        // credential lookup): no code → 400 'Authorization code is required'.
        const noCode = await request.get(
            `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins/read-packages`,
            { headers: h },
        );
        expect(noCode.status(), 'read-packages callback no-code → 400').toBe(400);
        expect(String((await noCode.json()).message), 'no-code message').toMatch(
            /authorization code is required/i,
        );

        // STEP 4 — With a (fake) code but no wired creds, the exchange step trips
        // the same 'not configured' guard — proving the code check passes first.
        const withCode = await request.get(
            `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins/read-packages?code=e2e-fake-code&state=abc`,
            { headers: h },
        );
        expect(withCode.status(), 'read-packages callback w/ code never 5xx').toBeLessThan(500);
        if (await isUnconfiguredCreds(withCode)) {
            expect(
                String((await withCode.json()).message),
                'w/ code falls through to the credential guard',
            ).toMatch(new RegExp(`not configured for provider: ${PROVIDER}`, 'i'));
        }

        // STEP 5 — Critically, NONE of the read-packages calls touched the MAIN
        // git connection. It is still false (the read-packages token track is
        // independent of authAccountRepository).
        const conn = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(conn.status(), 'main connection still readable').toBe(200);
        expect(
            ((await conn.json()) as GitConnection).connected,
            'read-packages flow never connected the MAIN git provider',
        ).toBe(false);
    });
});

test.describe('flow: plugin connect callback + oauth/user contract (no fabricated identity)', () => {
    test('callback/plugins enforces code-before-creds, and oauth/:p/user reports a truthful no-token failure', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 1 — The plugin connect callback (distinct from the social-login
        // callback) is auth-gated and requires a code before anything else.
        expect(
            (
                await request.get(`${API_BASE}/api/oauth/${PROVIDER}/callback/plugins?code=x`)
            ).status(),
            'callback/plugins rejects anon',
        ).toBe(401);

        const noCode = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/callback/plugins`, {
            headers: h,
        });
        expect(noCode.status(), 'callback/plugins no-code → 400').toBe(400);
        expect(String((await noCode.json()).message), 'no-code message').toMatch(
            /authorization code is required/i,
        );

        // STEP 2 — A fake code with no wired creds trips the credential guard
        // (proving the exchange is attempted only AFTER the code check). The
        // connection must remain unconnected — the fake code is never honoured.
        const withCode = await request.get(
            `${API_BASE}/api/oauth/${PROVIDER}/callback/plugins?code=e2e-fake-code&state=zzz`,
            { headers: h },
        );
        expect(withCode.status(), 'callback/plugins w/ code never 5xx').toBeLessThan(500);
        if (await isUnconfiguredCreds(withCode)) {
            expect(String((await withCode.json()).message), 'w/ code → credential guard').toMatch(
                new RegExp(`not configured for provider: ${PROVIDER}`, 'i'),
            );
        }

        // STEP 3 — oauth/:p/user for a user with no token. The controller catches
        // the BadRequest and returns a 200 ENVELOPE { success:false, user:null }
        // — never a fabricated user, never a 5xx.
        const userRes = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/user`, { headers: h });
        expect(userRes.status(), 'oauth/:p/user → 200 envelope').toBe(200);
        const userBody = await userRes.json();
        expect(userBody.success, 'no-token user → success:false').toBe(false);
        expect(userBody.user, 'no-token user → null user').toBeNull();
        expect(String(userBody.error), 'no-token error names the provider').toMatch(
            new RegExp(`no valid token for provider ${PROVIDER}`, 'i'),
        );

        // STEP 4 — The whole no-op sequence left the connection unconnected.
        const conn = await request.get(`${API_BASE}/api/oauth/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(((await conn.json()) as GitConnection).connected, 'still unconnected').toBe(false);
    });
});

test.describe('flow: unknown git provider resolves gracefully on BOTH controllers', () => {
    test('an unrecognised provider id yields a uniform {name:Unknown, enabled:false, connected:false} on git AND oauth views, with graceful sub-resources', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // A provider id that is NOT in the enabled allowlist (gitlab is a known
        // name but not wired in this env; bitbucket is wholly unknown). The
        // service short-circuits to a synthetic descriptor rather than throwing.
        const unknownIds = ['gitlab', 'bitbucket'];

        for (const pid of unknownIds) {
            // git-providers view.
            const gp = await request.get(`${API_BASE}/api/git-providers/${pid}/connection`, {
                headers: h,
            });
            expect(gp.status(), `git ${pid} connection → 200 (graceful)`).toBe(200);
            const gpBody = (await gp.json()) as GitConnection;
            expect(gpBody.id, `git ${pid} echoes id`).toBe(pid);
            expect(gpBody.name, `git ${pid} → name 'Unknown'`).toBe('Unknown');
            expect(gpBody.enabled, `git ${pid} → enabled:false`).toBe(false);
            expect(gpBody.connected, `git ${pid} → connected:false`).toBe(false);

            // oauth view — identical synthetic shape.
            const oa = await request.get(`${API_BASE}/api/oauth/${pid}/connection`, { headers: h });
            expect(oa.status(), `oauth ${pid} connection → 200 (graceful)`).toBe(200);
            const oaBody = (await oa.json()) as GitConnection;
            expect(oaBody.id, `oauth ${pid} echoes id`).toBe(pid);
            expect(oaBody.name, `oauth ${pid} → name 'Unknown'`).toBe('Unknown');
            expect(oaBody.enabled, `oauth ${pid} → enabled:false`).toBe(false);
            expect(oaBody.connected, `oauth ${pid} → connected:false`).toBe(false);
        }

        // Sub-resources on an unknown provider must also degrade (no 5xx): they
        // return the success:false envelope, never crash on the missing plugin.
        for (const path of ['organizations', 'repositories', 'user']) {
            const r = await request.get(`${API_BASE}/api/git-providers/gitlab/${path}`, {
                headers: h,
            });
            expect(r.status(), `unknown gitlab/${path} never 5xx`).toBeLessThan(500);
            if (r.status() === 200) {
                expect(typeof (await r.json()).success, `gitlab/${path} has success flag`).toBe(
                    'boolean',
                );
            }
        }

        // The connect/url for an unknown provider must NOT mint a url — it either
        // rejects the provider or trips the credential guard. Never 5xx, never a
        // fabricated authorize url for a provider that doesn't exist.
        const connect = await request.get(`${API_BASE}/api/oauth/bitbucket/connect/url`, {
            headers: h,
        });
        expect(connect.status(), 'unknown connect/url never 5xx').toBeLessThan(500);
        expect(connect.status(), 'unknown connect/url does not 200 a fabricated url').not.toBe(200);
    });
});

test.describe('flow: work creation is NOT git-gated, but git-backed taxonomy WRITES are', () => {
    test('a fresh disconnected user can CREATE a github-backed work, yet a category write (needs a git commit) is gated while the connection stays false', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);

        // STEP 0 — Baseline: the user is NOT connected to github.
        const before = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(((await before.json()) as GitConnection).connected, 'starts disconnected').toBe(
            false,
        );

        // STEP 1 — Work creation SUCCEEDS without any git connection. The work is
        // stamped with the default git/storage providers but no installed app.
        const slug = `e2e-git-gate-${Date.now().toString(36)}`;
        const created = await createWorkViaAPI(request, u.access_token, {
            name: `Git Gate ${slug}`,
            slug,
            description: 'git-gating probe',
        });
        expect(created.id, 'work created with an id (creation is not git-gated)').toBeTruthy();
        const raw = created.raw as { work?: Record<string, unknown> };
        const work = raw.work ?? {};
        expect(work.gitProvider, 'work defaults to gitProvider github').toBe('github');
        expect(work.storageProvider, 'work defaults to user-github storage').toBe('user-github');
        // No GitHub App installed for a disconnected user.
        expect(work.githubAppInstalled, 'fresh work has no installed github app').toBe(false);

        // STEP 2 — A git-backed TAXONOMY write is gated. createCategory commits to
        // the work's data repo; with no connected account the commit fails. The
        // platform surfaces this as a 5xx (the documented git-gated failure) — the
        // key guarantee is that it FAILS rather than silently fabricating a commit.
        const catRes = await request.post(`${API_BASE}/api/works/${created.id}/categories`, {
            headers: h,
            data: { name: 'Gated Category' },
        });
        expect(
            catRes.status(),
            `category write on a disconnected work is gated (got ${catRes.status()})`,
        ).toBeGreaterThanOrEqual(400);

        // STEP 3 — The gated write did NOT side-effect a connection. The user is
        // still disconnected from github after the failed git-backed operation.
        const after = await request.get(`${API_BASE}/api/git-providers/${PROVIDER}/connection`, {
            headers: h,
        });
        expect(after.status(), 'connection still readable').toBe(200);
        expect(
            ((await after.json()) as GitConnection).connected,
            'a failed git-gated write never flips the connection to connected',
        ).toBe(false);
    });
});

test.describe('flow: web-tier git-provider callback redirect contract + settings auth gate', () => {
    test('the connect callback redirects with the right oauth_error code, read-packages tolerates next-dev divergence, and the settings page is auth-gated', async ({
        page,
        baseURL,
    }) => {
        const webBase = baseURL || 'http://localhost:3000';

        // STEP 1 — The WEB plugin callback is the real OAuth redirect_uri target.
        // With NO code it redirects (307) to the git-provider settings page with
        // oauth_error=oauth_missing_code. We probe WITHOUT following so we can pin
        // the Location contract exactly.
        const noCode = await page.request.get(`${webBase}/api/oauth/${PROVIDER}/callback/plugins`, {
            maxRedirects: 0,
        });
        expect(noCode.status(), `web callback no-code is a redirect (got ${noCode.status()})`).toBe(
            307,
        );
        const noCodeLoc = noCode.headers()['location'] ?? '';
        expect(noCodeLoc, 'no-code redirect lands on the git-provider settings page').toContain(
            '/settings/plugins/git-provider',
        );
        expect(noCodeLoc, 'no-code redirect carries oauth_error=oauth_missing_code').toContain(
            'oauth_error=oauth_missing_code',
        );
        expect(noCodeLoc, 'redirect echoes the provider').toContain(`oauth_provider=${PROVIDER}`);

        // STEP 2 — A code WITH a state that has no matching cookie trips the C-03
        // CSRF guard (state present but != stored) → oauth_invalid_state. The code
        // check passes first; the state check is what rejects here.
        const badState = await page.request.get(
            `${webBase}/api/oauth/${PROVIDER}/callback/plugins?code=e2e-fake-code&state=e2e-bogus-state`,
            { maxRedirects: 0 },
        );
        expect(badState.status(), 'web callback bad-state is a redirect').toBe(307);
        const badStateLoc = badState.headers()['location'] ?? '';
        expect(badStateLoc, 'bad-state redirect carries oauth_error=oauth_invalid_state').toContain(
            'oauth_error=oauth_invalid_state',
        );

        // STEP 3 — The read-packages web callback is a deeper nested route that
        // renders in CI but can 404 to the catch-all under next-dev LOCALLY. Assert
        // the resilient union: either a redirect (307 with the oauth_* contract) OR
        // a clean 404. NEVER a 5xx.
        const rp = await page.request.get(
            `${webBase}/api/oauth/${PROVIDER}/callback/plugins/read-packages`,
            { maxRedirects: 0 },
        );
        expect(
            rp.status(),
            `read-packages web callback never 5xx (got ${rp.status()})`,
        ).toBeLessThan(500);
        if (rp.status() === 307) {
            const rpLoc = rp.headers()['location'] ?? '';
            expect(rpLoc, 'read-packages redirect lands on git-provider settings').toContain(
                '/settings/plugins/git-provider',
            );
            expect(rpLoc, 'read-packages redirect carries the read_packages intent').toContain(
                'oauth_intent=read_packages',
            );
        } else {
            expect(rp.status(), 'otherwise a clean local 404').toBe(404);
        }

        // STEP 4 — The git-provider settings page is auth-gated. Driven anon (an
        // empty storageState context strips the inherited auth cookie) it must
        // funnel to /login rather than render the connections panel.
        const anon = await page
            .context()
            .browser()
            ?.newContext({
                storageState: { cookies: [], origins: [] },
            });
        expect(anon, 'anon context created').toBeTruthy();
        const anonPage = await anon!.newPage();
        try {
            await anonPage.goto(`${webBase}/settings/plugins/git-provider`, {
                waitUntil: 'domcontentloaded',
            });
            await expect
                .poll(() => anonPage.url(), {
                    message: 'anon settings/git-provider funnels to /login',
                    timeout: 20_000,
                })
                .toContain('/login');
        } finally {
            await anonPage.close();
            await anon!.close();
        }
    });
});

test.describe('flow: authenticated git-provider settings page renders the github connection (UI)', () => {
    test('the seeded user can open the git-provider settings page and see the github connect affordance in a not-connected state', async ({
        page,
        baseURL,
        request,
    }) => {
        const webBase = baseURL || 'http://localhost:3000';

        // Confirm via API that the seeded user is NOT connected — so the UI must
        // render a CONNECT (not a disconnect) affordance. Best-effort: the page
        // assertion below is the load-bearing one and tolerates either state.
        const seeded = loadSeededTestUser();
        let seededConnected: boolean | undefined;
        try {
            const login = await request.post(`${API_BASE}/api/auth/login`, {
                data: { email: seeded.email, password: seeded.password },
            });
            if (login.ok()) {
                const { access_token } = await login.json();
                const conn = await request.get(
                    `${API_BASE}/api/git-providers/${PROVIDER}/connection`,
                    { headers: authedHeaders(access_token) },
                );
                if (conn.ok()) {
                    seededConnected = ((await conn.json()) as GitConnection).connected;
                }
            }
        } catch {
            // Non-fatal — the UI assertion does not depend on this.
        }

        // Drive the authenticated UI (storageState supplies the seeded session).
        // next-dev locale handling may serve the page at /settings/... or
        // /en/settings/... — assert resilient to both and to the cold-compile.
        const resp = await page.goto(`${webBase}/settings/plugins/git-provider`, {
            waitUntil: 'domcontentloaded',
        });
        expect(
            resp?.status() ?? 200,
            `settings page does not 5xx (schema render crash?)`,
        ).toBeLessThan(500);

        // The authenticated user must NOT be bounced to /login.
        await expect
            .poll(() => page.url(), { message: 'authed user stays on settings', timeout: 20_000 })
            .not.toContain('/login');

        // The Git Provider Connections panel surfaces the github connect entry.
        // i18n: gitProvider.settings.title='Git Provider Connections';
        // the connect button reads 'Connect GitHub'. Either the panel heading or
        // the github connect/connection control proves the page rendered.
        const panel = page
            .getByText(/Git Provider Connections/i)
            .or(page.getByRole('heading', { name: /Git Provider/i }))
            .or(page.getByText(/Connect GitHub/i))
            .or(page.getByText(/\bGitHub\b/i))
            .first();
        await expect(panel, 'git-provider settings panel renders github').toBeVisible({
            timeout: 20_000,
        });

        // If we confirmed the seeded user is not connected, the page must NOT be
        // asserting a connected username. Best-effort, branch-only.
        if (seededConnected === false) {
            const connectAffordance = page
                .getByRole('button', { name: /Connect/i })
                .or(page.getByText(/Connect to create works/i))
                .or(page.getByText(/Connect GitHub/i))
                .first();
            await expect(
                connectAffordance,
                'not-connected seeded user sees a connect affordance',
            ).toBeVisible({ timeout: 20_000 });
        }
    });
});

/**
 * Keep the APIRequestContext type import load-bearing for envs where the inline
 * helper signature is tree-shaken by the linter.
 */
export type _GitProviderFlowRequest = APIRequestContext;
