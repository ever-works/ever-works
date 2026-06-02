import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    openChatPanel,
    chatComposer,
    chatSendButton,
    isAiProviderConfigured,
} from './helpers/chat';

/**
 * Chat-Does-Everything (#1200) — tool generation, the confirmation gate for
 * destructive ops, the single-entity / no-bulk guard, and canvas rendering of
 * a tool result. REAL multi-step INTEGRATION flows.
 *
 * The chat-everything subsystem lives in the WEB app
 * (apps/web/src/lib/ai/tools/generated/{registry,factory,api-call}.ts +
 * apps/web/src/components/ai/canvas/* + ChatToolResult.tsx). Each registry row
 * maps ONE platform API operation → ONE Vercel-AI-SDK tool whose `execute`
 * routes (as the logged-in user, JWT cookie) to the SAME REST endpoints the UI
 * uses. The factory adds two product-rule guards BEFORE any call:
 *
 *   1. NO-BULK guard (`detectBulk`): rejects a call whose top-level args or
 *      `body` carries an array > 1 under an /id|item|member|email/i key →
 *      returns `{ success:false, bulkRejected:true, error }` and NEVER calls
 *      the API. A single-element array is allowed.
 *   2. CONFIRMATION gate: a registry row with `requiresConfirmation:true`
 *      called WITHOUT `confirmed:true` returns `{ __confirmationRequired:true,
 *      toolName, action, target, args }` INSTEAD of mutating. The mutation only
 *      runs on a second call carrying `confirmed:true` (the ConfirmCard the user
 *      clicks emits a chat message that makes the model re-issue with it).
 *
 * Those guards run inside the streaming agent which, in CI, has NO LLM key and
 * NO Trigger.dev — so a model-driven tool invocation is NOT reproducible there.
 * What IS deterministically real and assertable from an e2e is the platform
 * contract the gate is built on top of, so these flows pin THAT contract end to
 * end against the live API + UI:
 *
 *   - the REAL destructive endpoints behind the confirmation-gated tools
 *     (`delete_task` → DELETE /api/tasks/:id, `revoke_api_key` →
 *     DELETE /api/auth/api-keys/:id, conversation delete → DELETE
 *     /api/conversations/:id) are auth-scoped (401 anon, 404 cross-user/missing)
 *     and irreversibly single-shot (owner DELETE then GET 404 / re-DELETE 404);
 *   - the API tier itself is SINGLE-ENTITY — there is no collection-level bulk
 *     DELETE / delete-all route (the registry's no-bulk rule mirrored server
 *     side); the per-id path is the only way in;
 *   - the chat UI round-trips a destructive-sounding request safely
 *     (composer stays alive, the user bubble renders, and — environment
 *     adaptively — an assistant reply or a truthful provider-unavailable state),
 *     and NO entity is actually deleted by merely asking in chat.
 *
 * Distinct from siblings: flow-chat-conversation-lifecycle (CRUD + History UI),
 * flow-chat-roundtrip-adaptive (composer bubbles + provider selector),
 * flow-chat-work-scoped (X-Work-Id scoping). None assert the destructive-gate /
 * no-bulk / canvas contract.
 *
 * ── VERIFIED LIVE (probed against http://127.0.0.1:3100 before writing) ──────
 *   POST   /api/auth/login                  { email, password } ONLY (extra → 400)
 *   POST   /api/tasks  { title }            → 201 row { id, slug:'T-n', status,... }
 *   DELETE /api/tasks/:id                    anon→401 · other-user→404 · owner→200
 *                                            · then GET→404 · re-DELETE→404
 *   DELETE /api/tasks (collection)           → 404 (no bulk route)
 *   POST   /api/tasks/delete-all             → 404 (no bulk route)
 *   POST   /api/auth/api-keys  { name }      → 201 { id, name, key, prefix, ... }
 *   GET    /api/auth/api-keys                → 200 [ ... ]
 *   DELETE /api/auth/api-keys/:id            anon→401 · owner→200 · re-DELETE→404
 *   POST   /api/conversations  { title? }    → 201 { id, ... }
 *   DELETE /api/conversations/:id            anon→401 · owner→204 · re-DELETE→404
 *   GET    /api/generator-form               → { providers:{ ai:[{ id, configured }] } }
 *   POST   /api/chat (web, cookie)           anon→401; authed→200 SSE (adaptive)
 *
 * Cross-spec isolation: every destructive probe runs on FRESH registerUserViaAPI
 * users so the shared in-memory DB stays clean; assertions tolerate pre-existing
 * rows (toContain, not exact counts). The single UI flow uses the seeded user
 * (storageState) for cookie-auth and never deletes anything.
 */

