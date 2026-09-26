/**
 * APW-13 T31 — the fork lifecycle (ACC-E2E-02 PR twin, ACC-NEG-09).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-E2E-02** (`ACCEPTANCE.md:262-297`, the PR twin named on its row:
 * `apps/web/e2e/flow-app-work-fork-lifecycle.spec.ts`):
 *
 * > Given the user cannot push to that upstream, when they create an App Work choosing
 * > **Fork** into `<e2e-fork-org>`, then the create call returns without waiting for
 * > GitHub, the Work shows **Preparing your fork**, and within the deadline shows the fork
 * > as ready with the **Upstream: … · Fork: …** header.
 * >
 * > **Assertions.** `POST /api/works` → `200` with the source readiness `preparing`, within
 * > 10 s; it never waits for fork readiness (APW-01 FR-21, APW-02 FR-12). … The fork was
 * > created with the **user's** connection: … the PR twin additionally asserts, through the
 * > fake's recorded calls, that the fork request carried the user's token. **PR twin: the
 * > fake GitHub delays readiness 20 s; the Work never reports ready early and never pushes
 * > to the fork before readiness.**
 *
 * **ACC-NEG-09** (`ACCEPTANCE.md:714`, the PR-lane row: this file):
 *
 * > Fake GitHub never finishes the fork: after 15 minutes of Preparing, exactly one
 * > `app.fork.timeout`; the card reads "Your fork is taking longer than 15 minutes." with
 * > **Try again** and **Open on GitHub**; the fake recorded no push, no repository
 * > initialisation and exactly one fork request; **Try again**
 * > (`POST /api/works/:id/upstream/readiness/retry` → `202`) after the fake recovers →
 * > `app.fork.ready` with still one fork request; a 4th Try again in the hour is refused
 * > (APW-02 FR-18, FR-19). **Lane note:** the PR lane shortens the 15-minute deadline with
 * > the non-production override `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS` …
 *
 * ## What runs green here, and what does not (measured, not assumed)
 *
 * The **GitHub half** of both cases is real in this lane: the fork request, its token, the
 * absence of every write to the fork, and "the Work never reports ready early" while the
 * fake withholds the fork. That is what the two running tests assert, through the fake's
 * own `/_control/calls` and `/_control/state`.
 *
 * The **readiness half cannot run yet, and the blocker is one measurement**: nothing in
 * this build ever executes APW-02's readiness run. `APP_FORK_READINESS_DISPATCHER` — the
 * token `AppWorkCreateService.dispatchReadiness` injects — has **no provider anywhere in
 * `apps/api`** (`apps/api/src/app-works/app-works.module.ts:49-57` states it is APW-02
 * T31's and binds nothing; a grep over `apps/api/src` finds no `provide:`
 * `APP_FORK_READINESS_DISPATCHER`), and no task in `packages/tasks` runs
 * `AppForkReadinessService`. Measured on the lane's own API (2026-09-19): after a real
 * fork create, `GET /api/works/:id/upstream` answers
 * `readiness: { state: "preparing", reason: "dispatch_unavailable" }` and stays there for
 * the whole 20-second window (sampled every 3 s), and
 * `POST /api/works/:id/upstream/readiness/retry` answers **`409 not_retryable`** — because
 * `preparing` is not a retryable state (`app-upstream-state.service.ts:979-985`) and the
 * only caller of `timeout()` is that same missing run (plus the 10-minute sweeper leg,
 * which times out a row only after three re-dispatches). So `app.fork.ready`,
 * `app.fork.timeout`, the card copy and the `202` retry are all behind the two `fixme`s,
 * each naming the measurement that put it there.
 *
 * One further gap is reported rather than asserted: `app.source.forked` — ACC-E2E-02's
 * "exactly one `app.source.forked`" — has **no emitter** in this tree (a grep for the
 * string across `packages/agent/src` and `apps/api/src` returns nothing), so that event can
 * never appear in Activity in any lane today.
 *
 * Verified live against http://127.0.0.1:3999 (2026-09-19): a fork create answered `200` in
 * ~5.4 s with `appSource.relation: "fork"`, `readiness: "preparing"` and the fork
 * coordinates; the fake recorded exactly one `POST /repos/<upstream>/forks` carrying
 * `tokenIdentity: "apw-e2e-user"`; and no mutating call was ever made against the fork.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appWorkCreateBody,
    createAppWork,
    getUpstream,
    retryUpstreamReadiness,
} from './helpers/app-works';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/** The fake GitHub's control API (`plan §8.3`) — calls, state and faults. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives every account this lane attaches. */
const LANE_LOGIN = 'apw-e2e-user';

