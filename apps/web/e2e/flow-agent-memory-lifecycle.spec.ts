import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Agent-memory capability — REST lifecycle, ownership/IDOR gates, scoping and
 * input-validation contracts for `AgentMemoryController`
 * (`apps/api/src/plugins-capabilities/agent-memory/agent-memory.controller.ts`,
 * mounted at `/api/agent-memory`, JWT-guarded by `AuthSessionGuard`).
 *
 * GREENFIELD: this controller had ZERO e2e coverage before this file. Sibling
 * `flow-agent-budget-enforcement.spec.ts` covers per-agent/owner/account BUDGET
 * reads (a different controller) — there is no overlap. The api-side
 * `agent-memory.controller.spec.ts` is a NestJS unit test with a mocked facade;
 * this file pins the LIVE HTTP contract end-to-end.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING.
 *
 * ENVIRONMENT-ADAPTIVE NOTE (load-bearing): the e2e stack is KEYLESS — NO
 * agent-memory provider plugin is enabled. `isConfigured()` is true (the
 * capability is registered) but `getDefaultProvider()` resolves to null, so:
 *   - GET  /check-availability  -> 200 { status:'success', available:true,
 *                                         activeProvider:null }  (the ONE op
 *                                         that succeeds keyless).
 *   - EVERY facade-backed op (openSession / save / search / context /
 *     listSessions / closeSession / deleteEntry) throws `NoProviderError` at
 *     the facade and the controller maps it to:
 *       400 { status:'error',
 *             message:'No agent-memory provider is enabled. Install + enable an
 *                      agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).',
 *             operation:<handlerName> }
 *     where <handlerName> is the facade method: 'openSession' | 'saveMemory' |
 *     'searchMemory' | 'buildContext' | 'listSessions' | 'closeSession' |
 *     'deleteEntry'.
 * Because completions are impossible keyless, this spec asserts the ERROR
 * CONTRACTS, the AUTH gate, the OWNERSHIP/IDOR gates and the VALIDATION DTO
 * bounds — NOT provider-backed create/list/delete round-trips (which cannot run
 * here and would be vacuous). That is the deterministic, real surface.
 *
 * GATE ORDERING (probed): the controller runs `WorkOwnershipService` BEFORE the
 * facade, so a `workId` access failure pre-empts the no-provider 400:
 *   - Authn (AuthSessionGuard) ........ no/!valid bearer  -> 401 Unauthorized
 *   - DTO ValidationPipe .............. malformed body/query -> 400 (array msg)
 *   - Work access (when workId given) . non-owner Work     -> 403 'You do not
 *                                          have permission to access this work'
 *                                       nonexistent Work    -> 404 "Work with id
 *                                          '<uuid>' not found"
 *   - Facade (no provider) ............ owner / no-workId   -> 400 NoProvider
 * Reads + Open + Save use `ensureCanView`; the id-addressed MUTATIONS
 * (`POST /sessions/:id/close`, `DELETE /entries/:id`) use `ensureCanEdit`
 * (EW-711 #29 owner-stamp IDOR defense). In this build a Work's creator is its
 * sole owner with BOTH view + edit, and a stranger has NEITHER, so the 403/404
 * split is identical across the view/edit handlers here.
 *
 * VALIDATION BOUNDS (probed against the DTOs):
 *   - save:    content required (string, <=64000); tags each <=128;
 *              metadata must serialise <= 8192 bytes (8 KiB DoS cap);
 *              workId must be a UUID.
 *   - search:  query required (string, <=2000); limit 1..100.
 *   - context: maxTokens 100..64000.
 *   - sessions(list): limit 1..100 (string query coerced via @Type(Number)).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ISOLATION: every test registers FRESH users via registerUserViaAPI() (no
 * shared seeded user). Anonymous calls use the raw `request` fixture with NO
 * Authorization header (Playwright's `request` carries no app cookies/storage),
 * so they exercise the true unauth path. Unique suffixes derive from the
 * per-test title (TITLE_COUNTER), never a module-scope clock.
 */

const AM = `${API_BASE}/api/agent-memory`;
const FAKE_WORK_UUID = '99999999-9999-4999-8999-999999999999';
const NO_PROVIDER_MSG =
    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).';
const FOREIGN_WORK_MSG = 'You do not have permission to access this work';

/** Per-test unique suffix WITHOUT calling a clock at module scope. */
let TITLE_COUNTER = 0;
function uniq(title: string): string {
    TITLE_COUNTER += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${TITLE_COUNTER}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

interface NoProviderBody {
    status: string;
    message: string;
    operation: string;
}

/** Assert a response is the keyless no-provider 400 for the given facade op. */
async function expectNoProvider(res: APIResponse, operation: string): Promise<void> {
    expect(res.status(), `expected 400 no-provider for ${operation}`).toBe(400);
    const body = (await res.json()) as NoProviderBody;
    expect(body.status).toBe('error');
    expect(body.message).toBe(NO_PROVIDER_MSG);
    expect(body.operation, `operation tag should be ${operation}`).toBe(operation);
}

/** Pull the ValidationPipe `message` array out of a 400 body (best-effort). */
async function validationMessages(res: APIResponse): Promise<string[]> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return Array.isArray(body.message) ? (body.message as string[]) : [];
}

test.describe('Flow: agent-memory availability + auth gate', () => {
    test('check-availability is the only keyless-success read; reports registered-but-unconfigured', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // ── Step 1: availability is the ONE op that resolves without a provider —
        //    the capability is registered (available:true) but no plugin is
        //    configured for this user, so the active provider is null. This is the
        //    keyless steady state the whole rest of the surface degrades from.
        const res = await request.get(`${AM}/check-availability`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
            status: string;
            available: boolean;
            activeProvider: unknown;
        };
        expect(body.status).toBe('success');
        expect(body.available, 'capability registered → available true').toBe(true);
        expect(body.activeProvider, 'keyless → no resolved provider').toBeNull();
    });

    test('every agent-memory endpoint rejects anonymous callers with 401', async ({ request }) => {
        // The raw `request` fixture carries no app auth — exercise the true unauth
        // path across the read, mutation and id-addressed surfaces. Authn (the
        // guard) runs BEFORE validation/ownership/facade, so even malformed bodies
        // surface as 401 here, not 400.
        const anon: Array<[string, Promise<APIResponse>]> = [
            ['GET check-availability', request.get(`${AM}/check-availability`)],
            ['GET sessions', request.get(`${AM}/sessions`)],
            ['POST sessions', request.post(`${AM}/sessions`, { data: {} })],
            ['POST save', request.post(`${AM}/save`, { data: { content: 'x' } })],
            ['POST search', request.post(`${AM}/search`, { data: { query: 'x' } })],
            ['POST context', request.post(`${AM}/context`, { data: {} })],
            ['POST sessions/:id/close', request.post(`${AM}/sessions/sid/close`)],
            ['DELETE entries/:id', request.delete(`${AM}/entries/eid`)],
        ];
        for (const [label, p] of anon) {
            const res = await p;
            expect(res.status(), `${label} unauth → 401`).toBe(401);
            const body = (await res.json()) as { statusCode?: number; message?: string };
            expect(body.statusCode).toBe(401);
            expect(body.message).toBe('Unauthorized');
        }
    });
});

