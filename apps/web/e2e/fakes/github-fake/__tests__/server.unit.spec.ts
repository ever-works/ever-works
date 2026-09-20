/**
 * T2 — the fake GitHub's own behaviour.
 *
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md` names five
 * things this spec must show, and each has its own `describe` below:
 *
 *   1. fork readiness delay and "never ready";
 *   2. a clone and push round-trip through `git-backend`;
 *   3. `/_control/calls` records method, path and **token identity**;
 *   4. a per-token `auth-refused` fault returns `401` for that token and is
 *      restored afterwards;
 *   5. a seeded catalog fixture serves the routes APW-02, APW-03 and APW-05
 *      consume.
 *
 * Plus T2's "Done when": the server starts in under 1 s.
 *
 * The suite drives the **real HTTP server** on an ephemeral port rather than the
 * route handlers directly, because the things it asserts — a status the client
 * sees, a fault another request's identity does not hit, a `clone_url` a real
 * `git` can reach — only exist once a socket is involved.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The fake is plain ESM test infrastructure with no separate declarations;
// `allowJs` in apps/web/tsconfig.json lets TypeScript infer its surface.
import { createFakeGitHub } from '../server.mjs';
import { seedBareRepoCommit } from '../git-backend.mjs';
// The switch the upstream seed is armed by (T45), read from the fake's own
// constant rather than re-spelled here, so a rename cannot leave this spec
// flipping a variable nothing reads.
import { FAKES_SWITCH_ENV } from '../state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const USER_TOKEN = 'apw-e2e-user-token';
const STRANGER_TOKEN = 'apw-e2e-stranger-token';
const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

type Json = Record<string, any>;

interface Fake {
    origin: string;
    state: Json;
    start(): Promise<string>;
    stop(): Promise<void>;
    cleanup(): void;
}

interface ApiResult {
    status: number;
    body: any;
    headers: Headers;
}

let fake: Fake;

function api(
    method: string,
    routePath: string,
    options: { token?: string; body?: unknown } = {},
): Promise<ApiResult> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${fake.origin}${routePath}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }).then(async (response) => ({
        status: response.status,
        body: await response.json().catch(() => null),
        headers: response.headers,
    }));
}

function control(routePath: string, body?: unknown): Promise<ApiResult> {
    return api('POST', routePath, { body: body ?? {} });
}

/**
 * Run `git` **asynchronously**. This is not style: the fake server runs in this
 * same process, so a `spawnSync` here would block the event loop and the server
 * could never answer the client's `info/refs` request — the clone would sit
 * until the test times out, with no error to explain it.
 */
function git(
    args: string[],
    cwd?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `probe` answers `status`, or fail naming the last status seen.
 *
 * The readiness cases below must not assert a *wall-clock* transition: under the
 * full concurrent harness run a request can take longer than a short readiness
 * window, so a fixed sleep either misses the "not yet" window or races the
 * "ready" one. Polling keeps the assertion about the mechanism instead of about
 * how loaded the machine is.
 */
async function waitForStatus(
    probe: () => Promise<ApiResult>,
    status: number,
    deadlineMs = 20_000,
): Promise<ApiResult> {
    const until = Date.now() + deadlineMs;
    let last = await probe();
    while (last.status !== status && Date.now() < until) {
        await sleep(100);
        last = await probe();
    }
    expect(last.status, `expected ${status}, last saw ${last.status}`).toBe(status);
    return last;
}

/** The PR-lane catalog fixture, read from the checked-in seed (T1/T2). */
function catalogSeed(): Json {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'catalog-pr-lane.seed.json'), 'utf8'));
}

async function seedCatalog(): Promise<void> {
    const result = await control('/_control/seed', catalogSeed());
    expect(result.status).toBe(200);
}

/**
 * The environment, as a mutable bag.
 *
 * `process.env`'s declared properties are `readonly` (`NODE_ENV` among them), so
 * the two switches below cannot be flipped through the declared type. The cast is
 * what a spec that arms and disarms a switch has to do; nothing else in this file
 * writes the environment.
 */
function mutableEnv(): Record<string, string | undefined> {
    return process.env as unknown as Record<string, string | undefined>;
}

/**
 * Run `run` with `EVER_WORKS_E2E_FAKES` set to `value`, restoring whatever was
 * there afterwards.
 *
 * The fake reads the switch **per seed call** (`state.mjs`'s `upstreamSeedGate`),
 * deliberately, so a case can flip it — the same rule `resolveGitHubE2eFakeOrigin`
 * keeps. Restoring in a `finally` matters more than it looks: this process also
 * runs every other case in the file, and a leaked `EVER_WORKS_E2E_FAKES=1` would
 * arm the upstream seed for all of them.
 */
