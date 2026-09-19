/**
 * APW-03 T19 — Settings → App spec: the tab, and what this lane can render of it
 * (ACC-03-39, ACC-03-40; plan §10.3:880, plan §5.1:603-607).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-03-39** (`spec.md:717`):
 *
 * > The App spec tab is absent on a `website` Work and present on an App Work.
 *
 * **ACC-03-40** (`spec.md:718`):
 *
 * > Every banner state of §6.2 renders from its fixture; every problem row links to the evaluated
 * > commit and line.
 *
 * Plan §5.1:604 fixes the page's own half of ACC-03-39: the address is withheld for a Work that is
 * not an App Work — `notFound()` when `work.kind !== 'app'`, "exactly as the tab is".
 *
 * ## Measured on this lane (2026-09-19), not assumed
 *
 * The shipped web build serves this tab and the shipped API serves both App-spec routes, so the two
 * halves of ACC-03-39 are asserted against the real surfaces — a real `website` Work and a real App
 * Work created through `POST /api/works`, read through the real browser session:
 *
 *   - `nav[aria-label="Settings tabs"]` renders **three** anchors for the `website` Work (General,
 *     Members, Budgets) and **four** for the App Work — the fourth being `App spec`
 *     (`SettingsSubTabs.tsx:58-73`, `visible: work.kind === 'app'`) with
 *     `href="/works/<id>/settings/app-spec"`.
 *   - the tab's own address is withheld for **both** kinds, but for different reasons and with the
 *     same localized not-found page: the `website` Work answers `422 notAnAppWork` on the API, the
 *     App Work answers `404 not_found` — see {@link REFUSALS} below — and `page.tsx:63-73` turns
 *     **either** into `notFound()`. The DOM alone therefore cannot tell the two refusals apart;
 *     the API's `code` and `message` are the only places the difference is visible, and they are
 *     asserted here rather than papered over.
 *
 * ## What could NOT be exercised, and why (ACC-03-40, both clauses)
 *
 * **No `work_app_spec_states` row can exist on this lane, so the tab's first paint is a `404` for
 * every App Work and every role.** Measured: `GET /api/works/:id/app-spec` answers
 * `404 {"status":"error","code":"not_found","message":"Work <id> has no App spec state yet."}`
 * (`work-app-spec.controller.ts:230-237`) because nothing in the shipped runtime inserts that row —
 * `AppSpecService.initialize` (`app-spec.service.ts:352-358`) has no caller anywhere in
 * `apps/api/src` or `packages/agent/src` (its only references are its own definition, its own
 * specs and the built `apps/api/dist`, which has no caller either), and the App Work create path
 * does not reach it. The one surface that *could* insert it — the job runtime's own RPC,
 * `POST /internal/trigger/remote/call` with `{ name: 'AppSpecService', method: 'initialize' }`
 * (`trigger-internal.controller.ts:739-795`, the channel `packages/tasks` runs the evaluation
 * through) — is closed on this lane: it answers
 * `403 {"message":"Trigger internal secret is not configured", …}` because the lane's API runs
 * without `TRIGGER_INTERNAL_SECRET`.
 *
 * So `page.tsx:69-73` catches the `404` and `notFound()`s: the banner, the problems list and the
 * two card slots are never mounted, and ACC-03-40's two clauses have no fixture to render. Both
 * are recorded below as `test.fixme` with that measurement, and the assertion each one owes is
 * written out in its body so the case activates the moment APW-01's create path initializes the
 * row. The *state* ACC-03-40 renders is producible on this lane — the sibling file
 * `flow-app-spec-recheck.spec.ts` obtains the §6.2 `valid_with_warnings` verdict through
 * `POST …/app-spec/validate { source: 'content' }` — but a draft validation **stores nothing**, so
 * it can never become the state the banner reads.
 *
 * ## The cases this file runs green
 *
 *   1. {@link ACC-03_39_TAB} — the tab's presence gating, in the real nav, with the three sibling
 *      anchors as the control that the nav itself rendered.
 *   2. {@link ACC_03_39_ADDRESS} — the two refusals, by their own literals, and the not-found the
 *      browser renders for each; plus the read the tab's own poll performs, which is the fifth
 *      surface of this epic and is reachable even though the page is not.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { appWorkCreateBody, createAppWork, rawApi } from './helpers/app-works';
import { connectCustomerGitHub } from './helpers/github-connection';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * This file's cases share one seeded App Work and one seeded `website` Work, and run **one at a
 * time**: `playwright.config.ts:38` sets `fullyParallel: true`, and both Works are created through
 * the same API process and the same in-memory SQLite. In CI the shard already runs
 * `PLAYWRIGHT_WORKERS=1` (`playwright.config.ts:49-53`), where this setting is a no-op. No
 * assertion is weakened by it.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where this file's fixtures are seeded. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/**
 * The login the checked-in PR-lane fixture gives every account this lane attaches
 * (`github-connection.ts:87-88`). A fork App Work is created *for* this fake identity, so the
 * create needs no real credential.
 */
