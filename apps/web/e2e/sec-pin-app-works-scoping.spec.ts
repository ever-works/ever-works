/**
 * APW-13 T32 — SEC PIN: another account's App Work is not there (ACC-NEG-13, and
 * the App Works half of ACC-NEG-22).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-NEG-13 — Another account's App Work** (`ACCEPTANCE.md:718`):
 *
 * > Every App Works route that takes a Work id (CONTRACTS §4) called with another
 * > user's Work id → `404`, never `403`. For `PUT /api/me/apps/preferences`, a
 * > `work:<id>` key for another user's Work is rejected per item with the same
 * > reason as a nonexistent Work and changes nothing (APW-11 FR-28); APW-01's
 * > create and inspect conflicts name only the repository, never another account's
 * > Work (APW-01 FR-51).
 *
 * **ACC-NEG-22 — Another account's App Work is not there** (`ACCEPTANCE.md:727`),
 * which extends it:
 *
 * > Every `GET` an App Works controller owns — the runtime status and app-status
 * > routes, the Task delivery and cost routes, `GET /api/works/:id/apps-tier`, and
 * > the launcher's per-Work reads — answers **`404`** for another account's App Work
 * > through `ensureCanViewOr404`, never `403` and never the Work's name; the same
 * > route answers `403` for a member who lacks the required role (Resolution R-36).
 *
 * ## What this file proves today, and — loudly — what it does not
 *
 * Three of the case's clauses are **measurable on this branch**, and are pinned
 * green below:
 *
 *   1. **The APW-02 upstream routes already obey the rule.** `GET
 *      /api/works/:id/upstream` and `POST /api/works/:id/upstream/sync` answer `404
 *      {"code":"not_found","message":"No such App Work."}` for another account's
 *      Work — the same answer a nonexistent id gets, with no name in the body.
 *   2. **The launcher's arrangement save obeys the rule** (`PUT
 *      /api/me/apps/preferences`, APW-11 FR-28): a `work:<id>` key for another
 *      account's Work is rejected per item with `unknownItem` — *the same reason a
 *      nonexistent Work gets* — and the save changes nothing.
 *   3. **APW-01's conflicts obey the rule**: another account's inspect of an in-use
 *      repository reports `in_use_by_another_account`, and the create refusal names
 *      only the repository (`details.fullName`), never the first Work's id or name.
 *
 * One clause is **violated today**, and this file pins the violation rather than
 * hiding it — see the second describe block:
 *
 *   - `GET /api/works/:id` and `POST /api/deploy/works/:id` answer **`403`** for
 *     another account's real Work id and **`404`** for a nonexistent id. The two
 *     answers differ, so the status is an **existence oracle** on other accounts'
 *     Work ids — exactly what "→ `404`, never `403`" exists to prevent. Reported as
 *     a finding with its `path:line`; not fixed here.
 *
 * And one clause **cannot be reached at all** yet: "every App Works route that
 * takes a Work id" is a *sweep*, and eleven of the routes CONTRACTS §4 lists are
 * unmounted (each answers the platform's opaque `404` for owner, stranger and
 * anonymous caller alike — which is a 404, but for the wrong reason, so it is not
 * evidence of the ownership rule). That sweep is the `test.fixme('APW-06 + APW-11')`
 * body below, and its route list is derived from the harness's own
 * `CONTRACTS_S4_ROUTES` table rather than hand-copied.
 *
 * ## Measured on this lane (2026-09-19)
 *
 * API `node apps/api/dist/main.js` on **3998** (sqlite in memory, the runbook's
 * env; a second run additionally set `EVER_WORKS_APP_LAUNCHER_ENABLED=true`, which
 * is what mounts the launcher routes — the runbook's recipe leaves it unset), fake
 * GitHub on **3902**. Two accounts, both attached to the fake's single
 * `apw-e2e-user` identity, so every difference below is **Ever Works** account
 * scoping and not a GitHub identity:
 *
 *   | route (another account, real id)            | real id | random id | owner |
 *   |---------------------------------------------|---------|-----------|-------|
 *   | `GET /api/works/:id`                        | **403** | 404       | 200   |
 *   | `POST /api/deploy/works/:id`                | **403** | 404       | 422   |
 *   | `GET /api/works/:id/upstream`               | 404     | 404       | 200   |
 *   | `POST /api/works/:id/upstream/sync`         | 404     | 404       | 409   |
 *   | `GET /api/works/:id/app-env` (unmounted)    | 404     | 404       | 404   |
 *   | `PUT /api/me/apps/preferences` (launcher on)| 200 `unknownItem` for both keys | | `saved:1`, `rejected:[]` |
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    CONTRACTS_S4_ROUTES,
    createAppWork,
    getMyApps,
    getUpstream,
    inspectAppSource,
    putMyAppsPreferences,
    rawApi,
    syncUpstream,
} from './helpers/app-works';
import { registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/** Serial for the reason T30's spec documents — see the licence-gate pin's header. */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where "no write" is readable. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives the run account. */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot push to — so every create here is a fork. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/**
 * A syntactically valid v4 id that belongs to nobody. It is the **control** for
 * every "another account" assertion: it proves the refusal under test is about
 * ownership rather than about an id the API rejects outright.
 */
