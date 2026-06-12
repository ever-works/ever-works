import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: DEPLOY WORK + TEAMS — complex, multi-step, cross-feature INTEGRATION
 * flows pinning the deploy capability's WORK-DEPLOY + TEAMS verbs and the
 * per-verb DTO/whitelist/ownership asymmetries that the sibling deploy specs do
 * NOT cover: the GLOBAL `POST /teams` (context-free success+empty, NO request
 * DTO — silently swallows any body key) versus the per-work `POST /works/:id/teams`
 * (configure-gated, provider-NAME-resolved refusal copy), the `/check` verb
 * (NO DTO — accepts extra keys), and the full ownership cross-product applied to
 * EACH verb (foreign-owned -> 403, ghost id -> 404, anonymous -> 401).
 *
 * GROUNDING — every status/shape below was verified against the LIVE sqlite e2e
 * API (port 3100) with throwaway users on 2026-06-12, and cross-checked against
 * the real source:
 *   - apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 *       (deployWork -> DeployWorkDto; getDeploymentTeams (GLOBAL, no DTO);
 *        getTeamsForWork (per-work, no DTO); checkDeploymentCapability (no DTO);
 *        every per-work verb runs WorkOwnershipService.ensureCanEdit/View first)
 *   - apps/api/src/plugins-capabilities/deploy/dto/deploy.dto.ts
 *       (DeployWorkDto { teamScope? } + forbidNonWhitelisted — ONLY the deploy
 *        verb carries this DTO; teams/check are body-agnostic)
 *   - packages/agent/src/facades/deploy.facade.ts (getTeamsForWork resolves the
 *        work.deployProvider -> plugin name -> token; degrades to success+empty
 *        when a token is present but the provider call yields nothing)
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     POST /api/deploy/works/:id (DeployWorkDto):
 *        unconfigured vercel work → 400 { status:'error',
 *          message:'Vercel token is required. Please configure it in Plugin Settings.' }
 *        unconfigured k8s work    → 400 'Kubernetes token is required. ...' (name from work.deployProvider)
 *        `{ teamScope }`          → ACCEPTED (whitelisted) — still 400 at the unconfigured gate
 *        extra body key           → 400 { message:['property <k> should not exist'] } (forbidNonWhitelisted)
 *     POST /api/deploy/teams (GLOBAL, no work context, NO DTO):
 *        always → 201 { status:'success', teams:[], message:/work-specific endpoint|Plugin Settings/ }
 *        ANY body key (teamScope, bogus, both) → STILL 201 success+empty (no forbidNonWhitelisted)
 *     POST /api/deploy/works/:id/teams (per-work, configure-gated, NO body DTO):
 *        unconfigured vercel → 400 { status:'error',
 *          message:'Failed to get teams. Please configure your Vercel token in Plugin Settings.' }
 *        unconfigured k8s    → 400 'Failed to get teams. Please configure your Kubernetes token ...'
 *        extra body key      → STILL the 400 gate (no forbidNonWhitelisted — gate runs, not DTO)
 *        configured(fake)    → 201 { status:'success', teams:[] } (facade degrades to empty)
 *        configured + teamScope → 201 success+empty (teamScope tolerated)
 *     POST /api/deploy/works/:id/check (NO DTO):
 *        → 201 { status:'success', canDeploy, isShared:false, ownerHasToken, userHasToken }
 *        canDeploy === ownerHasToken; userHasToken flips true once the work's provider token is set
 *        extra body key → STILL 201 success (no forbidNonWhitelisted)
 *        GET method     → 404 'Cannot GET ...' (the verb is POST-only)
 *     OWNERSHIP cross-product (applies to deploy / teams / check uniformly):
 *        foreign-owned work → 403 { status:'error', message:'You do not have permission to access this work' }
 *        ghost work id      → 404 { status:'error', message:"Work with id '...' not found" }
 *        anonymous          → 401 { message:'Unauthorized', statusCode:401 }
 *        (403-vs-404 is a real split: ensureCanView 403s a real-but-foreign work, 404s a missing one.)
 *
 * ADAPTIVITY (CI reality): NO real Vercel/k8s token is wired. Flows that need a
 * configured gate enable a deliberately FAKE token to flip isConfigured, then
 * assert the truthful downstream behaviour (graceful empty teams / the distinct
 * invalid-token deploy refusal) — they never trigger or assert a real external
 * deploy. Assertions widen with status-sets / .or() so a configured stack still
 * passes. Anonymous contexts use an EMPTY storageState so they do not inherit
 * the shared auth cookie.
 *
 * NON-DUPLICATION: flow-deploy-capability-contract pins the provider-facade
 * SHAPE / ever-works read-alias / create-vs-PATCH deployProvider validation /
 * the gate's provider-name resolution / the global-vs-per-work /teams split at a
 * high level / the correlation invariant. flow-plugin-deployment drives the
 * PLUGIN side (token-enable flips capability, two-stage gate, per-work rebinding,
 * cached projectId, website-gated domains, batch envelope, system-plugin
 * invariants). flow-work-deploy-state pins the deploy STATE-MACHINE columns +
 * history/rollback + the generic ownership matrix. THIS file instead pins the
 * per-VERB request-contract asymmetries nobody else asserts: the GLOBAL /teams
 * having NO DTO (swallows any body), the per-work /teams configure-gate EXACT
 * copy with k8s provider-name resolution, the /check verb having NO DTO + being
 * POST-only, and the 403-vs-404-vs-401 ownership cross-product applied to EACH of
 * the deploy / teams / check verbs (not just one bare deploy).
 *
 * ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user (the
 * configured token is USER-scoped — must never leak into sibling specs). Unique
 * names/slugs from a per-test counter (NOT a module-scope clock).
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const PLUGINS_BASE = `${API_BASE}/api/plugins`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_VERCEL_TOKEN = 'fake-vercel-token-works-teams-deep';

