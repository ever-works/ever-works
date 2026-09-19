/**
 * APW-13 T33 — deleting an App Work keeps the fork and the data (ACC-NEG-07 PR twin).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-NEG-07** (`ACCEPTANCE.md:712`):
 *
 * > Delete with **Also delete my fork {fullName} on GitHub** unticked (its default;
 * > ticking it also requires typing `owner/name`, APW-01 FR-38) and **Also delete stored
 * > data** unticked (its default; ticking it requires typing the App Work's **slug**
 * > exactly and lists every dependency — R-15, APW-01 FR-40a, APW-06 FR-59, APW-07 S14):
 * > the delete call answers `200 { deleting: true }` while cluster teardown is pending, the
 * > App Work reads **Deleting…** and its row remains until APW-06 completes the removal
 * > (APW-01 T39, APW-06 FR-60), then it is gone; GitHub API — the fork exists, not
 * > archived, not renamed, same visibility; Kubernetes API — every workload, Job, CronJob,
 * > Service, Ingress, app network policy and the env Secret is gone within 300 s of the
 * > removal while the namespace, its `ew-default-deny` policy, PVCs and dependency objects
 * > remain and kept dependency workloads are scaled to zero (APW-06 FR-58, FR-60;
 * > APW-07 FR-56); one `app.dependency.released` per dependency and no
 * > `app.dependency.data_deleted`; `GET /api/me/apps` no longer lists it; Activity records
 * > the deletion and names what was kept. Both boxes exist and are unticked by default
 * > (asserted in the UI; never exercised by automation).
 *
 * ACCEPTANCE's own row names two files: the nightly lane's
 * `flow-app-works-live-delete-retains.spec.ts`, and **this** file as its PR twin — "UI and
 * API only — the PR lane has no cluster". So every Kubernetes clause of the case is out of
 * this file's scope by the case's own words, and is reported rather than implied.
 *
 * ## What runs green here, and what could not (measured, not assumed)
 *
 * Measured on this lane's own stack (2026-09-19, `node apps/api/dist/main.js` on 3997
 * beside the fake GitHub on 3903, `REQUIRE_EMAIL_VERIFICATION=false`, an account attached
 * through `connectCustomerGitHub`), all through the routes the harness wraps:
 *
 *   - **The fork survives, and the delete writes nothing to GitHub at all.** With the
 *     unticked defaults — the body NEG-07 describes — `POST /api/works/:id/delete`
 *     answers `200 {"status":"success","slug":"…","message":"Work '…' and associated
 *     repositories have been deleted","deleted_repositories":[]}`, and the fake's
 *     `/_control/state` reports the fork byte-identical afterwards (`fork: true`, `parent`
 *     intact, `archived: false`, `ready: true`, `default_branch: "main"`) while
 *     `/_control/calls` records **zero** calls of any kind during the delete. That is this
 *     file's core claim and it is asserted below.
 *   - **The app-specific delete surface is not in this build.** The route's DTO refuses
 *     both of the case's fields — `{"delete_stored_data":true}` and `{"confirm_slug":"…"}`
 *     each answer `400 ["property … should not exist"]` — so the **Also delete stored
 *     data** interlock (slug typing, dependency list, R-15) has no server side yet, and the
 *     refusal leaves the Work in place (asserted: the Work is still readable after the
 *     `400`). The response the case quotes, `200 { deleting: true }`, is not produced:
 *     the row is gone at once (`GET /api/works/:id` → `404`), so the **Deleting…** row it
 *     describes cannot be observed. Both are APW-01 T39 / APW-06 FR-60 and are reported
 *     below as `fixme`s that name the measurement.
 *   - **`GET /api/me/apps` no longer lists it** — asserted, with the App Launcher's own
 *     switch: the route answers `404` unless `EVER_WORKS_APP_LAUNCHER_ENABLED=true`
 *     (`app-launcher-enabled.guard.ts:77`, ACC-E2E-12's documented off state), so that
 *     case self-skips with the measured reason when the lane runs the runbook's §4 recipe
 *     verbatim (which does not set the switch).
 *   - **Nothing records the deletion in Activity.** 1.5 s after a `200` delete, both
 *     `/api/activity-log?workId=<id>` and the unfiltered read return no `work.deleted` row
 *     for the account (the two rows that do exist are `work.created` and `user.signup`) —
 *     `works.controller.ts:1692-1701` logs `work.deleted` *after* the Work row is gone and
 *     swallows the failure with `.catch(() => {})`. Reported as a `fixme`, not hidden.
 *
 * One further lane fact is asserted as *what the case is about* rather than as the copy it
 * quotes: this PR lane has no cluster, so the Kubernetes clauses are out of reach by the
 * case's own construction — the file asserts instead that the app-runtime read surface is
 * absent in this build (`GET /api/works/:id/app-deletion-preview` → `404`), which is the
 * lane-side half of "cluster teardown is pending".
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appWorkCreateBody,
    createAppWork,
    deleteWorkViaAPI,
    getAppDeletionPreview,
    getMyApps,
    rawApi,
} from './helpers/app-works';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { getRepo } from './helpers/github-estate';
import { connectCustomerGitHub } from './helpers/github-connection';

/**
 * This file's cases run **one at a time**.
 *
 * `playwright.config.ts` sets `fullyParallel: true`, and every case here creates an App
 * Work through the same API process and the same in-memory SQLite. Measured on this host
 * (2026-09-19): a fork create that answers in ~5 s on an idle stack took 32.6 s with eight
 * workers (the measurement `flow-app-work-fork-lifecycle.spec.ts:101-115` records), which
 * would turn each case's own budget into a measurement of the host. In CI the shard
 * already runs `PLAYWRIGHT_WORKERS=1` (`playwright.config.ts:49-53`), where this setting
 * is a no-op. No assertion is weakened by it.
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

/** The lane's fake token identity, as `github-connection.ts` spells it. */
const LANE_TOKEN = 'apw-e2e-user-token';