const NOBODY_UUID = '3f1d2c4b-5a69-4e7d-9b8c-0a1b2c3d4e5f';

/** The two refusal shapes this file tells apart. */
const NOT_FOUND_APP_WORK = { status: 'error', code: 'not_found', message: 'No such App Work.' };

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
}

interface FakeCall {
    method?: string;
    path?: string;
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

function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

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

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The mutating calls against one repository. */
function writesMatching(calls: FakeCall[], needle: string): FakeCall[] {
    return calls.filter(
        (call) =>
            MUTATING_METHODS.has((call.method ?? '').toUpperCase()) &&
            !(call.path ?? '').startsWith('/graphql') &&
            (call.path ?? '').includes(needle),
    );
}

interface CreatedView {
    work?: { id?: string; name?: string; slug?: string; kind?: string };
    appSource?: { relation?: string };
}

/** Create a forked App Work for `user` and hand back the answer. */
async function createFork(
    request: APIRequestContext,
    user: RegisteredUser,
    repo: { owner: string; name: string },
    slugBase: string,
): Promise<{ status: number; body: CreatedView; text: string }> {
    const slug = `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const result = await createAppWork(request, {
        token: user.access_token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T32 NEG-13 ${slugBase}`,
            organization: false,
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
        }),
    });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

// ---------------------------------------------------------------------------
// The rules that hold today
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-13 — the APW-02 upstream routes already answer 404, never 403', () => {
    test("another account's Work is `not_found` on both upstream routes, and a nonexistent id gets the identical answer", async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-scope-upstream-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to scope in this run.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const other = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, other.access_token);

        const created = await createFork(request, owner, repo, 'apw13-t32-scope-upstream');
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';
        expect(workId).toBeTruthy();

        // The owner's own answers: the control that proves each route resolves a Work
        // at all, so the stranger's 404 is about ownership and not about the path.
        const mineRead = await getUpstream(request, { token: owner.access_token, workId });
        expect(mineRead.status, `owner read body=${mineRead.text.slice(0, 200)}`).toBe(200);
        expect((mineRead.json as { workId?: string } | null)?.workId).toBe(workId);
        const mineSync = await syncUpstream(request, { token: owner.access_token, workId });
        expect(
            mineSync.status,
            `the owner's sync reaches the route's own precondition (409 not_ready) rather than a ` +
                `refusal — body=${mineSync.text.slice(0, 200)}`,
        ).toBe(409);

        // The stranger: 404 on both, with the same body a nonexistent id gets.
        const theirRead = await getUpstream(request, { token: other.access_token, workId });
        expect(
            theirRead.status,
            `another account's read body=${theirRead.text.slice(0, 200)} — ACC-NEG-13: 404, never 403`,
        ).toBe(404);
        expect(theirRead.json).toEqual(NOT_FOUND_APP_WORK);
        expect(
            theirRead.text.includes(workId),
            'and the refusal never names the Work it refused (nor, therefore, that it exists)',
        ).toBe(false);

        const theirSync = await syncUpstream(request, { token: other.access_token, workId });
        expect(
            theirSync.status,
            `another account's sync body=${theirSync.text.slice(0, 200)}`,
        ).toBe(404);
        expect(theirSync.json).toEqual(NOT_FOUND_APP_WORK);

        const nobodyRead = await getUpstream(request, {
            token: other.access_token,
            workId: NOBODY_UUID,
        });
        expect(nobodyRead.status).toBe(404);
        expect(
            nobodyRead.json,
            'the two 404 bodies are identical — the stranger cannot tell "not yours" from "not there"',
        ).toEqual(theirRead.json);
        const nobodySync = await syncUpstream(request, {
            token: other.access_token,
            workId: NOBODY_UUID,
        });
        expect(nobodySync.status).toBe(404);
        expect(nobodySync.json).toEqual(theirSync.json);

        // No session is a 401 — the platform tells "not signed in" apart from "not
        // yours", which is the boundary the case keeps intact.
        const anonymous = await getUpstream(request, { token: '', workId });
        expect(anonymous.status, 'an unauthenticated caller is refused as unauthenticated').toBe(
            401,
        );
    });

    test('the create and inspect conflicts name only the repository, never the first account’s Work', async ({
        request,
    }) => {
        const run = stamp();
        // A repository the run account CAN push to, so the first account may LINK it —
        // which is what puts it "in use" for the second account's refusal.
        const repo = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t32-scope-inuse-${run}`,
            permissions: [{ login: LANE_LOGIN, push: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the in-use ` +
                'conflict cannot be staged in this run.',
        );

        const first = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, first.access_token);
        const firstSlug = `apw13-t32-scope-inuse-${stamp()}`.toLowerCase();
        const firstCreate = await createAppWork(request, {
            token: first.access_token,
            body: appWorkCreateBody({
                name: firstSlug,
                slug: firstSlug,
                description: 'APW-13 T32 NEG-13 in-use conflict (the first account)',
                organization: false,
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        });
        expect(firstCreate.status, `first link body=${firstCreate.text.slice(0, 300)}`).toBe(200);
        const firstWorkId = (firstCreate.json as CreatedView | null)?.work?.id ?? '';
        const firstWorkName = (firstCreate.json as CreatedView | null)?.work?.name ?? '';
        expect(firstWorkId).toBeTruthy();
        expect(firstWorkName).toBeTruthy();

        const second = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, second.access_token);

        const inspected = await inspectAppSource(request, {
            token: second.access_token,
            body: appSourceInspectBody({ repositoryUrl: repoUrl(repo) }),
        });
        expect(inspected.status, `inspect body=${inspected.text.slice(0, 300)}`).toBe(200);
        expect(
            (inspected.json as { modes?: { link?: unknown } } | null)?.modes?.link,
            'the second account sees the conflict, not the first account’s Work',
        ).toEqual({ available: false, reason: 'in_use_by_another_account' });
        expect(
            inspected.text.includes(firstWorkId) || inspected.text.includes(firstWorkName),
            'the preview names neither the first Work’s id nor its name',
        ).toBe(false);

        const secondSlug = `apw13-t32-scope-second-${stamp()}`.toLowerCase();
        const refused = await createAppWork(request, {
            token: second.access_token,
            body: appWorkCreateBody({
                name: secondSlug,
                slug: secondSlug,
                description: 'APW-13 T32 NEG-13 in-use conflict (the second account)',
                organization: false,
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        });
        expect(refused.status, `second link body=${refused.text.slice(0, 300)}`).toBe(409);
        expect(refused.text).toContain('"code":"in_use_by_another_account"');
        expect(refused.text, 'the refusal names the repository instead').toContain(
            `${repo.owner}/${repo.name}`,
        );
        expect(
            refused.text.includes(firstWorkId) || refused.text.includes(firstWorkName),
            'and never the first account’s Work',
        ).toBe(false);

        // A **link** create performs no provider write at all — measured here (0 mutating
        // calls against the repository, where a `fork` create in the sibling lanes records
        // exactly one `POST /repos/<owner>/<repo>/forks`). That is the write-ledger half of
        // ACC-NEG-13's neighbourhood: neither the refusal nor the accepted first create
        // touched GitHub.
        const calls = (await fakeGitHubCalls(request)) ?? [];
        expect(
            writesMatching(calls, `/${repo.owner}/${repo.name}`).length,
            'a link create writes nothing to GitHub, and the refused second create writes nothing either',
        ).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The clause that is violated today — pinned, not hidden
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-13 — MEASURED DEVIATION: the Work read and the deploy route leak existence with 403', () => {
    test('GET /api/works/:id and POST /api/deploy/works/:id answer 403 for a real foreign id and 404 for a nonexistent one — the difference IS the oracle', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-scope-oracle-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to probe for existence in this run.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const stranger = await registerUserViaAPI(request);

        const created = await createFork(request, owner, repo, 'apw13-t32-scope-oracle');
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';

        const probes: Array<{
            label: string;
            route: string;
            method: 'GET' | 'POST';
            /** The owner's own answer, as the control that the route exists. */
            ownerStatus: number;
            /** Fragments the owner's body must carry, so the status is the expected refusal. */
            ownerBodyIncludes?: string[];
        }> = [
            {
                label: 'GET /api/works/:id',
                route: `/api/works/${workId}`,
                method: 'GET',
                ownerStatus: 200,
            },
            {
                label: 'POST /api/deploy/works/:id',
                route: `/api/deploy/works/${workId}`,
                method: 'POST',
                // Since 1076e17d9 (APW-06 T34) an App Work's deploy goes to the App
                // request path, which refuses a Work with no deploy target with 422
                // APP_DEPLOY_PRECONDITIONS (target_none). It used to hit the website
                // provider's 400 first. The 403/404 existence oracle is unchanged.
                ownerStatus: 422,
                ownerBodyIncludes: ['APP_DEPLOY_PRECONDITIONS', 'target_none'],
            },
        ];

        for (const probe of probes) {
            const mine = await rawApi(request, probe.method, probe.route, {
                token: owner.access_token,
                body: probe.method === 'POST' ? {} : undefined,
            });
            expect(
                mine.status,
                `${probe.label} (owner) body=${mine.text.slice(0, 200)} — the route resolves the Work`,
            ).toBe(probe.ownerStatus);
            for (const fragment of probe.ownerBodyIncludes ?? []) {
                expect(mine.text, `${probe.label} (owner) names ${fragment}`).toContain(fragment);
            }

            const theirs = await rawApi(request, probe.method, probe.route, {
                token: stranger.access_token,
                body: probe.method === 'POST' ? {} : undefined,
            });
            const nobody = await rawApi(
                request,
                probe.method,
                probe.route.replace(workId, NOBODY_UUID),
                { token: stranger.access_token, body: probe.method === 'POST' ? {} : undefined },
            );

            expect(
                theirs.status,
                `${probe.label} with another account's REAL Work id answers ${theirs.status} — ` +
                    'ACC-NEG-13 requires 404, never 403 (body=' +
                    `${theirs.text.slice(0, 200)})`,
            ).toBe(403);
            expect(theirs.text).toContain('You do not have permission to access this work');
            expect(
                nobody.status,
                `${probe.label} with an id that belongs to nobody answers ${nobody.status}`,
            ).toBe(404);
            expect(
                theirs.status === nobody.status,
                `FINDING: the two answers DIFFER (${theirs.status} vs ${nobody.status}), so a caller ` +
                    'who guesses a Work id learns whether it exists — the existence oracle ' +
                    'ACC-NEG-13 wording ("→ 404, never 403") exists to prevent',
            ).toBe(false);
        }

        // The APW-02 routes, on the same Work and from the same caller, answer the
        // case's 404 for both ids. The contrast is the finding: one family obeys the
        // rule, the older Work routes do not.
        const upstreamForeign = await getUpstream(request, {
            token: stranger.access_token,
            workId,
        });
        const upstreamNobody = await getUpstream(request, {
            token: stranger.access_token,
            workId: NOBODY_UUID,
        });
        expect(upstreamForeign.status).toBe(404);
        expect(upstreamNobody.status).toBe(404);
        expect(
            upstreamForeign.status === upstreamNobody.status,
            'the APW-02 family gives one answer for both ids — no oracle here',
        ).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The launcher's arrangement save (mounted only with the launcher switch on)
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-13 — the arrangement save refuses another account’s Work like a nonexistent one', () => {
    test('a work:<id> key for another account’s Work is rejected per item with `unknownItem`, exactly like a nonexistent id, and changes nothing', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-scope-prefs-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to name in the save.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const stranger = await registerUserViaAPI(request);

        const created = await createFork(request, owner, repo, 'apw13-t32-scope-prefs');
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';
        const ownerWorkName = created.body.work?.name ?? '';
        expect(
            ownerWorkName,
            'the owner’s Work has a name to leak, or this test proves nothing',
        ).toBeTruthy();

        // Is the launcher mounted? The runbook's lane recipe does not set
        // `EVER_WORKS_APP_LAUNCHER_ENABLED`, and the guard answers the platform's
        // opaque 404 when it is off (FR-54's default). Named, not silently passed.
        const probe = await getMyApps(request, { token: owner.access_token });
        test.skip(
            probe.status === 404,
            'the App Launcher is not mounted on this API — EVER_WORKS_APP_LAUNCHER_ENABLED is not ' +
                "'true', so the guard answers the platform's opaque 404 (FR-54's default) and " +
                "ACC-NEG-13's preferences half cannot be exercised in this run. Run the lane with " +
                'the switch on to execute this case.',
        );
        expect(probe.status, `GET /api/me/apps body=${probe.text.slice(0, 200)}`).toBe(200);

        // The stranger's save names two keys: the owner's Work, and an id nobody owns.
        // Both must come back with the SAME per-item reason, and neither may land.
        const strangerSave = await putMyAppsPreferences(request, {
            token: stranger.access_token,
            body: {
                changes: [
                    { key: `work:${workId}`, pinned: true },
                    { key: `work:${NOBODY_UUID}`, pinned: true },
                ],
            },
        });
        expect(strangerSave.status, `save body=${strangerSave.text.slice(0, 300)}`).toBe(200);
        const rejected = (
            strangerSave.json as { rejected?: Array<{ key?: string; reason?: string }> } | null
        )?.rejected;
        expect(rejected, 'both keys are rejected').toHaveLength(2);
        const byKey = new Map((rejected ?? []).map((row) => [row.key, row.reason]));
        expect(
            byKey.get(`work:${workId}`),
            "another account's Work is refused with the reason the case names",
        ).toBe('unknownItem');
        expect(
            byKey.get(`work:${NOBODY_UUID}`),
            'and a nonexistent Work is refused with the identical reason',
        ).toBe('unknownItem');
        expect((strangerSave.json as { saved?: number } | null)?.saved, 'nothing was saved').toBe(
            0,
        );
        // The save MUST echo the key it refused (that is how the caller learns which item
        // was rejected), so `workId` legitimately appears in the answer — the id the caller
        // itself sent. What must not appear is anything the stranger did not already hold:
        // the owner's Work **name**.
        expect(
            strangerSave.text.includes(ownerWorkName),
            `no Work name is served to the stranger (received=${strangerSave.text.slice(0, 300)})`,
        ).toBe(false);

        // The stranger's own list never carries the owner's Work, even with hidden
        // rows asked for; the owner's own save does, so the refusal above is not
        // vacuous.
        const strangerList = await getMyApps(request, {
            token: stranger.access_token,
            query: { includeHidden: 'true' },
        });
        expect(strangerList.status).toBe(200);
        expect(
            strangerList.text.includes(workId),
            "the stranger's launcher list never carries another account's App Work",
        ).toBe(false);

        const ownerSave = await putMyAppsPreferences(request, {
            token: owner.access_token,
            body: { changes: [{ key: `work:${workId}`, pinned: true, visible: true }] },
        });
        expect(ownerSave.status, `owner save body=${ownerSave.text.slice(0, 300)}`).toBe(200);
        expect(
            (ownerSave.json as { saved?: number; rejected?: unknown[] } | null)?.saved,
            'the owner’s own save is accepted — the control',
        ).toBe(1);
        expect((ownerSave.json as { rejected?: unknown[] } | null)?.rejected).toEqual([]);
        const ownerList = await getMyApps(request, {
            token: owner.access_token,
            query: { includeHidden: 'true' },
        });
        expect(ownerList.text.includes(workId), "the owner's own list carries it").toBe(true);

        // And the stranger asked again: still refused, still nothing changed.
        const repeat = await putMyAppsPreferences(request, {
            token: stranger.access_token,
            body: { changes: [{ key: `work:${workId}`, pinned: true }] },
        });
        expect(repeat.status).toBe(200);
        expect(
            (repeat.json as { saved?: number } | null)?.saved,
            'the repeated attempt saves nothing',
        ).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The sweep the case asks for, as far as it can be reached today
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-13 / ACC-NEG-22 — the whole route sweep (fixme until APW-06 + APW-11)', () => {
    /**
     * The blocker, measured: the case is a **sweep** ("every App Works route that
     * takes a Work id"), and the routes it names are the APW-06/APW-07/APW-10/APW-11
     * controllers, none of which is mounted on this branch. Each answers the
     * platform's opaque `404` for the owner, for another account **and** for an
     * anonymous caller alike (measured 2026-09-19): `app-spec`, `app-spec/validate`,
     * `app-license/attest`, `app-env`, `app-dependencies`, `app-status`, `app-target`
     * (`GET`/`PUT`), `app-target/check`, `app-deletion-preview`, `app-lifecycle`,
     * `app-status/refresh`, `app-smoke`, `app-rollback`, `app-logs`, `builds`,
     * `provision`, `provisioning`, `upstream-pull-requests`, `apps-tier`, `cost`.
     *
     * A `404` for *every* caller is not evidence of the ownership rule — it is
     * evidence that the route does not exist — so the sweep is not asserted green
     * and this marker says why. When those controllers land, this body is the case:
     * one row per CONTRACTS §4 route, another account's id → `404`, never `403` and
     * never the Work's name, plus R-36's `403` for a member who lacks the role.
     */
    test.fixme(
        'APW-06 + APW-11: the sweep needs the App Works controllers, which are unmounted — every ' +
            'route that takes a Work id answers an opaque 404 for owner, stranger and anonymous ' +
            'caller alike, so the ownership rule cannot be told apart from a missing route ' +
            '(measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-scope-sweep-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [repo])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const owner = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, owner.access_token);
            const stranger = await registerUserViaAPI(request);
            const created = await createFork(request, owner, repo, 'apw13-t32-scope-sweep');
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';
            const workName = created.body.work?.name ?? '';

            for (const route of CONTRACTS_S4_ROUTES) {
                if (!route.path.includes(':id')) continue;
                const path = route.path.replace(':id', workId).replace(/\/\*$/, '/probe');
                const mine = await rawApi(request, route.method, path, {
                    token: owner.access_token,
                    body: route.method === 'GET' ? undefined : {},
                });
                expect(
                    mine.status,
                    `${route.method} ${path} (owner) must be a real answer`,
                ).not.toBe(404);
                const theirs = await rawApi(request, route.method, path, {
                    token: stranger.access_token,
                    body: route.method === 'GET' ? undefined : {},
                });
                expect(
                    theirs.status,
                    `${route.method} ${path} (another account) → 404, never 403`,
                ).toBe(404);
                expect(
                    theirs.text.includes(workName) || theirs.text.includes(workId),
                    `${route.method} ${path} never names the Work it refused`,
                ).toBe(false);
            }

            // R-36: the same route answers 403 — not 404 — for a member who lacks the role.
            const member = await registerUserViaAPI(request);
            const asMember = await rawApi(request, 'GET', `/api/works/${workId}/app-status`, {
                token: member.access_token,
            });
            expect(asMember.status).toBe(403);
        },
    );
});
