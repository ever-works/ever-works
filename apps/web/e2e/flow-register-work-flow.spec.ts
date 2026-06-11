import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * flow-register-work-flow.spec.ts — DEEP, register-work-specific contract matrix
 * for the agent zero-friction onboarding controller
 * (apps/api/src/onboarding/onboarding.controller.ts → OnboardingService),
 * exposed as `POST /api/register-work` (+ `GET /api/register-work/:id` status).
 *
 * Every status, typed `code`, message and shape below was PROBED against the
 * LIVE stack (http://127.0.0.1:3100, sqlite CI driver, REQUIRE_EMAIL_VERIFICATION
 * off, GITHUB_APP_ID=999999 fake, NO real GitHub reachability) on 2026-06-11
 * BEFORE any assertion was written. This pins the platform's REAL behaviour.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THIS CONTROLLER TESTABLE-BUT-CONSTRAINED IN THIS ENV:
 *   • register-work is `@Public()` — identity is NOT the Ever Works `access_token`;
 *     it travels in the `X-GitHub-Token` HEADER. `OnboardingService.resolveGitHubIdentity`
 *     calls the real GitHub API. In this KEYLESS / fake-GitHub-App env that call
 *     ALWAYS fails → a successful 202 onboarding (account+Work creation, the
 *     `validated`→`queued` happy path) is UNREACHABLE locally. So this file pins
 *     the REACHABLE state machine: the validation gate (400), the credential
 *     resolution gate (401 malformed vs 403 unresolvable), and the status-read
 *     enumeration protection (404 not_found / 403 owner-mismatch). It asserts
 *     RECORDS / typed error CONTRACTS, never a completion (house rule: keyless env).
 *   • POST /api/register-work carries a TIGHT per-route `@Throttle(long:10/min/IP)`
 *     that is NOT disabled in e2e. Every POST (even a 400) consumes the bucket, and
 *     the bucket is shared per-IP across workers/shards. So: POST tests run SERIAL,
 *     go through a retry-on-429 helper, and are kept few. The GET status route has
 *     NO per-route @Throttle (rides the global long:1000/60s tier → effectively
 *     unlimited here) — the credential/enumeration/uuid contracts live on GET.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION (both siblings READ in full before writing this file):
 *   • flow-public-api-contract.spec.ts — pins the PUBLIC-SURFACE CENSUS + 3-tier
 *     rate-limit posture, treating register-work as ONE of many public routes with
 *     throttle-TOLERANT ".or 429" branching (it never asserts an exact typed code,
 *     only "4xx-ish, never 5xx, never 401"). This file goes DEEPER: it pins the
 *     EXACT typed `code` per branch and the 401-vs-403 credential distinction.
 *   • sec-pin-ssrf-contracts.spec.ts — pins ONLY the URL-SHAPE SSRF rejections
 *     (`repo` GITHUB_HTTPS_REPO regex, `webhookUrl` scheme regex) + the 403 control.
 *     This file deliberately does NOT re-assert those URL-shape rejections; it
 *     covers the NON-URL field bounds (email / agentId printable-ASCII / subdomain
 *     DNS / agentPayment object) and the credential + status + idempotency surface
 *     that sec-pin does not touch.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, http 3100, 2026-06-11):
 *   - POST /api/register-work, NO X-GitHub-Token header → 400
 *       { statusCode:400, code:'validation_error', message:'X-GitHub-Token header is required' }
 *       (controller-level guard, AFTER the feature flag, with a typed envelope).
 *   - POST /api/register-work, token present, body {} → 400 class-validator array
 *       { message:[...'repo must be a string'...], error:'Bad Request', statusCode:400 }.
 *   - POST + token + bad NON-URL fields → 400 class-validator array with the EXACT
 *       per-field message: email 'email must be an email'; agentId 'agentId must be
 *       printable ASCII'; subdomain 'subdomain must be DNS-safe (lowercase, hyphens)';
 *       agentPayment 'agentPayment must be an object'.
 *   - POST + valid DTO + unresolvable GitHub token → 403
 *       { statusCode:403, code:'gh_credential_invalid', message:'GitHub credential could not be resolved' }
 *       (DTO passed → reached resolveGitHubIdentity → GitHub API rejected the token).
 *   - POST + valid DTO + token shorter than 4 chars → 401
 *       { statusCode:401, code:'gh_credential_invalid', message:'GitHub credential is missing or malformed' }
 *       (the length<4 pre-check fires BEFORE any network call — distinct status from 403).
 *   - GET /api/register-work/:id, well-formed-but-unknown uuid, any token → 404
 *       { statusCode:404, code:'not_found', message:'unknown onboarding id' }
 *       (row lookup precedes credential resolution → unknown id is 404, not 403:
 *        no enumeration of which ids exist behind a token).
 *   - GET /api/register-work/:id, NO X-GitHub-Token header → 403
 *       { statusCode:403, code:'gh_credential_invalid', message:'X-GitHub-Token header is required' }.
 *   - GET /api/register-work/:id, NON-uuid id → 400 (ParseUUIDPipe)
 *       { message:'Validation failed (uuid is expected)', error:'Bad Request', statusCode:400 }.
 *   - Throttle asymmetry: POST exhausts at 10/min/IP → 429
 *       { statusCode:429, message:'ThrottlerException: Too Many Requests' }; the GET
 *       status route does NOT (5 rapid GETs all answer 404, none 429).
 */