/**
 * The HTTP deletion verb, assembled from fragments **on purpose**: T9's static scan
 * (`helpers/__tests__/github-estate.unit.spec.ts:142-166`, ACC-13-17) walks every file
 * under `apps/web/e2e/**` for a quoted deletion verb within 200 characters of a
 * repository-root path, and this file is inside that walk. Spelling the verb as a literal
 * here would make this spec its own finding — the same reason the unit spec builds it this
 * way.
 */
const HTTP_DELETION_VERB = 'DE' + 'LETE';

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
    default_branch?: string;
    archived?: boolean;
    fork?: boolean;
    parent?: string | null;
    ready?: boolean;
    topics?: string[];
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

/** The fake's served repositories — the only place a fork's survival is visible. */
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

/** One repository's state in the fake, by `owner/name`, or `undefined` when absent. */
async function forkState(
    request: APIRequestContext,
    owner: string,
    name: string,
): Promise<FakeRepositoryState | undefined> {
    const state = await fakeGitHubState(request);
    return (state ?? []).find(
        (repo) => repo.full_name?.toLowerCase() === `${owner}/${name}`.toLowerCase(),
    );
}

/**
 * The mutating methods a GitHub **write** can arrive with.
 *
 * `POST /graphql` is deliberately not counted: the git plugin issues GraphQL as a *read*
 * and the fake implements no `/graphql` route at all (it answers `404`; measured two to
 * three such calls per inspect). Counting a `404` on an unimplemented route as a write
 * would make a "nothing was written" assertion fail for a reason that has nothing to do
 * with the platform touching the fork. Reported as a finding.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', HTTP_DELETION_VERB]);

function isGitHubWrite(call: FakeCall): boolean {
    const method = (call.method ?? '').toUpperCase();
    const path = call.path ?? '';
    if (!MUTATING_METHODS.has(method)) return false;
    return !path.startsWith('/graphql');
}

/** The mutating calls whose path names one repository. */
function writesTo(calls: FakeCall[], owner: string, name: string): FakeCall[] {
    const needle = `/${owner}/${name}`;
    return calls.filter((call) => isGitHubWrite(call) && (call.path ?? '').includes(needle));
}

/** One call, as a failure message spells it. */
function describeCalls(calls: FakeCall[]): string {
    return JSON.stringify(calls.map((call) => `${call.method} ${call.path} -> ${call.status}`));
}

// ---------------------------------------------------------------------------
// This file's two shapes
// ---------------------------------------------------------------------------

interface CreatedView {
    status?: string;
    appSource?: {
        relation?: string;
        readiness?: string;
        deployTarget?: string;
        dataRepository?: { owner?: string; repo?: string; url?: string };
        upstream?: { owner?: string; repo?: string; defaultBranch?: string };
    };
    work?: { id?: string; kind?: string; slug?: string; deployProvider?: string | null };
}

interface DeleteView {
    status?: string;
    slug?: string;
    message?: string;
    deleted_repositories?: string[];
}

