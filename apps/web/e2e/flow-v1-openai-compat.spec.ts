import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * v1 OpenAI-compatible chat-completions facade — deep contract pinning.
 *
 * Target: apps/api/src/ai-conversation/openai-compat.controller.ts
 *         (+ openai-compat.service.ts + dto/openai-compat.dto.ts)
 * Route:  POST /api/v1/chat/completions   (@Controller('api/v1'), @HttpCode(200))
 *
 * ── NON-DUPLICATION ────────────────────────────────────────────────
 * `openai-compat.spec.ts` already covers, SHALLOWLY:
 *   - path discovery across candidate shapes,
 *   - unauth POST → 401/403,
 *   - one authed valid POST → "< 500".
 * This file does NOT repeat path discovery (the live route is fixed at
 * /api/v1/chat/completions) and instead deepens the CONTRACT: the exact
 * keyless error envelope (status + shape), DTO validation matrix
 * (messages required/shape, nested message validation, typed scalar
 * fields, forbid-non-whitelisted vs @Allow()-listed fields), the
 * streaming vs non-streaming acceptance + distinct error envelopes,
 * auth modes, and secret-redaction of the provider error message.
 * `chat-api*.spec.ts` / `flow-chat-*.spec.ts` exercise the web `/api/chat`
 * proxy + conversation lifecycle — a DIFFERENT surface from this raw
 * OpenAI-wire facade.
 *
 * ── PROBED CONTRACTS (live keyless stack @ 127.0.0.1:3100, 2026-06-11) ─
 *   - Anonymous POST                       → 401
 *   - Bad bearer token                     → 401
 *   - GET (wrong method) on completions    → 404
 *   - Authed valid non-stream, NO LLM key  → 422
 *         { error: { message, type: 'provider_unavailable' } }
 *         message contains "Missing Authentication header" (upstream),
 *         NEVER a 5xx stacktrace.
 *   - `model` is OPTIONAL (omit → still reaches provider → 422).
 *   - messages missing / non-array         → 400
 *         { message: ["messages must be an array", ...],
 *           error: "Bad Request", statusCode: 400 }
 *   - nested message missing role          → 400 ("messages.0.role must be a string")
 *   - temperature wrong type (string)      → 400 ("temperature must be a number ...")
 *   - unknown top-level field (seed/logprobs) → 400 ("property X should not exist")
 *         (global forbidNonWhitelisted in effect)
 *   - DECLARED @Allow() field stream_options alone → passes validation → 422
 *   - tools[] function-tool def            → passes validation → 422
 *   - empty messages [] (passes IsArray)   → 422 (reaches provider)
 *   - stream:true, keyless                 → 502, Content-Type application/json,
 *         { error: { message, type: 'provider_error', code: 'ai_provider_error' } }
 *         (service writes the envelope BEFORE the SSE stream begins).
 *
 * Environment-adaptive: CI is keyless (no LLM provider key) so a REAL
 * completion is impossible — we assert the CONTRACT + error envelopes,
 * never completion content. If a provider key were wired, the happy
 * path would be 200; every assertion below tolerates that by treating
 * 200 as an explicitly-allowed alternative where it could occur.
 */

const V1_COMPLETIONS = '/api/v1/chat/completions';

function url(path: string): string {
    return `${API_BASE}${path}`;
}

// Minimal valid OpenAI-wire body.
function validBody(content = 'ping'): Record<string, unknown> {
    return { model: 'gpt-4o-mini', messages: [{ role: 'user', content }] };
}

/**
 * Fresh isolated user per mutation. Suffix derives from the test title
 * (NOT a module-scope clock) so collection stays side-effect free.
 */