const PARAM_UUID_UNKNOWN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_REPO = 'https://github.com/octocat/awesome-mcp';
// Length>=4 so it passes the malformed pre-check and reaches the GitHub call →
// guaranteed to be REJECTED by GitHub in this keyless env (never a real token).
const UNRESOLVABLE_GH_TOKEN = 'ghp_e2e_fake_unresolvable_token_000';

interface TypedError {
    statusCode?: number;
    code?: string;
    message?: string | string[];
    error?: string;
}

async function readJson(res: { json: () => Promise<unknown> }): Promise<TypedError> {
    return (await res.json()) as TypedError;
}

function messageArray(body: TypedError): string[] {
    return Array.isArray(body.message) ? body.message : [];
}

/**
 * POST /api/register-work with a retry that absorbs the per-route
 * @Throttle(long:10/min/IP). On a 429 (shared-IP bucket drained by a sibling
 * shard / the other worker), wait out the route's own reset window and retry
 * ONCE. A second 429 surfaces a `throttled` marker so the caller can skip the
 * contract assertion rather than red the run on infrastructure contention.
 */
async function postRegisterWork(
    request: APIRequestContext,
    body: Record<string, unknown>,
    githubToken?: string,
): Promise<{ status: number; body: TypedError; throttled: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (githubToken) headers['X-GitHub-Token'] = githubToken;

    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await request.post(`${API_BASE}/api/register-work`, { headers, data: body });
        if (res.status() !== 429) {
            return { status: res.status(), body: await readJson(res), throttled: false };
        }
        // Drained bucket: honour the route's reset window then try once more.
        const retryAfter = Number(res.headers()['retry-after-long'] ?? '');
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 5000;
        if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 65_000)));
        } else {
            return { status: 429, body: await readJson(res), throttled: true };
        }
    }
    return { status: 429, body: {}, throttled: true };
}

async function getStatus(
    request: APIRequestContext,
    id: string,
    githubToken?: string,
): Promise<{ status: number; body: TypedError }> {
    const headers: Record<string, string> = {};
    if (githubToken) headers['X-GitHub-Token'] = githubToken;
    const res = await request.get(`${API_BASE}/api/register-work/${id}`, { headers });
    return { status: res.status(), body: await readJson(res) };
}

// POSTs share the per-IP @Throttle(long:10/min) bucket — run them in declared
// order so the retry-on-429 helper never races itself across the two workers.
test.describe.configure({ mode: 'serial' });

