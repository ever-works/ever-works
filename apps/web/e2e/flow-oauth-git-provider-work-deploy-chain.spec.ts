import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

/**
 * FLOW: OAUTH GIT-PROVIDER CONNECT → WORK GIT-BINDING → DEPLOY-READINESS CHAIN.
 *
 * This file walks the VERTICAL stitch that no sibling owns: the `connected:false`
 * state that a fresh user has on BOTH the OAuth capability surface AND the
 * git-provider capability surface is the ROOT CAUSE that propagates all the way
 * downstream into a `409 NoGitCredentialsError` on a git-backed publish
 * operation — while the Work's `storageProvider` binding (chosen at birth,
 * immutable thereafter) records WHICH git backend that 409 pertains to, and the
 * deploy-credential gate refuses the OTHER half of publish with a DIFFERENT
 * status/provider. The stack is keyless (sqlite in-memory, no OAuth app creds,
 * no git connection, no Vercel/k8s token), so NOTHING ever connects or deploys:
 * we pin the CONNECT-STATE, the BIRTH-BINDING, and the TWO divergent
 * publish-preconditions as one coherent chain.
 *
 * ── NON-DUPLICATION (checked live against every sibling on 2026-07-21) ────────
 * The oauth/git-provider/deploy surfaces are individually well covered; this file
 * is deliberately DISJOINT and owns the CROSS-FEATURE CHAIN, not any one surface:
 *   - flow-oauth-git-providers / flow-oauth-providers-deep — the OAuth provider
 *       taxonomy + authorize-URL loop. THIS file uses connect/url only to prove the
 *       state-cookie is minted BEFORE the unconfigured-400, then pivots downstream.
 *   - flow-git-provider-connection{,-multistep} / flow-git-providers-deep — the
 *       connection RECORD isolation + the git-gated TAXONOMY writes. THIS file uses
 *       a DIFFERENT git-gated surface (POST /api/templates/fork) that no spec asserts,
 *       and joins it to the storageProvider binding + the deploy half.
 *   - flow-taxonomy-git-gating-deep / flow-facade-error-mapping — the 409 via
 *       collections/community-PR taxonomy writes. THIS file pins the 409 via the
 *       TEMPLATE-FORK path, which has an EXTRA resolution layer (DTO 400 →
 *       template-not-found 404 → git-creds 409) the taxonomy path lacks.
 *   - flow-work-kind-variants — storageProvider STICKS VERBATIM at create. THIS
 *       file adds the IMMUTABILITY invariant (PATCH storageProvider is forbidden)
 *       and contrasts it against the MUTABLE deployProvider.
 *   - flow-work-deploy-*-chain — the deploy verb surface. THIS file touches deploy
 *       only to show the git-gate (409) and deploy-gate (400) are TWO distinct
 *       preconditions on ONE disconnected user, and that deploy is storageProvider-agnostic.
 * NEW angles: (1) the OAuth provider set is a SUPERSET of the git-provider set
 * (vercel is OAuth-only); (2) github's descriptor DIFFERS across the two surfaces
 * (oauth carries `name`, git-provider carries icon/description/homepage); (3) the
 * fork git-gate ORDER (400→404→409); (4) storageProvider is birth-bound + immutable
 * while deployProvider is mutable; (5) the SAME disconnected user faces git-409 (github)
 * vs deploy-400 (vercel) — the two halves of publish diverge; (6) the whole walk leaves
 * both connection surfaces false and the Work's deploy columns idle.
 *
 * ── PROBED CONTRACTS (verified live @127.0.0.1:3100, 2026-07-21) ──────────────
 *  GET  /api/oauth/providers            → { configured:true, providers:[{id:github,name:GitHub,enabled:true},
 *                                            {id:vercel,name:Vercel,enabled:true}] }
 *  GET  /api/oauth/:p/connection        → { id, name, enabled, connected:false }
 *  GET  /api/oauth/:p/connect/url       → 400 'OAuth credentials not configured for provider: :p'
 *                                          AND Set-Cookie ew_oauth_state=..; Path=/api/oauth; Max-Age=600; HttpOnly; SameSite=Lax
 *                                          (state minted BEFORE the credential lookup — cookie present on the 400)
 *  GET  /api/oauth/:p/callback/plugins  → no code → 400 'Authorization code is required';
 *                                          code+state, no cookie → 400 'OAuth state verification failed: missing state cookie'
 *  DELETE /api/oauth/:p                 → 204 (idempotent; connection stays false)
 *  GET  /api/git-providers              → { configured:true, providers:[{id:github,enabled:true,icon,description,homepage}] } (NO name)
 *  GET  /api/git-providers/:p/connection→ list-entry + connected:false; unknown → {id,name:'Unknown',enabled:false,connected:false}
 *  GET  /api/git-providers/:p/{user,organizations,repositories} → 200 {success:false,<coll>:[]|null,error:'Failed to fetch ...'}
 *  POST /api/works {storageProvider,gitProvider,deployProvider} → echoes storageProvider verbatim (free-form, default user-github);
 *                                          PATCH {storageProvider} → 400 'property storageProvider should not exist' (immutable);
 *                                          PATCH {deployProvider:'k8s'} → 200 (mutable)
 *  GET  /api/templates?kind=website     → { status:success, defaultTemplateId:'classic', templates:[{id:'classic'},..] }
 *  POST /api/templates/fork {kind,templateId,targetOwner}:
 *        resolvable template + no git conn → 409 { statusCode:409, error:'NoGitCredentialsError',
 *              message:'No connected account found for user <uid> with provider github' }
 *        unknown templateId → 404 'Template not found for this user and kind.'
 *        invalid kind / missing targetOwner / extra key → 400; anon → 401; GET → 404
 *  POST /api/deploy/works/:id/check     → 201 { status:success, canDeploy:false, ownerHasToken:false, userHasToken:false }
 *  POST /api/deploy/works/:id           → 400 'Vercel token is required. Please configure it...'
 *
 * Cross-spec isolation: EVERY test builds on FRESH registerUserViaAPI() users with unique
 * suffixes; message assertions tie to the caller's OWN user id via toContain; list assertions
 * use exact/sorted shapes, never global counts. No module-scope data loading.
 */

