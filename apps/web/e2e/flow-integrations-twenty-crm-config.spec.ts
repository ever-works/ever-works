import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: INTEGRATIONS SURFACE — config/status reachability + the GitHub-App
 * sibling controllers, as the COMPLEMENT to the Twenty-CRM companies *gate*.
 *
 * WHY THIS ANGLE (non-duplicate): flow-twenty-crm-gate-deep.spec.ts already
 * pins the Twenty-CRM `companies` controller's fail-CLOSED posture exhaustively
 * (anon 401, authed 403, unmounted /people 404, guard-before-pipe ordering,
 * route enumeration, no-5xx). It deliberately leaves two questions open that
 * the scope here answers from a DIFFERENT direction:
 *   (a) Is there ANY twenty-crm config/status surface reachable while the
 *       integration is UNCONFIGURED? Answer (probed + source-confirmed): NO —
 *       the ONLY mounted twenty-crm controller is `CompaniesController`
 *       (TwentyCrmModule.{forRoot,forRootAsync} register only it), and it is
 *       fully behind `@UseGuards(AuthSessionGuard, CrmSyncGuard)`. There is no
 *       GET config/status route; even `/api/twenty-crm/config|status|health`
 *       404. So we pin that ABSENCE, and pin the per-tenant CREDENTIALS MODEL
 *       contract indirectly (the gate fires before any tenant resolution).
 *   (b) The OTHER integration in apps/api/src/integrations — the GitHub App —
 *       is a genuinely DIFFERENT controller shape that IS reachable while its
 *       own credentials are unset: it exposes @Public() onboarding routes
 *       (`setup`, `callback`, `webhooks`) AND an authed, fail-OPEN-to-empty
 *       status route (`GET installations` -> 200 []). That contrast (one
 *       integration fails CLOSED with 403, the sibling serves a 200 status
 *       list + 400-validating public routes) is the heart of this file.
 *
 * GROUNDING — every status/shape below was probed against the LIVE sqlite e2e
 * API (port 3100, keyless, all TWENTY_CRM_* and GITHUB_APP_* env UNSET) with
 * throwaway users on 2026-06-12, and cross-checked against the real source:
 *   - apps/api/src/integrations/github-app/github-app.controller.ts
 *       @Controller('api/github-app'):
 *         @Public() GET  setup     (GitHubAppSetupQueryDto: installation_id @IsString,
 *                                    setup_action @IsIn(['install','request']))
 *         @Public() GET  callback  (GitHubAppCallbackQueryDto: code/state @IsString)
 *                   GET  installations               (authed; no @Public)
 *                   POST installations/:id/sync      (authed)
 *                   POST installations/:id/repositories/:repoId/onboard (authed)
 *   - apps/api/src/integrations/github-app/github-app-webhook.controller.ts
 *       @Public() POST webhooks: order = (1) missing x-github-event -> 400, then
 *         (2) missing rawBody -> 400, then (3) verifyWebhookSignature -> 401.
 *   - apps/api/src/integrations/github-app/github-app.service.ts
 *       getInstallation() rejects non-numeric installation_id with 400 BEFORE
 *       calling GitHub; getCredentials() throws when GITHUB_APP creds unset (so
 *       a VALID numeric setup id surfaces a 500 on the keyless stack);
 *       verifyWebhookSignature() returns false when no webhookSecret -> 401.
 *   - apps/api/src/integrations/twenty-crm/config/crm-config.service.ts
 *       isEnabled = !!(BASE_URL && API_KEY && WORKSPACE_ID) (all unset -> gate
 *       closed); configForTenant(tenantId) FAILS CLOSED (null) unless that
 *       tenant has its OWN api key in TWENTY_CRM_TENANTS.
 *   - apps/api/src/integrations/twenty-crm/twenty-crm.module.ts
 *       controllers: [CompaniesController] ONLY — no config/status controller.
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     GH setup   no installation_id            -> 400 ["installation_id must be a string"]
 *     GH setup   installation_id=abc (non-num) -> 400 {message:'Invalid GitHub App installation id'}
 *     GH setup   setup_action=bogus            -> 400 ["setup_action must be one of ... install, request"]
 *     GH setup   unknown query field           -> 400 ["property <x> should not exist"] (whitelist)
 *     GH setup   installation_id=123 (valid)   -> 500 (App creds unset; service throws downstream)
 *     GH callback no code/state                -> 400 ["code must be a string","state must be a string"]
 *     GH webhook  no x-github-event            -> 400 {message:'Missing GitHub event header'}
 *     GH webhook  event but empty body         -> 400 {message:'Missing raw webhook payload'}
 *     GH webhook  event + body, bad/no sig     -> 401 {message:'Invalid GitHub webhook signature'}
 *     GH webhook  GET (POST-only)              -> 404 'Cannot GET /api/github-app/webhooks'
 *     GH install  authed GET installations     -> 200 [] (reachable status; no installs yet)
 *     GH install  anon  GET installations      -> 401 {message:'Unauthorized',statusCode:401}
 *     GH install  garbage bearer               -> 401 (auth rejects before handler)
 *     GH sync     authed POST .../123/sync     -> 401 {message:'GitHub App installation not found ...'}
 *     GH onboard  authed POST .../repos/.../onboard -> 404 {message:'GitHub App repository not found ...'}
 *     GH route    /api/github-app/<bogus>      -> 404 'Cannot GET ...'
 *     CRM config  /api/twenty-crm/{config,status,health} -> 404 (NO such routes exist)
 *     CRM gate    authed GET companies         -> 403 {message:'Forbidden resource'} (contrast anchor)
 *
 * ADAPTIVITY: a stack that HAS configured the GitHub App (creds + webhook
 * secret set) would change ONLY the two creds-dependent outcomes — the valid
 * `setup` id (500 -> a 2xx redirect URL) and a correctly-signed webhook (401 ->
 * 200). Every assertion that depends on that is written tolerantly (status-set
 * membership / probed precondition); the auth, validation-pipe, and route-
 * enumeration invariants hold on ANY stack. The one purposeful 5xx assertion
 * (valid-id setup) is scoped to the keyless reality via a status-set so a
 * configured stack is not falsely failed.
 *
 * NON-DUPLICATION: complements (does NOT restate) flow-twenty-crm-gate-deep
 * (companies gate / people-unmounted / guard-ordering — re-touched here ONLY as
 * a single contrast anchor, test 12, not re-enumerated). No existing e2e spec
 * touches /api/github-app at all (greenfield for this controller). Does not
 * overlap api-public-contract.spec.ts (generic protected/404 tripwire across
 * unrelated prefixes; never /api/github-app or /api/twenty-crm).
 *
 * ISOLATION: every authed assertion uses a FRESH registerUserViaAPI() user;
 * anonymous probes use an explicit empty-storageState context. No module-scope
 * await / no clock at module scope — unique values come from a per-test counter.
 */