async function withFakesSwitch<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const env = mutableEnv();
    const previous = env[FAKES_SWITCH_ENV];
    if (value === undefined) delete env[FAKES_SWITCH_ENV];
    else env[FAKES_SWITCH_ENV] = value;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete env[FAKES_SWITCH_ENV];
        else env[FAKES_SWITCH_ENV] = previous;
    }
}

/** The same, for `NODE_ENV` — the other half of the gate. */
async function withNodeEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const env = mutableEnv();
    const previous = env.NODE_ENV;
    if (value === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = value;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete env.NODE_ENV;
        else env.NODE_ENV = previous;
    }
}

/**
 * The upstream seed of T45, in APW-09 plan §3.1 / §6's own field names: the
 * `upstream_pull_requests` row an `awaiting_approval` proposal is about, and the
 * `agent_action_proposals` row that approves it. The proposal deliberately does
 * **not** name its row — it is matched by `(workId, sourceTaskId)`, which is what
 * the sibling case below pins.
 */
function upstreamSeed(overrides: Json = {}): Json {
    return {
        upstream_pull_requests: [
            {
                id: 'upr-0001',
                userId: 'user-0001',
                workId: 'work-0001',
                sourceTaskId: 'task-0001',
                upstreamOwner: 'ever-works',
                upstreamRepo: 'cal-diy-template',
                baseBranch: 'main',
                headOwner: 'apw-e2e-user',
                headRepo: 'cal-diy-template',
                headBranch: 'upstream-pr/add-smoke-test-1a2b',
                headSha: SHA_A,
                upstreamBaseSha: SHA_B,
                state: 'awaiting_approval',
                number: 12,
                url: 'https://github.com/ever-works/cal-diy-template/pull/12',
                title: 'Add the smoke test',
            },
        ],
        upstream_approval_proposals: [
            {
                id: 'proposal-0001',
                userId: 'user-0001',
                agentId: 'agent-0001',
                title: 'Approve pull request to ever-works/cal-diy-template: Add the smoke test',
                subjectKey: 'apw-e2e-subject-key',
                status: 'pending',
                payload: { workId: 'work-0001', sourceTaskId: 'task-0001' },
            },
        ],
        ...overrides,
    };
}

beforeAll(async () => {
    fake = createFakeGitHub({ port: 0 }) as unknown as Fake;
    await fake.start();
});

afterAll(async () => {
    await fake.stop();
    fake.cleanup();
});

beforeEach(async () => {
    await control('/_control/reset');
    await seedCatalog();
});

describe('T2 — the fake GitHub starts and serves', () => {
    it('starts in under one second (T2 Done when)', async () => {
        const fresh = createFakeGitHub({ port: 0 }) as unknown as Fake;
        const startedAt = Date.now();
        await fresh.start();
        const elapsed = Date.now() - startedAt;
        await fresh.stop();
        fresh.cleanup();
        expect(elapsed, `start took ${elapsed}ms`).toBeLessThan(1000);
    });

    it('points every repository response clone_url at itself, never at github.com', async () => {
        const result = await api('GET', '/repos/ever-works/templates', { token: USER_TOKEN });
        expect(result.status).toBe(200);
        expect(result.body.clone_url).toBe(`${fake.origin}/ever-works/templates.git`);
        expect(result.body.full_name).toBe('ever-works/templates');
        expect(result.body.allow_forking).toBe(true);
    });

    it('answers 404 for a repository it was never seeded with', async () => {
        const result = await api('GET', '/repos/ever-works/does-not-exist', { token: USER_TOKEN });
        expect(result.status).toBe(404);
    });
});

describe('T2 — fork readiness', () => {
    it('answers 404 for a fork that is still being prepared, then 200 once the delay elapses', async () => {
        const planted = await control('/_control/fault', {
            route: '/repos/ever-works/templates/forks',
            behaviour: 'delay',
            seconds: 3,
        });
        expect(planted.status).toBe(200);

        const fork = await api('POST', '/repos/ever-works/templates/forks', {
            token: USER_TOKEN,
            body: {},
        });
        expect(fork.status).toBe(202);
        expect(fork.body.full_name).toBe('apw-e2e-user/templates');
        expect(fork.body.fork).toBe(true);

        const tooEarly = await api('GET', '/repos/apw-e2e-user/templates', { token: USER_TOKEN });
        expect(tooEarly.status, 'a fork in flight is 404, exactly as the live API answers').toBe(
            404,
        );

        const ready = await waitForStatus(
            () => api('GET', '/repos/apw-e2e-user/templates', { token: USER_TOKEN }),
            200,
        );
        expect(ready.body.parent.full_name).toBe('ever-works/templates');
        expect(ready.body.clone_url).toBe(`${fake.origin}/apw-e2e-user/templates.git`);
    });

    it('keeps a "never ready" fork invisible no matter how long the caller waits', async () => {
        await control('/_control/fault', {
            route: '/repos/ever-works/templates/forks',
            behaviour: 'never-ready',
        });

        const fork = await api('POST', '/repos/ever-works/templates/forks', {
            token: USER_TOKEN,
            body: { name: 'never-ready-templates' },
        });
        expect(fork.status).toBe(202);

        const first = await api('GET', '/repos/apw-e2e-user/never-ready-templates', {
            token: USER_TOKEN,
        });
        expect(first.status).toBe(404);
        await sleep(600);
        const second = await api('GET', '/repos/apw-e2e-user/never-ready-templates', {
            token: USER_TOKEN,
        });
        expect(second.status).toBe(404);

        const listed = await api('GET', '/repos/ever-works/templates/forks', { token: USER_TOKEN });
        expect(listed.status).toBe(200);
        expect(
            listed.body.map((entry: Json) => entry.full_name),
            'a fork that never became ready is not listed either',
        ).not.toContain('apw-e2e-user/never-ready-templates');
    });
});

