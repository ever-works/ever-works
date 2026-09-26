/**
 * APW-13 T30 — create an App Work from any repository URL (ACC-E2E-01, ACC-NEG-08).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-E2E-01** (`ACCEPTANCE.md:228-260`, `apps/web/e2e/flow-app-work-create-from-url.spec.ts`):
 *
 * > Given a signed-in user with a connected GitHub account, when they open `/works/new`,
 * > choose the **App** chip and paste each URL in turn, then the form shows, for each:
 * > whether they own it, whether they can push, **Fork** / **Link** / **Private copy**
 * > with the right default …, **App Blueprint found: {name}** or **No App Blueprint for
 * > this repository …**, and a licence preview.
 * >
 * > **Assertions.** `POST /api/works/app-source/inspect` → `200` for each URL; body fields
 * > match the seed (push access, fork possible, existing fork, Blueprint id, licence class).
 * > The fake GitHub recorded **zero write calls** during every inspect. A direct inspect
 * > call with a GitLab URL, a URL with no repository, or a malformed URL → `400 invalid_url`
 * > … Archived repository → inspect `200`, **Link** disabled …, **Fork** and **Private
 * > copy** available (APW-01 S15). Private repository with forking disallowed → **Fork**
 * > and **Private copy** disabled …
 *
 * **ACC-NEG-08** (`ACCEPTANCE.md:713`):
 *
 * > Another account's Repository Work or App Work on that repository → `409
 * > in_use_by_another_account` for **Link** (Fork still offered); the same account after
 * > 10 minutes or with a different slug → `409 app_work_exists`; an identical request
 * > within 10 minutes → `200` with `alreadyExisted: true` (APW-01 FR-23–FR-26). The fake
 * > GitHub recorded no write; the first App Work is unchanged. An existing fork of the
 * > upstream is announced in the preview ("You already have a fork: {fullName}. …") and
 * > adopted with no fork request (APW-01 FR-19, S5).
 *
 * ## The half of ACC-E2E-01 this file owns, and the half it does not
 *
 * ACCEPTANCE's own table for this scenario names **two** test files: this one (T30) and
 * APW-01's `flow-app-work-create-form.spec.ts` (T28) / `flow-app-work-create-refusals.spec.ts`.
 * This file is the **API half** — the preview the form renders, and every create answer —
 * driven through the same wrappers the App Works lanes use (`helpers/app-works.ts`), which
 * is the shape the three existing PR-lane specs established. The **form half** ("the field
 * error shows, **Check repository** stays disabled and no request is sent", the chip, the
 * copy) belongs to T28 and is **not driven here**; it is reported rather than implied.
 *
 * ## What is `fixme` here, and the measurement behind the marker
 *
 * The marker carries the number that put it there, measured on the lane's own API
 * (2026-09-19, `node apps/api/dist/main.js` on 3999 beside the fake GitHub on 3900, an
 * account attached through `connectCustomerGitHub`):
 *
 *   1. **ACC-E2E-01's Blueprint id and licence class — APW-03.** Measured 2026-09-19,
 *      `APP_SOURCE_CATALOG_PORT` was bound nowhere, so the inspector's catalog read
 *      answered `blueprint: { status: "unavailable" }` and
 *      `license: { class: "unknown", source: "detected" }` for **every** repository —
 *      including the ones the fake's Blueprint catalog lists. Since APW-03 T26
 *      (2026-09-25) `AppWorksModule` binds the port, but the answer in this lane stays the
 *      same (expected from the code, not re-measured): the Blueprint resolver reads the
 *      `ever-works` catalog with a **platform** GitHub credential and the lane has none (no
 *      installation on `ever-works`, no `EVER_WORKS_APPS_CATALOG_TOKEN` / `GITHUB_TOKEN` in
 *      `e2e.yml`). Even with one, a Blueprint match stays held back until the apply service
 *      (T28) is bound, and the manifest half that names `umami` for
 *      `ever-works/umami-template` is still open (T24/T26). The provider-detected SPDX
 *      (`"MIT"`, `"BUSL-1.1"`) *is* asserted below; the matched id and the class are not
 *      observable here yet.
 *
 * **ACC-NEG-08's `alreadyExisted: true` (APW-01 FR-23) was the second marker until C9.**
 * Measured twice on 2026-09-19 (fork and link creates): the identical request answered
 * **`409`** `A Work with the slug "…" already exists. Choose another slug.`, because the slug
 * uniqueness check (create step 5) ran before the FR-23 idempotent lookup (step 8), and a
 * request identical enough to be idempotent always has the same slug. Step 5 now defers
 * that one refusal when the slug's holder is the caller's own App Work created inside the
 * idempotency window (`app-work-create.service.ts`, `slugHeldByFreshOwnAppWork`), so the
 * case runs below as a live test.
 *
 * Two more lane facts:
 *
 *   • **Private copy is observable in this lane since C11.** Until then the fake's
 *     repository projection carried no `size`, `resolveAppRepositoryModes` refused the
 *     unmeasurable size first (`contracts/src/apps/app-source.ts`, fail-closed) and every
 *     inspect answered `private-copy: too_large_for_private_copy`. The fake now reports
 *     `size` from the seed's `sizeKb` (default 1024 KB, `fakes/github-fake/fixtures/README.md`),
 *     so the preview below pins both sides: a small repository offers Private copy, and one
 *     seeded above the 512000 KB cap is refused `too_large_for_private_copy`.
 *   • **The rejected create is refused before any provider write**, which is what
 *     "the fake GitHub recorded no write" means; the mutating-call audit below filters on
 *     the **run-unique repository path** rather than on the whole log, because the chromium
 *     project runs spec files in parallel workers against one fake (the same reason T15's
 *     spec gives for filtering its fork calls).
 *
 * Verified live against http://127.0.0.1:3999 (2026-09-19): inspect `200` with
 * `link: no_push_access` / `fork: available` / `defaultMode: "fork"` for a repository the
 * account cannot push to; `link: archived` for an archived repository it *can* push to;
 * `fork: forking_disabled` for a private repository with `allow_forking: false`;
 * `409 in_use_by_another_account` for a second account; `409 app_work_exists` for the same
 * account with another slug; and zero mutating GitHub calls during every inspect.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    createAppWork,
    inspectAppSource,
} from './helpers/app-works';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/**
 * This file's cases run **one at a time**.
 *
 * `playwright.config.ts` sets `fullyParallel: true`, so a local `playwright test` run of
 * this file beside its sibling `flow-app-work-fork-lifecycle` puts every case of both files
 * on **one** API process and **one** in-memory SQLite at once. Measured on this host
 * (2026-09-19): a fork create that answers in **5.4 s** on an idle stack took **32.6 s**
 * with eight workers — and this file's own creates/inspects slow down with it (a single
 * inspect-only case reported 53 s). Serialising the file's cases keeps every assertion
 * measuring the platform rather than the host; in CI the shard already runs
 * `PLAYWRIGHT_WORKERS=1` (`playwright.config.ts:49-53`, the workflow's baseline), where
 * this setting is a no-op. No assertion is weakened by it.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where "no write" is readable. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/**
 * The login the checked-in PR-lane fixture gives the run account
 * (`fakes/github-fake/fixtures/catalog-pr-lane.seed.json`): `apw-e2e-user` owns `templates`
 * and has `push` on the three `ever-works/*-template` repositories. Every account this lane
 * attaches presents that same fake identity, which is why the second account in the
 * ACC-NEG-08 case still *reads* as `apw-e2e-user` to GitHub — the conflict the case is
 * about is between two **Ever Works** accounts, not two GitHub logins.
 */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot write to: the fork scenarios' upstream side. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** `https://github.com/<owner>/<repo>` — what the form pastes. */