const GH_BASE = `${API_BASE}/api/github-app`;
const CRM_BASE = `${API_BASE}/api/twenty-crm`;

// Per-test unique suffix WITHOUT touching a clock at module scope.
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ErrorBody {
    message?: string | string[];
    error?: string;
    statusCode?: number;
}

async function jsonBody(res: { json: () => Promise<unknown> }): Promise<ErrorBody> {
    return (await res.json().catch(() => ({}))) as ErrorBody;
}

/** Flatten a string|string[] message into one searchable string. */
function msgText(body: ErrorBody): string {
    return Array.isArray(body.message) ? body.message.join(' | ') : String(body.message ?? '');
}

test.describe('integrations surface — github-app sibling controller + twenty-crm config reachability', () => {
    test('1. the @Public() github-app SETUP route is reachable WITHOUT auth but enforces its query DTO: a missing installation_id is a 400 from the global ValidationPipe (not a 401/500)', async ({
        browser,
    }) => {
        // Anonymous, explicit empty storageState — proves @Public() really is public
        // and that validation (not auth) is the first gate on this onboarding route.
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const res = await ctx.request.get(`${GH_BASE}/setup`);
            expect(res.status(), 'public setup with no params is a 400, not 401/500').toBe(400);
            const body = await jsonBody(res);
            expect(body.statusCode).toBe(400);
            expect(body.error).toBe('Bad Request');
            // class-validator surfaces the field-level message as an array.
            expect(msgText(body)).toMatch(/installation_id must be a string/i);
        } finally {
            await ctx.close();
        }
    });

    test('2. github-app SETUP applies BOTH the @IsIn(setup_action) DTO rule AND the service-level numeric installation_id guard: a non-numeric id and a bad setup_action each 400 with their distinct messages', async ({
        request,
    }) => {
        // setup_action outside {install,request} is rejected by the DTO (array message).
        const badAction = await request.get(`${GH_BASE}/setup`, {
            params: { installation_id: '123', setup_action: uniq('bogus') },
        });
        expect(badAction.status(), 'bad setup_action -> 400 from @IsIn').toBe(400);
        expect(msgText(await jsonBody(badAction))).toMatch(
            /setup_action must be one of the following values: install, request/i,
        );

        // A non-numeric installation_id PASSES the @IsString DTO but is rejected by
        // GitHubAppService.getInstallation's `/^\d+$/` guard (path-traversal defence)
        // BEFORE any GitHub call — a SERVICE 400 with a different, scalar message.
        const nonNumericId = await request.get(`${GH_BASE}/setup`, {
            params: { installation_id: 'not-a-number' },
        });
        expect(nonNumericId.status(), 'non-numeric installation_id -> 400 from service guard').toBe(
            400,
        );
        const body = await jsonBody(nonNumericId);
        expect(body.message).toBe('Invalid GitHub App installation id');
        expect(body.error).toBe('Bad Request');
    });

    test('3. github-app SETUP rejects unknown query params via the whitelisting ValidationPipe (forbidNonWhitelisted): an extra field is a 400 "property ... should not exist", never silently ignored', async ({
        request,
    }) => {
        const res = await request.get(`${GH_BASE}/setup`, {
            params: { installation_id: '123', [uniq('bogusExtra')]: 'hax' },
        });
        expect(res.status(), 'extra query field is forbidden -> 400').toBe(400);
        expect(msgText(await jsonBody(res))).toMatch(/property .* should not exist/i);
    });

    test('4. a VALID numeric installation_id passes ALL validation but the setup flow cannot complete on a keyless stack (GitHub App creds unset) — it surfaces a clean 500, NOT a hung request or a leaked credential error', async ({
        request,
    }) => {
        // This is the one purposeful non-2xx-non-4xx assertion: with GITHUB_APP_*
        // unset, getCredentials() throws downstream of validation, mapped to 500.
        // A configured stack would instead return a 2xx authorization-url payload —
        // so we tolerate either rather than hard-pinning 500.
        const res = await request.get(`${GH_BASE}/setup`, {
            params: { installation_id: '123', setup_action: 'install' },
        });
        expect(
            [200, 201, 500],
            `valid setup id status was ${res.status()} (500 on keyless, 2xx if configured)`,
        ).toContain(res.status());
        if (res.status() === 500) {
            const body = await jsonBody(res);
            // Generic message only — no raw "GitHub App credentials are not configured"
            // internals leaked to the client.
            expect(body.statusCode).toBe(500);
            expect(msgText(body)).not.toMatch(/private key|client_secret|credentials are not/i);
        }
    });

    test('5. the @Public() github-app CALLBACK route validates its DTO too: missing code AND state each produce a field-level 400 (the OAuth callback never trusts an empty query)', async ({
        browser,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const res = await ctx.request.get(`${GH_BASE}/callback`);
            expect(res.status(), 'callback with no code/state -> 400').toBe(400);
            const text = msgText(await jsonBody(res));
            expect(text).toMatch(/code must be a string/i);
            expect(text).toMatch(/state must be a string/i);
        } finally {
            await ctx.close();
        }
    });

    test('6. the @Public() WEBHOOK route enforces a strict precondition ORDER: the missing x-github-event header is rejected FIRST (400), even when the body is also absent — header presence is checked before payload presence', async ({
        request,
    }) => {
        // No event header at all, with a JSON body present: the handler checks the
        // event header BEFORE the raw body, so we see the event-header 400.
        const noEvent = await request.post(`${GH_BASE}/webhooks`, { data: { any: uniq('p') } });
        expect(noEvent.status(), 'missing event header -> 400').toBe(400);
        expect((await jsonBody(noEvent)).message).toBe('Missing GitHub event header');

        // Event header present but NO body -> the SECOND precondition fires.
        const noBody = await request.post(`${GH_BASE}/webhooks`, {
            headers: { 'x-github-event': 'ping' },
        });
        expect(noBody.status(), 'event header but no raw body -> 400').toBe(400);
        expect((await jsonBody(noBody)).message).toBe('Missing raw webhook payload');
    });

    test('7. a WEBHOOK with a valid event + body but an unverifiable signature is rejected as UNAUTHORIZED (401), and it fails closed even with no secret configured — an unsigned push can never be processed', async ({
        request,
    }) => {
        // verifyWebhookSignature returns false when no webhook secret is set, so ANY
        // signature (or none) -> 401. We send a plausible-but-wrong signature header
        // to prove it is the signature check, not a parsing error, that refuses us.
        const res = await request.post(`${GH_BASE}/webhooks`, {
            headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' },
            data: { ref: 'refs/heads/main', after: uniq('sha') },
        });
        expect(res.status(), 'bad/absent signature -> 401 (fail closed)').toBe(401);
        const body = await jsonBody(res);
        expect(body.statusCode).toBe(401);
        expect(body.message).toBe('Invalid GitHub webhook signature');
    });

    test('8. the github-app STATUS route GET /installations is reachable for an authenticated user and returns a 200 empty list (a fresh user has no installations) — the sibling integration fails OPEN to an empty status, unlike the twenty-crm 403 gate', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const res = await request.get(`${GH_BASE}/installations`, {
            headers: authedHeaders(access_token),
        });
        expect(res.status(), 'authed installations list -> 200').toBe(200);
        const body = (await res.json()) as unknown;
        // A brand-new user owns no GitHub App installations -> exactly [].
        expect(Array.isArray(body), 'installations response is an array').toBe(true);
        expect((body as unknown[]).length, 'fresh user has zero installations').toBe(0);
    });

    test('9. the github-app STATUS + sync + onboard routes are all PROTECTED: anonymous and garbage-bearer callers get 401 on the status list — auth precedes every non-@Public github-app handler', async ({
        browser,
        request,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anon = await ctx.request.get(`${GH_BASE}/installations`);
            expect(anon.status(), 'anon installations -> 401').toBe(401);
            const anonBody = await jsonBody(anon);
            expect(anonBody.statusCode).toBe(401);
            expect(msgText(anonBody)).toMatch(/Unauthorized/i);
        } finally {
            await ctx.close();
        }

        // A malformed bearer never resolves to a session -> 401, same as anon.
        const garbage = await request.get(`${GH_BASE}/installations`, {
            headers: { Authorization: `Bearer ${uniq('garbage')}` },
        });
        expect(garbage.status(), 'garbage bearer -> 401').toBe(401);
        expect(msgText(await jsonBody(garbage))).toMatch(/Unauthorized/i);
    });

    test('10. the authed github-app mutation routes resolve ownership to a NOT-FOUND for a fresh user: POST .../installations/:id/sync 401s "installation not found" and the deeper onboard route 404s "repository not found" — distinct not-found contracts, never a 5xx', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);

        // syncInstallation returns null for a non-owned id -> controller throws
        // UnauthorizedException (401), NOT NotFoundException. (Probed: this is the
        // real, slightly surprising contract — sync uses 401 for "not yours".)
        const sync = await request.post(`${GH_BASE}/installations/${uniq('123')}/sync`, {
            headers,
        });
        expect(sync.status(), 'sync of an unowned installation -> 401').toBe(401);
        const syncBody = await jsonBody(sync);
        expect(syncBody.statusCode).toBe(401);
        expect(msgText(syncBody)).toMatch(/installation not found/i);

        // onboardInstallationRepository returns null -> controller throws
        // NotFoundException (404) — a DIFFERENT not-found contract on the deeper route.
        const onboard = await request.post(
            `${GH_BASE}/installations/${uniq('123')}/repositories/${uniq('456')}/onboard`,
            { headers },
        );
        expect(onboard.status(), 'onboard of an unowned repo -> 404').toBe(404);
        const onboardBody = await jsonBody(onboard);
        expect(onboardBody.statusCode).toBe(404);
        expect(msgText(onboardBody)).toMatch(/repository not found/i);
    });

    test('11. ROUTE ENUMERATION — github-app webhooks is POST-only (GET 404s) and a bogus sub-path 404s; there is NO twenty-crm config/status/health HTTP route at all (the only mounted twenty-crm controller is companies)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);

        // webhooks is declared @Post only — a GET has no matching route.
        const webhookGet = await request.get(`${GH_BASE}/webhooks`);
        expect(webhookGet.status(), 'GET on POST-only webhooks -> 404').toBe(404);
        expect(msgText(await jsonBody(webhookGet))).toMatch(
            /Cannot GET \/api\/github-app\/webhooks/,
        );

        // A clearly bogus github-app sub-path is unmatched -> 404.
        const bogus = await request.get(`${GH_BASE}/${uniq('nonexistent')}`, { headers });
        expect(bogus.status(), 'bogus github-app sub-path -> 404').toBe(404);

        // The twenty-crm module mounts ONLY CompaniesController: there is no GET
        // config/status/health endpoint reachable while the integration is off.
        for (const noun of ['config', 'status', 'health']) {
            const res = await request.get(`${CRM_BASE}/${noun}`, { headers });
            expect(res.status(), `/api/twenty-crm/${noun} is not a route -> 404`).toBe(404);
            expect(msgText(await jsonBody(res))).toMatch(
                new RegExp(`Cannot GET /api/twenty-crm/${noun}`),
            );
        }
    });

    test('12. CONTRAST ANCHOR — the two sibling integrations have OPPOSITE unconfigured postures for an identical authed caller: twenty-crm companies fails CLOSED (403 "Forbidden resource") while github-app installations serves an OPEN 200 [] status, proving the gate is per-integration, not a blanket integrations lockout', async ({
        request,
    }) => {
        // One fresh user hits BOTH integrations so the only difference is the
        // integration's own posture, not the caller.
        const { access_token } = await registerUserViaAPI(request);
        const headers = authedHeaders(access_token);

        const crm = await request.get(`${CRM_BASE}/companies`, { headers });
        const gh = await request.get(`${GH_BASE}/installations`, { headers });

        // twenty-crm: CrmSyncGuard short-circuits (unconfigured) -> 403. (Tolerate a
        // 200 only on a stack that configured Twenty; the keyless CI reality is 403.)
        expect([200, 403], `crm companies status ${crm.status()}`).toContain(crm.status());
        if (crm.status() === 403) {
            const crmBody = await jsonBody(crm);
            expect(crmBody.message).toBe('Forbidden resource');
            expect(crmBody.statusCode).toBe(403);
        }

        // github-app: no integration gate on the status route -> 200 [] regardless of
        // whether the App is configured (a fresh user simply owns no installations).
        expect(gh.status(), 'github-app installations -> 200 (no blanket lockout)').toBe(200);
        expect(Array.isArray(await gh.json())).toBe(true);

        // The CONTRAST itself: the two integrations under the SAME caller diverge.
        expect(
            crm.status() !== gh.status() || crm.status() === 200,
            'unconfigured CRM (403) and github-app (200) postures differ for the same user',
        ).toBe(true);
    });
});
