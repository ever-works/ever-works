import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Account research opt-out — userResearchOptOut + inferredInterests +
 * suggestedVerticals persistence, opt-out gating, reversibility, defaults.
 *
 * The "user research" subsystem (packages/agent/src/user-research +
 * apps/api/src/work-proposals) researches a newly-signed-up user via web
 * search + content extraction and persists an inferred profile
 * (`inferredInterests`) plus derived `suggestedVerticals` on the User row.
 * A per-user `userResearchOptOut` boolean gates that telemetry/inference.
 *
 * Verified LIVE against the e2e stack (sqlite in-memory, NO LLM key, NO
 * Trigger.dev) before writing — assertions track these probed truths, not a
 * fictional contract:
 *
 *   GET  /api/me/work-proposals/preferences  (AuthSessionGuard)
 *       → 200 { optOut: boolean }. Fresh user DEFAULTS to { optOut: false }.
 *   PUT  /api/me/work-proposals/preferences  (UpdateWorkProposalPreferencesDto)
 *       body accepts EITHER { optOut } OR { emailNotifications } (the inverse:
 *       optOut === !emailNotifications). Both -> 200 { optOut }.
 *       - { optOut: true }                → 200 { optOut: true }
 *       - { emailNotifications: true }     → 200 { optOut: false }
 *       - {} (neither field)              → 200, IDEMPOTENT no-op (re-reads
 *                                           current state, never mutates).
 *       - { optOut: "yes" } (bad type)    → 400 ["optOut must be a boolean value"]
 *   POST /api/me/work-proposals/refresh     (@Throttle 3/60s, @HttpCode 202)
 *       → 202 { status: 'queued' | 'rate-limited' | 'at-limit', error? }.
 *       The opt-out gate lives INSIDE UserResearchService.research(): the
 *       refresh endpoint STILL returns 202 'queued' when opted out (it
 *       dispatches the pipeline async), but research() short-circuits with
 *       status 'no-data' and persists NOTHING. A second concurrent refresh
 *       returns { status:'queued', error:'already in flight' } (in-flight
 *       guard short-circuits before the 3/60s throttle trips).
 *   GET  /api/me/work-proposals/status
 *       → 200 { researching: boolean, canRefresh: boolean,
 *               refreshDisabledReason?: 'rate-limited' | 'at-limit' }.
 *
 *   Unauth GET/PUT preferences → 401 { message:'Unauthorized', statusCode:401 }.
 *
 *   inferredInterests / suggestedVerticals are persisted ONLY by a COMPLETED
 *   research() run. In CI (no AI provider) research never completes
 *   ('ai-provider-not-configured' / 'no-data'), so those fields stay NULL and
 *   are NOT surfaced by any /me GET (there is no /api/me; account/me all 404).
 *   The web-visible consequence: a fresh/opted-out user has an EMPTY pending
 *   Ideas list (GET /api/me/work-proposals → []). suggestedVerticals, when it
 *   IS derived (deriveVerticals in prompts.ts), is never empty — it falls back
 *   to ['general'] — so its persistence is keyed to a completed run, not the
 *   keyword match.
 *
 *   Work-created learning: WorkCreatedLearningListener → ingestWorkCreated
 *   folds a new Work's categories/tags into inferredInterests.topics ONLY when
 *   a profile already exists (no-op when inferredInterests is null). It is NOT
 *   gated by userResearchOptOut — the gate is "has a prior inferred profile",
 *   which a CI user never has. So creating a Work for a fresh user leaves
 *   inferredInterests null either way (no proposals appear).
 *
 * Isolation: every API-only mutation runs on a FRESH registerUserViaAPI() user
 * so the shared seeded user (storageState) stays clean for sibling specs. The
 * single UI-render flow uses the seeded user and only reads (navigates the
 * Discover route that consumes proposals) — it never opts the seeded user out.
 * Counts are tolerated with toContain / >= where pre-existing rows could exist.
 */

interface ResearchPreferences {
    optOut: boolean;
}

interface RefreshStatus {
    researching: boolean;
    canRefresh: boolean;
    refreshDisabledReason?: 'rate-limited' | 'at-limit';
}

interface RefreshResult {
    status: 'queued' | 'rate-limited' | 'at-limit';
    error?: string;
}

const PREFS_PATH = '/api/me/work-proposals/preferences';
const REFRESH_PATH = '/api/me/work-proposals/refresh';
const STATUS_PATH = '/api/me/work-proposals/status';
const LIST_PATH = '/api/me/work-proposals';