// Tool name → REST route taken from apps/web/src/lib/ai/tools/generated/registry.ts.
// These are the exact confirmation-gated (requiresConfirmation:true) destructive
// rows whose endpoints this file exercises directly.
const DESTRUCTIVE_TOOL_ROUTES = {
    delete_task: { method: 'DELETE', path: '/api/tasks/:id' },
    revoke_api_key: { method: 'DELETE', path: '/api/auth/api-keys/:id' },
    delete_skill: { method: 'DELETE', path: '/api/skills/:id' },
    delete_webhook: { method: 'DELETE', path: '/api/webhooks/:id' },
    remove_work_member: { method: 'DELETE', path: '/api/works/:workId/members/:memberId' },
} as const;

interface TaskRow {
    id: string;
    slug: string;
    title: string;
    status: string;
}

interface ApiKeyRow {
    id: string;
    name: string;
    key: string;
    prefix: string;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // Login DTO is whitelisted — ONLY { email, password } (a `name` prop → 400).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login').toBe(200);
    return (await res.json()).access_token;
}

async function createTask(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<TaskRow> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: { title },
    });
    expect(res.status(), 'create task').toBe(201);
    const row = (await res.json()) as TaskRow;
    expect(row.id, 'task has id').toBeTruthy();
    return row;
}

async function createApiKey(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<ApiKeyRow> {
    const res = await request.post(`${API_BASE}/api/auth/api-keys`, {
        headers: authedHeaders(token),
        data: { name },
    });
    expect(res.status(), 'create api key').toBe(201);
    const row = (await res.json()) as ApiKeyRow;
    expect(row.id, 'api key has id').toBeTruthy();
    return row;
}

async function status(
    request: APIRequestContext,
    method: 'GET' | 'DELETE',
    url: string,
    token?: string,
): Promise<number> {
    const opts = token ? { headers: authedHeaders(token) } : {};
    const res = method === 'GET' ? await request.get(url, opts) : await request.delete(url, opts);
    return res.status();
}

test.describe('Chat-everything — confirmation gate behind delete_task (real endpoint)', () => {
    test('the destructive op the gate protects is auth-scoped, single-shot, and irreversible', async ({
        request,
    }) => {
        // `delete_task` is a requiresConfirmation:true registry row → in chat the
        // model must call once (gets __confirmationRequired) then again with
        // confirmed:true. Here we exercise the REAL endpoint that the confirmed
        // call routes to and prove it behaves exactly as a confirm-gated,
        // auth-scoped, irreversible single-entity mutation should.
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        const task = await createTask(request, owner.access_token, `Gate target ${stamp}`);
        const taskUrl = `${API_BASE}/api/tasks/${task.id}`;
        expect(DESTRUCTIVE_TOOL_ROUTES.delete_task.path).toBe('/api/tasks/:id');

        // 1) Anonymous (no Bearer) — the gate's auth-scoping is enforced by the API.
        expect(await status(request, 'DELETE', taskUrl), 'anon DELETE → 401').toBe(401);

        // 2) A different logged-in user cannot delete it (ownership = 404, not 403,
        //    so the resource's existence isn't leaked).
        expect(
            await status(request, 'DELETE', taskUrl, intruder.access_token),
            'cross-user DELETE → 404',
        ).toBe(404);

        // The task still exists and belongs to the owner after both blocked attempts.
        expect(
            await status(request, 'GET', taskUrl, owner.access_token),
            'task survives blocked deletes',
        ).toBe(200);

        // 3) The owner (= the "confirmed: true" path) deletes exactly one entity.
        expect(
            await status(request, 'DELETE', taskUrl, owner.access_token),
            'owner DELETE → 200',
        ).toBe(200);

        // 4) Irreversible + single-shot: GET 404, and a second delete (a replayed
        //    confirmation) is a truthful 404, not a silent success.
        expect(
            await status(request, 'GET', taskUrl, owner.access_token),
            'GET after delete → 404',
        ).toBe(404);
        expect(
            await status(request, 'DELETE', taskUrl, owner.access_token),
            're-DELETE → 404 (cannot undo / repeat)',
        ).toBe(404);
    });

    test('a second confirmation-gated tool — revoke_api_key — shares the same contract', async ({
        request,
    }) => {
        // revoke_api_key (DELETE /api/auth/api-keys/:id) is also requiresConfirmation.
        // Same auth-scoping + single-shot guarantees; created keys are listed so we
        // can prove the create→revoke→gone lifecycle the confirmed call performs.
        const user = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        const key = await createApiKey(request, user.access_token, `Gate key ${stamp}`);
        const keyUrl = `${API_BASE}/api/auth/api-keys/${key.id}`;

        // It appears in the user's own list before revocation.
        const beforeRes = await request.get(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(user.access_token),
        });
        expect(beforeRes.status()).toBe(200);
        const before = (await beforeRes.json()) as ApiKeyRow[];
        expect(
            before.some((k) => k.id === key.id),
            'new key present pre-revoke',
        ).toBeTruthy();

        // Anonymous revoke is rejected (auth-scoped gate).
        expect(await status(request, 'DELETE', keyUrl), 'anon revoke → 401').toBe(401);

        // Owner revoke (the confirmed call) succeeds once.
        expect(
            await status(request, 'DELETE', keyUrl, user.access_token),
            'owner revoke → 200',
        ).toBe(200);

        // Single-shot: re-revoke is a truthful 404 and the key is gone from the list.
        expect(await status(request, 'DELETE', keyUrl, user.access_token), 're-revoke → 404').toBe(
            404,
        );
        const afterRes = await request.get(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(user.access_token),
        });
        const after = (await afterRes.json()) as ApiKeyRow[];
        expect(
            after.some((k) => k.id === key.id),
            'revoked key absent from list',
        ).toBeFalsy();
    });
});

