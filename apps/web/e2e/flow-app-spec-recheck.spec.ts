/**
 * APW-03 T19 — Re-check, and who may press it (ACC-03-13, ACC-03-41; plan §10.3:881, plan §5.3).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-03-13** (`spec.md:679`):
 *
 * > Three Re-check presses within 5 seconds run one evaluation; the 7th press in a minute is refused.
 *
 * **ACC-03-41** (`spec.md:719`):
 *
 * > A viewer sees no Re-check, upgrade or attestation controls; another account's Work id answers
 * > not found on every endpoint.
 *
 * ## Measured on this lane (2026-09-19) — the one fact everything below follows from
 *
 * `POST /api/works/:id/app-spec/validate { source: 'branch' }` is Re-check. On this lane it
 * **never records a request**, because there is no `work_app_spec_states` row to record it against:
 * the route's own guard is `requested.requested === false ⇒ 404`
 * (`work-app-spec.controller.ts:381-383`), and nothing in the shipped runtime inserts that row
 * (`AppSpecService.initialize`, `app-spec.service.ts:352-358`, has no caller in `apps/api/src` or
 * `packages/agent/src`, and the built `apps/api/dist` has none either). Measured, for an App Work
 * this file created through `POST /api/works`:
 *
 * | caller          | `GET …/app-spec`                       | `POST …/validate {source:'branch'}`   |
 * | --------------- | -------------------------------------- | ------------------------------------- |
 * | the owner       | `404 not_found` "has no App spec state yet." | `404 not_found` "has no App spec state yet." |
 * | a real viewer   | `404 not_found` "has no App spec state yet." | `404 not_found` "Work <id> not found." |
 * | a stranger      | `404 not_found` "Work <id> not found." | `404 not_found` "Work <id> not found." |
 *
 * So ACC-03-13's **coalescing** half (`202 { evaluationPending: true }`, three presses ⇒ one
 * evaluation) is unreachable here — nothing is ever recorded, so nothing can coalesce — while its
 * **throttle** half is real and is asserted: the per-Work allowance of 6/min is taken *before*
 * `requestEvaluation` (`work-app-spec.controller.ts:364`), so the 7th press answers the platform's
 * `429` whether or not there is a row to record it against. The `Checking…` UI state
 * (`AppSpecPageClient.tsx:139`, the optimistic `evaluationPending`) is likewise unreachable: the
 * banner it lives in never mounts — `flow-app-spec-settings.spec.ts` pins that, and its two
 * `test.fixme` cases carry the same blocker.
 *
 * ACC-03-41 is exercised on **both** halves that exist here:
 *
 *   - the server half, in full — the three rows of the table above are three *different* facts and
 *     each is asserted by its own literal: the owner reaches the state read and is refused only by
 *     the missing row; a **real viewer member** (`POST /api/works/:id/members { role: 'viewer' }`,
 *     read back as `userRole: 'viewer'`) reaches the read but is refused the Re-check **write** with
 *     the same not-found a stranger gets, which is what "a viewer sees no Re-check" means
 *     server-side; and another account's Work answers not found on **every** endpoint of the epic,
 *     `GET` and both `validate` sources;
 *   - the browser half, with a real viewer session — the lane's browser is the **seeded** user
 *     (`playwright.config.ts:102`), so this file makes that user the *viewer* of an App Work owned
 *     by a throwaway account, as `flow-work-sharing-visibility.spec.ts:465-505` does — and asserts
 *     the tab's page renders no Re-check control. That assertion is honest but **vacuous on this
 *     lane**: no role, the owner included, sees the control, because the page is a not-found for
 *     everyone until the state row exists. It is written this way rather than skipped because the
 *     absence *is* the shipped behaviour, and its vacuity is named in the test's own message.
 *
 * ## The control that makes the refusals mean something
 *
 * The very same route answers `200` for `{ source: 'content' }` — a draft validation of the
 * `schema.md` §24.1 example — which proves the route is mounted, the validator runs and this App
 * Work is a real App Work. Without that control, "Re-check answers 404" could be read as a missing
 * route rather than as a missing state row.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { appWorkCreateBody, createAppWork } from './helpers/app-works';
import { connectCustomerGitHub } from './helpers/github-connection';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * This file's cases share one App Work and run **one at a time**: `playwright.config.ts:38` sets
 * `fullyParallel: true`, and the Work is created through the same API process and the same
 * in-memory SQLite. In CI the shard already runs `PLAYWRIGHT_WORKERS=1`
 * (`playwright.config.ts:49-53`), where this setting is a no-op. No assertion is weakened by it.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where this file's repository fixture is seeded. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives every account this lane attaches. */