test.describe('Flow: agent-memory lifecycle (keyless) — open/save/search/context/list degrade to no-provider', () => {
    test('the full unscoped lifecycle returns the no-provider 400 tagged with each facade operation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const project = uniq('proj');

        // The intended lifecycle is open-session → save observation → search/build
        // context → list sessions → close/forget. Keyless, EVERY facade hop is a
        // tagged no-provider 400. We pin the per-handler `operation` tag so a
        // future regression that mis-routes one handler (e.g. save → searchMemory)
        // is caught even though the HTTP status is identical.

        // ── Step 1: open a session (valid body) → 'openSession'.
        await expectNoProvider(
            await request.post(`${AM}/sessions`, {
                headers: authedHeaders(u.access_token),
                data: { projectId: project, metadata: { phase: 'probe' } },
            }),
            'openSession',
        );

        // ── Step 2: save an observation into that project → 'saveMemory'.
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(u.access_token),
                data: { content: 'fixed the auth migration', tags: ['bug-fix'], projectId: project },
            }),
            'saveMemory',
        );

        // ── Step 3: search the project → 'searchMemory'.
        await expectNoProvider(
            await request.post(`${AM}/search`, {
                headers: authedHeaders(u.access_token),
                data: { query: 'auth migration', limit: 10, projectId: project },
            }),
            'searchMemory',
        );

        // ── Step 4: build a prompt context → 'buildContext'.
        await expectNoProvider(
            await request.post(`${AM}/context`, {
                headers: authedHeaders(u.access_token),
                data: { query: 'auth', purpose: 'fix-bug', maxTokens: 1000, projectId: project },
            }),
            'buildContext',
        );

        // ── Step 5: list sessions → 'listSessions' (optional facade method; keyless
        //    it never reaches the support probe — the provider resolves to none
        //    first, so it is the SAME no-provider 400, not a 'does not support' 404).
        await expectNoProvider(
            await request.get(`${AM}/sessions?limit=10&projectId=${encodeURIComponent(project)}`, {
                headers: authedHeaders(u.access_token),
            }),
            'listSessions',
        );
    });

    test('id-addressed mutations (close / forget) without a workId scope also degrade to no-provider', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // closeSession / deleteEntry run the owner-stamp verification via the read
        // seams (listSessions / searchMemory) BEFORE dispatching. Keyless, those
        // seams themselves resolve no provider, so the handler surfaces the
        // no-provider 400 tagged with the MUTATION's facade op — confirming the
        // unscoped id path still routes through the facade (not a silent success).
        await expectNoProvider(
            await request.post(`${AM}/sessions/${uniq('sid')}/close`, {
                headers: authedHeaders(u.access_token),
            }),
            'closeSession',
        );
        await expectNoProvider(
            await request.delete(`${AM}/entries/${uniq('eid')}`, {
                headers: authedHeaders(u.access_token),
            }),
            'deleteEntry',
        );
    });
});