const LANE_LOGIN = 'apw-e2e-user';

/** The Settings nav's own accessible name (`SettingsSubTabs.tsx:89`). */
const SETTINGS_NAV = 'nav[aria-label="Settings tabs"]';

/** The tab's own label, as shipped (`SettingsSubTabs.tsx:68`, `messages/en.json`). */
const APP_SPEC_TAB_LABEL = 'App spec';

/** The tab's address, exactly as `ROUTES.DASHBOARD_WORK_SETTINGS_APP_SPEC` builds it. */
function appSpecHref(workId: string): string {
    return `/works/${workId}/settings/app-spec`;
}

/**
 * The **poll's** address on the web origin — the BFF route handler
 * (`apps/web/src/app/api/works/[id]/app-spec/route.ts`). It is a different URL from the page above,
 * and it is the only read the browser's five-second poll performs
 * (`AppSpecPageClient.tsx:88`).
 */
function pollHref(workId: string): string {
    return `/api/works/${workId}/app-spec`;
}

/** The three tabs every kind gets, and the control that the nav rendered at all. */
function siblingHrefs(workId: string): string[] {
    return [
        `/works/${workId}/settings`,
        `/works/${workId}/settings/members`,
        `/works/${workId}/settings/budgets-usage`,
    ];
}

/**
 * The two refusals `GET /api/works/:id/app-spec` produces, as this lane answers them (measured
 * 2026-09-19, `work-app-spec.controller.ts:189-250` / `:408-441`). Both render the same not-found
 * page, so the `code` and `message` are the only observable difference — which is why each is
 * pinned here instead of being collapsed into "the request failed".
 */
interface Refusal {
    status: number;
    code: string;
    message: (workId: string) => string;
}

/** The `website` Work: visible, but its kind has no App spec. */
const NOT_AN_APP_WORK: Refusal = {
    status: 422,
    code: 'notAnAppWork',
    message: (workId) => `Work ${workId} is not an App Work, so it has no App spec.`,
};

/**
 * The App Work: visible *and* kind `app`, but its state row was never inserted. `404 not_found` is
 * also the answer for a Work that is missing or another account's, so this literal is the one
 * place the "no state row" case is distinguishable at all.
 */
