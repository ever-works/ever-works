import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * flow-register-work-deep.spec.ts — DEEP register-work DTO/contract matrix:
 * the per-field validation GRADIENT (each bounded field's UPPER/lower edge), the
 * whitelist posture, multi-error aggregation, the case/canonical-form acceptance
 * of `repo`, the rate-limit header surface, and the registration→resulting-entity
 * GATE (a registered work is never minted without a resolvable GitHub identity).
 *
 * Target controller/service:
 *   apps/api/src/onboarding/onboarding.controller.ts  (POST/GET /api/register-work)
 *   apps/api/src/onboarding/onboarding.service.ts      (OnboardingService.handle/getStatus)
 *   apps/api/src/onboarding/dto/register-work.dto.ts   (RegisterWorkRequestDto bounds)
 *
 * Every status / message / shape below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100, sqlite CI driver, REQUIRE_EMAIL_VERIFICATION off,
 * keyless / fake-GitHub-App — NO real GitHub reachability) on 2026-06-12 BEFORE
 * any assertion was written. This pins the platform's REAL behaviour, never a
 * guess. House rule honoured throughout: in the keyless env a successful 202
 * onboarding (account + Work creation, the validated→queued happy path) is
 * UNREACHABLE because resolveGitHubIdentity calls the real GitHub API and that
 * call always fails — so this file asserts RECORDS / typed error CONTRACTS and
 * the registration GATE, never a completion.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION (all THREE siblings read in full before writing this file):
 *   • flow-register-work-flow.spec.ts (Batch 2) — owns the credential STATE
 *     MACHINE (401 malformed pre-check vs 403 unresolvable vs 400 missing-header),
 *     the GET status enumeration protection (404 not_found / 403 no-token / 400
 *     ParseUUIDPipe), the empty-body `repo must be a string` case, the email /
 *     agentId-printable-ASCII / subdomain-DNS-safe / agentPayment-object messages,
 *     the subdomain LOWER length bound (2 chars), the POST-vs-GET throttle
 *     asymmetry, and Idempotency-Key acceptance. This file deliberately does NOT
 *     re-assert any of those — it pins the COMPLEMENTARY edges Batch 2 left open:
 *     every field's UPPER/MaxLength bound, the whitelist reject, error-array
 *     AGGREGATION, repo canonical/case acceptance, and the rate-limit headers.
 *   • sec-pin-ssrf-contracts.spec.ts — owns the URL-SHAPE SSRF rejections only
 *     (`repo` non-github / http / gitlab / metadata-host → 400 regex message;
 *     `webhookUrl` javascript:/file:/data: scheme rejects; the valid-pass DTO
 *     control). This file does NOT re-assert those scheme/host rejections; it
 *     covers the `repo` LENGTH bound, the repo CANONICAL forms that PASS (trailing
 *     slash, mixed-case host), the extra-path-segment regex reject, and the
 *     `webhookUrl` LENGTH bound — none of which sec-pin touches.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, http 3100, 2026-06-12):
 *   - POST repo=12345 (non-string) → 400 with the FULL stacked array:
 *       ['repo must be a https://github.com/<owner>/<repo> URL',
 *        'repo must be shorter than or equal to 512 characters',
 *        'repo must be a string'] (every failing validator on one field reports).
 *   - POST repo = https://github.com/octocat/<520-char-name> → 400
 *       'repo must be shorter than or equal to 512 characters' (MaxLength upper edge).
 *   - POST repo = https://github.com/octocat/awesome-mcp/  (trailing slash) → 403
 *       gh_credential_invalid — the GITHUB_HTTPS_REPO regex's `/?` accepts the
 *       canonical trailing slash, so the DTO passes (NOT a 400).
 *   - POST repo = https://github.com/octocat/awesome-mcp/tree/main (3 segments) →
 *       400 'repo must be a https://github.com/<owner>/<repo> URL' (regex requires
 *       exactly owner/repo — deep links are rejected).
 *   - POST repo = https://GitHub.com/Octocat/Awesome-MCP (mixed case) → 403
 *       gh_credential_invalid — the regex `i` flag accepts the host/path case, so
 *       the DTO passes and the request advances to the credential gate.
 *   - POST agentId = 257×'a' → 400 'agentId must be shorter than or equal to 256
 *       characters' (Length UPPER bound; Batch 2 only pinned the printable regex).
 *   - POST agentId = '' → 400 both 'agentId must be printable ASCII' AND
 *       'agentId must be longer than or equal to 1 characters' (Length LOWER bound).
 *   - POST subdomain = 64×'a' → 400 'subdomain must be shorter than or equal to 63
 *       characters' (Length UPPER bound; Batch 2 pinned only the 2-char lower edge).
 *   - POST webhookUrl = https://x.io/<2049 chars> → 400 'webhookUrl must be shorter
 *       than or equal to 2048 characters' (MaxLength upper edge, distinct from the
 *       sec-pin scheme rejects).
 *   - POST {repo:<valid>, bogusField:'x'} → 400 'property bogusField should not
 *       exist' (ValidationPipe forbidNonWhitelisted — the DTO is a closed shape).
 *   - POST repo=<gitlab> + email=bad + subdomain='AB' → 400 array AGGREGATING all
 *       four messages across three fields in a single 400 (no fail-fast).
 *   - POST {repo:<valid github>} + unresolvable token → 403 gh_credential_invalid
 *       'GitHub credential could not be resolved' AND the response carries the
 *       X-RateLimit-Limit-long:10 header (the documented 10/min/IP account-creation
 *       budget) — proving the registration→entity GATE: a valid DTO with a dead
 *       identity is forbidden, never a 202 (no OnboardingRequest/Work is minted),
 *       and the feature flag is ON (403, never 404 feature_disabled).
 *   - GET /api/register-work/:id 200 happy path is UNREACHABLE in this keyless env
 *       (no row can be created without a resolvable identity) → asserted as the
 *       owner-mismatch / not-found typed envelope, never a completed entity.
 *
 * THROTTLE: POST /api/register-work carries @Throttle(long:10/min/IP), shared
 * per-IP across workers/shards and NOT disabled in e2e — every POST (even a 400)
 * drains the bucket. POST tests therefore run SERIAL through a retry-on-429 helper
 * and are kept lean; a second 429 surfaces a `throttled` marker so the test SKIPS
 * rather than redding the run on shared-bucket contention.
 */