test.describe('Flow: agent-memory owner-stamp IDOR (EW-711 #29) — Work-scoped access is gated before the facade', () => {
    test("a stranger cannot READ user A's Work-scoped memory: save/search/list/context all 403 before the facade", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `am-idor-read-${uniq('w')}`,
        });
        expect(work.id).toBeTruthy();

        // ── Owner-on-own-Work passes the ownership gate and reaches the facade →
        //    no-provider 400 (NOT 403). This proves the 403 below is the access
        //    gate, not an artifact of the keyless backend.
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(owner.access_token),
                data: { content: 'owner note', workId: work.id },
            }),
            'saveMemory',
        );

        // ── Stranger scoping ANY read/open/save to A's Work is rejected at
        //    `ensureCanView` with 403 — the no-provider path is never reached, so
        //    the foreign Work's memory namespace is not even probed.
        const readEndpoints: Array<[string, Promise<APIResponse>]> = [
            [
                'save',
                request.post(`${AM}/save`, {
                    headers: authedHeaders(stranger.access_token),
                    data: { content: 'intruder', workId: work.id },
                }),
            ],
            [
                'search',
                request.post(`${AM}/search`, {
                    headers: authedHeaders(stranger.access_token),
                    data: { query: 'secrets', workId: work.id },
                }),
            ],
            [
                'context',
                request.post(`${AM}/context`, {
                    headers: authedHeaders(stranger.access_token),
                    data: { query: 'secrets', workId: work.id },
                }),
            ],
            [
                'open-session',
                request.post(`${AM}/sessions`, {
                    headers: authedHeaders(stranger.access_token),
                    data: { workId: work.id },
                }),
            ],
            ['list-sessions', request.get(`${AM}/sessions?workId=${work.id}`, {
                headers: authedHeaders(stranger.access_token),
            })],
        ];
        for (const [label, p] of readEndpoints) {
            const res = await p;
            expect(res.status(), `stranger ${label} on A's Work → 403`).toBe(403);
            const body = (await res.json()) as { message?: string };
            expect(body.message, `${label} forbidden message`).toBe(FOREIGN_WORK_MSG);
        }
    });

    test("a stranger cannot WRITE/DELETE user A's Work-scoped memory: close + forget 403 (ensureCanEdit) before the facade", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `am-idor-write-${uniq('w')}`,
        });
        expect(work.id).toBeTruthy();

        // The id-addressed mutations gate on `ensureCanEdit` (a Work VIEWER must
        // not end sessions / forget records). The Work creator is the sole owner
        // here with edit rights, so a stranger has neither — close + delete scoped
        // to A's Work are both 403, pre-empting the facade. This is the core of the
        // owner-stamp IDOR fix: an id you guessed is useless without Work edit (or,
        // unscoped, without owning the stamped resource).
        const closeRes = await request.post(`${AM}/sessions/${uniq('sid')}/close?workId=${work.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(closeRes.status(), "stranger close on A's Work → 403").toBe(403);
        expect((await closeRes.json()).message).toBe(FOREIGN_WORK_MSG);

        const deleteRes = await request.delete(`${AM}/entries/${uniq('eid')}?workId=${work.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(deleteRes.status(), "stranger forget on A's Work → 403").toBe(403);
        expect((await deleteRes.json()).message).toBe(FOREIGN_WORK_MSG);

        // ── The owner, by contrast, clears the edit gate and reaches the facade →
        //    no-provider 400, confirming the 403s are an authorization decision.
        await expectNoProvider(
            await request.delete(`${AM}/entries/${uniq('eid')}?workId=${work.id}`, {
                headers: authedHeaders(owner.access_token),
            }),
            'deleteEntry',
        );
    });

    test('a nonexistent workId is a 404 (distinct from the 403 foreign-owner case) across read + mutate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // The ownership service distinguishes "exists but not yours" (403) from
        // "no such Work" (404). A well-formed UUID that matches no row returns 404
        // with the id echoed — and this holds for BOTH the ensureCanView reads and
        // the ensureCanEdit mutations.
        const notFoundMsg = `Work with id '${FAKE_WORK_UUID}' not found`;

        const save404 = await request.post(`${AM}/save`, {
            headers: authedHeaders(u.access_token),
            data: { content: 'x', workId: FAKE_WORK_UUID },
        });
        expect(save404.status(), 'save with nonexistent workId → 404').toBe(404);
        expect((await save404.json()).message).toBe(notFoundMsg);

        const delete404 = await request.delete(`${AM}/entries/eid?workId=${FAKE_WORK_UUID}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(delete404.status(), 'forget with nonexistent workId → 404').toBe(404);
        expect((await delete404.json()).message).toBe(notFoundMsg);

        const close404 = await request.post(`${AM}/sessions/sid/close?workId=${FAKE_WORK_UUID}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(close404.status(), 'close with nonexistent workId → 404').toBe(404);
        expect((await close404.json()).message).toBe(notFoundMsg);
    });
});