/** The owner the run account cannot write to: the fork scenarios' upstream side. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/**
 * The fake's readiness delay, in seconds — ACC-E2E-02's own "the fake GitHub delays
 * readiness 20 s". Planted on the run's own fork route as a `delay` fault, which the fake's
 * `create-fork` handler consumes by publishing the fork only after the delay
 * (`fakes/github-fake/routes/repos.mjs:143-178`: a fork answers `404` until `readyAt`).
 */
const READINESS_DELAY_SECONDS = 20;

/** The create's own budget, from ACC-E2E-02: "`200` … within 10 s". */
const CREATE_BUDGET_MS = 10_000;

/**
 * This file's cases run **one at a time**.
 *
 * `playwright.config.ts` sets `fullyParallel: true`, so a local `playwright test` run of
 * this file beside its sibling `flow-app-work-create-from-url` puts every case of both
 * files on **one** API process and **one** in-memory SQLite at once. Measured on this host
 * (2026-09-19): the same fork create that answers in **5.4 s** on an idle stack took
 * **32.6 s** with eight workers — so ACC-E2E-02's own "within 10 s" budget stops measuring
 * the platform and starts measuring the host. (A probe with eight concurrent registrations
 * did *not* reproduce it — 5.23 s contended vs 5.32 s idle — so it is request queueing
 * under many in-flight clients, not one expensive route.) Serialising this file's cases
 * keeps the case's assertion meaningful on a developer machine; in CI the shard already
 * runs `PLAYWRIGHT_WORKERS=1` (`playwright.config.ts:49-53`, the workflow's baseline),
 * where this setting is a no-op. No assertion is weakened by it.
 */
test.describe.configure({ mode: 'serial' });

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(owner: string, name: string): string {
    return `https://github.com/${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// The fake GitHub's control API
// ---------------------------------------------------------------------------

interface FakeCall {
    method?: string;
    path?: string;
    tokenIdentity?: string;
    status?: number | null;
}

interface FakeRepositoryState {
    full_name?: string;
    fork?: boolean;
    parent?: string | null;
    ready?: boolean;
}

/** Every call the fake has served, or `null` when it is not reachable. */
async function fakeGitHubCalls(request: APIRequestContext): Promise<FakeCall[] | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: FakeCall[] };
        return Array.isArray(body.calls) ? body.calls : null;
    } catch {
        return null;
    }
}

/** The fake's served repositories — the only place a fork's readiness is visible. */
async function fakeGitHubState(request: APIRequestContext): Promise<FakeRepositoryState[] | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/state`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { repositories?: FakeRepositoryState[] };
        return Array.isArray(body.repositories) ? body.repositories : null;
    } catch {
        return null;
    }
}

/**
 * The fake's PR-lane catalog, as checked in (plan §8.3, T2). Located from the working
 * directory, because a spec may be launched from `apps/web` (the lane) or from the repo
 * root (a direct invocation).
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
    extraRepositories: Array<Record<string, unknown>> = [],
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

/** Plant one fault of plan §8.3's vocabulary on ONE route, for one application. */
async function plantDelayOnFork(
    request: APIRequestContext,
    owner: string,
    name: string,
): Promise<boolean> {
    try {
        const res = await request.post(`${FAKE_GITHUB_URL}/_control/fault`, {
            data: {
                route: `/repos/${owner}/${name}/forks`,
                method: 'POST',
                behaviour: 'delay',
                seconds: READINESS_DELAY_SECONDS,
            },
        });
        return res.ok();
    } catch {
        return false;
    }
}

