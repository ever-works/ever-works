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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const USER_TOKEN = 'apw-e2e-user-token';
const STRANGER_TOKEN = 'apw-e2e-stranger-token';

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