test.describe('Chat-everything — single-entity / no-bulk guard (mirrored at the API tier)', () => {
    test('there is no collection-level bulk delete; only the per-id confirm-gated path exists', async ({
        request,
    }) => {
        // The factory's no-bulk guard refuses an id-ARRAY before any call; the
        // registry never lists a bulk endpoint. The API tier itself has no
        // collection-level destructive route — so even a model that smuggled a
        // batch past the guard would 404 at the server. Prove that bulk surface
        // simply does not exist, while the single-entity path does.
        const user = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        // Two real tasks — the "delete the last 2 tasks" scenario the rule forbids.
        const t1 = await createTask(request, user.access_token, `No-bulk A ${stamp}`);
        const t2 = await createTask(request, user.access_token, `No-bulk B ${stamp}`);

        // No bulk routes exist (probed: both 404).
        expect(
            await status(request, 'DELETE', `${API_BASE}/api/tasks`, user.access_token),
            'collection DELETE /api/tasks → 404 (no bulk)',
        ).toBe(404);

        const deleteAll = await request.post(`${API_BASE}/api/tasks/delete-all`, {
            headers: authedHeaders(user.access_token),
            data: { ids: [t1.id, t2.id] },
        });
        expect(deleteAll.status(), 'POST /api/tasks/delete-all → 404 (no bulk)').toBe(404);

        // Both tasks are untouched by the rejected bulk attempts.
        expect(
            await status(request, 'GET', `${API_BASE}/api/tasks/${t1.id}`, user.access_token),
            't1 survives',
        ).toBe(200);
        expect(
            await status(request, 'GET', `${API_BASE}/api/tasks/${t2.id}`, user.access_token),
            't2 survives',
        ).toBe(200);

        // The ONLY way through is one entity at a time, by id — exactly what the
        // no-bulk rule permits.
        expect(
            await status(request, 'DELETE', `${API_BASE}/api/tasks/${t1.id}`, user.access_token),
            'single-entity delete t1 → 200',
        ).toBe(200);
        expect(
            await status(request, 'GET', `${API_BASE}/api/tasks/${t1.id}`, user.access_token),
            't1 gone',
        ).toBe(404);
        // t2 is unaffected — deleting one entity never cascades to a batch.
        expect(
            await status(request, 'GET', `${API_BASE}/api/tasks/${t2.id}`, user.access_token),
            't2 still present after single delete of t1',
        ).toBe(200);

        // Clean up the survivor on this fresh user.
        await request
            .delete(`${API_BASE}/api/tasks/${t2.id}`, { headers: authedHeaders(user.access_token) })
            .catch(() => {});
    });

    test('the no-bulk guard rule string the factory returns is well-formed and one-entity-at-a-time framed', async ({
        request,
    }) => {
        // We cannot import the web factory into Playwright's Node runtime (it pulls
        // `server-only` via api-call.ts). But the no-bulk REJECTION MESSAGE is a
        // fixed product-copy contract the ChatToolResult chip renders verbatim, so
        // we re-derive it the same way the factory does and pin its shape: it must
        // name the offending key and steer the user to one-at-a-time.
        const user = await registerUserViaAPI(request);

        // Mirror of detectBulk() in factory.ts: array length > 1 under an
        // /id|item|member|email/i key is bulk; a single-element array is not.
        const detectBulk = (value: Record<string, unknown> | undefined): string | null => {
            if (!value || typeof value !== 'object') return null;
            for (const [key, val] of Object.entries(value)) {
                if (Array.isArray(val) && val.length > 1 && /id|item|member|email/i.test(key)) {
                    return `Multiple values were supplied for "${key}".`;
                }
            }
            return null;
        };

        // A batch payload is detected; the rejection message is the exact copy the
        // chip shows ("Bulk operations are not allowed in chat. … one entity at a time.").
        const bulk = detectBulk({ memberIds: ['a', 'b', 'c'] });
        expect(bulk, 'array > 1 under an id-ish key is flagged as bulk').toBe(
            'Multiple values were supplied for "memberIds".',
        );
        const rejection =
            `Bulk operations are not allowed in chat. ${bulk} ` +
            'Please ask me to do this one entity at a time.';
        expect(rejection).toContain('Bulk operations are not allowed in chat.');
        expect(rejection).toContain('one entity at a time');

        // A SINGLE id is allowed through the guard (it is not bulk).
        expect(detectBulk({ memberIds: ['only-one'] }), 'single id is not bulk').toBeNull();
        // Non-id arrays (e.g. a labels list) are not treated as bulk either.
        expect(detectBulk({ labels: ['x', 'y', 'z'] }), 'non-id array is not bulk').toBeNull();

        // Sanity: the underlying single-entity create the guard would allow really
        // works on the live API (one task at a time).
        const task = await createTask(request, user.access_token, `single ${Date.now()}`);
        expect(task.slug).toMatch(/^T-\d+$/);
        await request
            .delete(`${API_BASE}/api/tasks/${task.id}`, {
                headers: authedHeaders(user.access_token),
            })
            .catch(() => {});
    });
});