/**
 * The mutating methods a GitHub **write** can arrive with.
 *
 * `POST /graphql` is deliberately not counted: the git plugin issues GraphQL as a *read*
 * and the fake implements no `/graphql` route at all (it answers `404`; measured two to
 * three such calls per inspect). Counting a `404` on an unimplemented route as a write
 * would make the "nothing was pushed" assertion fail for a reason that has nothing to do
 * with the platform touching the fork. Reported as a finding.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isGitHubWrite(call: FakeCall): boolean {
    const method = (call.method ?? '').toUpperCase();
    const path = call.path ?? '';
    if (!MUTATING_METHODS.has(method)) return false;
    return !path.startsWith('/graphql');
}

/** The mutating calls whose path names one repository — the fork, in this file. */
function writesTo(calls: FakeCall[], owner: string, name: string): FakeCall[] {
    const needle = `/${owner}/${name}`;
    return calls.filter((call) => isGitHubWrite(call) && (call.path ?? '').includes(needle));
}

// ---------------------------------------------------------------------------
// The two shapes this file reads back
// ---------------------------------------------------------------------------

interface UpstreamView {
    workId?: string;
    relation?: string;
    dataRepository?: { owner?: string; repo?: string; status?: string };
    upstream?: { owner?: string; repo?: string };
    readiness?: {
        state?: string;
        reason?: string;
        startedAt?: string;
        readyAt?: string;
        manualRetriesLeft?: number;
    };
    actions?: { state?: string };
}

interface CreatedView {
    status?: string;
    appSource?: {
        relation?: string;
        readiness?: string;
        dataRepository?: { owner?: string; repo?: string; url?: string };
        upstream?: { owner?: string; repo?: string; defaultBranch?: string };
    };
    work?: { id?: string; kind?: string; slug?: string };
}

// ---------------------------------------------------------------------------
// ACC-E2E-02 (PR twin) — the fork is requested, and nothing waits for it
// ---------------------------------------------------------------------------

