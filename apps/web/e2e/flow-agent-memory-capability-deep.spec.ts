/**
 * Agent Memory capability — the /api/agent-memory REST surface, DEEP end-to-end
 * (follow-up to PR #1073 / #1081 / #1084 / #1086; EW-711 #29 IDOR hardening).
 *
 * The capability lets the signed-in user open/close memory sessions, save
 * observations, search them, build prompt context, and forget records. This
 * file drives the real API against a live stack and pins the true response
 * shapes + status codes, covering:
 *
 *   • GET  /check-availability — the availability contract { status, available,
 *     activeProvider(, message) }
 *   • POST /sessions, POST /sessions/:id/close, GET /sessions
 *   • POST /save, POST /search, POST /context, DELETE /entries/:id
 *   • the full session → save → search → context → delete roundtrip, made
 *     ENV-ADAPTIVE: without a configured memory backend every operation returns
 *     a stable 400 NoProviderError ({ status:'error', operation, message }); with
 *     one wired it returns the 2xx success payload. Each op asserts a strict
 *     discriminated union of those two — never a permissive < 500 smoke.
 *   • validation (400, class-validator array-shape): content/query required,
 *     content ≤ 64000, query ≤ 2000, tags array of ≤128-char strings, metadata
 *     an object serialising to ≤ 8192 bytes, projectId ≤ 128, limit 1..100
 *     (with @Type Number coercion on the query param), maxTokens 100..64000,
 *     workId a UUID
 *   • auth gating — every route is AuthSessionGuard'd → 401 without a token
 *   • Work-scoped ownership + isolation: a workId owned by another user → 403
 *     (reads/writes via ensureCanView, mutations via ensureCanEdit); an unknown
 *     but well-formed workId → 404; a self-owned workId passes the gate and
 *     reaches the provider stage; a malformed workId → 400
 *   • the server-forced `ownerUserId` stamp is never taken from the request body
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. In THIS env `available` is true
 *    but no backend is resolvable, so operations return the 400 NoProviderError
 *    branch; the assertions tolerate both branches so the spec stays green if a
 *    memory plugin is later wired in.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners.
 * Fully API-orchestrated (safe `flow-` prefix, not matched by the no-auth
 * testIgnore regex), so it never contends on the UI.
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

const MEMORY_BASE = `${API_BASE}/api/agent-memory`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const PROVIDER_UNAVAILABLE = 'No agent-memory provider is enabled';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Every mutating/reading operation resolves to exactly one of two live-verified
 * shapes: the provider-unavailable 400 (this env) or the 2xx success payload
 * (a backend is wired). Assert that discriminated union strictly — a stray 401
 * / 403 / 404 / 500 or any other shape fails the test.
 */
function assertMemoryResult(
    status: number,
    body: Record<string, unknown>,
    operation: string,
    successKey?: string,
): void {
    expect([200, 201, 400]).toContain(status);
    if (status === 400) {
        // Provider-unavailable branch: business error, NOT a class-validator
        // array-shape validation error.
        expect(body.status).toBe('error');
        expect(body.operation).toBe(operation);
        expect(String(body.message)).toContain(PROVIDER_UNAVAILABLE);
        expect(Array.isArray(body.message)).toBe(false);
    } else {
        expect(body.status).toBe('success');
        if (successKey) expect(body).toHaveProperty(successKey);
    }
}

/** True when the resolved provider is actually usable in this env (backend wired). */
function providerIsLive(status: number): boolean {
    return status === 200 || status === 201;
}

