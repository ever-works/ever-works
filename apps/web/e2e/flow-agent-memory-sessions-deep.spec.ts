import { test, expect, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Agent-memory SESSIONS — deep coverage of the session lifecycle + the
 * save/search/context session-linkage contracts on `AgentMemoryController`
 * (`apps/api/src/plugins-capabilities/agent-memory/agent-memory.controller.ts`,
 * mounted at `/api/agent-memory`, JWT-guarded by `AuthSessionGuard`).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this is the SECOND agent-memory e2e file. Sibling
 * `flow-agent-memory-lifecycle.spec.ts` (Batch 2) already pins, and this file
 * deliberately does NOT re-assert:
 *   - GET /check-availability (the keyless-success read) + the blanket anon-401
 *     matrix across every endpoint.
 *   - The unscoped facade-op no-provider tags for save / search / context /
 *     listSessions in one mixed lifecycle, and the unscoped close/forget tags.
 *   - The workId-scoped IDOR matrix on save/search/context + open/list, and the
 *     DTO bounds for content, workId-UUID, SAVE-metadata cap, tags, search
 *     query/limit, context maxTokens, and list limit coercion.
 *
 * This file pins the GAPS Batch 2 left, all SESSION-centric:
 *   1. The session lifecycle as an ORDERED open → list → close → re-list
 *      sequence, asserting each SESSION endpoint routes through the facade with
 *      its own `operation` tag (a future mis-route, e.g. close → listSessions,
 *      is caught even though the keyless HTTP status is identical).
 *   2. `sessionId` LINKAGE on save / search / context — supplying a sessionId
 *      (the DTO field Batch 2 never exercised on these) still clears validation
 *      and reaches the facade (no-provider 400) tagged with the right op.
 *   3. OPEN-SESSION DTO bounds Batch 2 never touched: the `OpenSessionDto`
 *      metadata 8 KiB cap (Batch 2 capped SAVE only), metadata-must-be-object,
 *      projectId <=128, and the workId-UUID rule on the OPEN handler.
 *   4. `sessionId` <=128 on save AND search; context `query` <=2000 + `purpose`
 *      <=64 (none of these element bounds are in Batch 2).
 *   5. CROSS-USER session isolation: a stranger is gated at the Work boundary
 *      for open / list / close (ensureCanView vs ensureCanEdit), with the owner
 *      reaching the facade as the control that proves the 403 is an authz
 *      decision — and the 403 (foreign) vs 404 (nonexistent) split on the
 *      SESSION endpoints specifically.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING.
 *
 * ENVIRONMENT-ADAPTIVE (load-bearing): the e2e stack is KEYLESS — NO
 * agent-memory provider plugin is enabled. `isConfigured()` is true but
 * `getDefaultProvider()` resolves to null, so EVERY facade-backed session op
 * (openSession / listSessions / closeSession) and every save/search/context
 * call throws `NoProviderError`, mapped by the controller to:
 *   400 { status:'error', message:<NO_PROVIDER_MSG>, operation:<facadeOp> }
 * where <facadeOp> is the handler's facade method ('openSession' |
 * 'listSessions' | 'closeSession' | 'saveMemory' | 'searchMemory' |
 * 'buildContext'). Completions/list round-trips are impossible keyless, so this
 * spec pins the SESSION ERROR CONTRACTS, the DTO bounds, and the ownership
 * gates — never a provider-backed open→persist→close round-trip (which cannot
 * run here and would be vacuous). That is the deterministic, real surface.
 *
 * GATE ORDERING (probed): when a `workId` is supplied the controller runs
 * `WorkOwnershipService` BEFORE the facade, so a Work access failure pre-empts
 * the no-provider 400:
 *   - Authn ............ no bearer                      -> 401 (Batch 2 pins this)
 *   - DTO Validation ... malformed body/query           -> 400 (array message)
 *   - Work access ...... foreign Work (open/list=View;  -> 403 FOREIGN_WORK_MSG
 *                        close=Edit)
 *                        nonexistent Work               -> 404 "Work with id '<uuid>' not found"
 *   - Facade ........... owner / no-workId              -> 400 NoProvider
 *
 * VALIDATION BOUNDS pinned here (probed against the live DTOs):
 *   - open-session: metadata <= 8192 bytes serialised + must be an object;
 *                   projectId <= 128; workId must be a UUID.
 *   - save/search:  sessionId <= 128 chars.
 *   - context:      query <= 2000; purpose <= 64.
 *
 * ISOLATION: every test registers FRESH users via registerUserViaAPI() (no
 * shared seeded user). Unique suffixes derive from the per-test counter, never
 * a module-scope clock.
 */

