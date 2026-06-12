import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: Works generation LONG-TAIL — the GENERATOR-FORM schema surface +
 * the GENERATE-DETAILS deterministic (keyless) contract.
 *
 * The Works generation area already has THREE specs. This file is disjoint and
 * pins the two pre-generation surfaces that the others only smoke-touch:
 *
 *   GET  /api/works/:id/generator-form   (work-scoped dynamic form schema)
 *   GET  /api/generator-form             (global / no-work form schema)
 *   POST /api/works/generate-details     (AI-assisted name/slug/desc/keywords)
 *
 * Both are reachable + meaningfully completable in the keyless CI driver:
 *   - generator-form is built from the in-process plugin REGISTRY (no LLM call),
 *     so it returns a full schema even with zero provider API keys.
 *   - generate-details has a DETERMINISTIC fallback (slugify + "Work for <name>"
 *     + [lowercased prompt]) that returns 200 with NO AI provider configured —
 *     it is NOT Trigger/provider-gated like POST /works/:id/generate.
 * Neither requires a Trigger.dev worker, git remote, MailHog, or Redis.
 *
 * ── SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100, 2026-06-12)
 *    and the real source BEFORE WRITING ───────────────────────────────────
 *    sources: apps/api/src/works/works.controller.ts
 *               (@Get('works/:id/generator-form'), @Get('generator-form'),
 *                @Post('works/generate-details'))
 *             apps/api/src/works/dto/generate-detail.dto.ts (GenerateWorkDetailDto)
 *             packages/agent/src/services/generator-form-schema.service.ts
 *
 *   GET /api/works/:id/generator-form?pipelineId=  @HttpCode(200)
 *     -> 200 GeneratorFormSchema (a BARE object, NOT a { status } envelope):
 *        { resolvedPipelineId?: string, enforcedPipelineId?: string,
 *          providers: Record<uiKey, ProviderOption[]>, pluginFields: [],
 *          pluginGroups?: object, handledConfigFields?: string[],
 *          defaultValues?: object }
 *        - `providers` is keyed by UI-key: search, screenshot, ai,
 *          contentExtractor, pipeline (the selectable categories). Each
 *          ProviderOption = { id, name, description, configured:boolean,
 *          isDefault:boolean, icon, models? }.
 *        - In CI the default pipeline 'agent-pipeline' IS loaded, so
 *          resolvedPipelineId defaults to 'agent-pipeline'. Passing
 *          ?pipelineId=standard-pipeline ECHOES standard-pipeline; passing a
 *          BOGUS id FALLS BACK to agent-pipeline (NOT a 400 — graceful).
 *        - Keyless plugin isolation: the system/local plugins
 *          (local-content-extractor, the pipelines) report configured:true,
 *          while the BYOK providers needing an API key (tavily, openrouter)
 *          report configured:false. That split is the whole point of the form.
 *        - pluginFields is ALWAYS an array (defended in source against a
 *          misbehaving plugin returning a non-array — that 500'd the endpoint).
 *     Access: ensureAccess BEFORE building -> missing id 404, non-owner 403,
 *             unauthenticated 401.
 *
 *   GET /api/generator-form?pipelineId=  @HttpCode(200) — same schema shape but
 *     WORK-CONTEXT-FREE (no ensureAccess; userId-scoped only). unauth -> 401.
 *
 *   POST /api/works/generate-details (GenerateWorkDetailDto) @HttpCode(200)
 *     DTO: work_name (string, NOT empty, <=200) + prompt (string, NOT empty,
 *          <=8000) REQUIRED; ai_provider (string) OPTIONAL.
 *     -> 200 { name, slug, description, keywords:string[], categories:[] }
 *        Keyless fallback is DETERMINISTIC:
 *          slug         = slugify(work_name) (lowercase, non-alnum -> '-', trimmed)
 *          description  = "Work for <work_name>"
 *          keywords     = [ work_name.toLowerCase() ]  (raw, pre-slug)
 *          categories   = []
 *     -> empty body 400 { error:'Bad Request', message:string[] } naming
 *        work_name AND prompt; prompt-only 400 naming work_name; work_name>200
 *        400 'work_name must be shorter than or equal to 200 characters'.
 *     -> ai_provider passthrough (even an unconfigured plugin id) STILL 200 in
 *        CI (the deterministic fallback ignores the missing key). unauth -> 401.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 *   flow-work-generation-lifecycle.spec.ts  -> the /generate provider-gate, the
 *     lifecycle COLUMNS, ?generateStatus no-op, quick-create, generate->update
 *     ordering, generate authz/deleted-work matrix.
 *   flow-work-generation-cancel.spec.ts      -> the entire /cancel-generation surface.
 *   work-generator.spec.ts                   -> SMOKE only: generator-form 200,
 *     generate-details <500, top-level form 401, schedule, UI sub-pages.
 *   flow-comparison-generator.spec.ts        -> the /comparisons/* subsystem.
 *   THIS file is disjoint: it deeply pins the generator-form SCHEMA SHAPE
 *   (provider keys + configured-split + pipelineId echo/fallback + authz on
 *   BOTH variants) and the generate-details DETERMINISTIC keyless contract
 *   (the 200 fallback body, slug derivation, validation-400 discrimination,
 *   MaxLength, ai_provider passthrough) — none of which the others assert.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 *   Every test uses a FRESH registerUserViaAPI() user + (where needed) a fresh
 *   work. Unique slugs from a per-test counter (NOT a module-scope clock). No
 *   module-scope await / loadSeededTestUser(). TS strict. Anon = explicit empty
 *   storageState. .or() single-element assertions carry a trailing .first().
 */

// The selectable provider UI-keys the form schema is keyed by (source:
// getSelectableCategories()). The form must surface these buckets as arrays.
const SELECTABLE_PROVIDER_KEYS = ['ai', 'search', 'contentExtractor', 'screenshot', 'pipeline'];

// The default pipeline that is loaded + default in the keyless CI registry.
const DEFAULT_PIPELINE_ID = 'agent-pipeline';

interface ProviderOption {
    id?: string;
    name?: string;
    description?: string;
    configured?: boolean;
    isDefault?: boolean;
    icon?: unknown;
    models?: unknown;
}

interface GeneratorFormSchema {
    resolvedPipelineId?: string;
    enforcedPipelineId?: string;
    providers?: Record<string, ProviderOption[]>;
    pluginFields?: unknown;
    pluginGroups?: unknown;
    handledConfigFields?: unknown;
    defaultValues?: unknown;
}

interface GenerateDetailsBody {
    name?: string;
    slug?: string;
    description?: string;
    keywords?: unknown;
    categories?: unknown;
}

let testCounter = 0;
function uniqueSuffix(): string {
    testCounter += 1;
    return `${testCounter}${Math.random().toString(36).slice(2, 8)}`;
}

async function readJsonSafe(res: {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        try {
            return await res.text();
        } catch {
            return undefined;
        }
    }
}

async function freshUser(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request);
    expect(u.access_token, 'fresh user has a bearer token').toBeTruthy();
    return u.access_token;
}