async function freshToken(request: APIRequestContext, title: string): Promise<string> {
    const suffix = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24).toLowerCase();
    const u = await registerUserViaAPI(request, {
        email: `v1compat-${suffix}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    });
    return u.access_token;
}

test.describe('v1 OpenAI-compat — auth contract', () => {
    test('anonymous POST is rejected with 401 (no body leak)', async ({ request }) => {
        // Playwright's `request` fixture carries NO storageState cookies,
        // so this is a genuinely anonymous call.
        const res = await request.post(url(V1_COMPLETIONS), { data: validBody() });
        expect(res.status(), 'anonymous POST must be 401/403').toBeGreaterThanOrEqual(401);
        expect(res.status()).toBeLessThan(404);
        // Whatever the body, it must NOT be a 5xx stacktrace.
        expect(res.status()).toBeLessThan(500);
    });

    test('malformed bearer token is rejected with 401', async ({ request }) => {
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: { Authorization: 'Bearer not-a-real-token-zzz' },
            data: validBody(),
        });
        expect(res.status(), 'garbage bearer → 401').toBe(401);
    });

    test('GET on the completions route is 404 (POST-only contract)', async ({ request }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.get(url(V1_COMPLETIONS), { headers: authedHeaders(token) });
        expect(res.status(), 'wrong method must not reach the handler').toBe(404);
    });
});

test.describe('v1 OpenAI-compat — request validation (400 matrix)', () => {
    test('missing messages → 400 Bad Request with class-validator message array', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { model: 'gpt-4o-mini' },
        });
        expect(res.status(), 'no messages → 400').toBe(400);
        const body = await res.json();
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        expect(Array.isArray(body.message)).toBe(true);
        expect(
            (body.message as string[]).some((m) => /messages must be an array/i.test(m)),
            `expected a "messages must be an array" entry, got ${JSON.stringify(body.message)}`,
        ).toBe(true);
    });

    test('messages as a string (wrong type) → 400', async ({ request }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { model: 'gpt-4o-mini', messages: 'hello' },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect((body.message as string[]).join(' ')).toMatch(/messages must be an array/i);
    });

    test('nested message missing role → 400 with dotted path', async ({ request }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { model: 'gpt-4o-mini', messages: [{ content: 'hi' }] },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        // ValidateNested surfaces the index-dotted path.
        expect((body.message as string[]).join(' ')).toMatch(/messages\.0\.role/i);
    });

    test('temperature as a string → 400 (typed scalar enforced)', async ({ request }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { ...validBody(), temperature: 'hot' },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect((body.message as string[]).join(' ')).toMatch(/temperature must be a number/i);
    });

    test('unknown top-level field → 400 "property X should not exist" (forbidNonWhitelisted)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { ...validBody(), seed: 42 },
        });
        expect(res.status(), 'unknown field is rejected, not silently stripped').toBe(400);
        const body = await res.json();
        expect((body.message as string[]).join(' ')).toMatch(/property seed should not exist/i);
    });
});

test.describe('v1 OpenAI-compat — accepted bodies (validation passes, keyless → 422)', () => {
    // In CI there's no LLM key, so a body that PASSES validation reaches the
    // provider and yields the documented "provider_unavailable" 422 envelope.
    // With a key wired it would be 200 — both are non-5xx and accepted.

    test('valid non-streaming body → 422 provider-unavailable envelope (NOT a 5xx)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: validBody(),
        });
        // Keyless → 422; keyed → 200. Never 5xx.
        expect([200, 422], `unexpected status ${res.status()}`).toContain(res.status());
        if (res.status() === 422) {
            const body = await res.json();
            expect(body.error).toBeTruthy();
            expect(body.error.type).toBe('provider_unavailable');
            expect(typeof body.error.message).toBe('string');
            expect(body.error.message.length).toBeGreaterThan(0);
        }
    });

    test('model is OPTIONAL — omitting it still passes validation (→ 422, not 400)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'hi' }] },
        });
        // No 400 — model is @IsOptional. Reaches provider keyless → 422 (or 200 keyed).
        expect([200, 422], `model-less body should not 400; got ${res.status()}`).toContain(
            res.status(),
        );
    });

    test('declared @Allow() field stream_options passes validation (→ 422, not 400)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { ...validBody(), stream_options: { include_usage: true } },
        });
        // stream_options is an allow-listed optional field — must NOT be
        // rejected as an unknown property.
        expect([200, 422], `stream_options should be tolerated; got ${res.status()}`).toContain(
            res.status(),
        );
    });

    test('OpenAI-shaped tools[] function definition passes validation (→ 422)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: {
                ...validBody(),
                tools: [
                    {
                        type: 'function',
                        function: { name: 'get_weather', parameters: { type: 'object' } },
                    },
                ],
            },
        });
        expect([200, 422], `valid tools def should pass validation; got ${res.status()}`).toContain(
            res.status(),
        );
    });

    test('empty messages array passes IsArray and reaches the provider (→ 422)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { model: 'gpt-4o-mini', messages: [] },
        });
        // [] satisfies @IsArray; the controller does not enforce min-length,
        // so it reaches the provider rather than 400-ing.
        expect([200, 422], `empty messages → got ${res.status()}`).toContain(res.status());
    });
});

test.describe('v1 OpenAI-compat — streaming acceptance', () => {
    test('stream:true is accepted; keyless yields a 502 JSON error envelope (not a 5xx stacktrace)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: { ...validBody(), stream: true },
        });
        // Keyless: provider auth fails BEFORE the SSE stream begins, so the
        // service writes the JSON error envelope with a 502. Keyed: 200 +
        // text/event-stream. Both are accepted; a 4xx validation error is NOT.
        expect([200, 502], `stream request status ${res.status()}`).toContain(res.status());

        if (res.status() === 502) {
            const ctype = res.headers()['content-type'] || '';
            expect(ctype, 'pre-stream error must be JSON, not SSE').toContain('application/json');
            const body = await res.json();
            expect(body.error).toBeTruthy();
            expect(body.error.type).toBe('provider_error');
            expect(body.error.code).toBe('ai_provider_error');
            expect(typeof body.error.message).toBe('string');
        }
    });

    test('the keyless provider error message is sanitized — no raw key/secret tokens leak', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request, testInfo.title);
        const res = await request.post(url(V1_COMPLETIONS), {
            headers: authedHeaders(token),
            data: validBody(),
        });
        // Only meaningful in the keyless 422 path; skip the assertion if a
        // provider key happened to be wired (200).
        if (res.status() === 200) {
            test.info().annotations.push({ type: 'note', description: 'provider key wired; skipped redaction check' });
            return;
        }
        expect(res.status()).toBe(422);
        const body = await res.json();
        const message: string = body.error.message;
        // The upstream "Missing Authentication header" text surfaces, but the
        // sanitizer (secret-scan patterns) must strip any real secret token.
        expect(message).not.toMatch(/\bsk-[A-Za-z0-9_-]{10,}\b/);
        expect(message).not.toMatch(/\bsk-ant-[A-Za-z0-9_-]{10,}\b/);
        expect(message).not.toMatch(/\bAKIA[A-Z0-9]{16}\b/);
        // And it stays a bounded, human-readable string (sanitizer truncates
        // to ~300 chars + ellipsis).
        expect(message.length).toBeLessThanOrEqual(320);
    });
});
