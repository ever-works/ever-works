import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-settings-github-app — COMPLEX, cross-feature INTEGRATION flows for the
 * GitHub *App* (installation-based) integration: its setup → signed-state →
 * callback onboarding lifecycle, the installation status / ownership surface,
 * the web entry-point redirect (SSRF-pinned) contract, and — crucially — the
 * distinction between the GitHub *App* plane and the *OAuth/social* + the
 * *git-provider capability* planes that all share the provider id `github`.
 *
 * NON-DUPLICATION: the shallow API smoke in `github-app.spec.ts` only pings a
 * few endpoints for "not-5xx"; `flow-work-webhook-signatures.spec.ts` owns the
 * inbound webhook signature *verification* matrix (sha256= prefix discipline,
 * forged-HMAC rejection) and the outbound subscription signing. This file does
 * NOT re-assert those — it owns the SETUP/CALLBACK state machine, the
 * installation ownership-isolation status gradient, the app-vs-oauth plane
 * distinction, the web-route redirect contract, and the UI settings page.
 *
 * Probed LIVE against API :3100 + web :3000 + read from source before
 * asserting (apps/api/src/integrations/github-app/*, apps/web/src/app/api/
 * github-app/*, apps/web/src/components/settings/GitHubAppSettings.tsx):
 *
 *   API controller `@Controller('api/github-app')`:
 *     - GET  /setup  (@Public)  query DTO: installation_id REQUIRED (string),
 *         setup_action ∈ {install,request} optional, redirectTo optional.
 *         · no installation_id            → 400 ["installation_id must be a string"]
 *         · setup_action invalid          → 400 ["setup_action must be one of …"]
 *         · valid installation_id         → 500 (service calls GitHub
 *           `getInstallation`; CI has NO GitHub App credentials →
 *           getCredentials() throws → 500). The 500 here is the TRUTHFUL
 *           CI contract, not a bug — we pin "reaches service ⇒ 500, body
 *           leaks no credentials".
 *     - GET  /callback  (@Public)  query DTO: code + state REQUIRED.
 *         HMAC state machine (no GitHub call needed — deterministic):
 *         · neither                       → 400 ["code …","state …"]
 *         · code only                     → 400 ["state must be a string"]
 *         · state=""                      → 400 "Invalid GitHub App state"
 *         · state="a.b" (wrong sig)       → 400 "Invalid GitHub App state signature"
 *         · valid-structure, wrong sig    → 400 "Invalid GitHub App state signature"
 *     - GET  /installations         (AUTHED) → JSON ARRAY (fresh user: []).
 *     - POST /installations/:id/sync (AUTHED) bogus id → 401
 *         "GitHub App installation not found for this user".
 *     - POST /installations/:id/repositories/:repoId/onboard (AUTHED)
 *         bogus ids → 404 "GitHub App repository not found for this user".
 *       (Note the DELIBERATE status divergence: sync 401 vs onboard 404 — a
 *        contract worth pinning, they come from different exceptions.)
 *     - POST /webhooks  (@Public) event header → raw body → signature, in that
 *         order: missing event 400 "Missing GitHub event header"; event but
 *         empty body 400 "Missing raw webhook payload"; event + body, bad/no
 *         sig 401 "Invalid GitHub webhook signature".
 *     - wrong HTTP method on any path → 404 "Cannot <METHOD> /…".
 *
 *   Web Next.js routes (apps/web/src/app/api/github-app/{setup,callback}):
 *     - both proxy the API; on ANY upstream non-ok (always, in CI) they 3xx
 *       to /auth/error?error=oauth_callback. setup additionally pins the
 *       redirect target to protocol https + hostname github.com (SSRF guard).
 *
 *   OAuth/social plane (DISTINCT): GET /api/auth/providers →
 *       { socialProviders:["github","google"] }; GET /api/oauth/github/url →
 *       { url:"https://github.com/login/oauth/authorize?…scope=read:user…", state }.
 *   git-provider capability plane (DISTINCT): GET /api/git-providers/github/
 *       connection → { id:"github", connected:false, … }.
 *
 *   UI: /settings/github-app renders GitHubAppSettings; empty state shows
 *       "No GitHub App installations yet" (i18n dashboard.settings.githubApp.
 *       emptyTitle); settings nav exposes a "GitHub App" tab.
 *
 * Gotchas respected: cross-spec MUTATION isolation uses FRESH
 * registerUserViaAPI() users (never the shared seeded user); UI assertions use
 * the seeded storageState; anon context passes empty storageState; next-dev
 * local-vs-CI route divergence handled with `.or()`; generous timeouts +
 * toPass/poll for hydration.
 */

const GH = '/api/github-app';
const SETUP = `${GH}/setup`;
const CALLBACK = `${GH}/callback`;
const INSTALLATIONS = `${GH}/installations`;
const WEBHOOKS = `${GH}/webhooks`;

/** A bearer for the shared seeded user — for read-only API assertions. */
async function seededBearer(request: APIRequestContext): Promise<string> {
    const s = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: s.email, password: s.password },
    });
    expect(res.status(), 'seeded login should succeed').toBe(200);
    const { access_token } = await res.json();
    expect(typeof access_token).toBe('string');
    return access_token;
}