describe('T2 — git smart HTTP', () => {
    it('serves a clone and accepts a push through git http-backend', async () => {
        const repo = fake.state.repositories.get('ever-works/templates');
        seedBareRepoCommit(fake.state, repo, { 'README.md': '# templates\n' });

        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-git-roundtrip-'));
        const cloneDir = path.join(scratch, 'clone');

        const cloned = await git(['clone', `${fake.origin}/ever-works/templates.git`, cloneDir]);
        expect(cloned.status, `git clone failed: ${cloned.stderr}`).toBe(0);
        expect(fs.existsSync(path.join(cloneDir, 'README.md'))).toBe(true);

        await git(['config', 'user.email', 'e2e@example.invalid'], cloneDir);
        await git(['config', 'user.name', 'APW-13 fake GitHub'], cloneDir);
        fs.writeFileSync(path.join(cloneDir, 'pushed.txt'), 'pushed through the fake\n');
        await git(['add', '--all'], cloneDir);
        await git(['commit', '--message', 'push through git http-backend'], cloneDir);
        const pushed = await git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);
        expect(pushed.status, `git push failed: ${pushed.stderr}`).toBe(0);

        const head = await git(['rev-parse', 'main'], cloneDir);
        const serverHead = await git(['rev-parse', 'main'], repo.gitDir);
        expect(serverHead.status).toBe(0);
        expect(serverHead.stdout.trim()).toBe(head.stdout.trim());

        fs.rmSync(scratch, { recursive: true, force: true });
    });
});

describe('T2 — the control API', () => {
    it('records method, path and token identity, and never records the token value', async () => {
        await api('GET', '/user', { token: USER_TOKEN });
        await api('GET', '/repos/ever-works/templates', { token: USER_TOKEN });
        await api('GET', '/repos/ever-works/templates', {});

        const listed = await api('GET', '/_control/calls');
        expect(listed.status).toBe(200);
        const calls: Json[] = listed.body.calls;

        const userCall = calls.find(
            (call) =>
                call.method === 'GET' &&
                call.path === '/user' &&
                call.tokenIdentity === 'apw-e2e-user',
        );
        expect(userCall, 'the /user call is recorded with its token identity').toBeTruthy();
        expect(userCall?.authenticated).toBe(true);

        const anonymous = calls.find(
            (call) =>
                call.path === '/repos/ever-works/templates' && call.tokenIdentity === 'anonymous',
        );
        expect(anonymous, 'an unauthenticated call is recorded as anonymous').toBeTruthy();
        expect(anonymous?.authenticated).toBe(false);

        expect(
            JSON.stringify(calls),
            'the token VALUE must never appear in the call log',
        ).not.toContain(USER_TOKEN);
        expect(JSON.stringify(calls)).not.toContain(STRANGER_TOKEN);
    });

    it('does not record its own control traffic as GitHub traffic', async () => {
        await api('GET', '/_control/state');
        const listed = await api('GET', '/_control/calls');
        expect(
            listed.body.calls.filter((call: Json) => String(call.path).startsWith('/_control')),
            "/_control/* is the fake's own API, not a GitHub call",
        ).toEqual([]);
    });

    it('fails loudly on an unknown fault behaviour instead of silently doing nothing', async () => {
        const result = await control('/_control/fault', { behaviour: 'not-a-behaviour' });
        expect(result.status).toBe(500);
        expect(String(result.body.message)).toContain('unknown fault behaviour');
    });
});

