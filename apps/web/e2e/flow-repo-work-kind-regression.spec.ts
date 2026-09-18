/**
 * APW-13 T14 — Repository Work, the full contract (ACC-REG-01, ACC-NEG-15).
 *
 * ACC-REG-01's recorded verdict is *Partial — no e2e success, 409 or refusal
 * over HTTP*: the happy path, the cross-account `409` and the "never
 * deploy/write" refusals were unit-level only. This spec is the HTTP half.
 *
 * ── The split this file is built around (APW-13 plan §8.8):
 *
 * A `kind: 'repo'` Work is registered only after the platform probes that the
 * caller's CONNECTED Git account can read the repository
 * (`work-lifecycle.service.ts` → `assertRepositoryAccessible` →
 * `gitFacade.hasRepositoryAccess`). A fresh API-registered user has no
 * connection, so:
 *
 *   • every refusal that fires BEFORE the probe — the URL parser, the provider
 *     mismatch, the missing connection — runs here for real;
 *   • the success and the `409` for a second account need that connection, and
 *     run for real too now that T63 has landed surface (b) of plan §8.8: each
 *     account is attached through `connectCustomerGitHub`
 *     (`helpers/github-connection.ts`), which seeds the fake-GitHub OAuth row
 *     through the non-production route and asserts the platform's own re-read
 *     before the create is attempted. The fake is seeded from its checked-in
 *     PR-lane fixture so the repositories exist and the fake attributes the
 *     calls to `apw-e2e-user`;
 *   • the generate / deploy / write refusals carry their **own** `test.fixme`,
 *     with its own measured reason: the D1 guard is reachable on one of the
 *     three routes in this tree, which is a fact about those routes and not
 *     about the connection surface (see the comment on that case).
 *
 * The refusals are pinned twice: once standalone, and once with the lane's
 * `works-app` chip ON, which is what **ACC-NEG-15** asks for ("every refusal in
 * ACC-REG-01 still holds with `works-app` on and
 * `EVER_WORKS_APP_WORKS_ENABLED=true`").
 *
 * ── Evidence that the refusal is LOCAL, not a failed GitHub round-trip:
 *
 * `EVER_WORKS_E2E_FAKES=1` points the GitHub plugin at the lane's fake
 * (`apps/web/e2e/fakes/github-fake`), whose `GET /_control/calls` records every
 * call it served. The no-connection refusal must leave that log at zero GitHub
 * calls: if it had tried to read the repository first, the refusal would be the
 * fake's answer rather than the platform's own guard.
 *
 * Verified live against http://127.0.0.1:3100 (2026-09-18):
 *   - no `repositoryUrl` → `400`, message names `repositoryUrl`;
 *   - `https://gitlab.com/group/project` → `400`, same parse refusal;
 *   - `https://github.com/ever-works/ever-works` with no connection → `400`,
 *     `Could not verify access to <url> with your connected github account: …`;
 *   - the fake recorded ZERO GitHub calls across all three.
 *   - **with the connection surface (T63): a connected account's create answers
 *     `200` with `kind: 'repo'` and its source coordinates, and a second
 *     connected account wrapping the same repository answers `409`.**
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

const WORKS_URL = `${API_BASE}/api/works`;

/**
 * The fake GitHub's control API (`plan §8.3`). `APW_E2E_GITHUB_FAKE_URL` is the
 * platform-read variable the lane sets for both the API and Playwright.
 */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** A public repository URL, used for parse- and probe-only cases. */
const REPO_URL = 'https://github.com/ever-works/ever-works';

/**
 * The login the SUCCESS half wraps a repository under: the run account's
 * **own** identity, as the checked-in PR-lane fixture registers it
 * (`fakes/github-fake/fixtures/catalog-pr-lane.seed.json`, where `apw-e2e-user`
 * owns `templates` with `push`+`admin`).
 *
 * The repository name itself is **per run** (`ownedRepoUrl` below): the API
 * under test keeps its Work rows for the life of the process, and
 * `assertRepositoryNotWrappedByAnotherAccount` refuses the same repository for a
 * second account — which is the property the 409 case asserts, so a fixed name
 * would make the success case fail on every re-run in one lane. ACCEPTANCE §0.5
 * asks the PR lane's scenarios to be idempotent; a run-unique repository is how
 * this one is.
 *
 * `REPO_URL` above stays the parse- and probe-only example, including for the
 * "no connected account" refusal, which fires before any provider call and so
 * never needs the repository to exist anywhere.
 */
const OWNED_REPO_OWNER = 'apw-e2e-user';

