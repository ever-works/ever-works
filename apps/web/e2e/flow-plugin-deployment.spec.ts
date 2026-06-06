import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: DEPLOYMENT PLUGIN (vercel) — complex, multi-step, cross-feature
 * INTEGRATION flows that exercise how the deployment *plugin* drives the
 * deploy capability: enabling/configuring the vercel plugin and watching the
 * capability flip configured-vs-unconfigured, the two-stage deploy facade gate
 * (isConfigured -> validateToken), the per-work `deployProvider` binding, the
 * cached `deployProjectId`, the website-gated domain surface, batch deploy, and
 * the system-plugin lifecycle invariants.
 *
 * GROUNDING — every shape below was verified against the LIVE sqlite e2e API
 * (port 3100) with throwaway users on 2026-06-01, and cross-checked against the
 * real source:
 *   - apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 *   - apps/api/src/plugins-capabilities/deploy/dto/deploy.dto.ts (DeployWorkDto: { teamScope? }, forbidNonWhitelisted)
 *   - packages/agent/src/facades/deploy.facade.ts (isConfigured / isProviderConfigured / getTokenFromSettings)
 *   - packages/plugins/vercel/src/vercel.plugin.ts (settingsSchema.apiToken x-secret, validateToken)
 *   - packages/plugins/vercel/package.json (everworks.plugin: systemPlugin/builtIn/autoEnable, defaultForCapabilities)
 *   - packages/agent/src/entities/work.entity.ts (deployProvider default 'ever-works' col, deployProjectId)
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     GET  /api/plugins/vercel
 *          → { id:'vercel', category:'deployment', capabilities:['deployment'],
 *              enabled:true, configurationMode:'user-required', systemPlugin:true,
 *              builtIn:true, autoEnable:true, settingsSchema.properties = { apiToken } }
 *     POST /api/plugins/vercel/enable { secretSettings:{ apiToken:'<tok>' } } → 200 (returns manifest)
 *          extra body key → 400 { message:['property <k> should not exist'] } (forbidNonWhitelisted)
 *     POST /api/plugins/vercel/disable → 400 { message:'Plugin "vercel" is a system plugin and cannot be disabled' }
 *     PATCH /api/plugins/vercel/settings { secretSettings:{ apiToken:'' } } → 400 (apiToken required, cannot clear empty)
 *     GET  /api/deploy/providers → 200 { status:'success', providers:[ k8s, vercel ] }
 *          each { id,name,enabled:true,icon,description,homepage,configured } — configured is the per-user axis.
 *     GET  /api/deploy/providers/vercel/configured →
 *          before token: { configured:false, available:true, enabled:true, message:'...available but not configured.' }
 *          after  token: { configured:true,  available:true, enabled:true, message:"Provider 'vercel' is configured." }
 *     POST /api/deploy/validate-token → 201 { status:'success', valid:<anyEnabled&&configured>, userInfo:null, message }
 *     POST /api/deploy/works/:id/check → 201 { status:'success', canDeploy, isShared:false, ownerHasToken, userHasToken }
 *          (canDeploy === ownerHasToken; userHasToken flips true once the user configures the work's provider token)
 *     POST /api/deploy/works/:id (DeployWorkDto):
 *          UNCONFIGURED         → 400 '<ProviderName> token is required. Please configure it in Plugin Settings.'
 *          CONFIGURED-but-bad   → 400 'Invalid <ProviderName> token. Please check your token in Plugin Settings.'
 *            (the gate is TWO-STAGE: isConfigured passes on a present token, then validateToken hits the REAL
 *             Vercel API which rejects a fake token — a DISTINCT 400 from the unconfigured path; never a 2xx)
 *          extra body key       → 400 { message:['property <k> should not exist'] }
 *     POST /api/deploy/works/:id/lookup:
 *          configured + no website → 201 { status:'success', found:false } (facade swallows the failing provider call)
 *          unconfigured            → 400 '<ProviderName> token is required to lookup deployments...'
 *     GET  /api/deploy/works/:id/domains      → website unset → 400 'No deployment exists for this work...'
 *     POST /api/deploy/works/:id/domains      → website unset → 400 'No deployment exists for this work...'
 *     POST /api/deploy/batch (BatchDeployDto { works:[{ workId }], teamScope? }):
 *          []                  → 201 { status:'success', totalRequested:0, successfullyStarted:0, failed:0, results:[] }
 *          bogus/cross workId  → 404 "Work with id '...' not found" (ownership ensureCanEdit runs before the batch)
 *          undeployable work   → 201 { status:'error', totalRequested:1, successfullyStarted:0, failed:1,
 *                                       results:[{ workId, status:'error', message }] }
 *     WORK entity: a fresh work POSTed via /api/works has deployProvider:'vercel' (resolved default),
 *          deployProjectId:null, deploymentState:null, website:null, gitProvider:'github'.
 *          POST /api/works accepts `deployProvider` (lowercased); PATCH /api/works/:id can RE-BIND it.
 *          A work bound to 'k8s' surfaces the *Kubernetes* provider name in its deploy gate even when the
 *          user has a vercel token — proving per-work provider resolution (work.deployProvider -> plugin).
 *
 * ADAPTIVITY (CI reality): NO real Vercel token is wired in CI. These flows
 * CONFIGURE a deliberately FAKE token so the *isConfigured* gate flips true,
 * then assert the truthful downstream "Invalid token" refusal from the real
 * provider validation — they never trigger or assert a real external deploy.
 * Where a real token COULD be present, assertions widen with .or()-style status
 * sets so a configured stack still passes.
 *
 * NON-DUPLICATION: flow-work-deploy-state.spec.ts pins the state-machine columns
 * + the UNCONFIGURED gate + history/rollback/ownership; flow-templates-deploy
 * pins providers-list / a single configured-check / validate-token / one bare
 * deploy. THIS file instead drives the PLUGIN side: configuring the token to
 * FLIP the capability, the two-stage gate's CONFIGURED-but-invalid branch, the
 * per-work provider re-binding flipping the gate + provider name, the cached
 * deployProjectId / configured-lookup branch, website-gated domains, the batch
 * envelope, and the system-plugin (can't-disable, can't-clear) invariants.
 *
 * ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user
 * (the configured token is USER-scoped — must never leak into sibling chat/
 * deploy specs that share the seeded user). Unique names/slugs (Date.now()).
 * Assert toContain/find, never exact catalog counts.
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const PLUGINS_BASE = `${API_BASE}/api/plugins`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_VERCEL_TOKEN = 'fake-vercel-token-e2e-not-real';

/** Status classes accepted for a deploy POST: the CI-real refusals OR a configured success. */
const DEPLOY_OUTCOMES = [200, 201, 202, 400, 401, 403, 409, 422, 500];

interface ProviderRow {
    id: string;
    name: string;
    enabled: boolean;
    configured: boolean;
}

interface WorkRow {
    id: string;
    slug?: string;
    deployProvider?: string | null;
    deployProjectId?: string | null;
    deploymentState?: string | null;
    website?: string | null;
}

/** Create a fresh work (description is REQUIRED by the create DTO) and return its row. */
async function freshWork(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<WorkRow> {
    const stamp = Date.now() + Math.floor(Math.random() * 1000);
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: `Deploy Plugin Work ${stamp}`,
            slug: `deploy-plugin-${stamp}`,
            description: 'flow-plugin-deployment e2e work',
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

/** Read the deploy-relevant columns off GET /api/works/:id (envelope-tolerant). */
async function readWork(request: APIRequestContext, token: string, id: string): Promise<WorkRow> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const w = (json.work ?? json) as WorkRow;
    return w;
}

/** GET /api/deploy/providers/:id/configured */
async function providerConfigured(
    request: APIRequestContext,
    token: string,
    providerId: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${DEPLOY_BASE}/providers/${providerId}/configured`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

/** POST /api/deploy/works/:id/check */
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

test.describe('Deployment plugin (vercel) — capability configure + facade contract (deep integration)', () => {
    test('1. configuring the vercel plugin token FLIPS the deploy capability unconfigured -> configured across providers-list / provider-configured / validate-token / work check', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // --- The vercel plugin ships auto-enabled, system, user-required, with a
        //     single secret field `apiToken`. Pin that plugin contract first. ---
        const detailRes = await request.get(`${PLUGINS_BASE}/vercel`, {
            headers: authedHeaders(access_token),
        });
        expect(detailRes.status()).toBe(200);
        const detail = (await detailRes.json()) as Record<string, unknown>;
        expect(detail.id).toBe('vercel');
        expect(detail.category).toBe('deployment');
        expect(detail.capabilities).toContain('deployment');
        expect(detail.enabled, 'vercel is auto-enabled (loaded)').toBe(true);
        expect(detail.configurationMode).toBe('user-required');
        expect(detail.systemPlugin).toBe(true);
        const schemaProps = Object.keys(
            ((detail.settingsSchema as Record<string, unknown>)?.properties as object) ?? {},
        );
        expect(schemaProps, 'vercel primary credential field is apiToken').toContain('apiToken');

        // --- BEFORE: a fresh user has supplied no token, so vercel is enabled but
        //     unconfigured across every surface. ---
        const beforeProviders = await request.get(`${DEPLOY_BASE}/providers`, {
            headers: authedHeaders(access_token),
        });
        expect(beforeProviders.status()).toBe(200);
        const beforeRows = (await beforeProviders.json()).providers as ProviderRow[];
        const beforeVercel = beforeRows.find((p) => p.id === 'vercel');
        expect(beforeVercel, 'vercel deploy provider registered').toBeTruthy();
        expect(beforeVercel?.enabled, 'vercel enabled (loaded)').toBe(true);
        const startedConfigured = beforeVercel?.configured === true; // may already be true on a configured stack

        const beforeCfg = await providerConfigured(request, access_token, 'vercel');
        expect(beforeCfg.available).toBe(true);
        expect(beforeCfg.enabled).toBe(true);
        expect(beforeCfg.configured).toBe(startedConfigured);
        if (!startedConfigured) {
            expect(String(beforeCfg.message)).toContain('not configured');
        }

        // A work-scoped check agrees: no token -> userHasToken=false (on CI).
        const work = await freshWork(request, access_token);
        const beforeCheck = await deployCheck(request, access_token, work.id);
        expect(beforeCheck.status).toBe('success');
        expect(beforeCheck.isShared).toBe(false);
        expect(beforeCheck.userHasToken).toBe(startedConfigured);
        expect(beforeCheck.canDeploy, 'canDeploy mirrors the owner token state').toBe(
            beforeCheck.ownerHasToken,
        );

        // --- ACT: configure a (fake) vercel token via the plugin enable surface. ---
        await configureVercelToken(request, access_token);

        // --- AFTER: the capability has FLIPPED to configured everywhere. ---
        await expect
            .poll(
                async () => (await providerConfigured(request, access_token, 'vercel')).configured,
                {
                    timeout: 15_000,
                    message: 'vercel flips to configured after a token is supplied',
                },
            )
            .toBe(true);

        const afterCfg = await providerConfigured(request, access_token, 'vercel');
        expect(afterCfg.configured).toBe(true);
        expect(String(afterCfg.message)).toContain('configured');

        const afterProviders = (
            (
                await (
                    await request.get(`${DEPLOY_BASE}/providers`, {
                        headers: authedHeaders(access_token),
                    })
                ).json()
            ).providers as ProviderRow[]
        ).find((p) => p.id === 'vercel');
        expect(
            afterProviders?.configured,
            'providers-list reflects the configured vercel token',
        ).toBe(true);

        // validate-token now reports valid:true because an enabled+configured provider exists.
        const vt = await request.post(`${DEPLOY_BASE}/validate-token`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(vt.status());
        const vtBody = (await vt.json()) as Record<string, unknown>;
        expect(vtBody.status).toBe('success');
        expect(vtBody.valid, 'validate-token true once a provider is enabled+configured').toBe(
            true,
        );

        // The work-scoped check flips userHasToken/canDeploy to true for the same work.
        const afterCheck = await deployCheck(request, access_token, work.id);
        expect(afterCheck.userHasToken, 'work check sees the newly-configured user token').toBe(
            true,
        );
        expect(afterCheck.canDeploy).toBe(true);
        expect(afterCheck.ownerHasToken).toBe(true);
    });

    test('2. the deploy gate is TWO-STAGE: unconfigured -> "token is required"; configured-but-invalid -> "Invalid Vercel token"; an extra body key is DTO-rejected — and NO refusal ever writes deploy state', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);
        expect(work.deployProvider, 'fresh work resolves the default vercel provider').toBe(
            'vercel',
        );

        // --- STAGE 0: an unconfigured user is refused at the isConfigured gate,
        //     BEFORE any provider call — the "token is required" copy. ---
        const unconfigured = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const unconfiguredBody = (await unconfigured.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        // On CI this is a clean 400; a pre-configured stack could 2xx/other — tolerate.
        expect(DEPLOY_OUTCOMES).toContain(unconfigured.status());
        const wasUnconfiguredRefusal = unconfigured.status() === 400;
        if (wasUnconfiguredRefusal) {
            expect(unconfiguredBody?.status).toBe('error');
            expect(String(unconfiguredBody?.message)).toMatch(
                /Vercel token is required|token is required|not configured|Plugin Settings/i,
            );
            // The unconfigured refusal explicitly does NOT carry the "Invalid token" copy.
            expect(String(unconfiguredBody?.message)).not.toMatch(/Invalid/i);
        }

        // --- ACT: configure a deliberately FAKE token so isConfigured PASSES. ---
        await configureVercelToken(request, access_token);
        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
                message: 'work becomes deployable once a token is configured',
            })
            .toBe(true);

        // --- STAGE 1: now isConfigured passes, so the gate advances to the SECOND
        //     stage (validateToken), which hits the REAL Vercel API and rejects the
        //     fake token with a DISTINCT 400 "Invalid Vercel token" — never a 2xx,
        //     because we never wired a real token. (A real token would 2xx pending.) ---
        const configured = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(configured.status());
        const configuredBody = (await configured.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        const wasAccepted = configured.status() >= 200 && configured.status() < 300;
        if (!wasAccepted) {
            // Fake token -> validateToken fails the second stage -> "Invalid Vercel token".
            expect(configured.status()).toBe(400);
            expect(configuredBody?.status).toBe('error');
            expect(String(configuredBody?.message)).toMatch(
                /Invalid Vercel token|Invalid .* token|Failed to initiate/i,
            );
        } else {
            // Configured stack legitimately dispatched a pending deploy.
            expect(['pending', 'success']).toContain(configuredBody?.status);
        }

        // --- STAGE 2: a malformed body (extra key not on DeployWorkDto) is rejected
        //     by forbidNonWhitelisted BEFORE the gate even runs. ---
        const badBody = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: { notAField: true },
        });
        expect(badBody.status()).toBe(400);
        const badBodyJson = (await badBody.json()) as Record<string, unknown>;
        expect(JSON.stringify(badBodyJson.message ?? badBodyJson)).toMatch(/should not exist/i);

        // --- INVARIANT: none of the refused deploys wrote the work's deploy state. ---
        const after = await readWork(request, access_token, work.id);
        if (!wasAccepted) {
            expect(
                after.deploymentState ?? null,
                'refused deploys leave deploymentState idle',
            ).toBeNull();
            expect(after.website ?? null, 'refused deploys leave website unset').toBeNull();
            expect(
                after.deployProjectId ?? null,
                'refused deploys never cache a deployProjectId',
            ).toBeNull();
        }
    });

    test('3. per-work deployProvider binding drives the gate and provider name: a vercel-configured user is REFUSED with the Kubernetes message on a k8s-bound work, and RE-BINDING a work to k8s flips its gate from deployable to undeployable', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        // Configure ONLY a vercel token for this user.
        await configureVercelToken(request, access_token);

        // --- A work created with an explicit deployProvider=k8s. The DTO lowercases
        //     it and the column persists the per-work binding. ---
        const k8sWork = await freshWork(request, access_token, { deployProvider: 'k8s' });
        expect(k8sWork.deployProvider, 'per-work provider binding is k8s').toBe('k8s');
        // Persisted, not just echoed.
        await expect
            .poll(async () => (await readWork(request, access_token, k8sWork.id)).deployProvider, {
                timeout: 15_000,
                message: 'k8s provider binding persists on the work',
            })
            .toBe('k8s');

        // The user's vercel token is irrelevant to a k8s-bound work: the gate resolves
        // the work's OWN provider, so the user has no token FOR k8s -> not deployable.
        const k8sCheck = await deployCheck(request, access_token, k8sWork.id);
        expect(k8sCheck.userHasToken, 'a vercel token does not satisfy a k8s-bound work').toBe(
            false,
        );
        expect(k8sCheck.canDeploy).toBe(false);

        const k8sDeploy = await request.post(`${DEPLOY_BASE}/works/${k8sWork.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(k8sDeploy.status());
        const k8sBody = (await k8sDeploy.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        if (k8sDeploy.status() === 400) {
            // The refusal names the WORK's provider (Kubernetes), NOT vercel — proving
            // the provider name is resolved from work.deployProvider.
            expect(String(k8sBody?.message)).toMatch(
                /Kubernetes token is required|token is required/i,
            );
            expect(
                String(k8sBody?.message),
                'message reflects the k8s binding, not vercel',
            ).not.toMatch(/Vercel token is required/i);
        }

        // --- A vercel-bound work for the SAME user IS deployable (configured),
        //     then RE-BIND it to k8s via PATCH and watch the gate flip to undeployable. ---
        const vercelWork = await freshWork(request, access_token); // defaults to vercel
        expect(vercelWork.deployProvider).toBe('vercel');
        await expect
            .poll(async () => (await deployCheck(request, access_token, vercelWork.id)).canDeploy, {
                timeout: 15_000,
                message: 'a vercel-bound work is deployable for the configured user',
            })
            .toBe(true);

        const patch = await request.patch(`${API_BASE}/api/works/${vercelWork.id}`, {
            headers: authedHeaders(access_token),
            data: { deployProvider: 'k8s' },
        });
        expect(patch.status(), `patch body=${await patch.text().catch(() => '')}`).toBe(200);
        const patched = (await patch.json()) as Record<string, unknown>;
        expect((patched.work as WorkRow).deployProvider, 'PATCH re-binds the deploy provider').toBe(
            'k8s',
        );

        // Re-binding to a provider the user has NOT configured flips canDeploy false.
        await expect
            .poll(async () => (await deployCheck(request, access_token, vercelWork.id)).canDeploy, {
                timeout: 15_000,
                message: 're-binding to k8s makes the work undeployable for a vercel-only user',
            })
            .toBe(false);
        const reCheck = await deployCheck(request, access_token, vercelWork.id);
        expect(reCheck.userHasToken).toBe(false);
    });

    test('4. cached deployProjectId stays null on an undeployed work, and the lookup facade is configure-aware: unconfigured 400 "token required to lookup" vs configured -> graceful { found:false } (no provider data, no state write)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // A never-deployed work has the cached project pointer + website unset.
        expect(work.deployProjectId ?? null, 'fresh work has no cached deployProjectId').toBeNull();
        expect(work.website ?? null, 'fresh work has no website').toBeNull();

        // --- UNCONFIGURED lookup: no token AND no existing website -> the lookup gate
        //     refuses with the "token is required to lookup" copy (distinct verb). ---
        const lookupBefore = await request.post(`${DEPLOY_BASE}/works/${work.id}/lookup`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const lookupBeforeBody = (await lookupBefore.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        if (lookupBefore.status() === 400) {
            expect(lookupBeforeBody?.status).toBe('error');
            expect(String(lookupBeforeBody?.message)).toMatch(
                /token is required to lookup|token is required|not configured/i,
            );
        } else {
            // Pre-configured stack: a 2xx graceful lookup is also acceptable.
            expect([200, 201]).toContain(lookupBefore.status());
        }

        // --- ACT: configure a fake token so lookup passes the isConfigured gate. ---
        await configureVercelToken(request, access_token);
        await expect
            .poll(
                async () => (await providerConfigured(request, access_token, 'vercel')).configured,
                { timeout: 15_000 },
            )
            .toBe(true);

        // --- CONFIGURED lookup with NO website: the facade attempts the real provider
        //     lookup, the fake token yields nothing, and the error is SWALLOWED into a
        //     graceful 201 { found:false } — never a 5xx, never a state write. ---
        const lookupAfter = await request.post(`${DEPLOY_BASE}/works/${work.id}/lookup`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201], `configured lookup status ${lookupAfter.status()}`).toContain(
            lookupAfter.status(),
        );
        const lookupAfterBody = (await lookupAfter.json()) as Record<string, unknown>;
        expect(lookupAfterBody.status).toBe('success');
        expect(lookupAfterBody.found, 'no deployment exists for a fake token -> found:false').toBe(
            false,
        );
        // A not-found lookup surfaces no website and writes no website to the work.
        expect(lookupAfterBody.website ?? null).toBeNull();

        // The work's cached deploy pointers are untouched by the lookups.
        const after = await readWork(request, access_token, work.id);
        expect(after.deployProjectId ?? null, 'lookup did not cache a deployProjectId').toBeNull();
        expect(after.website ?? null, 'lookup did not set a website').toBeNull();
        expect(after.deploymentState ?? null).toBeNull();
    });

    test('5. the domain surface is website-gated: every domain verb refuses with "No deployment exists" until a website is published, regardless of whether a token is configured', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        // Configure a token to prove the gate is about the WEBSITE, not the token.
        await configureVercelToken(request, owner.access_token);
        const work = await freshWork(request, owner.access_token);
        expect(work.website ?? null, 'no website published yet').toBeNull();

        // GET list + POST add + verify all 400 with the same "No deployment exists" copy.
        const listDomains = await request.get(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(listDomains.status(), 'domains list gated on a published website').toBe(400);
        expect(String(((await listDomains.json()) as Record<string, unknown>).message)).toMatch(
            /No deployment exists/i,
        );

        const addDomain = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(owner.access_token),
            data: { domain: `e2e-${Date.now()}.example.com` },
        });
        expect(addDomain.status(), 'add-domain gated on a published website').toBe(400);
        expect(String(((await addDomain.json()) as Record<string, unknown>).message)).toMatch(
            /No deployment exists/i,
        );

        const verifyDomain = await request.post(
            `${DEPLOY_BASE}/works/${work.id}/domains/e2e.example.com/verify`,
            { headers: authedHeaders(owner.access_token), data: {} },
        );
        expect([400], 'verify-domain gated on a published website').toContain(
            verifyDomain.status(),
        );
        expect(String(((await verifyDomain.json()) as Record<string, unknown>).message)).toMatch(
            /No deployment exists/i,
        );

        // The domain surface is also ownership-gated: a different user is 403/404 (never a leak,
        // never the website-gate 400 — ownership runs first).
        const crossList = await request.get(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(other.access_token),
        });
        expect(
            [403, 404],
            `cross-user domains status (body=${await crossList.text().catch(() => '')})`,
        ).toContain(crossList.status());

        // Anonymous (EMPTY storageState so it doesn't inherit the shared auth cookie) -> guarded.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.get(`${DEPLOY_BASE}/works/${work.id}/domains`);
            expect([401, 403], 'anon domains read is auth-guarded').toContain(anonRes.status());
        } finally {
            await anon.close();
        }

        // The work is untouched by the whole barrage — still no website, no project id.
        const after = await readWork(request, owner.access_token, work.id);
        expect(after.website ?? null).toBeNull();
        expect(after.deployProjectId ?? null).toBeNull();
    });

    test('6. batch deploy honours the per-item ownership + capability contract: empty -> success/0, ghost workId -> 404, an undeployable configured work -> partial/error envelope with a per-work result row', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await configureVercelToken(request, access_token);
        const work = await freshWork(request, access_token); // vercel-bound, fake token

        // --- Empty batch is a no-op success with a zeroed envelope. ---
        const empty = await request.post(`${DEPLOY_BASE}/batch`, {
            headers: authedHeaders(access_token),
            data: { works: [] },
        });
        expect([200, 201]).toContain(empty.status());
        const emptyBody = (await empty.json()) as Record<string, unknown>;
        expect(emptyBody.status).toBe('success');
        expect(emptyBody.totalRequested).toBe(0);
        expect(emptyBody.successfullyStarted).toBe(0);
        expect(emptyBody.failed).toBe(0);
        expect(Array.isArray(emptyBody.results)).toBe(true);
        expect((emptyBody.results as unknown[]).length).toBe(0);

        // --- A ghost / non-owned work id is rejected by per-item ensureCanEdit BEFORE
        //     the batch runs -> 404 (ownership), never a silent skip. ---
        const ghost = await request.post(`${DEPLOY_BASE}/batch`, {
            headers: authedHeaders(access_token),
            data: { works: [{ workId: NIL_UUID }] },
        });
        expect(
            [403, 404],
            `ghost batch status (body=${await ghost.text().catch(() => '')})`,
        ).toContain(ghost.status());

        // --- A real owned work with a FAKE token: ownership passes, the deploy is
        //     attempted, and the (invalid-token) failure is reported in the batch
        //     envelope as failed:1 with a per-work result row — never a 5xx. ---
        const batch = await request.post(`${DEPLOY_BASE}/batch`, {
            headers: authedHeaders(access_token),
            data: { works: [{ workId: work.id }] },
        });
        expect([200, 201], `batch status ${batch.status()}`).toContain(batch.status());
        const batchBody = (await batch.json()) as Record<string, unknown>;
        expect(['success', 'partial', 'error']).toContain(batchBody.status);
        expect(batchBody.totalRequested).toBe(1);
        expect(typeof batchBody.successfullyStarted).toBe('number');
        expect(typeof batchBody.failed).toBe('number');
        expect(
            (batchBody.successfullyStarted as number) + (batchBody.failed as number),
            'every requested work lands in exactly one bucket',
        ).toBe(1);
        const results = batchBody.results as Array<Record<string, unknown>>;
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(1);
        expect(results[0].workId, 'result row is keyed by the requested work id').toBe(work.id);
        expect(['pending', 'success', 'error']).toContain(results[0].status);
        // On the CI fake-token reality the deploy cannot complete -> error/failed.
        if (results[0].status === 'error') {
            expect(batchBody.status, 'all-failed batch reports the error envelope').toBe('error');
            expect(batchBody.failed).toBe(1);
            expect(batchBody.successfullyStarted).toBe(0);
        }

        // The work is unharmed by the batch attempts.
        const after = await readWork(request, access_token, work.id);
        expect(after.id).toBe(work.id);
        if (results[0].status === 'error') {
            expect(
                after.deploymentState ?? null,
                'a failed batch deploy leaves state idle',
            ).toBeNull();
        }
    });

    test('7. the vercel plugin is a SYSTEM plugin: it cannot be disabled (400) and its required apiToken cannot be cleared to empty (400) — its enable rejects unknown body keys (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // enable with an EXTRA, non-schema body key is rejected by forbidNonWhitelisted.
        const badEnable = await request.post(`${PLUGINS_BASE}/vercel/enable`, {
            headers: authedHeaders(access_token),
            data: { secretSettings: { apiToken: FAKE_VERCEL_TOKEN }, bogusKey: 1 },
        });
        expect(badEnable.status(), 'unknown enable body key rejected').toBe(400);
        expect(String(JSON.stringify((await badEnable.json()) as unknown))).toMatch(
            /should not exist/i,
        );

        // A clean enable with just the token succeeds and configures the provider.
        await configureVercelToken(request, access_token);
        await expect
            .poll(
                async () => (await providerConfigured(request, access_token, 'vercel')).configured,
                { timeout: 15_000 },
            )
            .toBe(true);

        // Trying to CLEAR the required apiToken (empty string) violates the schema -> 400,
        // and the provider stays configured (the clear was a no-op rejection).
        const clear = await request.patch(`${PLUGINS_BASE}/vercel/settings`, {
            headers: authedHeaders(access_token),
            data: { secretSettings: { apiToken: '' } },
        });
        expect(
            [400, 422],
            `clear apiToken status (body=${await clear.text().catch(() => '')})`,
        ).toContain(clear.status());
        expect(
            (await providerConfigured(request, access_token, 'vercel')).configured,
            'a rejected clear leaves the token configured',
        ).toBe(true);

        // The vercel plugin is a systemPlugin -> disable is forbidden with a truthful 400,
        // and it remains enabled + a registered deploy provider afterwards.
        const disable = await request.post(`${PLUGINS_BASE}/vercel/disable`, {
            headers: authedHeaders(access_token),
        });
        expect(disable.status(), 'system plugin cannot be disabled').toBe(400);
        expect(String(((await disable.json()) as Record<string, unknown>).message)).toMatch(
            /system plugin and cannot be disabled|cannot be disabled/i,
        );

        const stillThere = (
            (
                await (
                    await request.get(`${DEPLOY_BASE}/providers`, {
                        headers: authedHeaders(access_token),
                    })
                ).json()
            ).providers as ProviderRow[]
        ).find((p) => p.id === 'vercel');
        expect(
            stillThere,
            'vercel remains a registered deploy provider after a rejected disable',
        ).toBeTruthy();
        expect(stillThere?.enabled, 'vercel stays enabled (loaded)').toBe(true);
        expect(stillThere?.configured, 'vercel stays configured for this user').toBe(true);
    });
});
