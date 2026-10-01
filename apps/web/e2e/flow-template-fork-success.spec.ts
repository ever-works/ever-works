/**
 * APW-13 T15 — Work Template fork succeeds (ACC-REG-02).
 *
 * ACC-REG-02's recorded verdict is *Gap — no successful fork anywhere; no
 * GitHub plugin test of the fork call*. The fork path needs the caller's GitHub
 * connection twice over: the platform forks INTO an owner the caller can write
 * to, and it forks with the CALLER'S token, which is the fact this spec is
 * supposed to pin (`GET /_control/calls` on the fake must show that token's
 * identity on the fork call — T15's own "Done when").
 *
 * ── What changed: the create acts on the fork fields (APW-01 T12 + T13, `5b838cb97`)
 *
 * An `app` create no longer falls through to the generated-website path.
 * `work-lifecycle.service.ts` hands it to `AppWorkCreateService` (the
 * `isAppWorkKind` branch that sits first), whose step 6 inspects the upstream
 * fresh and lists the owners the caller's connection can create in: their own
 * login first, then the organizations `GET /user/orgs` answers. A `targetOwner`
 * outside that list is refused with **`400 target_owner_unavailable`** (FR-13),
 * before any provider write. Step 9 forks with the caller's own connection:
 * `forkRepository(…, { organization, waitForReady: false })`, where
 * `organization` is set only for an owner the inspection typed as one.
 *
 * That retired the test this file used to run ("a create asking to fork is
 * accepted, and the fake still records no fork call"). It encoded the gap T13
 * closed, and e2e run 35455975352 (job 105940305928) measured it failing:
 * `400 {"code":"target_owner_unavailable"}` for `targetOwner: 'apw13-e2e-user'`,
 * a login no fake account has (the fixture's login is `apw-e2e-user`), sent
 * without a connection. It is replaced below by the refusal it now meets, and
 * the success halves it was waiting for are no longer behind a marker.
 *
 * ── What runs here, against the PR lane's fake GitHub
 *
 *   • **the refusal** — a connected caller asking to fork into an account that is
 *     not one of theirs gets `400 target_owner_unavailable`, and the fake records
 *     no fork request for that upstream. An inspect of the same URL is read first
 *     and asserted, so the refusal is shown to be about the OWNER: the upstream
 *     was read, the fork mode is available, and the caller's own login is offered;
 *   • **the user half** — fork into the caller's own login: `200`,
 *     `appSource.relation: "fork"`, the fork under the caller's login, and exactly
 *     one `POST /repos/<upstream>/forks` carrying the caller's token identity;
 *   • **the organization half** — the same into `apw-e2e-org`, which the fake's
 *     seed fixture lists on `GET /user/orgs`. The inspect's owner list is asserted
 *     first, so a lane whose fake does not offer the organization fails on that
 *     precondition by name rather than as an unexplained `400`.
 *
 * Every case seeds its OWN upstream (`apw-e2e-upstream/<run>`) and filters the
 * fake's shared call log to that upstream's path. It does not fork
 * `ever-works/templates`: the seed already holds `apw-e2e-user/templates` as a
 * fork of it, so a fork into the user would be ADOPTED (the plugin's and step 8's
 * existing-fork path) and no fork request would be made at all.
 *
 * ── What was checked, and where (2026-09-25)
 *
 * The plugin-to-fake half was driven for real: the built GitHub plugin
 * (`GitHubApiService`) against this fake, seeded with `catalog-pr-lane.seed.json`
 * plus a fresh upstream. `getOrganizations` answered `["ever-works","apw-e2e-org"]`;
 * `findExistingFork` answered `null` for all three owners; `forkRepository` with
 * `{ organization: 'apw-e2e-org' }` produced `apw-e2e-org/<name>` (`fork: true`,
 * parent the upstream), and without it `apw-e2e-user/<name>`. Every fork request
 * was recorded as `POST /repos/<upstream>/forks → 202` with
 * `tokenIdentity: "apw-e2e-user"`. The existing-fork lookup also issues
 * `GET /repos/<upstream>/forks` reads, which is why the filter below matches
 * the method as well as the path. The service half is pinned by the agent's
 * unit specs: the stranger refusal and the organization fork
 * (`app-work-create.service.spec.ts`), and the requested-owner entry
 * (`app-source-inspector.service.spec.ts`). The user half matches what
 * `flow-app-work-fork-lifecycle.spec.ts` measured on a lane on 2026-09-19. The
 * three cases as written here have not yet run on a lane stack.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import { registerUserViaAPI } from './helpers/api';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    createAppWork,
    inspectAppSource,
    type RawApiResult,
} from './helpers/app-works';
import { connectCustomerGitHub } from './helpers/github-connection';

/** The fake GitHub's control API (`plan §8.3`) — where the fork call must show. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives every account this lane attaches. */
const LANE_LOGIN = 'apw-e2e-user';

