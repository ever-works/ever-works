/**
 * APW-13 T14 — Repository Work, the full contract (ACC-REG-01, ACC-NEG-15).
 *
 * ACC-REG-01's recorded verdict is *Partial — no e2e success, 409 or refusal
 * over HTTP*: the happy path, the cross-account `409` and the "never
 * deploy/write" refusals were unit-level only. This spec is the HTTP half.
 *
 * ── The split this file is built around (APW-13 plan §8.8, the T63 blocker):
 *
 * A `kind: 'repo'` Work is registered only after the platform probes that the
 * caller's CONNECTED Git account can read the repository
 * (`work-lifecycle.service.ts` → `assertRepositoryAccessible` →
 * `gitFacade.hasRepositoryAccess`). A fresh API-registered user has no
 * connection, so:
 *
 *   • every refusal that fires BEFORE the probe — the URL parser, the provider
 *     mismatch, the missing connection — runs here for real, and
 *   • the success, the `409` for a second account and the generate / deploy /
 *     write refusals all need a Work row, which needs the connection, so they
 *     carry `test.fixme('APW-13 T63: no supported GitHub connection surface')`
 *     — the marker T14/T15/T16/T30/T31 share, un-fixme'd in T63's PR.
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
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

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
    // Until T63 lands the "seeded fake connection" this task needs has no
    // supported surface (plan §8.8), so the success, the cross-account 409 and
    // the generate / deploy / write refusals cannot run. The marker is T14's,
    // shared with T15/T16/T30/T31.
    test.fixme('APW-13 T63: no supported GitHub connection surface', async ({
        request,
    }: {
        request: APIRequestContext;
    }) => {
        // 1. Success: a `repo` Work wrapping the connected account's own
        //    repository, persisted with its source repository coordinates
        //    (`work-lifecycle.service.ts` → `applyRepositoryWorkSource`).
        const owner = await registerUserViaAPI(request);
        const created = await createWorkRaw(
            request,
            owner.access_token,
            repoWorkBody('apw13-t14-created', { repositoryUrl: REPO_URL }),
        );
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(200);
        expect(created.json?.status).toBe('success');

        // 2. 409: the SAME repository registered by a DIFFERENT account.
        //    Same account twice is allowed (one token, one checkout);
        //    another account is refused with 409 by
        //    `assertRepositoryNotWrappedByAnotherAccount`.
        const stranger = await registerUserViaAPI(request);
        const conflict = await createWorkRaw(
            request,
            stranger.access_token,
            repoWorkBody('apw13-t14-conflict', { repositoryUrl: REPO_URL }),
        );
        expect(
            conflict.status,
            `second account wrapping the same repository body=${conflict.text.slice(0, 300)}`,
        ).toBe(409);

        // 3. The generate / deploy / write refusals over HTTP — the D1
        //    "never deploy/write" guard, asserted on the Work created in
        //    step 1. Each route reaches a named
        //    `assertNotRepositoryWork(work, action)`
        //    (`packages/agent/src/works/repository-work-guard.ts:70`, whose
        //    refusal text starts with `is a Repository Work`):
        //      • generate — `POST /api/works/:id/generate`
        //        (`works.controller.ts:1078` → `work-generation.service.ts:1835`);
        //      • write    — `POST /api/works/:id/schedule/run`
        //        (`works.controller.ts:1248` → `work-schedule.service.ts:111`);
        //      • deploy   — `POST /api/deploy/works/:id`
        //        (`deploy.controller.ts:226` → `work-lifecycle.service.ts:940`).
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
    });
});