function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
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

/**
 * Put the checked-in fixture into the fake's state and add this test's own repositories.
 * `POST /_control/seed` upserts, so a re-run or a spec running beside this one is harmless.
 *
 * Returns `false` when the fake is unreachable, which each caller turns into a named
 * `test.skip`: without the fake there is no repository to inspect and no call log to read,
 * and the PR lane is what starts it beside the API.
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
 * The mutating methods a GitHub **write** can arrive with.
 *
 * `POST /graphql` is deliberately **not** counted: the git plugin issues it as a *read*
 * (its GraphQL query path), and the fake serves no `/graphql` route at all — it answers
 * `404` (measured: two to three such calls per inspect). Counting a 404 on a route the fake
 * does not implement as a write would make every "zero writes" assertion fail for a reason
 * that has nothing to do with the platform writing anything. Reported as a finding.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isGitHubWrite(call: FakeCall): boolean {
    const method = (call.method ?? '').toUpperCase();
    const path = call.path ?? '';
    if (!MUTATING_METHODS.has(method)) return false;
    return !path.startsWith('/graphql');
}

/** The mutating calls whose path names one repository (or one account), by path filter. */
function writesMatching(calls: FakeCall[], needle: string): FakeCall[] {
    return calls.filter((call) => isGitHubWrite(call) && (call.path ?? '').includes(needle));
}

