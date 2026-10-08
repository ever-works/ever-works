import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { request as httpRequest, type Server } from 'http';
import type { INestApplicationContext } from '@nestjs/common';

/**
 * APW-06 T32 — `app-runtime:local-worker`'s HTTP answers carry an error's **message**, never the
 * thrown value itself.
 *
 * `POST /run` answers a job that threw with `{ ok: false, error }`. An `Error` contributes its
 * `message` (never its `stack`). Anything else that was thrown — an object, a string built from a
 * stack, a value with a custom `toString` — is not serialized into the response at all: the
 * answer names what kind of value it was and says the text is in the log — the worker's stderr,
 * which is where the full text goes. The worker is loopback-only and refuses production, but the rule is the
 * response's own, not a property of who can reach it.
 *
 * The four task modules are replaced by one controllable runner so a job can throw exactly the
 * value a case needs; the queue, the server and the error rendering are the real ones.
 */

const { deployRunner } = vi.hoisted(() => ({
    deployRunner: vi.fn<(payload: unknown) => Promise<unknown>>(),
}));

vi.mock('../tasks/trigger/app-deploy.task', () => ({
    APP_DEPLOY_TASK_ID: 'app-deploy',
    runAppDeployTask: deployRunner,
}));
vi.mock('../tasks/trigger/app-smoke.task', () => ({
    APP_SMOKE_TASK_ID: 'app-smoke',
    runAppSmokeTask: vi.fn(),
}));
vi.mock('../tasks/trigger/app-cluster-op.task', () => ({
    APP_CLUSTER_OP_TASK_ID: 'app-cluster-op',
    runAppClusterOpTask: vi.fn(),
}));
vi.mock('../tasks/trigger/app-health-poll.task', () => ({
    APP_HEALTH_POLL_TASK_ID: 'app-health-poll',
    runAppHealthPollTask: vi.fn(),
}));
vi.mock('../trigger/worker/modules/trigger-app-runtime.module', () => ({
    APP_RUNTIME_TASK_QUEUE: { name: 'app-cluster-io', concurrencyLimit: 20 },
    TriggerAppRuntimeModule: class TriggerAppRuntimeModule {},
}));
vi.mock('@ever-works/agent/app-runtime', () => ({
    isAppClusterWorkerContext: () => false,
}));
vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: vi.fn() },
}));

import {
    LocalAppRuntimeQueue,
    startLocalWorkerServer,
} from '../tasks/trigger/app-runtime-local-worker';

/** A stack-shaped string: what must never come back over HTTP. */
const STACK_TEXT =
    'Error: kube said no\n    at ClusterClient.apply (/srv/agent/dist/app-runtime/cluster.js:42:7)';

describe('app-runtime:local-worker — POST /run error answers', () => {
    let server: Server;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    async function run(task: string): Promise<{ status: number; body: Record<string, unknown> }> {
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task, payload: { workId: 'w', deploymentId: 'd' } }),
        });
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    }

    beforeEach(async () => {
        deployRunner.mockReset();
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        server = await startLocalWorkerServer({
            queue: new LocalAppRuntimeQueue(1),
            context: {} as INestApplicationContext,
            bootError: null,
            port: 0,
        });
    });

    afterEach(async () => {
        errorSpy.mockRestore();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('answers an Error with its message, and never with its stack', async () => {
        const error = new Error('the cluster refused the apply');
        error.stack = STACK_TEXT;
        deployRunner.mockRejectedValueOnce(error);

        const { status, body } = await run('app-deploy');

        expect(status).toBe(500);
        expect(body).toMatchObject({ ok: false, task: 'app-deploy' });
        expect(body.error).toBe('the cluster refused the apply');
        expect(JSON.stringify(body)).not.toContain('cluster.js:42');
    });

    it('never serializes a thrown non-Error value into the answer; stderr keeps the text', async () => {
        const thrown = { toString: () => STACK_TEXT };
        deployRunner.mockRejectedValueOnce(thrown);

        const { status, body } = await run('app-deploy');

        expect(status).toBe(500);
        expect(body).toMatchObject({ ok: false, task: 'app-deploy' });
        expect(JSON.stringify(body)).not.toContain('cluster.js:42');
        expect(JSON.stringify(body)).not.toContain('kube said no');
        expect(body.error).toMatch(/non-Error value \(object\)/);
        // The operator still has the whole text — on the worker's own stderr.
        expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
            'cluster.js:42',
        );
    });

    it('a thrown string is not echoed either', async () => {
        deployRunner.mockRejectedValueOnce(STACK_TEXT);

        const { body } = await run('app-deploy');

        expect(JSON.stringify(body)).not.toContain('cluster.js:42');
        expect(body.error).toMatch(/non-Error value \(string\)/);
    });
});

/**
 * Loopback binding keeps other hosts out, but not a web page in the developer's own browser: a
 * DNS-rebinding page (a name the attacker re-points at 127.0.0.1) is same-origin with the worker,
 * so it could `POST /run` and read the answer. What such a request cannot fake is its `Host`
 * header — it carries the attacker's name — so the worker answers only a loopback `Host` with its
 * own port, which is what `.github/workflows/e2e.yml`'s `curl http://127.0.0.1:3101/health` sends.
 */
describe('app-runtime:local-worker — only a loopback Host is answered', () => {
    let server: Server;

    /** A raw request, because `fetch` will not let a caller choose the `Host` header. */
    function request(
        method: 'GET' | 'POST',
        path: string,
        host: string,
    ): Promise<{ status: number; body: string }> {
        const { port } = server.address() as AddressInfo;
        return new Promise((resolve, reject) => {
            const req = httpRequest(
                {
                    host: '127.0.0.1',
                    port,
                    method,
                    path,
                    headers: { host, 'content-type': 'application/json' },
                },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => (body += chunk));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
                },
            );
            req.on('error', reject);
            if (method === 'POST') {
                req.write(JSON.stringify({ task: 'app-deploy', payload: { workId: 'w' } }));
            }
            req.end();
        });
    }

    beforeEach(async () => {
        deployRunner.mockReset();
        deployRunner.mockResolvedValue({ status: 'ran' });
        server = await startLocalWorkerServer({
            queue: new LocalAppRuntimeQueue(1),
            context: {} as INestApplicationContext,
            bootError: null,
            port: 0,
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('refuses POST /run for a rebinding Host, and runs nothing', async () => {
        const { port } = server.address() as AddressInfo;

        const { status, body } = await request('POST', '/run', `attacker.example:${port}`);

        expect(status).toBe(403);
        expect(JSON.parse(body)).toMatchObject({ ok: false, reason: 'host_not_allowed' });
        expect(deployRunner).not.toHaveBeenCalled();
    });

    it('refuses GET /health for a rebinding Host too', async () => {
        const { port } = server.address() as AddressInfo;

        const { status } = await request('GET', '/health', `attacker.example:${port}`);

        expect(status).toBe(403);
    });

    it('refuses a loopback name with another port — that is another origin', async () => {
        const { port } = server.address() as AddressInfo;

        const { status } = await request('GET', '/health', `127.0.0.1:${port + 1}`);

        expect(status).toBe(403);
    });

    it('answers 127.0.0.1:<port> and localhost:<port>, the names a local caller uses', async () => {
        const { port } = server.address() as AddressInfo;

        const health = await request('GET', '/health', `127.0.0.1:${port}`);
        const run = await request('POST', '/run', `localhost:${port}`);

        expect(health.status).toBe(200);
        expect(run.status).toBe(200);
        expect(deployRunner).toHaveBeenCalledTimes(1);
    });
});
