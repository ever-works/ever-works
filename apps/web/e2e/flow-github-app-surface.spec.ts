import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * GitHub-App controller surface — deep authz + contract coverage of the
 * thinly-tested `GitHubAppController` (apps/api/src/integrations/
 * github-app/github-app.controller.ts) and the public callback/setup/
 * webhook gating around it.
 *
 * NON-DUPLICATION
 * ---------------
 * `flow-work-webhook-signatures.spec.ts` already owns the INBOUND
 * `POST /api/github-app/webhooks` SIGNATURE matrix (forged full-length
 * HMAC, sha1=/raw-hex/Bearer/empty-digest prefix discipline, unknown
 * event types, and the missing-`X-GitHub-Event` 400). This file does
 * NOT re-assert any of that. It covers the OTHER guard on the same
 * receiver (the `rawBody`-presence 400, which is ordered AFTER the
 * event-name guard but BEFORE the signature verifier) and the
 * wrong-HTTP-method 404 — then spends the rest of its budget on the
 * AUTHENTICATED surfaces (`installations` list, `sync`, `onboard`) and
 * the PUBLIC OAuth `setup` / `callback` DTO + state gating, which no
 * sibling touches. The cross-user IDOR matrix in
 * `flow-idor-resource-access.spec.ts` covers works/agents/tasks/etc. —
 * NOT the github-app routes, which are exercised here.
 *
 * PROBED CONTRACTS (live API @ 127.0.0.1:3100, sqlite in-memory CI
 * driver; `GITHUB_APP_ID=999999` is a fake app id so any code path that
 * reaches the real GitHub API fails closed). Every status/shape below
 * was curl-probed with throwaway users BEFORE being asserted:
 *
 *   Auth        POST /api/auth/register {username,email,password} →
 *               {access_token, user:{id,email,username}}.
 *
 *   Installations list — GET /api/github-app/installations (authed,
 *               AuthSessionGuard — NO @Public):
 *                 - anon / malformed bearer → 401 {message:'Unauthorized',
 *                   statusCode:401}.
 *                 - authed, no installations → 200 `[]` (JSON array,
 *                   `application/json; charset=utf-8`).
 *                 - CONTRACT (Wave M #138): each installation row is
 *                   built by stripping `rawPayload` in
 *                   GitHubAppSyncService.listInstallationsForUser — the
 *                   internal GitHub webhook audit blob is NEVER returned.
 *                   We pin the field's absence (and on the empty list,
 *                   the absence of the literal token anywhere in the
 *                   body) so a regression that spreads the raw entity
 *                   reddens.
 *
 *   Sync — POST /api/github-app/installations/:installationId/sync
 *               (authed):
 *                 - anon → 401 Unauthorized.
 *                 - authed, installation unknown to this user → 401
 *                   {message:'GitHub App installation not found for this
 *                   user', error:'Unauthorized', statusCode:401} (the
 *                   controller maps the service's null → 401; a
 *                   non-numeric installationId takes the SAME path —
 *                   there is no uuid/int pipe, the id is looked up as an
 *                   opaque string and simply misses).
 *
 *   Onboard — POST /api/github-app/installations/:installationId/
 *               repositories/:repositoryId/onboard (authed):
 *                 - anon → 401 Unauthorized.
 *                 - authed, installation unknown to this user → 404
 *                   {message:'GitHub App repository not found for this
 *                   user', error:'Not Found', statusCode:404} (distinct
 *                   status from sync's 401 — pinned as a contract).
 *
 *   Setup — GET /api/github-app/setup (@Public, GitHubAppSetupQueryDto):
 *                 - missing installation_id → 400
 *                   {message:['installation_id must be a string'],...}.
 *                 - setup_action not in {install,request} → 400
 *                   {message:['setup_action must be one of the following
 *                   values: install, request'],...}.
 *                 - valid-shape installation_id → reaches
 *                   beginSetup→getInstallation which calls the real
 *                   GitHub API with the fake app id and fails ⇒ 500
 *                   {statusCode:500,message:'Internal server error'} — a
 *                   GENERIC envelope that leaks no app id / token / stack.
 *
 *   Callback — GET /api/github-app/callback (@Public,
 *               GitHubAppCallbackQueryDto + HMAC state):
 *                 - missing code AND state → 400 with BOTH
 *                   ['code must be a string','state must be a string'].
 *                 - missing state only → 400 ['state must be a string'].
 *                 - code+state present but state not HMAC-signed → 400
 *                   {message:'Invalid GitHub App state signature',
 *                   error:'Bad Request'} (signed-state guard, NOT a 500).
 *
 *   Webhook receiver — POST /api/github-app/webhooks (@Public):
 *                 - X-GitHub-Event present but NO body (rawBody absent) →
 *                   400 {message:'Missing raw webhook payload', error:
 *                   'Bad Request'} (the rawBody guard, ordered after the
 *                   event-name guard, before signature verification —
 *                   NOT covered by the signature sibling).
 *                 - GET /api/github-app/webhooks (wrong method) → 404
 *                   "Cannot GET /api/github-app/webhooks".
 *
 * ISOLATION: every authed assertion uses a FRESH registerUserViaAPI()
 * user (never the seeded chat user — a user-scoped key would shadow the
 * env key and break sibling chat specs). Anonymous requests pass NO
 * Authorization header; the API is Bearer-token authed (not cookie), so
 * the absence of the header IS the anonymous identity regardless of the
 * project's stored web storageState. Unique suffixes derive from the
 * test title via a per-describe counter — no clock is read at module
 * scope.
 */

const GH = '/api/github-app';
const INSTALLATIONS = `${GH}/installations`;
const SETUP = `${GH}/setup`;
const CALLBACK = `${GH}/callback`;
const WEBHOOKS = `${GH}/webhooks`;

/** Per-file counter for unique-but-deterministic suffixes (no module-scope clock). */
let seq = 0;
function suffix(): string {
    seq += 1;
    return `gh${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Actor {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    headers: { Authorization: string };
}

async function makeActor(request: APIRequestContext): Promise<Actor> {
    const user = await registerUserViaAPI(request);
    return { user, headers: authedHeaders(user.access_token) };
}

/** Tokens that must never surface in an error body for this surface. */
const LEAK_TOKENS = [
    'rawpayload',
    'access_token',
    'client_secret',
    'webhook secret',
    'private key',
    '-----begin',
    '    at ', // node stack-frame indent
    'node_modules',
    'queryfailederror',
];

async function assertNoLeak(
    res: { text(): Promise<string> },
    context: string,
): Promise<string> {
    const raw = await res.text();
    const lower = raw.toLowerCase();
    for (const token of LEAK_TOKENS) {
        expect(lower, `${context} leaked '${token}' → ${raw.slice(0, 200)}`).not.toContain(token);
    }
    return raw;
}

test.describe('GitHub-App controller surface — authz + contracts', () => {
    // ── 1 ── installations list: anonymous is rejected with the NestJS
    //         guard envelope (Bearer-auth, not cookie) — both no-header
    //         and a malformed bearer collapse to the same opaque 401.
    test('installations list — anonymous and malformed-bearer both 401, never an array', async ({
        request,
    }) => {
        const anon = await request.get(`${API_BASE}${INSTALLATIONS}`);
        expect(anon.status(), 'anon installations list').toBe(401);
        const anonBody = JSON.parse(await assertNoLeak(anon, 'anon installations')) as {
            message: string;
            statusCode: number;
        };
        expect(anonBody.statusCode).toBe(401);
        expect(anonBody.message).toBe('Unauthorized');

        const bad = await request.get(`${API_BASE}${INSTALLATIONS}`, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(bad.status(), 'malformed bearer installations list').toBe(401);
        // A garbage token must be indistinguishable from no token: same
        // status, same envelope — no "token exists but is wrong" oracle.
        const badBody = JSON.parse(await assertNoLeak(bad, 'bad-bearer installations')) as {
            message: string;
            statusCode: number;
        };
        expect(badBody.statusCode).toBe(401);
        expect(badBody.message).toBe('Unauthorized');
    });

    // ── 2 ── installations list: a fresh authed user with no GitHub App
    //         connected gets an EMPTY ARRAY (the unconfigured state), not
    //         a 404/500 — and the body carries no `rawPayload` token.
    test('installations list — fresh user sees an empty JSON array (unconfigured state), 200', async ({
        request,
    }) => {
        const a = await makeActor(request);
        const res = await request.get(`${API_BASE}${INSTALLATIONS}`, { headers: a.headers });
        expect(res.status(), 'authed empty installations').toBe(200);
        expect(res.headers()['content-type'] ?? '').toContain('application/json');
        const raw = await assertNoLeak(res, 'authed installations');
        const body = JSON.parse(raw) as unknown[];
        expect(Array.isArray(body), 'installations list is a JSON array').toBe(true);
        expect(body.length, 'a brand-new user owns no installations').toBe(0);
        // Wave M #138 contract: the raw audit blob never appears even as a
        // bare token in the serialized list.
        expect(raw.toLowerCase()).not.toContain('rawpayload');
    });

    // ── 3 ── sync: anonymous is 401 (the @Public webhook routes do not
    //         leak onto the guarded sync route).
    test('sync — anonymous POST is 401, never reaches the sync service', async ({ request }) => {
        const res = await request.post(`${API_BASE}${INSTALLATIONS}/123456/sync`);
        expect(res.status(), 'anon sync').toBe(401);
        const body = JSON.parse(await assertNoLeak(res, 'anon sync')) as { statusCode: number };
        expect(body.statusCode).toBe(401);
    });

    // ── 4 ── sync: an authed user syncing an installation that does not
    //         belong to them gets the service-null → 401 mapping with the
    //         exact "not found for this user" message. A non-numeric id
    //         takes the SAME path (no pipe), proving it's a lookup miss,
    //         not an input-validation 400 — and is indistinguishable from
    //         a numeric unknown id (no existence oracle).
    test('sync — unknown installation (numeric & non-numeric) is a 401 "not found for this user", no enumeration oracle', async ({
        request,
    }) => {
        const a = await makeActor(request);

        const numeric = await request.post(`${API_BASE}${INSTALLATIONS}/9999999/sync`, {
            headers: a.headers,
        });
        expect(numeric.status(), 'authed unknown numeric installation sync').toBe(401);
        const numBody = JSON.parse(await assertNoLeak(numeric, 'sync unknown numeric')) as {
            message: string;
            statusCode: number;
        };
        expect(numBody.statusCode).toBe(401);
        expect(numBody.message).toBe('GitHub App installation not found for this user');

        const nonNumeric = await request.post(
            `${API_BASE}${INSTALLATIONS}/abc-not-numeric/sync`,
            { headers: a.headers },
        );
        expect(nonNumeric.status(), 'authed non-numeric installation sync').toBe(401);
        const nnBody = JSON.parse(await assertNoLeak(nonNumeric, 'sync non-numeric')) as {
            message: string;
        };
        // Same opaque message → the id shape is not an oracle; both are
        // plain lookup misses on the createdByUserId-scoped query.
        expect(nnBody.message).toBe('GitHub App installation not found for this user');
    });

    // ── 5 ── sync cross-user: a SECOND fresh user gets the same 401 for
    //         the same id the first user also can't see — neither owns it,
    //         so the response is identical (the scope filter is per-user,
    //         and an unowned id never differs from a never-existed one).
    test('sync — two distinct users hit the identical 401 for the same unowned installation id', async ({
        request,
    }) => {
        const alice = await makeActor(request);
        const bob = await makeActor(request);
        // A large numeric id that no fresh-DB installation owns. `seq` is
        // a digit so the strip never empties; the trailing digits keep it
        // numeric-shaped (the route has no pipe, so shape is irrelevant —
        // it's purely a guaranteed-miss lookup key).
        const id = `8800${seq}${Date.now().toString().slice(-5)}`;

        const aRes = await request.post(`${API_BASE}${INSTALLATIONS}/${id}/sync`, {
            headers: alice.headers,
        });
        const bRes = await request.post(`${API_BASE}${INSTALLATIONS}/${id}/sync`, {
            headers: bob.headers,
        });
        expect(aRes.status(), 'alice sync unowned').toBe(401);
        expect(bRes.status(), 'bob sync unowned').toBe(401);
        const aMsg = (JSON.parse(await aRes.text()) as { message: string }).message;
        const bMsg = (JSON.parse(await bRes.text()) as { message: string }).message;
        expect(aMsg).toBe('GitHub App installation not found for this user');
        expect(bMsg, 'both users see the byte-identical not-found').toBe(aMsg);
    });

    // ── 6 ── onboard: anonymous is 401.
    test('onboard — anonymous POST is 401', async ({ request }) => {
        const res = await request.post(
            `${API_BASE}${INSTALLATIONS}/123/repositories/456/onboard`,
        );
        expect(res.status(), 'anon onboard').toBe(401);
        const body = JSON.parse(await assertNoLeak(res, 'anon onboard')) as { statusCode: number };
        expect(body.statusCode).toBe(401);
    });

    // ── 7 ── onboard: an authed user onboarding under an installation
    //         they don't own gets 404 (DISTINCT from sync's 401 — the
    //         controller throws NotFoundException for the repo route).
    //         Pinning the status divergence guards against a refactor that
    //         accidentally unifies the two error shapes.
    test('onboard — unknown installation/repo is a 404 "repository not found", distinct from sync 401', async ({
        request,
    }) => {
        const a = await makeActor(request);
        const res = await request.post(
            `${API_BASE}${INSTALLATIONS}/999/repositories/456/onboard`,
            { headers: a.headers },
        );
        expect(res.status(), 'authed unknown onboard').toBe(404);
        const body = JSON.parse(await assertNoLeak(res, 'onboard unknown')) as {
            message: string;
            error: string;
            statusCode: number;
        };
        expect(body.statusCode).toBe(404);
        expect(body.error).toBe('Not Found');
        expect(body.message).toBe('GitHub App repository not found for this user');

        // Contrast contract: the SAME unknown installation on the SYNC
        // route is a 401, not a 404 — the two guarded routes report
        // different statuses by design.
        const sync = await request.post(`${API_BASE}${INSTALLATIONS}/999/sync`, {
            headers: a.headers,
        });
        expect(sync.status(), 'sync of the same unknown id stays 401').toBe(401);
    });

    // ── 8 ── setup: DTO validation. Missing installation_id and an
    //         out-of-enum setup_action are class-validator 400s with the
    //         field-named messages (the @Public route still validates).
    test('setup — missing installation_id and bad setup_action are field-named 400s', async ({
        request,
    }) => {
        const missing = await request.get(`${API_BASE}${SETUP}`);
        expect(missing.status(), 'setup missing installation_id').toBe(400);
        const missingBody = JSON.parse(await assertNoLeak(missing, 'setup missing id')) as {
            message: string[];
            statusCode: number;
        };
        expect(missingBody.statusCode).toBe(400);
        expect(missingBody.message).toContain('installation_id must be a string');

        const badAction = await request.get(
            `${API_BASE}${SETUP}?installation_id=123&setup_action=bogus`,
        );
        expect(badAction.status(), 'setup bad setup_action').toBe(400);
        const badBody = JSON.parse(await assertNoLeak(badAction, 'setup bad action')) as {
            message: string[];
        };
        expect(
            badBody.message.some((m) => m.includes('install, request')),
            'enum message names the allowed values',
        ).toBe(true);
    });

    // ── 9 ── setup: a valid-shape installation_id reaches the GitHub API
    //         (fake app id 999999) which fails ⇒ a GENERIC 500 envelope.
    //         The unconfigured/fake-app outcome must NOT leak the app id,
    //         a token, or a stack trace — it is the sanitized
    //         "Internal server error".
    test('setup — valid-shape id with the fake CI app fails closed as a generic 500 (no app-id/token/stack leak)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}${SETUP}?installation_id=55512345`);
        expect(res.status(), 'setup fake-app outcome').toBe(500);
        const raw = await assertNoLeak(res, 'setup fake-app 500');
        const body = JSON.parse(raw) as { statusCode: number; message: string };
        expect(body.statusCode).toBe(500);
        expect(body.message, 'generic envelope, no internals').toBe('Internal server error');
        // The fake app id must not bleed into the client response.
        expect(raw).not.toContain('999999');
    });

    // ── 10 ── callback: DTO validation. Both fields missing names BOTH;
    //          dropping only state names only state — the message array is
    //          precise per-field (class-validator), and it's a 400 BEFORE
    //          any state/HMAC work.
    test('callback — missing code/state produce precise per-field 400s', async ({ request }) => {
        const both = await request.get(`${API_BASE}${CALLBACK}`);
        expect(both.status(), 'callback no params').toBe(400);
        const bothBody = JSON.parse(await assertNoLeak(both, 'callback no params')) as {
            message: string[];
        };
        expect(bothBody.message).toContain('code must be a string');
        expect(bothBody.message).toContain('state must be a string');

        const onlyCode = await request.get(`${API_BASE}${CALLBACK}?code=abc`);
        expect(onlyCode.status(), 'callback code-only').toBe(400);
        const onlyCodeBody = JSON.parse(await assertNoLeak(onlyCode, 'callback code-only')) as {
            message: string[];
        };
        expect(onlyCodeBody.message).toContain('state must be a string');
        expect(
            onlyCodeBody.message,
            'a supplied code is not re-flagged',
        ).not.toContain('code must be a string');
    });

    // ── 11 ── callback: code+state present but state is not HMAC-signed →
    //          the signed-state guard returns 400 "Invalid GitHub App
    //          state signature" — a clean BadRequest, NOT a 500, and the
    //          supplied bogus state is not echoed back.
    test('callback — an unsigned/forged state is a 400 signature rejection, never a 500 or echo', async ({
        request,
    }) => {
        const forgedState = `forged-${suffix()}.notarealsignature`;
        const res = await request.get(
            `${API_BASE}${CALLBACK}?code=abc&state=${encodeURIComponent(forgedState)}`,
        );
        expect(res.status(), 'callback forged state').toBe(400);
        const raw = await assertNoLeak(res, 'callback forged state');
        const body = JSON.parse(raw) as { message: string; error: string };
        expect(body.error).toBe('Bad Request');
        expect(body.message).toBe('Invalid GitHub App state signature');
        // The forged value must not be reflected (no error-echo / XSS vector).
        expect(raw).not.toContain(forgedState);
    });

    // ── 12 ── webhook receiver: the rawBody-presence guard (distinct from
    //          the signature matrix the sibling owns) — an event header
    //          with NO body is a 400 "Missing raw webhook payload"; and a
    //          GET on the POST-only route is a 404. Both prove the public
    //          receiver is shaped correctly before authenticity is even
    //          considered.
    test('webhook receiver — missing rawBody is a 400 (distinct guard) and wrong method is a 404', async ({
        request,
    }) => {
        // Event header present, but no request body → the rawBody guard
        // fires (ordered after event-name, before signature verification).
        const noBody = await request.post(`${API_BASE}${WEBHOOKS}`, {
            headers: { 'X-GitHub-Event': 'ping' },
        });
        expect(noBody.status(), 'webhook missing rawBody').toBe(400);
        const noBodyJson = JSON.parse(await assertNoLeak(noBody, 'webhook no body')) as {
            message: string;
            error: string;
        };
        expect(noBodyJson.error).toBe('Bad Request');
        expect(noBodyJson.message).toBe('Missing raw webhook payload');

        // Wrong method on the webhook path → NestJS 404 route-not-found.
        const wrongMethod = await request.get(`${API_BASE}${WEBHOOKS}`);
        expect(wrongMethod.status(), 'GET on POST-only webhook route').toBe(404);
        const wmJson = JSON.parse(await assertNoLeak(wrongMethod, 'webhook wrong method')) as {
            message: string;
            statusCode: number;
        };
        expect(wmJson.statusCode).toBe(404);
        expect(wmJson.message).toContain('Cannot GET');
    });
});