describe('T2 — per-token faults', () => {
    it('refuses 401 for exactly one token identity, then restores that identity', async () => {
        await control('/_control/fault', {
            route: '/user',
            behaviour: 'auth-refused',
            token: 'apw-e2e-stranger',
        });

        const refused = await api('GET', '/user', { token: STRANGER_TOKEN });
        expect(refused.status, 'the faulted identity is refused').toBe(401);
        expect(refused.body.message).toBe('Bad credentials');

        const unaffected = await api('GET', '/user', { token: USER_TOKEN });
        expect(unaffected.status, 'another identity is untouched by the fault').toBe(200);
        expect(unaffected.body.login).toBe('apw-e2e-user');

        const restored = await api('GET', '/user', { token: STRANGER_TOKEN });
        expect(restored.status, 'a fault applies to the next matching call, then is restored').toBe(
            200,
        );
        expect(restored.body.login).toBe('apw-e2e-stranger');
    });

    it('answers rate-limit with 403 and an exhausted x-ratelimit-remaining header', async () => {
        await control('/_control/fault', {
            route: '/repos/ever-works/templates',
            behaviour: 'rate-limit',
        });
        const limited = await api('GET', '/repos/ever-works/templates', { token: USER_TOKEN });
        expect(limited.status).toBe(403);
        expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    });
});

/**
 * C14 — a fault narrowed to the token **value**.
 *
 * `GET /user` answers the `user` fixture 200 for every token, which is what
 * makes the fake faithful about a *working* credential and useless about a
 * **dead** one. A dead credential is not a seeded identity: the fake never saw
 * it, so it collapses to the single identity `unknown`, and an
 * identity-narrowed fault cannot distinguish it from any other unknown token —
 * nor survive two lanes arming at once, because a fault is one-shot. These
 * cases pin the `tokenValue` narrowing that closes that gap, and the GitHub 401
 * envelope the refusal answers with.
 */
describe('T2 — per-token-VALUE faults (a dead credential has no identity)', () => {
    const DEAD_TOKEN = 'ghp_e2e_dead_token_000';
    const OTHER_UNSEEDED_TOKEN = 'ghp_e2e_other_dead_token_000';

    it('refuses the named token by value and leaves another unseeded token alone', async () => {
        await control('/_control/fault', {
            route: '/user',
            behaviour: 'auth-refused',
            tokenValue: DEAD_TOKEN,
        });

        // ⚠️ The UNTOUCHED token is probed FIRST, and that order is the test.
        // A fault is one-shot, so probing the named token first would spend it
        // and the second call would answer 200 whether or not the narrowing
        // exists — a green mutant. Asking about the wrong token while the fault
        // is still armed is the only order in which the answer means anything.
        const untouched = await api('GET', '/user', { token: OTHER_UNSEEDED_TOKEN });
        expect(
            untouched.status,
            'a different unseeded token shares the identity `unknown` and must NOT be refused — ' +
                'that discrimination is the whole point of narrowing by value',
        ).toBe(200);

        const refused = await api('GET', '/user', { token: DEAD_TOKEN });
        expect(refused.status, 'the named token is refused').toBe(401);
        expect(refused.body.message).toBe('Bad credentials');
    });

    it('answers auth-refused with GitHub’s own 401 envelope', async () => {
        await control('/_control/fault', {
            route: '/user',
            behaviour: 'auth-refused',
            tokenValue: DEAD_TOKEN,
        });

        const refused = await api('GET', '/user', { token: DEAD_TOKEN });
        expect(refused.status).toBe(401);
        expect(refused.body).toMatchObject({
            message: 'Bad credentials',
            documentation_url: 'https://docs.github.com/rest',
            status: '401',
        });
    });

    it('records the refusal, its status and the identity in /_control/calls', async () => {
        await control('/_control/fault', {
            route: '/user',
            behaviour: 'auth-refused',
            tokenValue: DEAD_TOKEN,
        });
        await api('GET', '/user', { token: DEAD_TOKEN });

        const listed = await api('GET', '/_control/calls');
        const faulted = listed.body.calls.find(
            (call: Json) => call.faultApplied === 'auth-refused',
        );
        expect(faulted, 'the faulted call is recorded').toBeTruthy();
        expect(faulted.status, 'the status the fault answered with is recorded').toBe(401);
        expect(faulted.tokenIdentity).toBe('unknown');
        expect(
            JSON.stringify(listed.body.calls),
            'the token VALUE must still never appear in the call log',
        ).not.toContain(DEAD_TOKEN);
    });
});