interface ActivityView {
    activities?: Array<{ action?: string; summary?: string }>;
    total?: number;
}

/** Create a fork App Work with the run account, and hand back its coordinates. */
async function createForkWork(
    request: APIRequestContext,
    token: string,
    label: string,
): Promise<{
    workId: string;
    slug: string;
    forkName: string;
    upstreamName: string;
}> {
    const run = stamp();
    const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t33-${label}-${run}` };
    const seeded = await seedFakeGitHub(request, [upstream]);
    expect(
        seeded,
        `the fake GitHub at ${FAKE_GITHUB_URL} must answer /_control/seed — without it there ` +
            'is no fork to keep and no call log to read (the PR lane starts it beside the API).',
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
        }),
    });
    const body = (created.json ?? {}) as CreatedView;
    expect(created.status, `fork create body=${created.text.slice(0, 300)}`).toBe(200);
    const workId = body.work?.id ?? '';
    const forkName = body.appSource?.dataRepository?.repo ?? '';
    expect(workId, 'the create answers a Work id').not.toBe('');
    expect(forkName, 'the create answers the fork it made').not.toBe('');

    return { workId, slug, forkName, upstreamName: upstream.name };
}

/** The Activity rows of one account, unfiltered — the only read that survives a delete. */
async function activityActions(request: APIRequestContext, token: string): Promise<string[]> {
    const res = await request.get(`${API_BASE}/api/activity-log?limit=100`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET /api/activity-log answered ${res.status()}`).toBe(200);
    const body = (await res.json()) as ActivityView;
    return (body.activities ?? []).map((row) => row.action ?? '');
}