/**
 * An organization the lane's account can fork into: the seed fixture's
 * `organizations` list (`catalog-pr-lane.seed.json`) is what the fake answers on
 * `GET /user/orgs`, and this is the organization kept for the e2e suite (the
 * fake's own unit spec forks into it too).
 */
const LANE_ORG = 'apw-e2e-org';

/**
 * An account that is not one of the caller's: another user the fake knows (a
 * seeded login of its own), and neither the caller's login nor one of their
 * organizations.
 */
const FOREIGN_OWNER = 'apw-e2e-stranger';

/** The owner the run account cannot write to: the upstream side of every case. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(owner: string, name: string): string {
    return `https://github.com/${owner}/${name}`;
}

function sameLogin(a: string | undefined, b: string): boolean {
    return (a ?? '').toLowerCase() === b.toLowerCase();
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

/** The fake's served repositories — where a fork, and its parent, are visible. */
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

/**
 * Seed the checked-in fixture plus this run's own upstream. `false` ⇒ the fake is absent.
 *
 * The fixture carries the lane's users (the token → `apw-e2e-user` mapping the fork's token
 * identity is read from) and its `organizations`, which is what `GET /user/orgs` answers.
 * Seeding is additive, so re-seeding it beside other specs changes nothing they rely on.
 */
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

/**
 * The fork REQUESTS for one upstream: `POST /repos/<owner>/<name>/forks`.
 *
 * Two narrowings, and each is load-bearing:
 *
 *   - **the method.** Since T13 the create's own inspection looks for an existing fork, and
 *     one of its three lookups is `GET /repos/<upstream>/forks` — a READ on the same path.
 *     A path-only filter (`/\/forks$/`, which this file used before) counts those reads as
 *     forks, one per owner scanned.
 *   - **this run's upstream.** The fake's call log is SHARED: the chromium project runs spec
 *     files in parallel workers, and the fork-lifecycle spec forks on the same fake. Every
 *     case here seeds an upstream no other case uses, so matching its exact path reads this
 *     case's calls and nothing else, with no before/after count to race.
 */
function forkRequestsFor(
    calls: readonly FakeCall[],
    upstream: { owner: string; name: string },
): FakeCall[] {
    const path = `/repos/${upstream.owner}/${upstream.name}/forks`.toLowerCase();
    return calls.filter(
        (call) =>
            (call.method ?? '').toUpperCase() === 'POST' &&
            (call.path ?? '').toLowerCase() === path,
    );
}

// ---------------------------------------------------------------------------
// The two shapes this file reads back
// ---------------------------------------------------------------------------

interface InspectView {
    repository?: { owner?: string; repo?: string };
    modes?: { fork?: { available?: boolean; reason?: string } };
    targetOwners?: Array<{ login?: string; type?: string; available?: boolean; reason?: string }>;
}

interface CreatedView {
    status?: string;
    code?: string;
    appSource?: {
        relation?: string;
        dataRepository?: { owner?: string; repo?: string };
        upstream?: { owner?: string; repo?: string };
    };
    work?: { id?: string; kind?: string };
}

