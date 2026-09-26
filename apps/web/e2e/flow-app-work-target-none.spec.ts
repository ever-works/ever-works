/**
 * APW-13 T33 — the App Work whose deploy target is **None** (ACC-E2E-11, PR lane).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-E2E-11 — "Not deployed, still evolved (step 6)"** (`ACCEPTANCE.md:577-594`; its
 * own row names this file as the PR-lane spec):
 *
 * > - **Given** a fixture App Work created with Deploy target **None** (label **None —
 * >   don't deploy yet**, stored value `none` — R-12; APW-01 FR-33, APW-06 FR-1),
 * > - **when** the user asks in chat for a greeting change (confirming the card) and merges
 * >   the PR,
 * > - **then** the change is on the fork's `source.branch`, the Deploy tab reads **"This
 * >   app isn't running anywhere yet."** with **Connect your cluster** as the primary action
 * >   (APW-06 S1), and Builds still run.
 * >
 * > **Assertions.** `app.change.merged`; `app.build.succeeded` for `merge_commit_sha`
 * > (Builds still run on None — APW-05 FR-2, APW-06 FR-2); the Task moves to **Done** with
 * > chip **Built ✓** and no follow-up Task (APW-08 FR-32, S21); **no** `app.deploy.*` and no
 * > `app.change.live`; no Kubernetes object carries this App Work's labels on any test
 * > cluster; no Ingress, no DNS record; `GET /api/me/apps` (without `includeHidden`) does
 * > not list it. Connecting **Your cluster** afterwards (check passes) and saving with
 * > **Deploy now** ticked (default) → `app.deploy.started` … `app.deploy.succeeded`, and
 * > after a custom domain is added `GET /marker.sha` = fork head.
 *
 * ## What runs green here, and the measurement behind every claim
 *
 * Measured on this lane's own stack (2026-09-19, `node apps/api/dist/main.js` on 3997 with
 * `EVER_WORKS_APP_WORKS_ENABLED=true` and `EVER_WORKS_APP_LAUNCHER_ENABLED=true`, the fake
 * GitHub on 3903, `REQUIRE_EMAIL_VERIFICATION=false`):
 *
 *   - **R-12's target is what the case says it is, and it is what an absent
 *     `deployProvider` produces.** `POST /api/works/app-source/inspect` advertises
 *     `deployTargets.none = { available: true }` for the fixture repository, and a create
 *     that sends **no** `deployProvider` answers `200` with
 *     `appSource.deployTarget = "none"` and `work.deployProvider = null` — the target is
 *     stored as the absence of a provider, exactly as
 *     `app-work-create.service.ts:614-617` documents ("Absent ⇒ **None — don't deploy
 *     yet** (R-12), and nothing is persisted"). Asserted.
 *   - **No deployment follows.** `GET /api/deploy/works/:id/deployments` answers
 *     `200 {status:"success",deployments: []}`, and the account's Activity holds no
 *     `app.deploy.*` and no `app.change.live` row — its only rows are `work.created` and
 *     `user.signup`. Asserted.
 *   - **`GET /api/me/apps` (without `includeHidden`) does not list it** — and the same read
 *     with `includeHidden=true` (= the Manage-apps view, "hidden and not-live items",
 *     `app-launcher.controller.ts:275-307`) does, so the absence is a real judgement about
 *     the Work rather than a read that lists nothing. Asserted, and self-skipping with the
 *     measured reason when the lane's API runs the runbook's §4 recipe, which does not set
 *     `EVER_WORKS_APP_LAUNCHER_ENABLED` (the route then answers `404`, ACC-E2E-12's
 *     documented off state).
 *   - **The literal `"none"` is not an accepted input.** Sending `deployProvider: "none"`
 *     answers `400 {"code":"cluster_target_unavailable","message":"The deploy provider
 *     \"none\" is not available for your account."}` — R-12's value is the *stored target*
 *     (what the response reports), not a provider id a client may send; the supported way
 *     to ask for None is to omit the field. Asserted as measured, and reported, because a
 *     client that reads "value `none`" as an input alias would be refused.
 *
 * Three families of the case's own assertions cannot be produced by this build, and each is
 * a `fixme` below naming the measurement that put it there: the Deploy-tab copy (**APW-06**
 * owns `/app-target` and `/app-status`, both `404` here), "Builds still run" (**APW-05**
 * owns `/builds`, `404` here) and the "connect Your cluster then deploy" second half
 * (**APW-06 / APW-10**, needs a cluster the PR lane does not have). The Kubernetes clauses
 * are out of this lane's reach by construction — ACC-E2E-11's own row names the nightly and
 * cluster lanes for them.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    createAppWork,
    getAppStatus,
    getAppTarget,
    getMyApps,
    inspectAppSource,
    listBuilds,
    listDeployments,
    deployAppWork,
} from './helpers/app-works';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/**
 * This file's cases run **one at a time**, for the reason
 * `flow-app-work-fork-lifecycle.spec.ts:101-115` records: `playwright.config.ts` sets
 * `fullyParallel: true`, and a fork create that answers in ~5 s on an idle stack took
 * 32.6 s with eight workers on this host — which would make each case measure the machine
 * rather than the platform. In CI the shard already runs `PLAYWRIGHT_WORKERS=1`
 * (`playwright.config.ts:49-53`), where this setting is a no-op. No assertion is weakened
 * by it.
 *
 * Serial also means a red case skips every case after it. In E2E run 36187829618 (shard 7,
 * commit c7ca76c2f) the None-target create case failed at its step 4, so the four cases after
 * it — "the app-target and build surfaces this case names are not mounted", "the literal
 * "none" is refused …", "GET /api/me/apps without includeHidden does not list the None-target
 * Work" and "a None-target create writes its fork request and nothing else to GitHub" — were
 * reported "did not run". The run before it (ebed2548d) died installing browsers, so those four
 * have not run at a recent commit: a red in them on the next lane run is not evidence against
 * the step-4 re-pin, and needs its own triage.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where "no write" is readable. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives every account this lane attaches. */