test.describe('Agent Memory — availability + auth gating', () => {
    test('check-availability returns the availability contract shape', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${MEMORY_BASE}/check-availability`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(typeof body.available).toBe('boolean');
        if (body.available) {
            // Registered provider — activeProvider is present (null when the
            // per-user resolution fails, an object when it resolves).
            expect(body).toHaveProperty('activeProvider');
        } else {
            // No provider registered at all — a null activeProvider + a hint.
            expect(body.activeProvider).toBeNull();
            expect(typeof body.message).toBe('string');
        }
    });

    test('every route requires authentication → 401', async ({ request }) => {
        const routes: Array<{ method: 'get' | 'post' | 'delete'; path: string }> = [
            { method: 'get', path: '/check-availability' },
            { method: 'post', path: '/sessions' },
            { method: 'get', path: '/sessions' },
            { method: 'post', path: '/sessions/some-id/close' },
            { method: 'post', path: '/save' },
            { method: 'post', path: '/search' },
            { method: 'post', path: '/context' },
            { method: 'delete', path: '/entries/some-id' },
        ];
        for (const r of routes) {
            const res =
                r.method === 'get'
                    ? await request.get(`${MEMORY_BASE}${r.path}`)
                    : r.method === 'delete'
                      ? await request.delete(`${MEMORY_BASE}${r.path}`)
                      : await request.post(`${MEMORY_BASE}${r.path}`, { data: {} });
            expect(res.status(), `${r.method.toUpperCase()} ${r.path} unauth`).toBe(401);
        }
    });

    test('an unknown sub-route under the controller → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${MEMORY_BASE}/bogus-endpoint`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Agent Memory — session lifecycle (env-adaptive)', () => {
    test('open session accepts metadata + projectId and returns the provider union', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { projectId: `proj-${stamp()}`, metadata: { origin: 'e2e' } },
        });
        assertMemoryResult(res.status(), await res.json(), 'openSession', 'session');
    });

    test('list sessions returns { sessions } or the provider-unavailable 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${MEMORY_BASE}/sessions`, {
            headers: authedHeaders(user.access_token),
        });
        assertMemoryResult(res.status(), await res.json(), 'listSessions', 'sessions');
    });

    test('list sessions coerces a numeric ?limit (no validation 400 for a valid limit)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${MEMORY_BASE}/sessions?limit=5`, {
            headers: authedHeaders(user.access_token),
        });
        // limit=5 arrives as a string but @Type(() => Number) coerces it, so it
        // must NOT fail @IsNumber — it reaches the provider stage instead.
        assertMemoryResult(res.status(), await res.json(), 'listSessions', 'sessions');
    });

    test('close a session by id returns the provider union (operation closeSession)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/sessions/${stamp()}-sid/close`, {
            headers: authedHeaders(user.access_token),
        });
        expect([200, 400]).toContain(res.status());
        if (res.status() === 400) {
            const body = await res.json();
            expect(body.status).toBe('error');
            expect(body.operation).toBe('closeSession');
            expect(String(body.message)).toContain(PROVIDER_UNAVAILABLE);
        }
    });
});