const LANE_LOGIN = 'apw-e2e-user';

/** The tab's own address, exactly as `ROUTES.DASHBOARD_WORK_SETTINGS_APP_SPEC` builds it. */
function appSpecHref(workId: string): string {
    return `/works/${workId}/settings/app-spec`;
}

/**
 * The two `404 not_found` messages that are the whole of the visibility story on this lane
 * (`work-app-spec.controller.ts:408-441`, `:444-449`). They are the only place a caller can tell
 * "you may not touch this Work" from "this Work has no App spec state yet", because `404` is also
 * the answer for a Work that does not exist at all.
 */
function workNotFound(workId: string): string {
    return `Work ${workId} not found.`;
}

function noStateRow(workId: string): string {
    return `Work ${workId} has no App spec state yet.`;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// The Work under test, and the three callers
// ---------------------------------------------------------------------------

interface Caller {
    token: string;
    /** The Work's own role for this caller, as the API reports it (`GET /api/works`). */
    role: string;
}

interface RecheckFixtures {
    /** The Work ACC-03-41 is about, and the one the viewer's browser visits. */
    workId: string;
    /**
     * A second App Work of the same owner, used **only** by ACC-03-13's throttle case.
     *
     * Re-check's per-Work allowance is `branch:<workId>`, 6 per minute
     * (`work-app-spec.controller.ts:364`), and it is taken whether or not the request is recorded —
     * so the seventh press spends that Work's window for *every* caller, the viewer included. The
     * cases above need their own presses to mean what they say, so they get a Work whose window is
     * untouched.
     */
    throttleWorkId: string;
    owner: Caller;
    viewer: Caller;
    stranger: Caller;
}

let fixtures: RecheckFixtures | null = null;

/**
 * One retry for a **transport** failure, and only for the idempotent reads below.
 *
 * A red on this lane is a stack question before it is a spec question, and the stack is shared:
 * every worker and every agent's spec file talks to the same API process, so a keep-alive socket can
 * be reset under a read that never reached a handler. Measured once on the sibling file
 * (`read ECONNRESET` from `apiRequestContext.get`, 2026-09-19) against an API that answered
 * `200 {"status":"success","message":"API is up and running"}` before and after, on the same pid.
 *
 * A transport failure is not an answer from the product, so retrying it weakens nothing: the retried
 * attempt must still produce the exact status and body asserted below, and a second failure
 * propagates as a red. The POSTs are deliberately **not** wrapped — Re-check is counted by a
 * per-Work throttle and the case below counts presses, so re-sending one would change what it
 * measures.
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

/** `GET /api/works?limit=…`, reduced to one Work's row. */
async function workRole(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<string> {
    const res = await readWithTransportRetry(() =>
        request.get(`${API_BASE}/api/works?limit=200`, {
            headers: authedHeaders(token),
            failOnStatusCode: false,
        }),
    );
    expect(res.status(), `GET /api/works answered ${res.status()}`).toBe(200);
    const rows = ((await res.json()) as { works?: Array<{ id?: string; userRole?: string }> })
        .works;
    return (rows ?? []).find((row) => row.id === workId)?.userRole ?? '';
}

/** The seeded user — the lane's browser session, and this file's **viewer**. */
async function seededCredentials(): Promise<{ email: string; password: string }> {
    const seeded = loadSeededTestUser();
    return { email: seeded.email, password: seeded.password };
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email, password },
    });
    expect(res.status(), `login ${email} body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
}

/** The fake's PR-lane catalog, located from the working directory (lane or repo root). */
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
 * The Work, its **owner** (a throwaway account this file registers — so the seeded user can be the
 * *viewer*), a **stranger** that never appears in its membership, and the viewer's own membership
 * proven through the API before any UI claim is made.
 */
async function ensureFixtures(request: APIRequestContext): Promise<RecheckFixtures> {
    if (fixtures) return fixtures;

    const run = stamp();
    const seeded = await seededCredentials();
    const viewerToken = await login(request, seeded.email, seeded.password);

    const owner = await registerUserViaAPI(request);
    const stranger = await registerUserViaAPI(request);

    // The fake needs the repository this Work forks — and the lane identity the platform's Git
    // calls are attributed to (the same fixture `flow-app-work-delete-retains.spec.ts:190-209`
    // seeds from).
    const fixture = fakeSeedFixturePath();
    expect(
        fixture,
        'the checked-in fake GitHub seed fixture must exist for this lane to have a repository to ' +
            'fork',
    ).not.toBeNull();
    if (fixture === null) throw new Error('unreachable: the fixture path was just asserted');
    const seed = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
    /**
     * One upstream repository **per Work**, and not one shared between them: the fork the platform
     * creates takes its name from the upstream repository, so two Works forked from one repository
     * collide with `409 app_work_exists` on the second create (measured 2026-09-19 — the two
     * creates below are that reproduction).
     */
    const upstreams = ['recheck', 'throttle'].map((label) => ({
        owner: 'apw-e2e-upstream',
        name: `t19-${label}-${run}`,
    }));
    const seededFake = await request.post(`${FAKE_GITHUB_URL}/_control/seed`, {
        data: {
            ...seed,
            repositories: [...((seed.repositories as unknown[]) ?? []), ...upstreams],
        },
    });
    expect(
        seededFake.ok(),
        `the fake GitHub at ${FAKE_GITHUB_URL} must answer /_control/seed — without it there is no ` +
            'repository to fork and no App Work to read (the PR lane starts it beside the API).',
    ).toBe(true);

    await connectCustomerGitHub(request, owner.access_token);

    const createWork = async (label: string): Promise<string> => {
        const slug = `t19-${label}-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const upstream = upstreams.find((repo) => repo.name === `t19-${label}-${run}`);
        expect(upstream, `this run seeded an upstream repository for "${label}"`).toBeTruthy();
        const created = await createAppWork(request, {
            token: owner.access_token,
            body: appWorkCreateBody({
                name: slug,
                slug,
                description: `APW-03 T19 ACC-03-13/ACC-03-41 (${label})`,
                organization: false,
                repositoryUrl: `https://github.com/${upstream?.owner}/${upstream?.name}`,
                repositoryMode: 'fork',
                targetOwner: LANE_LOGIN,
                autoProvision: false,
            }),
        });
        expect(created.status, `app create body=${created.text.slice(0, 400)}`).toBe(200);
        const id = (created.json as { work?: { id?: string } })?.work?.id ?? '';
        expect(id, 'the create answers a Work id').not.toBe('');
        return id;
    };

    const workId = await createWork('recheck');
    const throttleWorkId = await createWork('throttle');

    // The viewer, added synchronously — `201` and a member row, the idiom
    // `flow-activity-org-audit.spec.ts:131-148` records.
    for (const id of [workId, throttleWorkId]) {
        const member = await request.post(`${API_BASE}/api/works/${id}/members`, {
            headers: authedHeaders(owner.access_token),
            data: { email: seeded.email, role: 'viewer' },
        });
        expect(
            member.status(),
            `invite ${seeded.email} as viewer on ${id}: ${await member.text().catch(() => '')}`,
        ).toBe(201);
    }

    fixtures = {
        workId,
        throttleWorkId,
        owner: {
            token: owner.access_token,
            role: await workRole(request, owner.access_token, workId),
        },
        viewer: { token: viewerToken, role: await workRole(request, viewerToken, workId) },
        stranger: {
            token: stranger.access_token,
            role: await workRole(request, stranger.access_token, workId),
        },
    };
    return fixtures;
}

