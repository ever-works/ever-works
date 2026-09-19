/**
 * APW-13 T32 — SEC PIN: nothing is published upstream without the author's approval
 * (ACC-NEG-06).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-NEG-06 — Upstream PR without approval** (`ACCEPTANCE.md:711`):
 *
 * > With an `awaiting_approval` proposal seeded, the fake GitHub records **no**
 * > create-pull-request call after: the proposal POST (`202 preparing`); approval
 * > by another user's approval id → `404` and no create call (`decide` resolves the
 * > proposal through `requireOwned`, so a non-author decision is a not-found rather
 * > than an `awaiting_approval` no-op, and the listener's non-author branch never
 * > inserts a second proposal because `UNIQUE (actionType, subjectKey)` forbids it);
 * > an expired approval (72 h → `expired`); a title or body change after approval
 * > (fingerprint mismatch, "The proposal changed after you approved it. Review it
 * > again."). Only the author's approval produces exactly one create call (APW-09
 * > FR-21–FR-24). An App spec with `upstreamPullRequests.requireApproval: false` →
 * > `app.spec.invalid` with code `upstream_pr_approval_required` (APW-03 R12). A
 * > private copy → `422` with the private-copy code and the S10 text. (The
 * > base-owner allow-list check is a harness interlock — ACC-NEG-16.)
 *
 * ## What this file proves today, and what it cannot
 *
 * Every route the case drives belongs to APW-09, which is **Wave 2 and unshipped**:
 * `POST|GET /api/works/:id/upstream-pull-requests`, its `/eligibility`, `/:prId`,
 * `/:prId/signed`, `/:prId/withdraw`, `/:prId/check`, `/:prId/address-review` and
 * the `suggestions/:taskId/dismiss` family all answer `404` for the owner, for
 * another account and for an anonymous caller alike (measured below). There is
 * therefore no proposal to seed, no approval to expire and no fingerprint to
 * change, and the case's own assertions cannot be produced — each one is carried by
 * a `test.fixme('APW-09: …')` body below.
 *
 * What the running pins **do** establish is the property the case exists for, at
 * the only layer this lane reaches: **this lane really does write to GitHub** (an
 * App Work created in `fork` mode records exactly one `POST
 * /repos/<upstream>/<repo>/forks`), and against that positive control **no
 * create-pull-request call is ever recorded** — the fake's own `POST
 * /repos/:owner/:repo/pulls` route (`fakes/github-fake/routes/pulls.mjs:56-57`)
 * is never hit. When APW-09 lands, this pin keeps holding the "no publication
 * without approval" line while the case's approval matrix gets its own green.
 *
 * ## Measured on this lane (2026-09-19)
 *
 * API `node apps/api/dist/main.js` on **3998** (sqlite in memory, the runbook's
 * env), fake GitHub on **3902**:
 *
 *   - `POST /api/works` (fork) → `200`; the fake's log carries exactly one
 *     `POST /repos/apw-e2e-upstream/<repo>/forks -> 202` for that repository
 *   - zero mutating calls whose path contains `/pulls` across the whole probe
 *   - `GET|POST /api/works/:id/upstream-pull-requests` → `404` (owner, other,
 *     anonymous), with the platform's `Cannot …` body
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appWorkCreateBody,
    createAppWork,
    getUpstreamPrEligibility,
    listUpstreamPullRequests,
    proposeUpstreamPr,
    rawApi,
    validateAppSpec,
} from './helpers/app-works';
import { registerUserViaAPI } from './helpers/api';
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

/** A syntactically valid v4 id for the routes the case names by parameter. */
const VALID_UUID = '11111111-2222-4333-8444-555555555555';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
}

interface FakeCall {
    method?: string;
    path?: string;
    status?: number | null;
}

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

/**
 * The mutating calls that would **publish** something upstream: a pull request, its
 * review, or a merge of it. `/graphql` is excluded for the reason T30's spec gives
 * (the git plugin issues it as a read and the fake serves no such route).
 */
function publicationWrites(calls: FakeCall[]): FakeCall[] {
    return calls.filter((call) => {
        const method = (call.method ?? '').toUpperCase();
        const path = call.path ?? '';
        if (!MUTATING_METHODS.has(method)) return false;
        if (path.startsWith('/graphql')) return false;
        return path.includes('/pulls');
    });
}

/** The mutating calls against one repository. */
function writesMatching(calls: FakeCall[], needle: string): FakeCall[] {
    return calls.filter(
        (call) =>
            MUTATING_METHODS.has((call.method ?? '').toUpperCase()) &&
            !(call.path ?? '').startsWith('/graphql') &&
            (call.path ?? '').includes(needle),
    );
}

/**
 * `owner/name` as the fake's call log spells it: **with its `/repos` prefix**
 * (measured in the ledger — `POST /repos/apw-e2e-upstream/<repo>/forks`). The
 * `writesMatching` filter above uses the bare `owner/name` substring, so it is
 * indifferent to the prefix; this helper is for the exact-path assertions.
 */