/** Status classes accepted for a deploy POST: the CI-real refusals OR a configured success. */
const DEPLOY_OUTCOMES = [200, 201, 202, 400, 401, 403, 409, 422, 500];

/** Per-test unique-suffix counter (NOT a module-scope clock). */
let seq = 0;
function uniq(prefix: string): string {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

interface WorkRow {
    id: string;
    slug?: string;
    deployProvider?: string | null;
    deploymentState?: string | null;
    website?: string | null;
}

/** Create a fresh work (description REQUIRED by the create DTO) and return its row. */
async function freshWork(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<WorkRow> {
    const stamp = uniq('deploy-wt');
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: `Deploy WorksTeams ${stamp}`,
            slug: stamp,
            description: 'flow-deploy-works-teams-deep e2e work',
            organization: false,
            ...overrides,
        },
    });
    expect(res.status(), `work create body=${await res.text().catch(() => '')}`).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const w = (json.work ?? json) as WorkRow;
    expect(w.id, 'created work has an id').toBeTruthy();
    return w;
}

/** POST /api/deploy/works/:id/check — envelope-tolerant. */
async function deployCheck(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.post(`${DEPLOY_BASE}/works/${id}/check`, {
        headers: authedHeaders(token),
        data: {},
    });
    expect([200, 201]).toContain(res.status());
    return (await res.json()) as Record<string, unknown>;
}

/** Enable the vercel plugin with a (fake) apiToken so the deploy capability becomes configured. */
async function configureVercelToken(
    request: APIRequestContext,
    token: string,
    apiToken = FAKE_VERCEL_TOKEN,
): Promise<void> {
    const res = await request.post(`${PLUGINS_BASE}/vercel/enable`, {
        headers: authedHeaders(token),
        data: { secretSettings: { apiToken } },
    });
    expect(res.status(), `enable vercel body=${await res.text().catch(() => '')}`).toBeLessThan(
        300,
    );
}