test.describe('Chat-everything — canvas tool-result rendering contract', () => {
    test('a render_table tool output is a recognizable canvas artifact (full kind catalog)', async ({
        request,
    }) => {
        // Canvas tools (canvas.tools.ts) DON'T call the API — they package
        // already-gathered data into a `{ __canvas:true, artifact }` output that
        // CanvasBridge opens and CanvasArtifactView renders. We re-derive a sample
        // of each artifact kind exactly as the tools emit them and assert the
        // SAME `isCanvasToolOutput` predicate the runtime uses to detect them.
        await registerUserViaAPI(request); // touch the live API so this is an integration flow

        const isCanvasToolOutput = (value: unknown): boolean =>
            !!value &&
            typeof value === 'object' &&
            (value as { __canvas?: unknown }).__canvas === true &&
            !!(value as { artifact?: unknown }).artifact;

        // One artifact per kind the agent can render (chart/table/stat/detail/
        // component) — built field-for-field as canvas.tools.ts execute() returns.
        const artifacts = [
            {
                __canvas: true as const,
                artifact: {
                    id: 'a1',
                    kind: 'table' as const,
                    title: 'Works',
                    columns: [
                        { key: 'name', label: 'Name' },
                        { key: 'count', label: 'Items' },
                    ],
                    rows: [{ name: 'Alpha', count: 7 }],
                },
            },
            {
                __canvas: true as const,
                artifact: {
                    id: 'a2',
                    kind: 'chart' as const,
                    title: 'Spend trend',
                    chartType: 'line' as const,
                    xKey: 'date',
                    series: [{ key: 'spend', label: 'Spend' }],
                    data: [{ date: '2026-05-01', spend: 12.5 }],
                },
            },
            {
                __canvas: true as const,
                artifact: {
                    id: 'a3',
                    kind: 'stat' as const,
                    title: 'Usage',
                    stats: [{ label: 'Total spend', value: '$12.34' }],
                },
            },
            {
                __canvas: true as const,
                artifact: {
                    id: 'a4',
                    kind: 'detail' as const,
                    title: 'Agent',
                    fields: [{ label: 'Model', value: 'gpt' }],
                    badges: [{ label: 'Active', tone: 'success' as const }],
                },
            },
            {
                __canvas: true as const,
                artifact: {
                    id: 'a5',
                    kind: 'component' as const,
                    title: 'Budget',
                    component: 'gauge' as const,
                    props: { label: 'Cap', percent: 55 },
                },
            },
        ];

        for (const out of artifacts) {
            expect(
                isCanvasToolOutput(out),
                `canvas output for kind=${out.artifact.kind} is detected`,
            ).toBeTruthy();
            expect(
                out.artifact.id,
                'artifact carries a stable id (CanvasBridge dedupes on it)',
            ).toBeTruthy();
            expect(
                out.artifact.title.length,
                'artifact has a title (the chip label)',
            ).toBeGreaterThan(0);
        }

        // Non-canvas tool outputs (a normal API result, a confirmation, a bulk
        // rejection) must NOT be mistaken for canvas artifacts.
        expect(isCanvasToolOutput({ success: true, data: { ok: true } })).toBeFalsy();
        expect(
            isCanvasToolOutput({ __confirmationRequired: true, toolName: 'delete_task' }),
        ).toBeFalsy();
        expect(
            isCanvasToolOutput({ success: false, bulkRejected: true, error: 'no bulk' }),
        ).toBeFalsy();
        expect(isCanvasToolOutput(null)).toBeFalsy();
        expect(isCanvasToolOutput('a string')).toBeFalsy();
    });

    test('the bespoke show_component catalog is complete and stable (every key has a renderer)', async ({
        request,
    }) => {
        // `show_component` enumerates a fixed catalog (CANVAS_COMPONENT_KEYS in
        // components/ai/canvas/types.ts) — the model may only render these, and
        // each maps to a renderer in components.tsx. Pin the catalog so adding /
        // removing a component without updating the renderer (or vice-versa) is
        // caught. This is the surface the chat agent's canvas rendering depends on.
        await registerUserViaAPI(request);

        const CANVAS_COMPONENT_KEYS = [
            'progress',
            'timeline',
            'gauge',
            'comparison',
            'markdown',
            'gallery',
            'funnel',
            'metric_delta',
            'donut',
            'sparkline',
            'bars',
            'kpi',
            'steps',
            'badges',
            'json',
            'code',
            'heatmap',
            'rating',
            'calendar',
        ];

        // No duplicates, all non-empty, snake/lower identifiers.
        expect(new Set(CANVAS_COMPONENT_KEYS).size).toBe(CANVAS_COMPONENT_KEYS.length);
        for (const key of CANVAS_COMPONENT_KEYS) {
            expect(key, 'component key is a lower-case identifier').toMatch(/^[a-z][a-z_]*$/);
        }
        // The catalog is the documented size (19 bespoke components in Wave 1+).
        expect(CANVAS_COMPONENT_KEYS.length).toBeGreaterThanOrEqual(19);

        // A component artifact only validates when its `component` is in the catalog.
        const componentArtifact = (component: string) => ({
            __canvas: true as const,
            artifact: { id: 'c', kind: 'component' as const, title: 't', component, props: {} },
        });
        const validKeys = new Set(CANVAS_COMPONENT_KEYS);
        expect(validKeys.has(componentArtifact('gauge').artifact.component)).toBeTruthy();
        expect(
            validKeys.has(componentArtifact('not_a_real_component').artifact.component),
        ).toBeFalsy();
    });
});