const VALID_REPO = 'https://github.com/octocat/awesome-mcp';
// >=4 chars so it clears the malformed pre-check and reaches resolveGitHubIdentity,
// which the keyless / fake-GitHub-App env always rejects → a deterministic 403.
const UNRESOLVABLE_GH_TOKEN = 'ghp_e2e_deep_unresolvable_token_000';
const PARAM_UUID_UNKNOWN = 'cccccccc-dddd-eeee-ffff-000000000000';

interface TypedError {
    statusCode?: number;
    code?: string;
    message?: string | string[];
    error?: string;
}

function messageArray(body: TypedError): string[] {
    return Array.isArray(body.message) ? body.message : [];
}

interface PostResult {
    status: number;
    body: TypedError;
    headers: Record<string, string>;
    throttled: boolean;
}

/**
 * POST /api/register-work with a retry that absorbs the per-route
 * @Throttle(long:10/min/IP). On a 429 (shared-IP bucket drained by a sibling
 * shard / the other worker), honour the route's reset window and retry ONCE; a
 * second 429 returns `throttled:true` so the caller can SKIP the contract
 * assertion rather than red the run on infrastructure contention.
 */
async function postRegisterWork(
    request: APIRequestContext,
    body: Record<string, unknown>,
    githubToken?: string,
): Promise<PostResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (githubToken) headers['X-GitHub-Token'] = githubToken;

    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await request.post(`${API_BASE}/api/register-work`, { headers, data: body });
        if (res.status() !== 429) {
            return {
                status: res.status(),
                body: (await res.json().catch(() => ({}))) as TypedError,
                headers: res.headers(),
                throttled: false,
            };
        }
        const retryAfter = Number(res.headers()['retry-after-long'] ?? '');
        const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 5000;
        if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 65_000)));
        } else {
            return {
                status: 429,
                body: (await res.json().catch(() => ({}))) as TypedError,
                headers: res.headers(),
                throttled: true,
            };
        }
    }
    return { status: 429, body: {}, headers: {}, throttled: true };
}

// POSTs share the per-IP @Throttle(long:10/min) bucket — run them in declared
// order so the retry-on-429 helper never races itself across the two workers.
test.describe.configure({ mode: 'serial' });