describe('T2 — the seeded PR-lane catalog serves its consumers', () => {
    it('serves APW-02: forks list, fork creation and the fork readiness gate', async () => {
        const forks = await api('GET', '/repos/ever-works/templates/forks', { token: USER_TOKEN });
        expect(forks.status).toBe(200);
        expect(forks.body).toHaveLength(1);
        expect(forks.body[0]).toMatchObject({
            full_name: 'apw-e2e-user/templates',
            fork: true,
            archived: false,
            default_branch: 'main',
        });
        expect(forks.body[0].owner.login).toBe('apw-e2e-user');
        expect(forks.body[0].clone_url).toBe(`${fake.origin}/apw-e2e-user/templates.git`);

        const created = await api('POST', '/repos/ever-works/umami-template/forks', {
            token: USER_TOKEN,
            body: { organization: 'apw-e2e-org' },
        });
        expect(created.status).toBe(202);
        expect(created.body.full_name).toBe('apw-e2e-org/umami-template');
        expect(created.body.parent.full_name).toBe('ever-works/umami-template');
    });

    it('serves APW-03: license, repository tree and a contents commit', async () => {
        const license = await api('GET', '/repos/ever-works/cal-diy-template/license', {
            token: USER_TOKEN,
        });
        expect(license.status).toBe(200);
        expect(license.body.spdx_id).toBe('AGPL-3.0');

        const amber = await api('GET', '/repos/apw-e2e-upstream/amber-app/license', {
            token: USER_TOKEN,
        });
        expect(amber.body.spdx_id).toBe('BUSL-1.1');
        const red = await api('GET', '/repos/apw-e2e-upstream/red-app/license', {
            token: USER_TOKEN,
        });
        expect(red.body.spdx_id).toBe('NOASSERTION');

        const tree = await api('GET', '/repos/ever-works/templates/git/trees/main?recursive=1', {
            token: USER_TOKEN,
        });
        expect(tree.status).toBe(200);
        for (const entry of tree.body.tree) {
            expect(typeof entry.path).toBe('string');
            expect(typeof entry.type).toBe('string');
            expect(typeof entry.mode).toBe('string');
            expect(typeof entry.sha).toBe('string');
        }

        const written = await api('PUT', '/repos/ever-works/templates/contents/.works/works.yml', {
            token: USER_TOKEN,
            body: {
                message: 'Add the App spec',
                content: Buffer.from('version: 1\nkind: app\n', 'utf8').toString('base64'),
                branch: 'main',
            },
        });
        expect(written.status).toBe(200);
        expect(written.body.commit.sha).toBeTruthy();

        const read = await api('GET', '/repos/ever-works/templates/contents/.works/works.yml', {
            token: USER_TOKEN,
        });
        expect(read.status).toBe(200);
        expect(read.body.path).toBe('.works/works.yml');
        expect(Buffer.from(read.body.content, 'base64').toString('utf8')).toBe(
            'version: 1\nkind: app\n',
        );
    });

    it('serves APW-05: workflows, disable/enable, secret public key and workflow runs', async () => {
        const workflows = await api('GET', '/repos/ever-works/templates/actions/workflows', {
            token: USER_TOKEN,
        });
        expect(workflows.status).toBe(200);
        expect(workflows.body.total_count).toBe(2);

        const disabled = await api(
            'PUT',
            '/repos/ever-works/templates/actions/workflows/900002/disable',
            { token: USER_TOKEN },
        );
        expect(disabled.status, 'PUT …/disable answers 204, as the live API does').toBe(204);

        const afterDisable = await api('GET', '/repos/ever-works/templates/actions/workflows', {
            token: USER_TOKEN,
        });
        expect(afterDisable.body.workflows.find((w: Json) => w.id === 900002).state).toBe(
            'disabled_manually',
        );

        const enabled = await api(
            'PUT',
            '/repos/ever-works/templates/actions/workflows/900002/enable',
            {
                token: USER_TOKEN,
            },
        );
        expect(enabled.status).toBe(204);

        const publicKey = await api(
            'GET',
            '/repos/ever-works/templates/actions/secrets/public-key',
            {
                token: USER_TOKEN,
            },
        );
        expect(publicKey.status).toBe(200);
        expect(typeof publicKey.body.key_id).toBe('string');
        expect(typeof publicKey.body.key).toBe('string');

        const secret = await api(
            'PUT',
            '/repos/ever-works/templates/actions/secrets/EW_BUILD_TOKEN',
            {
                token: USER_TOKEN,
                body: {
                    encrypted_value: 'bm90LWEtcmVhbC1zZWNyZXQ=',
                    key_id: publicKey.body.key_id,
                },
            },
        );
        expect(secret.status).toBe(201);

        const runs = await api('GET', '/repos/ever-works/templates/actions/runs', {
            token: USER_TOKEN,
        });
        expect(runs.status).toBe(200);
        expect(runs.body.workflow_runs[0]).toMatchObject({
            status: 'completed',
            conclusion: 'success',
            run_number: 1,
        });
        expect(runs.body.workflow_runs[0].head_sha).toMatch(/^[0-9a-f]{40}$/);

        const runId = runs.body.workflow_runs[0].id;
        const jobs = await api('GET', `/repos/ever-works/templates/actions/runs/${runId}/jobs`, {
            token: USER_TOKEN,
        });
        expect(jobs.status).toBe(200);
        expect(jobs.body.jobs[0].steps.map((step: Json) => step.name)).toEqual([
            'Set up job',
            'docker build',
            'push image',
        ]);

        const artifacts = await api(
            'GET',
            `/repos/ever-works/templates/actions/runs/${runId}/artifacts`,
            { token: USER_TOKEN },
        );
        expect(artifacts.status).toBe(200);
        expect(artifacts.body.artifacts[0].name).toBe('build-result');
    });

    it('records the writes it saw, so a "zero writes" assertion has something to read', async () => {
        await api('PUT', '/repos/ever-works/templates/topics', {
            token: USER_TOKEN,
            body: { names: ['ever-works', 'app-template', 'apw-e2e-expired'] },
        });
        const calls = await api('GET', '/_control/calls');
        const writes = calls.body.calls.filter((call: Json) => call.method !== 'GET');
        expect(writes.map((call: Json) => `${call.method} ${call.path}`)).toContain(
            'PUT /repos/ever-works/templates/topics',
        );
        expect(writes[0].tokenIdentity).toBe('apw-e2e-user');
        expect(writes[0].status).toBe(200);
    });

    it('archives and labels a repository through the topic route', async () => {
        const archived = await api('PUT', '/repos/ever-works/templates/topics', {
            token: USER_TOKEN,
            body: { names: ['apw-e2e-expired'] },
        });
        expect(archived.status).toBe(200);
        expect(archived.body.names).toEqual(['apw-e2e-expired']);
        const read = await api('GET', '/repos/ever-works/templates/topics', { token: USER_TOKEN });
        expect(read.body.names).toEqual(['apw-e2e-expired']);
    });
});

