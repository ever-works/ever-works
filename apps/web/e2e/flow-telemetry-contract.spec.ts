import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-telemetry-contract.spec.ts — boundary-precise, no-PII-echo, and
 * route-scoped-throttle contracts for the PUBLIC zero-friction funnel sink
 * `POST /api/telemetry/funnel` (TelemetryController, `@Public()` +
 * `@Throttle({ long: { limit: 60, ttl: 60_000 } })`). Every status / message /
 * header below was probed live against the API at :3100 before assertion.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this file deliberately AVOIDS what the two existing
 * telemetry specs already pin, and covers the complementary surface:
 *
 *   - `telemetry.spec.ts`               : a !5xx smoke of both endpoints only.
 *   - `flow-onboarding-telemetry.spec.ts`: the 8-event allow-list 204s, the
 *        funnelStep 0/9 edges, a 3-char correlationId, a non-ISO timestamp,
 *        a `bogusTop` forbidNonWhitelisted key, a 5000-char oversized blob,
 *        workId>64, auth-ignored, GET-404, the disjoint onboarding/funnel
 *        allow-lists, onboarding-relay 401, and state-isolation invariants.
 *   - `flow-rate-limit-throttle.spec.ts`: the GLOBAL named-tier throttler on
 *        auth/health routes (documents the GLOBAL long tier as 1000) — it
 *        never touches the telemetry route, whose @Throttle OVERRIDES long to
 *        60 (asserted here).
 *
 * What's NEW here (all probed): the EXACT 4096-byte payload boundary
 * (4096→204 / 4097→400 with a single-string controller message, not an array);
 * the correlationId regex LENGTH boundaries (7→400, 8→204, 64→204, 65→400);
 * the userId @MaxLength(64) boundary (mirror of the existing workId-only case);
 * @IsInt rejection of a FLOAT funnelStep (distinct from the Min/Max edges);
 * the NO-PII-ECHO guarantee (a 400 never reflects the rejected attacker value);
 * the `extra.userId`/`extra.workId` identity-strip path returning 204 (not a
 * 400/500); the FULL non-GET method matrix (PUT/DELETE/PATCH→404); the
 * route-scoped `X-RateLimit-Limit-long: 60` override header; and the
 * aggregated empty-body 400 enumerating EVERY missing envelope field.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, http://127.0.0.1:3100, before writing):
 *   POST /api/telemetry/funnel  body: FunnelEventDto
 *     { event, funnelStep:1..8 int, timestamp:ISO8601,
 *       correlationId:/^[A-Za-z0-9_-]{8,64}$/, extra?:object,
 *       workId?:<=64, userId?:<=64 }
 *   - well-formed (anonymous)        -> 204, empty body
 *   - total wire bytes == 4096       -> 204  (guard is `> MAX_PAYLOAD_BYTES`)
 *   - total wire bytes == 4097       -> 400  { message: 'telemetry payload too large' }  (STRING, not array)
 *   - correlationId 7 chars          -> 400 ["correlationId must be 8-64 chars, alphanumeric/_-"]
 *   - correlationId 8 / 64 chars     -> 204
 *   - correlationId 65 chars         -> 400 (same message)
 *   - userId 64 chars                -> 204 ; userId 65 chars -> 400 ["userId must be shorter than or equal to 64 characters"]
 *   - funnelStep 1.5 (float)         -> 400 ["funnelStep must be an integer number"]
 *   - rejected value NEVER echoed    -> the 400 message contains ONLY the rule text, not the offending PII string
 *   - extra:{userId,workId,...}      -> 204 (identity keys stripped server-side; never a 400/500)
 *   - PUT / DELETE / PATCH           -> 404 (POST-only route)
 *   - 204 response headers           -> X-RateLimit-Limit-long: 60  (route @Throttle override; GLOBAL long is 1000)
 *   - {} empty body                  -> 400, message ARRAY enumerating event + funnelStep + timestamp + correlationId rules
 *
 * CONSTRAINTS:
 *   • No PostHog sink in CI; `funnel.emit` is fire-and-forget, so a 204 means
 *     "accepted at the wire", never "delivered". We pin only the wire contract.
 *   • The funnel @Throttle is 60/min/IP — far above what any single test emits;
 *     we never deliberately trip it (a 429 would be cross-spec flaky).
 *   • Anonymous by design: the funnel is @Public(), so these flows need no
 *     user. The one authed user (userId-boundary flow) is a FRESH
 *     registerUserViaAPI() purely to source a real-ish id; full isolation.
 *   • Unique suffixes come from a per-test counter (never a module-scope clock).
 */

const FUNNEL = `${API_BASE}/api/telemetry/funnel`;
const VALID_EVENT = 'zero_friction.landing_prompt_submit';
const MAX_PAYLOAD_BYTES = 4096;