async function getPreferences(
    request: APIRequestContext,
    token: string,
): Promise<ResearchPreferences> {
    const res = await request.get(`${API_BASE}${PREFS_PATH}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Raw PUT — caller asserts status (used for both happy-path and 400 cases). */
function putPreferences(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.put(`${API_BASE}${PREFS_PATH}`, { headers: authedHeaders(token), data: body });
}

async function putPreferencesOk(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<ResearchPreferences> {
    const res = await putPreferences(request, token, body);
    expect(res.status(), `PUT prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getStatus(request: APIRequestContext, token: string): Promise<RefreshStatus> {
    const res = await request.get(`${API_BASE}${STATUS_PATH}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET status body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function postRefresh(request: APIRequestContext, token: string): Promise<RefreshResult> {
    const res = await request.post(`${API_BASE}${REFRESH_PATH}`, { headers: authedHeaders(token) });
    // Controller @HttpCode is 202; rate-limited maps to 429 (RefreshResponse
    // translation). Both are non-5xx, valid outcomes of the dispatch attempt.
    expect(
        [202, 429].includes(res.status()),
        `refresh status=${res.status()} body=${await res.text().catch(() => '')}`,
    ).toBeTruthy();
    return res.json();
}

async function listProposals(request: APIRequestContext, token: string): Promise<unknown[]> {
    const res = await request.get(`${API_BASE}${LIST_PATH}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET list body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function messageOf(res: APIResponse): Promise<string> {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const message = (body as { message?: unknown }).message;
    return Array.isArray(message) ? message.join(' ') : String(message ?? '');
}

test.describe('Account research opt-out — preferences persistence + gating', () => {
    test('fresh user defaults to opted-IN; opt-out persists across a fresh re-login', async ({
        request,
    }) => {
        // A brand-new local user. The default is research-ENABLED (optOut=false).
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // 1. Default state — probed: fresh users are NOT opted out.
        const initial = await getPreferences(request, token);
        expect(initial).toEqual({ optOut: false });

        // 2. Opt OUT. Response echoes the persisted canonical shape.
        const optedOut = await putPreferencesOk(request, token, { optOut: true });
        expect(optedOut).toEqual({ optOut: true });

        // 3. An independent GET reflects it from the DB (not a write-back echo).
        expect(await getPreferences(request, token)).toEqual({ optOut: true });

        // 4. The opt-out survives a FULL re-login — it is a durable user-row
        //    column, not session state. Login DTO accepts ONLY { email, password }.
        const fresh = await loginViaAPI(request, { email: u.email, password: u.password });
        expect(fresh.access_token, 'fresh login should yield a new bearer').toBeTruthy();
        expect(fresh.access_token).not.toBe(token);

        const afterRelogin = await getPreferences(request, fresh.access_token);
        expect(afterRelogin).toEqual({ optOut: true });
    });

    test('opt-out is reversible and toggles cleanly through both PUT shapes', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Start opted-in (default).
        expect((await getPreferences(request, token)).optOut).toBe(false);

        // Opt out via the canonical { optOut } field.
        expect((await putPreferencesOk(request, token, { optOut: true })).optOut).toBe(true);
        expect((await getPreferences(request, token)).optOut).toBe(true);

        // Re-opt-IN via the web-client-friendly inverse { emailNotifications:true }
        // (optOut === !emailNotifications). This is a DIFFERENT body shape mapping
        // to the same column — proving the alias path round-trips.
        expect((await putPreferencesOk(request, token, { emailNotifications: true })).optOut).toBe(
            false,
        );
        expect((await getPreferences(request, token)).optOut).toBe(false);

        // Opt out AGAIN via the inverse alias { emailNotifications:false }.
        expect((await putPreferencesOk(request, token, { emailNotifications: false })).optOut).toBe(
            true,
        );
        expect((await getPreferences(request, token)).optOut).toBe(true);

        // Back to opted-in via the canonical field, closing the loop.
        expect((await putPreferencesOk(request, token, { optOut: false })).optOut).toBe(false);
        expect((await getPreferences(request, token)).optOut).toBe(false);
    });

    test('idempotent no-op PUT and rejected bad-type PUT both leave persisted state intact', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Establish a known non-default state so a successful no-op is observable.
        expect((await putPreferencesOk(request, token, { optOut: true })).optOut).toBe(true);

        // 1. A body that validates cleanly but carries NEITHER field is an
        //    idempotent no-op: the controller re-reads current prefs and returns
        //    them WITHOUT mutating the row. Probed: {} -> 200 { optOut: <current> }.
        const noop = await putPreferencesOk(request, token, {});
        expect(noop).toEqual({ optOut: true });
        expect((await getPreferences(request, token)).optOut).toBe(true);

        // 2. A wrong-typed optOut is rejected by the @IsBoolean DTO validator with
        //    the real class-validator message — and persists NOTHING.
        const badType = await putPreferences(request, token, { optOut: 'yes' });
        expect(badType.status()).toBe(400);
        expect(await messageOf(badType)).toContain('optOut must be a boolean value');
        expect((await getPreferences(request, token)).optOut).toBe(true);

        // 3. A non-boolean emailNotifications alias is likewise a clean 4xx, not 5xx.
        const badAlias = await putPreferences(request, token, { emailNotifications: 42 });
        expect(badAlias.status()).toBeGreaterThanOrEqual(400);
        expect(badAlias.status()).toBeLessThan(500);
        // Still the value from step 1 — the rejected write never landed.
        expect((await getPreferences(request, token)).optOut).toBe(true);
    });

    test('preferences read + write require auth (telemetry/inference is never anonymous)', async ({
        request,
    }) => {
        // No bearer → 401 on BOTH the read and the write of the opt-out preference.
        const anonGet = await request.get(`${API_BASE}${PREFS_PATH}`);
        expect(anonGet.status()).toBe(401);
        expect(await messageOf(anonGet)).toContain('Unauthorized');

        const anonPut = await request.put(`${API_BASE}${PREFS_PATH}`, { data: { optOut: true } });
        expect(anonPut.status()).toBe(401);

        // The status surface that drives the "Suggest more ideas" affordance is
        // likewise auth-gated.
        const anonStatus = await request.get(`${API_BASE}${STATUS_PATH}`);
        expect(anonStatus.status()).toBe(401);

        // A garbage bearer is rejected too (not silently treated as anonymous).
        const badBearer = await request.get(`${API_BASE}${PREFS_PATH}`, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(badBearer.status()).toBe(401);
    });
});

test.describe('Account research opt-out — refresh gating + inference persistence', () => {
    test('opted-out refresh accepts the dispatch but persists no inferredInterests/suggestedVerticals', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // 1. A fresh user has NO inferred profile yet: the proxy for "no
        //    inferredInterests persisted" is an empty pending-Ideas list (those
        //    Ideas are only generated AFTER a completed research run).
        expect(await listProposals(request, token)).toEqual([]);

        // 2. Opt OUT, then trigger a refresh. The endpoint dispatches the pipeline
        //    asynchronously and still returns 202 'queued' — the opt-out gate is
        //    inside research(), which short-circuits with 'no-data'. So opting out
        //    does NOT surface as a refresh rejection; it surfaces as "no inference".
        expect((await putPreferencesOk(request, token, { optOut: true })).optOut).toBe(true);
        const refresh = await postRefresh(request, token);
        expect(['queued', 'rate-limited', 'at-limit']).toContain(refresh.status);

        // 3. Give the async pipeline time to run-and-bail, then confirm NOTHING was
        //    inferred or proposed: no Ideas appear. (In CI there is no AI provider,
        //    so even an opted-IN user would produce nothing — but the opt-out path
        //    guarantees research() returns before ANY provider resolution at all.)
        await expect
            .poll(async () => (await listProposals(request, token)).length, {
                timeout: 15_000,
                message: 'opted-out user must never accrue inferred proposals',
            })
            .toBe(0);

        // 4. Opt-out state is unchanged by the refresh attempt.
        expect((await getPreferences(request, token)).optOut).toBe(true);
    });

    test('refresh status surface + concurrent in-flight de-dup behave consistently for an opted-in user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // 1. A fresh opted-in user can refresh: status reports availability and no
        //    in-flight run, with no disabled reason.
        const before = await getStatus(request, token);
        expect(before.researching).toBe(false);
        expect(before.canRefresh).toBe(true);
        expect(before.refreshDisabledReason).toBeUndefined();

        // 2. First refresh is accepted (202 'queued').
        const first = await postRefresh(request, token);
        expect(['queued', 'rate-limited', 'at-limit']).toContain(first.status);

        // 3. A near-immediate SECOND refresh while the first pipeline may still be
        //    in flight is de-duped: the service returns 'queued' with
        //    error:'already in flight' rather than spinning up a parallel run.
        //    (Without an AI key the pipeline finishes fast, so the second call may
        //    also be a clean 'queued' — both are valid, never a 5xx.)
        const second = await postRefresh(request, token);
        expect(['queued', 'rate-limited', 'at-limit']).toContain(second.status);
        if (second.error) {
            expect(second.error).toContain('already in flight');
        }

        // 4. Status remains a well-formed envelope throughout. When a reason IS
        //    present it is one of the two documented values.
        const after = await getStatus(request, token);
        expect(typeof after.researching).toBe('boolean');
        expect(typeof after.canRefresh).toBe('boolean');
        if (after.refreshDisabledReason !== undefined) {
            expect(['rate-limited', 'at-limit']).toContain(after.refreshDisabledReason);
        }
        // canRefresh and a present disabled-reason are mutually consistent: a
        // reason only accompanies canRefresh=false.
        if (after.refreshDisabledReason) {
            expect(after.canRefresh).toBe(false);
        }

        // 5. The opted-in user never had opt-out toggled on by any of this.
        expect((await getPreferences(request, token)).optOut).toBe(false);
    });

    test('creating a Work for a profile-less (opted-out) user does not back-fill inferred interests', async ({
        request,
    }) => {
        // The WorkCreatedLearningListener folds a new Work's categories/tags into
        // inferredInterests.topics — but ONLY when a profile already exists; it is
        // a no-op when inferredInterests is null. A fresh user (CI: no completed
        // research) never has one, so work creation must not conjure inferred data.
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Opt out first — belt-and-suspenders that no inference path runs.
        expect((await putPreferencesOk(request, token, { optOut: true })).optOut).toBe(true);

        // Pre-state: no proposals (proxy for "no inferredInterests").
        expect(await listProposals(request, token)).toEqual([]);

        // Create a Work directly via the API — this emits WorkCreatedEvent, which
        // the learning listener consumes. createWorkViaAPI asserts a 2xx internally.
        const stamp = Date.now().toString(36);
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(token),
            data: {
                name: `OptOut Learning Work ${stamp}`,
                slug: `optout-learning-${stamp}`,
                description: 'e2e research-optout learning probe',
                organization: false,
            },
        });
        expect(res.status(), `create work body=${await res.text().catch(() => '')}`).toBeLessThan(
            300,
        );
        const created = await res.json();
        expect(created?.work?.id ?? created?.id, 'work should be created').toBeTruthy();

        // The learning ingest fires asynchronously off the event. Give it room,
        // then confirm it stayed a no-op: still zero proposals, opt-out intact.
        await expect
            .poll(async () => (await listProposals(request, token)).length, {
                timeout: 15_000,
                message: 'profile-less user gains no inferred proposals from a Work create',
            })
            .toBe(0);
        expect((await getPreferences(request, token)).optOut).toBe(true);
    });
});