test.describe('Flow: agent-memory scoping resolution — workId vs projectId both flow through the access gate', () => {
    test('projectId-only requests bypass the Work gate (no workId) and reach the facade; workId drives ownership', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // ── projectId is the memory-backend namespace; it does NOT trigger the
        //    Work-ownership check (only workId does). A projectId-only save therefore
        //    skips ownership entirely and reaches the facade → no-provider 400.
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(u.access_token),
                data: { content: 'scoped to a project', projectId: uniq('ns') },
            }),
            'saveMemory',
        );

        // ── Supplying BOTH workId (own Work) + projectId still resolves: the Work
        //    gate is satisfied (owner) and the projectId rides along into the facade,
        //    again surfacing the no-provider 400. This proves the two scoping inputs
        //    are independent — projectId never short-circuits the workId gate.
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `am-scope-${uniq('w')}`,
        });
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(u.access_token),
                data: { content: 'both scopes', workId: work.id, projectId: uniq('ns') },
            }),
            'saveMemory',
        );
    });
});

test.describe('Flow: agent-memory input validation — DTO bounds reject before the facade runs', () => {
    test('save: content is required and a malformed workId is rejected by the UUID rule', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // Missing content → ValidationPipe array message (content must be a string),
        // 400 — never reaches the facade.
        const missing = await request.post(`${AM}/save`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(missing.status()).toBe(400);
        expect(await validationMessages(missing)).toContain('content must be a string');

        // workId must be a UUID — a non-UUID is a DTO 400, distinct from the
        // ownership 403/404 a well-formed-but-foreign id would produce.
        const badWork = await request.post(`${AM}/save`, {
            headers: authedHeaders(u.access_token),
            data: { content: 'x', workId: 'not-a-uuid' },
        });
        expect(badWork.status()).toBe(400);
        expect(await validationMessages(badWork)).toContain('workId must be a UUID');
    });

    test('save: oversized metadata is rejected by the 8 KiB serialisation cap (DoS guard)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // The metadata field is capped at 8192 bytes after JSON.stringify to stop a
        // flood of individually-small-but-costly objects. A ~9 KB string trips it.
        const oversized = await request.post(`${AM}/save`, {
            headers: authedHeaders(u.access_token),
            data: { content: 'x', metadata: { blob: 'x'.repeat(9000) } },
        });
        expect(oversized.status()).toBe(400);
        expect(await validationMessages(oversized)).toContain(
            'metadata must serialise to <= 8192 bytes',
        );

        // A small metadata object is within the cap → passes validation and reaches
        // the facade (no-provider 400), proving the cap is a bound, not a blanket ban.
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(u.access_token),
                data: { content: 'x', metadata: { phase: 'ok' } },
            }),
            'saveMemory',
        );
    });

    test('save: a per-tag length over 128 chars is rejected (the per-element cap, not array-level)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const longTag = await request.post(`${AM}/save`, {
            headers: authedHeaders(u.access_token),
            data: { content: 'x', tags: ['t'.repeat(200)] },
        });
        expect(longTag.status()).toBe(400);
        expect(await validationMessages(longTag)).toContain(
            'each value in tags must be shorter than or equal to 128 characters',
        );
    });

    test('search: query is required and limit is bounded to 1..100', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const noQuery = await request.post(`${AM}/search`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(noQuery.status()).toBe(400);
        expect(await validationMessages(noQuery)).toContain('query must be a string');

        const overLimit = await request.post(`${AM}/search`, {
            headers: authedHeaders(u.access_token),
            data: { query: 'q', limit: 500 },
        });
        expect(overLimit.status()).toBe(400);
        expect(await validationMessages(overLimit)).toContain('limit must not be greater than 100');

        // A valid query+limit clears validation → no-provider 400 (facade reached).
        await expectNoProvider(
            await request.post(`${AM}/search`, {
                headers: authedHeaders(u.access_token),
                data: { query: 'q', limit: 50 },
            }),
            'searchMemory',
        );
    });

    test('context: maxTokens is bounded to its 100..64000 window', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const tooLow = await request.post(`${AM}/context`, {
            headers: authedHeaders(u.access_token),
            data: { query: 'q', maxTokens: 50 },
        });
        expect(tooLow.status()).toBe(400);
        expect(await validationMessages(tooLow)).toContain('maxTokens must not be less than 100');
    });

    test('sessions(list): the query-string limit is coerced and bounded to 1..100', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // limit arrives as a string and is @Type(Number)-coerced before the numeric
        // bounds run. Over/under bounds reject at validation (400) BEFORE the facade.
        const over = await request.get(`${AM}/sessions?limit=999`, {
            headers: authedHeaders(u.access_token),
        });
        expect(over.status()).toBe(400);
        expect(await validationMessages(over)).toContain('limit must not be greater than 100');

        const under = await request.get(`${AM}/sessions?limit=0`, {
            headers: authedHeaders(u.access_token),
        });
        expect(under.status()).toBe(400);
        expect(await validationMessages(under)).toContain('limit must not be less than 1');

        // A valid in-range limit coerces cleanly and passes validation → the facade
        // is reached and returns the keyless no-provider 400 (not a validation 400).
        await expectNoProvider(
            await request.get(`${AM}/sessions?limit=5`, {
                headers: authedHeaders(u.access_token),
            }),
            'listSessions',
        );
    });
});