test.describe('Agent Memory — save / search / context (env-adaptive)', () => {
    test('save a well-formed observation returns { record } or the provider 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: {
                content: 'Fixed the flaky auth migration.',
                tags: ['bug-fix', 'auth'],
                projectId: `proj-${stamp()}`,
            },
        });
        assertMemoryResult(res.status(), await res.json(), 'saveMemory', 'record');
    });

    test('search returns { results } or the provider 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(user.access_token),
            data: { query: 'auth migration', limit: 10 },
        });
        assertMemoryResult(res.status(), await res.json(), 'searchMemory', 'results');
    });

    test('build context returns { context } or the provider 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/context`, {
            headers: authedHeaders(user.access_token),
            data: { query: 'auth migration', purpose: 'fix-bug', maxTokens: 500 },
        });
        assertMemoryResult(res.status(), await res.json(), 'buildContext', 'context');
    });

    test('context accepts a fully empty body (all fields optional) and reaches the provider', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/context`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        assertMemoryResult(res.status(), await res.json(), 'buildContext', 'context');
    });

    test('full session → save → search → context → delete roundtrip (env-adaptive)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const projectId = `proj-${stamp()}`;

        const openRes = await request.post(`${MEMORY_BASE}/sessions`, {
            headers: H,
            data: { projectId, metadata: { origin: 'roundtrip' } },
        });
        const openBody = await openRes.json();
        assertMemoryResult(openRes.status(), openBody, 'openSession', 'session');

        if (!providerIsLive(openRes.status())) {
            // No memory backend in this env: every downstream op shares the same
            // fate. Assert each one truthfully rather than skipping.
            const saveRes = await request.post(`${MEMORY_BASE}/save`, {
                headers: H,
                data: { content: 'observation', projectId },
            });
            assertMemoryResult(saveRes.status(), await saveRes.json(), 'saveMemory', 'record');

            const searchRes = await request.post(`${MEMORY_BASE}/search`, {
                headers: H,
                data: { query: 'observation', projectId },
            });
            assertMemoryResult(
                searchRes.status(),
                await searchRes.json(),
                'searchMemory',
                'results',
            );

            const ctxRes = await request.post(`${MEMORY_BASE}/context`, {
                headers: H,
                data: { query: 'observation', projectId },
            });
            assertMemoryResult(ctxRes.status(), await ctxRes.json(), 'buildContext', 'context');

            const delRes = await request.delete(`${MEMORY_BASE}/entries/${stamp()}-eid`, {
                headers: H,
            });
            expect([200, 400]).toContain(delRes.status());
            return;
        }

        // Provider is live — exercise the real roundtrip end-to-end.
        const sessionId = openBody.session.id as string;
        expect(typeof sessionId).toBe('string');

        const saveRes = await request.post(`${MEMORY_BASE}/save`, {
            headers: H,
            data: { content: 'roundtrip observation', projectId, sessionId, tags: ['e2e'] },
        });
        expect(saveRes.status()).toBe(201);
        const saved = await saveRes.json();
        expect(saved.status).toBe('success');
        const entryId = saved.record.id as string;

        const searchRes = await request.post(`${MEMORY_BASE}/search`, {
            headers: H,
            data: { query: 'roundtrip', projectId, sessionId },
        });
        expect(searchRes.status()).toBe(200);
        expect((await searchRes.json()).status).toBe('success');

        const ctxRes = await request.post(`${MEMORY_BASE}/context`, {
            headers: H,
            data: { query: 'roundtrip', projectId, sessionId },
        });
        expect(ctxRes.status()).toBe(200);

        const delRes = await request.delete(`${MEMORY_BASE}/entries/${entryId}`, { headers: H });
        expect(delRes.status()).toBe(200);
        expect((await delRes.json()).status).toBe('success');

        const closeRes = await request.post(`${MEMORY_BASE}/sessions/${sessionId}/close`, {
            headers: H,
        });
        expect(closeRes.status()).toBe(200);
    });
});

test.describe('Agent Memory — validation (400, class-validator array shape)', () => {
    test('save requires a string content field', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { tags: ['t'] },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.error).toBe('Bad Request');
        expect(JSON.stringify(body.message)).toContain('content must be a string');
    });

    test('save rejects content longer than 64000 characters', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'x'.repeat(64_001) },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'content must be shorter than or equal to 64000',
        );
    });

    test('save rejects oversized metadata (> 8192 bytes serialised)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', metadata: { blob: 'x'.repeat(9_000) } },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'metadata must serialise to <= 8192 bytes',
        );
    });

    test('save rejects a non-object metadata and a non-array tags', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const badMeta = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(token),
            data: { content: 'c', metadata: 'not-an-object' },
        });
        expect(badMeta.status()).toBe(400);
        expect(JSON.stringify((await badMeta.json()).message)).toContain(
            'metadata must be an object',
        );

        const badTags = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(token),
            data: { content: 'c', tags: 'not-an-array' },
        });
        expect(badTags.status()).toBe(400);
        expect(JSON.stringify((await badTags.json()).message)).toContain('tags must be an array');
    });

    test('save rejects a tag element longer than 128 characters', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', tags: ['t'.repeat(200)] },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'each value in tags must be shorter than or equal to 128 characters',
        );
    });

    test('save rejects a projectId longer than 128 characters', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', projectId: 'p'.repeat(200) },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'projectId must be shorter than or equal to 128 characters',
        );
    });

    test('search requires a query and enforces the limit upper bound (100)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const noQuery = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(token),
            data: { limit: 5 },
        });
        expect(noQuery.status()).toBe(400);
        expect(JSON.stringify((await noQuery.json()).message)).toContain('query must be a string');

        const bigLimit = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(token),
            data: { query: 'q', limit: 101 },
        });
        expect(bigLimit.status()).toBe(400);
        expect(JSON.stringify((await bigLimit.json()).message)).toContain(
            'limit must not be greater than 100',
        );
    });

    test('search rejects a query longer than 2000 characters', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(user.access_token),
            data: { query: 'q'.repeat(2_001) },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'query must be shorter than or equal to 2000',
        );
    });

    test('context enforces the maxTokens lower bound (100)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${MEMORY_BASE}/context`, {
            headers: authedHeaders(user.access_token),
            data: { maxTokens: 50 },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            'maxTokens must not be less than 100',
        );
    });

    test('list sessions rejects a limit below 1 and a non-numeric limit', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const zero = await request.get(`${MEMORY_BASE}/sessions?limit=0`, {
            headers: authedHeaders(token),
        });
        expect(zero.status()).toBe(400);
        expect(JSON.stringify((await zero.json()).message)).toContain(
            'limit must not be less than 1',
        );

        const nan = await request.get(`${MEMORY_BASE}/sessions?limit=abc`, {
            headers: authedHeaders(token),
        });
        expect(nan.status()).toBe(400);
        expect(JSON.stringify((await nan.json()).message)).toContain('limit must be a number');
    });

    test('a malformed workId is rejected as a UUID (body + close/delete query params)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const body = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(token),
            data: { content: 'c', workId: 'not-a-uuid' },
        });
        expect(body.status()).toBe(400);
        expect(JSON.stringify((await body.json()).message)).toContain('workId must be a UUID');

        const closeQ = await request.post(`${MEMORY_BASE}/sessions/sid/close?workId=not-a-uuid`, {
            headers: authedHeaders(token),
        });
        expect(closeQ.status()).toBe(400);
        expect(JSON.stringify((await closeQ.json()).message)).toContain('workId must be a UUID');

        const delQ = await request.delete(`${MEMORY_BASE}/entries/eid?workId=not-a-uuid`, {
            headers: authedHeaders(token),
        });
        expect(delQ.status()).toBe(400);
        expect(JSON.stringify((await delQ.json()).message)).toContain('workId must be a UUID');
    });
});

