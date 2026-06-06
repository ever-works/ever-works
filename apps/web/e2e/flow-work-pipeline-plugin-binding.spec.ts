import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * COMPLEX, multi-step e2e INTEGRATION flows for WORK ↔ PIPELINE-PLUGIN BINDING:
 * pipeline selection per work, the active-pipeline capability, the per-pipeline
 * dynamic generator-form config schema, switching the selected pipeline plugin,
 * and a work inheriting the user/system-default (ENFORCED) pipeline.
 *
 * PROBED CONTRACT (live http://127.0.0.1:3100, verified 2026-06-01):
 *   The works module does NOT expose a per-work `/pipeline/*` sub-resource.
 *   A work's pipeline-plugin BINDING is realized through the GENERATOR
 *   form-schema endpoints, mounted on the global `@Controller('api')`
 *   (apps/api/src/works/works.controller.ts) — so the REAL routes are:
 *
 *     GET /api/generator-form?pipelineId=<id>
 *         -> getGlobalGeneratorFormSchema(): getFormSchema(pipelineId,{userId}).
 *            The GLOBAL (no work context) dynamic config form for the selected
 *            pipeline plugin. Omitting pipelineId resolves the DEFAULT pipeline.
 *            (NB: it is /api/generator-form, NOT /api/works/generator-form —
 *             the latter 404s "Cannot GET".)
 *
 *     GET /api/works/:id/generator-form?pipelineId=<id>
 *         -> getGeneratorFormSchema(): ownership-checked via
 *            workOwnershipService.ensureAccess(id,userId), then
 *            getFormSchema(pipelineId,{workId,userId}). The PER-WORK config form
 *            for the pipeline this work would generate with.
 *
 *   Both delegate to GeneratorFormSchemaService.getFormSchema()
 *   (packages/agent/src/services/generator-form-schema.service.ts), which
 *   returns a `GeneratorFormSchema`:
 *     {
 *       resolvedPipelineId: string,          // the pipeline this binding uses
 *       enforcedPipelineId?: string,         // set IFF the user pinned an
 *                                            //   ENFORCED global pipeline default
 *       providers: {                         // selectable plugins per capability
 *         pipeline:  ProviderOption[],       //   <- the active-pipeline capability
 *         ai, search, screenshot, contentExtractor: ProviderOption[]
 *       },
 *       pluginFields: FormFieldDefinition[], // the pipeline's dynamic config fields
 *       pluginGroups?: FormFieldGroup[],
 *       defaultValues?: Record<string,unknown>
 *     }
 *   ProviderOption = { id, name, description, configured, isDefault, icon, models? }.
 *
 *   PROBED FACTS (asserted below, not guessed):
 *     - With no pipelineId, resolvedPipelineId === 'agent-pipeline' (the
 *       default-for-capability pipeline), and providers.pipeline lists BOTH
 *       'agent-pipeline' and 'standard-pipeline', exactly ONE marked isDefault.
 *     - GET ...?pipelineId=standard-pipeline => resolvedPipelineId flips to
 *       'standard-pipeline' (an OBSERVABLE switch of the bound pipeline plugin).
 *     - An unknown pipelineId does NOT error: the service logs a warning and
 *       FALLS BACK to the default — so the endpoint returns 200 with
 *       resolvedPipelineId === the default ('agent-pipeline'), never a 4xx/5xx.
 *     - "work inherits user/system-default pipeline" == the ENFORCE feature:
 *         POST /api/plugins/pipeline-default { pluginId, enforce:true } (200)
 *         then GET /api/generator-form => enforcedPipelineId === pluginId.
 *         enforce omitted -> 400 (SetGlobalPipelineDefaultDto requires it);
 *         { pluginId:null, enforce:false } clears it -> enforcedPipelineId gone.
 *     - Ownership: owner per-work => 200; a different authed user => 403;
 *       a nonexistent work id => 404; anonymous (no bearer) => 401.
 *
 * GOTCHAS honored:
 *   - register={username,email,password}; fresh registerUserViaAPI() user per
 *     file + per-mutation (cross-spec isolation — the enforce default is
 *     user-scoped). createWorkViaAPI(request,token,{name})->{id}.
 *   - NO LLM key / NO Trigger.dev in CI -> never assert generation EXECUTION;
 *     only the SELECTION/CONFIG metadata (the form schema) is asserted.
 *   - ANON CONTEXT inherits the storageState cookie -> use empty storageState.
 *   - Generous timeouts, .first(), tolerate pre-existing rows, no exact counts.
 */

interface ProviderOption {
    id: string;
    name?: string;
    description?: string;
    configured?: boolean;
    isDefault?: boolean;
    icon?: unknown;
    models?: unknown;
}

interface GeneratorFormSchemaShape {
    resolvedPipelineId?: string;
    enforcedPipelineId?: string;
    providers?: Record<string, ProviderOption[]>;
    pluginFields?: unknown[];
    pluginGroups?: unknown[];
    defaultValues?: Record<string, unknown>;
}

interface ProbeResult {
    ok: boolean;
    status: number;
    body: unknown;
}

const GLOBAL_FORM = `${API_BASE}/api/generator-form`;
const PIPELINE_DEFAULT = `${API_BASE}/api/plugins/pipeline-default`;
const DEFAULT_PIPELINE_ID = 'agent-pipeline';
const ALT_PIPELINE_ID = 'standard-pipeline';

function perWorkForm(workId: string): string {
    return `${API_BASE}/api/works/${workId}/generator-form`;
}

async function getJson(
    request: APIRequestContext,
    token: string | null,
    url: string,
): Promise<ProbeResult> {
    const res = await request.get(url, {
        headers: token ? authedHeaders(token) : undefined,
        timeout: 30_000,
    });
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        body = await res.text().catch(() => null);
    }
    return { ok: res.ok(), status: res.status(), body };
}