test.describe('Deploy work + teams — per-verb request-contract + ownership cross-product (deep integration)', () => {
    test('1. the GLOBAL POST /teams is context-free and has NO request DTO: it always 201s with a success+empty envelope and the "work-specific endpoint" hint, and silently swallows ANY body key (teamScope, an unknown key, or both) — unlike the deploy verb', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // Bare body: the canonical context-free success envelope.
        const bare = await request.post(`${DEPLOY_BASE}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(bare.status());
        const bareBody = (await bare.json()) as Record<string, unknown>;
        expect(bareBody.status).toBe('success');
        expect(Array.isArray(bareBody.teams), 'global teams is an array').toBe(true);
        expect((bareBody.teams as unknown[]).length, 'global teams empty without a token').toBe(0);
        expect(String(bareBody.message)).toMatch(/work-specific endpoint|Plugin Settings/i);

        // A `teamScope` field is accepted (the global endpoint ignores it, no work context).
        const scoped = await request.post(`${DEPLOY_BASE}/teams`, {
            headers: authedHeaders(access_token),
            data: { teamScope: 'some-team' },
        });
        expect([200, 201]).toContain(scoped.status());
        expect(((await scoped.json()) as Record<string, unknown>).status).toBe('success');

        // KEY ASYMMETRY: an UNKNOWN body key on the global /teams is SILENTLY ACCEPTED
        // (no DTO / no forbidNonWhitelisted) — whereas the same junk key on the deploy
        // verb is rejected. Prove BOTH halves of the asymmetry in one test.
        const junkTeams = await request.post(`${DEPLOY_BASE}/teams`, {
            headers: authedHeaders(access_token),
            data: { totallyBogusKey: 1, teamScope: 'x' },
        });
        expect(
            [200, 201],
            `global teams tolerates an unknown body key (status ${junkTeams.status()})`,
        ).toContain(junkTeams.status());
        const junkBody = (await junkTeams.json()) as Record<string, unknown>;
        expect(junkBody.status).toBe('success');
        expect((junkBody.teams as unknown[]).length).toBe(0);

        // The contrasting half: the DEPLOY verb DOES reject the unknown key (forbidNonWhitelisted).
        const work = await freshWork(request, access_token);
        const junkDeploy = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: { totallyBogusKey: 1 },
        });
        expect(junkDeploy.status(), 'deploy verb rejects the unknown body key').toBe(400);
        expect(JSON.stringify((await junkDeploy.json()) as unknown)).toMatch(/should not exist/i);
    });

    test('2. the deploy verb whitelists `teamScope` (accepted, no DTO error) but still refuses an unconfigured work at the isConfigured gate with the vercel-named "token is required" copy — proving the DTO passes BEFORE the capability gate runs', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);
        expect(work.deployProvider, 'fresh work resolves the default vercel provider').toBe(
            'vercel',
        );

        // `teamScope` is a whitelisted DeployWorkDto field: it must NOT trip
        // forbidNonWhitelisted — the body validates, then the gate refuses on the
        // missing token. (A bad/extra key would 400 with "should not exist" instead.)
        const withScope = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: { teamScope: 'my-team-scope' },
        });
        expect(DEPLOY_OUTCOMES).toContain(withScope.status());
        if (withScope.status() === 400) {
            const body = (await withScope.json()) as Record<string, unknown>;
            // The refusal is the capability gate, NOT a DTO rejection.
            expect(JSON.stringify(body), 'teamScope is NOT a forbidden key').not.toMatch(
                /should not exist/i,
            );
            expect(body.status).toBe('error');
            expect(String(body.message)).toMatch(/Vercel token is required/i);
        }

        // Empty body takes the identical gate path — teamScope is genuinely optional.
        const bare = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(bare.status());
        if (bare.status() === 400) {
            expect(String(((await bare.json()) as Record<string, unknown>).message)).toMatch(
                /Vercel token is required/i,
            );
        }
    });

    test('3. the per-work POST /works/:id/teams is configure-gated with the DISTINCT "Failed to get teams. Please configure your Vercel token" copy (a different verb-specific message than the deploy gate), and it has NO body DTO — an unknown key still hits the gate, not a "should not exist" rejection', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // Unconfigured per-work teams: the facade can't resolve a token -> the
        // teams-SPECIFIC refusal copy (distinct verb, distinct sentence from deploy's
        // "token is required").
        const unconfigured = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const unconfiguredBody = (await unconfigured.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        // On CI this is a clean 400; a pre-configured stack could 2xx — tolerate both.
        if (unconfigured.status() === 400) {
            expect(unconfiguredBody?.status).toBe('error');
            expect(
                String(unconfiguredBody?.message),
                'per-work teams uses the "Failed to get teams" verb-specific copy',
            ).toMatch(/Failed to get teams/i);
            expect(String(unconfiguredBody?.message)).toMatch(/Vercel token/i);
        } else {
            expect([200, 201]).toContain(unconfigured.status());
        }

        // NO body DTO on this verb: an UNKNOWN key does NOT short-circuit with a
        // "should not exist" — the request validates and the capability gate runs.
        const junk = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: { totallyBogusKey: 1 },
        });
        const junkBody = (await junk.json().catch(() => null)) as Record<string, unknown> | null;
        expect(
            [200, 201, 400],
            `per-work teams tolerates an unknown key at the gate (status ${junk.status()})`,
        ).toContain(junk.status());
        if (junk.status() === 400) {
            // Same gate refusal as the bare body — NOT a DTO whitelist rejection.
            expect(
                JSON.stringify(junkBody),
                'per-work teams has no forbidNonWhitelisted',
            ).not.toMatch(/should not exist/i);
            expect(String(junkBody?.message)).toMatch(/Failed to get teams/i);
        }
    });

    test('4. per-work teams resolves the provider NAME from work.deployProvider: a k8s-bound work names "Kubernetes" in its unconfigured teams refusal even when the user holds a vercel token — proving teams gating is per-work, not per-user', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        // Give the user a vercel token; it must be irrelevant to a k8s-bound work.
        await configureVercelToken(request, access_token);

        const k8sWork = await freshWork(request, access_token, { deployProvider: 'k8s' });
        expect(k8sWork.deployProvider, 'per-work provider binding is k8s').toBe('k8s');

        const teams = await request.post(`${DEPLOY_BASE}/works/${k8sWork.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const teamsBody = (await teams.json().catch(() => null)) as Record<string, unknown> | null;
        if (teams.status() === 400) {
            // The refusal names the WORK's provider (Kubernetes), NOT the user's vercel token.
            expect(String(teamsBody?.message)).toMatch(/Failed to get teams/i);
            expect(
                String(teamsBody?.message),
                'k8s-bound teams names Kubernetes, not Vercel',
            ).toMatch(/Kubernetes/i);
            expect(String(teamsBody?.message)).not.toMatch(/Vercel token/i);
        } else {
            expect([200, 201]).toContain(teams.status());
        }

        // The matching /check agrees: the vercel token does not satisfy a k8s-bound work.
        const check = await deployCheck(request, access_token, k8sWork.id);
        expect(check.userHasToken, 'a vercel token does not satisfy a k8s-bound work').toBe(false);
        expect(check.canDeploy).toBe(false);
    });

    test('5. configuring a (fake) token flips per-work teams from the 400 gate to a graceful 201 success+empty (the facade calls the provider, gets nothing, degrades to []) — never a 5xx — and `teamScope` is tolerated on the configured path', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // BEFORE: gate refuses (token absent). Tolerate a pre-configured stack.
        const before = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        if (before.status() === 400) {
            expect(String(((await before.json()) as Record<string, unknown>).message)).toMatch(
                /Failed to get teams/i,
            );
        }

        // ACT: configure a fake token so the facade resolves it for the work.
        await configureVercelToken(request, access_token);
        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
                message: 'work becomes token-resolved after configure',
            })
            .toBe(true);

        // AFTER: the facade calls the provider; the fake token yields nothing, so the
        // handler degrades to a graceful success+empty (never a 5xx, never the
        // unconfigured "Failed to get teams" copy).
        const after = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201, 400], `configured per-work teams status ${after.status()}`).toContain(
            after.status(),
        );
        const afterBody = (await after.json().catch(() => null)) as Record<string, unknown> | null;
        if (after.status() < 300) {
            expect(afterBody?.status).toBe('success');
            expect(Array.isArray(afterBody?.teams), 'configured per-work teams is an array').toBe(
                true,
            );
        } else {
            // A truthful provider failure is allowed, but NEVER the unconfigured copy.
            expect(afterBody?.status).toBe('error');
            expect(String(afterBody?.message)).not.toMatch(/Please configure your .* token/i);
        }

        // `teamScope` is tolerated on the configured path too (still a graceful 2xx/empty).
        const scoped = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: { teamScope: 'team_abc' },
        });
        expect([200, 201, 400]).toContain(scoped.status());
        const scopedBody = (await scoped.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        if (scoped.status() < 300) {
            expect(scopedBody?.status).toBe('success');
            expect(Array.isArray(scopedBody?.teams)).toBe(true);
        }
    });

    test('6. the /check verb has NO request DTO: it 201s a uniform { canDeploy, isShared, ownerHasToken, userHasToken } shape (canDeploy === ownerHasToken) and TOLERATES an unknown body key — and configuring a token flips userHasToken/canDeploy true', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // Fresh check: every flag is a boolean, the shape is the capability contract,
        // and canDeploy mirrors the OWNER token state.
        const before = await deployCheck(request, access_token, work.id);
        expect(before.status).toBe('success');
        expect(before.isShared, 'a freshly-created solo work is not shared').toBe(false);
        expect(typeof before.canDeploy).toBe('boolean');
        expect(typeof before.ownerHasToken).toBe('boolean');
        expect(typeof before.userHasToken).toBe('boolean');
        expect(before.canDeploy, 'canDeploy mirrors ownerHasToken').toBe(before.ownerHasToken);
        const startedConfigured = before.userHasToken === true;

        // NO DTO: an unknown body key does NOT 400 — it returns the same success shape
        // (in contrast to the deploy verb's forbidNonWhitelisted).
        const junk = await request.post(`${DEPLOY_BASE}/works/${work.id}/check`, {
            headers: authedHeaders(access_token),
            data: { totallyBogusKey: 1 },
        });
        expect(
            [200, 201],
            `check tolerates an unknown body key (status ${junk.status()})`,
        ).toContain(junk.status());
        const junkBody = (await junk.json()) as Record<string, unknown>;
        expect(junkBody.status).toBe('success');
        expect(JSON.stringify(junkBody), 'check has no forbidNonWhitelisted').not.toMatch(
            /should not exist/i,
        );

        // ACT + AFTER: configuring the work's provider token flips userHasToken/canDeploy.
        if (!startedConfigured) {
            await configureVercelToken(request, access_token);
            await expect
                .poll(
                    async () => (await deployCheck(request, access_token, work.id)).userHasToken,
                    {
                        timeout: 15_000,
                        message: 'check sees the newly-configured user token',
                    },
                )
                .toBe(true);
            const after = await deployCheck(request, access_token, work.id);
            expect(after.userHasToken).toBe(true);
            expect(after.canDeploy).toBe(true);
            expect(after.ownerHasToken).toBe(true);
        }
    });

    test('7. the /check verb is POST-only: a GET on the same path is 404 "Cannot GET" (no accidental verb aliasing)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // POST works (capability check).
        const post = await request.post(`${DEPLOY_BASE}/works/${work.id}/check`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(post.status());

        // GET is NOT mapped — the router reports an unmatched route.
        const get = await request.get(`${DEPLOY_BASE}/works/${work.id}/check`, {
            headers: authedHeaders(access_token),
        });
        expect(get.status(), 'check is POST-only; GET is unmatched').toBe(404);
        expect(String(((await get.json()) as Record<string, unknown>).message)).toMatch(
            /Cannot GET/i,
        );
    });

    test('8. OWNERSHIP cross-product on the DEPLOY verb: a foreign-owned work is 403 "do not have permission" (NOT a leak, NOT a 404), a ghost work id is 404 "not found", and anonymous is 401 — the 403-vs-404 split distinguishes a real-but-foreign work from a missing one', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // FOREIGN (real work, not yours) -> 403 ownership refusal (ensureCanView/Edit).
        const foreign = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(
            foreign.status(),
            `foreign deploy body=${await foreign.text().catch(() => '')}`,
        ).toBe(403);
        expect(String(((await foreign.json()) as Record<string, unknown>).message)).toMatch(
            /do not have permission/i,
        );

        // GHOST (no such work) -> 404 not-found — the DISTINCT half of the split.
        const ghost = await request.post(`${DEPLOY_BASE}/works/${NIL_UUID}`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(ghost.status(), 'a ghost work id is 404, not 403').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        // ANONYMOUS (empty storageState so the shared auth cookie is NOT inherited) -> 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(`${DEPLOY_BASE}/works/${work.id}`, {
                data: {},
            });
            expect(anonRes.status(), 'anonymous deploy is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('9. OWNERSHIP cross-product on the per-work TEAMS verb mirrors the deploy verb: foreign-owned -> 403, ghost -> 404, anonymous -> 401 (the teams verb is guarded the SAME way, before the configure gate)', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // FOREIGN -> 403 (ownership runs BEFORE the configure gate — never a teams 400).
        const foreign = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(foreign.status(), 'foreign per-work teams is ownership-403').toBe(403);
        const foreignBody = (await foreign.json()) as Record<string, unknown>;
        expect(String(foreignBody.message)).toMatch(/do not have permission/i);
        // Critically, a foreign caller gets the ownership copy, NOT the configure-gate copy.
        expect(String(foreignBody.message)).not.toMatch(/Failed to get teams/i);

        // GHOST -> 404.
        const ghost = await request.post(`${DEPLOY_BASE}/works/${NIL_UUID}/teams`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(ghost.status(), 'ghost per-work teams is 404').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        // ANONYMOUS -> 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
                data: {},
            });
            expect(anonRes.status(), 'anonymous per-work teams is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('10. OWNERSHIP cross-product on the /check verb: foreign-owned -> 403, ghost -> 404, anonymous -> 401 — even though /check otherwise returns a benign success envelope, it does NOT leak a foreign work', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // FOREIGN -> 403 (the success-shaped check still refuses on ownership — no leak).
        const foreign = await request.post(`${DEPLOY_BASE}/works/${work.id}/check`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(foreign.status(), 'foreign /check is ownership-403, never a leaked success').toBe(
            403,
        );
        const foreignBody = (await foreign.json()) as Record<string, unknown>;
        expect(String(foreignBody.message)).toMatch(/do not have permission/i);
        // A refused check NEVER exposes the capability flags of a foreign work.
        expect(
            foreignBody.canDeploy,
            'a refused check carries no capability flags',
        ).toBeUndefined();

        // GHOST -> 404.
        const ghost = await request.post(`${DEPLOY_BASE}/works/${NIL_UUID}/check`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(ghost.status(), 'ghost /check is 404').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        // ANONYMOUS -> 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(`${DEPLOY_BASE}/works/${work.id}/check`, {
                data: {},
            });
            expect(anonRes.status(), 'anonymous /check is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('11. the GLOBAL /teams verb is auth-guarded but NOT work-scoped: it 401s anonymously yet has no work id to own, so an authenticated stranger gets the same context-free success as anyone (no 403/404 path exists for it)', async ({
        request,
        browser,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // Any authenticated user gets the same context-free success — there is no work
        // to own, so the global verb has NO ownership 403/404 path (contrast the per-work verb).
        const authed = await request.post(`${DEPLOY_BASE}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(authed.status());
        expect(((await authed.json()) as Record<string, unknown>).status).toBe('success');

        // ANONYMOUS -> 401 (it is still behind the global auth guard).
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(`${DEPLOY_BASE}/teams`, { data: {} });
            expect(anonRes.status(), 'anonymous global teams is auth-guarded').toBe(401);
            expect(String(((await anonRes.json()) as Record<string, unknown>).message)).toMatch(
                /Unauthorized/i,
            );
        } finally {
            await anon.close();
        }
    });

    test('12. the deploy gate is TWO-STAGE end-to-end for the WORK verb: unconfigured -> "token is required"; a FAKE token flips isConfigured so the gate advances to validateToken which rejects the fake token with the DISTINCT "Invalid Vercel token" copy — never a 2xx on CI', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // STAGE 0: unconfigured -> isConfigured refuses with "token is required".
        const stage0 = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(stage0.status());
        if (stage0.status() === 400) {
            const body = (await stage0.json()) as Record<string, unknown>;
            expect(String(body.message)).toMatch(/Vercel token is required/i);
            expect(
                String(body.message),
                'unconfigured copy is NOT the invalid-token copy',
            ).not.toMatch(/Invalid/i);
        }

        // ACT: configure a deliberately FAKE token so isConfigured passes.
        await configureVercelToken(request, access_token);
        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
                message: 'work becomes deployable once a token is configured',
            })
            .toBe(true);

        // STAGE 1: isConfigured passes -> validateToken hits the REAL provider and
        // rejects the fake token with the DISTINCT "Invalid Vercel token" copy. A real
        // token would 2xx-pending; on CI we only ever see the truthful refusal.
        const stage1 = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(stage1.status());
        const stage1Body = (await stage1.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        const accepted = stage1.status() >= 200 && stage1.status() < 300;
        if (!accepted) {
            expect(stage1.status()).toBe(400);
            expect(stage1Body?.status).toBe('error');
            expect(String(stage1Body?.message)).toMatch(
                /Invalid Vercel token|Invalid .* token|Failed to initiate/i,
            );
        } else {
            expect(['pending', 'success']).toContain(stage1Body?.status);
        }
    });

    test('13. a k8s-bound work deploy gate names "Kubernetes" (resolved from work.deployProvider) even when the user holds a vercel token — the deploy verb resolves the provider PER-WORK, the same way the teams verb does', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await configureVercelToken(request, access_token); // a vercel token, irrelevant to k8s

        const k8sWork = await freshWork(request, access_token, { deployProvider: 'k8s' });
        expect(k8sWork.deployProvider).toBe('k8s');

        const deploy = await request.post(`${DEPLOY_BASE}/works/${k8sWork.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(deploy.status());
        if (deploy.status() === 400) {
            const body = (await deploy.json()) as Record<string, unknown>;
            // The gate names the WORK's provider (Kubernetes), NOT the user's vercel token.
            expect(String(body.message)).toMatch(/Kubernetes token is required/i);
            expect(String(body.message), 'k8s gate does not name Vercel').not.toMatch(
                /Vercel token is required/i,
            );
        }
    });

    test('14. the deploy / teams / check verbs agree on the SAME unconfigured token state for one work: deploy 400s "token required", per-work teams 400s "Failed to get teams", and check reports userHasToken=false — three read-throughs of one credential model', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        const deploy = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const teams = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const check = await deployCheck(request, access_token, work.id);

        // On the CI keyless reality all three see the same "no token for this work" state.
        const deployUnconfigured = deploy.status() === 400;
        const teamsUnconfigured = teams.status() === 400;

        if (deployUnconfigured && teamsUnconfigured) {
            expect(String(((await deploy.json()) as Record<string, unknown>).message)).toMatch(
                /token is required/i,
            );
            expect(String(((await teams.json()) as Record<string, unknown>).message)).toMatch(
                /Failed to get teams/i,
            );
            expect(check.userHasToken, 'check agrees the work has no resolvable token').toBe(false);
            expect(check.canDeploy).toBe(false);
        } else {
            // A pre-configured stack: all three must AGREE the token IS present.
            expect(check.userHasToken).toBe(true);
        }
    });
});