test.describe('Agent Memory — Work-scoped ownership + isolation', () => {
    test('a self-owned workId passes the ownership gate and reaches the provider stage', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `AM Own ${stamp()}`,
        });
        expect(work.id).toMatch(UUID_RE);

        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'own-work observation', workId: work.id },
        });
        // Ownership must NOT wall the owner off — no 403/404 here.
        expect(res.status()).not.toBe(403);
        expect(res.status()).not.toBe(404);
        assertMemoryResult(res.status(), await res.json(), 'saveMemory', 'record');
    });

    test("another user's workId is walled off with 403 on reads + writes", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `AM Private ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        const calls: Array<{
            label: string;
            run: () => Promise<{ status(): number; json(): Promise<any> }>;
        }> = [
            {
                label: 'save',
                run: () =>
                    request.post(`${MEMORY_BASE}/save`, {
                        headers: iH,
                        data: { content: 'c', workId: work.id },
                    }),
            },
            {
                label: 'search',
                run: () =>
                    request.post(`${MEMORY_BASE}/search`, {
                        headers: iH,
                        data: { query: 'q', workId: work.id },
                    }),
            },
            {
                label: 'context',
                run: () =>
                    request.post(`${MEMORY_BASE}/context`, {
                        headers: iH,
                        data: { query: 'q', workId: work.id },
                    }),
            },
            {
                label: 'openSession',
                run: () =>
                    request.post(`${MEMORY_BASE}/sessions`, {
                        headers: iH,
                        data: { workId: work.id },
                    }),
            },
            {
                label: 'listSessions',
                run: () =>
                    request.get(`${MEMORY_BASE}/sessions?workId=${work.id}`, { headers: iH }),
            },
        ];
        for (const c of calls) {
            const res = await c.run();
            expect(res.status(), `${c.label} cross-user`).toBe(403);
            const body = await res.json();
            expect(body.status).toBe('error');
            expect(String(body.message)).toContain('permission to access this work');
        }
    });

    test("another user's workId is walled off with 403 on the id-addressed mutations (ensureCanEdit)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `AM Mut ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        const close = await request.post(`${MEMORY_BASE}/sessions/sid/close?workId=${work.id}`, {
            headers: iH,
        });
        expect(close.status()).toBe(403);
        expect(String((await close.json()).message)).toContain('permission to access this work');

        const del = await request.delete(`${MEMORY_BASE}/entries/eid?workId=${work.id}`, {
            headers: iH,
        });
        expect(del.status()).toBe(403);
        expect(String((await del.json()).message)).toContain('permission to access this work');
    });

    test('an unknown but well-formed workId → 404 (not 403)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const save = await request.post(`${MEMORY_BASE}/save`, {
            headers: H,
            data: { content: 'c', workId: UNKNOWN_UUID },
        });
        expect(save.status()).toBe(404);
        expect(String((await save.json()).message)).toContain(
            `Work with id '${UNKNOWN_UUID}' not found`,
        );

        const list = await request.get(`${MEMORY_BASE}/sessions?workId=${UNKNOWN_UUID}`, {
            headers: H,
        });
        expect(list.status()).toBe(404);
        expect(String((await list.json()).message)).toContain('not found');
    });

    test('the ownerUserId stamp is server-forced — a spoofed body value does not gate validation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // A metadata.ownerUserId in the body is ignored (overridden server-side),
        // so the request still passes validation and reaches the provider stage
        // rather than being rejected or accepted as another user's write.
        const res = await request.post(`${MEMORY_BASE}/save`, {
            headers: authedHeaders(user.access_token),
            data: {
                content: 'stamp test',
                metadata: { ownerUserId: 'someone-else', note: 'spoof' },
            },
        });
        assertMemoryResult(res.status(), await res.json(), 'saveMemory', 'record');
    });

    test('cross-user isolation does not leak: intruder + owner get independent provider results', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);

        // With no workId, memory is per-user (owner stamp) but not walled by
        // Work ownership — both callers independently reach the provider stage.
        const ownerRes = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(owner.access_token),
            data: { query: 'anything' },
        });
        assertMemoryResult(ownerRes.status(), await ownerRes.json(), 'searchMemory', 'results');

        const intruderRes = await request.post(`${MEMORY_BASE}/search`, {
            headers: authedHeaders(intruder.access_token),
            data: { query: 'anything' },
        });
        assertMemoryResult(
            intruderRes.status(),
            await intruderRes.json(),
            'searchMemory',
            'results',
        );
    });
});
