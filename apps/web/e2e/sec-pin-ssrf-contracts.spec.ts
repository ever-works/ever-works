import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * SSRF / URL-GUARD CONTRACTS — pins the platform's server-side defenses against
 * Server-Side Request Forgery and scheme-injection at the REAL API boundary.
 * Every status, message and shape below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) on 2026-06-11 before the assertions were written, so
 * this asserts the platform's ACTUAL behaviour, never a guess.
 *
 * The guards under test all consume the shared lexical SSRF predicate
 * `isSafeWebhookUrl` (packages/plugin/src/helpers/ssrf-guard.ts, re-exported from
 * @ever-works/agent/utils) plus per-surface tightening (https-only, github-only,
 * no embedded credentials). Three live boundaries are exercised:
 *
 *   1. Missions `missionTemplateRepo` — POST/PATCH /api/me/missions[/:id]. The
 *      strongest, most stable surface: validated at the DTO via the custom
 *      `IsMissionTemplateRepo` constraint (apps/api/src/missions/dto/mission.dto.ts)
 *      AND re-validated in MissionsService.normalizeTemplateRepo
 *      (packages/agent/src/missions/missions.service.ts). NOT env-gated, so the
 *      reject behaviour is identical local + CI.
 *   2. Onboarding `register-work` — POST /api/register-work (@Public). Its DTO
 *      (apps/api/src/onboarding/dto/register-work.dto.ts) pins `repo` to an
 *      `https://github.com/<owner>/<repo>` URL (GITHUB_HTTPS_REPO regex →
 *      host + TLS pinning) and `webhookUrl` to an http(s) URL (HTTPS_URL regex →
 *      scheme allowlist). DTO validation runs BEFORE the feature-flag / GitHub
 *      token checks, so the URL-shape rejections are reachable with any token.
 *   3. Webhook subscriptions — POST /api/webhooks. The DTO `@IsUrl({ protocols })`
 *      (apps/api/src/webhooks/webhooks.controller.ts) is the env-STABLE gate
 *      (rejects javascript:/file:/data:/ftp: in every env). The private-IP SSRF
 *      guard in WebhooksService.assertValidUrl is deliberately env-GATED (skipped
 *      in NODE_ENV development/test so devs can point at a local tunnel) → those
 *      assertions are ENVIRONMENT-ADAPTIVE below.
 *
 * NON-DUPLICATION: flow-plugin-ai-settings-validation.spec.ts pins the
 * plugin-settings JSON-Schema validation surface (required/type/x-secret/x-envVar
 * — `apiKey`/`defaultModel` on openrouter) and was read FIRST to confirm none of
 * the URL/SSRF guards below are touched there. The plugin-settings PATCH path runs
 * AJV schema validation (`apiKey` required), NOT these URL guards — probed live:
 * activepieces `repo_url` github-only validation is a form-schema-provider concern
 * not reachable via the settings PATCH endpoint (AJV rejects on missing `apiKey`
 * first), and the user-research `sources[].url` https-guard is an internal LLM
 * tool / persistence schema with no public HTTP boundary — so BOTH are out of
 * scope here (house rule: never assert a contract you could not probe live).
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - POST /api/me/missions { type:'one-shot', missionTemplateRepo } —
 *       • 'owner/repo' slug / bare-catalog-id / 'https://github.com/..' → 201.
 *       • http:// host, https loopback 127.0.0.1, metadata 169.254.169.254,
 *         10.x private, https://[::1], user:pass@ creds, file://, git://, ssh://
 *         → 400 { message:['missionTemplateRepo must be a GitHub-style "owner/repo"
 *         slug, a bare catalog id, or an HTTPS git URL on a public host'] }.
 *       • >200 chars → adds the MaxLength message to the array.
 *       • PATCH /api/me/missions/:id mirrors the same accept/reject matrix.
 *   - POST /api/register-work (X-GitHub-Token header) —
 *       • repo non-github / http github / gitlab → 400
 *         { message:['repo must be a https://github.com/<owner>/<repo> URL'] }.
 *       • webhookUrl javascript:/file: → 400
 *         { message:['webhookUrl must be an http(s) URL'] }.
 *       • valid github repo + https webhook PASSES the DTO → 403
 *         { code:'gh_credential_invalid' } (proves the rejections are URL-shape).
 *   - POST /api/webhooks { url } —
 *       • javascript:/file:/data:/ftp:/not-a-url/missing → 400
 *         { message:['url must be a URL address'] } (env-STABLE).
 *       • https://example.com/hook → 201 (control).
 *       • private/loopback/metadata IP → ENV-ADAPTIVE: 2xx pass-through in a
 *         local dev/test env (SSRF guard skipped), or 4xx (400/403) in a guarded
 *         non-local env. Asserted as "either", never assuming the env.
 *   - Anonymous POST /api/webhooks and /api/me/missions → 401 (auth precedes
 *     body validation; the SSRF surface is not reachable unauthenticated).
 *
 * ISOLATION: every mutation runs on its OWN fresh registerUserViaAPI() user with a
 * unique Date.now()-suffixed email. All probes are pure API-contract assertions
 * (no UI nav → no next-dev cold-compile flake). Filename `sec-` is not matched by
 * the no-auth testIgnore regex, so it runs in the authenticated chromium project;
 * each request carries an explicit bearer token (or none, for the anon checks).
 */

const MISSION_REPO_REJECT_MSG =
    'missionTemplateRepo must be a GitHub-style "owner/repo" slug, a bare catalog id, or an HTTPS git URL on a public host';
const REGISTER_REPO_REJECT_MSG = 'repo must be a https://github.com/<owner>/<repo> URL';
const REGISTER_WEBHOOK_REJECT_MSG = 'webhookUrl must be an http(s) URL';
const WEBHOOK_URL_REJECT_MSG = 'url must be a URL address';

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext, tag: string): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-ssrf-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    });
    return u.access_token;
}

