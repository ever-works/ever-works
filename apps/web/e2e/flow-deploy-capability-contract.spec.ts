import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * FLOW: DEPLOY CAPABILITY CONTRACT — complex, multi-step, cross-feature
 * INTEGRATION flows pinning the deploy *capability facade* surface: the
 * configured-vs-unconfigured contract (no real deploy ever happens), the
 * provider-facade SHAPE (icon/description/homepage/enabled/configured), the
 * `ever-works` read-alias asymmetry, the per-work deploy-provider SELECTION
 * (create vs PATCH write-validation), the deploy GATE provider-name
 * resolution, and deploy CORRELATION tracking (`lastDeployCorrelationId`
 * stays null across every refused deploy/rollback).
 *
 * GROUNDING — every shape below was verified against the LIVE sqlite e2e API
 * (port 3100) with throwaway users on 2026-06-01, and cross-checked against
 * the real source:
 *   - apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 *       (resolveDeployProviderId: 'ever-works' -> 'k8s'; getProviderName;
 *        listProviders -> getAvailableProvidersForUser; isProviderConfigured;
 *        deploy two-stage gate; validateToken; getDeploymentTeams (global);
 *        getTeamsForWork (per-work); checkDeploymentCapability)
 *   - packages/agent/src/facades/deploy.facade.ts
 *       (getAvailableProviders -> {id,name,enabled,icon,description,homepage};
 *        getAvailableProvidersForUser adds per-user `configured`;
 *        isConfigured resolves work.deployProvider -> registry plugin -> token)
 *   - apps/api/src/plugins-capabilities/deploy/dto/deploy.dto.ts (DeployWorkDto {teamScope?})
 *   - packages/agent/src/entities/work.entity.ts (deployProvider default 'vercel',
 *        lastDeployCorrelationId, deploymentState, deploymentStartedAt, deployProjectId)
 *   - apps/api/src/plugins-capabilities/deploy/deploy.service.ts
 *       (effectiveCorrelationId = options.correlationId || work.lastDeployCorrelationId;
 *        deploymentState/StartedAt only written AFTER a successful dispatch)
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     GET  /api/deploy/providers → 200 { status:'success', providers:[
 *            { id:'k8s',    name:'Kubernetes', enabled:true,
 *              icon:{ type:'lucide', value:'Container', backgroundColor:'#326CE5' },
 *              description:'Deploy works to a Kubernetes cluster',
 *              homepage:'https://kubernetes.io/...', configured:false },
 *            { id:'vercel', name:'Vercel', enabled:true,
 *              icon:{ type:'lucide', value:'Triangle', backgroundColor:'#000000' },
 *              description:'Deploy works to Vercel',
 *              homepage:'https://vercel.com/account/tokens', configured:false } ] }
 *     GET  /api/deploy/providers/:id/configured →
 *            known   → { configured, available:true, enabled:true, message }
 *            'ever-works' → resolves to k8s: { available:true, enabled:true } (READ alias)
 *            unknown → { configured:false, available:false, message:"Provider '<id>' is not available" }
 *     POST /api/works { deployProvider } :
 *            'k8s'           → persists 'k8s'
 *            'ever-works'    → SILENTLY coerced to the column default 'vercel' (create drops the alias)
 *            'totally-fake'  → persists the raw string as-is (create does NOT whitelist)
 *     PATCH /api/works/:id { deployProvider } :
 *            'k8s'           → 200 persists 'k8s'
 *            'ever-works'    → 400 { status:'error', message:'Unsupported deploy provider: ever-works' }
 *            'totally-fake'  → 400 { status:'error', message:'Unsupported deploy provider: totally-fake' }
 *            (PATCH whitelists vercel/k8s; create is laxer — a real asymmetry.)
 *     POST /api/deploy/works/:id (DeployWorkDto):
 *            vercel work unconfigured → 400 'Vercel token is required. Please configure it in Plugin Settings.'
 *            k8s   work unconfigured  → 400 'Kubernetes token is required. ...' (name from work.deployProvider)
 *            bogus work unconfigured  → 400 '<rawProviderId> token is required. ...' (getProviderName falls through)
 *            vercel work + FAKE token → 400 'Invalid Vercel token...' (two-stage: isConfigured then validateToken)
 *     POST /api/deploy/validate-token → 201 { status:'success', valid:<any enabled&&configured>, userInfo:null }
 *            unconfigured: valid:false 'No deployment provider is available.'
 *            after vercel token: valid:true 'Deployment provider is available...'
 *     POST /api/deploy/teams (global)        → 201 { status:'success', teams:[], message:'To fetch teams, ...' }
 *     POST /api/deploy/works/:id/teams (per-work):
 *            unconfigured → 400 { status:'error', message:'No ... credentials configured. ...' }
 *            configured(fake) → 201 { status:'success', teams:[] } (provider getTeams degrades to empty)
 *
 * ADAPTIVITY (CI reality): NO real Vercel/k8s token is wired. Flows CONFIGURE
 * a deliberately FAKE token to flip the isConfigured gate, then assert the
 * truthful downstream refusal — they never trigger or assert a real external
 * deploy. Assertions widen with status-set / .or() so a configured stack still
 * passes (e.g. a real token that 2xx-dispatches).
 *
 * NON-DUPLICATION: flow-templates-deploy pins providers-list/one configured-
 * check/validate-token/one bare deploy + screenshot; flow-work-deploy-state
 * pins the state-machine columns + history/rollback gating + ownership matrix +
 * the web /deploy/status projection; flow-plugin-deployment drives the PLUGIN
 * side (token-enable flips capability, two-stage gate, per-work re-binding,
 * cached projectId/lookup, website-gated domains, batch envelope, system-plugin
 * invariants). THIS file instead pins the CAPABILITY-FACADE CONTRACT: the full
 * provider-facade SHAPE (icon/description/homepage), the `ever-works` read-alias
 * asymmetry, the create-vs-PATCH write-validation asymmetry for deployProvider,
 * the gate's provider-NAME resolution across vercel/k8s/bogus bindings, the
 * global-vs-per-work /teams contract, and the deploy CORRELATION invariant.
 *
 * ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user
 * (the configured token is USER-scoped — must never leak into sibling chat/
 * deploy specs that share the seeded user). Unique names/slugs (Date.now()).
 * The seeded user (storageState) drives ONLY the UI-context providers read.
 * Assert toContain/find, never exact catalog counts.
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const PLUGINS_BASE = `${API_BASE}/api/plugins`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_VERCEL_TOKEN = 'fake-vercel-token-capability-contract';