/**
 * T45 — the upstream endpoints APW-09's lanes call.
 *
 * `docs/specs/features/app-works/APW-09-upstream-pull-requests/tasks.md` T45
 * names ten REST endpoints and one extension. This block drives each of them over
 * real HTTP and asserts **what the consuming plugin reads**, not merely that a
 * `200` came back:
 *
 *   - `check_runs[].{name,status,conclusion,details_url}` plus `total_count`
 *     (`readChecks` → `checks.listForRef`), seeded with an `action_required` run
 *     because ACC-09-17 turns on that value reading as *waiting for maintainers*
 *     rather than as a failure;
 *   - the commit statuses, and the combined status **rolled up** from them rather
 *     than asserted;
 *   - the interaction limit, including GitHub's own `204` for "no temporary
 *     limit", which the plugin maps to `null` and never to `'none'`;
 *   - the branch create / update / delete trio, where the delete must really
 *     remove the ref;
 *   - the pull-request reads the status lane makes, and the compare's
 *     `total_commits` (APW-09 T1).
 *
 * The structural half — that every URL T45 names is dispatched to *some* route of
 * the right method — is `contract.unit.spec.ts`'s `T45_ROUTES` net. This block is
 * the behavioural half.
 */
describe('T45 — the upstream endpoints APW-09 calls', () => {
    it('creates, updates and deletes a branch ref, and the delete really removes it', async () => {
        const created = await api('POST', '/repos/ever-works/templates/git/refs', {
            token: USER_TOKEN,
            body: { ref: 'refs/heads/upstream-pr-withdraw', sha: SHA_A },
        });
        expect(created.status).toBe(201);
        expect(created.body.ref).toBe('refs/heads/upstream-pr-withdraw');
        expect(created.body.object).toMatchObject({ sha: SHA_A, type: 'commit' });

        const updated = await api(
            'PATCH',
            '/repos/ever-works/templates/git/refs/heads/upstream-pr-withdraw',
            { token: USER_TOKEN, body: { sha: SHA_B } },
        );
        expect(updated.status).toBe(200);
        expect(updated.body.object.sha).toBe(SHA_B);

        const deleted = await api(
            'DELETE',
            '/repos/ever-works/templates/git/refs/heads/upstream-pr-withdraw',
            { token: USER_TOKEN },
        );
        expect(deleted.status, 'the live API answers 204 for a branch delete').toBe(204);

        const gone = await api(
            'GET',
            '/repos/ever-works/templates/git/refs/heads/upstream-pr-withdraw',
            { token: USER_TOKEN },
        );
        expect(
            gone.status,
            'a fake that answered 204 while the branch stayed readable would let a lane ' +
                'pass a "the branch is gone" assertion it never earned',
        ).toBe(404);

        const calls = await api('GET', '/_control/calls');
        const recorded = calls.body.calls.find(
            (call: Json) => call.method === 'DELETE' && call.path.endsWith('/upstream-pr-withdraw'),
        );
        expect(
            recorded?.status,
            'the delete is a recorded write, for a zero-writes assertion',
        ).toBe(204);
    });

    it('serves check-runs, commit statuses and the combined status of a commit', async () => {
        const runs = await api(
            'GET',
            `/repos/ever-works/cal-diy-template/commits/${SHA_A}/check-runs`,
            { token: USER_TOKEN },
        );
        expect(runs.status).toBe(200);
        expect(runs.body.total_count).toBe(2);
        expect(
            runs.body.check_runs.map((run: Json) => `${run.name}:${run.status}:${run.conclusion}`),
            'an action_required run is what ACC-09-17 reads as waiting for maintainers',
        ).toEqual(['build:completed:action_required', 'lint:completed:success']);
        expect(typeof runs.body.check_runs[0].details_url).toBe('string');
        expect(typeof runs.body.check_runs[0].output.annotations_count).toBe('number');

        const statuses = await api(
            'GET',
            `/repos/ever-works/cal-diy-template/commits/${SHA_A}/statuses`,
            { token: USER_TOKEN },
        );
        expect(statuses.status).toBe(200);
        expect(Array.isArray(statuses.body)).toBe(true);
        expect(statuses.body[0]).toMatchObject({
            context: 'continuous-integration/apw-e2e',
            state: 'success',
        });

        const combined = await api(
            'GET',
            `/repos/ever-works/cal-diy-template/commits/${SHA_A}/status`,
            { token: USER_TOKEN },
        );
        expect(combined.status).toBe(200);
        expect(combined.body).toMatchObject({ state: 'success', total_count: 1 });
        expect(combined.body.repository.full_name).toBe('ever-works/cal-diy-template');
    });

    it('rolls the combined status up from the statuses instead of asserting it', async () => {
        await control('/_control/seed', {
            repositories: [
                {
                    owner: 'ever-works',
                    name: 'templates',
                    commitStatuses: [
                        {
                            id: 910001,
                            context: 'continuous-integration/one',
                            state: 'success',
                            createdAt: '2026-09-18T09:12:04Z',
                        },
                        {
                            id: 910002,
                            context: 'continuous-integration/two',
                            state: 'failure',
                            description: 'The smoke test failed',
                            createdAt: '2026-09-18T09:13:04Z',
                        },
                    ],
                },
            ],
        });

        const statuses = await api('GET', '/repos/ever-works/templates/commits/main/statuses', {
            token: USER_TOKEN,
        });
        expect(statuses.body.map((status: Json) => status.context)).toEqual([
            'continuous-integration/one',
            'continuous-integration/two',
        ]);

        const combined = await api('GET', '/repos/ever-works/templates/commits/main/status', {
            token: USER_TOKEN,
        });
        expect(
            combined.body.state,
            'a red status among green ones is a red roll-up, as GitHub answers',
        ).toBe('failure');
        expect(combined.body.total_count).toBe(2);
    });

    it('answers a seeded interaction limit 200 and an unseeded repository GitHub’s own 204', async () => {
        const limited = await api('GET', '/repos/ever-works/cal-diy-template/interaction-limits', {
            token: USER_TOKEN,
        });
        expect(limited.status).toBe(200);
        expect(limited.body).toMatchObject({
            limit: 'collaborators_only',
            origin: 'repository',
        });
        expect(typeof limited.body.expires_at).toBe('string');

        const unlimited = await api('GET', '/repos/ever-works/templates/interaction-limits', {
            token: USER_TOKEN,
        });
        expect(
            unlimited.status,
            'the live API answers 204 when a repository has no temporary limit',
        ).toBe(204);
        expect(
            unlimited.body,
            'a 204 carries no body, which the plugin maps to null — never to `none`',
        ).toBeNull();
    });

    it('serves the pull-request reads the upstream status lane makes', async () => {
        const created = await api('POST', '/repos/ever-works/cal-diy-template/pulls', {
            token: USER_TOKEN,
            body: {
                title: 'Add the smoke test',
                head: 'apw-e2e-user:upstream-pr-add-smoke-test-1a2b',
                base: 'main',
                body: 'The proposal body.',
            },
        });
        expect(created.status).toBe(201);
        const number = created.body.number;

        const read = await api('GET', `/repos/ever-works/cal-diy-template/pulls/${number}`, {
            token: USER_TOKEN,
        });
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ state: 'open', mergeable: true, draft: false });
        expect(read.body.head.label).toBe('apw-e2e-user:upstream-pr-add-smoke-test-1a2b');
        expect(read.body.base.ref).toBe('main');

        const reviews = await api(
            'GET',
            `/repos/ever-works/cal-diy-template/pulls/${number}/reviews`,
            { token: USER_TOKEN },
        );
        expect(reviews.status).toBe(200);
        expect(reviews.body.map((review: Json) => review.state)).toEqual(['APPROVED']);
        expect(typeof reviews.body[0].submitted_at).toBe('string');

        const comments = await api(
            'GET',
            `/repos/ever-works/cal-diy-template/pulls/${number}/comments`,
            { token: USER_TOKEN },
        );
        expect(comments.status).toBe(200);
        expect(comments.body[0]).toMatchObject({ path: '.works/works.yml' });
        expect(typeof comments.body[0].line).toBe('number');
    });

    it('answers total_commits on the compare read (APW-09 T1)', async () => {
        const compared = await api(
            'GET',
            '/repos/ever-works/cal-diy-template/compare/main...apw-e2e-head',
            { token: USER_TOKEN },
        );
        expect(compared.status).toBe(200);
        expect(compared.body.total_commits).toBe(1);
        expect(Array.isArray(compared.body.files)).toBe(true);
    });
});