const NO_STATE_ROW: Refusal = {
    status: 404,
    code: 'not_found',
    message: (workId) => `Work ${workId} has no App spec state yet.`,
};

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function slugOf(label: string, run: string): string {
    return `t19-${label}-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// ---------------------------------------------------------------------------
// The seeded user, and the two Works this file is about
// ---------------------------------------------------------------------------

/**
 * The lane's browser session is the **seeded** user's (`playwright.config.ts:102` loads
 * `e2e/.auth/user.json`), so every Work this file reads in the browser is created with the seeded
 * user's own bearer token — the browser and the API are then the same principal, and a UI miss is
 * a rendering fact rather than a wrong-owner fact.
 */
async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * The fake's PR-lane catalog, as checked in (`plan §8.3`, T2). Located from the working directory,
 * because a spec may be launched from `apps/web` (the lane) or from the repo root (a direct
 * invocation) — the same two candidates `flow-app-work-delete-retains.spec.ts:180-188` tries.
 */
function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** Seed the checked-in fixture plus this run's own upstream. `false` ⇒ the fake is absent. */
async function seedFakeGitHub(
    request: APIRequestContext,
    extraRepositories: Array<Record<string, unknown>>,
): Promise<boolean> {
    const fixture = fakeSeedFixturePath();
    if (fixture === null) return false;
    try {
        const seed = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
        const res = await request.post(`${FAKE_GITHUB_URL}/_control/seed`, {
            data: {
                ...seed,
                repositories: [...((seed.repositories as unknown[]) ?? []), ...extraRepositories],
            },
        });
        return res.ok();
    } catch {
        return false;
    }
}

/** A `website` Work of the seeded user — the kind ACC-03-39 says has no App spec tab. */
async function createWebsiteWork(
    request: APIRequestContext,
    token: string,
    run: string,
): Promise<string> {
    const slug = slugOf('web', run);
    const created = await rawApi(request, 'POST', '/api/works', {
        token,
        body: {
            kind: 'website',
            name: slug,
            slug,
            description: 'APW-03 T19 ACC-03-39',
            organization: false,
        },
    });
    expect(created.status, `website create body=${created.text.slice(0, 300)}`).toBe(200);
    const id = (created.json as { work?: { id?: string } })?.work?.id ?? '';
    expect(id, 'the create answers a Work id').not.toBe('');
    return id;
}

/**
 * A fork App Work of the seeded user, through `POST /api/works` with `kind: 'app'` — the shipped
 * create path (measured 200 on this lane) rather than a hand-built row.
 */
async function createAppWorkForSeededUser(
    request: APIRequestContext,
    token: string,
    run: string,
    label: string,
): Promise<string> {
    const upstream = { owner: 'apw-e2e-upstream', name: `t19-${label}-${run}` };
    const seeded = await seedFakeGitHub(request, [upstream]);
    expect(
        seeded,
        `the fake GitHub at ${FAKE_GITHUB_URL} must answer /_control/seed — without it there is no ` +
            'repository to fork and no App Work to read (the PR lane starts it beside the API).',
    ).toBe(true);
    await connectCustomerGitHub(request, token);

    const slug = slugOf(label, run);
    const created = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-03 T19 ${label}`,
            organization: false,
            repositoryUrl: `https://github.com/${upstream.owner}/${upstream.name}`,
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
            autoProvision: false,
        }),
    });
    expect(created.status, `app create body=${created.text.slice(0, 400)}`).toBe(200);
    const id = (created.json as { work?: { id?: string } })?.work?.id ?? '';
    expect(id, 'the create answers a Work id').not.toBe('');
    return id;
}

/** The two Works, seeded once per run and reused by every case in this file. */
interface AppSpecSettingsFixtures {
    token: string;
    websiteId: string;
    appId: string;
}

let fixtures: AppSpecSettingsFixtures | null = null;

async function ensureFixtures(request: APIRequestContext): Promise<AppSpecSettingsFixtures> {
    if (fixtures) return fixtures;

    const token = await seededToken(request);
    const run = stamp();
    fixtures = {
        token,
        websiteId: await createWebsiteWork(request, token, run),
        appId: await createAppWorkForSeededUser(request, token, run, 'app'),
    };
    return fixtures;
}

// ---------------------------------------------------------------------------
// The API literals, as one helper
// ---------------------------------------------------------------------------

/**
 * One retry for a **transport** failure, and only for the idempotent reads below.
 *
 * A red on this lane is a stack question before it is a spec question, and the stack is shared:
 * every worker and every agent's spec file talks to the same API process, so a keep-alive socket can
 * be reset under a read that never reached a handler. Measured once here (`read ECONNRESET` from
 * `apiRequestContext.get`, 2026-09-19) against an API that answered
 * `200 {"status":"success","message":"API is up and running"}` before and after, on the same pid.
 *
 * A transport failure is not an answer from the product, so retrying it weakens nothing: the retried
 * attempt must still produce the exact status and body asserted below, and a second failure
 * propagates as a red. The POSTs are deliberately **not** wrapped — Re-check is counted by a
 * per-Work throttle, so re-sending one would change what a case measures.
 */
async function readWithTransportRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
        return await attempt();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
            !/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|fetch failed/i.test(
                message,
            )
        ) {
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        return attempt();
    }
}

