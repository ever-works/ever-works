import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-works-crud-meta-deep.spec.ts — Works LONG-TAIL metadata contract (deep).
 *
 * SCOPE — the small read/write accessor endpoints that hang off the main Works
 * controller (apps/api/src/works/works.controller.ts) which the existing Works
 * specs only smoke-touch. This file pins the EXACT shapes / gates / 4xx
 * envelopes for:
 *   GET  /api/works/website-templates       (full per-template registry shape)
 *   GET  /api/works/:id/website-settings     (authed shape, seeded company_name)
 *   PUT  /api/works/:id/website-settings      (validation-BEFORE-git-gate, then GIT-GATE)
 *   GET  /api/works/:id/history               (NaN limit/offset tolerance + activityType filter)
 *   POST /api/works/quick-create  vs  POST /api/works   (the create-shape divergence)
 *   the META-ENDPOINT 403-vs-404 lattice (foreign-existing → 403, nonexistent → 404).
 *
 * GROUND TRUTH — every status / message / shape below was LIVE-PROBED against the
 * running sqlite-in-memory CI driver (http://127.0.0.1:3100, REQUIRE_EMAIL_VERIFICATION
 * off, keyless, NO MailHog/Redis) on 2026-06-12 BEFORE any assertion, and cross-read
 * against:
 *   - apps/api/src/works/works.controller.ts
 *       (getWebsiteTemplates / getWebsiteSettings+updateWebsiteSettings /
 *        getWorkHistory / quickCreateWork / createWork; getWorkConfig / getWorkStatus /
 *        getWorkCategoriesTags all ensureAccess-then-resolve)
 *   - packages/agent/src/dto/website-settings.dto.ts (UpdateWebsiteSettingsDto:
 *        company_website @IsUrl({protocols:['http','https'],require_protocol:true});
 *        whitelist-validated → unknown props rejected)
 *
 * PROBED CONTRACTS (exact, live):
 *
 *   GET /api/works/website-templates  (authed; getWebsiteTemplates):
 *     200 -> { status:'success', templates: Array<{ id, name, description,
 *              sourceType, originType, isDefault }> }.
 *     The built-in registry exposes BOTH 'classic' (isDefault:true) and 'minimal'
 *     (isDefault:false); both have sourceType:'built_in', originType:'standard'.
 *     (website-templates.spec.ts only pins classic.isDefault; this pins the full
 *      per-row shape + the 'minimal' row + the success envelope.)
 *
 *   GET /api/works/:id/website-settings  (own work, getWebsiteSettings):
 *     200 -> { status:'success', company_name:<the work name>, company_website:'',
 *              settings:{}, custom_menu:{ header:[], footer:[] } }.
 *     company_name is SEEDED from the Work's name on a fresh work; the rest are empty.
 *
 *   PUT /api/works/:id/website-settings  (own work, updateWebsiteSettings,
 *        UpdateWebsiteSettingsDto, whitelist-validated):
 *     - VALIDATION runs FIRST (global ValidationPipe, before the handler/git):
 *         unknown property         -> 400 { message:['property <p> should not exist'], error:'Bad Request' }
 *         company_website:'javascript:alert(1)' (non-http(s)) -> 400 ['company_website must be a URL address']
 *           (security: the field is rendered as an <a href> on the public site; the
 *            DTO @IsUrl gate keeps javascript:/data: schemes from ever reaching an href.)
 *     - A WELL-FORMED body then hits the WRITE path, which is GIT-GATED: with no
 *       connected git provider (CI) the persist fails
 *         -> 400 { status:'error', message:'Please reconnect your Git account to continue.' }
 *       So a valid PUT does NOT round-trip in CI — we assert the TYPED GATE, and that
 *       a subsequent GET is UNCHANGED (the write never landed). (No sibling pins this.)
 *
 *   GET /api/works/:id/history  (getWorkHistory; @Query limit/offset/activityType):
 *     200 -> { status:'success', history:[], total:0, limit, offset }.
 *     limit/offset are parsed with Number()+isNaN guard → a NON-numeric value is
 *     SILENTLY IGNORED and the response echoes the DEFAULTS { limit:10, offset:0 }
 *     (this is the CONTRAST with the Missions manual-parse, which 400s on ?limit=abc).
 *     A valid ?limit=&offset= is echoed verbatim. activityType is a free passthrough
 *     filter: an unknown/items/taxonomy value is NOT rejected → 200 empty for a fresh work.
 *     (flow-work-generation-lifecycle / -cancel / -community-pr pin the base shape and
 *      the generation/community_pr filters; none pins the NaN tolerance or the
 *      arbitrary-activityType passthrough.)
 *
 *   POST /api/works/quick-create  vs  POST /api/works  (the create divergence):
 *     QuickCreateWorkDto REQUIRES { name, description, prompt } (slug optional). A body
 *     missing description/prompt -> 400 with the class-validator messages naming them.
 *     With a complete body, quick-create kicks off AI+search generation which is
 *     PROVIDER-GATED in keyless CI ->
 *         400 { message:'One or more selected providers are not available.',
 *               providerErrors:{ search:'…Tavily…', ai:'…OpenRouter…' } }.
 *     The plain POST /api/works (CreateWorkDto: { name, slug, description, organization })
 *     does NOT generate → it SUCCEEDS 200 { status:'success', work:{ id, … } } on the same
 *     keyless stack. We pin both sides of that divergence. (sec-pin-throttle-contracts
 *     pins the 10/60s throttle; flow-claim-zero-friction / -generation-lifecycle pin the
 *     gated outcome as `<500`; none pins the REQUIRED-FIELD 400 vs the plain-create
 *     success as a contrast.)
 *
 *   META-ENDPOINT 403-vs-404 lattice (ensureAccess precedes existence on the per-:id
 *     readers): a FOREIGN user reading an EXISTING work's meta endpoint ->
 *         403 { status:'error', message:'You do not have permission to access this work' };
 *     a NONEXISTENT (well-formed) id for the OWNER ->
 *         404 { status:'error', message:"Work with id '<id>' not found" }.
 *     This is the existence-leak boundary; we walk it across config/count/categories-tags/
 *     history/website-settings/source-validation in one consolidated assertion. (Individual
 *     specs assert one endpoint each; none walks the whole meta set as a single lattice.)
 *
 * House rules honoured: fresh registerUserViaAPI() owner + fresh work per mutation;
 * per-test unique suffix derived from a per-spec counter (NO module-scope clock);
 * anon via an explicit empty header set; keyless-adaptive (no AI/search/git readback —
 * assert the GATE/typed failure, never a git-backed mutation success); API-contract
 * assertions only; TS strict.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Per-spec monotonic counter — seeds unique slugs without a module-scope clock. */
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface ErrorEnvelope {
    status?: string;
    statusCode?: number;
    error?: string;
    message?: string | string[];
    providerErrors?: Record<string, string>;
}

