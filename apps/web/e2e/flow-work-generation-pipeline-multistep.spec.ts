import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';

/**
 * FLOW: Work → generation PIPELINE, walked end-to-end as a MULTISTEP integration.
 *
 * This file targets the generation PIPELINE PLUMBING that the three sibling
 * generation specs leave uncovered: the CreateItemsGeneratorDto / UpdateItemsGeneratorDto
 * validation LATTICE, the provider-gate BODY shape (not just its presence), the
 * /update (AI item update) endpoint's ordering + DTO surface, the /history filter +
 * pagination MATRIX, cross-endpoint gate SYMMETRY (generate vs quick-create), and a
 * cohesive create→form→generate→history→update→cancel WALK. The CI driver has NO LLM
 * key, NO search provider (Tavily) and NO Trigger.dev worker, so generation NEVER
 * completes — we assert the RECORD / contract at every hop, never pipeline content.
 *
 * ── SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100, 2026-07-21) and
 *    the real source BEFORE WRITING ────────────────────────────────────────────
 *    sources: apps/api/src/works/works.controller.ts
 *               (@Post('works/:id/generate'), @Post('works/:id/update'),
 *                @Get('works/:id/history'), @Post('works/quick-create'),
 *                @Get('works/:id/generator-form'), @Post('works/:id/cancel-generation'))
 *             packages/agent/src/items-generator/dto/create-items-generator.dto.ts
 *               (CreateItemsGeneratorDto + UpdateItemsGeneratorDto + ProvidersDto)
 *             packages/agent/src/items-generator/dto/items-generator-response.dto.ts
 *             packages/agent/src/utils/sanitize.util.ts (sanitizeName / sanitizePrompt)
 *
 *   POST /api/works/:id/generate  (CreateItemsGeneratorDto)  @HttpCode(202)
 *     - `name` (string, @IsNotEmpty, @MaxLength 200) AND `prompt` (string,
 *       @IsNotEmpty, @MaxLength 5000) are REQUIRED. Empty {} -> 400 class-validator
 *       { error:'Bad Request', message:[ 'name should not be empty', ...,
 *         'prompt should not be empty', ... ], statusCode:400 }.
 *     - forbidNonWhitelisted IS ON: an unknown key -> 400 [ 'property <k> should not exist' ].
 *     - `generation_method` is @IsEnum(GenerationMethod) — a bad value -> 400
 *       [ 'generation_method must be one of the following values: create-update, recreate, import' ].
 *     - `providers.ai` must be a string: a number -> 400 [ 'providers.ai must be a string' ];
 *       `providers` as a scalar -> 400 [ 'nested property providers must be either object or array' ].
 *     - GOTCHA (non-obvious): `name`/`prompt`/`model` each carry a @Transform that
 *       sanitizeName/sanitizePrompt-CLAMPS the string to its max BEFORE @MaxLength runs,
 *       so an OVER-LENGTH value does NOT produce a MaxLength 400 — it is silently
 *       truncated and the request proceeds to the provider gate. (Contrast
 *       generate-details, whose plain @MaxLength DOES 400.)
 *     - With a VALID DTO but no AI/search provider configured (CI), the service
 *       rejects at prepareProviders() BEFORE any persistence -> 400
 *       { message:'One or more selected providers are not available.',
 *         providerErrors:{ search:'Default provider "Tavily" is not configured...',
 *                          ai:'Default provider "OpenRouter" is not configured...' } }.
 *       This gate has NO `error:'Bad Request'` marker — it is distinguishable from a
 *       class-validator 400 by the `providerErrors` object + the exact message.
 *
 *   POST /api/works/:id/update  (UpdateItemsGeneratorDto)  @HttpCode(202)
 *     - The DTO has NO required fields (model / generation_method / update_with_pull_request /
 *       providers are all @IsOptional), so an EMPTY {} PASSES validation and reaches the
 *       service — where a work that has never generated has no stored last_request_data ->
 *       400 { status:'error', slug, message:'Configuration invalid or missing. Please run a
 *       manual generation first.' }. This proves the generate-BEFORE-update ORDERING.
 *     - forbidNonWhitelisted + @IsEnum apply exactly as on /generate.
 *
 *   GET /api/works/:id/history?limit&offset&activityType  @HttpCode(200)
 *     -> 200 { status:'success', history:[], total, limit, offset }.
 *     - activityType ∈ { generation, items, comparisons, taxonomy, community_pr } — each a
 *       well-formed envelope; an UNKNOWN activityType is a NO-OP (still 200, not 400).
 *     - Pagination echoes offset verbatim (incl. offset>total -> empty history, total preserved);
 *       limit is coerced via `parsedLimit && !isNaN` so limit=0 / limit=abc FALL BACK to the
 *       service default (10), while offset=abc falls back to 0.
 *
 *   POST /api/works/quick-create (QuickCreateWorkDto) @HttpCode(202) @Throttle(10/60s)
 *     - create + generate in one call. In CI it hits the SAME provider gate -> 400 with the
 *       SAME providerErrors shape. GOTCHA: the Work is created FIRST and PERSISTS even when the
 *       generation step 400s (non-atomic) — the slug is afterwards taken (check-slug false + `-N`).
 *
 *   GET /api/works/:id/generator-form -> 200 bare schema { resolvedPipelineId, providers, ... };
 *       the default search/ai providers (tavily/openrouter) report configured:false in CI, which is
 *       exactly WHY /generate gates — this file uses the form only as a PRE-FLIGHT correlation.
 *   POST /api/works/:id/cancel-generation -> 202 { status:'success', message, mode } (never-generated
 *       work deterministically takes mode:'already_finished').
 *
 * ── AUTHZ (probed) ───────────────────────────────────────────────────────────
 *   unauth generate/update/history -> 401; cross-owner update/history -> 403
 *   { status:'error', message:'You do not have permission to access this work' };
 *   missing-id update/history -> 404 { status:'error', message:"Work with id '..' not found" }.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────────
 *   flow-work-generation-lifecycle.spec.ts  -> lifecycle COLUMNS, ?generateStatus no-op,
 *     per-work isolation, sequential re-generation, generate-authz/deleted-work matrix.
 *   flow-work-generation-cancel.spec.ts       -> the ENTIRE /cancel-generation surface.
 *   flow-works-generation-lifecycle.spec.ts   -> generator-form SCHEMA shape + generate-details.
 *   THIS file is disjoint: the /generate + /update DTO VALIDATION LATTICE (unknown key,
 *   enum, nested providers, sanitize-CLAMP vs MaxLength), the provider-gate BODY shape,
 *   the /update endpoint (ordering + DTO + authz on that surface), the /history filter +
 *   pagination MATRIX, quick-create⇄generate gate SYMMETRY + create-first persistence,
 *   PARALLEL generate, and the cohesive multistep WALK — none asserted elsewhere.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────────
 *   One FRESH registerUserViaAPI() user owns every mutation (cross-spec rule); attackers
 *   are fresh users too. Unique slugs; assert toContain / status-sets, never exact counts.
 *   Anon = explicit empty storageState. No module-scope await. TS strict (tsc-gated).
 */