// ---------------------------------------------------------------------------
// The two endpoints, and Re-check's verb
// ---------------------------------------------------------------------------

interface Answer {
    status: number;
    body: Record<string, unknown>;
}

/** `GET /api/works/:id/app-spec` — the read, wrapped in the transport retry above. */
async function getAppSpec(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<Answer> {
    const res = await readWithTransportRetry(() =>
        request.get(`${API_BASE}/api/works/${workId}/app-spec`, {
            headers: authedHeaders(token),
            failOnStatusCode: false,
        }),
    );
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/**
 * **Re-check**, exactly as `recheckAppSpecAction` sends it (`actions/dashboard/app-spec.ts:84`).
 *
 * Deliberately **not** retried: every press spends one of the Work's six-per-minute allowances, so a
 * silent re-send would change what the throttle case counts.
 */
async function recheck(request: APIRequestContext, token: string, workId: string): Promise<Answer> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/app-spec/validate`, {
        headers: authedHeaders(token),
        data: { source: 'branch' },
        failOnStatusCode: false,
    });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** A draft validation of arbitrary text — `source: 'content'`, which stores nothing. */
async function validateDraft(
    request: APIRequestContext,
    token: string,
    workId: string,
    content: string,
): Promise<Answer> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/app-spec/validate`, {
        headers: authedHeaders(token),
        data: { source: 'content', content },
        failOnStatusCode: false,
    });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/**
 * The `schema.md` §24.1 example, read out of the normative document rather than re-typed here, so
 * this file cannot drift from it. Returns the fenced YAML block under the §24.1 heading.
 */
function schemaExample(): string {
    const candidates = [
        'docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md',
        '../../docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md',
    ];
    const path = candidates.find((candidate) => existsSync(candidate));
    expect(path, `schema.md must be readable from ${process.cwd()}`).toBeTruthy();
    if (!path) throw new Error('unreachable: the schema path was just asserted');

    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const heading = lines.findIndex((line) => line.startsWith('### 24.1'));
    expect(heading, 'schema.md has a §24.1 heading').toBeGreaterThan(-1);
    const fence = lines.findIndex((line, index) => index > heading && /^```ya?ml/.test(line));
    expect(fence, '§24.1 opens a yaml fence').toBeGreaterThan(heading);
    const close = lines.findIndex((line, index) => index > fence && /^```\s*$/.test(line));
    expect(close, '§24.1 closes its yaml fence').toBeGreaterThan(fence);

    const yaml = lines.slice(fence + 1, close).join('\n');
    expect(yaml, 'the §24.1 example is the App spec document').toContain('kind: app');
    return yaml;
}

// ---------------------------------------------------------------------------
// ACC-03-13 — Re-check: what is recorded, and what is refused
// ---------------------------------------------------------------------------

test('ACC-03-13 — three Re-check presses inside 5 s record nothing (three identical 404s, never the 202), and the 7th press in a minute is refused with 429', async ({
    request,
}) => {
    const { throttleWorkId, owner } = await ensureFixtures(request);

    // 1. Seven presses on a Work whose allowance no other case has touched. The case's own
    //    arithmetic — "three presses within 5 seconds run one evaluation" — needs a recorded
    //    request to coalesce, and on this lane no press is recorded: the answer is the read's own
    //    `404` every time, and `evaluationPending` is never claimed
    //    (`work-app-spec.controller.ts:376-385`).
    const bodies: string[] = [];
    for (let press = 1; press <= 7; press += 1) {
        const answer = await recheck(request, owner.token, throttleWorkId);

        if (press <= 3) {
            // The three presses of the case's own window: identical, and none of them a `202`.
            expect(
                answer.status,
                `press ${press} of 3 answered ${answer.status}: ${JSON.stringify(answer.body)}`,
            ).toBe(404);
            expect(answer.body.code, 'no press is refused for any other reason').toBe('not_found');
            expect(answer.body.message).toBe(noStateRow(throttleWorkId));
            expect(
                answer.body.evaluationPending,
                `press ${press}: a 404 can never carry \`evaluationPending\` — only a recorded ` +
                    'request answers 202 with it',
            ).toBeUndefined();
            bodies.push(JSON.stringify(answer.body));
            continue;
        }

        // 2. The 7th press in a minute. The per-Work allowance of 6 is taken **before**
        //    `requestEvaluation` (`work-app-spec.controller.ts:364`), so this half of ACC-03-13
        //    holds on this lane and is asserted rather than described: presses 4-6 stay `404`,
        //    press 7 is the platform's own `429`.
        if (press <= 6) {
            expect(answer.status, `press ${press} is still inside the 6-per-minute allowance`).toBe(
                404,
            );
            continue;
        }

        expect(
            answer.status,
            `the 7th press in a minute must be refused (body=${JSON.stringify(answer.body)})`,
        ).toBe(429);
        expect(answer.body.message, 'Nest’s own throttler body').toMatch(/throttl/i);
    }

    expect(
        new Set(bodies).size,
        'the three presses inside the window are the same answer: nothing was recorded, so nothing ' +
            'coalesced',
    ).toBe(1);

    // 3. None of the seven presses changed the state read.
    const after = await getAppSpec(request, owner.token, throttleWorkId);
    expect(after.status).toBe(404);
    expect(after.body.message).toBe(noStateRow(throttleWorkId));
});

test('ACC-03-13 (control) — the same route answers 200 for a draft validation, so the 404s above are the missing state row, not a missing route', async ({
    request,
}) => {
    const { workId, owner } = await ensureFixtures(request);

    // `{ source: 'content' }` is a **view** of text the member holds: it stores nothing
    // (`work-app-spec.controller.ts:338-361`, ACC-03-08), so it needs no state row and it works.
    const verdict = await validateDraft(request, owner.token, workId, schemaExample());
    expect(
        verdict.status,
        `draft validation body=${JSON.stringify(verdict.body).slice(0, 400)}`,
    ).toBe(200);
    expect(verdict.body.workId).toBe(workId);

    // §24.1 is the program's running example, and ACC-03-01 asks it to validate with **zero
    // errors**. Measured on this lane: `valid_with_warnings`, `errorCount: 0`, one warning —
    // R11 (`secret_build_arg`) on the build argument the example itself annotates as accepted
    // (`schema.md:571`). That verdict is exactly §6.2's *valid with warnings* state; what this lane
    // cannot do is **store** it, which is why the banner itself is `flow-app-spec-settings.spec.ts`'s
    // blocker and not this file's.
    expect(verdict.body.status).toBe('valid_with_warnings');
    expect(verdict.body.errorCount).toBe(0);
    expect(verdict.body.warningCount).toBe(1);
    expect(verdict.body.truncated).toBe(false);
    const issues = (verdict.body.issues ?? []) as Array<{ code?: string; line?: number }>;
    expect(issues.map((issue) => issue.code)).toEqual(['secret_build_arg']);
    expect(issues[0]?.line, 'the warning carries the line the problems list would link to').toBe(
        21,
    );

    // And the state read is *still* the 404: a draft validation writes nothing.
    const state = await getAppSpec(request, owner.token, workId);
    expect(state.status).toBe(404);
    expect(state.body.message).toBe(noStateRow(workId));
});

// ---------------------------------------------------------------------------
// ACC-03-41 — the viewer, and another account
// ---------------------------------------------------------------------------

test('ACC-03-41 — a real viewer may read but is refused the Re-check write, and another account’s Work id answers not found on every endpoint', async ({
    request,
}) => {
    const { workId, owner, viewer, stranger } = await ensureFixtures(request);

    // The three callers are what the case says they are: the owner owns the Work, the seeded user
    // is a **viewer** member of it, and the stranger's own read of the Works list has no row for
    // this Work at all.
    expect(owner.role, 'the Work’s owner').toBe('owner');
    expect(viewer.role, 'a real viewer membership, not a mocked permission').toBe('viewer');
    expect(stranger.role, 'a stranger sees no row for this Work').toBe('');

    // 1. The read: view for every member — the viewer reaches the Work, and the only thing that
    //    refuses the answer is the missing state row.
    const viewerRead = await getAppSpec(request, viewer.token, workId);
    expect(viewerRead.status).toBe(404);
    expect(viewerRead.body.message).toBe(noStateRow(workId));

    // 2. Re-check is `{ source: 'branch' }`, which plan §4.1:548 makes an **edit** of the Work's
    //    spec state — so a viewer is refused by the access gate, and the refusal is the same
    //    `404 not_found` a stranger gets, never a `403` that would confirm the Work exists
    //    (`work-app-spec.controller.ts:408-441`).
    const viewerRecheck = await recheck(request, viewer.token, workId);
    expect(viewerRecheck.status, 'a viewer may not re-check').toBe(404);
    expect(viewerRecheck.body.message).toBe(workNotFound(workId));

    // The owner presses the same verb and passes that gate: the difference between these two
    // bodies is the access level, which is the whole point of the pair.
    const ownerRecheck = await recheck(request, owner.token, workId);
    expect(ownerRecheck.status).toBe(404);
    expect(ownerRecheck.body.message).toBe(noStateRow(workId));

    // 3. "another account's Work id answers not found on every endpoint" — all three of this
    //    epic's calls, and none of them distinguishes this Work from one that does not exist.
    const strangerRead = await getAppSpec(request, stranger.token, workId);
    expect(strangerRead.status).toBe(404);
    expect(strangerRead.body.message).toBe(workNotFound(workId));

    const strangerRecheck = await recheck(request, stranger.token, workId);
    expect(strangerRecheck.status).toBe(404);
    expect(strangerRecheck.body.message).toBe(workNotFound(workId));

    // `{ source: 'content' }` is a view, and the view gate refuses a non-member just the same.
    const strangerDraft = await validateDraft(request, stranger.token, workId, 'kind: app');
    expect(strangerDraft.status).toBe(404);
    expect(strangerDraft.body.message).toBe(workNotFound(workId));
});

test('ACC-03-41 — the viewer’s browser session: the settings root withholds itself (measured), the tab’s page holds no Re-check control for anyone, and the viewer’s real refusal is the API’s', async ({
    page,
    request,
}) => {
    const { workId, viewer } = await ensureFixtures(request);
    expect(viewer.role, 'the browser’s session is the viewer of this Work').toBe('viewer');

    // 1. The page the tab strip lives on. `SettingsSubTabs` is rendered by
    //    `settings/layout.tsx`, and that layout sits above `settings/page.tsx` — whose own gate is
    //    `canAccessSettings(work.userRole)` (`settings/page.tsx:31-34`), i.e. **manager or higher**
    //    (`lib/permissions.ts:13-18`). A viewer is the lowest of four roles, so that page calls
    //    `notFound()`, and the app's nearest not-found boundary is at the locale root: it replaces
    //    the whole tree, tab strip included. Measured 2026-09-19 — the 404 renders with no
    //    `nav[aria-label="Settings tabs"]` at all, and no `App spec` link anywhere in the document.
    //
    //    That is a **disagreement with this epic's own design**, reported rather than smoothed over:
    //    plan §5.1:604 withholds the tab on **kind** alone, `SettingsSubTabs.tsx:68-72` gates it on
    //    `work.kind === 'app'` alone, and the App spec page itself records "No role gate,
    //    deliberately — FR-76 requires a **viewer** to be able to read the App spec"
    //    (`app-spec/page.tsx:34-40`). The settings root's manager gate makes that unreachable in the
    //    UI: the API would serve a viewer the read (asserted above), and the browser will not take
    //    them to it.
    await page.goto(`/works/${workId}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
        timeout: 30_000,
    });
    await expect(
        page.locator('nav[aria-label="Settings tabs"]'),
        'a viewer gets no settings tab strip at all, so the App spec tab is unreachable for one',
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'App spec' })).toHaveCount(0);

    // 2. The tab's own address. The owner reaches this page and is offered the tab (the sibling
    //    file asserts that); a viewer is refused the *host page* above, and here both roles get the
    //    same not-found — the App spec page's own `kind` check and state read, neither of which is a
    //    role gate. The control ACC-03-41 names is absent, asserted by its test id
    //    (`AppSpecStatusBanner.tsx:390-400`) **and** by its label, so a renamed test id cannot turn
    //    this into a free pass.
    //
    //    **This absence is vacuous on this lane and the test says so rather than implying
    //    otherwise**: the banner mounts only inside `AppSpecPageClient`, the page renders only when
    //    `GET /api/works/:id/app-spec` answers, and on this lane it answers
    //    `404 not_found "…has no App spec state yet."` for every App Work and every role — the owner
    //    included (`flow-app-spec-settings.spec.ts` pins that). So no role sees a Re-check control,
    //    and the API half asserted above (the viewer's Re-check verb is refused while the owner's
    //    passes the same gate) is the half that carries real weight today.
    await page.goto(appSpecHref(workId), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
        timeout: 30_000,
    });
    await expect(
        page.getByTestId('app-spec-recheck'),
        'the page withheld the Re-check control from the viewer only vacuously: it mounts for no role',
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Re-check/ })).toHaveCount(0);
    await expect(page.getByTestId('app-spec-page')).toHaveCount(0);
    expect(new URL(page.url()).pathname, 'the tab’s own address, withheld in place').toBe(
        appSpecHref(workId),
    );
});

// ---------------------------------------------------------------------------
// ACC-03-13 — the UI half this lane cannot exercise
// ---------------------------------------------------------------------------

test.fixme(
    'ACC-03-13 (Re-check → Checking…, one evaluation): Re-check cannot be pressed and `Checking…` ' +
        'cannot be observed — blocked: no `work_app_spec_states` row can exist, so the press answers ' +
        '404 not_found and the banner that renders `Checking…` never mounts (measured 2026-09-19)',
    async ({ page, request }) => {
        const { workId, owner } = await ensureFixtures(request);

        // The case, as it must be written once the row exists. The button's own copy is §6.2's
        // (`Re-check now` / `Checking…`, `AppSpecStatusBanner.tsx:398`), and the state it shows
        // while a press is in flight is the page's optimistic `evaluationPending`
        // (`AppSpecPageClient.tsx:139`).
        await page.goto(appSpecHref(workId), { waitUntil: 'domcontentloaded' });
        const button = page.getByTestId('app-spec-recheck');
        await expect(button).toBeVisible({ timeout: 30_000 });
        await expect(button).toHaveText('Re-check now');

        await button.click();
        await expect(button).toBeDisabled();
        await expect(button).toHaveText('Checking…');
        await expect(page.getByTestId('app-spec-status-banner')).toHaveAttribute(
            'data-state',
            'checking',
        );

        // "one evaluation" for three presses inside five seconds is the API's own arithmetic
        // (FR-22, `work-app-spec-state.repository.ts:271-334`), and `{ evaluationPending: true }`
        // is the claim that the request was *recorded* — which is exactly what a missing state row
        // makes impossible. The gate this case needs, asserted first so the reason is unambiguous:
        expect((await recheck(request, owner.token, workId)).status).toBe(202);
    },
);
