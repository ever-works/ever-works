import { test, expect, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Agent-memory capability — EXHAUSTIVE DTO VALIDATION MATRIX for
 * `AgentMemoryController`
 * (`apps/api/src/plugins-capabilities/agent-memory/agent-memory.controller.ts`,
 * mounted at `/api/agent-memory`, JWT-guarded by `AuthSessionGuard`;
 * DTOs in `dto/agent-memory.dto.ts`).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this is the FOURTH agent-memory e2e file. The siblings
 * (`flow-agent-memory-lifecycle.spec.ts`, `flow-agent-memory-sessions-deep.spec.ts`,
 * `flow-agent-memory-capability-deep.spec.ts`) already pin the no-provider
 * lifecycle, the per-handler `operation` tags, the 401 anon matrix, the
 * Work-scoped 403/404 IDOR gates, and a first slice of DTO bounds (content/query
 * MISSING, content>64000, query>2000, metadata>8KiB, non-array tags, long-tag,
 * projectId>128, sessionId>128, purpose>64, maxTokens<100, list limit 0/101/abc).
 *
 * This file deliberately does NOT re-assert those. It covers the DISTINCT
 * validation angles the siblings left open, as a field-by-field matrix:
 *
 *   1. forbidNonWhitelisted — an EXTRA unknown property is rejected with
 *      `property <x> should not exist`, on BOTH the body DTOs (save/search/
 *      context/open) AND the query DTOs (list/close/delete). No sibling tests
 *      extra-field rejection at all.
 *   2. Wrong-TYPE per field — content/projectId/sessionId/purpose non-string →
 *      `<field> must be a string`; tags non-string element → `each value in tags
 *      must be a string`; body limit/maxTokens non-numeric → `<field> must be a
 *      number …`. Siblings only test MISSING / too-long, never the type message.
 *   3. Metadata shape nuances — an ARRAY yields the single `metadata must be an
 *      object`; a SCALAR (number/boolean) yields BOTH `must be an object` AND
 *      `must serialise to <= 8192 bytes`; `null` is treated as absent (@IsOptional)
 *      and reaches the facade.
 *   4. Boundary values AT the exact cap PASS (reach the facade) while one over
 *      rejects — content 64000/64001, query 2000, tag-elem 128, projectId
 *      128/129, sessionId 128, purpose 64, search limit 1 & 100, and the
 *      maxTokens UPPER bound 100 & 64000 pass / 64001 reject (siblings only pin
 *      the LOWER maxTokens bound).
 *   5. Numeric coercion — a FLOAT limit (5.5 body + ?limit=5.5 query) satisfies
 *      @IsNumber and reaches the facade.
 *   6. workId UUID edge variants — empty string and a short near-miss both →
 *      `workId must be a UUID` (siblings only test the literal `not-a-uuid`).
 *   7. Gate ordering — the ValidationPipe runs BEFORE the handler's ownership
 *      check, so a body validation error pre-empts the would-be 404/403, and a
 *      multi-field violation aggregates every message.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100 — sqlite
 * in-memory, the CI driver) BEFORE writing every assertion.
 *
 * ENVIRONMENT-ADAPTIVE (load-bearing): the stack is KEYLESS — the capability is
 * registered (`isConfigured()` true) but no agent-memory provider plugin
 * resolves, so any request that CLEARS validation reaches the facade and
 * surfaces the deterministic:
 *   400 { status:'error', message:<NO_PROVIDER_MSG>, operation:<facadeOp> }
 * A request that FAILS validation instead surfaces the ValidationPipe array:
 *   400 { message:[…], error:'Bad Request', statusCode:400 }
 * Every test below pins WHICH of those two 400s a given input produces — a
 * "passes validation" case is asserted as the no-provider union (proving it
 * cleared the pipe), never a permissive < 500 smoke. If a memory backend is
 * later wired in, the passing-boundary cases flip to 2xx; `expectClearsValidation`
 * tolerates that so the spec stays green either way.
 *
 * ISOLATION: every test registers a FRESH `registerUserViaAPI()` user (never the
 * shared seeded user). Unique suffixes derive from a call-time `stamp()`; no
 * module-scope clock runs at collection.
 */

const AM = `${API_BASE}/api/agent-memory`;
const NO_PROVIDER_MSG =
    'No agent-memory provider is enabled. Install + enable an agent-memory plugin (e.g. `@ever-works/agentmemory-plugin`).';