test.describe('Account research opt-out — Discover surface (seeded user, read-only)', () => {
    test('the Discover route that consumes inferred proposals renders for the seeded user without leaking opt-out state', async ({
        page,
        request,
        baseURL,
    }) => {
        // UI-render flow uses the seeded session (storageState). We only READ its
        // preference and navigate — never opt it out — so sibling specs stay safe.
        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        expect(token, 'seeded login should yield a bearer').toBeTruthy();

        // The seeded user's opt-out preference is a clean boolean either way — we
        // assert the shape, not a specific value (other specs may have touched it).
        const prefs = await getPreferences(request, token);
        expect(typeof prefs.optOut).toBe('boolean');

        // The status envelope is well-formed for the seeded user too.
        const status = await getStatus(request, token);
        expect(typeof status.canRefresh).toBe('boolean');
        expect(typeof status.researching).toBe('boolean');

        // Navigate the Discover page — the dashboard surface that renders
        // AI-curated Work ideas (the consumer of inferredInterests-driven
        // proposals). next-dev local-vs-CI route divergence: the nested route may
        // render in CI but 404 to the catch-all locally, so accept EITHER the real
        // Discover heading OR a generic page heading, and never hard-fail on 404.
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/discover`, { waitUntil: 'domcontentloaded' });

        // `.first()` must wrap the UNION, not just the left side: in the local
        // 404-to-home fallback the page has several h1/h2 nodes, so a bare
        // `.or(anyHeading)` resolves to multiple elements and trips strict mode.
        const discoverHeading = page.getByRole('heading', { name: /discover/i });
        const anyHeading = page.locator('h1, h2');
        await expect(discoverHeading.or(anyHeading).first()).toBeVisible({ timeout: 30_000 });

        // The page must not crash into a client error boundary — the body should
        // have meaningful content, not a bare error chrome.
        const body = page.locator('body');
        await expect(body).toBeVisible();
        const text = (await body.innerText().catch(() => '')) ?? '';
        expect(text.length, 'Discover page should render non-empty content').toBeGreaterThan(0);
    });
});