function fakePath(owner: string, name: string): string {
    return `/repos/${owner}/${name}`;
}

/**
 * The proposal-decision path the case's "approval by another user's approval id"
 * clause drives. CONTRACTS §4 lists `POST /api/agent-approvals/:id/approve` under
 * "named only in epic plans" for APW-09; the proposal-scoped decision lives under
 * the Work, which is the id the case calls *the approval id*.
 */
function approvePath(workId: string, approvalId: string): string {
    return `/api/works/${workId}/upstream-pull-requests/${approvalId}/approve`;
}

interface CreatedView {
    work?: { id?: string; kind?: string };
    appSource?: { relation?: string; dataRepository?: { owner?: string; repo?: string } };
}

/** Create one forked App Work from `repo` and hand back the answer. */
async function createFork(
    request: APIRequestContext,
    token: string,
    repo: { owner: string; name: string },
    slugBase: string,
): Promise<{ status: number; body: CreatedView; text: string }> {
    const slug = `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const result = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T32 NEG-06 ${slugBase}`,
            organization: false,
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
        }),
    });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

// ---------------------------------------------------------------------------
// Running pins — the publication line, held at the layer this lane reaches
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-06 — no create-pull-request call, against a lane that really does write to GitHub', () => {
    test('the fork create writes exactly one fork call and no create-pull-request call at all', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-pr-nowrite-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the write ` +
                'ledger cannot be read in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const before = await fakeGitHubCalls(request);
        expect(before, 'the fake answers /_control/calls in this lane').not.toBeNull();

        const created = await createFork(request, user.access_token, repo, 'apw13-t32-pr-nowrite');
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        expect(created.body.work?.kind).toBe('app');
        expect(created.body.appSource?.relation, 'the create forked the upstream').toBe('fork');

        const after = (await fakeGitHubCalls(request)) ?? [];
        // Filtered on THIS run's repository path: the call log is shared with every
        // other spec on the fake, so a whole-log count compares two different worlds
        // (the trap T15's spec documents).
        const repoWrites = writesMatching(after, fakePath(repo.owner, repo.name));
        expect(
            repoWrites.length,
            `the fork is the one write against the repository ` +
                `(writes=${JSON.stringify(repoWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(1);
        expect(repoWrites[0]?.path, 'and it is the fork call, not a pull-request call').toBe(
            `${fakePath(repo.owner, repo.name)}/forks`,
        );

        const publications = publicationWrites(after);
        expect(
            publications.length,
            `the positive control above shows this lane writes to GitHub, and none of those ` +
                `writes publishes upstream (pulls=${JSON.stringify(
                    publications.map((c) => `${c.method} ${c.path}`),
                )})`,
        ).toBe(0);
    });

    test('the proposal routes ACC-NEG-06 drives are not mounted — 404 for the owner, another account and nobody', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-pr-routes-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to point the proposal routes at in this run.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const other = await registerUserViaAPI(request);

        const created = await createFork(request, owner.access_token, repo, 'apw13-t32-pr-routes');
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';
        expect(workId).toBeTruthy();

        const attempts: Array<{
            label: string;
            run: (token: string) => Promise<{ status: number; text: string }>;
        }> = [
            {
                label: 'POST upstream-pull-requests (the proposal)',
                run: (token) => proposeUpstreamPr(request, { token, workId, body: {} }),
            },
            {
                label: 'GET upstream-pull-requests (the list)',
                run: (token) => listUpstreamPullRequests(request, { token, workId }),
            },
            {
                label: 'GET upstream-pull-requests/eligibility (the pre-flight)',
                run: (token) =>
                    getUpstreamPrEligibility(request, { token, workId, taskId: VALID_UUID }),
            },
        ];

        for (const attempt of attempts) {
            for (const [who, token] of [
                ['owner', owner.access_token],
                ['another account', other.access_token],
                ['no session', ''],
            ] as const) {
                const result = await attempt.run(token);
                expect(
                    result.status,
                    `${attempt.label} (${who}) body=${result.text.slice(0, 200)} — APW-09 owns these ` +
                        'routes and none of them exists on this API yet',
                ).toBe(404);
            }
        }

        // Nothing was published while the routes were probed: the whole point of the
        // case, checked again after the attempts rather than only before them.
        const after = (await fakeGitHubCalls(request)) ?? [];
        const publications = publicationWrites(after);
        expect(
            publications.length,
            `a 404 publishes nothing (pulls=${JSON.stringify(
                publications.map((c) => `${c.method} ${c.path}`),
            )})`,
        ).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The acceptance case, blocked by APW-09 (Wave 2) and APW-03
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-06 — the approval rule itself (fixme until APW-09)', () => {
    /**
     * The measured blocker: APW-09 is Wave 2 and unshipped on this branch — every
     * proposal route answers `404` (measured above), so there is no `awaiting_approval`
     * proposal to seed, no approval id to hand to a second user, no 72 h clock to
     * expire and no fingerprint to change. The fake GitHub side of the case is
     * already in place (`routes/pulls.mjs:56` serves `POST /repos/:owner/:repo/pulls`),
     * which is what makes the assertion writable the day the routes land.
     */
    test.fixme(
        'APW-09: the approval matrix needs the proposal routes, which are unshipped — POST and ' +
            'GET /api/works/:id/upstream-pull-requests answer 404 Cannot POST/GET (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg06-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [repo])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const author = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, author.access_token);
            const stranger = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, stranger.access_token);

            const created = await createFork(request, author.access_token, repo, 'apw13-t32-neg06');
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';
            const callsBefore = (await fakeGitHubCalls(request)) ?? [];

            // The proposal POST → `202 preparing`, and no create call yet.
            const proposal = await proposeUpstreamPr(request, {
                token: author.access_token,
                workId,
                body: { taskId: VALID_UUID, title: `apw13-t32 ${run}`, body: 'APW-13 T32 NEG-06' },
            });
            expect(proposal.status).toBe(202);
            expect(proposal.text).toContain('preparing');
            const proposalId = (proposal.json as { id?: string } | null)?.id ?? '';
            expect(proposalId).toBeTruthy();
            expect(
                publicationWrites((await fakeGitHubCalls(request)) ?? []).length,
                'a proposal publishes nothing',
            ).toBe(0);

            // Another user's approval id → 404, and still no create call.
            const asStranger = await rawApi(request, 'POST', approvePath(workId, proposalId), {
                token: stranger.access_token,
                body: {},
            });
            expect(asStranger.status, 'a non-author decision is a not-found').toBe(404);
            expect(
                publicationWrites((await fakeGitHubCalls(request)) ?? []).length,
                'and it creates nothing',
            ).toBe(0);

            // 72 h later the approval is `expired`, and still nothing is created.
            const expired = await listUpstreamPullRequests(request, {
                token: author.access_token,
                workId,
            });
            expect(expired.text).toContain('expired');
            expect(publicationWrites((await fakeGitHubCalls(request)) ?? []).length).toBe(0);

            // A title change after approval is a fingerprint mismatch.
            const changed = await proposeUpstreamPr(request, {
                token: author.access_token,
                workId,
                body: { taskId: VALID_UUID, title: `apw13-t32 ${run} (changed)` },
            });
            expect(changed.status).toBe(422);
            expect(changed.text).toContain('The proposal changed after you approved it');

            // Only the author's approval produces exactly one create call.
            const approved = await rawApi(request, 'POST', approvePath(workId, proposalId), {
                token: author.access_token,
                body: {},
            });
            expect(approved.status).toBe(200);
            const publications = publicationWrites((await fakeGitHubCalls(request)) ?? []);
            expect(
                publications.length,
                `exactly one create-pull-request call ` +
                    `(writes=${JSON.stringify(publications.map((c) => `${c.method} ${c.path}`))})`,
            ).toBe(1);
            expect(publications[0]?.path).toBe(`${fakePath(repo.owner, repo.name)}/pulls`);
            expect(
                publicationWrites(callsBefore).length,
                'and none of it happened before the author approved',
            ).toBe(0);
        },
    );

    /**
     * The other two clauses of ACC-NEG-06 belong to APW-03's App spec validation
     * (`GET /api/works/:id/app-spec` and `POST /api/works/:id/app-spec/validate` both
     * answer `404` on this API, measured 2026-09-19) and to APW-01's private-copy
     * mode, so neither the `app.spec.invalid` code nor the private-copy `422` can be
     * produced here.
     */
    test.fixme(
        'APW-03: the `upstreamPullRequests.requireApproval: false` refusal and the private-copy ' +
            '422 need App spec validation and the private-copy mode — /api/works/:id/app-spec ' +
            'and /:id/app-spec/validate answer 404, and the fake reports no repository size so ' +
            'private copy is never offered (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg06-spec-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [repo])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const author = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, author.access_token);
            const created = await createFork(
                request,
                author.access_token,
                repo,
                'apw13-t32-neg06-spec',
            );
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';

            const invalid = await validateAppSpec(request, {
                token: author.access_token,
                workId,
                body: { upstreamPullRequests: { requireApproval: false } },
            });
            expect(invalid.status).toBe(422);
            expect(invalid.text).toContain('app.spec.invalid');
            expect(invalid.text).toContain('upstream_pr_approval_required');

            const privateCopy = await createAppWork(request, {
                token: author.access_token,
                body: appWorkCreateBody({
                    name: `apw13-t32-neg06-copy-${run}`,
                    slug: `apw13-t32-neg06-copy-${run}`.toLowerCase(),
                    organization: false,
                    repositoryUrl: repoUrl(repo),
                    repositoryMode: 'private-copy',
                }),
            });
            expect(privateCopy.status).toBe(422);
            expect(privateCopy.text).toContain('private_copy');
        },
    );
});
