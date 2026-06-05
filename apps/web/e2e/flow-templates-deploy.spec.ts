import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Website templates + deploy — complex, multi-step, cross-feature flows.
 *
 * Three end-to-end orchestrations against the REAL platform, all verified
 * against the live API before assertions were written:
 *
 *   1. Template catalog → work association: enumerate the website-template
 *      catalog (two surfaces: the works-facing `GET /api/works/website-templates`
 *      and the richer `GET /api/templates?kind=website`), create a Work bound
 *      to a non-default template via `websiteTemplateId`, then SWITCH that
 *      work's template and confirm the change persists on re-read.
 *
 *   2. Template customization persistence: the user-scoped default template
 *      (`PUT /api/templates/default`) is the persistent customization surface
 *      available without an external code-edit/AI plugin. Set it, confirm the
 *      catalog's `defaultTemplateId` flips, confirm `getWebsiteTemplates`
 *      reflects the new default, and confirm the per-template customization
 *      ledger (`GET /api/templates/:id/customizations`) is queryable.
 *
 *   3. Deploy + screenshot capability (adaptive): exercise the
 *      plugins-capabilities deploy + screenshot facade endpoints and assert
 *      the configured-vs-unconfigured CONTRACT without requiring a real
 *      external deploy. On CI no Vercel/screenshot token is configured, so we
 *      assert the truthful "available but not configured" / "no provider
 *      configured" responses; if a token IS configured the same assertions
 *      adapt to the configured branch.
 *
 * Verified live-API shapes (fresh user, port 3100):
 *   GET  /api/works/website-templates →
 *        { status:'success', templates:[{ id,name,description,sourceType,originType,isDefault }] }
 *   GET  /api/templates?kind=website →
 *        { status:'success', kind, defaultTemplateId, templates:[{ id,kind,sourceType,originType,
 *          name,description,repositoryUrl,repositoryOwner,repositoryName,branch,isDefault,
 *          customizable,baseTemplateId,latestCustomization,... }] }
 *   POST /api/works (with websiteTemplateId) → { status:'success', work:{ id, websiteTemplateId, ... } }
 *   GET  /api/works/:id → { status:'success', work:{ websiteTemplateId, ... } }
 *   POST /api/works/:id/switch-website-template { websiteTemplateId } →
 *        { status:'success', previousWebsiteTemplateId, websiteTemplateId, switchMode, message, ... }
 *        (invalid id → 400 { status:'error', message:'Unsupported website template: <id>' })
 *   PUT  /api/templates/default { kind,templateId } → { status:'success', kind, defaultTemplateId }
 *   GET  /api/templates/:id/customizations → { status:'success', customizations:[] }
 *   GET  /api/templates/customizations/:id — :id is enforced as a UUID by a
 *        ParseUUIDPipe (security hardening). A well-formed but unknown UUID →
 *        200 { status:'error', message:'Customization not found' }. A non-UUID
 *        (e.g. 'bogus-...') is rejected by the pipe with a 400 BadRequest BEFORE
 *        the handler runs, so the not-found contract is probed with a real UUID.
 *   GET  /api/deploy/providers → { status:'success', providers:[{ id,name,enabled,configured,... }] }
 *   GET  /api/deploy/providers/:id/configured →
 *        { status:'success', configured, available, enabled?, message }
 *   POST /api/deploy/works/:id/check → { status:'success', canDeploy, isShared, ownerHasToken, userHasToken }
 *   POST /api/deploy/works/:id (unconfigured) → 400 { status:'error', message:'<Provider> token is required...' }
 *   POST /api/deploy/validate-token → { status:'success', valid, userInfo, message }
 *   GET  /api/screenshot/check-availability → { status:'success', available, providers, activeProvider }
 *   POST /api/screenshot/capture (unconfigured) → 400 { status:'error', message:'No screenshot provider configured' }
 *
 * Isolation: each flow runs API mutations on a FRESH registerUserViaAPI()
 * user so the shared in-memory DB stays clean for sibling specs. UI checks
 * use the seeded storageState. Assertions tolerate pre-existing catalog rows
 * (toContain / find), never exact counts.
 */

type WebsiteTemplate = {
    id: string;
    name: string;
    description?: string | null;
    sourceType?: string;
    originType?: string;
    isDefault?: boolean;
};

type CatalogTemplate = WebsiteTemplate & {
    kind?: string;
    repositoryUrl?: string;
    repositoryOwner?: string;
    repositoryName?: string;
    branch?: string;
    customizable?: boolean;
    baseTemplateId?: string;
    latestCustomization?: unknown;
};