interface ProbeResult {
    status: number;
    body: { message?: string | string[]; error?: string; code?: string } & Record<string, unknown>;
}

/** Flatten the NestJS validation `message` (string | string[]) to one string. */
function messageText(body: ProbeResult['body']): string {
    const m = body?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return typeof m === 'string' ? m : '';
}

/** Create a Mission and return the raw status + body. */
async function createMission(
    request: APIRequestContext,
    token: string,
    missionTemplateRepo?: string,
): Promise<ProbeResult> {
    const data: Record<string, unknown> = {
        description: `ssrf-probe ${Date.now()}`,
        type: 'one-shot',
    };
    if (missionTemplateRepo !== undefined) data.missionTemplateRepo = missionTemplateRepo;
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as ProbeResult['body'],
    };
}

/** POST /api/register-work with a dummy GitHub token so we exercise the DTO gate. */
async function registerWork(
    request: APIRequestContext,
    body: Record<string, unknown>,
): Promise<ProbeResult> {
    const res = await request.post(`${API_BASE}/api/register-work`, {
        headers: { 'X-GitHub-Token': 'gho_e2e_dummy_probe_token' },
        data: body,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as ProbeResult['body'],
    };
}

/** POST /api/webhooks with a raw url and return the status + body. */
async function createWebhook(
    request: APIRequestContext,
    token: string,
    url: unknown,
): Promise<ProbeResult> {
    const res = await request.post(`${API_BASE}/api/webhooks`, {
        headers: authedHeaders(token),
        data: url === undefined ? {} : { url },
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as ProbeResult['body'],
    };
}

test.describe('SSRF / URL-guard contracts — API boundary', () => {
    test('Mission template-repo guard accepts the three legitimate shapes (owner/repo, bare catalog id, https github URL)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mrepo-ok');

        // 1. GitHub-style owner/repo slug.
        const slug = await createMission(request, token, 'ever-works/p2p-marketplace-template');
        expect(slug.status, `owner/repo slug accepted; body=${JSON.stringify(slug.body)}`).toBe(
            201,
        );
        expect(slug.body.missionTemplateRepo, 'the slug round-trips verbatim').toBe(
            'ever-works/p2p-marketplace-template',
        );

        // 2. Bare catalog-id selector (single segment, no `/`).
        const bare = await createMission(request, token, 'starter-business');
        expect(bare.status, `bare catalog id accepted; body=${JSON.stringify(bare.body)}`).toBe(
            201,
        );
        expect(bare.body.missionTemplateRepo, 'the catalog id round-trips').toBe(
            'starter-business',
        );

        // 3. Full HTTPS GitHub URL on a public host.
        const url = await createMission(request, token, 'https://github.com/ever-works/template');
        expect(url.status, `https github URL accepted; body=${JSON.stringify(url.body)}`).toBe(201);
        expect(url.body.missionTemplateRepo, 'the https URL round-trips').toBe(
            'https://github.com/ever-works/template',
        );

        // CONTROL: a Mission with NO template repo is accepted (proves the 400s in
        // the sibling tests are about the URL value, not a blanket reject of create).
        const none = await createMission(request, token);
        expect(none.status, 'a mission with no template repo is accepted').toBe(201);
        expect(
            none.body.missionTemplateRepo,
            'an omitted template repo persists as null',
        ).toBeNull();
    });

    test('Mission template-repo guard rejects loopback / metadata / private-IP HTTPS hosts with the SSRF message', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mrepo-ssrf');

        // Each of these is a syntactically-valid https URL whose HOST is an
        // SSRF target — the lexical guard (isSafeWebhookUrl) must reject every one.
        const ssrfHosts: Array<[label: string, value: string]> = [
            ['loopback 127.0.0.1', 'https://127.0.0.1/template'],
            ['cloud-metadata 169.254.169.254', 'https://169.254.169.254/latest/meta-data'],
            ['RFC1918 10.x', 'https://10.0.0.5/template'],
            ['IPv6 loopback [::1]', 'https://[::1]/template'],
        ];

        for (const [label, value] of ssrfHosts) {
            const res = await createMission(request, token, value);
            expect(res.status, `${label} rejected (400); body=${JSON.stringify(res.body)}`).toBe(
                400,
            );
            expect(messageText(res.body), `${label} returns the SSRF guard message`).toContain(
                MISSION_REPO_REJECT_MSG,
            );
        }
    });

    test('Mission template-repo guard rejects non-HTTPS schemes and embedded credentials (http / file / git / ssh / user:pass@)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mrepo-scheme');

        const badShapes: Array<[label: string, value: string]> = [
            ['http (non-TLS) github', 'http://github.com/ever-works/template'],
            ['file scheme', 'file:///etc/passwd'],
            ['git scheme', 'git://github.com/ever-works/template'],
            ['ssh scheme', 'ssh://git@github.com/ever-works/template'],
            ['embedded credentials', 'https://user:pass@github.com/ever-works/template'],
        ];

        for (const [label, value] of badShapes) {
            const res = await createMission(request, token, value);
            expect(res.status, `${label} rejected (400); body=${JSON.stringify(res.body)}`).toBe(
                400,
            );
            expect(messageText(res.body), `${label} returns the SSRF guard message`).toContain(
                MISSION_REPO_REJECT_MSG,
            );
        }
    });

    test('Mission template-repo over-length value is rejected (200-char cap) without bypassing the shape guard', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mrepo-len');

        // A 201-char value that LOOKS like a bare slug still trips the MaxLength
        // guard (defense-in-depth: length is bounded before the shape branch runs).
        const tooLong = 'a'.repeat(201);
        const res = await createMission(request, token, tooLong);
        expect(res.status, `over-length repo rejected; body=${JSON.stringify(res.body)}`).toBe(400);
        // The exact-200 boundary is accepted by the slug shape (bare slug, no `/`).
        const atLimit = 'b'.repeat(200);
        const ok = await createMission(request, token, atLimit);
        expect(
            ok.status,
            `exactly-200-char bare slug accepted; body=${JSON.stringify(ok.body)}`,
        ).toBe(201);
    });

    test('Mission template-repo guard also fires on PATCH /api/me/missions/:id (update path is guarded, not just create)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'mrepo-patch');

        // Seed a clean mission, then attempt to PATCH a hostile template repo onto it.
        const seeded = await createMission(request, token);
        expect(seeded.status, 'seed mission created').toBe(201);
        const missionId = seeded.body.id as string;
        expect(missionId, 'seed mission has an id').toBeTruthy();

        const patchBad = await request.patch(`${API_BASE}/api/me/missions/${missionId}`, {
            headers: authedHeaders(token),
            data: { missionTemplateRepo: 'https://169.254.169.254/template' },
        });
        const patchBadBody = (await patchBad.json().catch(() => ({}))) as ProbeResult['body'];
        expect(
            patchBad.status(),
            `PATCH metadata-IP repo rejected; body=${JSON.stringify(patchBadBody)}`,
        ).toBe(400);
        expect(messageText(patchBadBody), 'PATCH returns the SSRF guard message').toContain(
            MISSION_REPO_REJECT_MSG,
        );

        // A legitimate owner/repo PATCH succeeds — the guard rejects the VALUE,
        // not the operation, and the original record is otherwise mutable.
        const patchOk = await request.patch(`${API_BASE}/api/me/missions/${missionId}`, {
            headers: authedHeaders(token),
            data: { missionTemplateRepo: 'ever-works/clean-template' },
        });
        const patchOkBody = (await patchOk.json().catch(() => ({}))) as ProbeResult['body'];
        expect(patchOk.status(), `valid PATCH succeeds; body=${JSON.stringify(patchOkBody)}`).toBe(
            200,
        );
        expect(patchOkBody.missionTemplateRepo, 'the valid repo persisted').toBe(
            'ever-works/clean-template',
        );
    });

    test('register-work pins `repo` to an https://github.com/<owner>/<repo> URL (host + TLS pinning rejects other hosts/schemes)', async ({
        request,
    }) => {
        // The register-work DTO runs before the feature-flag / GitHub-token checks,
        // so these URL-shape rejections are reachable with the dummy token.
        const cases: Array<[label: string, repo: string]> = [
            ['cloud-metadata host', 'https://169.254.169.254/owner/repo'],
            ['http (non-TLS) github', 'http://github.com/owner/repo'],
            ['non-github host (gitlab)', 'https://gitlab.com/owner/repo'],
            ['loopback host', 'https://127.0.0.1/owner/repo'],
        ];

        for (const [label, repo] of cases) {
            const res = await registerWork(request, { repo });
            expect(res.status, `${label} rejected (400); body=${JSON.stringify(res.body)}`).toBe(
                400,
            );
            expect(messageText(res.body), `${label} returns the github-URL pin message`).toContain(
                REGISTER_REPO_REJECT_MSG,
            );
        }
    });

    test('register-work `webhookUrl` enforces the http(s) scheme allowlist (javascript:/file:/data: rejected)', async ({
        request,
    }) => {
        const validGithubRepo = 'https://github.com/octocat/awesome-mcp';

        const badSchemes: Array<[label: string, webhookUrl: string]> = [
            ['javascript scheme', 'javascript:alert(1)'],
            ['file scheme', 'file:///etc/passwd'],
            ['data scheme', 'data:text/plain,pwned'],
        ];

        for (const [label, webhookUrl] of badSchemes) {
            const res = await registerWork(request, { repo: validGithubRepo, webhookUrl });
            expect(res.status, `${label} rejected (400); body=${JSON.stringify(res.body)}`).toBe(
                400,
            );
            expect(
                messageText(res.body),
                `${label} returns the webhookUrl scheme message`,
            ).toContain(REGISTER_WEBHOOK_REJECT_MSG);
        }
    });

    test('register-work ACCEPTS a valid github repo + https webhook at the DTO and proceeds to the GitHub-credential check (proving rejections are URL-shape, not blanket)', async ({
        request,
    }) => {
        // A well-formed github repo + https webhook passes EVERY DTO URL guard, so
        // the request advances past validation to the GitHub-credential resolution,
        // which fails for the dummy token with a stable typed 403 envelope. This is
        // the positive control: it proves the 400s above are specifically about the
        // URL shapes, not a request the endpoint rejects wholesale.
        const res = await registerWork(request, {
            repo: 'https://github.com/octocat/awesome-mcp',
            webhookUrl: 'https://my-agent.example.com/webhooks/ever-works',
        });
        // Either the feature is enabled and the dummy GitHub token fails credential
        // resolution (403 gh_credential_invalid), or zero-friction onboarding is
        // disabled (404 feature_disabled). BOTH outcomes prove the DTO accepted the
        // URLs — neither is the 400 URL-shape rejection. Assert it is NOT a 400 and
        // carries a known typed code.
        expect(
            res.status,
            `valid URLs pass the DTO (not a 400 URL rejection); body=${JSON.stringify(res.body)}`,
        ).not.toBe(400);
        expect(
            [403, 404],
            `advanced past DTO to a typed gate; body=${JSON.stringify(res.body)}`,
        ).toContain(res.status);
        expect(
            res.body.code,
            'the response carries a typed onboarding error code, not a validation_error',
        ).toMatch(/gh_credential_invalid|feature_disabled/);
    });

    test('Webhook subscription DTO rejects every non-http(s) scheme (javascript / file / data / ftp) — env-stable scheme allowlist', async ({
        request,
    }) => {
        const token = await freshToken(request, 'wh-scheme');

        const badSchemes: Array<[label: string, url: unknown]> = [
            ['javascript scheme', 'javascript:alert(1)'],
            ['file scheme', 'file:///etc/passwd'],
            ['data scheme', 'data:text/plain,pwned'],
            ['ftp scheme', 'ftp://example.com/x'],
            ['not a url', 'not a url at all'],
            ['missing url', undefined],
        ];

        for (const [label, url] of badSchemes) {
            const res = await createWebhook(request, token, url);
            expect(res.status, `${label} rejected (400); body=${JSON.stringify(res.body)}`).toBe(
                400,
            );
            expect(
                messageText(res.body),
                `${label} returns the url scheme/format message`,
            ).toContain(WEBHOOK_URL_REJECT_MSG);
        }
    });

    test('Webhook subscription accepts a public https URL and returns the one-time signing secret (control for the scheme rejections)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'wh-ok');

        const res = await createWebhook(request, token, 'https://example.com/ever-works/hook');
        expect(res.status, `public https url accepted; body=${JSON.stringify(res.body)}`).toBe(201);
        const sub = (res.body.subscription ?? {}) as { id?: string; url?: string; status?: string };
        expect(sub.id, 'the created subscription carries an id').toBeTruthy();
        expect(sub.url, 'the public https url round-trips').toBe(
            'https://example.com/ever-works/hook',
        );
        expect(sub.status, 'a new subscription is active').toBe('active');
        // The RAW signing secret is returned ONCE on create (and only here).
        expect(
            typeof res.body.signingSecret,
            'the raw signing secret is returned once on create',
        ).toBe('string');
    });

    test('Webhook private/loopback/metadata-IP handling is environment-adaptive (SSRF guard env-gated in dev/test, enforced in guarded envs)', async ({
        request,
    }) => {
        const token = await freshToken(request, 'wh-ssrf');

        // The WebhooksService SSRF guard is intentionally SKIPPED in local
        // dev/test envs (NODE_ENV development/test/empty) so devs can target a
        // local tunnel, and ENFORCED in every non-local env (staging/prod) where
        // the host shares network access to cloud metadata / internal tooling.
        // We therefore assert the ADAPTIVE contract: a private/loopback/metadata
        // host is EITHER accepted (201, local env — guard skipped) OR blocked with
        // a 4xx (400/403, guarded env). It is NEVER a 5xx, and a blocked response
        // carries the private/loopback SSRF reason. This holds in both local and CI.
        const ssrfTargets: Array<[label: string, url: string]> = [
            ['loopback 127.0.0.1', 'http://127.0.0.1:8080/hook'],
            ['cloud-metadata 169.254.169.254', 'https://169.254.169.254/latest/meta-data'],
            ['RFC1918 10.x', 'https://10.0.0.5/hook'],
            ['IPv6 loopback [::1]', 'https://[::1]/hook'],
        ];

        let sawBlock = false;
        let sawAllow = false;
        for (const [label, url] of ssrfTargets) {
            const res = await createWebhook(request, token, url);
            expect(
                res.status,
                `${label} resolves to a 2xx (local) or 4xx (guarded), never 5xx; body=${JSON.stringify(res.body)}`,
            ).toBeLessThan(500);
            if (res.status >= 200 && res.status < 300) {
                sawAllow = true;
            } else {
                sawBlock = true;
                expect(
                    res.status,
                    `${label} block is a 400/403 authorization-style rejection`,
                ).toBeGreaterThanOrEqual(400);
                // A guarded-env block names the private/loopback/link-local reason.
                expect(
                    messageText(res.body).toLowerCase(),
                    `${label} block explains the private/loopback rejection`,
                ).toMatch(/private|loopback|link-local|not allowed|https/);
            }
        }
        // Sanity: every probe resolved to exactly one of the two adaptive branches.
        expect(
            sawAllow || sawBlock,
            'each SSRF target resolved to either the local-allow or guarded-block branch',
        ).toBe(true);
    });

    test('The SSRF surfaces require authentication — anonymous POSTs to /api/webhooks and /api/me/missions are 401 (the guard is never reachable unauthenticated)', async ({
        request,
    }) => {
        // No Authorization header → the AuthSessionGuard rejects before any body /
        // URL validation runs. The API is bearer-authed, so omitting the header on
        // the shared request fixture is a true anonymous call (no cookie carries an
        // API session). This proves the SSRF-sensitive write surfaces are not an
        // unauthenticated SSRF vector.
        const whAnon = await request.post(`${API_BASE}/api/webhooks`, {
            headers: { Authorization: '' },
            data: { url: 'https://169.254.169.254/x' },
        });
        expect(whAnon.status(), 'anonymous webhook create is 401').toBe(401);

        const missionAnon = await request.post(`${API_BASE}/api/me/missions`, {
            headers: { Authorization: '' },
            data: {
                description: 'anon',
                type: 'one-shot',
                missionTemplateRepo: 'https://127.0.0.1/x',
            },
        });
        expect(missionAnon.status(), 'anonymous mission create is 401').toBe(401);
    });
});