async function freshWork(
    request: APIRequestContext,
    token: string,
    label: string,
): Promise<string> {
    const suffix = uniqueSuffix();
    const created = await createWorkViaAPI(request, token, {
        name: `WGL ${label} ${suffix}`,
        slug: `wgl-${label}-${suffix}`,
        description: `works-generation-lifecycle e2e ${suffix}`,
    });
    expect(created.id, `createWork(${label}) returns an id`).toBeTruthy();
    return created.id;
}

/** Assert the structural invariants of a GeneratorFormSchema (provider-key map + array fields). */
function expectFormSchemaShape(schema: GeneratorFormSchema, ctx: string): void {
    // It is a BARE schema object, never a { status:'success' } envelope.
    expect(schema, `${ctx}: schema is an object`).toBeTruthy();
    expect(
        (schema as { status?: unknown }).status,
        `${ctx}: generator-form is NOT a status envelope`,
    ).toBeUndefined();

    // providers is an object map keyed by selectable UI-keys, each value an array.
    expect(typeof schema.providers, `${ctx}: providers is an object map`).toBe('object');
    const providers = schema.providers ?? {};
    for (const key of SELECTABLE_PROVIDER_KEYS) {
        expect(providers[key], `${ctx}: providers has a "${key}" bucket`).toBeDefined();
        expect(Array.isArray(providers[key]), `${ctx}: providers.${key} is an array`).toBeTruthy();
    }

    // pluginFields is ALWAYS an array (the source coerces non-arrays to [] so a
    // misbehaving plugin can't 500 the endpoint).
    expect(Array.isArray(schema.pluginFields), `${ctx}: pluginFields is an array`).toBeTruthy();

    // A loaded pipeline must resolve; in keyless CI it is the default 'agent-pipeline'.
    expect(typeof schema.resolvedPipelineId, `${ctx}: resolvedPipelineId is a string`).toBe(
        'string',
    );
}