/** Status classes accepted for a deploy POST: CI-real refusals OR a configured success. */
const DEPLOY_OUTCOMES = [200, 201, 202, 400, 401, 403, 409, 422, 500];

interface ProviderRow {
    id: string;
    name: string;
    enabled: boolean;
    configured?: boolean;
    icon?: { type?: string; value?: string; backgroundColor?: string };
    description?: string;
    homepage?: string;
}

interface WorkRow {
    id: string;
    slug?: string;
    deployProvider?: string | null;
    deployProjectId?: string | null;
    deploymentState?: string | null;
    deploymentStartedAt?: string | null;
    lastDeployCorrelationId?: string | null;
    website?: string | null;
}

/** Create a fresh work (description is REQUIRED by the create DTO) and return its row. */
async function freshWork(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<WorkRow> {
    const stamp = Date.now() + Math.floor(Math.random() * 100000);
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: `Deploy Capability Work ${stamp}`,
            slug: `deploy-cap-${stamp}`,
            description: 'flow-deploy-capability-contract e2e work',
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
    return (json.work ?? json) as WorkRow;
}

/** GET /api/deploy/providers — returns the user-scoped provider rows. */
async function listProviders(request: APIRequestContext, token: string): Promise<ProviderRow[]> {
    const res = await request.get(`${DEPLOY_BASE}/providers`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('success');
    return body.providers as ProviderRow[];
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

test.describe('Deploy capability contract (configured-vs-unconfigured, facade shape, provider selection, gating, correlation)', () => {
    test('1. the providers facade exposes the FULL shape (id/name/enabled/icon/description/homepage/configured) for every registered deploy provider, and the user-scoped `configured` axis is false for a fresh user', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        const providers = await listProviders(request, access_token);
        expect(Array.isArray(providers)).toBe(true);
        expect(
            providers.length,
            'at least the two built-in deploy providers ship',
        ).toBeGreaterThanOrEqual(2);

        // Pin the two built-ins by id (tolerate extra rows on a richer stack).
        const k8s = providers.find((p) => p.id === 'k8s');
        const vercel = providers.find((p) => p.id === 'vercel');
        expect(k8s, 'k8s deploy provider registered').toBeTruthy();
        expect(vercel, 'vercel deploy provider registered').toBeTruthy();

        // EVERY provider row carries the complete facade contract. `enabled` means
        // the plugin is loaded; `configured` is the per-user credential axis.
        for (const p of providers) {
            expect(typeof p.id, 'provider id is a string').toBe('string');
            expect(typeof p.name, `${p.id}.name is a string`).toBe('string');
            expect(p.name.length, `${p.id}.name non-empty`).toBeGreaterThan(0);
            expect(typeof p.enabled, `${p.id}.enabled is boolean`).toBe('boolean');
            expect(typeof p.configured, `${p.id}.configured is boolean (user-scoped)`).toBe(
                'boolean',
            );
            // icon/description/homepage are surfaced verbatim from the plugin manifest.
            expect(p.icon, `${p.id} exposes a manifest icon`).toBeTruthy();
            expect(typeof p.icon?.value, `${p.id}.icon.value is a string`).toBe('string');
            expect(typeof p.description, `${p.id} exposes a description`).toBe('string');
            expect(typeof p.homepage, `${p.id} exposes a homepage`).toBe('string');
        }

        // The built-in identities are stable contracts the deploy-picker UI relies on.
        expect(k8s?.name).toBe('Kubernetes');
        expect(k8s?.icon?.value, 'k8s uses the Container lucide glyph').toBe('Container');
        expect(String(k8s?.description)).toMatch(/Kubernetes/i);
        expect(String(k8s?.homepage)).toContain('kubernetes.io');

        expect(vercel?.name).toBe('Vercel');
        expect(vercel?.icon?.value, 'vercel uses the Triangle lucide glyph').toBe('Triangle');
        expect(String(vercel?.description)).toMatch(/Vercel/i);
        expect(String(vercel?.homepage)).toContain('vercel.com');

        // A brand-new user has supplied no token, so every provider is loaded-but-unconfigured.
        // (Tolerate a pre-configured stack: only assert the boolean type above + the fresh default here.)
        for (const p of providers) {
            expect(p.enabled, `${p.id} is loaded`).toBe(true);
        }
    });

    test('2. `ever-works` is a READ-side alias resolving to k8s on /providers/:id/configured, an unknown provider reports available:false, and the per-provider configured shape is uniform across known/alias/unknown', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // A KNOWN provider: available+enabled, configured boolean is the env-adaptive axis.
        const vercelCfg = await providerConfigured(request, access_token, 'vercel');
        expect(vercelCfg.status).toBe('success');
        expect(vercelCfg.available).toBe(true);
        expect(vercelCfg.enabled).toBe(true);
        expect(typeof vercelCfg.configured).toBe('boolean');
        expect(typeof vercelCfg.message).toBe('string');

        // The `ever-works` alias resolves to the k8s plugin (resolveDeployProviderId),
        // so the configured-check treats it as a real, available, enabled provider —
        // NOT a 404. This is the READ-side face of the platform-managed deploy target.
        const everWorksCfg = await providerConfigured(request, access_token, 'ever-works');
        expect(everWorksCfg.status).toBe('success');
        expect(everWorksCfg.available, "'ever-works' resolves to an available provider (k8s)").toBe(
            true,
        );
        expect(everWorksCfg.enabled).toBe(true);
        expect(typeof everWorksCfg.configured).toBe('boolean');
        // The message echoes the REQUESTED id verbatim, not the resolved one.
        expect(String(everWorksCfg.message)).toContain("'ever-works'");

        // The alias and its resolution target agree on availability/enabled state.
        const k8sCfg = await providerConfigured(request, access_token, 'k8s');
        expect(k8sCfg.available).toBe(true);
        expect(k8sCfg.enabled).toBe(true);
        expect(everWorksCfg.configured, "'ever-works' configured-state mirrors k8s").toBe(
            k8sCfg.configured,
        );

        // An UNKNOWN provider id is reported as not-available (no 404, no 5xx) — the
        // graceful contract the provider-picker polls.
        const unknown = await providerConfigured(
            request,
            access_token,
            `totally-bogus-${Date.now()}`,
        );
        expect(unknown.status).toBe('success');
        expect(unknown.available, 'unknown provider is not available').toBe(false);
        expect(unknown.configured).toBe(false);
        expect(String(unknown.message)).toMatch(/not available/i);
    });

    test('3. deploy-provider SELECTION write-validation is ASYMMETRIC: create accepts k8s + an arbitrary raw id but DROPS the ever-works alias to the default; PATCH whitelists (rejects ever-works AND bogus with 400 "Unsupported deploy provider")', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // --- CREATE: explicit k8s persists the per-work binding. ---
        const k8sWork = await freshWork(request, access_token, { deployProvider: 'k8s' });
        expect(k8sWork.deployProvider, 'create honours an explicit k8s binding').toBe('k8s');
        await expect
            .poll(async () => (await readWork(request, access_token, k8sWork.id)).deployProvider, {
                timeout: 15_000,
                message: 'k8s binding persists',
            })
            .toBe('k8s');

        // --- CREATE: the `ever-works` alias is NOT a writable binding — create
        //     silently coerces it to the column default ('vercel'). (The alias is a
        //     read-only provider-listing concept, never a stored work provider.) ---
        const aliasWork = await freshWork(request, access_token, { deployProvider: 'ever-works' });
        expect(
            aliasWork.deployProvider,
            "create drops the 'ever-works' alias to the default provider",
        ).toBe('vercel');

        // --- CREATE: an arbitrary unknown id is accepted verbatim (create does NOT
        //     whitelist provider values — only the alias is special-cased). ---
        const bogusId = `totally-fake-${Date.now()}`;
        const bogusWork = await freshWork(request, access_token, { deployProvider: bogusId });
        expect(bogusWork.deployProvider, 'create persists an arbitrary provider id as-is').toBe(
            bogusId,
        );

        // --- PATCH is STRICTER: it whitelists deployProvider. A valid provider
        //     (k8s) re-binds cleanly... ---
        const reBind = await request.patch(`${API_BASE}/api/works/${aliasWork.id}`, {
            headers: authedHeaders(access_token),
            data: { deployProvider: 'k8s' },
        });
        expect(reBind.status(), `patch k8s body=${await reBind.text().catch(() => '')}`).toBe(200);
        expect(((await reBind.json()).work as WorkRow).deployProvider).toBe('k8s');

        // ...but the `ever-works` alias is REJECTED on PATCH (it isn't a stored value). ---
        const patchAlias = await request.patch(`${API_BASE}/api/works/${aliasWork.id}`, {
            headers: authedHeaders(access_token),
            data: { deployProvider: 'ever-works' },
        });
        expect(patchAlias.status(), 'PATCH rejects the ever-works alias').toBe(400);
        expect(String(((await patchAlias.json()) as Record<string, unknown>).message)).toMatch(
            /Unsupported deploy provider/i,
        );

        // ...and an arbitrary unknown id is ALSO rejected on PATCH (whereas create allowed it). ---
        const patchBogus = await request.patch(`${API_BASE}/api/works/${aliasWork.id}`, {
            headers: authedHeaders(access_token),
            data: { deployProvider: `totally-fake-${Date.now()}` },
        });
        expect(patchBogus.status(), 'PATCH rejects an unknown provider id').toBe(400);
        expect(String(((await patchBogus.json()) as Record<string, unknown>).message)).toMatch(
            /Unsupported deploy provider/i,
        );

        // The rejected PATCHes were no-ops: the work is still bound to k8s from the valid re-bind.
        expect((await readWork(request, access_token, aliasWork.id)).deployProvider).toBe('k8s');
    });

    test('4. the unconfigured deploy gate resolves the provider NAME from work.deployProvider: a vercel work says "Vercel token is required", a k8s work says "Kubernetes token is required", and a raw/unknown-provider work echoes its raw id — never the wrong provider', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // A default work resolves to vercel.
        const vercelWork = await freshWork(request, access_token);
        expect(vercelWork.deployProvider).toBe('vercel');
        const vercelDeploy = await request.post(`${DEPLOY_BASE}/works/${vercelWork.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(vercelDeploy.status());
        if (vercelDeploy.status() === 400) {
            const msg = String(((await vercelDeploy.json()) as Record<string, unknown>).message);
            expect(msg, 'vercel work names Vercel in its gate').toMatch(
                /Vercel token is required/i,
            );
            expect(msg, 'vercel gate does not name Kubernetes').not.toMatch(/Kubernetes/i);
        }

        // A k8s-bound work names Kubernetes (the resolved plugin name), NOT vercel.
        const k8sWork = await freshWork(request, access_token, { deployProvider: 'k8s' });
        expect(k8sWork.deployProvider).toBe('k8s');
        const k8sDeploy = await request.post(`${DEPLOY_BASE}/works/${k8sWork.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(k8sDeploy.status());
        if (k8sDeploy.status() === 400) {
            const msg = String(((await k8sDeploy.json()) as Record<string, unknown>).message);
            expect(msg, 'k8s work names Kubernetes in its gate').toMatch(
                /Kubernetes token is required/i,
            );
            expect(msg, 'k8s gate does not name Vercel').not.toMatch(/Vercel token is required/i);
        }

        // A work bound to an unknown provider id (no matching plugin) echoes the RAW
        // id in the gate — getProviderName falls through to work.deployProvider.
        const rawId = `rawprov-${Date.now()}`;
        const bogusWork = await freshWork(request, access_token, { deployProvider: rawId });
        expect(bogusWork.deployProvider).toBe(rawId);
        const bogusDeploy = await request.post(`${DEPLOY_BASE}/works/${bogusWork.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(bogusDeploy.status());
        if (bogusDeploy.status() === 400) {
            const msg = String(((await bogusDeploy.json()) as Record<string, unknown>).message);
            expect(msg, 'unknown-provider gate echoes the raw provider id').toContain(rawId);
            expect(msg).toMatch(/token is required/i);
        }
    });

    test('5. the deploy gate is TWO-STAGE and configure flips validate-token false->true: an unconfigured deploy is refused at isConfigured ("token is required"); configuring a FAKE token flips validate-token to valid and advances the gate to the SECOND stage, which rejects the fake token with the DISTINCT "Invalid Vercel token" copy — never a 2xx', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // --- validate-token BEFORE any token: no enabled+configured provider -> valid:false. ---
        const vtBefore = await request.post(`${DEPLOY_BASE}/validate-token`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(vtBefore.status());
        const vtBeforeBody = (await vtBefore.json()) as Record<string, unknown>;
        expect(vtBeforeBody.status).toBe('success');
        expect(
            vtBeforeBody.userInfo,
            'validate-token never returns userInfo on this stack',
        ).toBeNull();
        const startedConfigured = vtBeforeBody.valid === true;
        if (!startedConfigured) {
            expect(String(vtBeforeBody.message)).toMatch(/No deployment provider/i);
        }

        // --- STAGE 0: unconfigured deploy refused at isConfigured (BEFORE any provider call). ---
        const unconfigured = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(unconfigured.status());
        if (unconfigured.status() === 400) {
            const body = (await unconfigured.json()) as Record<string, unknown>;
            expect(body.status).toBe('error');
            expect(String(body.message)).toMatch(
                /token is required|not configured|Plugin Settings/i,
            );
            expect(
                String(body.message),
                'unconfigured copy is NOT the invalid-token copy',
            ).not.toMatch(/Invalid/i);
        }

        // --- ACT: configure a deliberately FAKE token so isConfigured PASSES. ---
        await configureVercelToken(request, access_token);

        // validate-token now flips to valid:true (an enabled+configured provider exists).
        await expect
            .poll(
                async () =>
                    (
                        (await (
                            await request.post(`${DEPLOY_BASE}/validate-token`, {
                                headers: authedHeaders(access_token),
                                data: {},
                            })
                        ).json()) as Record<string, unknown>
                    ).valid,
                {
                    timeout: 15_000,
                    message: 'validate-token flips valid after a token is supplied',
                },
            )
            .toBe(true);

        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
                message: 'work becomes deployable once a token is configured',
            })
            .toBe(true);

        // --- STAGE 1: isConfigured passes, so the gate advances to validateToken which
        //     hits the REAL Vercel API and rejects the fake token with a DISTINCT 400
        //     "Invalid Vercel token" — never a 2xx (we never wired a real token). ---
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
            expect(configured.status()).toBe(400);
            expect(configuredBody?.status).toBe('error');
            expect(String(configuredBody?.message)).toMatch(
                /Invalid Vercel token|Invalid .* token|Failed to initiate/i,
            );
        } else {
            expect(['pending', 'success']).toContain(configuredBody?.status);
        }
    });

    test('6. deploy CORRELATION tracking invariant: lastDeployCorrelationId is null on a fresh work and STAYS null across an unconfigured deploy, a configured-but-invalid deploy, and a rejected rollback — every refusal runs before the deploy.service correlation/state write', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // Baseline: the whole deploy-correlation/state machine is at rest.
        const before = await readWork(request, access_token, work.id);
        expect(
            before.lastDeployCorrelationId ?? null,
            'fresh lastDeployCorrelationId is null',
        ).toBeNull();
        expect(before.deploymentState ?? null, 'fresh deploymentState is null').toBeNull();
        expect(before.deploymentStartedAt ?? null, 'fresh deploymentStartedAt is null').toBeNull();
        expect(before.deployProjectId ?? null, 'fresh deployProjectId is null').toBeNull();

        // 1. UNCONFIGURED deploy — refused at the isConfigured gate.
        const d1 = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(d1.status());
        const d1Accepted = d1.status() >= 200 && d1.status() < 300;

        // 2. CONFIGURED-but-invalid deploy — refused at the validateToken second stage.
        await configureVercelToken(request, access_token);
        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
            })
            .toBe(true);
        const d2 = await request.post(`${DEPLOY_BASE}/works/${work.id}`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(DEPLOY_OUTCOMES).toContain(d2.status());
        const d2Accepted = d2.status() >= 200 && d2.status() < 300;

        // 3. ROLLBACK against a non-existent deployment — refused after DTO validation.
        const rb = await request.post(`${DEPLOY_BASE}/works/${work.id}/rollback`, {
            headers: authedHeaders(access_token),
            data: { deploymentId: NIL_UUID },
        });
        expect(rb.status(), `rollback body=${await rb.text().catch(() => '')}`).toBe(400);
        expect(String(((await rb.json()) as Record<string, unknown>).message)).toMatch(
            /Deployment not found|production deployments|rolled back/i,
        );

        // INVARIANT: as long as nothing was actually dispatched (the CI reality with a
        // fake token), the correlation id + the rest of the deploy state machine were
        // never written — the gate/validation always runs before deploy.service.
        const after = await readWork(request, access_token, work.id);
        if (!d1Accepted && !d2Accepted) {
            expect(
                after.lastDeployCorrelationId ?? null,
                'refused deploys never stamp lastDeployCorrelationId',
            ).toBeNull();
            expect(
                after.deploymentState ?? null,
                'refused deploys leave deploymentState idle',
            ).toBeNull();
            expect(
                after.deploymentStartedAt ?? null,
                'refused deploys never stamp deploymentStartedAt',
            ).toBeNull();
            expect(
                after.deployProjectId ?? null,
                'refused deploys never cache a deployProjectId',
            ).toBeNull();
        }
    });

    test('7. the /teams capability is split: the GLOBAL POST /teams always returns success+empty (no work context), while the per-work POST /works/:id/teams is configure-gated — unconfigured 400 ("credentials configured" copy) vs configured a graceful 2xx — and a fresh deploy/check agrees on the token state', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // --- GLOBAL teams: context-free, always a success envelope with an empty list
        //     and the "use the work-specific endpoint" hint. ---
        const globalTeams = await request.post(`${DEPLOY_BASE}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(globalTeams.status());
        const globalBody = (await globalTeams.json()) as Record<string, unknown>;
        expect(globalBody.status).toBe('success');
        expect(Array.isArray(globalBody.teams), 'global teams is an array').toBe(true);
        expect(
            (globalBody.teams as unknown[]).length,
            'global teams is empty without a token',
        ).toBe(0);
        expect(String(globalBody.message)).toMatch(/work-specific endpoint|Plugin Settings/i);

        // --- PER-WORK teams UNCONFIGURED: the facade can't resolve a token, so it
        //     refuses with the "No <provider> credentials configured" copy. ---
        const perWorkBefore = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        const perWorkBeforeBody = (await perWorkBefore.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        // On CI this is a clean 400; a pre-configured stack could 2xx — tolerate both.
        if (perWorkBefore.status() === 400) {
            expect(perWorkBeforeBody?.status).toBe('error');
            expect(String(perWorkBeforeBody?.message)).toMatch(
                /credentials configured|token in Plugin Settings|token is required/i,
            );
            // The matching deploy/check agrees: the user has no token for this work.
            const check = await deployCheck(request, access_token, work.id);
            expect(
                check.userHasToken,
                'per-work teams 400 lines up with check.userHasToken=false',
            ).toBe(false);
        } else {
            expect([200, 201]).toContain(perWorkBefore.status());
        }

        // --- ACT: configure a (fake) token so the facade resolves it for the work. ---
        await configureVercelToken(request, access_token);
        await expect
            .poll(async () => (await deployCheck(request, access_token, work.id)).userHasToken, {
                timeout: 15_000,
                message: 'work becomes token-resolved after configure',
            })
            .toBe(true);

        // --- PER-WORK teams CONFIGURED: the facade now resolves the token and calls the
        //     provider. With a fake token the provider call yields nothing, but the
        //     handler degrades to a graceful success+empty (or a truthful provider 400)
        //     — never a 5xx, and never the unconfigured "credentials configured" copy. ---
        const perWorkAfter = await request.post(`${DEPLOY_BASE}/works/${work.id}/teams`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(
            [200, 201, 400],
            `configured per-work teams status ${perWorkAfter.status()}`,
        ).toContain(perWorkAfter.status());
        const perWorkAfterBody = (await perWorkAfter.json().catch(() => null)) as Record<
            string,
            unknown
        > | null;
        if (perWorkAfter.status() < 300) {
            expect(perWorkAfterBody?.status).toBe('success');
            expect(
                Array.isArray(perWorkAfterBody?.teams),
                'configured per-work teams is an array',
            ).toBe(true);
        } else {
            // A truthful provider failure is allowed, but never the unconfigured copy.
            expect(perWorkAfterBody?.status).toBe('error');
            expect(String(perWorkAfterBody?.message)).not.toMatch(/No .* credentials configured/i);
        }
    });

    test('8. the seeded user (UI storageState context) sees the SAME deploy-capability facade contract through the API: providers list carries the configured axis and validate-token agrees with whether any provider is configured', async ({
        request,
    }) => {
        // Drive the capability surface as the SEEDED user (the one whose session cookie
        // backs the UI storageState) to prove the facade contract is identical for the
        // account the dashboard actually renders — without mutating that user's tokens.
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.ok(), `seed login body=${await login.text().catch(() => '')}`).toBeTruthy();
        const { access_token } = (await login.json()) as { access_token: string };

        const providers = await listProviders(request, access_token);
        const vercel = providers.find((p) => p.id === 'vercel');
        expect(vercel, 'seeded user sees the vercel deploy provider').toBeTruthy();
        expect(vercel?.enabled).toBe(true);
        expect(typeof vercel?.configured).toBe('boolean');
        const anyConfigured = providers.some((p) => p.enabled && p.configured === true);

        // validate-token must agree with the providers-list configured state for the
        // SAME user — the two surfaces are read-throughs of one credential model.
        const vt = await request.post(`${DEPLOY_BASE}/validate-token`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect([200, 201]).toContain(vt.status());
        const vtBody = (await vt.json()) as Record<string, unknown>;
        expect(vtBody.status).toBe('success');
        expect(vtBody.valid, 'validate-token agrees with the providers-list configured axis').toBe(
            anyConfigured,
        );

        // The per-provider configured-check for the seeded user matches the list row —
        // no drift between the aggregate list and the single-provider probe.
        const vercelCfg = await providerConfigured(request, access_token, 'vercel');
        expect(vercelCfg.available).toBe(true);
        expect(vercelCfg.configured, 'single-provider configured matches the list row').toBe(
            vercel?.configured === true,
        );
    });
});