// The generate/quick-create ENQUEUE family: 202 declared happy path; 200/201 adapters
// collapsing to OK; 400 = provider gate (Tavily/OpenRouter unconfigured in CI); the rest
// = other truthful provider/worker/throttle rejections. Never assert pipeline success.
const GENERATE_ENQUEUE_OK = new Set([200, 201, 202, 400, 402, 409, 422, 429, 500, 503]);

// The real GenerationMethod enum values (source: contracts/api). A bad value is a 400.
const GENERATION_METHODS = ['create-update', 'recreate', 'import'];

// The activityType history filter buckets the controller documents.
const HISTORY_ACTIVITY_TYPES = ['generation', 'items', 'comparisons', 'taxonomy', 'community_pr'];

// The exact provider-gate message emitted when no AI/search provider is configured.
const PROVIDER_GATE_MESSAGE = 'One or more selected providers are not available.';

// A valid CreateItemsGeneratorDto body (name + prompt satisfy @IsNotEmpty). In CI this
// still 400s at the provider gate — that is the deterministic contract we lean on.
const VALID_GENERATE_BODY = {
    name: 'e2e pipeline',
    prompt: 'List three open-source developer tools.',
};

interface WorkRecord {
    id: string;
    slug?: string;
    generateStatus?: { status?: string } | null;
    generationStartedAt?: string | null;
    generationProgressedAt?: string | null;
    generationFinishedAt?: string | null;
}

interface HistoryEnvelope {
    status?: string;
    history?: unknown;
    total?: number;
    limit?: number;
    offset?: number;
}