const OAUTH = `${API_BASE}/api/oauth`;
const GITP = `${API_BASE}/api/git-providers`;
const WORKS = `${API_BASE}/api/works`;
const FORK = `${API_BASE}/api/templates/fork`;
const DEPLOY = `${API_BASE}/api/deploy`;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

/** Extract every Set-Cookie value from a response, tolerant of combined/array forms. */
function setCookies(res: import('@playwright/test').APIResponse): string {
    const arr = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    if (arr.length) return arr.map((h) => h.value).join('\n');
    return res.headers()['set-cookie'] ?? '';
}

interface BoundWork {
    id: string;
    storageProvider: string;
    gitProvider: string;
    deployProvider: string | null;
    website: string | null;
    deploymentState: string | null;
}

/** Create a Work with explicit git/storage/deploy binding (not covered by the shared helper). */
async function createBoundWork(
    request: APIRequestContext,
    token: string,
    opts: {
        label?: string;
        storageProvider?: string;
        gitProvider?: string;
        deployProvider?: string;
    } = {},
): Promise<BoundWork> {
    const s = stamp();
    const data: Record<string, unknown> = {
        name: `${opts.label ?? 'Chain Work'} ${s}`,
        slug: `chain-${s}`,
        description: 'oauth→git→deploy chain probe',
        organization: false,
    };
    if (opts.storageProvider !== undefined) data.storageProvider = opts.storageProvider;
    if (opts.gitProvider !== undefined) data.gitProvider = opts.gitProvider;
    if (opts.deployProvider !== undefined) data.deployProvider = opts.deployProvider;

    const res = await request.post(WORKS, { headers: authedHeaders(token), data });
    // NB: works creation answers 200 (not the REST-conventional 201) — the
    // controller returns the {status,work} envelope without an explicit 201.
    expect(res.status(), `create work (${await res.text().catch(() => '')})`).toBe(200);
    const body = (await res.json()) as { work: Record<string, unknown> };
    const w = body.work;
    return {
        id: String(w.id),
        storageProvider: String(w.storageProvider),
        gitProvider: String(w.gitProvider),
        deployProvider: (w.deployProvider ?? null) as string | null,
        website: (w.website ?? null) as string | null,
        deploymentState: (w.deploymentState ?? null) as string | null,
    };
}