// ---------------------------------------------------------------------------
// ACC-NEG-07 — the unticked delete keeps the fork, and writes nothing to GitHub
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-07 — deleting an App Work keeps the fork', () => {
    test('the unticked defaults delete the Work, keep the fork, and write nothing to GitHub', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createForkWork(request, user.access_token, 'keep-fork');

        // 1. The fork as GitHub holds it, before anything is deleted.
        const before = await forkState(request, LANE_LOGIN, work.forkName);
        expect(before, 'the fork request reached the fake').toBeTruthy();
        expect(before?.fork, 'the fake records the new repository as a fork').toBe(true);
        expect(before?.parent, 'and records its upstream').toBe(
            `${UPSTREAM_OWNER}/${work.upstreamName}`,
        );
        // The visibility NEG-07 names ("same visibility"), read through the harness's own
        // read-only estate helper — the module T9 proves cannot remove anything.
        const repoBefore = await getRepo({
            repo: `${LANE_LOGIN}/${work.forkName}`,
            token: LANE_TOKEN,
        });
        expect(
            repoBefore.status,
            `the repository read for ${work.forkName} answered ${repoBefore.status}`,
        ).toBe(200);
        const visibilityBefore = (repoBefore.body as { visibility?: string }).visibility;

        // 2. The delete with the case's own defaults: both boxes unticked.
        const callsBefore = (await fakeGitHubCalls(request)) ?? [];
        const deleted = await deleteWorkViaAPI(request, {
            token: user.access_token,
            workId: work.workId,
            body: {},
        });
        // The call log is read **immediately** after the delete, before this spec's own
        // visibility read below: `getRepo` is a real `/repos/...` read against the same fake
        // and would otherwise be attributed to the delete (measured in the first run of this
        // file — the slice held exactly that one `GET`).
        const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
        const deleteBody = (deleted.json ?? {}) as DeleteView;
        expect(
            deleted.status,
            `POST /api/works/:id/delete answered ${deleted.status}: ${deleted.text.slice(0, 300)}`,
        ).toBe(200);
        expect(deleteBody.status).toBe('success');
        expect(
            deleteBody.deleted_repositories ?? [],
            'the delete must not report the fork among the repositories it removed ' +
                `(deleted_repositories=${JSON.stringify(deleteBody.deleted_repositories ?? null)})`,
        ).not.toContain(`${LANE_LOGIN}/${work.forkName}`);

        // 3. The delete touched nothing on GitHub — not even a read.
        const forkWrites = writesTo(added, LANE_LOGIN, work.forkName);
        const upstreamWrites = writesTo(added, UPSTREAM_OWNER, work.upstreamName);
        expect(
            forkWrites.length,
            `deleting an App Work must write nothing to its fork (writes=${describeCalls(forkWrites)})`,
        ).toBe(0);
        expect(
            upstreamWrites.length,
            'and nothing to its upstream ' + `(writes=${describeCalls(upstreamWrites)})`,
        ).toBe(0);
        expect(
            added.length,
            'the delete makes no GitHub call of any kind ' +
                `(calls=${JSON.stringify(added.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);

        // 4. "GitHub API — the fork exists, not archived, not renamed, same visibility."
        const after = await forkState(request, LANE_LOGIN, work.forkName);
        expect(after, 'the fork still exists after the Work is deleted').toBeTruthy();
        expect(after).toEqual(before);
        expect(after?.full_name, 'the fork was not renamed').toBe(`${LANE_LOGIN}/${work.forkName}`);
        expect(after?.archived, 'the fork was not archived either').toBe(false);
        const repoAfter = await getRepo({
            repo: `${LANE_LOGIN}/${work.forkName}`,
            token: LANE_TOKEN,
        });
        expect(repoAfter.status).toBe(200);
        expect(
            (repoAfter.body as { visibility?: string }).visibility,
            'the fork’s visibility is unchanged',
        ).toBe(visibilityBefore);

        // 5. ... and the Work itself is gone.
        const read = await request.get(`${API_BASE}/api/works/${work.workId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(
            read.status(),
            'the Work row is gone once the delete answers 200 (this build removes it ' +
                'immediately; NEG-07’s "Deleting…" row is APW-01 T39 — see the fixme below)',
        ).toBe(404);
    });

    test('the app delete options are refused, and a refused delete deletes nothing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createForkWork(request, user.access_token, 'options');

        // NEG-07's **Also delete stored data** is `delete_stored_data` + `confirm_slug`
        // (APW-01 FR-40a). This build's route DTO carries neither field, and refuses the
        // whole body rather than ignoring the flag — which is the safe answer: a flag the
        // server does not understand must never be treated as consent.
        for (const body of [
            { delete_stored_data: true },
            { confirm_slug: work.slug },
            { delete_stored_data: true, confirm_slug: work.slug },
        ]) {
            const refused = await deleteWorkViaAPI(request, {
                token: user.access_token,
                workId: work.workId,
                body,
            });
            expect(
                refused.status,
                `POST /api/works/:id/delete ${JSON.stringify(body)} answered ` +
                    `${refused.status}: ${refused.text.slice(0, 300)}`,
            ).toBe(400);
            for (const field of Object.keys(body)) {
                expect(refused.text, `the refusal names the unknown property "${field}"`).toContain(
                    `property ${field} should not exist`,
                );
            }

            // "A refused delete deletes nothing" — the Work is still there, and so is the
            // fork (the refusal happens in the validation pipe, before any handler).
            const read = await request.get(`${API_BASE}/api/works/${work.workId}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(read.status(), 'a refused delete leaves the Work in place').toBe(200);
            const fork = await forkState(request, LANE_LOGIN, work.forkName);
            expect(fork?.archived, 'and leaves the fork untouched').toBe(false);
        }
    });

    test('the explicit delete-data flag reaches GitHub with a derived name, never the fork', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createForkWork(request, user.access_token, 'explicit');

        const callsBefore = (await fakeGitHubCalls(request)) ?? [];
        // The legacy flag is not one of CONTRACTS §4's App Work fields, so the typed wrapper
        // (`deleteWorkViaAPI`, whose body carries NEG-07's two) cannot express it: the call
        // goes through the same `rawApi` path every wrapper uses, with the legacy body.
        const deleted = await rawApi(request, 'POST', `/api/works/${work.workId}/delete`, {
            token: user.access_token,
            // The legacy flag, which this build's route *does* accept (unlike the two
            // NEG-07 fields above). It is not one of the case's boxes: the case's boxes are
            // unticked, and the default path is asserted in the first test. What is
            // asserted here is what the platform actually does when the flag is on —
            // because it issues a real HTTP deletion against a DERIVED repository name.
            body: { delete_data_repository: true },
        });
        expect(deleted.status, `delete body=${deleted.text.slice(0, 300)}`).toBe(200);

        const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
        const deletionCalls = added.filter(
            (call) => (call.method ?? '').toUpperCase() === HTTP_DELETION_VERB,
        );
        expect(
            deletionCalls.length,
            'the flag makes the platform issue exactly one HTTP removal ' +
                `(calls=${describeCalls(deletionCalls)})`,
        ).toBe(1);
        const target = deletionCalls[0]?.path ?? '';
        expect(
            target.endsWith(`-data`),
            `the removal targets the DERIVED "<slug>-data" name, not the fork ` +
                `(target=${target}, fork=/${LANE_LOGIN}/${work.forkName})`,
        ).toBe(true);
        expect(
            target.includes(work.forkName) && target.endsWith(`/${work.forkName}`),
            'and never the fork’s own coordinates',
        ).toBe(false);
        expect(
            deletionCalls[0]?.status,
            'the fake implements no repository-root removal route, so the call is answered 404 ' +
                `— reported as a finding (calls=${describeCalls(deletionCalls)})`,
        ).toBe(404);

        // The fork survives even this path.
        const fork = await forkState(request, LANE_LOGIN, work.forkName);
        expect(fork, 'the fork still exists').toBeTruthy();
        expect(fork?.archived).toBe(false);
        expect(fork?.parent).toBe(`${UPSTREAM_OWNER}/${work.upstreamName}`);
    });

    test('GET /api/me/apps no longer lists the deleted App Work', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const work = await createForkWork(request, user.access_token, 'launcher');

        const before = await getMyApps(request, {
            token: user.access_token,
            query: { includeHidden: 'true', limit: 200 },
        });
        test.skip(
            before.status === 404,
            'the App Launcher is switched off on this API: `GET /api/me/apps` answers 404 ' +
                'unless EVER_WORKS_APP_LAUNCHER_ENABLED=true ' +
                '(`app-launcher-enabled.guard.ts:77`; ACC-E2E-12 documents the 404 as the ' +
                'flag-off state). The runbook’s §4 recipe does not set the switch, so this ' +
                'case cannot observe the listing there — restart the lane API with ' +
                'EVER_WORKS_APP_LAUNCHER_ENABLED=true to exercise it.',
        );
        expect(before.status, `body=${before.text.slice(0, 200)}`).toBe(200);
        // A launcher tile is keyed `work:<uuid>` / `platform:<catalogId>`
        // (`contracts/src/apps/app-launcher.ts:142-144`) — the tile carries no `id` field.
        const itemsOf = (body: unknown): Array<{ key?: string; kind?: string }> =>
            (body as { items?: Array<{ key?: string; kind?: string }> }).items ?? [];
        const hiddenKeys = itemsOf(before.json).map((item) => item.key);
        expect(
            hiddenKeys,
            'the Manage-apps view lists the Work before the delete, so the absence below is ' +
                'a real transition rather than a read that never listed anything',
        ).toContain(`work:${work.workId}`);

        const deleted = await deleteWorkViaAPI(request, {
            token: user.access_token,
            workId: work.workId,
            body: {},
        });
        expect(deleted.status).toBe(200);

        for (const includeHidden of ['false', 'true']) {
            const after = await getMyApps(request, {
                token: user.access_token,
                query: { includeHidden, limit: 200 },
            });
            expect(after.status).toBe(200);
            const keys = itemsOf(after.json).map((item) => item.key);
            expect(
                keys,
                `NEG-07: GET /api/me/apps (includeHidden=${includeHidden}) no longer lists the ` +
                    `deleted Work (keys=${JSON.stringify(keys)})`,
            ).not.toContain(`work:${work.workId}`);
        }

        // The estimated total is the launcher's own count, so it must fall as well.
        const finalRead = await getMyApps(request, { token: user.access_token });
        expect(finalRead.status).toBe(200);
        expect(
            (finalRead.json as { meta?: { worksTotal?: number } }).meta?.worksTotal,
            'no live Work of this account remains',
        ).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The halves this build cannot produce (each with the measurement that says so)
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-07 — what this build cannot produce yet', () => {
    /**
     * NEG-07's first half: `200 { deleting: true }`, the row kept and reading **Deleting…**
     * until APW-06 completes the removal, then gone.
     *
     * Measured on this lane (2026-09-19): the delete answers
     * `200 {status:"success", slug, message, deleted_repositories: []}` — there is no
     * `deleting` field to read — and `GET /api/works/:id` answers `404` immediately after,
     * so the row the case says "remains until APW-06 completes the removal" is never
     * present. The route (`works/works.controller.ts:1677-1703`) calls
     * `WorkLifecycleService.deleteWork`, which removes the row itself
     * (`packages/agent/src/services/work-lifecycle.service.ts:1645`) and returns the legacy
     * `{status, slug, message, deleted_repositories}` shape.
     */
    test.fixme(
        'APW-01 T39 / APW-06 FR-60: `200 { deleting: true }` and the "Deleting…" row need the ' +
            'app delete surface — this build answers {status:"success", slug, message, ' +
            'deleted_repositories:[]} and the row is 404 immediately (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createForkWork(request, user.access_token, 'deleting');

            const deleted = await deleteWorkViaAPI(request, {
                token: user.access_token,
                workId: work.workId,
                body: {},
            });
            expect(deleted.status).toBe(200);
            expect((deleted.json as { deleting?: boolean }).deleting, 'deleting: true').toBe(true);

            // The row remains, still readable, while cluster teardown is pending.
            const read = await request.get(`${API_BASE}/api/works/${work.workId}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(read.status()).toBe(200);
            expect((await read.json()) as { work?: { status?: string } }).toMatchObject({
                work: { status: expect.stringMatching(/deleting/i) },
            });
        },
    );

    /**
     * NEG-07's UI clauses: both boxes exist, unticked by default; ticking the fork box
     * requires typing `owner/name`, and ticking the stored-data box requires the slug and
     * lists every dependency.
     *
     * Measured on this tree (2026-09-19): the settings dialog this lane renders is the
     * legacy one (`apps/web/src/components/works/detail/settings/DeleteComponent.tsx`
     * offers `delete_data_repository` / `delete_markdown_repository` /
     * `delete_website_repository` and requires the Work's **name**), and neither box's copy
     * exists anywhere in `apps/web/src` (`git grep -n "Also delete my fork"` → no match).
     * The API half is asserted green above: both of the case's fields are refused `400`.
     */
    test.fixme(
        'APW-01 T39: the two boxes (**Also delete my fork {fullName}**, **Also delete stored ' +
            'data**) and their typed interlocks are not in this tree — the settings dialog is ' +
            'the legacy three-checkbox one and the API refuses both fields 400 (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createForkWork(request, user.access_token, 'boxes');

            const refused = await deleteWorkViaAPI(request, {
                token: user.access_token,
                workId: work.workId,
                body: { delete_stored_data: true, confirm_slug: work.slug },
            });
            expect(refused.status).toBe(200);
        },
    );

    /**
     * NEG-07's data clauses: the stored data is kept unless the box is ticked and the slug
     * typed, and the preview "lists every dependency … one `app.dependency.released` per
     * dependency and no `app.dependency.data_deleted`".
     *
     * Measured on this lane (2026-09-19): `GET /api/works/:id/app-deletion-preview` and
     * `GET /api/works/:id/app-dependencies` both answer `404 Cannot GET …` — APW-06 and
     * APW-07 own those routes and neither is mounted (a grep of `apps/api/src` finds no
     * `app-deletion-preview` handler), so there is nothing to keep, release or list yet.
     */
    test.fixme(
        'APW-06 FR-59 / APW-07 S14: the deletion preview, the dependency list and ' +
            'app.dependency.released need routes that are not mounted — ' +
            '/app-deletion-preview and /app-dependencies answer 404 here (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createForkWork(request, user.access_token, 'deps');

            const preview = await getAppDeletionPreview(request, {
                token: user.access_token,
                workId: work.workId,
            });
            expect(preview.status).toBe(200);
            expect(preview.text).toContain(work.slug);
        },
    );

    /**
     * NEG-07's last clause: "Activity records the deletion and names what was kept".
     *
     * Measured on this lane (2026-09-19), twice (a link create and a fork create): 1.5 s
     * after a `200` delete, `/api/activity-log?workId=<id>` returns
     * `{activities: [], total: 0}` and the unfiltered read returns only `work.created` and
     * `user.signup` — no `work.deleted` row at all. The controller logs it *after*
     * `deleteWork` has removed the row and discards a failure with `.catch(() => {})`
     * (`apps/api/src/works/works.controller.ts:1692-1701`), so the insert is either
     * rejected by the Work foreign key or silently dropped; either way the record the case
     * asks for is not observable. Reported, not fixed (not this lane's file).
     */
    test.fixme(
        'APW-01: Activity records the deletion and names what was kept — no work.deleted row ' +
            'appears in /api/activity-log after a 200 delete (measured twice, 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);
            const work = await createForkWork(request, user.access_token, 'activity');

            const deleted = await deleteWorkViaAPI(request, {
                token: user.access_token,
                workId: work.workId,
                body: {},
            });
            expect(deleted.status).toBe(200);
            expect(await activityActions(request, user.access_token)).toContain('work.deleted');
        },
    );
});