/** The create body every case sends, differing only in the owner. */
function forkCreateBody(run: string, label: string, upstreamName: string, targetOwner: string) {
    return appWorkCreateBody({
        name: `apw13-t15-${label} ${run}`,
        slug: `apw13-t15-${label}-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        description: `APW-13 T15 template fork into ${targetOwner}`,
        organization: false,
        repositoryUrl: repoUrl(UPSTREAM_OWNER, upstreamName),
        repositoryMode: 'fork',
        targetOwner,
    });
}

/** The inspect of one URL, asserted to have READ the upstream (not a provider refusal). */
async function inspectUpstream(
    request: APIRequestContext,
    token: string,
    upstream: { owner: string; name: string },
): Promise<InspectView> {
    const inspected: RawApiResult = await inspectAppSource(request, {
        token,
        body: appSourceInspectBody({ repositoryUrl: repoUrl(upstream.owner, upstream.name) }),
    });
    expect(inspected.status, `inspect body=${inspected.text.slice(0, 300)}`).toBe(200);
    const view = (inspected.json ?? {}) as InspectView;
    expect(
        view.modes?.fork,
        'the fork mode is available for the seeded upstream — so a refusal below is about the ' +
            `owner, not the repository (inspect body=${inspected.text.slice(0, 300)})`,
    ).toMatchObject({ available: true });
    return view;
}

// ---------------------------------------------------------------------------
// FR-13 — an owner that is not the caller's is refused, and nothing is forked
// ---------------------------------------------------------------------------

test.describe('Work Template fork — an owner that is not the caller’s is refused (FR-13)', () => {
    test('a fork into another account answers 400 target_owner_unavailable, and the fake records no fork request', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t15-refused-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [upstream])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to fork in this run (the PR lane starts it beside the API).',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. The refusal must be about the OWNER. The same inspection the create runs at
        //    step 6 read the upstream, offers the caller's own login, and does not offer
        //    the account this case asks for — so "no fork" below cannot be the side effect
        //    of a repository the platform failed to read.
        const inspected = await inspectUpstream(request, user.access_token, upstream);
        const owners = inspected.targetOwners ?? [];
        expect(
            owners.find((owner) => sameLogin(owner.login, LANE_LOGIN)),
            `the caller's own login is an available owner (owners=${JSON.stringify(owners)})`,
        ).toMatchObject({ type: 'user', available: true });
        expect(
            owners.some((owner) => sameLogin(owner.login, FOREIGN_OWNER)),
            `${FOREIGN_OWNER} is not one of the caller's accounts (owners=${JSON.stringify(owners)})`,
        ).toBe(false);

        // 2. The create is refused, with the inspector's own code.
        const created = await createAppWork(request, {
            token: user.access_token,
            body: forkCreateBody(run, 'refused', upstream.name, FOREIGN_OWNER),
        });
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(400);
        expect((created.json ?? {}) as CreatedView).toMatchObject({
            code: 'target_owner_unavailable',
        });

        // 3. Nothing was forked: no fork REQUEST for this upstream reached the fake, and
        //    the fake holds no repository whose parent is this upstream. The refusal is
        //    step 6's, before step 9's provider write.
        const forkRequests = forkRequestsFor((await fakeGitHubCalls(request)) ?? [], upstream);
        expect(
            forkRequests.length,
            'nothing may be forked for an owner the caller cannot create in ' +
                `(requests=${JSON.stringify(forkRequests.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);
        const state = await fakeGitHubState(request);
        expect(state, 'the fake answers /_control/state in this lane').not.toBeNull();
        expect(
            (state ?? []).filter((repo) =>
                sameLogin(repo.parent ?? '', `${upstream.owner}/${upstream.name}`),
            ),
            'no fork of this upstream exists on the fake',
        ).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T15 — the success halves: into the caller's account, and into an organization
// ---------------------------------------------------------------------------

test.describe('Work Template fork — the success halves (T15)', () => {
    test('a fork into the caller’s own account answers 200, and the fake records one fork request with the caller’s token', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t15-user-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [upstream])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to fork in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. Fork into the USER's own account: the Work records the upstream and the
        //    fork's coordinates, and the fork lands under the caller's login.
        const created = await createAppWork(request, {
            token: user.access_token,
            body: forkCreateBody(run, 'user', upstream.name, LANE_LOGIN),
        });
        expect(created.status, `fork into ${LANE_LOGIN} body=${created.text.slice(0, 300)}`).toBe(
            200,
        );
        const body = (created.json ?? {}) as CreatedView;
        expect(body.work?.kind, 'the create produced a Work of the app kind').toBe('app');
        expect(body.appSource?.relation).toBe('fork');
        expect(body.appSource?.upstream).toMatchObject({
            owner: upstream.owner,
            repo: upstream.name,
        });
        expect(body.appSource?.dataRepository).toMatchObject({
            owner: LANE_LOGIN,
            repo: upstream.name,
        });

        // 2. The fake recorded the FORK request, once, with the user's token identity on
        //    it — T15's "Done when" (`/_control/calls` records method, path and token
        //    IDENTITY, never a value).
        const forkRequests = forkRequestsFor((await fakeGitHubCalls(request)) ?? [], upstream);
        expect(
            forkRequests.length,
            `exactly one fork request for ${upstream.owner}/${upstream.name} ` +
                `(requests=${JSON.stringify(forkRequests.map((c) => `${c.method} ${c.path} -> ${c.status}`))})`,
        ).toBe(1);
        expect(
            forkRequests[0]?.tokenIdentity,
            'the fork was requested with the USER’s connection, not the platform’s',
        ).toBe(LANE_LOGIN);

        // 3. The fork exists on the fake, under the caller, with this upstream as parent.
        const state = await fakeGitHubState(request);
        const fork = (state ?? []).find((repo) =>
            sameLogin(repo.full_name, `${LANE_LOGIN}/${upstream.name}`),
        );
        expect(fork, 'the fork reached the fake').toBeTruthy();
        expect(fork?.fork).toBe(true);
        expect(fork?.parent).toBe(`${upstream.owner}/${upstream.name}`);
    });

    test('a fork into an organization the caller belongs to answers 200, and the fork request carries the caller’s token', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t15-org-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [upstream])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to fork in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. The precondition, asserted rather than assumed: the create's own inspection
        //    offers the organization as an available owner OF THE ORGANIZATION TYPE. That
        //    type is what makes step 9 pass `organization`, so a lane whose fake does not
        //    list the organization on `GET /user/orgs` fails here, by name.
        const inspected = await inspectUpstream(request, user.access_token, upstream);
        const owners = inspected.targetOwners ?? [];
        expect(
            owners.find((owner) => sameLogin(owner.login, LANE_ORG)),
            `${LANE_ORG} must be offered as an organization the caller can fork into ` +
                `(owners=${JSON.stringify(owners)})`,
        ).toMatchObject({ type: 'organization', available: true });

        // 2. Fork into the ORGANIZATION (the owner-picker half).
        const created = await createAppWork(request, {
            token: user.access_token,
            body: forkCreateBody(run, 'org', upstream.name, LANE_ORG),
        });
        expect(created.status, `fork into ${LANE_ORG} body=${created.text.slice(0, 300)}`).toBe(
            200,
        );
        const body = (created.json ?? {}) as CreatedView;
        expect(body.work?.kind, 'the create produced a Work of the app kind').toBe('app');
        expect(body.appSource?.relation).toBe('fork');
        expect(body.appSource?.upstream).toMatchObject({
            owner: upstream.owner,
            repo: upstream.name,
        });
        expect(body.appSource?.dataRepository).toMatchObject({
            owner: LANE_ORG,
            repo: upstream.name,
        });

        // 3. One fork request, still made with the USER's connection: forking into an
        //    organization changes where the fork lands, not whose token asks for it.
        const forkRequests = forkRequestsFor((await fakeGitHubCalls(request)) ?? [], upstream);
        expect(
            forkRequests.length,
            `exactly one fork request for ${upstream.owner}/${upstream.name} ` +
                `(requests=${JSON.stringify(forkRequests.map((c) => `${c.method} ${c.path} -> ${c.status}`))})`,
        ).toBe(1);
        expect(
            forkRequests[0]?.tokenIdentity,
            'the fork into the organization was requested with the USER’s connection',
        ).toBe(LANE_LOGIN);

        // 4. The fork exists on the fake under the ORGANIZATION, with this upstream as
        //    parent — and not under the caller's own login.
        const state = await fakeGitHubState(request);
        const orgFork = (state ?? []).find((repo) =>
            sameLogin(repo.full_name, `${LANE_ORG}/${upstream.name}`),
        );
        expect(orgFork, 'the fork landed in the organization').toBeTruthy();
        expect(orgFork?.fork).toBe(true);
        expect(orgFork?.parent).toBe(`${upstream.owner}/${upstream.name}`);
        expect(
            (state ?? []).some((repo) =>
                sameLogin(repo.full_name, `${LANE_LOGIN}/${upstream.name}`),
            ),
            'nothing was forked into the caller’s own account instead',
        ).toBe(false);
    });
});