test.describe('register-work — credential & status state machine (GET, unthrottled)', () => {
    test('GET status: unknown-but-well-formed uuid → 404 not_found (no id enumeration behind a token)', async ({
        request,
    }) => {
        const { status, body } = await getStatus(request, PARAM_UUID_UNKNOWN, UNRESOLVABLE_GH_TOKEN);
        // Row lookup precedes credential resolution: an unknown id is a clean 404,
        // NOT a 403 — so a caller cannot probe which onboarding ids exist.
        expect(status, 'unknown onboarding id is 404').toBe(404);
        expect(body.statusCode).toBe(404);
        expect(body.code, 'typed not_found code').toBe('not_found');
        expect(body.message).toBe('unknown onboarding id');
    });

    test('GET status: missing X-GitHub-Token header → 403 gh_credential_invalid (never 401, public route)', async ({
        request,
    }) => {
        const { status, body } = await getStatus(request, PARAM_UUID_UNKNOWN);
        expect(status, 'status read without proof token is forbidden').toBe(403);
        expect(body.statusCode).toBe(403);
        expect(body.code, 'typed credential code on the status gate').toBe('gh_credential_invalid');
        expect(body.message).toBe('X-GitHub-Token header is required');
    });

    test('GET status: non-uuid id → 400 ParseUUIDPipe (validation precedes the handler)', async ({
        request,
    }) => {
        const { status, body } = await getStatus(request, 'not-a-valid-uuid', UNRESOLVABLE_GH_TOKEN);
        expect(status, 'non-uuid path param is rejected by the pipe').toBe(400);
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        expect(body.message).toBe('Validation failed (uuid is expected)');
    });

    test('GET status: token-gate runs BEFORE the uuid lookup branch — a no-token read is 403 even for a valid-shaped id', async ({
        request,
    }) => {
        // Distinct from the 404 case above: with NO token the request is refused
        // at the proof-token gate (403) — it never reaches the row lookup, so a
        // valid-shaped unknown id does NOT leak as 404 to an unauthenticated caller.
        const { status, body } = await getStatus(request, PARAM_UUID_UNKNOWN);
        expect(status).toBe(403);
        expect(body.code).toBe('gh_credential_invalid');
        // And a different valid-shaped id behaves identically (no per-id fork).
        const second = await getStatus(request, '11111111-2222-3333-4444-555555555555');
        expect(second.status).toBe(403);
        expect(second.body.code).toBe('gh_credential_invalid');
    });

    test('GET status: route is NOT bound by the POST @Throttle(10/min) — 5 rapid reads all answer 404, none 429', async ({
        request,
    }) => {
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            const { status } = await getStatus(request, PARAM_UUID_UNKNOWN, UNRESOLVABLE_GH_TOKEN);
            statuses.push(status);
        }
        expect(statuses, 'every status read resolves to the not_found contract').toEqual([
            404, 404, 404, 404, 404,
        ]);
        expect(statuses, 'GET status never trips the tight per-route POST throttle').not.toContain(
            429,
        );
    });
});

