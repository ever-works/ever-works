import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * COMPLEX, multi-step e2e INTEGRATION flows for WORK ↔ AGENT integration
 * SETTINGS: the agent-per-work binding (a `scope:'work'` Agent carrying its
 * own AI provider/model + behavior config), enabling/binding that agent to a
 * work, the per-work AI-provider selection surface, and the per-work
 * advanced-prompts settings — with a hard focus on PERSISTENCE round-trips +
 * VALIDATION boundaries.
 *
 * ── PROBED against the LIVE stack (sqlite in-memory — the CI driver) on
 *    2026-06-01, BEFORE any assertion below was written (curl http://127.0.0.1:3100):
 *
 *  REGISTER DTO: { username, email, password } (registerUserViaAPI maps name→username).
 *  LOGIN DTO: ONLY { email, password }.
 *
 *  THE AGENT-PER-WORK BINDING — POST /api/agents (auth required, @CurrentUser):
 *    A work-scoped Agent IS the "agent bound to a work":
 *      { scope:'work', workId:<uuid>, name, aiProviderId?, modelId?, capabilities?,
 *        heartbeatCadence?, idleBehavior?, pauseAfterFailures?, maxSkillContextTokens?,
 *        permissions?:{…}, targets?:[{type,id}], committerName?, committerEmail? } → 201 AgentDto.
 *    PERSISTED + DEFAULTED on create (probed):
 *      - aiProviderId / modelId / capabilities / committerName / committerEmail persist verbatim.
 *      - permissions is MERGED with the conservative all-false default, so a partial
 *        { canCommitToRepo:true } round-trips with the other 7 flags = false.
 *      - status:'draft', idleBehavior:'propose', maxSkillContextTokens:4000 are the defaults.
 *      - workId is stamped; missionId/ideaId stay null.
 *    SCOPE RULE (verified by flow-agent-scoping-matrix): scope:'work' REQUIRES (and only)
 *      workId else 400 "Work-scoped Agents require workId (and only workId)." — that file
 *      owns the scope-cascade matrix, so we exercise the SETTINGS/CONFIG surface instead.
 *    NB: create does NOT validate work EXISTENCE — a well-formed but unknown workId still
 *      201s (the work-link is a soft reference). So never assert a 404 there.
 *    A duplicate name within the same scope ⇒ 409 (slug uniqueness). A second
 *      DISTINCT-named work-scoped agent on the same work ⇒ 201 (many agents per work).
 *
 *  PATCH /api/agents/:id — partial settings update (auth, ownership-scoped):
 *    - aiProviderId/modelId/capabilities/idleBehavior/maxSkillContextTokens/targets
 *      all persist on the GET round-trip.
 *    - aiProviderId:null + modelId:null CLEAR the binding (200, value null).
 *    - targets:[{type:'work',id:<workId>}] round-trips as-is.
 *    VALIDATION (all 400, class-validator; the persisted row is UNCHANGED after a reject):
 *      - pauseAfterFailures > 20 (or < 1)            → 400 (Min/Max 1..20)
 *      - maxSkillContextTokens > 20000               → 400 (Max 20000)
 *      - committerEmail not an email                 → 400 (@IsEmail)
 *      - idleBehavior not in propose|noop|observe    → 400 (@IsEnum)
 *      - targets[].type not mission|idea|work|wildcard → 400
 *      - name longer than 120                        → 400 (MaxLength 120)
 *    Cross-user PATCH / GET budget on a foreign agent ⇒ 404 (existence is NOT leaked via 403).
 *
 *  THE PER-WORK AI-PROVIDER SELECTION SURFACE — GET /api/works/:id/generator-form:
 *    GeneratorFormSchema { resolvedPipelineId, providers:{ ai, search, screenshot,
 *      contentExtractor, pipeline }, pluginFields, pluginGroups, defaultValues }.
 *    providers.ai = the AI-provider plugins this work can bind to; in CI the env key
 *      configures exactly 'openrouter' (configured:true, isDefault:true). The per-work
 *      pipeline selection flips resolvedPipelineId (?pipelineId=standard-pipeline →
 *      'standard-pipeline'). Ownership: owner 200, anon (no bearer) 401.
 *
 *  THE PER-WORK PROMPT SETTINGS — GET/PUT /api/works/:id/advanced-prompts (auth, ownership):
 *    Shape { workId, relevanceAssessment, itemGeneration, itemExtraction, searchQuery,
 *      categorization, deduplication, sourceValidation, updatedAt } (all string|null).
 *    PUT is a true PARTIAL MERGE: setting itemGeneration then searchQuery in separate calls
 *      leaves BOTH set. Empty body {} is a no-op 200.
 *    NORMALIZATION (UpdateWorkAdvancedPromptsDto @Transform sanitizeAndNormalize, MAX 2000):
 *      - leading/trailing whitespace TRIMMED ('  REAL  ' → 'REAL').
 *      - whitespace-only / empty CLEARS the field to null.
 *      - a non-string value coerces to null (NOT a 400).
 *      - an oversized string is TRUNCATED to 2000 chars (NOT a 400).
 *    WHITELIST: an UNKNOWN body key ⇒ 400 (forbidNonWhitelisted). Cross-user GET ⇒ 403.
 *
 *  AUTH / ANON: every surface here is @CurrentUser-guarded ⇒ anonymous (no bearer) = 401.
 *
 * GOTCHAS honored:
 *   - FRESH registerUserViaAPI() user per mutation (cross-spec isolation — never the
 *     shared seeded user). Unique names (Date.now/stamp suffix). Tolerate pre-existing
 *     rows (toContain / scoped filters), never assert global counts.
 *   - NO LLM key / NO Trigger.dev in CI ⇒ we assert only the SELECTION/CONFIG metadata
 *     (the binding + its persisted settings), never generation/run EXECUTION.
 *   - ANON CONTEXT inherits the storageState cookie ⇒ use empty storageState.
 *   - Generous timeouts, .first(), expect.poll, no exact global counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface AgentDto {
    id: string;
    slug: string;
    scope: string;
    workId: string | null;
    missionId: string | null;
    ideaId: string | null;
    name: string;
    status: string;
    aiProviderId: string | null;
    modelId: string | null;
    capabilities: string | null;
    idleBehavior: string;
    heartbeatCadence: string | null;
    maxSkillContextTokens: number;
    pauseAfterFailures: number;
    permissions: Record<string, boolean>;
    targets: Array<{ type: string; id?: string }> | null;
    committerName: string | null;
    committerEmail: string | null;
}

interface GeneratorFormSchema {
    resolvedPipelineId?: string;
    providers?: Record<string, Array<{ id: string; isDefault?: boolean; configured?: boolean }>>;
    pluginFields?: unknown[];
    defaultValues?: Record<string, unknown>;
}

interface AdvancedPrompts {
    workId: string;
    relevanceAssessment: string | null;
    itemGeneration: string | null;
    itemExtraction: string | null;
    searchQuery: string | null;
    categorization: string | null;
    deduplication: string | null;
    sourceValidation: string | null;
    updatedAt: string | null;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const agentsUrl = `${API_BASE}/api/agents`;
const agentUrl = (id: string) => `${agentsUrl}/${id}`;
const generatorFormUrl = (workId: string) => `${API_BASE}/api/works/${workId}/generator-form`;
const advancedPromptsUrl = (workId: string) => `${API_BASE}/api/works/${workId}/advanced-prompts`;

/** Create a work-scoped Agent (the agent-per-work binding). Returns the AgentDto. */
async function createWorkAgent(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: Record<string, unknown>,
): Promise<AgentDto> {
    const res = await request.post(agentsUrl, {
        headers: authedHeaders(token),
        data: { scope: 'work', workId, ...body },
        timeout: 30_000,
    });
    expect(res.status(), `createWorkAgent body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function getAgent(request: APIRequestContext, token: string, id: string): Promise<AgentDto> {
    const res = await request.get(agentUrl(id), { headers: authedHeaders(token), timeout: 30_000 });
    expect(res.status(), `getAgent ${id}`).toBe(200);
    return res.json();
}

async function getAdvancedPrompts(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<AdvancedPrompts> {
    const res = await request.get(advancedPromptsUrl(workId), {
        headers: authedHeaders(token),
        timeout: 30_000,
    });
    expect(res.status(), `getAdvancedPrompts ${workId}`).toBe(200);
    return res.json();
}

async function putAdvancedPrompts(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: Record<string, unknown>,
) {
    return request.put(advancedPromptsUrl(workId), {
        headers: authedHeaders(token),
        data: body,
        timeout: 30_000,
    });
}

test.describe('Settings: work-agent integration (binding + persistence + validation)', () => {
    test('1. agent-per-work binding lifecycle: enable with full AI config, persist, re-bind, then clear', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-bind-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WA Bind Work ${s}`,
            slug: `wa-bind-work-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        // ENABLE: bind a fully-configured agent to this work (provider, model,
        // capabilities, heartbeat, failure cap, a PARTIAL permissions set, committer).
        const agent = await createWorkAgent(request, token, workId, {
            name: `Bind Bot ${s}`,
            aiProviderId: 'openai',
            modelId: 'gpt-4o-mini',
            capabilities: 'Generates + maintains this work',
            heartbeatCadence: 'manual',
            pauseAfterFailures: 3,
            permissions: { canCommitToRepo: true, canSpend: false },
            committerName: 'Bind Bot',
            committerEmail: `bind-bot-${s}@test.local`,
        });

        // The binding is realized: the agent is work-scoped + stamped to THIS work.
        expect(agent.scope).toBe('work');
        expect(agent.workId).toBe(workId);
        expect(agent.missionId).toBeNull();
        expect(agent.ideaId).toBeNull();
        // New agents are born draft (not yet enabled/active).
        expect(agent.status).toBe('draft');

        // The full AI config persisted verbatim.
        expect(agent.aiProviderId).toBe('openai');
        expect(agent.modelId).toBe('gpt-4o-mini');
        expect(agent.capabilities).toBe('Generates + maintains this work');
        expect(agent.heartbeatCadence).toBe('manual');
        expect(agent.pauseAfterFailures).toBe(3);
        expect(agent.committerName).toBe('Bind Bot');
        expect(agent.committerEmail).toBe(`bind-bot-${s}@test.local`);

        // Defaults filled in: idleBehavior 'propose', maxSkillContextTokens 4000.
        expect(agent.idleBehavior).toBe('propose');
        expect(agent.maxSkillContextTokens).toBe(4000);

        // permissions is MERGED with the conservative default — the one flag we
        // set is true, the rest are explicitly false (never undefined).
        expect(agent.permissions.canCommitToRepo).toBe(true);
        expect(agent.permissions.canSpend).toBe(false);
        expect(agent.permissions.canAssignTasks).toBe(false);
        expect(agent.permissions.canOpenPullRequests).toBe(false);

        // RE-BIND: change the provider/model, attach a work TARGET, switch idle
        // behavior + the skill-context budget. Returned DTO reflects the edit.
        const rebindRes = await request.patch(agentUrl(agent.id), {
            headers: authedHeaders(token),
            data: {
                aiProviderId: 'anthropic',
                modelId: 'claude-3-5-sonnet',
                capabilities: 'Rebound to a different provider',
                idleBehavior: 'observe',
                maxSkillContextTokens: 8000,
                targets: [{ type: 'work', id: workId }],
            },
            timeout: 30_000,
        });
        expect(rebindRes.status(), `rebind body=${await rebindRes.text().catch(() => '')}`).toBe(
            200,
        );
        const rebound = (await rebindRes.json()) as AgentDto;
        expect(rebound.aiProviderId).toBe('anthropic');
        expect(rebound.modelId).toBe('claude-3-5-sonnet');
        expect(rebound.idleBehavior).toBe('observe');
        expect(rebound.maxSkillContextTokens).toBe(8000);
        expect(rebound.targets).toEqual([{ type: 'work', id: workId }]);

        // PERSISTENCE round-trip: a fresh GET shows the rebound settings + the
        // unchanged work binding.
        const afterRebind = await getAgent(request, token, agent.id);
        expect(afterRebind.aiProviderId).toBe('anthropic');
        expect(afterRebind.modelId).toBe('claude-3-5-sonnet');
        expect(afterRebind.idleBehavior).toBe('observe');
        expect(afterRebind.maxSkillContextTokens).toBe(8000);
        expect(afterRebind.targets).toEqual([{ type: 'work', id: workId }]);
        expect(afterRebind.workId, 'work binding survives a settings re-bind').toBe(workId);

        // CLEAR the provider/model binding (null) — the agent stays bound to the
        // work but with no pinned AI provider.
        const clearRes = await request.patch(agentUrl(agent.id), {
            headers: authedHeaders(token),
            data: { aiProviderId: null, modelId: null },
            timeout: 30_000,
        });
        expect(clearRes.status()).toBe(200);
        const cleared = await getAgent(request, token, agent.id);
        expect(cleared.aiProviderId, 'provider binding cleared').toBeNull();
        expect(cleared.modelId, 'model binding cleared').toBeNull();
        expect(cleared.workId, 'clearing the provider does not unbind the work').toBe(workId);
    });

    test('2. work-agent config VALIDATION: every bad setting is a 400 and never mutates the persisted binding', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-valid-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WA Valid Work ${s}`,
            slug: `wa-valid-work-${s}`,
        });

        // A known-good baseline binding we will repeatedly try (and fail) to corrupt.
        const agent = await createWorkAgent(request, token, workId, {
            name: `Valid Bot ${s}`,
            aiProviderId: 'openai',
            modelId: 'gpt-4o-mini',
            pauseAfterFailures: 5,
            maxSkillContextTokens: 4000,
            idleBehavior: 'propose',
        });

        // Each entry: a PATCH body the DTO must reject with 400.
        const badPatches: Array<{ label: string; data: Record<string, unknown> }> = [
            { label: 'pauseAfterFailures above the 20 cap', data: { pauseAfterFailures: 99 } },
            { label: 'pauseAfterFailures below the 1 floor', data: { pauseAfterFailures: 0 } },
            {
                label: 'maxSkillContextTokens above the 20000 cap',
                data: { maxSkillContextTokens: 50_000 },
            },
            { label: 'committerEmail not an email', data: { committerEmail: 'not-an-email' } },
            { label: 'idleBehavior not in the enum', data: { idleBehavior: 'banana' } },
            {
                label: 'target type not mission|idea|work|wildcard',
                data: { targets: [{ type: 'galaxy' }] },
            },
            { label: 'name longer than 120 chars', data: { name: 'x'.repeat(130) } },
        ];

        for (const { label, data } of badPatches) {
            const res = await request.patch(agentUrl(agent.id), {
                headers: authedHeaders(token),
                data,
                timeout: 30_000,
            });
            expect(res.status(), `${label} must be rejected`).toBe(400);
        }

        // After ALL the rejected edits, the binding's settings are byte-for-byte intact.
        const after = await getAgent(request, token, agent.id);
        expect(after.aiProviderId).toBe('openai');
        expect(after.modelId).toBe('gpt-4o-mini');
        expect(after.pauseAfterFailures).toBe(5);
        expect(after.maxSkillContextTokens).toBe(4000);
        expect(after.idleBehavior).toBe('propose');
        expect(after.name, 'name unchanged after the rejected over-long edit').toBe(
            `Valid Bot ${s}`,
        );
        expect(after.committerEmail, 'committerEmail never set by a rejected edit').toBeNull();
        expect(after.targets, 'targets never set by a rejected edit').toBeNull();

        // A subsequent VALID edit still goes through (the row is not poisoned).
        const goodRes = await request.patch(agentUrl(agent.id), {
            headers: authedHeaders(token),
            data: { pauseAfterFailures: 7, idleBehavior: 'noop' },
            timeout: 30_000,
        });
        expect(goodRes.status()).toBe(200);
        const good = await getAgent(request, token, agent.id);
        expect(good.pauseAfterFailures).toBe(7);
        expect(good.idleBehavior).toBe('noop');
    });

    test('3. many agents bind to one work, the per-work filter is exact, and a duplicate name is a 409 conflict', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-multi-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        // Two distinct works → bindings must NOT bleed across them.
        const { id: workA } = await createWorkViaAPI(request, token, {
            name: `WA Multi A ${s}`,
            slug: `wa-multi-a-${s}`,
        });
        const { id: workB } = await createWorkViaAPI(request, token, {
            name: `WA Multi B ${s}`,
            slug: `wa-multi-b-${s}`,
        });

        // Bind two distinct-named agents to work A and one to work B.
        const a1 = await createWorkAgent(request, token, workA, { name: `A Builder ${s}` });
        const a2 = await createWorkAgent(request, token, workA, { name: `A Reviewer ${s}` });
        const b1 = await createWorkAgent(request, token, workB, { name: `B Builder ${s}` });
        expect(new Set([a1.id, a2.id, b1.id]).size).toBe(3);

        // A duplicate NAME within the same scope collides on the agent slug ⇒ 409.
        const dup = await request.post(agentsUrl, {
            headers: authedHeaders(token),
            data: { scope: 'work', workId: workA, name: `A Builder ${s}` },
            timeout: 30_000,
        });
        expect(
            dup.status(),
            `duplicate work-agent name body=${await dup.text().catch(() => '')}`,
        ).toBe(409);

        // The per-work filter returns EXACTLY the two work-A agents, never work-B's.
        const listA = await request.get(`${agentsUrl}?scope=work&workId=${workA}`, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(listA.status()).toBe(200);
        const aBody = await listA.json();
        const aIds = (aBody.data as AgentDto[]).map((x) => x.id);
        expect(aIds).toContain(a1.id);
        expect(aIds).toContain(a2.id);
        expect(aIds, 'work-B agent never leaks into the work-A binding list').not.toContain(b1.id);
        expect(aBody.meta.total).toBe(2);
        // Every returned row is genuinely bound to work A.
        expect((aBody.data as AgentDto[]).every((x) => x.workId === workA)).toBe(true);

        const listB = await request.get(`${agentsUrl}?scope=work&workId=${workB}`, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        const bBody = await listB.json();
        expect((bBody.data as AgentDto[]).map((x) => x.id)).toEqual([b1.id]);

        // A filter on an unknown work id is an empty page (not a 4xx) — no binding.
        const listGhost = await request.get(`${agentsUrl}?scope=work&workId=${UNKNOWN_UUID}`, {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(listGhost.status()).toBe(200);
        expect((await listGhost.json()).meta.total).toBe(0);
    });

    test('4. per-work AI-provider binding surface lists configured providers and per-work pipeline selection flips', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-provform-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WA Provider Form ${s}`,
            slug: `wa-prov-form-${s}`,
        });

        // The per-work generator-form is the surface that lists which AI-provider
        // plugins this work can bind to (providers.ai), alongside the pipeline
        // + the other capability categories.
        const baseRes = await request.get(generatorFormUrl(workId), {
            headers: authedHeaders(token),
            timeout: 30_000,
        });
        expect(baseRes.status()).toBe(200);
        const base = (await baseRes.json()) as GeneratorFormSchema;

        // All capability categories present, including the AI-provider binding list.
        expect(Object.keys(base.providers ?? {})).toEqual(
            expect.arrayContaining(['ai', 'pipeline', 'search', 'screenshot', 'contentExtractor']),
        );
        const aiOptions = base.providers?.ai ?? [];
        expect(
            aiOptions.length,
            'at least one AI provider is bindable to the work',
        ).toBeGreaterThanOrEqual(1);
        // Each AI option exposes its binding metadata (an id + a configured flag).
        for (const opt of aiOptions) {
            expect(opt.id, 'AI provider option has an id').toBeTruthy();
            expect(typeof opt.configured, `AI provider ${opt.id} exposes configured flag`).toBe(
                'boolean',
            );
        }
        // In CI the env key configures exactly one provider as the default-bound one.
        const configuredDefault = aiOptions.find((o) => o.isDefault && o.configured);
        expect(
            configuredDefault,
            'exactly one configured AI provider is the work default binding',
        ).toBeTruthy();

        // Per-work PIPELINE selection flips the resolved binding for this work
        // (a settings choice that scopes to the work, not the whole account).
        const switched = await request.get(
            `${generatorFormUrl(workId)}?pipelineId=standard-pipeline`,
            { headers: authedHeaders(token), timeout: 30_000 },
        );
        expect(switched.status()).toBe(200);
        const switchedSchema = (await switched.json()) as GeneratorFormSchema;
        expect(
            switchedSchema.resolvedPipelineId,
            'selecting standard-pipeline binds this work to it',
        ).toBe('standard-pipeline');
        // providers.ai is still resolvable under the alternate pipeline.
        expect(Array.isArray(switchedSchema.providers?.ai)).toBe(true);

        // The provider-binding surface is @CurrentUser-guarded — anon (EMPTY
        // storageState so it does NOT inherit the shared auth cookie) ⇒ 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonRes = await anon.request.get(generatorFormUrl(workId), { timeout: 30_000 });
        expect(anonRes.status(), 'anon per-work provider surface is guarded').toBe(401);
        await anon.close();
    });

    test('5. per-work advanced-prompts settings: partial-merge persistence + trim/clear/truncate normalization + whitelist', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-prompts-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WA Prompts Work ${s}`,
            slug: `wa-prompts-work-${s}`,
        });

        // Fresh work → every per-work prompt setting starts null.
        const initial = await getAdvancedPrompts(request, token, workId);
        expect(initial.workId).toBe(workId);
        expect(initial.itemGeneration).toBeNull();
        expect(initial.searchQuery).toBeNull();
        expect(initial.updatedAt).toBeNull();

        // PARTIAL MERGE across calls: set itemGeneration, then searchQuery —
        // the first MUST survive the second (a true PATCH, not a replace).
        const set1 = await putAdvancedPrompts(request, token, workId, {
            itemGeneration: '  Generate rich items  ',
        });
        expect(set1.status()).toBe(200);
        const set2 = await putAdvancedPrompts(request, token, workId, {
            searchQuery: 'Find directory tools',
        });
        expect(set2.status()).toBe(200);

        const merged = await getAdvancedPrompts(request, token, workId);
        // Surrounding whitespace was TRIMMED on the way in.
        expect(merged.itemGeneration, 'first setting persisted + trimmed').toBe(
            'Generate rich items',
        );
        expect(merged.searchQuery, 'second setting merged, not replacing the first').toBe(
            'Find directory tools',
        );
        expect(merged.updatedAt, 'updatedAt is stamped once a setting is written').toBeTruthy();

        // CLEAR via whitespace-only — the normalizer maps it to null.
        const cleared = await putAdvancedPrompts(request, token, workId, { itemGeneration: '   ' });
        expect(cleared.status()).toBe(200);
        const afterClear = await getAdvancedPrompts(request, token, workId);
        expect(afterClear.itemGeneration, 'whitespace-only clears the setting').toBeNull();
        expect(afterClear.searchQuery, 'the OTHER setting is untouched by the clear').toBe(
            'Find directory tools',
        );

        // OVERSIZED values are TRUNCATED to 2000 (a real normalization, NOT a 400).
        const big = await putAdvancedPrompts(request, token, workId, {
            categorization: 'A'.repeat(3000),
        });
        expect(big.status()).toBe(200);
        const afterBig = await getAdvancedPrompts(request, token, workId);
        expect(afterBig.categorization?.length, 'oversized prompt truncated to the 2000 cap').toBe(
            2000,
        );

        // Empty body is a no-op 200 that leaves the settings intact.
        const noop = await putAdvancedPrompts(request, token, workId, {});
        expect(noop.status()).toBe(200);
        const afterNoop = await getAdvancedPrompts(request, token, workId);
        expect(afterNoop.searchQuery).toBe('Find directory tools');
        expect(afterNoop.categorization?.length).toBe(2000);

        // WHITELIST: an unknown key is a 400 — you cannot smuggle arbitrary
        // fields into the per-work settings via this endpoint.
        const unknown = await putAdvancedPrompts(request, token, workId, { bogusField: 'x' });
        expect(unknown.status(), 'unknown settings key is rejected by the whitelist').toBe(400);
    });

    test('6. work-agent + per-work settings are ownership-scoped: foreign reads/writes are denied, anon is 401', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request, {
            email: `e2e-wa-iso-${Date.now()}@test.local`,
        });
        const token = owner.access_token;
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WA Iso Work ${s}`,
            slug: `wa-iso-work-${s}`,
        });
        const agent = await createWorkAgent(request, token, workId, {
            name: `Iso Bot ${s}`,
            aiProviderId: 'openai',
        });
        // Seed a per-work prompt setting so the owner-read is non-empty.
        expect(
            (
                await putAdvancedPrompts(request, token, workId, { itemGeneration: 'owned' })
            ).status(),
        ).toBe(200);

        // A DIFFERENT authenticated user.
        const intruder = await registerUserViaAPI(request, {
            email: `e2e-wa-intruder-${Date.now()}@test.local`,
        });
        const atk = authedHeaders(intruder.access_token);

        // Foreign PATCH of the work-agent config ⇒ 404 (existence is not leaked as 403).
        const foreignPatch = await request.patch(agentUrl(agent.id), {
            headers: atk,
            data: { aiProviderId: 'hijack' },
            timeout: 30_000,
        });
        expect(foreignPatch.status(), 'foreign agent config write denied').toBe(404);

        // Foreign read of the agent budget surface ⇒ 404 as well.
        const foreignBudget = await request.get(`${agentUrl(agent.id)}/budget`, {
            headers: atk,
            timeout: 30_000,
        });
        expect(foreignBudget.status(), 'foreign agent budget read denied').toBe(404);

        // Foreign read of the per-work prompt settings ⇒ 403 (work ownership guard).
        const foreignPrompts = await request.get(advancedPromptsUrl(workId), {
            headers: atk,
            timeout: 30_000,
        });
        expect(
            [403, 404],
            `foreign per-work prompts denied (got ${foreignPrompts.status()})`,
        ).toContain(foreignPrompts.status());

        // The owner can still read both — the denials above are scope, not corruption.
        const ownerAgent = await getAgent(request, token, agent.id);
        expect(ownerAgent.aiProviderId, 'owner config un-hijacked').toBe('openai');
        const ownerPrompts = await getAdvancedPrompts(request, token, workId);
        expect(ownerPrompts.itemGeneration).toBe('owned');

        // ANON (empty storageState so the shared auth cookie is NOT inherited):
        // every work-agent settings surface is @CurrentUser-guarded ⇒ 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonTargets: Array<{ label: string; url: string }> = [
            { label: 'agents list', url: agentsUrl },
            { label: 'agent get', url: agentUrl(agent.id) },
            { label: 'per-work generator-form', url: generatorFormUrl(workId) },
            { label: 'per-work advanced-prompts', url: advancedPromptsUrl(workId) },
        ];
        for (const { label, url } of anonTargets) {
            const res = await anon.request.get(url, { timeout: 30_000 });
            expect(res.status(), `anon GET ${label} is 401`).toBe(401);
        }
        await anon.close();
    });
});