/** Call-time unique suffix (no module-scope clock at collection). */
function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Pull the ValidationPipe `message` array out of a 400 body (best-effort). */
async function validationMessages(res: APIResponse): Promise<string[]> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return Array.isArray(body.message) ? (body.message as string[]) : [];
}

/**
 * Assert an input that CLEARS validation: keyless it is the no-provider 400 for
 * `operation`; with a backend wired it is a 2xx success. Strictly one of those —
 * a validation-array 400, a 401/403/404 or a 500 all fail. This is how a
 * "boundary passes" case is proven to have cleared the pipe rather than smoke.
 */
async function expectClearsValidation(res: APIResponse, operation: string): Promise<void> {
    const status = res.status();
    expect([200, 201, 400], `${operation}: unexpected status ${status}`).toContain(status);
    const body = (await res.json()) as {
        status?: string;
        message?: unknown;
        operation?: string;
    };
    if (status === 400) {
        // Must be the BUSINESS no-provider error, NOT a class-validator array.
        expect(
            Array.isArray(body.message),
            `${operation}: expected no-provider, got validation`,
        ).toBe(false);
        expect(body.status).toBe('error');
        expect(body.operation).toBe(operation);
        expect(String(body.message)).toBe(NO_PROVIDER_MSG);
    } else {
        expect(body.status).toBe('success');
    }
}