async function workIdFromGet(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ status: number; websiteTemplateId: string | null | undefined }> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return { status: res.status(), websiteTemplateId: undefined };
    const body = await res.json();
    const work = body?.work ?? body?.data ?? body;
    return { status: res.status(), websiteTemplateId: work?.websiteTemplateId };
}

test.describe('Flow: website-template catalog → work association → switch', () => {
    test('catalog enumerates built-in templates and a Work binds + switches its template', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // --- Step 1: works-facing website-template list (the catalog the
        // create-work UI consumes). Two built-ins ship: classic (default) +
        // minimal. We tolerate extra rows but require the contract shape. ---
        const wtRes = await request.get(`${API_BASE}/api/works/website-templates`, {
            headers: authedHeaders(user.access_token),
        });
        expect(wtRes.status(), 'website-templates is authed-readable').toBe(200);
        const wtBody = await wtRes.json();
        expect(wtBody.status).toBe('success');
        const websiteTemplates: WebsiteTemplate[] = wtBody.templates;
        expect(Array.isArray(websiteTemplates), 'templates is an array').toBe(true);

        const classic = websiteTemplates.find((t) => t.id === 'classic');
        const minimal = websiteTemplates.find((t) => t.id === 'minimal');
        expect(classic, '`classic` template is registered').toBeTruthy();
        expect(minimal, '`minimal` template is registered').toBeTruthy();
        // Each entry carries the full website-template contract.
        for (const t of [classic!, minimal!]) {
            expect(typeof t.id).toBe('string');
            expect(typeof t.name).toBe('string');
            expect(t.sourceType, `${t.id}.sourceType`).toBe('built_in');
            expect(t.originType, `${t.id}.originType`).toBe('standard');
            expect(typeof t.isDefault).toBe('boolean');
        }
        // Exactly one default in the works-facing list, and it is `classic`
        // (the platform default for a brand-new user with no preference set).
        const defaults = websiteTemplates.filter((t) => t.isDefault);
        expect(defaults.length, 'exactly one default website template').toBe(1);
        expect(defaults[0].id).toBe('classic');

        // --- Step 2: the richer catalog surface backs the same template ids
        // with repository metadata. Pin the legacy directory-web-template repo
        // so a future rename can't silently break clone-on-create. ---
        const catRes = await request.get(`${API_BASE}/api/templates?kind=website`, {
            headers: authedHeaders(user.access_token),
        });
        expect(catRes.status()).toBe(200);
        const catBody = await catRes.json();
        expect(catBody.status).toBe('success');
        expect(catBody.kind).toBe('website');
        expect(catBody.defaultTemplateId, 'fresh user default is classic').toBe('classic');
        const catalog: CatalogTemplate[] = catBody.templates;
        const catClassic = catalog.find((t) => t.id === 'classic');
        expect(catClassic, 'classic present in rich catalog').toBeTruthy();
        expect(catClassic?.repositoryName).toBe('directory-web-template');
        expect(catClassic?.repositoryOwner).toBe('ever-works');
        expect(catClassic?.repositoryUrl).toContain('github.com/ever-works/directory-web-template');
        const catMinimal = catalog.find((t) => t.id === 'minimal');
        expect(catMinimal?.repositoryName).toBe('directory-web-minimal-template');

        // --- Step 3: create a Work explicitly bound to the NON-default
        // template (minimal) via websiteTemplateId. The create response must
        // echo the binding. ---
        const slug = `flow-tpl-${Date.now()}`;
        const createRes = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(user.access_token),
            data: {
                name: `Flow Template Site ${Date.now()}`,
                slug,
                description: 'flow-templates-deploy: template association',
                organization: false,
                websiteTemplateId: 'minimal',
            },
        });
        expect(createRes.status(), 'work created').toBe(200);
        const createBody = await createRes.json();
        expect(createBody.status).toBe('success');
        const work = createBody.work;
        expect(work?.id, 'work id present').toBeTruthy();
        expect(work.websiteTemplateId, 'create echoes the chosen template').toBe('minimal');
        const workId: string = work.id;

        // Confirm persistence via a fresh GET (not just the create echo).
        await expect
            .poll(
                async () =>
                    (await workIdFromGet(request, user.access_token, workId)).websiteTemplateId,
                { timeout: 15000, message: 'work persists websiteTemplateId=minimal' },
            )
            .toBe('minimal');

        // --- Step 4: SWITCH the work's website template to classic. Because
        // the website repo has not been created yet, the switch is saved for
        // first initialization (switchMode=saved_for_initialization) and does
        // NOT recreate any repo. ---
        const switchRes = await request.post(
            `${API_BASE}/api/works/${workId}/switch-website-template`,
            {
                headers: authedHeaders(user.access_token),
                data: { websiteTemplateId: 'classic' },
            },
        );
        expect(switchRes.status(), 'switch accepted').toBe(200);
        const switchBody = await switchRes.json();
        expect(switchBody.status).toBe('success');
        expect(switchBody.previousWebsiteTemplateId, 'reports previous binding').toBe('minimal');
        expect(switchBody.websiteTemplateId, 'reports new binding').toBe('classic');
        // No website repo exists yet, so the switch is deferred, not destructive.
        expect(switchBody.switchMode).toBe('saved_for_initialization');
        expect(switchBody.repositoryRecreated).toBe(false);
        expect(typeof switchBody.message).toBe('string');

        // The switch must persist on the work entity.
        await expect
            .poll(
                async () =>
                    (await workIdFromGet(request, user.access_token, workId)).websiteTemplateId,
                { timeout: 15000, message: 'work persists the switched template=classic' },
            )
            .toBe('classic');

        // --- Step 5: switching to a bogus template id is rejected with the
        // truthful 400 contract and does NOT mutate the work. ---
        const badSwitch = await request.post(
            `${API_BASE}/api/works/${workId}/switch-website-template`,
            {
                headers: authedHeaders(user.access_token),
                data: { websiteTemplateId: 'does-not-exist-template' },
            },
        );
        expect(badSwitch.status(), 'unsupported template rejected').toBe(400);
        const badBody = await badSwitch.json();
        expect(badBody.status).toBe('error');
        expect(String(badBody.message)).toContain('Unsupported website template');
        // Work still bound to classic — the rejected switch was a no-op.
        const afterBad = await workIdFromGet(request, user.access_token, workId);
        expect(afterBad.websiteTemplateId).toBe('classic');
    });
});