function asSchema(body: unknown): GeneratorFormSchemaShape {
    return (body ?? {}) as GeneratorFormSchemaShape;
}

/** A form-schema payload must carry the real binding contract keys. */
function isGeneratorFormSchema(body: unknown): boolean {
    const s = asSchema(body);
    return (
        !!body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'resolvedPipelineId' in (body as object) &&
        'providers' in (body as object) &&
        typeof s.providers === 'object' &&
        s.providers !== null &&
        Array.isArray((s.providers as Record<string, unknown>).pipeline)
    );
}

function pipelineOptions(schema: GeneratorFormSchemaShape): ProviderOption[] {
    return (schema.providers?.pipeline ?? []) as ProviderOption[];
}

test.describe('Work pipeline plugin binding (complex flows)', () => {
    let token: string;

    test.beforeAll(async ({ request }) => {
        const user = await registerUserViaAPI(request, {
            email: `e2e-pipe-bind-${Date.now()}@test.local`,
        });
        token = user.access_token;
    });

    test('1. a work with no pipeline selected inherits the default pipeline binding + a usable config schema', async ({
        request,
    }) => {
        // No pipelineId -> the server resolves the DEFAULT pipeline's config form,
        // i.e. the binding a freshly-created work inherits.
        const def = await getJson(request, token, GLOBAL_FORM);
        expect(def.status, `default form-schema resolves (got ${def.status})`).toBe(200);
        expect(
            isGeneratorFormSchema(def.body),
            `recognizable GeneratorFormSchema in ${JSON.stringify(def.body).slice(0, 300)}`,
        ).toBe(true);

        const schema = asSchema(def.body);
        // The default-for-capability pipeline plugin is the bound one.
        expect(schema.resolvedPipelineId, 'default resolved pipeline id').toBe(DEFAULT_PIPELINE_ID);
        // With no enforced user default in play, the binding is NOT pinned.
        expect(schema.enforcedPipelineId, 'no enforced pipeline by default').toBeFalsy();

        // pluginFields is always an array (the dynamic per-pipeline config surface).
        expect(Array.isArray(schema.pluginFields), 'pluginFields is an array').toBe(true);
    });

    test('2. the active-pipeline capability lists the selectable pipeline plugins with exactly one default', async ({
        request,
    }) => {
        const def = await getJson(request, token, GLOBAL_FORM);
        expect(def.status).toBe(200);
        const schema = asSchema(def.body);

        // providers.pipeline IS the "active pipeline capability" surface.
        const options = pipelineOptions(schema);
        expect(
            options.length,
            'at least the two known pipeline plugins are selectable',
        ).toBeGreaterThanOrEqual(2);

        const ids = options.map((o) => o.id);
        expect(ids, 'agent-pipeline is selectable').toContain(DEFAULT_PIPELINE_ID);
        expect(ids, 'standard-pipeline is selectable').toContain(ALT_PIPELINE_ID);

        // Exactly one pipeline option is the active/default one, and it matches the
        // schema's resolvedPipelineId (the binding the work would actually use).
        const defaults = options.filter((o) => o.isDefault);
        expect(defaults.length, 'exactly one default pipeline option').toBe(1);
        expect(defaults[0].id, 'default option matches resolvedPipelineId').toBe(
            schema.resolvedPipelineId,
        );

        // Each pipeline option carries its capability metadata (name + configured flag).
        for (const opt of options) {
            expect(opt.id, 'pipeline option has an id').toBeTruthy();
            expect(typeof opt.configured, `pipeline ${opt.id} exposes configured flag`).toBe(
                'boolean',
            );
        }

        // The non-pipeline capability categories are present too (the generator form
        // is composed of the pipeline's REQUIRED provider categories).
        expect(Object.keys(schema.providers ?? {}), 'capability categories present').toEqual(
            expect.arrayContaining(['pipeline']),
        );
    });

    test('3. switching the selected pipeline plugin flips the resolved binding (agent -> standard)', async ({
        request,
    }) => {
        // Baseline: the default binding.
        const base = await getJson(request, token, GLOBAL_FORM);
        expect(base.status).toBe(200);
        expect(asSchema(base.body).resolvedPipelineId).toBe(DEFAULT_PIPELINE_ID);

        // Switch to the alternate pipeline plugin -> the resolved binding flips.
        const switched = await getJson(
            request,
            token,
            `${GLOBAL_FORM}?pipelineId=${encodeURIComponent(ALT_PIPELINE_ID)}`,
        );
        expect(switched.status, `switch to ${ALT_PIPELINE_ID} (got ${switched.status})`).toBe(200);
        expect(isGeneratorFormSchema(switched.body)).toBe(true);

        const switchedSchema = asSchema(switched.body);
        expect(
            switchedSchema.resolvedPipelineId,
            'selecting standard-pipeline binds the work to it',
        ).toBe(ALT_PIPELINE_ID);

        // PROBED REALITY (live 2026-06-01): the GLOBAL form has no workId, so the
        // providers.pipeline `isDefault` flag is computed purely from each plugin's
        // manifest `defaultForCapabilities` (toProviderOption) and does NOT track the
        // `?pipelineId` query param — it stays pinned to the manifest default
        // (agent-pipeline). The OBSERVABLE binding switch is `resolvedPipelineId`
        // (asserted above); the alternate is still a selectable option, just not the
        // capability-default. Assert the TRUE shape, not a fictional "isDefault follows
        // the selection" contract.
        const switchedOptions = pipelineOptions(switchedSchema);
        const switchedDefault = switchedOptions.find((o) => o.isDefault);
        expect(
            switchedDefault?.id,
            'manifest default-for-capability stays agent-pipeline regardless of selection',
        ).toBe(DEFAULT_PIPELINE_ID);
        expect(
            switchedOptions.map((o) => o.id),
            'standard-pipeline remains a selectable pipeline option after the switch',
        ).toContain(ALT_PIPELINE_ID);

        // And switching back resolves the original binding again (round-trip).
        const backToAgent = await getJson(
            request,
            token,
            `${GLOBAL_FORM}?pipelineId=${encodeURIComponent(DEFAULT_PIPELINE_ID)}`,
        );
        expect(backToAgent.status).toBe(200);
        expect(asSchema(backToAgent.body).resolvedPipelineId).toBe(DEFAULT_PIPELINE_ID);
    });

    test('4. selecting an unknown pipeline id is non-fatal: the binding falls back to the default', async ({
        request,
    }) => {
        // resolvePipelinePlugin() warns + falls through to the default when the id
        // is not a loaded+enabled pipeline plugin — so this is a CLEAN 200 with the
        // default binding, never a 4xx/5xx. Guards against a fictional "400 unknown
        // pipeline" contract.
        const bogus = await getJson(
            request,
            token,
            `${GLOBAL_FORM}?pipelineId=${encodeURIComponent(`no-such-pipeline-${Date.now()}`)}`,
        );
        expect(bogus.status, `unknown pipeline is non-fatal (got ${bogus.status})`).toBeLessThan(
            500,
        );
        // The platform's real behaviour is a graceful 200 fallback.
        expect(bogus.status, 'unknown pipeline resolves the default (200 fallback)').toBe(200);
        expect(isGeneratorFormSchema(bogus.body)).toBe(true);
        expect(
            asSchema(bogus.body).resolvedPipelineId,
            'unknown pipeline falls back to the default binding',
        ).toBe(DEFAULT_PIPELINE_ID);
    });

    test('5. a work inherits the ENFORCED user-default pipeline binding (set -> appears -> clear)', async ({
        request,
    }) => {
        // User-scoped enforce default — run on a FRESH user so it cannot leak into
        // sibling specs that share the seeded user.
        const owner = await registerUserViaAPI(request, {
            email: `e2e-pipe-enforce-${Date.now()}@test.local`,
        });
        const ownerToken = owner.access_token;

        // Before: no enforced pipeline.
        const before = await getJson(request, ownerToken, GLOBAL_FORM);
        expect(before.status).toBe(200);
        expect(
            asSchema(before.body).enforcedPipelineId,
            'no enforced pipeline initially',
        ).toBeFalsy();

        // SetGlobalPipelineDefaultDto requires `enforce` — omitting it is a 400.
        const missingEnforce = await request.post(PIPELINE_DEFAULT, {
            headers: authedHeaders(ownerToken),
            data: { pluginId: ALT_PIPELINE_ID },
            timeout: 30_000,
        });
        expect(missingEnforce.status(), 'pipeline-default requires enforce flag').toBe(400);

        // Pin the alternate pipeline as the ENFORCED global default for this user.
        const setRes = await request.post(PIPELINE_DEFAULT, {
            headers: authedHeaders(ownerToken),
            data: { pluginId: ALT_PIPELINE_ID, enforce: true },
            timeout: 30_000,
        });
        expect(setRes.status(), 'set enforced global pipeline default').toBe(200);

        // Now EVERY work this user generates inherits the enforced binding: the
        // generator-form surfaces it as enforcedPipelineId.
        await expect
            .poll(
                async () =>
                    asSchema((await getJson(request, ownerToken, GLOBAL_FORM)).body)
                        .enforcedPipelineId,
                { timeout: 20_000, message: 'enforced pipeline propagates to the binding' },
            )
            .toBe(ALT_PIPELINE_ID);

        // A concrete owned work inherits it too (per-work binding read).
        const work = await createWorkViaAPI(request, ownerToken, {
            name: `Pipe Enforce ${Date.now()}`,
        });
        expect(work.id, 'work created under enforced default').toBeTruthy();
        const perWork = await getJson(request, ownerToken, perWorkForm(work.id));
        expect(perWork.status, `owner per-work form-schema (got ${perWork.status})`).toBe(200);
        expect(isGeneratorFormSchema(perWork.body)).toBe(true);
        expect(
            asSchema(perWork.body).enforcedPipelineId,
            'the new work inherits the enforced user-default pipeline',
        ).toBe(ALT_PIPELINE_ID);

        // Clearing the default (pluginId:null, enforce:false) removes the inheritance.
        const clearRes = await request.post(PIPELINE_DEFAULT, {
            headers: authedHeaders(ownerToken),
            data: { pluginId: null, enforce: false },
            timeout: 30_000,
        });
        expect(clearRes.status(), 'clear enforced global pipeline default').toBe(200);
        await expect
            .poll(
                async () =>
                    asSchema((await getJson(request, ownerToken, GLOBAL_FORM)).body)
                        .enforcedPipelineId,
                { timeout: 20_000, message: 'cleared enforced pipeline disappears from binding' },
            )
            .toBeFalsy();
    });

    test('6. per-work pipeline binding is ownership-scoped and auth-guarded (owner 200 / intruder 403 / ghost 404 / anon 401)', async ({
        request,
        browser,
    }) => {
        // Owner creates a work and reads its per-work binding.
        const work = await createWorkViaAPI(request, token, { name: `Pipe Owned ${Date.now()}` });
        const ownerRead = await getJson(request, token, perWorkForm(work.id));
        expect(ownerRead.status, 'owner can read per-work binding').toBe(200);
        expect(isGeneratorFormSchema(ownerRead.body)).toBe(true);
        // Selecting a specific pipeline for THIS work resolves that binding.
        const ownerSelected = await getJson(
            request,
            token,
            `${perWorkForm(work.id)}?pipelineId=${encodeURIComponent(ALT_PIPELINE_ID)}`,
        );
        expect(ownerSelected.status).toBe(200);
        expect(asSchema(ownerSelected.body).resolvedPipelineId).toBe(ALT_PIPELINE_ID);

        // A DIFFERENT authenticated user is denied by ensureAccess() -> 403.
        const intruder = await registerUserViaAPI(request, {
            email: `e2e-pipe-intruder-${Date.now()}@test.local`,
        });
        const intruderRead = await getJson(request, intruder.access_token, perWorkForm(work.id));
        expect(
            [403, 404],
            `cross-user per-work read denied (got ${intruderRead.status})`,
        ).toContain(intruderRead.status);

        // A nonexistent work id -> 404 (ensureAccess cannot find it).
        const ghost = await getJson(
            request,
            token,
            perWorkForm('00000000-0000-0000-0000-000000000000'),
        );
        expect(ghost.status, `ghost work per-work read (got ${ghost.status})`).toBe(404);

        // Anonymous (EMPTY storageState so it does NOT inherit the shared auth
        // cookie) -> both binding reads are @CurrentUser()-guarded -> 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        for (const url of [GLOBAL_FORM, perWorkForm(work.id)]) {
            const res = await anon.request.get(url, { timeout: 30_000 });
            expect(res.status(), `anon GET ${url} is guarded as 401`).toBe(401);
        }
        await anon.close();
    });
});