/** The mutating calls that hit one exact path. */
function writesAt(calls: FakeCall[], path: string): FakeCall[] {
    return calls.filter((call) => isGitHubWrite(call) && call.path === path);
}

/** `owner/name` as the fake's call log spells it. */
function fakePath(owner: string, name: string): string {
    return `/${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// The two shapes this file reads back
// ---------------------------------------------------------------------------

type ModeAvailability = { available?: boolean; reason?: string };

interface InspectView {
    repository?: {
        owner?: string;
        repo?: string;
        fullName?: string;
        defaultBranch?: string;
        archived?: boolean;
        isFork?: boolean;
        allowForking?: boolean;
        visibility?: string;
    };
    access?: { canPush?: boolean; canAdmin?: boolean };
    modes?: { link?: ModeAvailability; fork?: ModeAvailability; 'private-copy'?: ModeAvailability };
    defaultMode?: string | null;
    targetOwners?: Array<{
        login?: string;
        type?: string;
        available?: boolean;
        existingForkChecked?: boolean;
        existingFork?: { fullName?: string; inUseByAnotherAccount?: boolean };
    }>;
    blueprint?: { status?: string; id?: string };
    license?: { spdx?: string | null; class?: string; source?: string };
    scanIncomplete?: boolean;
}

interface CreatedView {
    status?: string;
    alreadyExisted?: boolean;
    appSource?: {
        relation?: string;
        readiness?: string;
        dataRepository?: { owner?: string; repo?: string; url?: string };
        upstream?: { owner?: string; repo?: string };
    };
    work?: { id?: string; kind?: string; slug?: string };
}

/** Inspect one URL and hand back both the status and the typed body. */
async function inspect(
    request: APIRequestContext,
    token: string,
    repositoryUrl: string,
): Promise<{ status: number; body: InspectView; text: string }> {
    const result = await inspectAppSource(request, {
        token,
        body: appSourceInspectBody({ repositoryUrl }),
    });
    return { status: result.status, body: (result.json ?? {}) as InspectView, text: result.text };
}

/** Create an App Work and hand back both the status and the typed body. */
async function createApp(
    request: APIRequestContext,
    token: string,
    body: Parameters<typeof appWorkCreateBody>[0],
): Promise<{ status: number; body: CreatedView; text: string }> {
    const result = await createAppWork(request, { token, body: appWorkCreateBody(body) });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

/** A create body for a run-unique repository, with the fields every case needs. */
function appCreateBody(input: {
    slugBase: string;
    repositoryUrl: string;
    repositoryMode: 'link' | 'fork' | 'private-copy';
    targetOwner?: string;
}): Parameters<typeof appWorkCreateBody>[0] {
    const slug = `${input.slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return {
        name: slug,
        slug,
        description: `APW-13 T30 ${input.slugBase}`,
        organization: false,
        repositoryUrl: input.repositoryUrl,
        repositoryMode: input.repositoryMode,
        ...(input.targetOwner ? { targetOwner: input.targetOwner } : {}),
    };
}

// ---------------------------------------------------------------------------
// ACC-E2E-01 — the preview, URL by URL
// ---------------------------------------------------------------------------

test.describe('ACC-E2E-01 — the App source preview the create form renders', () => {
    test('the preview reports push access, the three modes with their reasons, and the default', async ({
        request,
    }) => {
        const run = stamp();
        const forkable = { owner: UPSTREAM_OWNER, name: `apw13-t30-forkable-${run}` };
        const own = {
            owner: LANE_LOGIN,
            name: `apw13-t30-own-${run}`,
            permissions: [{ login: LANE_LOGIN, push: true, admin: true }],
        };
        // An archived repository the account CAN push to: the `archived` reason is only
        // reachable when it is not shadowed by `no_push_access`
        // (`contracts/src/apps/app-source.ts:504-508`, first-reason-wins).
        const archived = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-archived-${run}`,
            archived: true,
            permissions: [{ login: LANE_LOGIN, push: true }],
        };
        const noFork = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-nofork-${run}`,
            private: true,
            forkingAllowed: false,
        };
        // C11 — the two sides of the private-copy size cap (512000 KB,
        // `APP_PRIVATE_COPY_MAX_SIZE_KB`): the fake reports the seeded `sizeKb` as GitHub's
        // `size`, which is the value the cap is checked against.
        const small = { owner: UPSTREAM_OWNER, name: `apw13-t30-small-${run}`, sizeKb: 2048 };
        const tooLarge = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-toolarge-${run}`,
            sizeKb: 600000,
        };
        test.skip(
            !(await seedFakeGitHub(request, [forkable, own, archived, noFork, small, tooLarge])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to inspect in this run (the PR lane starts it beside the API).',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. A repository the account cannot push to: Fork is the default, Link is refused
        //    with the reason the form renders (ACC-E2E-01's "whether they can push … Fork
        //    with the right default").
        const forkableInspect = await inspect(request, user.access_token, repoUrl(forkable));
        expect(
            forkableInspect.status,
            `inspect ${repoUrl(forkable)} body=${forkableInspect.text.slice(0, 300)}`,
        ).toBe(200);
        expect(forkableInspect.body.repository?.fullName).toBe(
            `${forkable.owner}/${forkable.name}`,
        );
        expect(forkableInspect.body.access?.canPush, 'the account has no push access').toBe(false);
        expect(forkableInspect.body.modes?.link).toEqual({
            available: false,
            reason: 'no_push_access',
        });
        expect(forkableInspect.body.modes?.fork).toEqual({ available: true });
        expect(forkableInspect.body.defaultMode, 'Fork is pre-selected when Link is refused').toBe(
            'fork',
        );

        // 2. The account's OWN repository: Link is available and is the default, and Fork is
        //    refused as `own_repository`.
        const ownInspect = await inspect(request, user.access_token, repoUrl(own));
        expect(ownInspect.status, `body=${ownInspect.text.slice(0, 300)}`).toBe(200);
        expect(ownInspect.body.access, 'the fixture grants push and admin here').toMatchObject({
            canPush: true,
            canAdmin: true,
        });
        expect(ownInspect.body.modes?.link).toEqual({ available: true });
        expect(ownInspect.body.modes?.fork).toEqual({
            available: false,
            reason: 'own_repository',
        });
        expect(ownInspect.body.defaultMode, 'Link is pre-selected for a pushable non-fork').toBe(
            'link',
        );

        // 3. An archived repository: Link is refused with `archived` — the refusal whose
        //    copy ACC-E2E-01 quotes ("Archived repositories are read-only.").
        const archivedInspect = await inspect(request, user.access_token, repoUrl(archived));
        expect(archivedInspect.status, `body=${archivedInspect.text.slice(0, 300)}`).toBe(200);
        expect(archivedInspect.body.repository?.archived).toBe(true);
        expect(
            archivedInspect.body.modes?.link,
            'an archived repository is read-only even when the account can push',
        ).toEqual({ available: false, reason: 'archived' });
        expect(
            archivedInspect.body.modes?.fork,
            'Fork stays available for an archived repository the account does not own',
        ).toEqual({ available: true });

        // 4. A private repository whose owner disallows forking: Fork is refused with
        //    `forking_disabled` — the refusal whose copy ACC-E2E-01 quotes ("The owner of
        //    this repository doesn't allow forks or copies.").
        const noForkInspect = await inspect(request, user.access_token, repoUrl(noFork));
        expect(noForkInspect.status, `body=${noForkInspect.text.slice(0, 300)}`).toBe(200);
        expect(noForkInspect.body.repository?.allowForking).toBe(false);
        expect(noForkInspect.body.modes?.fork).toEqual({
            available: false,
            reason: 'forking_disabled',
        });
        // The copy half, with the case's own reason: since C11 the fake reports a size inside
        // the cap, so the size rule no longer answers first and the private repository that
        // disallows forks is refused `forking_disabled` for Private copy too.
        expect(
            noForkInspect.body.modes?.['private-copy']?.available,
            'Private copy is not offered for a repository its owner disallows copies of',
        ).toBe(false);
        expect(noForkInspect.body.modes?.['private-copy']).toEqual({
            available: false,
            reason: 'forking_disabled',
        });
        expect(
            noForkInspect.body.defaultMode,
            'nothing is pre-selected when neither Link nor Fork is available',
        ).toBeNull();

        // 5. Private copy and its size cap (C11). A small public repository the account
        //    cannot push to offers Private copy beside Fork; one above the 512000 KB cap is
        //    refused `too_large_for_private_copy` while Fork, which the size never affects,
        //    stays available.
        const smallInspect = await inspect(request, user.access_token, repoUrl(small));
        expect(smallInspect.status, `body=${smallInspect.text.slice(0, 300)}`).toBe(200);
        expect(
            smallInspect.body.modes?.['private-copy'],
            'a 2048 KB repository is inside the private-copy cap',
        ).toEqual({ available: true });
        expect(smallInspect.body.modes?.fork).toEqual({ available: true });

        const tooLargeInspect = await inspect(request, user.access_token, repoUrl(tooLarge));
        expect(tooLargeInspect.status, `body=${tooLargeInspect.text.slice(0, 300)}`).toBe(200);
        expect(
            tooLargeInspect.body.modes?.['private-copy'],
            'a 600000 KB repository is above the 512000 KB private-copy cap',
        ).toEqual({ available: false, reason: 'too_large_for_private_copy' });
        expect(
            tooLargeInspect.body.modes?.fork,
            'the size cap is a private-copy rule only',
        ).toEqual({ available: true });

        // 6. The licence preview is read from the provider, and its `spdx` is the fixture's.
        //    The CLASS is APW-03's (see the `fixme` below); the SPDX is not.
        const licensed = await inspect(
            request,
            user.access_token,
            'https://github.com/ever-works/umami-template',
        );
        expect(licensed.status, `body=${licensed.text.slice(0, 300)}`).toBe(200);
        expect(licensed.body.license?.spdx, 'the fixture licence is MIT').toBe('MIT');
        expect(licensed.body.license?.source, 'nothing is persisted before a create').toBe(
            'detected',
        );
    });

    test('the inspect writes nothing: the fake records no mutating GitHub call for it', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t30-nowrite-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'zero-write proof cannot be read in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const before = await fakeGitHubCalls(request);
        expect(before, 'the fake answers /_control/calls in this lane').not.toBeNull();

        for (const url of [
            repoUrl(repo),
            `https://github.com/${LANE_LOGIN}/templates`,
            'https://github.com/ever-works/umami-template',
        ]) {
            const result = await inspect(request, user.access_token, url);
            expect(result.status, `inspect ${url} body=${result.text.slice(0, 300)}`).toBe(200);
        }

        const after = (await fakeGitHubCalls(request)) ?? [];
        // Filtered on THIS run's paths: the call log is shared with every other spec in the
        // shard, so a whole-log count would compare two different worlds (the trap T15's
        // spec documents).
        const repoWrites = writesMatching(after, fakePath(repo.owner, repo.name));
        const accountWrites = [...writesAt(after, '/user'), ...writesAt(after, '/user/orgs')];
        expect(
            repoWrites.length,
            `an inspect is a read: the fake must record no write against the repository ` +
                `(writes=${JSON.stringify(repoWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);
        expect(
            accountWrites.length,
            `an inspect is a read: the fake must record no write against the account ` +
                `(writes=${JSON.stringify(accountWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);
    });

    test('a GitLab URL, a URL with no repository and a malformed URL are refused 400 invalid_url', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        for (const repositoryUrl of [
            'https://gitlab.com/group/project',
            'https://github.com/ever-works',
            'not a url at all',
        ]) {
            const result = await inspect(request, user.access_token, repositoryUrl);
            expect(
                result.status,
                `inspect ${repositoryUrl} body=${result.text.slice(0, 300)}`,
            ).toBe(400);
            expect(
                result.text,
                'the refusal is the documented `invalid_url` code, not a field list',
            ).toContain('"code":"invalid_url"');
        }
    });

    test('an existing fork of the upstream is announced in the preview', async ({ request }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t30-hasfork-${run}` };
        const fork = {
            owner: LANE_LOGIN,
            name: `apw13-t30-hasfork-${run}`,
            fork: true,
            parentFullName: `${upstream.owner}/${upstream.name}`,
            sourceFullName: `${upstream.owner}/${upstream.name}`,
            permissions: [{ login: LANE_LOGIN, push: true, admin: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [upstream, fork])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'existing-fork preview cannot be read in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const result = await inspect(request, user.access_token, repoUrl(upstream));
        expect(result.status, `body=${result.text.slice(0, 300)}`).toBe(200);

        const mine = (result.body.targetOwners ?? []).find(
            (owner) => owner.login?.toLowerCase() === LANE_LOGIN,
        );
        expect(mine, 'the caller is the first owner offered').toBeTruthy();
        expect(mine?.existingForkChecked, 'the owner scan reached this account').toBe(true);
        expect(
            mine?.existingFork?.fullName,
            'ACC-NEG-08: "You already have a fork: {fullName}. Ever Works will use it."',
        ).toBe(`${LANE_LOGIN}/${fork.name}`);
        expect(
            mine?.existingFork?.inUseByAnotherAccount,
            'the only Work on that fork is the caller’s own (none exists yet)',
        ).toBe(false);
    });

    /**
     * The Blueprint id and the licence class ACC-E2E-01's assertion list names.
     *
     * Measured 2026-09-19: `APP_SOURCE_CATALOG_PORT` had no provider anywhere, so the
     * inspector's catalog read answered `blueprint: { status: 'unavailable' }` — which its
     * own contract defines as "the catalog could not be consulted at all, never 'no
     * match'" — and `license: { class: 'unknown', source: 'detected' }` for every
     * repository, including `ever-works/umami-template`, whose id the fake's Blueprint list
     * carries (`umami`). Since APW-03 T26 the port is bound, and three things still keep
     * this case from running here: the lane gives the platform no GitHub credential for
     * the ever-works catalog (so the answer is still `unavailable` / `unknown`); a Blueprint
     * match is held back until the apply service (T28) is bound; and the manifest lookup
     * that names `umami` for this repository is not implemented yet (T24/T26 — the probe
     * path would look for `ever-works/umami-template-template`). The assertions stay
     * exactly as the case words them.
     */
    test.fixme(
        'APW-03: the Blueprint preview and the licence class need a platform catalog ' +
            'credential in this lane, the Blueprint apply service (T28) and the manifest lookup ' +
            '(T24/T26) — the catalog port is bound since T26, and every inspect here still ' +
            'answers blueprint.status "unavailable" and license.class "unknown" (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            test.skip(
                !(await seedFakeGitHub(request)),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);

            const matched = await inspect(
                request,
                user.access_token,
                'https://github.com/ever-works/umami-template',
            );
            expect(matched.status).toBe(200);
            expect(
                matched.body.blueprint?.status,
                'the fixture lists a Blueprint for this repository (`umami`)',
            ).toBe('matched');
            expect(matched.body.blueprint?.id).toBe('umami');
            expect(matched.body.license?.class, 'MIT is green in the fixture catalog').toBe(
                'green',
            );
            expect(matched.body.license?.source).toBe('blueprint');
        },
    );
});

// ---------------------------------------------------------------------------
// ACC-NEG-08 — conflicts on create
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-08 — conflicts on create', () => {
    test("another account's App Work refuses Link with 409 in_use_by_another_account, and Fork is still offered", async ({
        request,
    }) => {
        const run = stamp();
        // A repository owned by someone else, which the run account may push to. Both
        // halves of the case need that combination: the FIRST account must be able to LINK
        // it, and the SECOND account's Fork must still be available — which it is not for a
        // repository the fake login owns (`own_repository`).
        const repo = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-conflict-${run}`,
            permissions: [{ login: LANE_LOGIN, push: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'cross-account conflict cannot be set up in this run.',
        );

        // 1. The first account links the repository: one App Work, and the repository is
        //    now in use.
        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const created = await createApp(
            request,
            owner.access_token,
            appCreateBody({
                slugBase: 'apw13-t30-conflict',
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        );
        expect(created.status, `first link body=${created.text.slice(0, 300)}`).toBe(200);
        expect(created.body.work?.id, 'the first App Work exists').toBeTruthy();
        const firstWorkId = created.body.work?.id ?? '';
        const firstSlug = created.body.work?.slug ?? '';

        // 2. A second account sees Link refused with the conflict code, and Fork offered.
        const stranger = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, stranger.access_token);
        const strangerInspect = await inspect(request, stranger.access_token, repoUrl(repo));
        expect(strangerInspect.status, `body=${strangerInspect.text.slice(0, 300)}`).toBe(200);
        expect(
            strangerInspect.body.modes?.link,
            'another account’s App Work on this repository refuses Link',
        ).toEqual({ available: false, reason: 'in_use_by_another_account' });
        expect(
            strangerInspect.body.modes?.fork,
            'Fork is still offered — the way out the case names',
        ).toEqual({ available: true });

        // 3. The create is refused with the same code, and the refusal carries the
        //    repository (never the other account's Work).
        const before = (await fakeGitHubCalls(request)) ?? [];
        const refused = await createApp(
            request,
            stranger.access_token,
            appCreateBody({
                slugBase: 'apw13-t30-stranger',
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        );
        expect(refused.status, `second account’s link body=${refused.text.slice(0, 300)}`).toBe(
            409,
        );
        expect(refused.text).toContain('"code":"in_use_by_another_account"');
        expect(refused.text).toContain(`${repo.owner}/${repo.name}`);
        expect(
            refused.text.includes(firstWorkId),
            'the refusal names the repository, never another account’s Work',
        ).toBe(false);

        // 4. "The fake GitHub recorded no write" — for THIS run-unique repository path.
        const after = (await fakeGitHubCalls(request)) ?? [];
        const newWrites = writesMatching(
            after.slice(before.length),
            fakePath(repo.owner, repo.name),
        );
        expect(
            newWrites.length,
            `a refused create writes nothing to GitHub ` +
                `(writes=${JSON.stringify(newWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);

        // 5. "The first App Work is unchanged."
        const first = await request.get(`${API_BASE}/api/works/${firstWorkId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(first.status(), `the first Work is still readable (${first.status()})`).toBe(200);
        const firstBody = (await first.json()) as { work?: { slug?: string; kind?: string } };
        expect(firstBody.work?.slug).toBe(firstSlug);
        expect(firstBody.work?.kind).toBe('app');
    });

    test('the same account on the same repository with another slug is refused 409 app_work_exists', async ({
        request,
    }) => {
        const run = stamp();
        const repo = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-exists-${run}`,
            permissions: [{ login: LANE_LOGIN, push: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'same-account conflict cannot be set up in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const first = await createApp(
            request,
            user.access_token,
            appCreateBody({
                slugBase: 'apw13-t30-first',
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        );
        expect(first.status, `first link body=${first.text.slice(0, 300)}`).toBe(200);

        const second = await createApp(
            request,
            user.access_token,
            appCreateBody({
                slugBase: 'apw13-t30-second',
                repositoryUrl: repoUrl(repo),
                repositoryMode: 'link',
            }),
        );
        expect(second.status, `same account, another slug body=${second.text.slice(0, 300)}`).toBe(
            409,
        );
        expect(second.text).toContain('"code":"app_work_exists"');
        expect(
            second.text,
            'the refusal names the caller’s own Work — never another account’s',
        ).toContain(first.body.work?.id ?? 'the-work-id-is-missing');
    });

    test('an existing fork of the upstream is adopted with no fork request', async ({
        request,
    }) => {
        const run = stamp();
        const upstream = { owner: UPSTREAM_OWNER, name: `apw13-t30-adopt-${run}` };
        const fork = {
            owner: LANE_LOGIN,
            name: `apw13-t30-adopt-${run}`,
            fork: true,
            parentFullName: `${upstream.owner}/${upstream.name}`,
            sourceFullName: `${upstream.owner}/${upstream.name}`,
            permissions: [{ login: LANE_LOGIN, push: true, admin: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [upstream, fork])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'adoption cannot be set up in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const before = (await fakeGitHubCalls(request)) ?? [];
        const created = await createApp(
            request,
            user.access_token,
            appCreateBody({
                slugBase: 'apw13-t30-adopt',
                repositoryUrl: repoUrl(upstream),
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
            }),
        );
        expect(
            created.status,
            `fork with an existing fork body=${created.text.slice(0, 300)}`,
        ).toBe(200);
        expect(
            created.body.appSource?.dataRepository?.owner,
            'the Work’s repository IS the existing fork, not a second one',
        ).toBe(LANE_LOGIN);
        expect(created.body.appSource?.dataRepository?.repo).toBe(fork.name);
        expect(created.body.appSource?.upstream).toMatchObject({
            owner: upstream.owner,
            repo: upstream.name,
        });

        const after = (await fakeGitHubCalls(request)) ?? [];
        const forkRequests = after
            .slice(before.length)
            .filter(
                (call) =>
                    (call.method ?? '').toUpperCase() === 'POST' &&
                    call.path === `/repos/${upstream.owner}/${upstream.name}/forks`,
            );
        expect(
            forkRequests.length,
            'ACC-NEG-08: an existing fork is adopted with NO fork request ' +
                `(requests=${JSON.stringify(forkRequests.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(0);
    });

    /**
     * ACC-NEG-08's idempotent half: "an identical request within 10 minutes → `200` with
     * `alreadyExisted: true` (APW-01 FR-23–FR-26)".
     *
     * This was a `fixme` until C9. Measured twice on the lane's own API (2026-09-19), for a
     * fork create and a link create, the identical request answered **`409`**
     * `A Work with the slug "<slug>" already exists. Choose another slug.`: the slug check
     * (create step 5) ran before the FR-23 idempotent lookup (step 8), so the request FR-23
     * is meant to answer was refused one step earlier. Step 5 now defers that refusal when
     * the slug's holder is the caller's own App Work created inside the window, and step 8
     * answers it. The assertions are the ones the marker carried, unchanged.
     *
     * The repository grants the run account push: the case LINKS it, and Link without push
     * is refused `no_push_access` at the FIRST create (`contracts/src/apps/app-source.ts`,
     * `resolveAppRepositoryModes`), which the marker hid — the body as it stood could never
     * create the Work the identical request is about.
     */
    test('an identical create inside ten minutes answers 200 alreadyExisted with the same App Work (FR-23)', async ({
        request,
    }) => {
        const run = stamp();
        const repo = {
            owner: UPSTREAM_OWNER,
            name: `apw13-t30-idem-${run}`,
            permissions: [{ login: LANE_LOGIN, push: true }],
        };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
        );
        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const body = appCreateBody({
            slugBase: 'apw13-t30-idem',
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'link',
        });
        const first = await createApp(request, user.access_token, body);
        expect(first.status, `body=${first.text.slice(0, 300)}`).toBe(200);

        const identical = await createApp(request, user.access_token, body);
        expect(identical.status, `identical request body=${identical.text.slice(0, 300)}`).toBe(
            200,
        );
        expect(identical.body.alreadyExisted).toBe(true);
        expect(identical.body.work?.id).toBe(first.body.work?.id);
    });
});