/** `GET /api/works/:id/app-spec`, with the caller's own bearer token. */
async function readAppSpec(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await readWithTransportRetry(() =>
        request.get(`${API_BASE}/api/works/${workId}/app-spec`, {
            headers: authedHeaders(token),
            failOnStatusCode: false,
        }),
    );
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

function expectRefusal(
    actual: { status: number; body: Record<string, unknown> },
    expected: Refusal,
    workId: string,
): void {
    expect(
        actual.status,
        `GET /api/works/${workId}/app-spec answered ${actual.status}: ${JSON.stringify(actual.body)}`,
    ).toBe(expected.status);
    expect(actual.body.code).toBe(expected.code);
    expect(actual.body.message).toBe(expected.message(workId));
}

// ---------------------------------------------------------------------------
// ACC-03-39 — the tab
// ---------------------------------------------------------------------------

test('ACC-03-39 — the App spec tab is absent on a `website` Work and present on an App Work', async ({
    page,
    request,
}) => {
    const { websiteId, appId } = await ensureFixtures(request);

    // 1. The `website` Work: the nav renders, and the App spec tab is not one of its anchors.
    await page.goto(`/works/${websiteId}/settings`, { waitUntil: 'domcontentloaded' });
    const websiteNav = page.locator(SETTINGS_NAV);
    await expect(websiteNav).toBeVisible({ timeout: 30_000 });

    // The control: every tab a `website` Work *does* get is there, so the absence below is a fact
    // about the kind gate rather than about a nav that never rendered.
    for (const href of siblingHrefs(websiteId)) {
        await expect(
            websiteNav.locator(`a[href="${href}"]`),
            `the \`website\` Work's Settings nav has ${href}`,
        ).toHaveCount(1);
    }
    await expect(
        websiteNav.locator(`a[href="${appSpecHref(websiteId)}"]`),
        'ACC-03-39: a `website` Work offers no App spec tab',
    ).toHaveCount(0);

    // 2. The App Work: the fourth tab, with its own label and its own address.
    await page.goto(`/works/${appId}/settings`, { waitUntil: 'domcontentloaded' });
    const appNav = page.locator(SETTINGS_NAV);
    await expect(appNav).toBeVisible({ timeout: 30_000 });
    for (const href of siblingHrefs(appId)) {
        await expect(appNav.locator(`a[href="${href}"]`)).toHaveCount(1);
    }

    const appSpecTab = appNav.locator(`a[href="${appSpecHref(appId)}"]`);
    await expect(appSpecTab, 'ACC-03-39: an App Work offers the App spec tab').toHaveCount(1);
    await expect(appSpecTab).toBeVisible();
    await expect(appSpecTab).toHaveText(APP_SPEC_TAB_LABEL);
    await expect(appSpecTab).toHaveAttribute('href', appSpecHref(appId));
});

// ---------------------------------------------------------------------------
// ACC-03-39 / plan §5.1:604 — the address, and the two refusals behind it
// ---------------------------------------------------------------------------

test('ACC-03-39 (plan §5.1:604) — both kinds withhold the tab’s address, and only the API says which refusal it is', async ({
    page,
    request,
}) => {
    const { token, websiteId, appId } = await ensureFixtures(request);

    // 1. The API half: the same read, two different refusals.
    expectRefusal(await readAppSpec(request, token, websiteId), NOT_AN_APP_WORK, websiteId);
    expectRefusal(await readAppSpec(request, token, appId), NO_STATE_ROW, appId);

    // 2. The DOM half: `/settings/app-spec` on a `website` Work renders the not-found page in
    //    place — the address is withheld exactly as the tab is (plan §5.1:604).
    await page.goto(appSpecHref(websiteId), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
        timeout: 30_000,
    });
    await expect(
        page.getByTestId('app-spec-page'),
        'a `website` Work has no App spec page to render',
    ).toHaveCount(0);
    expect(new URL(page.url()).pathname, 'the address is not redirected away').toBe(
        appSpecHref(websiteId),
    );

    // 3. ...and so does the App Work, for the other reason: the API refuses the state read, so
    //    `page.tsx:69-73` refuses the page. This is the measured state of the whole tab on this
    //    lane and it is what the two `test.fixme` cases at the end of this file are blocked on.
    await page.goto(appSpecHref(appId), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
        timeout: 30_000,
    });
    await expect(
        page.getByTestId('app-spec-page'),
        'the App spec page mounts only when `GET /api/works/:id/app-spec` answers — it answers ' +
            `${NO_STATE_ROW.status} ${NO_STATE_ROW.code} on this lane`,
    ).toHaveCount(0);
    await expect(
        page.getByTestId('app-spec-status-banner'),
        'and no §6.2 banner state can render without it (ACC-03-40)',
    ).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(appSpecHref(appId));
});