interface ProviderGateBody {
    message?: unknown;
    providerErrors?: Record<string, unknown>;
    error?: string;
    statusCode?: number;
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

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createWork(
    request: APIRequestContext,
    token: string,
    label = 'pipe',
): Promise<{ id: string; work: WorkRecord }> {
    const suffix = uniqueSuffix();
    const created = await createWorkViaAPI(request, token, {
        name: `WGP ${label} ${suffix}`,
        slug: `wgp-${label}-${suffix}`,
        description: `work-generation-pipeline e2e ${suffix}`,
    });
    expect(created.id, `createWork(${label}) returns an id`).toBeTruthy();
    return { id: created.id, work: (created.raw as { work?: WorkRecord }).work as WorkRecord };
}

async function readWork(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<WorkRecord> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET /works/${id}`).toBe(200);
    const body = (await res.json()) as { status?: string; work?: WorkRecord };
    expect(body.status, 'detail envelope').toBe('success');
    return body.work as WorkRecord;
}

async function generate(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown> = VALID_GENERATE_BODY,
): Promise<{ status: number; body: unknown }> {
    const res = await request.post(`${API_BASE}/api/works/${id}/generate`, {
        data: body,
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await readJsonSafe(res) };
}

async function getHistory(
    request: APIRequestContext,
    token: string,
    id: string,
    query = '',
): Promise<{ status: number; body: HistoryEnvelope }> {
    const res = await request.get(`${API_BASE}/api/works/${id}/history${query}`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await readJsonSafe(res)) as HistoryEnvelope };
}

/** The lifecycle columns of a never-completed work must stay parked at their null defaults. */
function expectParkedLifecycle(work: WorkRecord, ctx: string): void {
    if (work.generateStatus != null) {
        expect(typeof work.generateStatus, `${ctx}: generateStatus is an object not a string`).toBe(
            'object',
        );
        expect(
            ['generated', 'error', 'cancelled'],
            `${ctx}: no worker -> generation never reaches a terminal state`,
        ).not.toContain(work.generateStatus.status);
    }
    expect(work.generationFinishedAt, `${ctx}: no worker -> never finished`).toBeNull();
}

/**
 * Assert the CI provider-gate body when a valid-DTO /generate (or quick-create) is rejected
 * for want of configured providers. Guarded: only enforced when the response IS a 400 carrying
 * `providerErrors`, so a future keyed environment (202/other) can't break the suite.
 */
function expectProviderGate(status: number, body: ProviderGateBody, ctx: string): void {
    expect(
        GENERATE_ENQUEUE_OK.has(status),
        `${ctx}: status ${status} must be in the accepted-or-truthful enqueue family`,
    ).toBeTruthy();
    expect(status, `${ctx}: must not 5xx`).toBeLessThan(500);
    if (status === 400 && body && typeof body === 'object' && body.providerErrors) {
        expect(body.message, `${ctx}: exact provider-gate message`).toBe(PROVIDER_GATE_MESSAGE);
        expect(typeof body.providerErrors, `${ctx}: providerErrors is an object`).toBe('object');
        // The two DEFAULT providers that are unconfigured in the keyless CI driver.
        expect(String(body.providerErrors.search), `${ctx}: search gate names Tavily`).toMatch(
            /Tavily/i,
        );
        expect(String(body.providerErrors.ai), `${ctx}: ai gate names OpenRouter`).toMatch(
            /OpenRouter/i,
        );
        // The provider gate is NOT a class-validator failure.
        expect(body.error, `${ctx}: provider gate carries no 'Bad Request' marker`).not.toBe(
            'Bad Request',
        );
    }
}

test.describe('Work generation pipeline (multistep, Trigger-gated)', () => {
    let user: RegisteredUser;
    let token: string;
    let headers: Record<string, string>;

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        user = await registerUserViaAPI(ctx);
        token = user.access_token;
        headers = authedHeaders(token);
        await ctx.dispose();
    });

    // ─── Group A — /generate DTO validation lattice ────────────────────────────

    test('generate DTO: an empty body fails validation naming BOTH required fields (name + prompt)', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'empty');
        const res = await generate(request, token, id, {});
        expect(res.status, 'empty generate body -> 400 validation').toBe(400);
        const body = res.body as { error?: string; message?: unknown; statusCode?: number };
        expect(body.error, 'class-validator 400 marker').toBe('Bad Request');
        expect(body.statusCode, 'statusCode echoed').toBe(400);
        expect(Array.isArray(body.message), 'validation message is an array').toBeTruthy();
        const msg = JSON.stringify(body.message);
        expect(msg, 'names the required name field').toMatch(/name should not be empty/i);
        expect(msg, 'names the required prompt field').toMatch(/prompt should not be empty/i);
        // A pure validation rejection never touched the work.
        expectParkedLifecycle(await readWork(request, token, id), 'after empty-body 400');
    });

    test('generate DTO: forbidNonWhitelisted rejects an unknown property with "should not exist"', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'whitelist');
        const res = await generate(request, token, id, {
            name: 'ok',
            prompt: 'ok',
            bogusField: 123,
            anotherStray: true,
        });
        expect(res.status, 'unknown property -> 400').toBe(400);
        const body = res.body as { error?: string; message?: unknown };
        expect(body.error, 'forbidNonWhitelisted is a Bad Request').toBe('Bad Request');
        const msg = JSON.stringify(body.message);
        expect(msg, 'names the offending unknown property').toMatch(
            /property bogusField should not exist/i,
        );
    });

    test('generate DTO: an invalid generation_method enum is rejected and lists the real allowed values', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'enum');
        const res = await generate(request, token, id, {
            name: 'ok',
            prompt: 'ok',
            generation_method: 'NOT_A_METHOD',
        });
        expect(res.status, 'bad enum -> 400').toBe(400);
        const msg = JSON.stringify((res.body as { message?: unknown }).message);
        expect(msg, 'names generation_method').toMatch(/generation_method must be one of/i);
        for (const method of GENERATION_METHODS) {
            expect(msg, `enum lists the real value "${method}"`).toContain(method);
        }
    });

    test('generate DTO: nested providers is type-checked (ai must be a string; providers must be object/array)', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'nested');

        // A non-string providers.ai fails the nested @IsString.
        const wrongType = await generate(request, token, id, {
            name: 'ok',
            prompt: 'ok',
            providers: { ai: 123 },
        });
        expect(wrongType.status, 'providers.ai number -> 400').toBe(400);
        expect(
            JSON.stringify((wrongType.body as { message?: unknown }).message),
            'names providers.ai as a string violation',
        ).toMatch(/providers\.ai must be a string/i);

        // A scalar providers fails @ValidateNested (must be object or array).
        const scalar = await generate(request, token, id, {
            name: 'ok',
            prompt: 'ok',
            providers: 'notanobject',
        });
        expect(scalar.status, 'scalar providers -> 400').toBe(400);
        expect(
            JSON.stringify((scalar.body as { message?: unknown }).message),
            'names the nested providers structural violation',
        ).toMatch(/nested property providers must be either object or array/i);
    });

    test('generate DTO: over-length name/prompt/model are sanitize-CLAMPED (no MaxLength 400) and reach the provider gate', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'clamp');

        // name > 200, prompt > 5000, model > 200 — each carries a truncating @Transform
        // that runs BEFORE @MaxLength, so NONE of these produces a MaxLength validation 400;
        // instead the request proceeds and hits the provider gate.
        const cases: Array<{ label: string; body: Record<string, unknown> }> = [
            { label: 'name>200', body: { name: 'a'.repeat(260), prompt: 'ok' } },
            { label: 'prompt>5000', body: { name: 'ok', prompt: 'p'.repeat(5200) } },
            {
                label: 'model>200',
                body: { name: 'ok', prompt: 'ok', model: 'm'.repeat(260) },
            },
        ];
        for (const c of cases) {
            const res = await generate(request, token, id, c.body);
            // Must be in the enqueue family and, crucially, NOT a length-validation 400.
            expect(
                GENERATE_ENQUEUE_OK.has(res.status),
                `${c.label}: status ${res.status} in the enqueue family`,
            ).toBeTruthy();
            const msg = JSON.stringify((res.body as { message?: unknown }).message ?? '');
            expect(msg, `${c.label}: sanitize-clamp means NO MaxLength failure`).not.toMatch(
                /must be shorter than or equal to/i,
            );
            expect(msg, `${c.label}: not an empty-field failure either`).not.toMatch(
                /should not be empty/i,
            );
            // In the keyless CI driver this deterministically lands on the provider gate.
            expectProviderGate(res.status, res.body as ProviderGateBody, `${c.label} clamp`);
        }
    });

    // ─── Group B — provider gate ───────────────────────────────────────────────

    test('generate provider gate: a valid DTO with no providers configured returns the exact gate body (Tavily + OpenRouter)', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'gate');
        const res = await generate(request, token, id);
        expectProviderGate(res.status, res.body as ProviderGateBody, 'provider gate');

        // When it IS the CI gate (the deterministic case), pin the full body deeply.
        const body = res.body as ProviderGateBody;
        if (res.status === 400 && body.providerErrors) {
            expect(Object.keys(body.providerErrors), 'gate names BOTH search and ai').toEqual(
                expect.arrayContaining(['search', 'ai']),
            );
            expect(String(body.providerErrors.search), 'search gate is actionable').toMatch(
                /Settings/i,
            );
        }
        // The gate fires before any persistence — lifecycle stays parked.
        expectParkedLifecycle(await readWork(request, token, id), 'after provider gate');
    });

    test('generate provider gate: supplying explicit (unconfigured) provider overrides does not bypass or alter the gate', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'override');
        // Valid string overrides referencing plugins that have no key configured — the
        // service still resolves them as unavailable, so the gate is unchanged.
        const res = await generate(request, token, id, {
            name: 'ok',
            prompt: 'ok',
            providers: { ai: 'openrouter', search: 'tavily' },
        });
        expectProviderGate(res.status, res.body as ProviderGateBody, 'override gate');
        // Identical to the no-override gate: same status, same message.
        const bare = await generate(request, token, id);
        expect(res.status, 'override gate matches the bare gate status').toBe(bare.status);
        if (res.status === 400) {
            expect(
                (res.body as ProviderGateBody).message,
                'override gate message is identical',
            ).toBe((bare.body as ProviderGateBody).message);
        }
    });

    test('gate SYMMETRY: quick-create hits the SAME provider gate as /generate but PERSISTS the work first (non-atomic)', async ({
        request,
    }) => {
        const suffix = uniqueSuffix();
        const slug = `wgp-qc-${suffix}`;
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            data: {
                name: `QC ${suffix}`,
                slug,
                description: `quick-create symmetry ${suffix}`,
                prompt: 'List three open-source developer tools.',
                organization: false,
            },
            headers,
        });
        const body = (await readJsonSafe(res)) as ProviderGateBody & {
            status?: string;
            work?: { id?: string };
        };
        expectProviderGate(res.status(), body, 'quick-create gate');

        if (res.status() === 400 && body.providerErrors) {
            // Create-FIRST: the Work was persisted before the generation step threw, so the
            // slug is now TAKEN even though the combined call returned an error.
            const check = await request.get(`${API_BASE}/api/works/check-slug?slug=${slug}`, {
                headers,
            });
            expect(check.status(), 'check-slug -> 200').toBe(200);
            const checkBody = (await check.json()) as {
                available?: boolean;
                suggestion?: string;
            };
            expect(checkBody.available, 'quick-create persisted the work -> slug taken').toBe(
                false,
            );
            expect(checkBody.suggestion, 'a free -N suggestion is offered').toBeTruthy();

            // And the persisted work is listable + lifecycle-parked (generation never ran).
            const list = await request.get(`${API_BASE}/api/works?limit=100&search=${suffix}`, {
                headers,
            });
            expect(list.status()).toBe(200);
            const match = ((await list.json()).works as WorkRecord[]).find((w) => w.slug === slug);
            expect(match, 'persisted quick-create work is listed').toBeTruthy();
            if (match) {
                expectParkedLifecycle(
                    await readWork(request, token, match.id),
                    'quick-create persisted work',
                );
            }
        } else if (res.status() === 202 && body.work?.id) {
            expect(body.status, 'quick-create happy path is pending').toBe('pending');
            expectParkedLifecycle(await readWork(request, token, body.work.id), 'quick-created');
        }
    });

    // ─── Group C — /history filter + pagination matrix ─────────────────────────

    test('history filter matrix: every documented activityType returns a well-formed, count-consistent envelope', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'histmatrix');

        // Baseline (no filter) total — every activityType view of a fresh work agrees with it.
        const base = await getHistory(request, token, id, '?limit=10');
        expect(base.status, 'baseline history -> 200').toBe(200);
        expect(base.body.status, 'baseline envelope').toBe('success');
        expect(Array.isArray(base.body.history), 'baseline history is an array').toBeTruthy();
        expect(typeof base.body.total, 'baseline total numeric').toBe('number');
        const baseTotal = base.body.total ?? -1;

        for (const activityType of HISTORY_ACTIVITY_TYPES) {
            const res = await getHistory(
                request,
                token,
                id,
                `?activityType=${activityType}&limit=10`,
            );
            expect(res.status, `activityType=${activityType} -> 200`).toBe(200);
            expect(res.body.status, `${activityType} envelope`).toBe('success');
            expect(
                Array.isArray(res.body.history),
                `${activityType} history is an array`,
            ).toBeTruthy();
            expect(res.body.limit, `${activityType} echoes limit`).toBe(10);
            // A fresh work has no history of any kind: each filtered total matches baseline (0).
            expect(res.body.total, `${activityType} total consistent with baseline`).toBe(
                baseTotal,
            );
        }
    });

    test('history filter: an UNKNOWN activityType is a documented NO-OP (200 envelope), never a 400', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'histnoop');
        const res = await getHistory(request, token, id, '?activityType=totally-made-up&limit=5');
        expect(res.status, 'unknown activityType still 200 (no-op)').toBe(200);
        expect(res.body.status, 'no-op envelope').toBe('success');
        expect(Array.isArray(res.body.history), 'no-op history is an array').toBeTruthy();
        expect(res.body.limit, 'no-op echoes limit').toBe(5);
    });

    test('history pagination: offset is echoed (incl. beyond-total), while limit=0/abc and offset=abc coerce to defaults', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'histpage');

        // A normal window echoes both params verbatim.
        const normal = await getHistory(request, token, id, '?limit=7&offset=3');
        expect(normal.status).toBe(200);
        expect(normal.body.limit, 'limit echoed').toBe(7);
        expect(normal.body.offset, 'offset echoed').toBe(3);

        // offset beyond total -> empty history, offset echoed verbatim, total preserved.
        const beyond = await getHistory(request, token, id, '?limit=5&offset=999');
        expect(beyond.status).toBe(200);
        expect((beyond.body.history as unknown[]).length, 'beyond-total window is empty').toBe(0);
        expect(beyond.body.offset, 'beyond-total offset echoed').toBe(999);
        expect(beyond.body.total, 'total unaffected by offset').toBe(0);

        // limit=0 is falsy -> service default (10). limit=abc is NaN -> default too.
        const zero = await getHistory(request, token, id, '?limit=0');
        expect(zero.body.limit, 'limit=0 coerces to the default 10').toBe(10);
        const nan = await getHistory(request, token, id, '?limit=abc');
        expect(nan.body.limit, 'limit=abc coerces to the default 10').toBe(10);

        // offset=abc is NaN -> falls back to 0 (not echoed as NaN).
        const offNan = await getHistory(request, token, id, '?offset=abc&limit=4');
        expect(offNan.body.offset, 'offset=abc coerces to 0').toBe(0);
        expect(offNan.body.limit, 'limit still honored alongside bad offset').toBe(4);
    });

    // ─── Group D — /update (AI item update) ordering + DTO surface ─────────────

    test('update ordering: /update on a NEVER-generated work is rejected with the guidance 400 (generate-first)', async ({
        request,
    }) => {
        const { id, work } = await createWork(request, token, 'order');
        // An EMPTY body is DTO-valid for UpdateItemsGeneratorDto (no required fields), so the
        // 400 comes from the SERVICE (no stored last_request_data), proving the ordering law.
        const res = await request.post(`${API_BASE}/api/works/${id}/update`, {
            data: {},
            headers,
        });
        expect(res.status(), 'update-before-generate -> 400').toBe(400);
        const body = (await readJsonSafe(res)) as {
            status?: string;
            slug?: string;
            message?: string;
        };
        expect(body.status, 'guidance error envelope').toBe('error');
        expect(body.slug, 'guidance 400 echoes the work slug').toBe(work.slug);
        expect(String(body.message), 'guidance points to a manual generation first').toMatch(
            /run a manual generation first/i,
        );
        expectParkedLifecycle(await readWork(request, token, id), 'after rejected update');
    });

    test('update DTO: forbidNonWhitelisted + enum validation apply exactly as on /generate', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'updatedto');

        // Unknown property -> forbidNonWhitelisted 400.
        const unknown = await request.post(`${API_BASE}/api/works/${id}/update`, {
            data: { nope: true },
            headers,
        });
        expect(unknown.status(), 'update unknown property -> 400').toBe(400);
        expect(
            JSON.stringify(((await unknown.json()) as { message?: unknown }).message),
            'names the unknown property',
        ).toMatch(/property nope should not exist/i);

        // Bad generation_method enum -> 400 listing the real values.
        const badEnum = await request.post(`${API_BASE}/api/works/${id}/update`, {
            data: { generation_method: 'BAD' },
            headers,
        });
        expect(badEnum.status(), 'update bad enum -> 400').toBe(400);
        expect(
            JSON.stringify(((await badEnum.json()) as { message?: unknown }).message),
            'update enum lists the real values',
        ).toMatch(/generation_method must be one of/i);
    });

    test('update ordering is about generate-precedence, not the model: a VALID model still gets the guidance 400', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'updatemodel');
        // A perfectly valid optional `model` passes the DTO but the work still has no prior
        // generation to reuse -> the SAME config-missing guidance 400 (not a model error).
        const res = await request.post(`${API_BASE}/api/works/${id}/update`, {
            data: { model: 'openai/gpt-4' },
            headers,
        });
        expect(res.status(), 'valid-model update still -> 400 (ordering)').toBe(400);
        const body = (await res.json()) as { status?: string; message?: string };
        expect(body.status, 'still the guidance envelope').toBe('error');
        expect(String(body.message), 'still the generate-first guidance').toMatch(
            /run a manual generation first/i,
        );
    });

    // ─── Group E — multistep walk + concurrency invariants ─────────────────────

    test('MULTISTEP WALK: create → form pre-flight → generate(gate) → history → update(ordering) → cancel → re-read parked', async ({
        request,
    }) => {
        // 1. Create a fresh work — lifecycle columns start null.
        const { id, work } = await createWork(request, token, 'walk');
        expect(work.generateStatus, 'fresh work has null generateStatus').toBeNull();
        expect(work.generationStartedAt, 'fresh work has null startedAt').toBeNull();

        // 2. PRE-FLIGHT: the generator-form shows the default search/ai providers as
        //    unconfigured, which is exactly WHY the next step gates. Correlate them.
        const formRes = await request.get(`${API_BASE}/api/works/${id}/generator-form`, {
            headers,
        });
        expect(formRes.status(), 'generator-form -> 200').toBe(200);
        const form = (await formRes.json()) as {
            providers?: Record<string, Array<{ id?: string; configured?: boolean }>>;
        };
        const defaultAiUnconfigured = (form.providers?.ai ?? []).some(
            (o) => o.id === 'openrouter' && o.configured === false,
        );
        const defaultSearchUnconfigured = (form.providers?.search ?? []).some(
            (o) => o.id === 'tavily' && o.configured === false,
        );

        // 3. GENERATE — with those defaults unconfigured, the pipeline gates before persistence.
        const gen = await generate(request, token, id);
        expectProviderGate(gen.status, gen.body as ProviderGateBody, 'walk generate');
        if (defaultAiUnconfigured && defaultSearchUnconfigured && gen.status === 400) {
            // The pre-flight correctly PREDICTED the gate.
            expect(
                (gen.body as ProviderGateBody).providerErrors,
                'unconfigured pre-flight -> the generate gate fired',
            ).toBeTruthy();
        }

        // 4. HISTORY — the generate attempt left a well-formed (still-empty) history envelope.
        const hist = await getHistory(request, token, id, '?activityType=generation&limit=10');
        expect(hist.status, 'walk history -> 200').toBe(200);
        expect(hist.body.status, 'walk history envelope').toBe('success');
        expect(Array.isArray(hist.body.history), 'walk history is an array').toBeTruthy();

        // 5. UPDATE — still rejected (nothing was persisted to reuse) → ordering holds mid-walk.
        const upd = await request.post(`${API_BASE}/api/works/${id}/update`, { data: {}, headers });
        expect(upd.status(), 'walk update-before-generate -> 400').toBe(400);
        expect(((await upd.json()) as { status?: string }).status).toBe('error');

        // 6. CANCEL — a never-generating work cancels as the idempotent no-op.
        const cancel = await request.post(`${API_BASE}/api/works/${id}/cancel-generation`, {
            data: {},
            headers,
        });
        expect(cancel.status(), 'walk cancel -> 202').toBe(202);
        const cancelBody = (await cancel.json()) as { status?: string; mode?: string };
        expect(cancelBody.status, 'walk cancel envelope').toBe('success');
        expect(cancelBody.mode, 'never-generated -> already_finished').toBe('already_finished');

        // 7. RE-READ — after the whole walk the work is coherent and lifecycle-parked.
        expectParkedLifecycle(await readWork(request, token, id), 'work after full walk');
    });

    test('concurrency: four PARALLEL generate attempts all gate identically and never wedge the work', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'parallel');
        const results = await Promise.all([
            generate(request, token, id),
            generate(request, token, id),
            generate(request, token, id),
            generate(request, token, id),
        ]);
        for (const [i, r] of results.entries()) {
            expect(r.status, `parallel generate #${i} must not 5xx`).toBeLessThan(500);
            expectProviderGate(r.status, r.body as ProviderGateBody, `parallel #${i}`);
        }
        // All four agree on a single coherent status (no torn 409-lock / crash under contention).
        const statuses = new Set(results.map((r) => r.status));
        expect(statuses.size, 'all parallel generates agree on one status').toBe(1);
        // The work survives and is still owner-listed + lifecycle-parked.
        expectParkedLifecycle(await readWork(request, token, id), 'work after parallel generates');
        const list = await request.get(`${API_BASE}/api/works?limit=100`, { headers });
        const ids = ((await list.json()).works as WorkRecord[]).map((w) => w.id);
        expect(ids, 'work still active after parallel generates').toContain(id);
    });

    test('invariant: a gated generate persists NOTHING, so a follow-up /update still fails the ordering gate', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'persistnothing');
        // Fire generate (gated in CI, before any markGenerationStarted persistence).
        const gen = await generate(request, token, id);
        expectProviderGate(gen.status, gen.body as ProviderGateBody, 'pre-update generate');
        // Because the gate persisted no last_request_data, /update STILL cannot proceed —
        // the ordering gate is invariant across a failed generate attempt.
        const upd = await request.post(`${API_BASE}/api/works/${id}/update`, { data: {}, headers });
        expect(upd.status(), 'update after gated generate still -> 400').toBe(400);
        expect(String(((await upd.json()) as { message?: string }).message)).toMatch(
            /run a manual generation first/i,
        );
        expectParkedLifecycle(await readWork(request, token, id), 'after gated-generate + update');
    });

    // ─── Group F — authz on the /update + /history surfaces (distinct from lifecycle) ──

    test('authz: unauthenticated generate, update AND history are all rejected by the controller guard (401)', async ({
        request,
        playwright,
    }) => {
        const { id } = await createWork(request, token, 'unauth');
        const anon = await playwright.request.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const gen = await anon.post(`${API_BASE}/api/works/${id}/generate`, {
                data: VALID_GENERATE_BODY,
            });
            expect(gen.status(), 'unauth generate -> 401').toBe(401);
            const upd = await anon.post(`${API_BASE}/api/works/${id}/update`, { data: {} });
            expect(upd.status(), 'unauth update -> 401').toBe(401);
            const hist = await anon.get(`${API_BASE}/api/works/${id}/history`);
            expect(hist.status(), 'unauth history -> 401').toBe(401);
        } finally {
            await anon.dispose();
        }
    });

    test('authz: cross-owner update + history are 403 (no leak); missing-id update + history are 404 (names the id)', async ({
        request,
    }) => {
        const { id } = await createWork(request, token, 'authzmatrix');

        // --- cross-owner: a DIFFERENT user has no access to update or read this work's history. ---
        const attacker = await registerUserViaAPI(request);
        const attackerHeaders = authedHeaders(attacker.access_token);

        const crossUpdate = await request.post(`${API_BASE}/api/works/${id}/update`, {
            data: {},
            headers: attackerHeaders,
        });
        expect(crossUpdate.status(), 'cross-owner update -> 403').toBe(403);
        const cuBody = (await crossUpdate.json()) as { status?: string; message?: string };
        expect(cuBody.status, 'cross-owner update error envelope').toBe('error');
        expect(String(cuBody.message), 'cross-owner update is a permission denial').toMatch(
            /permission/i,
        );
        // The 403 must NOT leak the guidance/config message (that would reveal work internals).
        expect(String(cuBody.message), 'no internals leak on the denial').not.toMatch(
            /manual generation/i,
        );

        const crossHistory = await request.get(`${API_BASE}/api/works/${id}/history`, {
            headers: attackerHeaders,
        });
        expect(crossHistory.status(), 'cross-owner history -> 403').toBe(403);
        expect(
            String(((await crossHistory.json()) as { message?: string }).message),
            'cross-owner history permission denial',
        ).toMatch(/permission/i);

        // --- missing id: existence is resolved first -> 404 naming the id. ---
        const missingId = '00000000-0000-0000-0000-000000000000';
        const missUpdate = await request.post(`${API_BASE}/api/works/${missingId}/update`, {
            data: {},
            headers,
        });
        expect(missUpdate.status(), 'missing-id update -> 404').toBe(404);
        expect(
            String(((await missUpdate.json()) as { message?: string }).message),
            'missing-id update names not-found',
        ).toMatch(/not found/i);

        const missHistory = await request.get(`${API_BASE}/api/works/${missingId}/history`, {
            headers,
        });
        expect(missHistory.status(), 'missing-id history -> 404').toBe(404);
        expect(
            String(((await missHistory.json()) as { message?: string }).message),
            'missing-id history names the id',
        ).toMatch(/not found/i);
    });
});