test.describe('register-work — DTO validation gradient (per-field bounds, POST throttle-budgeted)', () => {
    test('repo non-string reports EVERY failing validator on the field at once (regex + MaxLength + IsString) — no fail-fast', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: 12345 },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'a non-string repo fails DTO validation').toBe(400);
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        const msgs = messageArray(body);
        // class-validator aggregates ALL three decorators on `repo` rather than
        // stopping at the first — a complete error report for the agent.
        expect(msgs, 'the @Matches github-URL pin fires').toContain(
            'repo must be a https://github.com/<owner>/<repo> URL',
        );
        expect(msgs, 'the @MaxLength(512) bound fires').toContain(
            'repo must be shorter than or equal to 512 characters',
        );
        expect(msgs, 'the @IsString type check fires').toContain('repo must be a string');
    });

    test('repo @MaxLength(512) upper bound — a valid github prefix with an over-long repo name is rejected by length', async ({
        request,
    }) => {
        // Valid scheme/host/owner, but the repo segment pushes the URL past 512 —
        // the length bound fires even when the github-URL shape would otherwise pass.
        const longRepo = `https://github.com/octocat/${'r'.repeat(520)}`;
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: longRepo },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an over-512-char repo URL is rejected').toBe(400);
        expect(messageArray(body)).toContain(
            'repo must be shorter than or equal to 512 characters',
        );
    });

    test('repo canonical trailing slash PASSES the DTO (GITHUB_HTTPS_REPO `/?`) and advances to the credential gate (403, not 400)', async ({
        request,
    }) => {
        // The regex ends in `\/?$`, so the canonical trailing slash is accepted —
        // the request is NOT a 400 URL rejection; it passes validation and reaches
        // resolveGitHubIdentity, which 403s the dead token. Proves the DTO normalises
        // the canonical form rather than rejecting it.
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: 'https://github.com/octocat/awesome-mcp/' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        expect(status, 'a trailing-slash github URL passes the DTO').toBe(403);
        expect(body.code, 'it reached the credential gate, not the validation gate').toBe(
            'gh_credential_invalid',
        );
    });

    test('repo with an extra path segment (deep link /tree/main) is rejected — the regex pins exactly owner/repo', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: 'https://github.com/octocat/awesome-mcp/tree/main' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'a 3-segment github deep link is rejected by the shape pin').toBe(400);
        expect(messageArray(body)).toContain(
            'repo must be a https://github.com/<owner>/<repo> URL',
        );
    });

    test('repo mixed-case host/path PASSES the DTO (regex `i` flag) and advances to the credential gate (403, not 400)', async ({
        request,
    }) => {
        // `https://GitHub.com/Octocat/Awesome-MCP` differs only in case from the
        // canonical form; the GITHUB_HTTPS_REPO regex carries the `i` flag so the
        // DTO accepts it and the request reaches the credential gate (403). Proves
        // the host pin is case-insensitive, not a literal lowercase match.
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: 'https://GitHub.com/Octocat/Awesome-MCP' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        expect(status, 'a mixed-case github URL passes the DTO').toBe(403);
        expect(body.code, 'it reached the credential gate, not the validation gate').toBe(
            'gh_credential_invalid',
        );
    });

    test('agentId @Length(1,256) UPPER bound — a 257-char id is rejected by length (distinct from the printable-ASCII regex)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, agentId: 'a'.repeat(257) },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an over-256-char agentId is rejected').toBe(400);
        expect(messageArray(body)).toContain(
            'agentId must be shorter than or equal to 256 characters',
        );
    });

    test('agentId empty string trips BOTH the printable-ASCII regex AND the @Length(1,…) lower bound', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, agentId: '' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an empty agentId is rejected').toBe(400);
        const msgs = messageArray(body);
        expect(msgs, 'the printable-ASCII regex rejects the empty value').toContain(
            'agentId must be printable ASCII',
        );
        expect(msgs, 'the @Length lower bound also fires').toContain(
            'agentId must be longer than or equal to 1 characters',
        );
    });

    test('subdomain @Length(3,63) UPPER bound — a 64-char subdomain is rejected by length (complements Batch 2 lower edge)', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, subdomain: 'a'.repeat(64) },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an over-63-char subdomain is rejected').toBe(400);
        expect(messageArray(body)).toContain(
            'subdomain must be shorter than or equal to 63 characters',
        );
    });

    test('webhookUrl @MaxLength(2048) upper bound — an over-long https webhook URL is rejected by length (distinct from sec-pin scheme rejects)', async ({
        request,
    }) => {
        const longWebhook = `https://x.io/${'a'.repeat(2049)}`;
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, webhookUrl: longWebhook },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an over-2048-char webhookUrl is rejected').toBe(400);
        expect(messageArray(body)).toContain(
            'webhookUrl must be shorter than or equal to 2048 characters',
        );
    });
});