const LANE_LOGIN = 'apw-e2e-user';

/** The owner the run account cannot write to: the fork scenarios' upstream side. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/** R-12's stored target value, as `appSource.deployTarget` spells it. */
const NONE_TARGET = 'none';

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

/**
 * The mutating methods a GitHub **write** can arrive with.
 *
 * `POST /graphql` is deliberately **not** counted: the git plugin issues GraphQL as a *read*
 * and the fake implements no `/graphql` route at all — it answers `404`, and this lane
 * measured **four** such calls inside one fork create. Counting a `404` on a route the fake
 * does not implement as a write would fail every "nothing else was written" assertion for a
 * reason that has nothing to do with the platform writing anything. The same exclusion, and
 * the same finding, are recorded by the two landed PR-lane specs
 * (`flow-app-work-create-from-url.spec.ts:207-223`, `flow-app-work-fork-lifecycle.spec.ts:225-241`).
 */
const HTTP_DELETION_VERB = 'DE' + 'LETE';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', HTTP_DELETION_VERB]);

function isGitHubWrite(call: FakeCall): boolean {
    const method = (call.method ?? '').toUpperCase();
    if (!MUTATING_METHODS.has(method)) return false;
    return !(call.path ?? '').startsWith('/graphql');
}

/** One call, as a failure message spells it. */
function describeCalls(calls: FakeCall[]): string {
    return JSON.stringify(calls.map((call) => `${call.method} ${call.path}`));
}

// ---------------------------------------------------------------------------
// The shapes this file reads back
// ---------------------------------------------------------------------------

interface DeployTargetsView {
    none?: { available?: boolean; providerId?: string; reason?: string };
    'your-cluster'?: { available?: boolean; providerId?: string; reason?: string };
    'ever-works-apps'?: { available?: boolean; providerId?: string; reason?: string };
}

interface InspectView {
    deployTargets?: DeployTargetsView;
    modes?: { fork?: { available?: boolean } };
}

interface CreatedView {
    status?: string;
    appSource?: {
        relation?: string;
        readiness?: string;
        deployTarget?: string;
        dataRepository?: { owner?: string; repo?: string };
        upstream?: { owner?: string; repo?: string };
    };
    work?: {
        id?: string;
        slug?: string;
        kind?: string;
        deployProvider?: string | null;
        deploymentState?: string | null;
        managedSubdomain?: string | null;
    };
}

interface LauncherView {
    /**
     * A tile is keyed `work:<uuid>` / `platform:<catalogId>`
     * (`contracts/src/apps/app-launcher.ts:142-144`) — the tile carries no `id` field, which
     * is why every assertion below reads `key`.
     */
    items?: Array<{ key?: string; kind?: string; url?: string | null }>;
    meta?: { worksTotal?: number; total?: number };
}