/** Per-test monotonic counter → unique-but-deterministic suffixes without a
 *  module-scope clock call (module scope runs at collection on EVERY shard). */
let seq = 0;

/** A regex-valid correlationId (8-64 [A-Za-z0-9_-]) seeded off the test title. */
function corrId(tag: string): string {
    seq += 1;
    const raw = `e2e${tag}${seq}`.replace(/[^A-Za-z0-9_-]/g, '');
    // Pad to >=8 and clamp to <=64 so the envelope is always shape-valid.
    return raw.padEnd(8, '0').slice(0, 64);
}

/** A well-formed minimal funnel envelope for the given event + step. */
function envelope(event: string, funnelStep: number, correlationId: string) {
    return { event, funnelStep, timestamp: new Date().toISOString(), correlationId };
}

/** POST an anonymous funnel event (no auth — the route is @Public()). */
function postFunnel(request: APIRequestContext, data: unknown) {
    return request.post(FUNNEL, { data });
}

// ─── 1. exact 4096-byte payload boundary (accept) ─────────────────────────────

test('funnel accepts a payload of EXACTLY 4096 wire bytes (the `> MAX` guard is inclusive of the cap)', async ({
    request,
}) => {
    // The controller rejects only when rawSize `> 4096`. Build an `extra.blob`
    // sized so the serialized envelope is byte-for-byte 4096 — the largest
    // payload the public sink must still accept. Playwright serializes `data`
    // with JSON.stringify, the same bytes the body-parser `verify` hook captures.
    const cid = corrId('cap');
    const base = { ...envelope(VALID_EVENT, 1, cid), extra: { blob: '' } };
    const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8');
    // overhead counts the two quotes of the empty blob; each added char is +1 byte.
    const blobLen = MAX_PAYLOAD_BYTES - overhead;
    const body = { ...base, extra: { blob: 'x'.repeat(blobLen) } };
    expect(
        Buffer.byteLength(JSON.stringify(body), 'utf8'),
        'crafted body is exactly 4096 bytes',
    ).toBe(MAX_PAYLOAD_BYTES);

    const res = await postFunnel(request, body);
    expect(res.status(), 'exactly-4096-byte payload is accepted').toBe(204);
    expect((await res.text()).length, '204 has an empty body').toBe(0);
});

// ─── 2. exact 4097-byte payload boundary (reject, controller-string message) ──

test('funnel rejects a payload ONE byte over the 4096 cap with the controller string message (not a class-validator array)', async ({
    request,
}) => {
    const cid = corrId('cap1');
    const base = { ...envelope(VALID_EVENT, 1, cid), extra: { blob: '' } };
    const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8');
    const blobLen = MAX_PAYLOAD_BYTES - overhead + 1; // one byte over the cap
    const body = { ...base, extra: { blob: 'x'.repeat(blobLen) } };
    expect(
        Buffer.byteLength(JSON.stringify(body), 'utf8'),
        'crafted body is exactly 4097 bytes',
    ).toBe(MAX_PAYLOAD_BYTES + 1);

    const res = await postFunnel(request, body);
    expect(res.status(), 'one-byte-over payload is rejected').toBe(400);
    const json = await res.json();
    // The controller's own guard returns a SINGLE string message — distinct from
    // the class-validator array shape every field-level rejection uses. Pinning
    // the type guards against a refactor that would change the wire shape.
    expect(typeof json.message, 'controller size-guard message is a plain string').toBe('string');
    expect(json.message).toBe('telemetry payload too large');
    expect(json.statusCode).toBe(400);
});

// ─── 3. correlationId regex LENGTH boundaries (7/8/64/65) ─────────────────────

test('funnel correlationId enforces the 8..64 length boundary exactly (7→400, 8→204, 64→204, 65→400)', async ({
    request,
}) => {
    // The cross-service trace key must match /^[A-Za-z0-9_-]{8,64}$/. The existing
    // suite only probes a 3-char id; here we pin BOTH edges of the inclusive range
    // so a future widen/shrink of the bound is caught at both ends.
    const cases: Array<{ len: number; expected: number }> = [
        { len: 7, expected: 400 },
        { len: 8, expected: 204 },
        { len: 64, expected: 204 },
        { len: 65, expected: 400 },
    ];
    for (const c of cases) {
        const cid = 'a'.repeat(c.len);
        const res = await postFunnel(request, envelope(VALID_EVENT, 1, cid));
        expect(res.status(), `correlationId of ${c.len} chars → ${c.expected}`).toBe(c.expected);
        if (c.expected === 400) {
            const json = await res.json();
            expect(JSON.stringify(json.message)).toContain('correlationId must be 8-64 chars');
        }
    }
});