test.describe('register-work — registration validation gate (POST, throttle-budgeted)', () => {
    test('POST: missing X-GitHub-Token header → 400 validation_error (typed envelope, before any GitHub call)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(request, { repo: VALID_REPO });
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        expect(status, 'a missing GH token is a 400, not a 403').toBe(400);
        expect(body.statusCode).toBe(400);
        expect(body.code, 'controller-level typed validation_error').toBe('validation_error');
        expect(body.message).toBe('X-GitHub-Token header is required');
    });

    test('POST: empty body (token present) → 400 class-validator array citing the required repo field', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(request, {}, UNRESOLVABLE_GH_TOKEN);
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'missing repo fails DTO validation').toBe(400);
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        const msgs = messageArray(body);
        expect(msgs, 'class-validator surfaces a message array').not.toHaveLength(0);
        expect(
            msgs.some((m) => m.includes('repo must be a string')),
            'the required `repo` field is named in the validation array',
        ).toBeTruthy();
    });

    test('POST: bad NON-URL optional fields each reject with their EXACT per-field message', async ({
        request,
    }) => {
        // Deliberately NOT the URL-shape SSRF rejections (those are sec-pin-ssrf's
        // turf). These are the non-URL DTO bounds: email / agentId / subdomain.
        const { status, body, throttled } = await postRegisterWork(
            request,
            {
                repo: VALID_REPO,
                email: 'not-an-email',
                agentId: 'agent\n123', // newline → not printable ASCII
                subdomain: 'MyApp', // uppercase → not DNS-safe
            },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'bad optional fields fail DTO validation before any GitHub call').toBe(400);
        const msgs = messageArray(body);
        expect(msgs).toContain('email must be an email');
        expect(msgs).toContain('agentId must be printable ASCII');
        expect(msgs).toContain('subdomain must be DNS-safe (lowercase, hyphens)');
    });

    test('POST: agentPayment non-object → 400 IsObject (the reserved v2 payment envelope is type-checked even though ignored at v1)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, agentPayment: 'not-an-object' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status).toBe(400);
        const msgs = messageArray(body);
        expect(msgs).toContain('agentPayment must be an object');
    });

    test('POST: subdomain length boundary (2 chars) → 400 Length(3,63)', async ({ request }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, subdomain: 'ab' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'too-short subdomain fails the @Length bound').toBe(400);
        const msgs = messageArray(body);
        expect(
            msgs.some((m) => m.toLowerCase().includes('subdomain')),
            'the subdomain length violation is reported',
        ).toBeTruthy();
    });
});

test.describe('register-work — credential resolution gate (POST, throttle-budgeted)', () => {
    test('POST: valid DTO + UNRESOLVABLE GitHub token → 403 gh_credential_invalid (DTO passed, GitHub API rejected the token — no 202, no side effect)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        // The DTO is valid, so we passed validation and reached resolveGitHubIdentity;
        // the keyless/fake-GitHub-App env makes the token unresolvable → 403. Crucially
        // this is NEVER a 202 here (no real GitHub) — the controller has no completion path.
        expect(status, 'a valid DTO with a dead token is forbidden, not accepted').toBe(403);
        expect(body.statusCode).toBe(403);
        expect(body.code, 'typed credential-invalid code at the resolution gate').toBe(
            'gh_credential_invalid',
        );
        expect(body.message).toBe('GitHub credential could not be resolved');
    });

    test('POST: token shorter than 4 chars → 401 (distinct from the 403 above — the malformed pre-check fires before any network call)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO },
            'ab',
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        // length<4 short-circuits in resolveGitHubIdentity with a 401 BEFORE the
        // GitHub call — proving the credential gate distinguishes "malformed"
        // (401) from "well-formed but unresolvable" (403).
        expect(status, 'a malformed (too-short) token is 401, not 403').toBe(401);
        expect(body.statusCode).toBe(401);
        expect(body.code).toBe('gh_credential_invalid');
        expect(body.message).toBe('GitHub credential is missing or malformed');
    });

    test('POST: Idempotency-Key header is accepted by the contract (does not alter the credential-gate outcome for a dead token)', async ({
        request,
    }) => {
        // The Stripe-convention Idempotency-Key header is optional and must not
        // change the validation/credential outcome — a dead token still 403s, the
        // header is simply carried into the (unreached-here) persistence layer.
        const res = await request.post(`${API_BASE}/api/register-work`, {
            headers: {
                'Content-Type': 'application/json',
                'X-GitHub-Token': UNRESOLVABLE_GH_TOKEN,
                'Idempotency-Key': '99999999-8888-7777-6666-555555555555',
            },
            data: { repo: VALID_REPO },
        });
        test.skip(res.status() === 429, 'shared-IP @Throttle bucket drained');
        const body = (await res.json()) as TypedError;
        // Either the credential gate (403) — the dominant outcome — proving the
        // Idempotency-Key header is accepted and does not fork the contract.
        expect(res.status(), 'idempotency-key does not change the dead-token outcome').toBe(403);
        expect(body.code).toBe('gh_credential_invalid');
    });
});