/** Read the raw Work row (unwraps the { work } envelope). */
async function readWork(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${WORKS}/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `read work ${id}`).toBe(200);
    const body = (await res.json()) as { work?: Record<string, unknown> };
    return body.work ?? (body as Record<string, unknown>);
}

/** Resolve a real, forkable website templateId from the live catalog. */
async function resolvableWebsiteTemplateId(
    request: APIRequestContext,
    token: string,
): Promise<string> {
    const res = await request.get(`${API_BASE}/api/templates?kind=website`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'website template catalog').toBe(200);
    const body = (await res.json()) as {
        status: string;
        defaultTemplateId?: string;
        templates?: Array<{ id: string }>;
    };
    expect(body.status).toBe('success');
    return body.defaultTemplateId || body.templates?.[0]?.id || 'classic';
}

async function forkAttempt(
    request: APIRequestContext,
    token: string | undefined,
    payload: Record<string, unknown>,
) {
    return request.post(FORK, {
        headers: token ? authedHeaders(token) : undefined,
        data: payload,
    });
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 1 — the two connect surfaces reconcile on a disconnected user', () => {
    test('the OAuth provider set is a SUPERSET of the git-provider set: github lives in BOTH, vercel is OAuth-only', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const oauthRes = await request.get(`${OAUTH}/providers`, { headers: h });
        const gitRes = await request.get(GITP, { headers: h });
        expect(oauthRes.status()).toBe(200);
        expect(gitRes.status()).toBe(200);

        const oauth = (await oauthRes.json()) as {
            configured: boolean;
            providers: Array<{ id: string; name: string; enabled: boolean }>;
        };
        const git = (await gitRes.json()) as {
            configured: boolean;
            providers: Array<{ id: string; enabled: boolean }>;
        };

        // Both capability lists advertise themselves configured (plugins loaded).
        expect(oauth.configured).toBe(true);
        expect(git.configured).toBe(true);

        const oauthIds = oauth.providers.map((p) => p.id).sort();
        const gitIds = git.providers.map((p) => p.id).sort();
        // OAuth carries github + vercel; git-providers carries only github.
        expect(oauthIds).toContain('github');
        expect(oauthIds).toContain('vercel');
        expect(gitIds).toEqual(['github']);
        // github is in BOTH; vercel (deploy/oauth) is NOT a git provider.
        expect(gitIds).toContain('github');
        expect(gitIds).not.toContain('vercel');
        // OAuth entries carry a human name; every advertised provider is enabled.
        expect(oauth.providers.every((p) => p.enabled)).toBe(true);
        expect(oauth.providers.find((p) => p.id === 'github')?.name).toBe('GitHub');
        expect(oauth.providers.find((p) => p.id === 'vercel')?.name).toBe('Vercel');
    });

    test("github's connection descriptor DIFFERS across surfaces (oauth carries `name`, git-provider carries icon/description/homepage) yet BOTH agree connected:false", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const oauthConn = (await (
            await request.get(`${OAUTH}/github/connection`, { headers: h })
        ).json()) as { id: string; name: string; enabled: boolean; connected: boolean };
        const gitConn = (await (
            await request.get(`${GITP}/github/connection`, { headers: h })
        ).json()) as {
            id: string;
            enabled: boolean;
            connected: boolean;
            description?: string;
            homepage?: string;
            icon?: unknown;
        };

        // Same identity + same enabled + same fresh-user disconnected verdict.
        expect(oauthConn.id).toBe('github');
        expect(gitConn.id).toBe('github');
        expect(oauthConn.enabled).toBe(true);
        expect(gitConn.enabled).toBe(true);
        expect(oauthConn.connected).toBe(false);
        expect(gitConn.connected).toBe(false);

        // Divergent descriptor shape: oauth has a human name; git-provider carries
        // rich plugin metadata (icon/description/homepage) instead.
        expect(oauthConn.name).toBe('GitHub');
        expect(gitConn.description).toMatch(/GitHub/i);
        expect(gitConn.homepage).toBe('https://github.com');
        expect(gitConn.icon).toBeTruthy();
    });

    test('an UNKNOWN provider resolves to the SAME benign disabled stub on BOTH surfaces; anon is 401 on both', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const base of [OAUTH, GITP]) {
            const res = await request.get(`${base}/definitely-not-real/connection`, { headers: h });
            expect(res.status(), `${base} unknown connection`).toBe(200);
            expect(await res.json()).toEqual({
                id: 'definitely-not-real',
                name: 'Unknown',
                enabled: false,
                connected: false,
            });
        }

        // Both capability surfaces are auth-guarded.
        expect((await request.get(`${OAUTH}/github/connection`)).status()).toBe(401);
        expect((await request.get(`${GITP}/github/connection`)).status()).toBe(401);
        expect((await request.get(`${OAUTH}/providers`)).status()).toBe(401);
        expect((await request.get(GITP)).status()).toBe(401);
    });

    test('the git-provider capability READS (user/organizations/repositories) degrade GRACEFULLY to a 200 {success:false} envelope for a disconnected user — never a 4xx/5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const userRes = await request.get(`${GITP}/github/user`, { headers: h });
        const orgRes = await request.get(`${GITP}/github/organizations`, { headers: h });
        const repoRes = await request.get(`${GITP}/github/repositories`, { headers: h });

        expect(userRes.status()).toBe(200);
        expect(orgRes.status()).toBe(200);
        expect(repoRes.status()).toBe(200);

        expect(await userRes.json()).toMatchObject({ success: false, user: null });
        expect(await orgRes.json()).toMatchObject({ success: false, organizations: [] });
        expect(await repoRes.json()).toMatchObject({ success: false, repositories: [] });
        // The read surface stays open even though the WRITE surface (fork) is a hard 409.
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 2 — the OAuth connect-entry / callback / disconnect lifecycle', () => {
    test('connect/url for an unconfigured provider is a 400 BUT still mints the ew_oauth_state HttpOnly cookie (state minted BEFORE the credential lookup) — for github AND vercel', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const provider of ['github', 'vercel']) {
            const res = await request.get(`${OAUTH}/${provider}/connect/url`, { headers: h });
            expect(res.status(), `${provider} connect/url unconfigured`).toBe(400);
            expect(msgOf(await res.json())).toMatch(
                new RegExp(`OAuth credentials not configured for provider: ${provider}`, 'i'),
            );
            // The server-minted CSRF state cookie is present EVEN on the 400 — the
            // mint precedes the unconfigured-provider throw (C-03 dual-channel binding).
            const cookie = setCookies(res);
            expect(cookie, `${provider} state cookie on 400`).toMatch(/ew_oauth_state=/);
            expect(cookie).toMatch(/Path=\/api\/oauth/);
            expect(cookie).toMatch(/HttpOnly/i);
            expect(cookie).toMatch(/SameSite=Lax/i);
            expect(cookie).toMatch(/Max-Age=600/);
        }
    });

    test('the callback GATE ORDER: code-presence (400 "Authorization code is required") precedes state-verification (400 "missing state cookie")', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // No code at all → the first gate fires, regardless of state.
        const noCode = await request.get(`${OAUTH}/github/callback/plugins`, { headers: h });
        expect(noCode.status()).toBe(400);
        expect(msgOf(await noCode.json())).toMatch(/Authorization code is required/i);

        // Code present but NO state cookie (curl/API caller) → the SECOND gate fires.
        const noCookie = await request.get(
            `${OAUTH}/github/callback/plugins?code=fake-code-${stamp()}&state=fake-state`,
            { headers: h },
        );
        expect(noCookie.status()).toBe(400);
        expect(msgOf(await noCookie.json())).toMatch(
            /OAuth state verification failed.*missing state cookie/i,
        );

        // The two refusals are DISTINCT — code-gate never mentions state, state-gate never mentions code.
        expect(
            msgOf(
                await (
                    await request.get(`${OAUTH}/github/callback/plugins`, { headers: h })
                ).json(),
            ),
        ).not.toMatch(/state/i);
    });

    test('the read-packages OAuth variant MIRRORS the main flow: connect/url 400+cookie, callback code-gate first', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const url = await request.get(`${OAUTH}/github/read-packages/connect/url`, { headers: h });
        expect(url.status()).toBe(400);
        expect(msgOf(await url.json())).toMatch(
            /OAuth credentials not configured for provider: github/i,
        );
        expect(setCookies(url)).toMatch(/ew_oauth_state=/);

        const cb = await request.get(`${OAUTH}/github/callback/plugins/read-packages`, {
            headers: h,
        });
        expect(cb.status()).toBe(400);
        expect(msgOf(await cb.json())).toMatch(/Authorization code is required/i);
    });

    test('DELETE disconnect is an idempotent 204 no-op on a never-connected provider; the connection stays false and the user endpoint reports no token', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // Disconnecting a provider that was never connected is a clean 204 (twice).
        expect((await request.delete(`${OAUTH}/github`, { headers: h })).status()).toBe(204);
        expect((await request.delete(`${OAUTH}/github`, { headers: h })).status()).toBe(204);
        expect((await request.delete(`${OAUTH}/vercel`, { headers: h })).status()).toBe(204);

        // The connection never flipped, and the token lookup still reports absence.
        const conn = (await (
            await request.get(`${OAUTH}/github/connection`, { headers: h })
        ).json()) as {
            connected: boolean;
        };
        expect(conn.connected).toBe(false);
        const gitUser = (await (
            await request.get(`${OAUTH}/github/user`, { headers: h })
        ).json()) as {
            success: boolean;
            error: string;
        };
        expect(gitUser.success).toBe(false);
        expect(gitUser.error).toMatch(/No valid token for provider github/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 3 — the Work git-binding is chosen at birth and frozen', () => {
    test('a fresh Work is born bound to storageProvider default `user-github` + gitProvider `github`, and echoes an explicit `ever-works-git` binding verbatim', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const def = await createBoundWork(request, token, { label: 'Birth Default' });
        expect(def.storageProvider).toBe('user-github');
        expect(def.gitProvider).toBe('github');
        // Fresh Works never carry a published website or deployment state.
        expect(def.website).toBeNull();
        expect(def.deploymentState).toBeNull();

        const ewg = await createBoundWork(request, token, {
            label: 'Birth EWG',
            storageProvider: 'ever-works-git',
        });
        expect(ewg.storageProvider).toBe('ever-works-git');
        // The two Works carry INDEPENDENT bindings — no cross-work bleed.
        expect(ewg.id).not.toBe(def.id);
    });

    test('storageProvider is FREE-FORM at creation (no whitelist — an arbitrary string is accepted), same leniency as gitProvider', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // No @IsIn on the create-DTO's storageProvider/gitProvider → arbitrary values stick.
        const w = await createBoundWork(request, token, {
            label: 'Freeform',
            storageProvider: 'totally-made-up-backend',
            gitProvider: 'gitlab',
        });
        expect(w.storageProvider).toBe('totally-made-up-backend');
        expect(w.gitProvider).toBe('gitlab');

        // Read-back confirms the persisted binding is exactly what was sent.
        const row = await readWork(request, token, w.id);
        expect(row.storageProvider).toBe('totally-made-up-backend');
        expect(row.gitProvider).toBe('gitlab');
    });

    test('storageProvider is IMMUTABLE after birth (PATCH is forbidNonWhitelisted-rejected) while deployProvider is MUTABLE (PATCH k8s succeeds) — the binding is set-once', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const w = await createBoundWork(request, token, { label: 'Immutable' });
        expect(w.storageProvider).toBe('user-github');

        // storageProvider is NOT in UpdateWorkDto → any PATCH carrying it is a 400.
        for (const val of ['ever-works-git', 'user-gitlab']) {
            const res = await request.patch(`${WORKS}/${w.id}`, {
                headers: h,
                data: { storageProvider: val },
            });
            expect(res.status(), `PATCH storageProvider=${val}`).toBe(400);
            expect(msgOf(await res.json())).toMatch(/property storageProvider should not exist/i);
        }

        // deployProvider, by contrast, IS mutable (whitelisted k8s|vercel).
        const okPatch = await request.patch(`${WORKS}/${w.id}`, {
            headers: h,
            data: { deployProvider: 'k8s' },
        });
        expect(okPatch.status()).toBe(200);
        expect(
            ((await okPatch.json()) as { work: { deployProvider: string } }).work.deployProvider,
        ).toBe('k8s');

        // The rejected storageProvider PATCHes changed nothing — still the birth value.
        const after = await readWork(request, token, w.id);
        expect(after.storageProvider).toBe('user-github');
        expect(after.deployProvider).toBe('k8s');
    });

    test('creating git-backed Works never side-effects a git connection: BOTH surfaces stay connected:false across the whole binding step', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);

        await createBoundWork(request, token, { label: 'Bind A', storageProvider: 'user-github' });
        await createBoundWork(request, token, {
            label: 'Bind B',
            storageProvider: 'ever-works-git',
        });

        // Binding a Work to a git backend is orthogonal to actually connecting an account.
        expect(
            (
                (await (
                    await request.get(`${OAUTH}/github/connection`, { headers: h })
                ).json()) as { connected: boolean }
            ).connected,
        ).toBe(false);
        expect(
            (
                (await (await request.get(`${GITP}/github/connection`, { headers: h })).json()) as {
                    connected: boolean;
                }
            ).connected,
        ).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 4 — the git-credential precondition (409 NoGitCredentials)', () => {
    test('forking a RESOLVABLE template with no connected github account → 409 NoGitCredentialsError naming the caller and provider github', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const templateId = await resolvableWebsiteTemplateId(request, token);

        const res = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: `acme-${stamp()}`,
        });
        expect(res.status(), 'resolvable-template fork with no git conn → 409').toBe(409);
        const body = (await res.json()) as { statusCode: number; message: string; error: string };
        expect(body.statusCode).toBe(409);
        expect(body.error).toBe('NoGitCredentialsError');
        expect(body.message).toMatch(/No connected account found/i);
        expect(body.message).toMatch(/provider github/i);
        // The precondition ties to THIS caller's identity.
        expect(body.message).toContain(user.user.id);
    });

    test('the fork gate has a THREE-LAYER order: DTO (400) → template-resolution (404) → git-credentials (409), each a distinct envelope', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const templateId = await resolvableWebsiteTemplateId(request, token);

        // Layer 1 — DTO: invalid kind, missing targetOwner, and an extra key each 400 BEFORE any lookup.
        const badKind = await forkAttempt(request, token, {
            kind: 'not-a-kind',
            templateId,
            targetOwner: 'acme',
        });
        expect(badKind.status()).toBe(400);
        expect(msgOf(await badKind.json())).toMatch(/kind must be one of the following values/i);

        const noOwner = await forkAttempt(request, token, { kind: 'website', templateId });
        expect(noOwner.status()).toBe(400);
        expect(msgOf(await noOwner.json())).toMatch(/targetOwner must be a string/i);

        const extraKey = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
            sneaky: true,
        });
        expect(extraKey.status()).toBe(400);
        expect(msgOf(await extraKey.json())).toMatch(/property sneaky should not exist/i);

        // Layer 2 — template resolution: a well-formed body naming an UNKNOWN template → 404 (before git).
        const unknownTpl = await forkAttempt(request, token, {
            kind: 'website',
            templateId: `ghost-template-${stamp()}`,
            targetOwner: 'acme',
        });
        expect(unknownTpl.status()).toBe(404);
        expect(msgOf(await unknownTpl.json())).toMatch(
            /Template not found for this user and kind/i,
        );

        // Layer 3 — git-credentials: a RESOLVABLE template reaches the git gate → 409.
        const gitGate = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(gitGate.status()).toBe(409);
        expect(((await gitGate.json()) as { error: string }).error).toBe('NoGitCredentialsError');
    });

    test('the fork git-gate always cites provider `github` regardless of the Work`s gitProvider binding (fork is account-scoped, not work-scoped)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const templateId = await resolvableWebsiteTemplateId(request, token);

        // Even after binding a Work to gitlab storage, the account-level fork still resolves github.
        const gitlabWork = await createBoundWork(request, token, {
            label: 'Gitlab Bound',
            gitProvider: 'gitlab',
            storageProvider: 'user-gitlab',
        });
        expect(gitlabWork.gitProvider).toBe('gitlab');

        const res = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(res.status()).toBe(409);
        // The 409 is about the ACCOUNT's default git provider (github), decoupled from the Work binding.
        expect(msgOf(await res.json())).toMatch(/provider github/i);
    });

    test('the fork endpoint is auth-guarded (anon → 401) and method-pinned (GET → 404)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const templateId = await resolvableWebsiteTemplateId(request, user.access_token);

        const anon = await forkAttempt(request, undefined, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(anon.status()).toBe(401);

        const wrongMethod = await request.get(FORK, { headers: authedHeaders(user.access_token) });
        expect(wrongMethod.status()).toBe(404);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 5 — the two halves of publish diverge on ONE disconnected user', () => {
    test('the SAME disconnected user faces TWO distinct preconditions: git-storage → 409 NoGitCredentials (github) vs deploy-credential → 400 token-required (vercel)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const templateId = await resolvableWebsiteTemplateId(request, token);
        const work = await createBoundWork(request, token, { label: 'Two Gates' });

        // Half A — the git-storage precondition (publish the CONTENT repo): 409 github.
        const gitGate = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(gitGate.status()).toBe(409);
        const gitBody = (await gitGate.json()) as { error: string; message: string };
        expect(gitBody.error).toBe('NoGitCredentialsError');
        expect(gitBody.message).toMatch(/provider github/i);

        // Half B — the deploy-credential precondition (ship the SITE): 400 vercel.
        const deployGate = await request.post(`${DEPLOY}/works/${work.id}`, {
            headers: h,
            data: {},
        });
        expect(deployGate.status()).toBe(400);
        const deployBody = (await deployGate.json()) as { status: string; message: string };
        expect(deployBody.status).toBe('error');
        expect(deployBody.message).toMatch(/Vercel token is required/i);

        // The two gates are genuinely DIFFERENT: different status, provider, and envelope key.
        expect(gitGate.status()).not.toBe(deployGate.status());
        expect(gitBody.message).not.toMatch(/Vercel/i);
        expect(deployBody.message).not.toMatch(/github/i);
    });

    test('deploy-readiness is storageProvider-AGNOSTIC: `check` returns the SAME idle capability shape for a user-github Work and an ever-works-git Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);

        const ugh = await createBoundWork(request, token, {
            label: 'Chk UGH',
            storageProvider: 'user-github',
        });
        const ewg = await createBoundWork(request, token, {
            label: 'Chk EWG',
            storageProvider: 'ever-works-git',
        });

        const readCheck = async (id: string) => {
            const res = await request.post(`${DEPLOY}/works/${id}/check`, { headers: h });
            expect(res.status()).toBe(201);
            return (await res.json()) as Record<string, unknown>;
        };

        const idle = {
            status: 'success',
            canDeploy: false,
            isShared: false,
            ownerHasToken: false,
            userHasToken: false,
        };
        // The deploy gate keys on the DEPLOY token, not the git storage binding.
        expect(await readCheck(ugh.id)).toMatchObject(idle);
        expect(await readCheck(ewg.id)).toMatchObject(idle);
    });

    test('the deploy-credential gate names the Work`s deployProvider: flipping vercel→k8s renames the token-required copy while the git-storage 409 is unchanged', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const templateId = await resolvableWebsiteTemplateId(request, token);
        const work = await createBoundWork(request, token, { label: 'Rename Gate' });

        // Before: deploy gate names Vercel (default provider).
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
                ).json(),
            ),
        ).toMatch(/Vercel token is required/i);

        // Flip the deploy dial (mutable) to k8s.
        expect(
            (
                await request.patch(`${WORKS}/${work.id}`, {
                    headers: h,
                    data: { deployProvider: 'k8s' },
                })
            ).status(),
        ).toBe(200);

        // After: the deploy gate renames Vercel→Kubernetes...
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
                ).json(),
            ),
        ).toMatch(/Kubernetes token is required/i);

        // ...but the git-storage 409 is UNAFFECTED — it belongs to the account git provider, not the deploy dial.
        const fork = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(fork.status()).toBe(409);
        expect(msgOf(await fork.json())).toMatch(/provider github/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Chain step 6 — the whole vertical stitch, end to end', () => {
    test('register → discover → confirm disconnected on BOTH surfaces → bind a github Work → fork blocked 409 → deploy blocked 400 → connection STILL false, deploy columns idle', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user: RegisteredUser = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const templateId = await resolvableWebsiteTemplateId(request, token);

        // 1. Discover — github advertised on both capability surfaces, both disconnected.
        expect(
            (
                (await (
                    await request.get(`${OAUTH}/github/connection`, { headers: h })
                ).json()) as { connected: boolean }
            ).connected,
        ).toBe(false);
        expect(
            (
                (await (await request.get(`${GITP}/github/connection`, { headers: h })).json()) as {
                    connected: boolean;
                }
            ).connected,
        ).toBe(false);

        // 2. Bind — create a github-backed Work; the binding is recorded at birth.
        const work = await createBoundWork(request, token, {
            label: 'E2E Stitch',
            storageProvider: 'user-github',
        });
        expect(work.storageProvider).toBe('user-github');

        // 3. The CONTENT half is blocked at the git-credential gate.
        const fork = await forkAttempt(request, token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(fork.status()).toBe(409);
        expect(((await fork.json()) as { error: string }).error).toBe('NoGitCredentialsError');

        // 4. The DEPLOY half is blocked at the deploy-credential gate.
        expect(
            (await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })).status(),
        ).toBe(400);
        // ...but the capability read stays open and idle.
        expect(
            (await request.post(`${DEPLOY}/works/${work.id}/check`, { headers: h })).status(),
        ).toBe(201);

        // 5. Nothing in the whole walk connected an account or published a site.
        expect(
            (
                (await (
                    await request.get(`${OAUTH}/github/connection`, { headers: h })
                ).json()) as { connected: boolean }
            ).connected,
        ).toBe(false);
        expect(
            (
                (await (await request.get(`${GITP}/github/connection`, { headers: h })).json()) as {
                    connected: boolean;
                }
            ).connected,
        ).toBe(false);
        const after = await readWork(request, token, work.id);
        expect(after.website ?? null).toBeNull();
        expect(after.deploymentState ?? null).toBeNull();
        expect(after.lastDeployCorrelationId ?? null).toBeNull();
        // The birth binding is intact.
        expect(after.storageProvider).toBe('user-github');
    });

    test('the chain is strictly PER-USER: user A`s disconnected fork-409 and Work binding are invisible to a fresh user B (independent connection ledgers)', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const templateId = await resolvableWebsiteTemplateId(request, userA.access_token);

        // A forks → 409 naming A.
        const forkA = await forkAttempt(request, userA.access_token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(forkA.status()).toBe(409);
        expect(msgOf(await forkA.json())).toContain(userA.user.id);

        // B forks → 409 naming B, never A (separate credential ledgers).
        const forkB = await forkAttempt(request, userB.access_token, {
            kind: 'website',
            templateId,
            targetOwner: 'acme',
        });
        expect(forkB.status()).toBe(409);
        const bMsg = msgOf(await forkB.json());
        expect(bMsg).toContain(userB.user.id);
        expect(bMsg).not.toContain(userA.user.id);

        // Both users independently see connected:false — neither can perturb the other.
        for (const u of [userA, userB]) {
            const conn = (await (
                await request.get(`${OAUTH}/github/connection`, {
                    headers: authedHeaders(u.access_token),
                })
            ).json()) as { connected: boolean };
            expect(conn.connected).toBe(false);
        }
    });
});