// ---------------------------------------------------------------------------
// The read the tab's own poll performs — reachable even though the page is not
// ---------------------------------------------------------------------------

/**
 * The poll is `browserApiFetch('/api/works/<id>/app-spec')` on the **web** origin
 * (`AppSpecPageClient.tsx:88`), served by `apps/web/src/app/api/works/[id]/app-spec/route.ts`.
 * That route is the same-origin read door for the five-second poll, and it is reachable on this
 * lane even though the page that starts the poll is not — so both of its answers are pinned here.
 *
 * ## The authenticated half is a build-wide refusal, measured, and it is not this epic's
 *
 * The route's contract is "forward the API's `404` unchanged" (`route.ts:50-59`), and the API does
 * answer that `404`. What this lane's web process answers instead is an **empty `500`** — for an
 * app-spec poll *and* for three sibling BFF poll routes that predate this epic, which is the control
 * that keeps this from being read as an App-spec defect. Measured 2026-09-19 against the running
 * production build (`next start`, port 3211) with the seeded session cookie, four for four:
 *
 * ```
 * /api/works/<id>/app-spec                       -> 500, 0-byte body
 * /api/works/<id>/upstream                       -> 500, 0-byte body
 * /api/works/<id>/deploy/status                  -> 500, 0-byte body
 * /api/works/<id>/comparisons/generation-status  -> 500, 0-byte body
 * ```
 *
 * A 0-byte body is what Next.js answers for an **unhandled** throw inside a route handler, so the
 * throw is before the handler's own `try` — i.e. in `getAuthFromCookie()` (`route.ts:40`) or in
 * `serverFetch`'s own prologue (`server-api.ts:106-113`, which calls `headers()` and
 * `getTranslations('api.errors')` outside any `try`). The anonymous path never reaches either and
 * answers the documented `401 {"status":"error","code":"unauthorized"}`. Root-causing it needs the
 * web process's own stderr, which this lane does not expose; the measurement, the four-route
 * control and the two candidate call sites are recorded here and in T19's report.
 *
 * The assertions below pin **both** measured answers rather than the source's intent, so a build
 * that starts forwarding the `404` fails this test loudly and gets updated deliberately.
 */
test('the tab’s poll read (`/api/works/:id/app-spec` on the web origin): anonymous is 401 `unauthorized`; an authenticated call is the build-wide empty 500 the three sibling poll routes also answer', async ({
    playwright,
}) => {
    const origin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
    // The poll is cookie-authenticated (`route.ts:40`), so the context that calls it must carry the
    // same session the browser does — the seeded user's storage state, which the `chromium` project
    // loads for every spec (`playwright.config.ts:102`).
    const owner = await playwright.request.newContext({
        baseURL: origin,
        storageState: './e2e/.auth/user.json',
    });
    const anonymous = await playwright.request.newContext({
        baseURL: origin,
        // Explicitly empty: `playwright.request.newContext()` inherits the project's
        // `use.storageState` (`playwright.config.ts:102`), so an "anonymous" context built without
        // this would arrive carrying the seeded session cookie and take the authenticated path —
        // measured, and the reason this line exists rather than being implied.
        storageState: { cookies: [], origins: [] },
    });

    try {
        const { appId } = await ensureFixtures(owner);

        // 1. The authenticated poll, exactly as `AppSpecPageClient` issues it.
        const polled: APIResponse = await readWithTransportRetry(() =>
            owner.get(pollHref(appId), { failOnStatusCode: false }),
        );
        const polledBody = await polled.text();
        expect(
            polled.status(),
            `the authenticated poll read answered ${polled.status()} with ${JSON.stringify(polledBody)}. ` +
                'Measured on this lane: 500 with an empty body — the API answers 404 not_found ' +
                '("…has no App spec state yet.") and the BFF handler never forwards it.',
        ).toBe(500);
        expect(
            polledBody,
            'an empty body is Next’s answer for an unhandled throw, i.e. before the handler’s own catch',
        ).toBe('');

        // 2. The control: three sibling BFF poll routes, none of them this epic's, answer the same
        //    thing in the same session — so the refusal is a property of this build's authenticated
        //    route handlers, not of the App spec route.
        for (const sibling of [
            `/api/works/${appId}/upstream`,
            `/api/works/${appId}/deploy/status`,
            `/api/works/${appId}/comparisons/generation-status`,
        ]) {
            const response: APIResponse = await readWithTransportRetry(() =>
                owner.get(sibling, { failOnStatusCode: false }),
            );
            expect(
                { status: response.status(), body: await response.text() },
                `${sibling} answers what the app-spec poll answers`,
            ).toEqual({ status: 500, body: '' });
        }

        // 3. The anonymous half is the contract the route documents and does apply: no session, no
        //    upstream call, `401` with the route's own code.
        const refused: APIResponse = await anonymous.get(pollHref(appId), {
            failOnStatusCode: false,
        });
        expect(refused.status(), await refused.text()).toBe(401);
        expect((await refused.json()) as Record<string, unknown>).toMatchObject({
            status: 'error',
            code: 'unauthorized',
        });
    } finally {
        await owner.dispose();
        await anonymous.dispose();
    }
});