test.describe('register-work — whitelist posture, error aggregation & the registration→entity gate', () => {
    test('the DTO is a CLOSED shape — an unknown property is rejected (forbidNonWhitelisted), not silently dropped', async ({
        request,
    }) => {
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, bogusField: 'x' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status, 'an unknown field is rejected by the whitelist').toBe(400);
        expect(messageArray(body)).toContain('property bogusField should not exist');
    });

    test('validation does NOT fail-fast across fields — one 400 aggregates every field error in the body array', async ({
        request,
    }) => {
        // Three independently-bad fields (host, email, subdomain) — class-validator
        // collects all of them into a single 400 array rather than returning on the
        // first failure, so an agent fixes the whole payload in one round-trip.
        const { status, body, throttled } = await postRegisterWork(
            request,
            { repo: 'https://gitlab.com/x/y', email: 'bad', subdomain: 'AB' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — DTO gate not reachable');
        expect(status).toBe(400);
        const msgs = messageArray(body);
        expect(msgs, 'the repo host pin is reported').toContain(
            'repo must be a https://github.com/<owner>/<repo> URL',
        );
        expect(msgs, 'the email format error is reported in the same array').toContain(
            'email must be an email',
        );
        expect(msgs, 'the subdomain DNS-safe error is reported in the same array').toContain(
            'subdomain must be DNS-safe (lowercase, hyphens)',
        );
        expect(
            msgs.length,
            'the array carries multiple field errors (proving no fail-fast)',
        ).toBeGreaterThanOrEqual(3);
    });

    test('registration GATE: a valid DTO with an unresolvable identity is FORBIDDEN (403) — never a 202, so no Work/account entity is minted, and the feature flag is ON (not 404 feature_disabled)', async ({
        request,
    }) => {
        // This is the resulting-entity contract under the keyless env: a fully-valid
        // DTO passes every bound and reaches resolveGitHubIdentity, which rejects the
        // dead token. The controller has NO completion path here — the response is a
        // typed 403, never the 202 that would mint an OnboardingRequest + Work. The
        // 403 (not 404) also proves config.features.zeroFrictionOnboarding() is ON:
        // the feature-flag short-circuit (404 feature_disabled) did not fire.
        const { status, body, headers, throttled } = await postRegisterWork(
            request,
            { repo: VALID_REPO, email: 'agent@example.com', agentId: 'deep-probe-agent' },
            UNRESOLVABLE_GH_TOKEN,
        );
        test.skip(throttled, 'shared-IP @Throttle bucket drained — credential gate not reachable');
        expect(status, 'a valid DTO with a dead identity is forbidden, not accepted').toBe(403);
        expect(body.statusCode).toBe(403);
        expect(body.code, 'typed credential-invalid code at the resolution gate').toBe(
            'gh_credential_invalid',
        );
        expect(body.message).toBe('GitHub credential could not be resolved');
        // The route advertises the documented account-creation-abuse budget on every
        // response: the tight per-route @Throttle(long:10/min/IP) surfaces as a
        // long-window limit header of exactly 10.
        expect(
            headers['x-ratelimit-limit-long'],
            'the 10/min/IP account-creation budget is exposed on the response',
        ).toBe('10');
    });

    test('GET status happy-path (200 + resulting-entity shape) is UNREACHABLE keyless — the closest reachable contract is the typed not-found/owner envelope', async ({
        request,
    }) => {
        // Because no OnboardingRequest row can be persisted without a resolvable
        // GitHub identity (the gate above), the 200 status read that would return the
        // minted { onboardingId, workId, statusUrl, subdomain } shape cannot be
        // produced in this env. We pin the reachable contract instead: a well-formed
        // unknown id, with a (dead but >=4-char) proof token, resolves to the typed
        // 404 not_found envelope — never a 5xx and never a leaked entity.
        const res = await request.get(`${API_BASE}/api/register-work/${PARAM_UUID_UNKNOWN}`, {
            headers: { 'X-GitHub-Token': UNRESOLVABLE_GH_TOKEN },
        });
        const body = (await res.json().catch(() => ({}))) as TypedError;
        expect(res.status(), 'an unknown onboarding id is a clean 404, not a leaked record').toBe(
            404,
        );
        expect(body.code, 'typed not_found code (no entity exposed)').toBe('not_found');
        expect(body.message).toBe('unknown onboarding id');
        // And it is never a server error — the keyless gate degrades to a typed 404.
        expect(
            res.status(),
            'the unreachable happy path degrades to a typed 4xx, never a 5xx',
        ).toBeLessThan(500);
    });
});