const AM = `${API_BASE}/api/agent-memory`;
const FAKE_WORK_UUID = '99999999-9999-4999-8999-999999999999';
const NO_PROVIDER_MSG =
    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).';
const FOREIGN_WORK_MSG = 'You do not have permission to access this work';

/** Per-test unique suffix WITHOUT calling a clock at module scope. */
let UNIQ_COUNTER = 0;
function uniq(label: string): string {
    UNIQ_COUNTER += 1;
    return `${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${UNIQ_COUNTER}-${Math.random()
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

/** Assert a Work-ownership 403 with the canonical foreign-work message. */
async function expectForeignWork(res: APIResponse, label: string): Promise<void> {
    expect(res.status(), `${label} → 403`).toBe(403);
    const body = (await res.json()) as { status?: string; message?: string };
    expect(body.message, `${label} message`).toBe(FOREIGN_WORK_MSG);
}

test.describe('Flow: agent-memory session lifecycle (keyless) — open → list → close routes each through the facade', () => {
    test('the ordered session lifecycle returns the no-provider 400 tagged per SESSION handler', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const project = uniq('proj');
        const headers = authedHeaders(u.access_token);

        // The intended session lifecycle is: open a session for a project →
        // enumerate the recent sessions → close it → confirm the close reflected
        // by re-listing. Keyless, EVERY session hop is a tagged no-provider 400.
        // Pinning the per-handler `operation` tag (NOT just the 400) catches a
        // future regression that mis-routes a session handler through the wrong
        // facade method while the HTTP status stays identical.

        // ── Step 1: OPEN a session scoped to the project namespace → 'openSession'.
        await expectNoProvider(
            await request.post(`${AM}/sessions`, {
                headers,
                data: { projectId: project, metadata: { phase: 'kickoff' } },
            }),
            'openSession',
        );

        // ── Step 2: LIST the recent sessions for that project → 'listSessions'.
        //    (Batch 2 lists unscoped; here it is the second step of an ordered
        //    session flow with a projectId + a bounded limit.)
        await expectNoProvider(
            await request.get(`${AM}/sessions?limit=20&projectId=${encodeURIComponent(project)}`, {
                headers,
            }),
            'listSessions',
        );

        // ── Step 3: CLOSE a session by id (unscoped — no workId) → 'closeSession'.
        //    The id-addressed mutation runs the owner-stamp verification via the
        //    listSessions read seam BEFORE dispatch; keyless that seam itself
        //    resolves no provider, so the handler surfaces the no-provider 400
        //    tagged with the MUTATION's op — proving the close still routes
        //    through the facade rather than silently succeeding.
        await expectNoProvider(
            await request.post(`${AM}/sessions/${uniq('sid')}/close`, { headers }),
            'closeSession',
        );

        // ── Step 4: RE-LIST after the (failed) close → still 'listSessions'. With
        //    no provider the "closed reflected" assertion degrades to the same
        //    deterministic no-provider contract — the list seam is the only place
        //    a closed session would surface, and it is reached identically.
        await expectNoProvider(
            await request.get(`${AM}/sessions?projectId=${encodeURIComponent(project)}`, {
                headers,
            }),
            'listSessions',
        );
    });

    test('close-by-id is independent of list — an unrelated guessed sessionId still reaches the closeSession facade op', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // Two DIFFERENT guessed session ids both surface the closeSession op (not
        // a 404 "no such session" — there is no get-by-id seam, the owner-stamp
        // check fails open on the keyless list seam and the facade is dispatched).
        // This pins that the close handler is reachable for ANY well-formed id and
        // is not gated behind a prior successful list.
        await expectNoProvider(
            await request.post(`${AM}/sessions/${uniq('sid-a')}/close`, { headers }),
            'closeSession',
        );
        await expectNoProvider(
            await request.post(`${AM}/sessions/${uniq('sid-b')}/close`, { headers }),
            'closeSession',
        );
    });
});

test.describe('Flow: agent-memory session linkage — sessionId on save/search/context flows through to the facade', () => {
    test('save linked to a sessionId clears validation and reaches saveMemory', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // A save can be attached to an open session via `sessionId`. Batch 2 never
        // supplied this field on /save; here a well-formed (<=128) sessionId rides
        // through validation into the facade → no-provider 400 tagged saveMemory,
        // proving the linkage field is accepted (not rejected) and routed.
        await expectNoProvider(
            await request.post(`${AM}/save`, {
                headers: authedHeaders(u.access_token),
                data: {
                    content: 'observation captured during the session',
                    sessionId: uniq('sess'),
                    tags: ['session-note'],
                },
            }),
            'saveMemory',
        );
    });

    test('search restricted to a sessionId clears validation and reaches searchMemory', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        await expectNoProvider(
            await request.post(`${AM}/search`, {
                headers: authedHeaders(u.access_token),
                data: { query: 'what did we decide', sessionId: uniq('sess'), limit: 25 },
            }),
            'searchMemory',
        );
    });

    test('context built for a sessionId clears validation and reaches buildContext', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // buildContext has NO required field — a sessionId-scoped context with a
        // purpose hint and an in-range token budget is a fully-optional valid body
        // that still reaches the facade keyless.
        await expectNoProvider(
            await request.post(`${AM}/context`, {
                headers: authedHeaders(u.access_token),
                data: {
                    query: 'recall the open questions',
                    purpose: 'resume-session',
                    sessionId: uniq('sess'),
                    maxTokens: 2000,
                },
            }),
            'buildContext',
        );
    });
});

test.describe('Flow: agent-memory open-session DTO bounds — validated before the facade runs', () => {
    test('open-session: oversized metadata is rejected by the 8 KiB serialisation cap (DoS guard)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // The OpenSessionDto seeds session-row metadata and carries the SAME 8 KiB
        // serialisation cap as SaveMemoryDto — but Batch 2 only pinned the cap on
        // /save. A ~9 KB blob trips it here on the OPEN handler.
        const oversized = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(u.access_token),
            data: { metadata: { blob: 'x'.repeat(9000) } },
        });
        expect(oversized.status()).toBe(400);
        expect(await validationMessages(oversized)).toContain(
            'metadata must serialise to <= 8192 bytes',
        );

        // A small metadata object is within the cap → passes validation and reaches
        // the facade (no-provider 400), proving the cap is a bound, not a blanket ban.
        await expectNoProvider(
            await request.post(`${AM}/sessions`, {
                headers: authedHeaders(u.access_token),
                data: { metadata: { phase: 'ok' } },
            }),
            'openSession',
        );
    });

    test('open-session: metadata must be an object and projectId is capped at 128 chars', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // A non-object metadata (string) fails @IsObject — the byte-cap constraint
        // also fires since it rejects non-objects, so BOTH messages appear.
        const notObject = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(u.access_token),
            data: { metadata: 'not-an-object' },
        });
        expect(notObject.status()).toBe(400);
        const notObjectMsgs = await validationMessages(notObject);
        expect(notObjectMsgs).toContain('metadata must be an object');

        // projectId is the backend namespace, capped at 128 chars on the shared
        // WorkScopedDto — a 200-char value is rejected before the facade.
        const longProject = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(u.access_token),
            data: { projectId: 'p'.repeat(200) },
        });
        expect(longProject.status()).toBe(400);
        expect(await validationMessages(longProject)).toContain(
            'projectId must be shorter than or equal to 128 characters',
        );
    });

    test('open-session: a malformed workId is rejected by the UUID rule (distinct from the 403/404 ownership outcomes)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // workId must be a UUID on the OPEN handler too — a non-UUID is a DTO 400,
        // never reaching the ownership check that a well-formed-but-foreign id
        // would (403) or a nonexistent id would (404).
        const badWork = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(u.access_token),
            data: { workId: 'not-a-uuid' },
        });
        expect(badWork.status()).toBe(400);
        expect(await validationMessages(badWork)).toContain('workId must be a UUID');
    });
});

test.describe('Flow: agent-memory linkage DTO bounds — sessionId/query/purpose element caps reject before the facade', () => {
    test('save + search: a sessionId over 128 chars is rejected by the per-field cap', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const longSession = 's'.repeat(200);

        const saveRes = await request.post(`${AM}/save`, {
            headers,
            data: { content: 'x', sessionId: longSession },
        });
        expect(saveRes.status()).toBe(400);
        expect(await validationMessages(saveRes)).toContain(
            'sessionId must be shorter than or equal to 128 characters',
        );

        const searchRes = await request.post(`${AM}/search`, {
            headers,
            data: { query: 'q', sessionId: longSession },
        });
        expect(searchRes.status()).toBe(400);
        expect(await validationMessages(searchRes)).toContain(
            'sessionId must be shorter than or equal to 128 characters',
        );
    });

    test('context: query is capped at 2000 chars and purpose at 64 chars', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const longQuery = await request.post(`${AM}/context`, {
            headers,
            data: { query: 'q'.repeat(2100) },
        });
        expect(longQuery.status()).toBe(400);
        expect(await validationMessages(longQuery)).toContain(
            'query must be shorter than or equal to 2000 characters',
        );

        const longPurpose = await request.post(`${AM}/context`, {
            headers,
            data: { query: 'q', purpose: 'p'.repeat(80) },
        });
        expect(longPurpose.status()).toBe(400);
        expect(await validationMessages(longPurpose)).toContain(
            'purpose must be shorter than or equal to 64 characters',
        );
    });
});

test.describe('Flow: agent-memory cross-user session isolation — Work-scoped open/list/close are gated before the facade', () => {
    test("a stranger cannot open or list user A's Work-scoped sessions: both 403 at ensureCanView, owner reaches the facade", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `am-sess-view-${uniq('w')}`,
        });
        expect(work.id).toBeTruthy();

        // ── Owner on own Work clears the (view) ownership gate and reaches the
        //    facade → no-provider 400. This control proves the strangers' 403s
        //    below are an authorization decision, not a keyless artifact.
        await expectNoProvider(
            await request.post(`${AM}/sessions`, {
                headers: authedHeaders(owner.access_token),
                data: { workId: work.id, metadata: { phase: 'owner' } },
            }),
            'openSession',
        );
        await expectNoProvider(
            await request.get(`${AM}/sessions?workId=${work.id}`, {
                headers: authedHeaders(owner.access_token),
            }),
            'listSessions',
        );

        // ── Stranger scoping OPEN or LIST to A's Work is rejected at ensureCanView
        //    with 403 — the foreign Work's session namespace is never probed.
        await expectForeignWork(
            await request.post(`${AM}/sessions`, {
                headers: authedHeaders(stranger.access_token),
                data: { workId: work.id },
            }),
            "stranger open on A's Work",
        );
        await expectForeignWork(
            await request.get(`${AM}/sessions?workId=${work.id}`, {
                headers: authedHeaders(stranger.access_token),
            }),
            "stranger list on A's Work",
        );
    });

    test("a stranger cannot close user A's Work-scoped session: 403 at ensureCanEdit (stronger than the view gate), owner reaches the facade", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `am-sess-close-${uniq('w')}`,
        });
        expect(work.id).toBeTruthy();

        // closeSession is a mutation → gates on ensureCanEdit, NOT ensureCanView.
        // A stranger has neither view nor edit on A's Work, so the close scoped to
        // it is rejected with 403 BEFORE the owner-stamp / facade dispatch. This is
        // the core of the EW-711 #29 owner-stamp IDOR defense for sessions: a
        // guessed sessionId is useless without Work edit access.
        await expectForeignWork(
            await request.post(`${AM}/sessions/${uniq('sid')}/close?workId=${work.id}`, {
                headers: authedHeaders(stranger.access_token),
            }),
            "stranger close on A's Work",
        );

        // ── The owner clears the EDIT gate and reaches the facade → no-provider
        //    400, confirming the stranger's 403 was an authz decision and the
        //    close handler dispatches for the rightful editor.
        await expectNoProvider(
            await request.post(`${AM}/sessions/${uniq('sid')}/close?workId=${work.id}`, {
                headers: authedHeaders(owner.access_token),
            }),
            'closeSession',
        );
    });

    test('a nonexistent workId is a 404 (distinct from the 403 foreign-owner case) across the session open/list/close handlers', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // The ownership service distinguishes "exists but not yours" (403) from
        // "no such Work" (404). A well-formed UUID matching no row returns 404 with
        // the id echoed — and this holds across ALL THREE session handlers (open +
        // list use ensureCanView, close uses ensureCanEdit), so the 404 is a
        // property of the Work-resolution step, independent of the access level.
        const notFoundMsg = `Work with id '${FAKE_WORK_UUID}' not found`;

        const open404 = await request.post(`${AM}/sessions`, {
            headers,
            data: { workId: FAKE_WORK_UUID },
        });
        expect(open404.status(), 'open with nonexistent workId → 404').toBe(404);
        expect((await open404.json()).message).toBe(notFoundMsg);

        const list404 = await request.get(`${AM}/sessions?workId=${FAKE_WORK_UUID}`, { headers });
        expect(list404.status(), 'list with nonexistent workId → 404').toBe(404);
        expect((await list404.json()).message).toBe(notFoundMsg);

        const close404 = await request.post(
            `${AM}/sessions/${uniq('sid')}/close?workId=${FAKE_WORK_UUID}`,
            { headers },
        );
        expect(close404.status(), 'close with nonexistent workId → 404').toBe(404);
        expect((await close404.json()).message).toBe(notFoundMsg);
    });
});