/** `https://github.com/<owner>/<run-unique name>` for the success half. */
function ownedRepoUrl(name: string): string {
    return `https://github.com/${OWNED_REPO_OWNER}/${name}`;
}

/** The web chip the App Works lanes force on (tasks.md:201-204). */
const WORKS_APP_ENABLED = process.env.EVER_WORKS_APP_WORKS_ENABLED === 'true';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface RawResult {
    status: number;
    text: string;
    json: Record<string, unknown> | null;
}

/**
 * Raw create — posts an arbitrary body and never throws on `!ok`, so a refusal
 * is asserted by status and message rather than by a thrown Playwright error.
 */
async function createWorkRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<RawResult> {
    const res = await request.post(WORKS_URL, { headers: authedHeaders(token), data: body });
    const text = await res.text();
    let json: RawResult['json'] = null;
    try {
        json = JSON.parse(text) as RawResult['json'];
    } catch {
        json = null;
    }
    return { status: res.status(), text, json };
}

/** A Repository Work create body; `extra` layers on the kind-specific fields. */
function repoWorkBody(
    slugBase: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        name: `${slugBase} ${stamp()}`,
        slug: `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        description: 'APW-13 T14 repository-work regression',
        organization: false,
        kind: 'repo',
        ...extra,
    };
}

/** The three refusals a fresh, connection-less account always gets. */
async function assertConnectionFreeRefusals(
    request: APIRequestContext,
    token: string,
): Promise<void> {
    const missingUrl = await createWorkRaw(request, token, repoWorkBody('apw13-t14-nourl'));
    expect(
        missingUrl.status,
        `repo without repositoryUrl body=${missingUrl.text.slice(0, 300)}`,
    ).toBe(400);
    expect(missingUrl.text).toContain('repositoryUrl');

    for (const repositoryUrl of [
        'https://gitlab.com/group/project',
        // eslint-disable-next-line no-useless-escape
        'git@github.com:ever-works/ever-works.git',
        'https://github.com/ever-works',
    ]) {
        const badUrl = await createWorkRaw(
            request,
            token,
            repoWorkBody('apw13-t14-badurl', { repositoryUrl }),
        );
        expect(
            badUrl.status,
            `repo with repositoryUrl=${repositoryUrl} body=${badUrl.text.slice(0, 300)}`,
        ).toBe(400);
        expect(badUrl.text).toContain('repositoryUrl');
    }

    const noConnection = await createWorkRaw(
        request,
        token,
        repoWorkBody('apw13-t14-noconn', { repositoryUrl: REPO_URL }),
    );
    expect(
        noConnection.status,
        `repo with no connected Git account body=${noConnection.text.slice(0, 300)}`,
    ).toBe(400);
    expect(noConnection.text).toContain(`Could not verify access to ${REPO_URL}`);
}

/**
 * How many GitHub calls the fake has served, or `null` when its control API is
 * not reachable (the lane did not start it).
 */
async function fakeGitHubCallCount(request: APIRequestContext): Promise<number | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: unknown[] };
        return Array.isArray(body.calls) ? body.calls.length : null;
    } catch {
        return null;
    }
}

/**
 * The fake's PR-lane catalog, as checked in (plan §8.3, T2: "Seed the PR-lane
 * catalog … from a checked-in JSON fixture per spec rather than per-test code").
 *
 * Located from the working directory rather than from `import.meta`, because a
 * Playwright spec may be launched from `apps/web` (the lane) or from the repo
 * root (a direct invocation) — the same two candidates
 * `localization-strings.spec.ts` uses for its message bundles.
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
 * Put the checkout-in fixture into the fake's state, so the repositories the
 * success half wraps exist and the fake knows the run account's token identity
 * (`apw-e2e-user`). Idempotent — `POST /_control/seed` upserts, so a re-run or a
 * second spec in the same lane is harmless.
 *
 * `extraRepositories` are seeded on top of the fixture, which is how a scenario
 * gets a **run-unique** repository without inventing a second fixture file.
 *
 * Returns `false` when the fake is not reachable, which the caller turns into a
 * named `test.skip` rather than a failure: without the fake there is nothing to
 * fork, clone or attribute, and the PR lane is what starts it
 * (`.github/workflows/e2e.yml`).
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

test.describe('Repository Work — the refusals that fire before any GitHub call', () => {
    test('a fresh account is refused with 400 for a missing, non-GitHub or unreachable repository', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await assertConnectionFreeRefusals(request, user.access_token);
    });

    test('the refusal is local: the fake GitHub records no call for it', async ({ request }) => {
        const before = await fakeGitHubCallCount(request);
        test.skip(
            before === null,
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/calls, so the ` +
                'zero-call proof cannot be read in this run (the PR lane starts it beside the API).',
        );

        const user = await registerUserViaAPI(request);
        await assertConnectionFreeRefusals(request, user.access_token);

        const after = await fakeGitHubCallCount(request);
        expect(
            after,
            'the access probe must never reach the provider when the caller has no connection — ' +
                'a non-zero delta would mean the refusal is the fake answering, not the platform guard',
        ).toBe(before);
    });

    test('an unauthenticated create is refused (401)', async ({ request }) => {
        const res = await request.post(WORKS_URL, { data: repoWorkBody('apw13-t14-anon') });
        expect(res.status()).toBe(401);
    });
});