// ─── 4. userId optional passthrough @MaxLength(64) boundary ───────────────────

test('funnel userId passthrough enforces @MaxLength(64): 64 chars accepted, 65 rejected', async ({
    request,
}) => {
    // `userId` is an OPTIONAL bounded passthrough (becomes the PostHog distinctId
    // downstream). The existing suite probes only the workId>64 edge; this pins
    // the symmetric userId bound, and the 64-char ACCEPT (not just the reject).
    const fresh = await registerUserViaAPI(request);
    const cid64 = corrId('uid64');
    const ok = await postFunnel(request, {
        ...envelope('zero_friction.claim_account', 8, cid64),
        userId: 'u'.repeat(64),
    });
    expect(ok.status(), 'userId of exactly 64 chars is accepted').toBe(204);

    const cid65 = corrId('uid65');
    const tooLong = await postFunnel(request, {
        ...envelope('zero_friction.claim_account', 8, cid65),
        userId: 'u'.repeat(65),
    });
    expect(tooLong.status(), 'userId of 65 chars is rejected').toBe(400);
    expect(JSON.stringify((await tooLong.json()).message)).toContain(
        'userId must be shorter than or equal to 64 characters',
    );

    // A genuine (short) user id from a real registration still rides through fine,
    // proving the bound rejects only the abusive over-length case, not real ids.
    const cidReal = corrId('uidreal');
    const real = await postFunnel(request, {
        ...envelope('zero_friction.claim_account', 8, cidReal),
        userId: fresh.user.id,
    });
    expect(real.status(), 'a real (short) userId passes the bound').toBe(204);
    expect(fresh.user.id.length, 'real user id is within the 64-char bound').toBeLessThanOrEqual(
        64,
    );
});

// ─── 5. funnelStep must be an INTEGER (@IsInt), float rejected ────────────────

test('funnel funnelStep rejects a non-integer (float 1.5) distinctly from the Min/Max range edges', async ({
    request,
}) => {
    // The Min(1)/Max(8) edges are already pinned elsewhere; @IsInt is a SEPARATE
    // constraint — a 1.5 lands inside [1,8] yet must still 400 so PostHog's step
    // axis stays a dense set of whole numbers.
    const cid = corrId('float');
    const res = await postFunnel(request, {
        event: VALID_EVENT,
        funnelStep: 1.5,
        timestamp: new Date().toISOString(),
        correlationId: cid,
    });
    expect(res.status(), 'float funnelStep → 400').toBe(400);
    expect(JSON.stringify((await res.json()).message)).toContain(
        'funnelStep must be an integer number',
    );
});

// ─── 6. NO PII ECHO — a 400 never reflects the rejected attacker value ────────

test('funnel rejection responses NEVER echo the offending attacker-supplied value back to the caller', async ({
    request,
}) => {
    // The endpoint is @Public(), so the whole body is attacker-controlled. A
    // validation 400 must surface ONLY the rule text — never reflect the rejected
    // value — so the public sink can't be turned into a value-reflecting oracle /
    // self-XSS vector. We embed sentinel strings that would be obvious in any echo.
    const piiCorr = 'PII-SENTINEL-secret@evil.example-<script>';
    const badCorr = await postFunnel(request, {
        event: VALID_EVENT,
        funnelStep: 1,
        timestamp: new Date().toISOString(),
        correlationId: piiCorr,
    });
    expect(badCorr.status()).toBe(400);
    const badCorrBody = await badCorr.text();
    expect(badCorrBody, 'correlationId 400 does not echo the rejected value').not.toContain(
        'PII-SENTINEL',
    );
    expect(badCorrBody).not.toContain('secret@evil.example');
    expect(badCorrBody, 'still carries the rule text').toContain(
        'correlationId must be 8-64 chars',
    );

    // Same guarantee on the @MaxLength workId path: an over-long id carrying an
    // email + sentinel is rejected without the email/sentinel appearing in the body.
    const piiWorkId = `WORKID-SENTINEL-victim@example.com-${'x'.repeat(60)}`;
    const badWorkId = await postFunnel(request, {
        ...envelope('zero_friction.work_created', 4, corrId('piiwork')),
        workId: piiWorkId,
    });
    expect(badWorkId.status()).toBe(400);
    const badWorkIdBody = await badWorkId.text();
    expect(badWorkIdBody, 'workId 400 does not echo the rejected value').not.toContain(
        'WORKID-SENTINEL',
    );
    expect(badWorkIdBody).not.toContain('victim@example.com');
    expect(badWorkIdBody).toContain('workId must be shorter than or equal to 64 characters');
});

// ─── 7. identity-key stripping inside `extra` is accepted, never errors ───────