test.describe('ACC-E2E-02 (PR twin) — the fork lifecycle the fake can drive', () => {
    test('the create answers before GitHub publishes the fork, and the fake records one fork request with the user’s token', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t31-fork-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [upstream])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to fork in this run (the PR lane starts it beside the API).',
        );
        test.skip(
            !(await plantDelayOnFork(request, upstream.owner, upstream.name)),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/fault, so the ` +
                `case's own ${READINESS_DELAY_SECONDS}-second readiness delay cannot be planted.`,
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const callsBefore = (await fakeGitHubCalls(request)) ?? [];
        const startedAt = Date.now();
        const created = await createAppWork(request, {
            token: user.access_token,
            body: appWorkCreateBody({
                name: `apw13-t31-fork-${run}`,
                slug: `apw13-t31-fork-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                description: 'APW-13 T31 fork lifecycle',
                organization: false,
                repositoryUrl: repoUrl(upstream.owner, upstream.name),
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
            }),
        });
        const elapsed = Date.now() - startedAt;
        const body = (created.json ?? {}) as CreatedView;

        // 1. "the create call returns without waiting for GitHub" and "within 10 s".
        expect(created.status, `fork create body=${created.text.slice(0, 300)}`).toBe(200);
        expect(
            elapsed,
            `the create must not wait for the fork: it answered in ${elapsed}ms`,
        ).toBeLessThan(CREATE_BUDGET_MS);

        // 2. The answer is a fork whose readiness is `preparing` — the state the "Preparing
        //    your fork" card renders — with both sides of the "Upstream: … · Fork: …" header.
        expect(body.appSource?.relation).toBe('fork');
        expect(body.appSource?.readiness, 'the create never reports a ready fork').toBe(
            'preparing',
        );
        expect(body.appSource?.upstream).toMatchObject({
            owner: upstream.owner,
            repo: upstream.name,
        });
        expect(body.appSource?.dataRepository).toMatchObject({
            owner: LANE_LOGIN,
            repo: upstream.name,
        });

        // 3. The fake withheld the fork: the create returned while GitHub still answered
        //    `404` for it, which is what makes assertion 1 above mean "did not wait".
        const state = await fakeGitHubState(request);
        expect(state, 'the fake answers /_control/state in this lane').not.toBeNull();
        const forkState = (state ?? []).find(
            (repo) => repo.full_name?.toLowerCase() === `${LANE_LOGIN}/${upstream.name}`,
        );
        expect(forkState, 'the fork request reached the fake').toBeTruthy();
        expect(
            forkState?.ready,
            `the fork is still being prepared (the fake publishes it after ` +
                `${READINESS_DELAY_SECONDS}s, and the create answered after ${elapsed}ms)`,
        ).toBe(false);
        expect(forkState?.fork, 'the fake records the new repository as a fork').toBe(true);
        expect(forkState?.parent, 'and records its upstream').toBe(
            `${upstream.owner}/${upstream.name}`,
        );

        // 4. "the PR twin additionally asserts, through the fake's recorded calls, that the
        //    fork request carried the user's token" — one request, and its token IDENTITY
        //    (never a value) is the lane's login.
        const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
        const forkRequests = added.filter(
            (call) =>
                (call.method ?? '').toUpperCase() === 'POST' &&
                call.path === `/repos/${upstream.owner}/${upstream.name}/forks`,
        );
        expect(
            forkRequests.length,
            `exactly one fork request (requests=${JSON.stringify(
                forkRequests.map((c) => `${c.method} ${c.path} -> ${c.status}`),
            )})`,
        ).toBe(1);
        expect(
            forkRequests[0]?.tokenIdentity,
            'the fork was created with the USER’s connection, not the platform’s',
        ).toBe(LANE_LOGIN);

        // 5. The Work row itself is the app kind, with the fork persisted as its Work
        //    Repository (the "Upstream: … · Fork: …" header reads these two coordinates).
        expect(body.work?.id, 'the create answers a Work id').toBeTruthy();
        expect(body.work?.kind).toBe('app');
    });

    test('nothing is pushed to the fork while it is being prepared, and the Work never reads ready', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t31-wait-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [upstream])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to fork in this run.',
        );
        test.skip(
            !(await plantDelayOnFork(request, upstream.owner, upstream.name)),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/fault, so the ` +
                `case's own ${READINESS_DELAY_SECONDS}-second readiness delay cannot be planted.`,
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const callsBefore = (await fakeGitHubCalls(request)) ?? [];
        const created = await createAppWork(request, {
            token: user.access_token,
            body: appWorkCreateBody({
                name: `apw13-t31-wait-${run}`,
                slug: `apw13-t31-wait-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                description: 'APW-13 T31 readiness window',
                organization: false,
                repositoryUrl: repoUrl(upstream.owner, upstream.name),
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
            }),
        });
        expect(created.status, `fork create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = ((created.json ?? {}) as CreatedView).work?.id ?? '';
        expect(workId, 'the created Work id is required to read its upstream').not.toBe('');

        // The window ACC-E2E-02's PR twin describes: poll until the fake publishes the fork
        // (its own readiness clock), sampling the Work's readiness at every step. There is no
        // fixed sleep anywhere in this file — the polling primitive is `expect.poll`, which
        // makes each sample an assertion rather than a pause.
        const sampled: string[] = [];
        let fakePublished = false;
        await expect
            .poll(
                async () => {
                    const state = await fakeGitHubState(request);
                    const forkReady =
                        (state ?? []).find(
                            (repo) =>
                                repo.full_name?.toLowerCase() === `${LANE_LOGIN}/${upstream.name}`,
                        )?.ready === true;
                    const upstreamRead = await getUpstream(request, {
                        token: user.access_token,
                        workId,
                    });
                    const readiness = ((upstreamRead.json ?? {}) as UpstreamView).readiness;
                    sampled.push(
                        `forkReady=${String(forkReady)} state=${String(readiness?.state)} ` +
                            `reason=${String(readiness?.reason)}`,
                    );
                    fakePublished = forkReady;
                    return forkReady;
                },
                {
                    message:
                        `the fake must publish the fork it delayed by ` +
                        `${READINESS_DELAY_SECONDS}s — if it never does, this lane cannot ` +
                        'observe the window at all',
                    timeout: (READINESS_DELAY_SECONDS + 15) * 1_000,
                    intervals: [3_000],
                },
            )
            .toBe(true);

        expect(fakePublished, 'the fake published the fork inside the window').toBe(true);
        expect(
            sampled.length,
            `the window must have been sampled more than once (samples=${JSON.stringify(sampled)})`,
        ).toBeGreaterThan(1);
        expect(
            sampled.filter((sample) => sample.includes('state=ready')).length,
            'the Work never reports ready early: not one sample read `ready` ' +
                `(samples=${JSON.stringify(sampled)})`,
        ).toBe(0);

        // "never pushes to the fork before readiness" / ACC-NEG-09's "the fake recorded no
        // push, no repository initialisation": no mutating call against the fork's own
        // coordinates at any point in the window.
        const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
        const forkWrites = writesTo(added, LANE_LOGIN, upstream.name);
        expect(
            forkWrites.length,
            'nothing may be pushed to the fork while it is being prepared ' +
                `(writes=${JSON.stringify(forkWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);
    });

    /**
     * ACC-E2E-02's ready half, and ACC-NEG-09's timeout.
     *
     * Nothing in this build runs APW-02's readiness job. `APP_FORK_READINESS_DISPATCHER`
     * has no provider in `apps/api` (`app-works.module.ts:49-57` says so in prose; a grep
     * finds no `provide:` for the token), and no task in `packages/tasks` runs
     * `AppForkReadinessService`. Measured on this lane (2026-09-19) after a real fork
     * create: `readiness.state` stayed `preparing` with `reason: "dispatch_unavailable"`
     * for the whole 20-second window, and the retry route answered `409 not_retryable`
     * (`app-upstream-state.service.ts:979-985`). The assertions are the case's own, and are
     * what a bound dispatcher plus a running readiness job would turn green.
     */
    test.fixme(
        'APW-02: the ready half — app.fork.ready, the Upstream header and the readiness transition ' +
            'need a readiness job, and no dispatcher for APP_FORK_READINESS_DISPATCHER is bound in ' +
            'apps/api, so the Work rests at preparing/dispatch_unavailable (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t31-ready-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [upstream])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );

            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const created = await createAppWork(request, {
                token: user.access_token,
                body: appWorkCreateBody({
                    name: `apw13-t31-ready-${run}`,
                    slug: `apw13-t31-ready-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                    description: 'APW-13 T31 readiness',
                    organization: false,
                    repositoryUrl: repoUrl(upstream.owner, upstream.name),
                    repositoryMode: 'fork',
                    targetOwner: LANE_LOGIN,
                }),
            });
            expect(created.status).toBe(200);
            const workId = ((created.json ?? {}) as CreatedView).work?.id ?? '';

            await expect
                .poll(
                    async () => {
                        const read = await getUpstream(request, {
                            token: user.access_token,
                            workId,
                        });
                        return ((read.json ?? {}) as UpstreamView).readiness?.state;
                    },
                    { timeout: 60_000, intervals: [2_000] },
                )
                .toBe('ready');

            const read = await getUpstream(request, { token: user.access_token, workId });
            const view = (read.json ?? {}) as UpstreamView;
            expect(
                view.readiness?.readyAt,
                'a ready fork carries the instant it became ready',
            ).toBeTruthy();
            expect(view.dataRepository).toMatchObject({ owner: LANE_LOGIN, repo: upstream.name });
            expect(
                view.upstream,
                'the "Upstream: … · Fork: …" header reads both sides',
            ).toMatchObject({ owner: upstream.owner, repo: upstream.name });
        },
    );
});

// ---------------------------------------------------------------------------
// ACC-NEG-09 — the fork that never finishes
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-09 — the fork never becomes ready', () => {
    /**
     * The timeout and the retry, which are the same missing readiness run.
     *
     * A `never-ready` fault is planted (the case's "Fake GitHub never finishes the fork"),
     * and the PR lane's shortened deadline would be
     * `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`. Nothing observes the deadline: the only
     * caller of `timeout()` is `AppForkReadinessService` (no task runs it) plus the
     * dispatcher's 10-minute sweeper leg, which times a row out only after three
     * re-dispatches (`app-upstream-sync-dispatcher.service.ts:248-279`), and the **Try
     * again** route refuses while the row is `preparing` — measured `409 not_retryable` on
     * this lane, 2026-09-19. The measurable half of this case (no push, no repository
     * initialisation, exactly one fork request) runs green in the two tests above.
     */
    test.fixme(
        'APW-02: the fork timeout needs the readiness job that calls timeout(), and Try again ' +
            'needs a retryable state — measured 409 not_retryable while the Work sits at ' +
            'preparing/dispatch_unavailable (2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t31-never-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [upstream])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            await request.post(`${FAKE_GITHUB_URL}/_control/fault`, {
                data: {
                    route: `/repos/${upstream.owner}/${upstream.name}/forks`,
                    method: 'POST',
                    behaviour: 'never-ready',
                },
            });

            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const created = await createAppWork(request, {
                token: user.access_token,
                body: appWorkCreateBody({
                    name: `apw13-t31-never-${run}`,
                    slug: `apw13-t31-never-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                    description: 'APW-13 T31 fork timeout',
                    organization: false,
                    repositoryUrl: repoUrl(upstream.owner, upstream.name),
                    repositoryMode: 'fork',
                    targetOwner: LANE_LOGIN,
                }),
            });
            expect(created.status).toBe(200);
            const workId = ((created.json ?? {}) as CreatedView).work?.id ?? '';

            // The deadline the lane's override shortens — `timed_out` with exactly one
            // `app.fork.timeout` row in Activity.
            await expect
                .poll(
                    async () => {
                        const read = await getUpstream(request, {
                            token: user.access_token,
                            workId,
                        });
                        return ((read.json ?? {}) as UpstreamView).readiness?.state;
                    },
                    { timeout: 60_000, intervals: [2_000] },
                )
                .toBe('timed_out');

            const activity = await request.get(
                `${API_BASE}/api/activity-log?workId=${workId}&limit=100`,
                { headers: authedHeaders(user.access_token) },
            );
            const rows = ((await activity.json()) as { activities?: Array<{ action?: string }> })
                .activities;
            expect(
                (rows ?? []).filter((row) => row.action === 'app.fork.timeout').length,
                'exactly one app.fork.timeout per attempt',
            ).toBe(1);

            // **Try again** re-queues without a second fork, and the fourth call in the
            // rolling hour is refused.
            const retry = await retryUpstreamReadiness(request, {
                token: user.access_token,
                workId,
            });
            expect(retry.status, `retry body=${retry.text.slice(0, 200)}`).toBe(202);
            const fourth = await retryUpstreamReadiness(request, {
                token: user.access_token,
                workId,
            });
            expect(fourth.status).toBe(429);
            expect(fourth.text).toContain('retry_limit_reached');
        },
    );
});