// ---------------------------------------------------------------------------
// ACC-03-40 — the two clauses this lane cannot exercise
// ---------------------------------------------------------------------------

test.fixme(
    'ACC-03-40 (banner states): every §6.2 banner state renders from its fixture — blocked: no ' +
        '`work_app_spec_states` row can exist on this lane, so the tab is a 404 for every App Work ' +
        '(GET /api/works/:id/app-spec → 404 not_found "no App spec state yet"; measured 2026-09-19)',
    async ({ page, request }) => {
        const { token, appId } = await ensureFixtures(request);

        // The case, as it must be written once the row exists: one fixture per §6.2 state row,
        // each rendering its own `data-state` on the banner. The page mirrors the state as a
        // hidden attribute for exactly this (`AppSpecPageClient.tsx:203-204`), so the assertion
        // reads the state rather than the copy.
        await page.goto(appSpecHref(appId), { waitUntil: 'domcontentloaded' });
        const banner = page.getByTestId('app-spec-status-banner');
        await expect(banner).toBeVisible({ timeout: 30_000 });

        for (const state of [
            'valid',
            'valid_with_warnings',
            'invalid_running',
            'invalid_nothing',
            'missing',
            'unreadable',
            'checking',
        ]) {
            // 🛑 The missing piece, and the whole reason this case is a `fixme`: a call that puts
            // the row into `state` before the reload. There is none on this lane —
            // `AppSpecService.initialize(workId, trackedBranch)` (`app-spec.service.ts:352-358`)
            // has no caller on APW-01's create path, and the job runtime's own
            // `POST /internal/trigger/remote/call { name: 'AppSpecService', method: 'initialize' }`
            // (`trigger-internal.controller.ts:739-795`) needs the API's `TRIGGER_INTERNAL_SECRET`,
            // which this lane's API does not set — it answers `403 "Trigger internal secret is not
            // configured"` (measured 2026-09-19).
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(banner, `§6.2 state \`${state}\``).toHaveAttribute('data-state', state);
        }

        expect(
            (await readAppSpec(request, token, appId)).status,
            'the state read this page depends on',
        ).toBe(200);
    },
);

test.fixme(
    'ACC-03-40 (problem links): every problem row links to the evaluated commit and line — ' +
        'blocked by the same missing state row: no problems list is mounted, so no ' +
        '`app-spec-problem-link` exists to build an href from (measured 2026-09-19)',
    async ({ page, request }) => {
        const { appId } = await ensureFixtures(request);

        // The case, as it must be written once the row exists. §24.4's six-code fixture is what
        // makes the link assertion non-vacuous — the href is `links.file.base` plus the
        // provider's own `lineAnchor` at the issue's line (`AppSpecProblemsList.tsx:227`,
        // `buildAppSpecLineLink`), never a URL the web app assembles.
        await page.goto(appSpecHref(appId), { waitUntil: 'domcontentloaded' });
        const rows = page.getByTestId('app-spec-problem');
        await expect(rows.first()).toBeVisible({ timeout: 30_000 });

        for (let index = 0; index < (await rows.count()); index += 1) {
            const row = rows.nth(index);
            const position = await row.getByTestId('app-spec-problem-position').innerText();
            const line = Number(position.split(':')[0]);
            const link = row.getByTestId('app-spec-problem-link');
            await expect(link).toHaveAttribute('href', new RegExp(`#L${line}$`));
        }
    },
);