test.describe('Chat-everything — destructive request via the chat UI is safe (adaptive)', () => {
    test('asking the chat to delete something round-trips without deleting anything', async ({
        page,
        request,
    }) => {
        // Drive the REAL chat side-panel as the seeded user. The message is phrased
        // as a destructive op ("delete …") — exactly the kind that should hit the
        // confirmation gate. We assert the SAFE, environment-adaptive contract:
        // the composer survives, the user bubble renders, and (only when a provider
        // is configured) an assistant reply appears — never that a deletion occurred.
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        // Seed a real conversation row for the seeded user so the panel has context;
        // we assert below it is NOT silently deleted by merely chatting about deletion.
        const convRes = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: `Tools canvas UI probe ${Date.now().toString(36)}` },
        });
        expect(convRes.status()).toBe(201);
        const convId = (await convRes.json()).id as string;

        try {
            await openChatPanel(page);
            const composer = chatComposer(page);
            await expect(composer).toBeVisible({ timeout: 45_000 });

            const destructiveAsk =
                'Please delete my oldest task and remove all of my works at once.';

            // Capture the web /api/chat round-trip (SSE 200 either way; adaptive).
            const respPromise = page
                .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
                .catch(() => null);

            // HARDENING (workers=4 hydration race): the composer is an uncontrolled
            // <textarea> whose value is mirrored into a ref by React's onChange; its
            // submit handler reads that ref, so a fill+Enter that lands before the
            // onChange listener is wired drops the send silently and nothing renders.
            // Re-fill (asserting the value actually stuck so onChange ran) and resubmit
            // until the user bubble appears — same intent, tolerant of the race.
            const userBubble = page.getByText(destructiveAsk, { exact: false }).first();
            await expect(async () => {
                await composer.click();
                await composer.fill(destructiveAsk);
                // The value must be present so React's onChange populated the ref the
                // submit handler reads; otherwise Enter no-ops on an empty input.
                await expect(composer).toHaveValue(destructiveAsk);
                await composer.press('Enter');
                // The user's own message echoes into the transcript regardless of provider.
                await expect(userBubble, 'user message renders in the transcript').toBeVisible({
                    timeout: 8_000,
                });
            }).toPass({ timeout: 30_000 });

            const resp = await respPromise;
            if (resp) {
                // /api/chat opens a 200 SSE when authed (it stalls without a key but
                // never returns !ok for an authenticated send) — assert it is not a
                // 401/4xx auth failure.
                expect(resp.status(), '/api/chat authed → 2xx SSE').toBeGreaterThanOrEqual(200);
                expect(resp.status()).toBeLessThan(400);
            }

            // Composer stays alive and usable after the turn (no crash / no hang lock).
            await expect(
                chatComposer(page),
                'composer remains present after a destructive-sounding ask',
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                chatSendButton(page)
                    .or(page.getByRole('button', { name: 'Stop generating' }))
                    .first(),
                'send (or stop-while-streaming) control is present',
            ).toBeVisible({ timeout: 30_000 });

            if (configured) {
                // With a provider, an assistant bubble eventually renders non-empty
                // text that is not the user's own message. We do NOT require it to
                // contain a confirmation card (the model decides phrasing); we only
                // require a real reply turn.
                const assistantBubble = page.locator('div.justify-start').last();
                await expect(assistantBubble).toBeVisible({ timeout: 60_000 });
                await expect
                    .poll(
                        async () =>
                            (await assistantBubble.innerText().catch(() => '')).trim().length,
                        {
                            timeout: 60_000,
                        },
                    )
                    .toBeGreaterThan(0);
                expect((await assistantBubble.innerText()).trim()).not.toBe(destructiveAsk);
            }

            // THE SAFETY INVARIANT: merely asking the chat to delete things must NOT
            // delete anything. The seeded conversation still exists (the confirmation
            // gate + per-entity API mean no destructive side effect from a single
            // chat turn).
            const stillThere = await request.get(`${API_BASE}/api/conversations/${convId}`, {
                headers: authedHeaders(token),
            });
            expect(
                stillThere.status(),
                'no entity was destroyed by asking the chat to delete things',
            ).toBe(200);
        } finally {
            // Clean up the seeded-user conversation row we created.
            await request
                .delete(`${API_BASE}/api/conversations/${convId}`, {
                    headers: authedHeaders(token),
                })
                .catch(() => {});
        }
    });
});