test.describe('Flow: template customization persists (user-scoped default)', () => {
    test('set default template flips the catalog default and the works-facing list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Baseline: a fresh user defaults to classic across both surfaces.
        const before = await request.get(`${API_BASE}/api/templates?kind=website`, {
            headers: authedHeaders(user.access_token),
        });
        expect(before.status()).toBe(200);
        const beforeBody = await before.json();
        expect(beforeBody.defaultTemplateId).toBe('classic');

        // --- Apply a persistent customization: set the user's default website
        // template to minimal. This is the durable per-user template
        // preference the platform exposes without an external code-edit plugin
        // (agent-driven custom-from-base requires a code-edit provider which
        // is not installed in CI — see deviation note in `risks`). ---
        const setRes = await request.put(`${API_BASE}/api/templates/default`, {
            headers: authedHeaders(user.access_token),
            data: { kind: 'website', templateId: 'minimal' },
        });
        expect(setRes.status(), 'set-default accepted').toBe(200);
        const setBody = await setRes.json();
        expect(setBody.status).toBe('success');
        expect(setBody.kind).toBe('website');
        expect(setBody.defaultTemplateId, 'set-default echoes minimal').toBe('minimal');

        // --- Persistence check #1: the rich catalog now reports minimal as the
        // default, and minimal's row carries isDefault=true. ---
        await expect
            .poll(
                async () => {
                    const r = await request.get(`${API_BASE}/api/templates?kind=website`, {
                        headers: authedHeaders(user.access_token),
                    });
                    if (!r.ok()) return `http-${r.status()}`;
                    return (await r.json()).defaultTemplateId as string;
                },
                { timeout: 15000, message: 'catalog default persists as minimal' },
            )
            .toBe('minimal');

        const afterCat = await (
            await request.get(`${API_BASE}/api/templates?kind=website`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        const minimalRow = (afterCat.templates as CatalogTemplate[]).find(
            (t) => t.id === 'minimal',
        );
        expect(minimalRow?.isDefault, 'minimal row marked default').toBe(true);
        const classicRow = (afterCat.templates as CatalogTemplate[]).find(
            (t) => t.id === 'classic',
        );
        expect(classicRow?.isDefault, 'classic row no longer default').toBe(false);

        // --- Persistence check #2: the works-facing list (consumed by the
        // create-work UI) reflects the same flipped default. ---
        const wtAfter = await request.get(`${API_BASE}/api/works/website-templates`, {
            headers: authedHeaders(user.access_token),
        });
        expect(wtAfter.status()).toBe(200);
        const wtAfterBody = await wtAfter.json();
        const wtDefaults = (wtAfterBody.templates as WebsiteTemplate[]).filter((t) => t.isDefault);
        expect(wtDefaults.length, 'still exactly one default').toBe(1);
        expect(wtDefaults[0].id, 'works-facing default flipped to minimal').toBe('minimal');

        // --- Customization ledger: minimal is a customizable template, so its
        // per-template customization list is queryable (empty for a fresh
        // user — no agent run has been submitted). This pins the real ledger
        // endpoint used by the template-customization UI. ---
        const ledgerRes = await request.get(`${API_BASE}/api/templates/minimal/customizations`, {
            headers: authedHeaders(user.access_token),
        });
        expect(ledgerRes.status(), 'customization ledger queryable').toBe(200);
        const ledgerBody = await ledgerRes.json();
        expect(ledgerBody.status).toBe('success');
        expect(Array.isArray(ledgerBody.customizations), 'ledger is an array').toBe(true);

        // --- An unknown (but well-formed) customization id returns the truthful
        // not-found payload (200 with status:'error') rather than throwing —
        // pins the contract the polling UI relies on. The id param is enforced
        // as a UUID by a ParseUUIDPipe (security hardening: a non-UUID such as
        // `bogus-...` is rejected with a 400 BEFORE the handler runs), so we
        // probe the not-found branch with a real-but-nonexistent UUID. ---
        const unknownCustomizationId = randomUUID();
        const bogus = await request.get(
            `${API_BASE}/api/templates/customizations/${unknownCustomizationId}`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(bogus.status()).toBeLessThan(500);
        const bogusBody = await bogus.json();
        expect(bogusBody.status).toBe('error');
        expect(String(bogusBody.message)).toContain('not found');
    });
});

test.describe('Flow: deploy + screenshot capability (configured-vs-unconfigured)', () => {
    test('deploy + screenshot facades report a truthful capability contract', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // A real Work to anchor the work-scoped deploy capability checks. The
        // default deployProvider is vercel.
        const created = await createWorkViaAPI(request, user.access_token, {
            name: `Flow Deploy Site ${Date.now()}`,
            slug: `flow-deploy-${Date.now()}`,
        });
        expect(created.id, 'work created for deploy checks').toBeTruthy();
        const workId = created.id;

        // --- Step 1: list deploy providers. Two ship enabled: vercel + k8s.
        // For a fresh user with no token, every provider is unconfigured. ---
        const provRes = await request.get(`${API_BASE}/api/deploy/providers`, {
            headers: authedHeaders(user.access_token),
        });
        expect(provRes.status(), 'providers listed').toBe(200);
        const provBody = await provRes.json();
        expect(provBody.status).toBe('success');
        const providers: Array<{
            id: string;
            name: string;
            enabled: boolean;
            configured: boolean;
        }> = provBody.providers;
        expect(Array.isArray(providers)).toBe(true);
        const vercel = providers.find((p) => p.id === 'vercel');
        expect(vercel, 'vercel deploy provider registered').toBeTruthy();
        expect(vercel?.enabled, 'vercel enabled').toBe(true);
        const anyConfigured = providers.some((p) => p.configured);

        // --- Step 2: per-provider configured check. The shape is uniform; the
        // `configured` boolean is the env-adaptive axis. ---
        const cfgRes = await request.get(`${API_BASE}/api/deploy/providers/vercel/configured`, {
            headers: authedHeaders(user.access_token),
        });
        expect(cfgRes.status()).toBe(200);
        const cfgBody = await cfgRes.json();
        expect(cfgBody.status).toBe('success');
        expect(cfgBody.available, 'vercel available').toBe(true);
        expect(cfgBody.enabled, 'vercel enabled').toBe(true);
        expect(typeof cfgBody.configured).toBe('boolean');
        expect(typeof cfgBody.message).toBe('string');
        if (cfgBody.configured) {
            expect(String(cfgBody.message)).toContain('configured');
        } else {
            expect(String(cfgBody.message)).toContain('not configured');
        }

        // An unknown provider id reports available:false (no 404, no 5xx).
        const unknownCfg = await request.get(
            `${API_BASE}/api/deploy/providers/totally-bogus/configured`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(unknownCfg.status()).toBe(200);
        const unknownBody = await unknownCfg.json();
        expect(unknownBody.configured).toBe(false);
        expect(unknownBody.available).toBe(false);
        expect(String(unknownBody.message)).toContain('not available');

        // --- Step 3: work-scoped deploy capability check. Mirrors the
        // configured state for the owner. ---
        const checkRes = await request.post(`${API_BASE}/api/deploy/works/${workId}/check`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        // POST handler carries no @HttpCode(200), so Nest returns its default 201 for POST.
        expect(checkRes.status()).toBe(201);
        const checkBody = await checkRes.json();
        expect(checkBody.status).toBe('success');
        expect(checkBody.isShared, 'owner is not a shared collaborator').toBe(false);
        expect(typeof checkBody.canDeploy).toBe('boolean');
        expect(typeof checkBody.ownerHasToken).toBe('boolean');
        expect(typeof checkBody.userHasToken).toBe('boolean');
        // canDeploy must agree with the owner's token state.
        expect(checkBody.canDeploy).toBe(checkBody.ownerHasToken);

        // --- Step 4: validate-token reflects whether ANY provider is both
        // enabled and configured — env-adaptive. ---
        const vtRes = await request.post(`${API_BASE}/api/deploy/validate-token`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        // Same as /check: no @HttpCode(200) on this POST, so Nest returns 201.
        expect(vtRes.status()).toBe(201);
        const vtBody = await vtRes.json();
        expect(vtBody.status).toBe('success');
        expect(typeof vtBody.valid).toBe('boolean');
        expect(vtBody.valid, 'validate-token agrees with provider configured state').toBe(
            anyConfigured,
        );

        // --- Step 5: attempt the actual deploy. ADAPTIVE: when no provider is
        // configured (CI), the deploy is refused with the truthful 400
        // "token is required" contract — we never trigger a real external
        // deploy. When a token IS configured, the deploy is accepted (status
        // pending). Either way we assert the configured-vs-unconfigured
        // contract, not external completion. ---
        const deployRes = await request.post(`${API_BASE}/api/deploy/works/${workId}`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        const deployBody = await deployRes.json().catch(() => ({}));
        if (checkBody.canDeploy) {
            // Configured branch: deploy was dispatched (pending) or rejected for
            // a downstream reason (e.g. repo not yet created) — never a 5xx.
            expect(deployRes.status(), `deploy status ${deployRes.status()}`).toBeLessThan(500);
            expect(['pending', 'success', 'error']).toContain(deployBody.status);
        } else {
            // Unconfigured branch (CI): a clean 400 with the token-required message.
            expect(deployRes.status(), 'deploy refused without a token').toBe(400);
            expect(deployBody.status).toBe('error');
            expect(String(deployBody.message)).toMatch(/token is required|not configured/i);
        }

        // --- Step 6: screenshot capability — same configured-vs-unconfigured
        // shape, work-scoped. ---
        const ssRes = await request.get(
            `${API_BASE}/api/screenshot/check-availability?workId=${workId}`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(ssRes.status(), 'screenshot availability readable').toBe(200);
        const ssBody = await ssRes.json();
        expect(ssBody.status).toBe('success');
        expect(typeof ssBody.available).toBe('boolean');
        expect(Array.isArray(ssBody.providers), 'providers is an array').toBe(true);
        // `available` is true iff at least one listed provider is configured.
        const anyShotConfigured = (ssBody.providers as Array<{ configured?: boolean }>).some(
            (p) => p.configured,
        );
        expect(ssBody.available).toBe(anyShotConfigured);

        // --- Step 7: attempt a capture. ADAPTIVE: unconfigured → clean 400
        // "No screenshot provider configured"; configured → not a 5xx (the
        // facade either returns an image or a 400 capture error, but never a
        // server crash). We never depend on a real external screenshot. ---
        const capRes = await request.post(`${API_BASE}/api/screenshot/capture`, {
            headers: authedHeaders(user.access_token),
            data: { url: 'https://example.com', workId },
        });
        const capBody = await capRes.json().catch(() => ({}));
        if (ssBody.available) {
            expect(capRes.status(), `capture status ${capRes.status()}`).toBeLessThan(500);
            expect(['success', 'error']).toContain(capBody.status);
        } else {
            expect(capRes.status(), 'capture refused without a provider').toBe(400);
            expect(capBody.status).toBe('error');
            expect(String(capBody.message)).toContain('No screenshot provider configured');
        }
    });
});