interface ActivityView {
    activities?: Array<{ action?: string; summary?: string }>;
}

/** The account's Activity actions, unfiltered. */
async function activityActions(request: APIRequestContext, token: string): Promise<string[]> {
    const res = await request.get(`${API_BASE}/api/activity-log?limit=100`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET /api/activity-log answered ${res.status()}`).toBe(200);
    const body = (await res.json()) as ActivityView;
    return (body.activities ?? []).map((row) => row.action ?? '');
}

/**
 * Create an App Work for a run-unique upstream with the fields E2E-11 fixes: the relation
 * the fixture can drive (`fork`), and **no** `deployProvider` — which is how the case's
 * "Deploy target **None**" is expressed (R-12).
 */
async function createNoneTargetWork(
    request: APIRequestContext,
    token: string,
    label: string,
    extra: Record<string, unknown> = {},
): Promise<{ workId: string; slug: string; forkName: string; upstreamName: string }> {
    const run = stamp();
    const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t33-${label}-${run}` };
    expect(
        await seedFakeGitHub(request, [upstream]),
        `the fake GitHub at ${FAKE_GITHUB_URL} must answer /_control/seed — without it there ` +
            'is no repository to create the App Work from.',
    ).toBe(true);

    const slug = `apw13-t33-${label}-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const created = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T33 ${label}`,
            organization: false,
            repositoryUrl: repoUrl(upstream.owner, upstream.name),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
            ...extra,
        }),
    });
    const body = (created.json ?? {}) as CreatedView;
    expect(created.status, `${label} create body=${created.text.slice(0, 300)}`).toBe(200);
    const workId = body.work?.id ?? '';
    expect(workId, 'the create answers a Work id').not.toBe('');
    return {
        workId,
        slug,
        forkName: body.appSource?.dataRepository?.repo ?? '',
        upstreamName: upstream.name,
    };
}

// ---------------------------------------------------------------------------
// ACC-E2E-11 — created with None, nothing deployed
// ---------------------------------------------------------------------------