test('funnel accepts a hostile `extra` carrying userId/workId keys (silently stripped) — 204, not 400/500', async ({
    request,
}) => {
    // Security hardening: the controller strips `userId`/`workId` OUT of the
    // free-form `extra` bag before spreading it, so a malicious client cannot
    // inject/override the analytics distinctId or work attribution via `extra`.
    // The strip path must SUCCEED quietly (204) — it neither rejects the post nor
    // throws — while the dedicated top-level fields remain the only identity source.
    const cid = corrId('strip');
    const res = await postFunnel(request, {
        ...envelope('zero_friction.work_created', 4, cid),
        extra: {
            userId: 'evil-distinct-id',
            workId: 'evil-work-attribution',
            // a legitimate per-event passthrough is preserved alongside the stripped keys
            promptLength: 42,
            nested: { a: 1 },
        },
        // the LEGITIMATE top-level identity fields still validate normally
        workId: 'w'.repeat(20),
        userId: 'u'.repeat(20),
    });
    expect(res.status(), 'hostile extra identity keys are stripped, post still accepted').toBe(204);
    expect((await res.text()).length, 'still an empty 204 body').toBe(0);
});

// ─── 8. method matrix — the funnel route is POST-only (PUT/DELETE/PATCH → 404) ─

test('funnel route is POST-only: PUT, DELETE and PATCH all 404 (no handler registered for the verb)', async ({
    request,
}) => {
    // The existing suite only pins GET→404. A telemetry sink must not expose any
    // other mutating/idempotent verb that a scanner could probe; pin the full
    // non-POST matrix so a future @Put/@Patch on the controller is caught.
    const put = await request.put(FUNNEL, { data: {} });
    expect(put.status(), 'PUT funnel → 404').toBe(404);

    const del = await request.delete(FUNNEL);
    expect(del.status(), 'DELETE funnel → 404').toBe(404);

    const patch = await request.patch(FUNNEL, { data: {} });
    expect(patch.status(), 'PATCH funnel → 404').toBe(404);
});

// ─── 9. route-scoped @Throttle override surfaces X-RateLimit-Limit-long: 60 ───

test('funnel response carries the route-scoped throttle override header (X-RateLimit-Limit-long: 60), distinct from the global 1000', async ({
    request,
}) => {
    // The controller decorates the route with @Throttle({ long: { limit: 60 } }),
    // OVERRIDING the global long tier (1000, per flow-rate-limit-throttle.spec.ts).
    // The named-tier headers are emitted on every response; we assert the long
    // tier reflects the per-route 60, proving the override is live on THIS route.
    const res = await postFunnel(request, envelope(VALID_EVENT, 1, corrId('thr')));
    expect(res.status()).toBe(204);
    const headers = res.headers();
    expect(headers['x-ratelimit-limit-long'], 'route @Throttle long override = 60').toBe('60');
    // The short/medium tiers fall through to the global config and must still be
    // present + numeric (the named-tier taxonomy is emitted on every response).
    expect(
        Number(headers['x-ratelimit-limit-short']),
        'short tier limit is numeric',
    ).toBeGreaterThan(0);
    expect(
        Number(headers['x-ratelimit-remaining-long']),
        'remaining-long is a non-negative number',
    ).toBeGreaterThanOrEqual(0);
});

// ─── 10. empty body — aggregated 400 enumerating every missing envelope field ─

test('funnel empty-body 400 enumerates ALL four missing envelope-field rules (event allow-list, funnelStep int+range, ISO timestamp, correlationId regex)', async ({
    request,
}) => {
    // A `{}` post fails every required-field constraint at once. The global
    // ValidationPipe returns the AGGREGATED message array — this single response
    // is the server-authoritative envelope contract, so we pin that each of the
    // four fields contributes its rule (and the event rule enumerates the
    // 8-event allow-list, doubling as the canonical catalog).
    const res = await postFunnel(request, {});
    expect(res.status(), 'empty body → 400').toBe(400);
    const json = await res.json();
    expect(Array.isArray(json.message), 'field-level rejection is an array of rules').toBe(true);
    const msg = JSON.stringify(json.message);
    // event: allow-list enumerated (first + last canonical names present).
    expect(msg).toContain('must be one of the following values');
    expect(msg).toContain('zero_friction.landing_prompt_submit');
    expect(msg).toContain('zero_friction.claim_account');
    // funnelStep: both the integer constraint and the range bounds are reported.
    expect(msg).toContain('funnelStep must be an integer number');
    expect(msg).toContain('funnelStep must not be less than 1');
    expect(msg).toContain('funnelStep must not be greater than 8');
    // timestamp + correlationId rules.
    expect(msg).toContain('timestamp must be a valid ISO 8601 date string');
    expect(msg).toContain('correlationId must be 8-64 chars');
    expect(json.error).toBe('Bad Request');
    expect(json.statusCode).toBe(400);
});