async function readBody<T = ErrorEnvelope>(res: {
    status(): number;
    text(): Promise<string>;
}): Promise<{ status: number; body: T; text: string }> {
    const text = await res.text().catch(() => '');
    let body: T;
    try {
        body = JSON.parse(text || '{}') as T;
    } catch {
        body = {} as T;
    }
    return { status: res.status(), body, text };
}

function messages(body: ErrorEnvelope): string[] {
    if (Array.isArray(body.message)) return body.message;
    if (typeof body.message === 'string') return [body.message];
    return [];
}

/** Create a fresh owner + a fresh work, returning both. */
async function ownerWithWork(
    request: APIRequestContext,
    tag: string,
): Promise<{ token: string; workId: string }> {
    const owner = await registerUserViaAPI(request);
    const work = await createWorkViaAPI(request, owner.access_token, { name: `Meta ${uniq(tag)}` });
    expect(work.id, 'createWorkViaAPI returned a work id').toBeTruthy();
    return { token: owner.access_token, workId: work.id };
}

test.describe('flow-works-crud-meta-deep — Works long-tail metadata contract', () => {
    // ─── website-templates registry shape ─────────────────────────────────────
    test('GET /works/website-templates → success envelope with the full per-template shape incl. the non-default `minimal` row', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { status, body } = await readBody<{
            status: string;
            templates: Array<{
                id: string;
                name: string;
                description: string;
                sourceType: string;
                originType: string;
                isDefault: boolean;
            }>;
        }>(
            await request.get(`${API_BASE}/api/works/website-templates`, {
                headers: authedHeaders(u.access_token),
            }),
        );
        expect(status, 'authed templates list → 200').toBe(200);
        expect(body.status, 'templates list uses the success envelope').toBe('success');
        expect(Array.isArray(body.templates), 'templates is an array').toBe(true);

        const byId = new Map(body.templates.map((t) => [t.id, t]));
        const classic = byId.get('classic');
        const minimal = byId.get('minimal');
        expect(classic, 'the built-in `classic` template is registered').toBeTruthy();
        expect(minimal, 'the built-in `minimal` template is registered').toBeTruthy();

        // Full per-row shape: every key the controller maps is present + typed.
        for (const t of [classic, minimal]) {
            expect(typeof t!.id).toBe('string');
            expect(typeof t!.name).toBe('string');
            expect(typeof t!.description).toBe('string');
            expect(t!.sourceType, 'built-in templates report sourceType:built_in').toBe('built_in');
            expect(t!.originType, 'built-in templates report originType:standard').toBe('standard');
            expect(typeof t!.isDefault).toBe('boolean');
        }
        // Exactly one default in the built-in pair, and it is `classic`.
        expect(classic!.isDefault, '`classic` is the default template').toBe(true);
        expect(minimal!.isDefault, '`minimal` is NOT the default template').toBe(false);
    });

    // ─── website-settings GET shape ───────────────────────────────────────────
    test('GET /works/:id/website-settings on a fresh work → success envelope with company_name SEEDED from the work name + empty settings/menu', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const name = `WS Seed ${uniq('ws')}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name });

        const { status, body } = await readBody<{
            status: string;
            company_name: string;
            company_website: string;
            settings: Record<string, unknown>;
            custom_menu: { header: unknown[]; footer: unknown[] };
        }>(
            await request.get(`${API_BASE}/api/works/${work.id}/website-settings`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(status, 'own website-settings → 200').toBe(200);
        expect(body.status, 'website-settings success envelope').toBe('success');
        expect(body.company_name, 'company_name is seeded from the work name').toBe(name);
        expect(body.company_website, 'fresh work has an empty company_website').toBe('');
        expect(body.settings, 'fresh settings is an empty object').toEqual({});
        expect(body.custom_menu, 'fresh custom_menu has empty header+footer arrays').toEqual({
            header: [],
            footer: [],
        });
    });

    // ─── website-settings PUT — validation runs BEFORE the handler/git ─────────
    test('PUT /works/:id/website-settings rejects an UNKNOWN property with the whitelist 400 (before any write)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'ws-unknown');
        const { status, body } = await readBody(
            await request.put(`${API_BASE}/api/works/${workId}/website-settings`, {
                headers: authedHeaders(token),
                data: { siteName: 'Nope', notARealField: true },
            }),
        );
        expect(status, 'unknown-property PUT → 400 (whitelist)').toBe(400);
        expect(body.error, 'whitelist rejection uses the Bad Request label').toBe('Bad Request');
        const msgs = messages(body);
        expect(
            msgs.some((m) => m === 'property siteName should not exist'),
            `unknown prop named in 400; got ${JSON.stringify(msgs)}`,
        ).toBe(true);
    });

    test('PUT /works/:id/website-settings rejects a non-http(s) company_website BEFORE the git gate (href-sanitization contract)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'ws-badurl');
        // A `javascript:` scheme must be rejected at the DTO @IsUrl gate — it never
        // reaches the git-gated write path, so the failure is a VALIDATION 400, not the
        // "reconnect your Git account" gate.
        const { status, body } = await readBody(
            await request.put(`${API_BASE}/api/works/${workId}/website-settings`, {
                headers: authedHeaders(token),
                data: { company_website: 'javascript:alert(1)' },
            }),
        );
        expect(status, 'javascript: company_website → 400 validation').toBe(400);
        expect(messages(body)).toContain('company_website must be a URL address');
        // The status:'error' git-gate message must NOT appear — validation short-circuits first.
        expect(
            body.status,
            'rejection is the validation envelope, not the git-gate envelope',
        ).not.toBe('error');
    });

    // ─── website-settings PUT — the GIT GATE (valid body, no round-trip in CI) ──
    test('PUT /works/:id/website-settings with a VALID body is GIT-GATED in CI (typed 400) and does NOT mutate the GET', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const name = `WS Gate ${uniq('wsg')}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name });

        const put = await readBody(
            await request.put(`${API_BASE}/api/works/${work.id}/website-settings`, {
                headers: authedHeaders(owner.access_token),
                data: {
                    company_name: 'Renamed Co',
                    company_website: 'https://example.com',
                    categories_enabled: true,
                },
            }),
        );
        // No connected git provider on the CI stack → the persist is gated with a typed
        // 400. We assert the GATE (never a git-backed success).
        expect(put.status, `valid website-settings PUT is git-gated → 400; body=${put.text}`).toBe(
            400,
        );
        expect(put.body.status, 'git-gate uses the error envelope').toBe('error');
        expect(put.body.message, 'git-gate carries the reconnect-Git message').toBe(
            'Please reconnect your Git account to continue.',
        );

        // The write never landed: GET still shows the seeded name + empty website.
        const after = await readBody<{ company_name: string; company_website: string }>(
            await request.get(`${API_BASE}/api/works/${work.id}/website-settings`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(after.body.company_name, 'company_name unchanged after the gated write').toBe(name);
        expect(
            after.body.company_website,
            'company_website still empty after the gated write',
        ).toBe('');
    });

    // ─── history — NaN limit/offset tolerance (the Missions-contrast) ──────────
    test('GET /works/:id/history echoes a valid limit/offset but SILENTLY DEFAULTS a non-numeric one to {limit:10,offset:0} (NOT a 400)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'hist-nan');
        const headers = authedHeaders(token);

        // Valid numerics are echoed verbatim.
        const valid = await readBody<{
            status: string;
            history: unknown[];
            total: number;
            limit: number;
            offset: number;
        }>(
            await request.get(`${API_BASE}/api/works/${workId}/history?limit=3&offset=1`, {
                headers,
            }),
        );
        expect(valid.status, 'valid history query → 200').toBe(200);
        expect(valid.body.status).toBe('success');
        expect(
            Array.isArray(valid.body.history),
            'history is an array (empty on a fresh work)',
        ).toBe(true);
        expect(valid.body.total, 'fresh work has no history rows').toBe(0);
        expect(valid.body.limit, 'a valid limit is echoed').toBe(3);
        expect(valid.body.offset, 'a valid offset is echoed').toBe(1);

        // A non-numeric limit/offset is NOT rejected (unlike the Missions manual-parse) —
        // it is dropped and the response reports the handler defaults.
        const nan = await readBody<{ status: number; limit: number; offset: number }>(
            await request.get(`${API_BASE}/api/works/${workId}/history?limit=abc&offset=xyz`, {
                headers,
            }),
        );
        expect(nan.status, 'non-numeric history pagination is tolerated → 200, not 400').toBe(200);
        expect(nan.body.limit, 'NaN limit falls back to the default 10').toBe(10);
        expect(nan.body.offset, 'NaN offset falls back to the default 0').toBe(0);
    });

    // ─── history — activityType is a free passthrough filter ───────────────────
    test('GET /works/:id/history?activityType passes through ANY filter token (items / taxonomy / unknown) → 200 empty, never a 400', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'hist-filter');
        const headers = authedHeaders(token);
        for (const activityType of ['items', 'taxonomy', 'totally_unknown_filter']) {
            const { status, body } = await readBody<{ status: string; history: unknown[] }>(
                await request.get(
                    `${API_BASE}/api/works/${workId}/history?activityType=${activityType}`,
                    { headers },
                ),
            );
            expect(status, `activityType=${activityType} is a tolerated passthrough → 200`).toBe(
                200,
            );
            expect(body.status, `activityType=${activityType} success envelope`).toBe('success');
            expect(
                Array.isArray(body.history) && body.history.length === 0,
                `activityType=${activityType} returns an empty history for a fresh work`,
            ).toBe(true);
        }
    });

    // ─── quick-create REQUIRED-FIELD contract (distinct from plain create) ─────
    test('POST /works/quick-create REQUIRES description + prompt: a name-only body → 400 naming the missing fields', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { status, body } = await readBody(
            await request.post(`${API_BASE}/api/works/quick-create`, {
                headers: authedHeaders(u.access_token),
                data: { name: 'Quick No Desc', slug: uniq('qc-missing') },
            }),
        );
        expect(status, 'quick-create missing description+prompt → 400').toBe(400);
        const msgs = messages(body);
        expect(
            msgs.some((m) => m.includes('description')),
            `description is named as required; got ${JSON.stringify(msgs)}`,
        ).toBe(true);
        expect(
            msgs.some((m) => m.includes('prompt')),
            `prompt is named as required; got ${JSON.stringify(msgs)}`,
        ).toBe(true);
    });

    test('POST /works/quick-create with a COMPLETE body is PROVIDER-GATED in keyless CI (400 providerErrors), while plain POST /works SUCCEEDS — the create divergence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // Plain create does NOT generate → it succeeds on the keyless stack.
        const created = await readBody<{ status: string; work?: { id: string } }>(
            await request.post(`${API_BASE}/api/works`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: `Plain ${uniq('plain')}`,
                    slug: uniq('plain-slug'),
                    description: 'plain create succeeds without any AI/search provider',
                    organization: false,
                },
            }),
        );
        expect(created.status, 'plain POST /works → 200').toBe(200);
        expect(created.body.status, 'plain create success envelope').toBe('success');
        expect(created.body.work?.id, 'plain create returns a work id').toBeTruthy();

        // quick-create combines create + AI/search generation → provider-gated (keyless CI).
        const qc = await readBody(
            await request.post(`${API_BASE}/api/works/quick-create`, {
                headers: authedHeaders(u.access_token),
                data: {
                    name: `Quick ${uniq('quick')}`,
                    slug: uniq('quick-slug'),
                    description: 'quick-create probe — should hit the keyless provider gate',
                    prompt: 'a curated list of developer tools',
                },
            }),
        );
        // Environment-adaptive: keyless CI → 400 providerErrors; a keyed env would 202.
        // Never a 5xx; the gate is a typed 4xx, not a crash.
        expect(
            qc.status,
            `quick-create gated outcome is a 4xx (keyless); body=${qc.text}`,
        ).toBeLessThan(500);
        if (qc.status === 400 && qc.body.providerErrors) {
            expect(qc.body.message, 'provider-gate message').toContain(
                'One or more selected providers are not available',
            );
            const keys = Object.keys(qc.body.providerErrors);
            expect(
                keys.includes('ai') || keys.includes('search'),
                `providerErrors names the unconfigured provider(s); got ${JSON.stringify(keys)}`,
            ).toBe(true);
        } else {
            // Keyed env: accepted (202) with a work + generation block.
            expect(qc.status, 'a keyed env accepts quick-create').toBe(202);
        }
    });

    // ─── 403-vs-404 lattice across the per-:id meta endpoints ──────────────────
    test('a FOREIGN user reading an EXISTING work meta endpoint → 403 (access checked before existence) across config/count/categories-tags/history/website-settings/source-validation', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Foreign ${uniq('foreign')}`,
        });
        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);

        const metaPaths = [
            'config',
            'count',
            'categories-tags',
            'history',
            'website-settings',
            'source-validation',
        ];
        for (const path of metaPaths) {
            const { status, body } = await readBody(
                await request.get(`${API_BASE}/api/works/${work.id}/${path}`, { headers: sh }),
            );
            expect(status, `foreign GET /${path} → 403 (not a 404 existence leak)`).toBe(403);
            expect(body.status, `foreign /${path} uses the error envelope`).toBe('error');
            expect(body.message, `foreign /${path} message`).toBe(
                'You do not have permission to access this work',
            );
        }
    });

    test('the OWNER reading a NONEXISTENT (well-formed) work id → 404 "Work with id \'…\' not found" across the same meta endpoints', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const oh = authedHeaders(owner.access_token);
        const metaPaths = [
            'config',
            'count',
            'categories-tags',
            'history',
            'website-settings',
            'source-validation',
        ];
        for (const path of metaPaths) {
            const { status, body } = await readBody(
                await request.get(`${API_BASE}/api/works/${ZERO_UUID}/${path}`, { headers: oh }),
            );
            expect(status, `nonexistent-id GET /${path} → 404`).toBe(404);
            expect(body.status, `nonexistent /${path} error envelope`).toBe('error');
            expect(body.message, `nonexistent /${path} names the missing id`).toBe(
                `Work with id '${ZERO_UUID}' not found`,
            );
        }
    });

    // ─── anon is rejected on the per-:id meta readers (401, before any resolve) ─
    test('anonymous (no bearer) requests to the per-:id meta readers → 401 across config/count/categories-tags/history/website-settings/source-validation', async ({
        request,
    }) => {
        // We need a real, existing id so the 401 is proven to precede the resolver
        // (an anon hit must NOT depend on the work existing).
        const { workId } = await ownerWithWork(request, 'anon');
        for (const path of [
            'config',
            'count',
            'categories-tags',
            'history',
            'website-settings',
            'source-validation',
        ]) {
            const { status, body } = await readBody(
                await request.get(`${API_BASE}/api/works/${workId}/${path}`, { headers: {} }),
            );
            expect(status, `anon GET /${path} → 401`).toBe(401);
            expect(body.statusCode, `anon /${path} 401 statusCode`).toBe(401);
            expect(body.message, `anon /${path} 401 message`).toBe('Unauthorized');
        }
    });

    // ─── website-settings + source-validation WRITES are anon-401 too ──────────
    test('anonymous PUT to /website-settings and /source-validation → 401 (auth precedes both the DTO and the git gate)', async ({
        request,
    }) => {
        const { workId } = await ownerWithWork(request, 'anon-put');
        const ws = await readBody(
            await request.put(`${API_BASE}/api/works/${workId}/website-settings`, {
                headers: {},
                data: { company_name: 'anon' },
            }),
        );
        expect(ws.status, 'anon PUT website-settings → 401').toBe(401);
        expect(ws.body.message).toBe('Unauthorized');

        const sv = await readBody(
            await request.put(`${API_BASE}/api/works/${workId}/source-validation`, {
                headers: {},
                data: { enabled: true, cadence: 'weekly' },
            }),
        );
        expect(sv.status, 'anon PUT source-validation → 401').toBe(401);
        expect(sv.body.message).toBe('Unauthorized');
    });

    // ─── history pagination round-trip is independent of activityType ──────────
    test('GET /works/:id/history combines activityType + pagination: the limit/offset echo is unaffected by the filter token', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request, 'hist-combo');
        const { status, body } = await readBody<{
            status: string;
            limit: number;
            offset: number;
            total: number;
        }>(
            await request.get(
                `${API_BASE}/api/works/${workId}/history?activityType=generation&limit=7&offset=2`,
                { headers: authedHeaders(token) },
            ),
        );
        expect(status, 'filtered+paginated history → 200').toBe(200);
        expect(body.status).toBe('success');
        expect(body.limit, 'limit echoed alongside the activityType filter').toBe(7);
        expect(body.offset, 'offset echoed alongside the activityType filter').toBe(2);
        expect(body.total, 'a fresh work has zero history rows under any filter').toBe(0);
    });
});