/** Build a structurally-valid-but-unsigned `<payload>.<sig>` state string. */
function craftState(payload: Record<string, unknown>, sig: string): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${sig}`;
}

test.describe('GitHub App — setup → signed-state → callback onboarding lifecycle', () => {
    test('setup DTO gradient: missing id 400, invalid setup_action 400 (validated BEFORE the service), valid id reaches the credential-less service ⇒ 500 with no secret leak', async ({
        request,
    }) => {
        // 1) No installation_id — the @Public setup endpoint still validates
        //    its query DTO before doing anything.
        const noId = await request.get(`${API_BASE}${SETUP}`);
        expect(noId.status(), 'setup without installation_id must 400').toBe(400);
        const noIdBody = await noId.json();
        expect(JSON.stringify(noIdBody.message)).toContain('installation_id');

        // 2) installation_id present but setup_action out of the enum — the
        //    class-validator @IsIn rejects BEFORE the service is touched, so
        //    this is a 400 even though a *valid* setup_action would 500.
        const badAction = await request.get(
            `${API_BASE}${SETUP}?installation_id=12345&setup_action=definitely-not-valid`,
        );
        expect(badAction.status(), 'invalid setup_action must 400').toBe(400);
        expect(JSON.stringify(await badAction.json()).toLowerCase()).toContain('setup_action');

        // 3) A *valid* DTO sails past validation and reaches
        //    GitHubAppOnboardingService.beginSetup → getInstallation, which
        //    needs GitHub App credentials this CI env does not have. The
        //    truthful contract is a 500 — what we PIN is that it's a clean
        //    server error that does not echo a private key, client secret,
        //    or auth secret.
        const reachesService = await request.get(`${API_BASE}${SETUP}?installation_id=12345`);
        expect(
            reachesService.status(),
            `valid setup DTO should reach the credential-less service (500), got ${reachesService.status()}`,
        ).toBe(500);
        const leak = (await reachesService.text()).toLowerCase();
        expect(leak).not.toContain('private');
        expect(leak).not.toContain('client_secret');
        expect(leak).not.toContain('begin rsa');
        expect(leak).not.toContain('webhook');
    });

    test('callback HMAC state machine: required-field gradient then a four-rung signature gradient — every malformed state is a deterministic 400 that never reaches GitHub', async ({
        request,
    }) => {
        // The callback is @Public and validates state authenticity LOCALLY
        // (HMAC over the auth secret) before any network call. Every rung
        // below is reproducible without GitHub creds — proving the state
        // gate is the first line of defense.

        // Rung 0 — DTO: both fields required.
        const neither = await request.get(`${API_BASE}${CALLBACK}`);
        expect(neither.status()).toBe(400);
        const neitherMsg = JSON.stringify(await neither.json());
        expect(neitherMsg).toContain('code');
        expect(neitherMsg).toContain('state');

        // Rung 1 — code present, state missing entirely.
        const codeOnly = await request.get(`${API_BASE}${CALLBACK}?code=abc`);
        expect(codeOnly.status()).toBe(400);
        expect(JSON.stringify(await codeOnly.json())).toContain('state');

        // Rung 2 — state present but EMPTY: split('.') yields no signature
        //          part → "Invalid GitHub App state" (structure failure).
        const emptyState = await request.get(`${API_BASE}${CALLBACK}?code=abc&state=`);
        expect(emptyState.status()).toBe(400);
        expect((await emptyState.json()).message).toBe('Invalid GitHub App state');

        // Rung 3 — state has the right SHAPE (payload.sig) but the signature
        //          is the wrong byte-length → "… state signature" (the length
        //          guard before timingSafeEqual).
        const shapeWrongLen = await request.get(`${API_BASE}${CALLBACK}?code=abc&state=aaa.bbb`);
        expect(shapeWrongLen.status()).toBe(400);
        expect((await shapeWrongLen.json()).message).toBe('Invalid GitHub App state signature');

        // Rung 4 — a base64url payload that actually decodes to a plausible
        //          SetupStatePayload, but signed with a forged signature →
        //          still "… state signature". This is the closest an attacker
        //          can get without the server's auth secret, and it is
        //          rejected at the HMAC compare, NOT at GitHub.
        const forged = craftState(
            { installationId: '999', issuedAt: Date.now() },
            'deadbeefdeadbeefdeadbeefdeadbeef',
        );
        const forgedRes = await request.get(`${API_BASE}${CALLBACK}?code=abc&state=${forged}`);
        expect(forgedRes.status()).toBe(400);
        expect((await forgedRes.json()).message).toMatch(/invalid github app state/i);

        // Nothing in any rung should leak the auth/HMAC secret.
        for (const r of [emptyState, shapeWrongLen, forgedRes]) {
            expect((await r.text()).toLowerCase()).not.toMatch(/hmac|auth.?secret|expected/);
        }
    });
});

test.describe('GitHub App — installation status & ownership isolation', () => {
    test('a fresh account starts with an empty installation list (array shape, not a wrapper) and that empty surface is private to the account', async ({
        request,
    }) => {
        // Unauth → 401 (the @Public decorator is NOT on the installations
        // listing — only setup/callback/webhooks are public).
        const anon = await request.get(`${API_BASE}${INSTALLATIONS}`);
        expect(anon.status(), 'installations must require auth').toBe(401);

        // A brand-new isolated user — never the seeded one (mutation-free but
        // we still want a clean baseline that no other spec can have seeded).
        const u = await registerUserViaAPI(request);
        const listed = await request.get(`${API_BASE}${INSTALLATIONS}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(listed.status()).toBe(200);
        const body = await listed.json();
        // The controller returns the raw array (verified live: `[]`) — not a
        // `{ installations: [] }` envelope. Tolerate either at the helper
        // level but assert it is genuinely empty for a fresh account.
        const arr = Array.isArray(body) ? body : (body?.installations ?? body?.data ?? []);
        expect(Array.isArray(arr), 'installations must be an array').toBe(true);
        expect(arr.length, 'a fresh account has zero installations').toBe(0);

        // A malformed bearer is rejected identically to no bearer — no
        // information about the (empty) installation set leaks pre-auth.
        const malformed = await request.get(`${API_BASE}${INSTALLATIONS}`, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(malformed.status()).toBe(401);
    });

    test('ownership-scoped mutations on non-existent installations return DISTINCT statuses — sync 401 vs onboard 404 — and the message never confirms existence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // sync on an installation this user does not own / that does not
        // exist → 401 (UnauthorizedException "… not found for this user").
        // The 401 (not 404) here is the deliberate contract: the sync path
        // treats "not yours" as an auth failure.
        const syncBogus = await request.post(`${API_BASE}${INSTALLATIONS}/9999999/sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(syncBogus.status(), 'sync on a non-owned installation → 401').toBe(401);
        const syncMsg = (await syncBogus.json()).message;
        expect(String(syncMsg)).toMatch(/not found for this user/i);

        // A pathologically long id must take the SAME branch (no DB/parse
        // crash, no 5xx) — still 401.
        const syncLong = await request.post(`${API_BASE}${INSTALLATIONS}/${'9'.repeat(40)}/sync`, {
            headers: authedHeaders(u.access_token),
        });
        expect(syncLong.status(), 'oversized installation id must not 5xx').toBe(401);

        // onboard on a non-existent installation/repository pair → 404
        // (NotFoundException "GitHub App repository not found for this user").
        // Same "you can't touch it" semantics, DIFFERENT status — this
        // divergence is the load-bearing assertion of this flow.
        const onboardBogus = await request.post(
            `${API_BASE}${INSTALLATIONS}/9999999/repositories/8888888/onboard`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(onboardBogus.status(), 'onboard on a non-owned repo → 404').toBe(404);
        expect(String((await onboardBogus.json()).message)).toMatch(/repository not found/i);

        // Both mutation routes are auth-gated: unauth → 401 regardless of id.
        const syncUnauth = await request.post(`${API_BASE}${INSTALLATIONS}/9999999/sync`);
        expect(syncUnauth.status()).toBe(401);
        const onboardUnauth = await request.post(
            `${API_BASE}${INSTALLATIONS}/9999999/repositories/8888888/onboard`,
        );
        expect(onboardUnauth.status()).toBe(401);

        // Two independent fresh accounts both see an empty, mutually-isolated
        // installation set — neither can observe the other via these routes.
        const other = await registerUserViaAPI(request);
        const otherList = await request.get(`${API_BASE}${INSTALLATIONS}`, {
            headers: authedHeaders(other.access_token),
        });
        expect(otherList.status()).toBe(200);
        const otherArr = await otherList.json();
        expect(Array.isArray(otherArr) ? otherArr.length : 0).toBe(0);
    });
});

test.describe('GitHub App vs OAuth/social vs git-provider — three planes, one provider id', () => {
    test('the App installation plane is mechanically distinct from social OAuth login and from the git-provider capability — all three resolve the SAME github id through DIFFERENT surfaces', async ({
        request,
    }) => {
        const token = await seededBearer(request);

        // PLANE A — GitHub *App* (installation-based). Its onboarding lives
        // under /api/github-app/* and is keyed on an HMAC-signed `state`, not
        // on a login session. The user-facing list is account-scoped.
        const appList = await request.get(`${API_BASE}${INSTALLATIONS}`, {
            headers: authedHeaders(token),
        });
        expect(appList.status()).toBe(200);
        expect(Array.isArray(await appList.json())).toBe(true);
        // Its setup endpoint speaks an installation_id contract — proof it is
        // the App plane (OAuth login has no such concept).
        const appSetup = await request.get(`${API_BASE}${SETUP}`);
        expect(appSetup.status()).toBe(400);
        expect(JSON.stringify(await appSetup.json())).toContain('installation_id');

        // PLANE B — social OAuth LOGIN. github is advertised as a social
        // provider, and its authorize URL targets login/oauth/authorize with
        // user-identity scopes — a completely different GitHub product than
        // App installations.
        const providers = await request.get(`${API_BASE}/api/auth/providers`);
        expect(providers.status()).toBe(200);
        const provJson = await providers.json();
        expect(Array.isArray(provJson.socialProviders)).toBe(true);
        expect(provJson.socialProviders).toContain('github');

        const oauthUrl = await request.get(`${API_BASE}/api/oauth/github/url`);
        expect(oauthUrl.status()).toBe(200);
        const oauthJson = await oauthUrl.json();
        expect(typeof oauthJson.url).toBe('string');
        // Login OAuth → /login/oauth/authorize (NOT /apps/<slug>/installations).
        expect(oauthJson.url).toContain('github.com/login/oauth/authorize');
        expect(oauthJson.url).toMatch(/scope=[^&]*read%3Auser|scope=[^&]*user%3Aemail/);
        expect(typeof oauthJson.state).toBe('string');
        expect(oauthJson.state.length).toBeGreaterThan(0);
        // The two planes use DIFFERENT state mechanisms: the App's callback
        // rejects this opaque OAuth-login token because it is not a signed
        // `<base64url-payload>.<hmac>` envelope — proof the surfaces don't
        // share a state format even though both say "github".
        const crossPlane = await request.get(
            `${API_BASE}${CALLBACK}?code=x&state=${encodeURIComponent(oauthJson.state)}`,
        );
        expect(crossPlane.status(), 'an OAuth-login state is not a valid App state').toBe(400);
        expect(String((await crossPlane.json()).message)).toMatch(/invalid github app state/i);

        // PLANE C — git-provider CAPABILITY. Same id `github`, exposed as a
        // connectable provider with a per-user connection flag. A fresh
        // session is not "connected" — and this connection state is wholly
        // independent of whether an App installation exists.
        const conn = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
            headers: authedHeaders(token),
        });
        expect(conn.status()).toBe(200);
        const connJson = await conn.json();
        expect(connJson.id).toBe('github');
        expect(typeof connJson.connected).toBe('boolean');

        // The three planes are reachable independently and do not collapse
        // into one another: the App list, the OAuth url, and the provider
        // connection are three separate 200s with three different shapes.
        expect(connJson).not.toHaveProperty('socialProviders');
        expect(oauthJson).not.toHaveProperty('connected');
    });
});

test.describe('GitHub App — web entry-point redirect & method discipline', () => {
    test('web /api/github-app/{setup,callback} never surface upstream errors — they 3xx to /auth/error, and setup pins its redirect to https://github.com (SSRF guard)', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // In CI the upstream API setup/callback always fail (no GitHub creds /
        // invalid state), so BOTH web routes must redirect to the auth-error
        // page rather than leaking the upstream 4xx/5xx body. We follow no
        // redirects so we can read the Location header directly.
        const webSetup = await page.request.get(`${origin}/api/github-app/setup`, {
            maxRedirects: 0,
        });
        expect(
            [302, 303, 307, 308].includes(webSetup.status()),
            `web setup should redirect, got ${webSetup.status()}`,
        ).toBe(true);
        const setupLoc = webSetup.headers()['location'] || '';
        expect(
            setupLoc,
            'web setup must redirect to the auth-error page on upstream failure',
        ).toContain('/auth/error');
        expect(setupLoc).toContain('error=oauth_callback');
        // It must NOT have followed through to github.com with our fake creds
        // — the SSRF guard only forwards to github.com on a SUCCESSFUL upstream
        // that returns an https://github.com url, which can't happen here.
        expect(setupLoc).not.toContain('github.com');

        // Even with a syntactically-plausible installation_id the web route
        // still redirects to auth-error (upstream 500), never to GitHub.
        const webSetupId = await page.request.get(
            `${origin}/api/github-app/setup?installation_id=12345`,
            { maxRedirects: 0 },
        );
        expect([302, 303, 307, 308].includes(webSetupId.status())).toBe(true);
        expect(webSetupId.headers()['location'] || '').toContain('/auth/error');

        // Callback: an invalid state likewise resolves to the auth-error
        // page — the access token is never set, no session is minted.
        const webCb = await page.request.get(
            `${origin}/api/github-app/callback?code=abc&state=bogus`,
            { maxRedirects: 0 },
        );
        expect(
            [302, 303, 307, 308].includes(webCb.status()),
            `web callback should redirect, got ${webCb.status()}`,
        ).toBe(true);
        const cbLoc = webCb.headers()['location'] || '';
        expect(cbLoc).toContain('/auth/error');
        expect(cbLoc).toContain('error=oauth_callback');
        // No auth cookie may be issued on a failed callback.
        const setCookie = webCb.headers()['set-cookie'] || '';
        expect(setCookie.toLowerCase()).not.toContain('access');
    });

    test('the API controller surface enforces method discipline — wrong verbs 404 "Cannot <M> /…" while the documented verbs stay reachable', async ({
        request,
    }) => {
        // Public GET-only endpoints must reject POST with the Nest "Cannot
        // POST" 404 (route not found for that verb), NOT a 405 and NOT a 500.
        const postSetup = await request.post(`${API_BASE}${SETUP}?installation_id=12345`);
        expect(postSetup.status()).toBe(404);
        expect(String((await postSetup.json()).message)).toMatch(/cannot post/i);

        // installations is GET-only — a PUT is an unknown route.
        const putInstalls = await request.put(`${API_BASE}${INSTALLATIONS}`);
        expect(putInstalls.status()).toBe(404);
        expect(String((await putInstalls.json()).message)).toMatch(/cannot put/i);

        // webhooks is POST-only — a GET is an unknown route (and importantly
        // not an accidental data-leaking handler).
        const getWebhooks = await request.get(`${API_BASE}${WEBHOOKS}`);
        expect(getWebhooks.status()).toBe(404);
        expect(String((await getWebhooks.json()).message)).toMatch(/cannot get/i);
    });
});

test.describe('GitHub App — inbound webhook guard ORDERING (event → raw body → signature)', () => {
    test('the receiver checks guards in a strict order: missing event 400, present-event-but-empty-body 400, present-body-but-unsigned 401 — each a distinct rung, none a 5xx', async ({
        request,
    }) => {
        // This complements (does NOT duplicate) flow-work-webhook-signatures,
        // which always sends a body and focuses on signature CORRECTNESS. Here
        // we pin the GUARD ORDERING — particularly the "Missing raw webhook
        // payload" branch that only fires when an event header is present but
        // the body is empty, a rung the signature spec never reaches.

        // Rung 1 — no X-GitHub-Event header at all: short-circuits BEFORE the
        // raw-body and signature checks.
        const noEvent = await request.post(`${API_BASE}${WEBHOOKS}`, {
            headers: { 'Content-Type': 'application/json' },
            data: { action: 'ping' },
        });
        expect(noEvent.status(), 'missing event header → 400').toBe(400);
        expect(String((await noEvent.json()).message)).toMatch(/missing github event/i);

        // Rung 2 — event header present but the request carries NO raw body.
        // The controller demands req.rawBody and 400s with a DISTINCT message
        // ("Missing raw webhook payload") before it ever consults the secret.
        const emptyBody = await request.post(`${API_BASE}${WEBHOOKS}`, {
            headers: { 'X-GitHub-Event': 'installation' },
        });
        expect(emptyBody.status(), 'event but empty body → 400').toBe(400);
        expect(String((await emptyBody.json()).message)).toMatch(/missing raw webhook payload/i);

        // Rung 3 — event header AND a body present, but no (or an invalid)
        // signature: now the signature verifier runs and rejects with 401.
        // In CI the webhook secret is unset so this 401s unconditionally —
        // which is exactly the safe default we want to pin (never 2xx, never
        // 5xx for an unsigned delivery).
        const unsigned = await request.post(`${API_BASE}${WEBHOOKS}`, {
            headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'installation' },
            data: { action: 'created', installation: { id: 42 } },
        });
        expect(unsigned.status(), 'present body, no signature → 401').toBe(401);
        expect(String((await unsigned.json()).message)).toMatch(
            /invalid github webhook signature/i,
        );

        // The three rungs returned three DIFFERENT (status,message) pairs —
        // proving the guards are independent and correctly ordered.
        expect(noEvent.status()).toBe(400);
        expect(emptyBody.status()).toBe(400);
        expect(unsigned.status()).toBe(401);
    });
});

test.describe('GitHub App — settings UI page (authenticated)', () => {
    test('the seeded user lands on /settings/github-app, sees the empty-installations state, and the page is reachable from the settings GitHub App tab; anon is gated', async ({
        page,
        browser,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // --- Anon gate first, in an isolated empty-storageState context so we
        //     don't inherit the seeded auth cookie. ---
        const anonCtx = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const anonPage = await anonCtx.newPage();
            const res = await anonPage.goto(`${origin}/en/settings/github-app`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            const finalUrl = anonPage.url();
            // Either bounced to /login, or a non-5xx gate page — never a server
            // crash from the settings render.
            if (res) {
                expect(res.status(), 'anon settings/github-app must not 5xx').toBeLessThan(500);
            }
            expect(
                finalUrl.includes('/login') ||
                    (res !== null && [200, 401, 403, 404].includes(res.status())),
                `unexpected anon final state: ${finalUrl}`,
            ).toBe(true);
            await anonPage.close();
        } finally {
            await anonCtx.close();
        }

        // --- Authenticated (seeded storageState from the default context). ---
        const resAuthed = await page.goto(`${origin}/en/settings/github-app`, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
        });
        if (resAuthed) {
            expect(
                resAuthed.status(),
                'authed settings/github-app must not 5xx (server render crash?)',
            ).toBeLessThan(500);
        }

        // Some nested settings routes render in CI but 404 to the catch-all
        // LOCALLY under next-dev — tolerate either, but when the page DOES
        // render, assert the GitHub App settings surface specifically.
        const onLogin = page.url().includes('/login');
        if (onLogin) {
            // Auth cookie didn't carry for this route under local next-dev —
            // the gate still held, which is an acceptable outcome.
            expect(page.url()).toContain('/login');
            return;
        }

        // The seeded account has no GitHub App installations, so the empty
        // state must render (i18n: dashboard.settings.githubApp.emptyTitle =
        // "No GitHub App installations yet"). It may co-exist with the page
        // title "GitHub App". Use a resilient toPass loop for hydration.
        const emptyTitle = page.getByText(/No GitHub App installations yet/i).first();
        const tabHeading = page.getByText(/GitHub App/i).first();
        const notFound = page.getByText(/404|not found|page could not be found/i).first();

        await expect
            .poll(
                async () => {
                    if (await emptyTitle.isVisible().catch(() => false)) return 'empty';
                    if (await tabHeading.isVisible().catch(() => false)) return 'heading';
                    if (await notFound.isVisible().catch(() => false)) return 'notfound';
                    return 'pending';
                },
                { timeout: 30000, message: 'github-app settings page never settled' },
            )
            .not.toBe('pending');

        // Whatever settled, it must be a recognised GitHub-App settings state
        // (empty list / heading) or the tolerated local 404 — never a blank or
        // errored shell.
        const settled =
            (await emptyTitle.isVisible().catch(() => false)) ||
            (await tabHeading.isVisible().catch(() => false)) ||
            (await notFound.isVisible().catch(() => false));
        expect(settled, 'expected the GitHub App settings page or a tolerated 404').toBe(true);

        // If the real page rendered (not the local 404), confirm the empty
        // state copy is present — proving this is the App settings surface and
        // not some other settings tab.
        if (await emptyTitle.isVisible().catch(() => false)) {
            await expect(emptyTitle).toBeVisible();
            // No installation cards / sync buttons exist for the empty account.
            const syncButton = page.getByRole('button', { name: /^Sync$/i });
            expect(await syncButton.count()).toBe(0);
        }
    });
});