test.describe('ACC-NEG-15 — with the works-app chip on, the Repository Work refusals are unchanged', () => {
    test('every connection-free refusal still holds, and never becomes a fork/build/deploy', async ({
        request,
    }) => {
        test.skip(
            !WORKS_APP_ENABLED,
            'this lane did not set EVER_WORKS_APP_WORKS_ENABLED=true, so the "with works-app on" ' +
                'contrast ACC-NEG-15 asks for cannot be observed (tasks.md:201-204 makes it a lane ' +
                'switch precisely so it is never inferred from NODE_ENV).',
        );

        const user = await registerUserViaAPI(request);
        await assertConnectionFreeRefusals(request, user.access_token);

        // The refusal is a CREATE refusal: no Work row may exist for any of the
        // three attempts, so nothing downstream (fork, build, deploy) is armed.
        const list = await request.get(`${WORKS_URL}?limit=100`, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status(), `works listing body=${(await list.text()).slice(0, 200)}`).toBe(200);
        const listed = (await list.json()) as { works?: Array<{ kind?: string }> };
        const repoWorks = (listed.works ?? []).filter((work) => work.kind === 'repo');
        expect(
            repoWorks.length,
            'a refused Repository Work create must not leave a Work behind',
        ).toBe(0);
    });
});

test.describe('Repository Work — halves that need a GitHub connection (T63)', () => {
    // T63 landed surface (b) of plan §8.8: the non-production
    // connection-seeding route (`POST /api/e2e/github-connection/seed`), reached
    // through `connectCustomerGitHub` (`helpers/github-connection.ts`). Each
    // account that acts on a repository is connected before it creates one —
    // including the stranger, because `assertRepositoryAccessible` runs BEFORE
    // the cross-account wrap check
    // (`packages/agent/src/services/work-lifecycle.service.ts:571-572`), so the
    // 409 is only reachable for an account that also has a usable connection.
    test('a connected account creates a repo Work and a second account is refused 409', async ({
        request,
    }: {
        request: APIRequestContext;
    }) => {
        const repositoryName = `apw13-t14-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const repositoryUrl = ownedRepoUrl(repositoryName);
        test.skip(
            !(await seedFakeGitHub(request, [
                { owner: OWNED_REPO_OWNER, name: repositoryName, defaultBranch: 'main' },
            ])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'connected half cannot run in this lane (the PR lane starts it beside the API).',
        );

        // 1. Success: a `repo` Work wrapping the connected account's own
        //    repository, persisted with its source repository coordinates
        //    (`work-lifecycle.service.ts` → `applyRepositoryWorkSource`).
        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const created = await createWorkRaw(
            request,
            owner.access_token,
            repoWorkBody('apw13-t14-created', { repositoryUrl }),
        );
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(200);
        expect(created.json?.status).toBe('success');
        // The co-ordinates are the fixture's own repository, echoed by the
        // platform — the property T14's "successful create" is about.
        const work = created.json?.work as { id?: string; kind?: string } | undefined;
        expect(work?.kind, 'the Work is a Repository Work').toBe('repo');
        expect(
            (created.json?.work as { sourceRepository?: unknown } | undefined)?.sourceRepository ??
                null,
            'the source repository coordinates are persisted on the Work',
        ).not.toBeNull();

        // 2. 409: the SAME repository registered by a DIFFERENT account.
        //    Same account twice is allowed (one token, one checkout);
        //    another account is refused with 409 by
        //    `assertRepositoryNotWrappedByAnotherAccount`.
        const stranger = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, stranger.access_token);
        const conflict = await createWorkRaw(
            request,
            stranger.access_token,
            repoWorkBody('apw13-t14-conflict', { repositoryUrl }),
        );
        expect(
            conflict.status,
            `second account wrapping the same repository body=${conflict.text.slice(0, 300)}`,
        ).toBe(409);
    });

    /**
     * The D1 "never deploy/write" refusals — **kept, and deliberately not
     * re-pointed**, because the connection surface T63 landed is not what blocks
     * them.
     *
     * The assertions below are exactly the ones this file shipped with. They
     * cannot pass in this tree, and the blockers are measured, not guessed
     * (probed 2026-09-18 against the lane's own API, `node dist/main.js`, with a
     * connected account and a `kind: 'repo'` Work it had just created):
     *
     *   - `POST /api/works/:id/generate` **does** reach the guard — but only for
     *     a body the DTO accepts. `{}` is refused by the global `ValidationPipe`
     *     first (`name`/`prompt` are required,
     *     `packages/agent/src/items-generator/dto/create-items-generator.dto.ts:52-68`),
     *     so the observed answer is a `400` field list, not the guard's message.
     *     With `{ name, prompt }` it answers `400 is a Repository Work`, which is
     *     the refusal this case is about.
     *   - `POST /api/works/:id/schedule/run` answers **`404 Schedule not found`**:
     *     the controller reads a schedule row before anything else
     *     (`works.controller.ts:1257-1266`) and a Repository Work has none. The
     *     guard this case names lives in `updateSchedule`
     *     (`work-schedule.service.ts:111`), not on the run path — so the run
     *     route never reaches it.
     *   - `POST /api/deploy/works/:id` answers **`400 Deployment token is
     *     required`**, refused before any Work-kind check while no deploy
     *     provider is configured (`deploy.controller.ts:249-256`), and no deploy
     *     service calls `assertNotRepositoryWork` at all.
     *
     * So the D1 guard is reachable on one of the three routes the case names, and
     * making the other two reach it is a change to those routes — not to this
     * spec and not to the GitHub connection surface. Left `fixme` with the
     * accurate reason, and reported, rather than re-pointed at the refusals that
     * happen to fire first.
     */
    test.fixme(
        'APW-13 T14: the generate/deploy/write refusals need the D1 guard on all three routes ' +
            '(schedule/run has no schedule row to run; deploy refuses for a missing provider token first)',
        async ({ request }: { request: APIRequestContext }) => {
            // A run-unique repository, seeded on top of the checked-in fixture,
            // so this case can be un-fixme'd and re-run in one lane without
            // colliding with the success case's Work.
            const repositoryName = `apw13-t14-guard-${stamp()}`
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '');
            await seedFakeGitHub(request, [
                { owner: OWNED_REPO_OWNER, name: repositoryName, defaultBranch: 'main' },
            ]);

            const owner = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, owner.access_token);
            const created = await createWorkRaw(
                request,
                owner.access_token,
                repoWorkBody('apw13-t14-guard', { repositoryUrl: ownedRepoUrl(repositoryName) }),
            );
            expect(created.status).toBe(200);

            // The generate / deploy / write refusals over HTTP — the D1
            // "never deploy/write" guard, asserted on the Work created above.
            // Each route is expected to reach a named
            // `assertNotRepositoryWork(work, action)`
            // (`packages/agent/src/works/repository-work-guard.ts:70`, whose
            // refusal text starts with `is a Repository Work`):
            //   • generate — `POST /api/works/:id/generate`
            //     (`works.controller.ts:1078` → `work-generation.service.ts:1835`);
            //   • write    — `POST /api/works/:id/schedule/run`
            //     (`works.controller.ts:1248` → `work-schedule.service.ts:111`);
            //   • deploy   — `POST /api/deploy/works/:id`
            //     (`deploy.controller.ts:226` → `work-lifecycle.service.ts:940`).
            const workId = (created.json?.work as { id?: string } | undefined)?.id ?? '';
            expect(workId, 'the created Work id is required for the refusal cases').not.toBe('');

            for (const [label, method, path] of [
                ['generate', 'POST', `/api/works/${workId}/generate`],
                ['write', 'POST', `/api/works/${workId}/schedule/run`],
                ['deploy', 'POST', `/api/deploy/works/${workId}`],
            ] as const) {
                const res = await request.fetch(`${API_BASE}${path}`, {
                    method,
                    headers: authedHeaders(owner.access_token),
                    data: {},
                });
                const text = await res.text();
                expect(res.status(), `${label} refusal body=${text.slice(0, 300)}`).toBe(400);
                expect(text).toContain('is a Repository Work');
            }
        },
    );
});