/** Assert a ValidationPipe rejection whose message array contains `needle`. */
async function expectValidationError(res: APIResponse, needle: string): Promise<void> {
    expect(res.status(), `expected 400 validation for "${needle}"`).toBe(400);
    const body = (await res.json()) as { error?: string; message?: unknown };
    expect(body.error).toBe('Bad Request');
    expect(Array.isArray(body.message)).toBe(true);
    expect(JSON.stringify(body.message)).toContain(needle);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. forbidNonWhitelisted — an extra unknown property is rejected everywhere.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — forbidNonWhitelisted (extra unknown property → 400)', () => {
    test('save rejects an unknown body property with the exact whitelisting message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', bogusField: 'x' },
        });
        await expectValidationError(res, 'property bogusField should not exist');
    });

    test('every body-DTO endpoint (search/context/open-session) rejects an unknown property', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const cases: Array<{ label: string; path: string; data: Record<string, unknown> }> = [
            { label: 'search', path: '/search', data: { query: 'q', nope: 1 } },
            { label: 'context', path: '/context', data: { nope: 1 } },
            { label: 'open-session', path: '/sessions', data: { metadata: { a: 1 }, nope: 1 } },
        ];
        for (const c of cases) {
            const res = await request.post(`${AM}${c.path}`, { headers: H, data: c.data });
            await expectValidationError(res, 'property nope should not exist');
        }
    });

    test('open-session rejects a `content` property — it belongs to SaveMemoryDto, not OpenSessionDto', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // `content` is a valid SaveMemoryDto field but foreign to OpenSessionDto,
        // so the whitelist rejects it by name (proves per-DTO whitelisting, not a
        // shared allow-any bag).
        const res = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'x' },
        });
        await expectValidationError(res, 'property content should not exist');
    });

    test('the QUERY DTOs (list/close/delete) also whitelist — an unknown query param is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const list = await request.get(`${AM}/sessions?limit=5&bogus=1`, { headers: H });
        await expectValidationError(list, 'property bogus should not exist');

        const close = await request.post(`${AM}/sessions/sid/close?bogus=1`, { headers: H });
        await expectValidationError(close, 'property bogus should not exist');

        const del = await request.delete(`${AM}/entries/eid?bogus=1`, { headers: H });
        await expectValidationError(del, 'property bogus should not exist');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong-TYPE per field.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — wrong-type field validation', () => {
    test('save content: number, null and array all fail with "content must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const bad of [123, null, ['a']]) {
            const res = await request.post(`${AM}/save`, { headers: H, data: { content: bad } });
            await expectValidationError(res, 'content must be a string');
        }
    });

    test('save projectId + sessionId reject a numeric value with the string-type message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const proj = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', projectId: 123 },
        });
        await expectValidationError(proj, 'projectId must be a string');

        const sess = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', sessionId: 123 },
        });
        await expectValidationError(sess, 'sessionId must be a string');
    });

    test('save tags: a non-string element is rejected by the per-element string rule', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', tags: [123] },
        });
        await expectValidationError(res, 'each value in tags must be a string');
    });

    test('search query: a numeric value fails with "query must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/search`, {
            headers: authedHeaders(user.access_token),
            data: { query: 123 },
        });
        await expectValidationError(res, 'query must be a string');
    });

    test('search limit (body): a non-numeric string fails @IsNumber', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/search`, {
            headers: authedHeaders(user.access_token),
            data: { query: 'q', limit: 'abc' },
        });
        await expectValidationError(res, 'limit must be a number');
    });

    test('context maxTokens (body): a non-numeric string fails @IsNumber', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/context`, {
            headers: authedHeaders(user.access_token),
            data: { maxTokens: 'abc' },
        });
        await expectValidationError(res, 'maxTokens must be a number');
    });

    test('context purpose: a numeric value fails with "purpose must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/context`, {
            headers: authedHeaders(user.access_token),
            data: { purpose: 123 },
        });
        await expectValidationError(res, 'purpose must be a string');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Metadata shape nuances (@IsObject + byte-cap interplay).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — metadata shape validation', () => {
    test('metadata as an ARRAY yields exactly the "must be an object" message (byte-cap passes for arrays)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', metadata: [1, 2, 3] },
        });
        await expectValidationError(res, 'metadata must be an object');
        // An array is `typeof === 'object'`, so the byte-cap constraint does NOT
        // fire — only the @IsObject rule does. Pin that it is the SINGLE message.
        const msgs = await validationMessages(res);
        expect(msgs).toContain('metadata must be an object');
        expect(msgs).not.toContain('metadata must serialise to <= 8192 bytes');
    });

    test('metadata as a SCALAR (number/boolean) trips BOTH the object rule and the byte-cap', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const scalar of [5, true]) {
            const res = await request.post(`${AM}/save`, {
                headers: H,
                data: { content: 'c', metadata: scalar },
            });
            expect(res.status()).toBe(400);
            const msgs = await validationMessages(res);
            // A non-object scalar fails @IsObject AND the byte-cap constraint
            // (which returns false for `typeof value !== 'object'`).
            expect(msgs).toContain('metadata must be an object');
            expect(msgs).toContain('metadata must serialise to <= 8192 bytes');
        }
    });

    test('metadata `null` is treated as absent (@IsOptional) and reaches the facade', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // null short-circuits @IsOptional → the field is skipped, not type-checked,
        // so the request clears validation and surfaces the no-provider 400.
        const save = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 'c', metadata: null },
        });
        await expectClearsValidation(save, 'saveMemory');

        const open = await request.post(`${AM}/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { metadata: null },
        });
        await expectClearsValidation(open, 'openSession');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Boundary values AT the exact cap pass; one over rejects.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — length boundaries (at-cap passes, over-cap rejects)', () => {
    test('save content: exactly 64000 chars clears validation; 64001 is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const atCap = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'x'.repeat(64_000) },
        });
        await expectClearsValidation(atCap, 'saveMemory');

        const overCap = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'x'.repeat(64_001) },
        });
        await expectValidationError(overCap, 'content must be shorter than or equal to 64000');
    });

    test('save projectId: exactly 128 chars clears validation; 129 is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const atCap = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', projectId: 'p'.repeat(128) },
        });
        await expectClearsValidation(atCap, 'saveMemory');

        const overCap = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', projectId: 'p'.repeat(129) },
        });
        await expectValidationError(
            overCap,
            'projectId must be shorter than or equal to 128 characters',
        );
    });

    test('save tags-element (128) + sessionId (128) at the exact cap clear validation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const tag = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', tags: ['t'.repeat(128)] },
        });
        await expectClearsValidation(tag, 'saveMemory');

        const sess = await request.post(`${AM}/save`, {
            headers: H,
            data: { content: 'c', sessionId: 's'.repeat(128) },
        });
        await expectClearsValidation(sess, 'saveMemory');
    });

    test('search query at the exact 2000-char cap clears validation', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/search`, {
            headers: authedHeaders(user.access_token),
            data: { query: 'q'.repeat(2_000) },
        });
        await expectClearsValidation(res, 'searchMemory');
    });

    test('context purpose at the exact 64-char cap clears validation', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${AM}/context`, {
            headers: authedHeaders(user.access_token),
            data: { purpose: 'u'.repeat(64) },
        });
        await expectClearsValidation(res, 'buildContext');
    });

    test('save content EMPTY string + search query EMPTY string clear validation (no @IsNotEmpty)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const save = await request.post(`${AM}/save`, { headers: H, data: { content: '' } });
        await expectClearsValidation(save, 'saveMemory');

        const search = await request.post(`${AM}/search`, { headers: H, data: { query: '' } });
        await expectClearsValidation(search, 'searchMemory');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Numeric range boundaries + float coercion.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — numeric range boundaries + coercion', () => {
    test('search limit at both range edges (1 and 100) clears validation', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const limit of [1, 100]) {
            const res = await request.post(`${AM}/search`, {
                headers: H,
                data: { query: 'q', limit },
            });
            await expectClearsValidation(res, 'searchMemory');
        }
    });

    test('context maxTokens UPPER bound: 64000 clears validation, 64001 rejects', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const atLow = await request.post(`${AM}/context`, {
            headers: H,
            data: { maxTokens: 100 },
        });
        await expectClearsValidation(atLow, 'buildContext');

        const atHigh = await request.post(`${AM}/context`, {
            headers: H,
            data: { maxTokens: 64_000 },
        });
        await expectClearsValidation(atHigh, 'buildContext');

        const over = await request.post(`${AM}/context`, {
            headers: H,
            data: { maxTokens: 64_001 },
        });
        await expectValidationError(over, 'maxTokens must not be greater than 64000');
    });

    test('a FLOAT limit satisfies @IsNumber on both the search body and the list query param', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // @IsNumber has no integer constraint, so 5.5 passes the numeric checks.
        const bodyFloat = await request.post(`${AM}/search`, {
            headers: H,
            data: { query: 'q', limit: 5.5 },
        });
        await expectClearsValidation(bodyFloat, 'searchMemory');

        // The list ?limit is @Type(Number)-coerced from the "5.5" string, then
        // passes @IsNumber/@Min/@Max → reaches the facade.
        const queryFloat = await request.get(`${AM}/sessions?limit=5.5`, { headers: H });
        await expectClearsValidation(queryFloat, 'listSessions');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. workId UUID edge variants.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — workId UUID edge variants', () => {
    test('save workId: an empty string and a short near-miss both fail the UUID rule', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const bad of ['', '12345']) {
            const res = await request.post(`${AM}/save`, {
                headers: H,
                data: { content: 'c', workId: bad },
            });
            await expectValidationError(res, 'workId must be a UUID');
        }
    });

    test('close + delete: a near-miss workId query param fails the UUID rule before ownership', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const close = await request.post(`${AM}/sessions/sid/close?workId=12345`, { headers: H });
        await expectValidationError(close, 'workId must be a UUID');

        const del = await request.delete(`${AM}/entries/eid?workId=12345`, { headers: H });
        await expectValidationError(del, 'workId must be a UUID');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Gate ordering — ValidationPipe precedes the handler ownership check.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Memory — gate ordering (validation precedes ownership + message aggregation)', () => {
    test('a body validation error pre-empts the ownership check for an unknown workId (validation 400, not 404)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // Missing content + a well-formed-but-nonexistent workId: if ownership ran
        // first this would be 404 "Work not found". The ValidationPipe runs FIRST,
        // so it is a validation 400 about content — the Work is never resolved.
        const res = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { workId: '99999999-9999-4999-8999-999999999999' },
        });
        await expectValidationError(res, 'content must be a string');
        // And crucially NOT the ownership 404 message.
        expect(JSON.stringify(await validationMessages(res))).not.toContain('not found');
    });

    test('multiple field violations aggregate into a single message array', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // A bad content type AND a malformed workId → the pipe reports BOTH in one
        // 400 array rather than short-circuiting on the first.
        const res = await request.post(`${AM}/save`, {
            headers: authedHeaders(user.access_token),
            data: { content: 123, workId: 'nope', projectId: `p-${stamp()}` },
        });
        expect(res.status()).toBe(400);
        const msgs = await validationMessages(res);
        expect(msgs).toContain('content must be a string');
        expect(msgs).toContain('workId must be a UUID');
    });
});