/**
 * T45 — the upstream seed and the switch that arms it.
 *
 * `POST /_control/seed` gains `upstream_pull_requests` and
 * `upstream_approval_proposals`, and they are the only seed keys governed by
 * `EVER_WORKS_E2E_FAKES=1 && NODE_ENV !== 'production'`. Three things a lane's
 * precondition depends on, each pinned here: an armed seed lands and links, an
 * unarmed one is **ignored and says so**, and a proposal matching no row is
 * refused loudly.
 */
describe('T45 — the upstream seed, and the switch that arms it', () => {
    it('seeds the row and its matching proposal when the switch is armed, and reads them back', async () => {
        const seeded = await withFakesSwitch('1', () => control('/_control/seed', upstreamSeed()));

        expect(seeded.status).toBe(200);
        expect(seeded.body.seeded.upstreamSeed).toEqual({
            applied: true,
            reason: 'armed',
            rows: 1,
            proposals: 1,
            linked: 1,
        });

        const state = await api('GET', '/_control/state');
        const row = state.body.upstreamPullRequests[0];
        expect(row).toMatchObject({
            id: 'upr-0001',
            workId: 'work-0001',
            sourceTaskId: 'task-0001',
            state: 'awaiting_approval',
            number: 12,
            upstreamOwner: 'ever-works',
            upstreamRepo: 'cal-diy-template',
        });
        const proposal = state.body.upstreamApprovalProposals[0];
        expect(proposal).toMatchObject({
            id: 'proposal-0001',
            actionType: 'upstream_pull_request',
            status: 'pending',
        });
        expect(
            proposal.payload.upstreamPullRequestId,
            'the proposal is matched to its row, so ACC-NEG-06 starts from a linked pair',
        ).toBe('upr-0001');
        expect(row.approvalProposalId).toBe('proposal-0001');
    });

    it('ignores the upstream seed when the switch is off, and names the reason', async () => {
        const seeded = await withFakesSwitch(undefined, () =>
            control('/_control/seed', upstreamSeed()),
        );

        expect(seeded.status, 'an unarmed seed is not an error — it is an ignorable key').toBe(200);
        expect(seeded.body.seeded.upstreamSeed).toEqual({
            applied: false,
            reason: 'switch-off',
            rows: 0,
            proposals: 0,
            linked: 0,
        });

        const state = await api('GET', '/_control/state');
        expect(
            state.body.upstreamPullRequests,
            'nothing was stored, so no case can read a row it did not seed',
        ).toEqual([]);
        expect(state.body.upstreamApprovalProposals).toEqual([]);
    });

    it('ignores the upstream seed in production even with the switch on', async () => {
        const seeded = await withNodeEnv('production', () =>
            withFakesSwitch('1', () => control('/_control/seed', upstreamSeed())),
        );
        expect(seeded.body.seeded.upstreamSeed.applied).toBe(false);
        expect(seeded.body.seeded.upstreamSeed.reason).toBe('production');
    });

    it('refuses a proposal that matches no seeded row, naming the orphan', async () => {
        const seeded = await withFakesSwitch('1', () =>
            control(
                '/_control/seed',
                upstreamSeed({
                    upstream_approval_proposals: [
                        {
                            id: 'proposal-orphan',
                            payload: { workId: 'work-nobody', sourceTaskId: 'task-nobody' },
                        },
                    ],
                }),
            ),
        );

        expect(
            seeded.status,
            'a precondition that silently seeded nothing is the failure to prevent',
        ).toBe(400);
        expect(String(seeded.body.message)).toContain('proposal-orphan');
        expect(String(seeded.body.message)).toContain(
            'matches no seeded upstream_pull_requests row',
        );
    });

    it('clears the upstream seed on /_control/reset', async () => {
        await withFakesSwitch('1', () => control('/_control/seed', upstreamSeed()));
        expect((await api('GET', '/_control/state')).body.upstreamPullRequests).toHaveLength(1);

        await control('/_control/reset');
        const state = await api('GET', '/_control/state');
        expect(state.body.upstreamPullRequests).toEqual([]);
        expect(state.body.upstreamApprovalProposals).toEqual([]);
    });
});