test.describe('Works generation long-tail: generator-form schema + generate-details (keyless)', () => {
    test('work-scoped generator-form returns the full provider-keyed schema with a configured/unconfigured split', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const workId = await freshWork(request, token, 'formshape');

        const res = await request.get(`${API_BASE}/api/works/${workId}/generator-form`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'work generator-form -> 200').toBe(200);
        const schema = (await res.json()) as GeneratorFormSchema;
        expectFormSchemaShape(schema, 'work-scoped form');

        // The default pipeline is the loaded 'agent-pipeline' on a fresh work that
        // has no per-work active-pipeline override.
        expect(schema.resolvedPipelineId, 'default resolved pipeline').toBe(DEFAULT_PIPELINE_ID);

        // The pipeline bucket lists the loaded pipeline plugins, each fully formed.
        const pipelines = schema.providers?.pipeline ?? [];
        expect(pipelines.length, 'at least one loaded pipeline provider').toBeGreaterThan(0);
        for (const p of pipelines) {
            expect(typeof p.id, 'pipeline option has an id').toBe('string');
            expect(typeof p.name, 'pipeline option has a name').toBe('string');
            expect(typeof p.configured, 'pipeline option has a configured flag').toBe('boolean');
            expect(typeof p.isDefault, 'pipeline option has an isDefault flag').toBe('boolean');
        }
        // Exactly one pipeline is marked default, and it matches resolvedPipelineId.
        const defaultPipelines = pipelines.filter((p) => p.isDefault);
        expect(defaultPipelines.length, 'exactly one default pipeline').toBe(1);
        expect(defaultPipelines[0]?.id, 'default pipeline matches resolved').toBe(
            schema.resolvedPipelineId,
        );

        // KEYLESS isolation contract: the system/local plugins are configured:true
        // (no key needed); the BYOK providers that need an API key are
        // configured:false. We assert THAT split structurally — every option has a
        // boolean flag, and at least one configured + at least one unconfigured
        // option exists across the whole schema (the local extractor vs tavily/openrouter).
        const allOptions = Object.values(schema.providers ?? {}).flat();
        expect(allOptions.length, 'schema surfaces provider options').toBeGreaterThan(0);
        for (const o of allOptions) {
            expect(typeof o.configured, `provider "${o.id}" has a boolean configured flag`).toBe(
                'boolean',
            );
        }
        const configuredCount = allOptions.filter((o) => o.configured === true).length;
        const unconfiguredCount = allOptions.filter((o) => o.configured === false).length;
        expect(
            configuredCount,
            'keyless: at least one system/local provider is configured',
        ).toBeGreaterThan(0);
        expect(
            unconfiguredCount,
            'keyless: at least one BYOK provider is unconfigured (no API key)',
        ).toBeGreaterThan(0);
    });

    test('generator-form pipelineId: a valid id is echoed, a bogus id falls back to the default (never a 400)', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const workId = await freshWork(request, token, 'pipeid');

        // A valid, loaded pipeline id is ECHOED into resolvedPipelineId.
        const stdRes = await request.get(
            `${API_BASE}/api/works/${workId}/generator-form?pipelineId=standard-pipeline`,
            { headers: authedHeaders(token) },
        );
        expect(stdRes.status(), 'valid pipelineId -> 200').toBe(200);
        const stdSchema = (await stdRes.json()) as GeneratorFormSchema;
        expectFormSchemaShape(stdSchema, 'standard-pipeline form');
        expect(stdSchema.resolvedPipelineId, 'valid pipelineId is echoed').toBe(
            'standard-pipeline',
        );

        // A BOGUS pipeline id does NOT 400 — the resolver gracefully falls back to
        // the default loaded pipeline. This is the documented resilience stance.
        const bogusRes = await request.get(
            `${API_BASE}/api/works/${workId}/generator-form?pipelineId=does-not-exist-xyz`,
            { headers: authedHeaders(token) },
        );
        expect(bogusRes.status(), 'bogus pipelineId still 200 (graceful fallback)').toBe(200);
        const bogusSchema = (await bogusRes.json()) as GeneratorFormSchema;
        expectFormSchemaShape(bogusSchema, 'bogus-pipeline form');
        expect(bogusSchema.resolvedPipelineId, 'bogus pipelineId falls back to default').toBe(
            DEFAULT_PIPELINE_ID,
        );
    });

    test('the global (work-context-free) generator-form returns the same schema shape and honours pipelineId', async ({
        request,
    }) => {
        const token = await freshUser(request);

        // No work context: built from the registry, userId-scoped only.
        const res = await request.get(`${API_BASE}/api/generator-form`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'global generator-form -> 200').toBe(200);
        const schema = (await res.json()) as GeneratorFormSchema;
        expectFormSchemaShape(schema, 'global form');
        expect(schema.resolvedPipelineId, 'global default pipeline').toBe(DEFAULT_PIPELINE_ID);

        // The global form honours pipelineId exactly like the work-scoped one.
        const stdRes = await request.get(
            `${API_BASE}/api/generator-form?pipelineId=standard-pipeline`,
            { headers: authedHeaders(token) },
        );
        expect(stdRes.status(), 'global form valid pipelineId -> 200').toBe(200);
        const stdSchema = (await stdRes.json()) as GeneratorFormSchema;
        expect(stdSchema.resolvedPipelineId, 'global form echoes pipelineId').toBe(
            'standard-pipeline',
        );
    });

    test('generator-form authz matrix: unauth 401 (both variants), cross-owner 403, missing-work 404', async ({
        request,
        playwright,
    }) => {
        const token = await freshUser(request);
        const workId = await freshWork(request, token, 'authz');

        // --- unauthenticated: empty storageState so we don't inherit a project cookie. ---
        const anon = await playwright.request.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const anonWork = await anon.get(`${API_BASE}/api/works/${workId}/generator-form`);
            expect(anonWork.status(), 'unauth work-scoped form -> 401').toBe(401);
            const anonGlobal = await anon.get(`${API_BASE}/api/generator-form`);
            expect(anonGlobal.status(), 'unauth global form -> 401').toBe(401);
        } finally {
            await anon.dispose();
        }

        // --- cross-owner: a DIFFERENT user has no access to this work's form. ---
        const attackerToken = await freshUser(request);
        const cross = await request.get(`${API_BASE}/api/works/${workId}/generator-form`, {
            headers: authedHeaders(attackerToken),
        });
        expect(cross.status(), 'cross-owner work form -> 403').toBe(403);
        const crossBody = (await readJsonSafe(cross)) as { status?: string; message?: string };
        expect(crossBody.status, 'cross-owner error envelope').toBe('error');
        expect(String(crossBody.message), 'cross-owner permission denial').toMatch(/permission/i);

        // --- missing work id: ensureAccess resolves existence first -> 404. ---
        const missingId = '00000000-0000-0000-0000-000000000000';
        const missing = await request.get(`${API_BASE}/api/works/${missingId}/generator-form`, {
            headers: authedHeaders(token),
        });
        expect(missing.status(), 'missing-work form -> 404').toBe(404);
        const missingBody = (await readJsonSafe(missing)) as { message?: string };
        expect(String(missingBody.message), 'missing-work message names not-found').toMatch(
            /not found/i,
        );

        // The owner is unaffected by the rejected cross-owner/missing probes.
        const ownerOk = await request.get(`${API_BASE}/api/works/${workId}/generator-form`, {
            headers: authedHeaders(token),
        });
        expect(ownerOk.status(), 'owner still gets 200 after rejected probes').toBe(200);
    });

    test('generate-details keyless: a valid body returns the deterministic name/slug/description/keywords fallback', async ({
        request,
    }) => {
        const token = await freshUser(request);

        const workName = 'Headless CMS Directory';
        const res = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers: authedHeaders(token),
            data: { work_name: workName, prompt: 'open source headless cms platforms' },
        });
        // This is NOT provider-gated: the deterministic fallback returns 200 keyless.
        expect(res.status(), 'generate-details valid body -> 200 (keyless fallback)').toBe(200);
        const body = (await res.json()) as GenerateDetailsBody;

        // Deterministic fallback contract (probed live):
        //   name = work_name verbatim; slug = slugify(work_name);
        //   description = "Work for <work_name>"; keywords = [work_name.toLowerCase()];
        //   categories = [].
        expect(body.name, 'fallback echoes the work_name').toBe(workName);
        expect(body.slug, 'fallback slug is slugified work_name').toBe('headless-cms-directory');
        expect(body.description, 'fallback description wraps the name').toBe(
            `Work for ${workName}`,
        );
        expect(Array.isArray(body.keywords), 'keywords is an array').toBeTruthy();
        expect(body.keywords, 'keyword is the lowercased name').toContain(workName.toLowerCase());
        expect(Array.isArray(body.categories), 'categories is an array').toBeTruthy();
        expect((body.categories as unknown[]).length, 'keyless categories empty').toBe(0);
    });

    test('generate-details slug derivation: messy names slugify (lowercase, non-alnum collapsed)', async ({
        request,
    }) => {
        const token = await freshUser(request);

        // Probed: "My  Cool!! Project @2026" -> slug "my-cool-project-2026".
        // `name` is preserved VERBATIM (incl. the interior double space), but the
        // `description` wraps a WHITESPACE-COLLAPSED form of the name. Pin both.
        const messyName = 'My  Cool!! Project @2026';
        const res = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers: authedHeaders(token),
            data: { work_name: messyName, prompt: 'a messy-name slug derivation probe' },
        });
        expect(res.status(), 'messy-name generate-details -> 200').toBe(200);
        const body = (await res.json()) as GenerateDetailsBody;

        expect(body.slug, 'messy name slugifies to lowercase hyphenated').toBe(
            'my-cool-project-2026',
        );
        // The slug must contain ONLY [a-z0-9-] and have no leading/trailing/double hyphens.
        expect(body.slug, 'slug is a clean kebab token').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        // `name` preserves the raw casing/punctuation/whitespace verbatim.
        expect(body.name, 'name preserves original text verbatim').toBe(messyName);
        // `description` is "Work for " + the name with interior whitespace collapsed —
        // assert the prefix + the meaningful tokens, not the exact spacing.
        expect(body.description, 'description wraps the name').toMatch(/^Work for /);
        expect(body.description, 'description collapses interior whitespace').toBe(
            `Work for ${messyName.replace(/\s+/g, ' ')}`,
        );
    });

    test('generate-details ai_provider is an optional passthrough — an unconfigured provider still 200s keyless', async ({
        request,
    }) => {
        const token = await freshUser(request);

        // ai_provider is optional; passing an unconfigured plugin id (openrouter, no
        // key in CI) must NOT gate the deterministic fallback — it still 200s.
        const res = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers: authedHeaders(token),
            data: {
                work_name: 'DevTools Hub',
                prompt: 'directory of developer tools',
                ai_provider: 'openrouter',
            },
        });
        expect(res.status(), 'ai_provider passthrough still 200 keyless').toBe(200);
        const body = (await res.json()) as GenerateDetailsBody;
        expect(body.name, 'ai_provider path still returns the fallback name').toBe('DevTools Hub');
        expect(body.slug, 'ai_provider path still slugifies').toBe('devtools-hub');
    });

    test('generate-details validation lattice: empty body, prompt-only, and over-length work_name all 400 distinctly', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const headers = authedHeaders(token);

        // (a) Empty body -> 400 naming BOTH required fields, as a class-validator
        //     'Bad Request' with an ARRAY message.
        const empty = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers,
            data: {},
        });
        expect(empty.status(), 'empty body -> 400').toBe(400);
        const emptyBody = (await empty.json()) as { error?: string; message?: unknown };
        expect(emptyBody.error, 'validation 400 marker').toBe('Bad Request');
        expect(Array.isArray(emptyBody.message), 'validation message is an array').toBeTruthy();
        const emptyMsg = JSON.stringify(emptyBody.message);
        expect(emptyMsg, 'empty body names work_name').toMatch(/work_name/i);
        expect(emptyMsg, 'empty body names prompt').toMatch(/prompt/i);

        // (b) prompt-only -> 400 naming work_name (the missing field) but NOT prompt.
        const promptOnly = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers,
            data: { prompt: 'a prompt with no work_name' },
        });
        expect(promptOnly.status(), 'prompt-only -> 400').toBe(400);
        const promptOnlyMsg = JSON.stringify(
            ((await promptOnly.json()) as { message?: unknown }).message,
        );
        expect(promptOnlyMsg, 'prompt-only names the missing work_name').toMatch(/work_name/i);

        // (c) work_name > 200 chars -> 400 with the MaxLength message (security cap).
        const overLong = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers,
            data: { work_name: 'a'.repeat(250), prompt: 'a valid prompt' },
        });
        expect(overLong.status(), 'over-length work_name -> 400').toBe(400);
        const overLongMsg = JSON.stringify(
            ((await overLong.json()) as { message?: unknown }).message,
        );
        expect(overLongMsg, 'over-length names the work_name length cap').toMatch(
            /work_name must be shorter than or equal to 200/i,
        );
    });

    test('generate-details rejects unauthenticated requests with 401 (controller-wide guard)', async ({
        playwright,
    }) => {
        // Empty storageState so we don't inherit the project auth cookie.
        const anon = await playwright.request.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const res = await anon.post(`${API_BASE}/api/works/generate-details`, {
                data: { work_name: 'x', prompt: 'y' },
            });
            expect(res.status(), 'unauth generate-details -> 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('generate-details never 5xx-stacktraces on hostile inputs (long prompt, control chars, odd casing)', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const headers = authedHeaders(token);

        // A battery of awkward-but-DTO-valid inputs. The endpoint must answer from a
        // truthful family (200 deterministic fallback, or a clean 4xx if a guard
        // trips) and NEVER surface an opaque 500 — assert the graceful contract.
        const hostileBodies: Array<Record<string, unknown>> = [
            // Max-length prompt (exactly at the 8000 cap) — must not overflow into 5xx.
            { work_name: 'Edge Cap Work', prompt: 'x'.repeat(8000) },
            // Control chars + unicode in the prompt (sanitizer territory).
            { work_name: 'Unicode Probe', prompt: 'café\t\n — naïve​ résumé' },
            // Name that slugifies to (near-)empty after stripping symbols.
            { work_name: '@@@ ### !!!', prompt: 'symbol-only name' },
            // Numeric-leading name.
            { work_name: '2026 Roadmap', prompt: 'a year-prefixed name' },
        ];

        for (const data of hostileBodies) {
            const res = await request.post(`${API_BASE}/api/works/generate-details`, {
                headers,
                data,
            });
            expect(
                res.status(),
                `hostile generate-details (${String(data.work_name)}) must not 5xx`,
            ).toBeLessThan(500);
            // It must answer from the accepted-or-truthful family — never a redirect/odd code.
            expect(
                [200, 400, 422].includes(res.status()),
                `hostile generate-details (${String(data.work_name)}) answers 200/400/422, got ${res.status()}`,
            ).toBeTruthy();
            // On a 200 the deterministic shape still holds (name + a clean slug).
            if (res.status() === 200) {
                const body = (await res.json()) as GenerateDetailsBody;
                expect(typeof body.name, 'fallback still returns a name').toBe('string');
                expect(typeof body.slug, 'fallback still returns a slug').toBe('string');
                // slug is always a safe token (possibly empty for symbol-only names),
                // never containing whitespace or path separators.
                expect(String(body.slug), 'slug has no whitespace/separators').not.toMatch(
                    /[\s/\\]/,
                );
            }
        }
    });

    test('generator-form is read-only and side-effect-free: repeated reads are stable and never touch the work lifecycle', async ({
        request,
    }) => {
        const token = await freshUser(request);
        const workId = await freshWork(request, token, 'sideeffect');

        // Read the form schema THREE times — a pure read must be idempotent.
        const reads = await Promise.all(
            [0, 1, 2].map(() =>
                request
                    .get(`${API_BASE}/api/works/${workId}/generator-form`, {
                        headers: authedHeaders(token),
                    })
                    .then(async (r) => ({
                        status: r.status(),
                        schema: (await r.json()) as GeneratorFormSchema,
                    })),
            ),
        );
        for (const [i, r] of reads.entries()) {
            expect(r.status, `form read #${i} -> 200`).toBe(200);
            expect(r.schema.resolvedPipelineId, `form read #${i} stable pipeline`).toBe(
                DEFAULT_PIPELINE_ID,
            );
        }

        // Reading the form NEVER starts generation: the work's lifecycle columns
        // stay at their null defaults (no generateStatus, no startedAt).
        const detail = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(detail.status(), 'work still readable after form reads').toBe(200);
        const work = (
            (await detail.json()) as {
                work?: { generateStatus?: unknown; generationStartedAt?: unknown };
            }
        ).work;
        expect(work?.generateStatus, 'form read leaves generateStatus null').toBeNull();
        expect(work?.generationStartedAt, 'form read leaves startedAt null').toBeNull();
    });
});