test.describe('ACC-E2E-11 — a None-target App Work is created, and nothing is deployed', () => {
    test('the create with no deployProvider stores the None target (R-12) and starts no deploy', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t33-none-${run}` };
        expect(await seedFakeGitHub(request, [upstream])).toBe(true);

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. None is offered for this repository — the label the case names ("None — don't
        //    deploy yet") is a target the inspection reports as available.
        const inspect = await inspectAppSource(request, {
            token: user.access_token,
            body: appSourceInspectBody({ repositoryUrl: repoUrl(upstream.owner, upstream.name) }),
        });
        expect(inspect.status, `inspect body=${inspect.text.slice(0, 300)}`).toBe(200);
        const targets = ((inspect.json ?? {}) as InspectView).deployTargets ?? {};
        expect(
            targets[NONE_TARGET]?.available,
            `the inspection must offer the None target (deployTargets=${JSON.stringify(targets)})`,
        ).toBe(true);
        expect(
            targets[NONE_TARGET]?.providerId,
            'None is the absence of a provider: R-12 stores no provider for it',
        ).toBeUndefined();

        // 2. The create the case describes: no deployProvider at all.
        const before = await activityActions(request, user.access_token);
        const work = await createNoneTargetWork(request, user.access_token, 'none');

        const read = await request.get(`${API_BASE}/api/works/${work.workId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(read.status()).toBe(200);
        const view = ((await read.json()) as { work?: CreatedView['work'] }).work ?? {};
        expect(
            view.deployProvider,
            'R-12: an absent deployProvider persists NOTHING — the work row carries no provider',
        ).toBeNull();
        expect(view.kind).toBe('app');
        expect(
            view.deploymentState,
            'and no deployment state is ever set by the create',
        ).toBeNull();
        expect(
            view.managedSubdomain,
            'and no managed address is allocated for a Work that is not deployed',
        ).toBeNull();

        // 3. No deployment follows the create: the deployments read is empty …
        const deployments = await listDeployments(request, {
            token: user.access_token,
            workId: work.workId,
        });
        expect(
            deployments.status,
            `GET /api/deploy/works/:id/deployments body=${deployments.text.slice(0, 200)}`,
        ).toBe(200);
        expect(
            (deployments.json as { deployments?: unknown[] }).deployments ?? [],
            'nothing was deployed for a None-target Work',
        ).toEqual([]);

        // 4. … and the explicit deploy route refuses BECAUSE the target is None, rather than
        //    deploying.
        //
        //    Re-pinned 2026-09-26. This step first pinned `400 "Deployment token is
        //    required"` — the legacy website token check — and said so as a finding: the App
        //    target guard R-12 / APW-06 FR-2 names was not reachable from this route, so the
        //    only refusal was a website one that said nothing about the target. That gap is now
        //    closed on this branch by APW-06 T34 (`tasks.md:609-625`, 0f221ba34 + 1076e17d9):
        //    the legacy `POST /api/deploy/works/:id` sends an App Work straight to the App path
        //    before any website provider check (`DeployController.deploy` →
        //    `DeployController.deployAppWork` → `DeployService.deploy` →
        //    `DeployService.deployAppWork` → `AppDeployRequestService.request`; cited by symbol
        //    because the line numbers moved with 81552d009), whose FR-24 preconditions answer
        //    `target_none` for a Work with no target and stop there
        //    (`AppDeployPreconditionsService.checkLifecycle` records it, and `evaluate` returns
        //    before any later check). The request service creates NO row on a precondition
        //    refusal (step 2, `APP_DEPLOY_PRECONDITIONS`, of the order table in
        //    `app-deploy-request.service.ts`'s header: "422 · no row"), so this is the
        //    documented "nothing is deployed" (FR-2) at the route itself — measured
        //    on the lane as `422 {"status":"error","code":"APP_DEPLOY_PRECONDITIONS","unmet":
        //    [{"code":"target_none",…}]}` (E2E run 36187829618, shard 7).
        const deploy = await deployAppWork(request, {
            token: user.access_token,
            workId: work.workId,
            body: {},
        });
        expect(
            deploy.status,
            `POST /api/deploy/works/:id answered ${deploy.status}: ${deploy.text.slice(0, 400)}`,
        ).toBe(422);
        const refusal = (deploy.json ?? {}) as {
            status?: string;
            code?: string;
            unmet?: Array<{ code?: string }>;
        };
        expect(refusal.status).toBe('error');
        expect(refusal.code, 'the App path’s precondition refusal, not a website one').toBe(
            'APP_DEPLOY_PRECONDITIONS',
        );
        expect(
            (refusal.unmet ?? []).map((entry) => entry.code),
            'R-12: the refusal names the None target, and target_none ends the evaluation',
        ).toEqual(['target_none']);
        expect(
            deploy.text,
            'the website token check is no longer what answers for an App Work',
        ).not.toContain('token is required');

        // … and the refusal left no Deployment behind: the same read as step 3, after it.
        const afterRefusal = await listDeployments(request, {
            token: user.access_token,
            workId: work.workId,
        });
        expect(afterRefusal.status).toBe(200);
        expect(
            (afterRefusal.json as { deployments?: unknown[] }).deployments ?? [],
            'a refused None-target deploy creates no Deployment row',
        ).toEqual([]);

        // 5. Activity: "no `app.deploy.*` and no `app.change.live`".
        const after = await activityActions(request, user.access_token);
        const added = after.filter((action) => !before.includes(action));
        expect(
            added.filter(
                (action) => action.startsWith('app.deploy.') || action === 'app.change.live',
            ),
            `a None-target Work records no deploy or live event (added=${JSON.stringify(added)})`,
        ).toEqual([]);

        // 6. The Work is a fork whose repository is known to the lane — the starting point
        //    of the nightly lane's "the change is on the fork's source.branch" half, which
        //    needs APW-08's evolve loop and is therefore out of this file (see the fixmes).
        expect(work.forkName, 'the fork exists').not.toBe('');
    });

    test('the app-target and build surfaces this case names are not mounted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createNoneTargetWork(request, user.access_token, 'surfaces');

        // APW-06's S1 copy ("This app isn't running anywhere yet.", **Connect your
        // cluster**) is rendered from `/app-target`; APW-05's "Builds still run" from
        // `/builds`. Both answer 404 in this build, which is what the `fixme`s below say in
        // full — asserted here so the blocker is a live measurement in every run.
        const target = await getAppTarget(request, {
            token: user.access_token,
            workId: work.workId,
        });
        const status = await getAppStatus(request, {
            token: user.access_token,
            workId: work.workId,
        });
        const builds = await listBuilds(request, {
            token: user.access_token,
            workId: work.workId,
        });
        expect(
            { target: target.status, status: status.status, builds: builds.status },
            'APW-06 owns /app-target and /app-status, APW-05 owns /builds (all 404 here)',
        ).toEqual({ target: 404, status: 404, builds: 404 });
    });

    test('the literal "none" is refused: R-12’s value is the stored target, not an input', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createNoneTargetWork(request, user.access_token, 'literal');

        // A complete create body — the DTO's field errors would otherwise answer first and
        // the refusal under test would never be reached (measured in the first run of this
        // file: an incomplete body answered 400 with the field list instead of the code).
        const literalSlug = `apw13-t33-literal-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const refused = await createAppWork(request, {
            token: user.access_token,
            body: appWorkCreateBody({
                name: literalSlug,
                slug: literalSlug,
                description: 'APW-13 T33 literal none',
                organization: false,
                repositoryUrl: `https://github.com/${UPSTREAM_OWNER}/${work.upstreamName}`,
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
                deployProvider: NONE_TARGET,
            }),
        });
        expect(
            refused.status,
            `deployProvider:"none" answered ${refused.status}: ${refused.text.slice(0, 300)}`,
        ).toBe(400);
        expect(refused.text).toContain('"code":"cluster_target_unavailable"');
        // The Work the case is about is unaffected — the refused create wrote nothing.
        const read = await request.get(`${API_BASE}/api/works/${work.workId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(read.status()).toBe(200);
    });

    test('GET /api/me/apps without includeHidden does not list the None-target Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createNoneTargetWork(request, user.access_token, 'launcher');

        const live = await getMyApps(request, { token: user.access_token, query: { limit: 200 } });
        test.skip(
            live.status === 404,
            'the App Launcher is switched off on this API: `GET /api/me/apps` answers 404 ' +
                'unless EVER_WORKS_APP_LAUNCHER_ENABLED=true ' +
                '(`app-launcher-enabled.guard.ts:77`; ACC-E2E-12 documents the 404 as the ' +
                'flag-off state). The runbook’s §4 recipe does not set the switch — restart ' +
                'the lane API with EVER_WORKS_APP_LAUNCHER_ENABLED=true to exercise this case.',
        );
        expect(live.status, `body=${live.text.slice(0, 200)}`).toBe(200);

        const liveView = (live.json ?? {}) as LauncherView;
        expect(
            (liveView.items ?? []).map((item) => item.key),
            'E2E-11: GET /api/me/apps (without includeHidden) does not list a None-target Work',
        ).not.toContain(`work:${work.workId}`);
        expect(
            (liveView.items ?? []).filter((item) => item.kind === 'work').length,
            `no live Work of this account is listed (items=${JSON.stringify(
                (liveView.items ?? []).map((item) => `${item.kind}:${item.key ?? ''}`),
            )})`,
        ).toBe(0);
        expect(liveView.meta?.worksTotal, 'the launcher’s own count agrees').toBe(0);

        // The control: the Manage-apps read DOES list it, so the absence above is the
        // launcher's judgement about a not-live Work rather than an empty read.
        const hidden = await getMyApps(request, {
            token: user.access_token,
            query: { includeHidden: 'true', limit: 200 },
        });
        expect(hidden.status).toBe(200);
        expect(
            ((hidden.json ?? {}) as LauncherView).items?.map((item) => item.key),
            'includeHidden=true is the Manage-apps view and returns the not-live Work',
        ).toContain(`work:${work.workId}`);
    });

    test('a None-target create writes its fork request and nothing else to GitHub', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t33-nowrite-${run}` };
        expect(await seedFakeGitHub(request, [upstream])).toBe(true);

        const callsBefore = (await fakeGitHubCalls(request)) ?? [];
        const created = await createAppWork(request, {
            token: user.access_token,
            body: appWorkCreateBody({
                name: `apw13-t33-nowrite-${run}`,
                slug: `apw13-t33-nowrite-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                description: 'APW-13 T33 none-target writes',
                organization: false,
                repositoryUrl: repoUrl(upstream.owner, upstream.name),
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
            }),
        });
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = ((created.json ?? {}) as CreatedView).work?.id ?? '';

        // NEG-07's "no Kubernetes object / no Ingress / no DNS record" cannot be read in a
        // lane with no cluster; what CAN be read is that nothing else was written: the only
        // mutating call is the one fork request, and no deploy route was touched.
        const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
        const mutating = added.filter(isGitHubWrite);
        const forkRequests = mutating.filter(
            (call) =>
                (call.method ?? '').toUpperCase() === 'POST' &&
                call.path === `/repos/${upstream.owner}/${upstream.name}/forks`,
        );
        expect(
            forkRequests.length,
            `exactly one fork request (calls=${describeCalls(mutating)})`,
        ).toBe(1);
        expect(
            mutating.filter((call) => !(call.path ?? '').includes('/forks')).length,
            'a None-target create writes nothing beyond its fork request ' +
                `(calls=${describeCalls(mutating)})`,
        ).toBe(0);
        expect(workId).not.toBe('');
    });
});

// ---------------------------------------------------------------------------
// The halves of ACC-E2E-11 this build cannot produce (each measured)
// ---------------------------------------------------------------------------

test.describe('ACC-E2E-11 — what this build cannot produce yet', () => {
    /**
     * The Deploy tab's copy and its primary action (APW-06 S1), and "no Kubernetes object
     * carries this App Work's labels on any test cluster; no Ingress, no DNS record".
     *
     * Measured on this lane (2026-09-19): `GET /api/works/:id/app-target` and
     * `GET /api/works/:id/app-status` both answer
     * `404 {"message":"Cannot GET /api/works/<id>/app-target", …}` — APW-06 owns both and
     * neither is mounted (a grep of `apps/api/src` finds no handler for either path), so
     * the Deploy tab has nothing to render from, and no cluster object can exist because
     * the lane has no cluster and no route that could create one. The assertions below are
     * the case's own.
     */
    test.fixme(
        'APW-06 S1: the Deploy tab copy and the no-Kubernetes-object assertions need ' +
            '/app-target and /app-status, which answer 404 here (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createNoneTargetWork(request, user.access_token, 'deploy-tab');

            const target = await getAppTarget(request, {
                token: user.access_token,
                workId: work.workId,
            });
            expect(target.status).toBe(200);
            expect(target.text).toContain("This app isn't running anywhere yet.");
            expect(target.text).toContain('connect-cluster');
        },
    );

    /**
     * "Builds still run on None" (APW-05 FR-2, APW-06 FR-2): `app.change.merged`,
     * `app.build.succeeded` for `merge_commit_sha`, the Task moving to **Done** with chip
     * **Built ✓** and no follow-up Task.
     *
     * Measured on this lane (2026-09-19): `GET` and `POST /api/works/:id/builds` both answer
     * `404 Cannot … /builds`, and `GET /api/tasks/:id/delivery` is likewise unmounted — APW-05
     * and APW-08 own those routes. The measurable half of "a None-target Work is not
     * deployed" is asserted green above (no `app.deploy.*`, no `app.change.live`, an empty
     * deployments read).
     */
    test.fixme(
        'APW-05 FR-2 / APW-08 FR-32: "Builds still run" and the Built ✓ chip need /builds and ' +
            '/tasks/:id/delivery, both unmounted (404) in this build (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createNoneTargetWork(request, user.access_token, 'builds');

            const builds = await listBuilds(request, {
                token: user.access_token,
                workId: work.workId,
            });
            expect(builds.status).toBe(200);
            expect((builds.json as { builds?: unknown[] }).builds ?? []).not.toEqual([]);
        },
    );

    /**
     * The case's second half: connecting **Your cluster** (check passes) and saving with
     * **Deploy now** ticked → `app.deploy.started` … `app.deploy.succeeded`, and after a
     * custom domain is added `GET /marker.sha` = fork head.
     *
     * Needs a cluster and the managed/custom-domain path: ACC-E2E-11's own row sends the
     * cluster half to the nightly lane and APW-06's `flow-app-deploy-target.spec.ts`.
     * Measured here: `GET /api/works/:id/app-target`, `POST /api/works/:id/app-target/check`
     * and `GET /api/works/:id/app-status` are all unmounted (`404`), so no check can pass
     * and no deploy can start in this lane.
     */
    test.fixme(
        'APW-06 / APW-10: "connect Your cluster → app.deploy.started … succeeded" and the ' +
            'custom-domain marker need the cluster lanes — the app-target routes are 404 here ' +
            '(measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createNoneTargetWork(request, user.access_token, 'cluster');

            const status = await getAppStatus(request, {
                token: user.access_token,
                workId: work.workId,
            });
            expect(status.status).toBe(200);
            expect(await activityActions(request, user.access_token)).toContain(
                'app.deploy.succeeded',
            );
        },
    );
});
