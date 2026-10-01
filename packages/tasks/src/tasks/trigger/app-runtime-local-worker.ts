import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { isAppClusterWorkerContext } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_TASK_QUEUE,
    TriggerAppRuntimeModule,
} from '../../trigger/worker/modules/trigger-app-runtime.module';
import { runAppDeployTask, APP_DEPLOY_TASK_ID } from './app-deploy.task';
import { runAppSmokeTask, APP_SMOKE_TASK_ID } from './app-smoke.task';
import { runAppClusterOpTask, APP_CLUSTER_OP_TASK_ID } from './app-cluster-op.task';
import { runAppHealthPollTask, APP_HEALTH_POLL_TASK_ID } from './app-health-poll.task';

/**
 * APW-06 T32 (`tasks.md:563-566`, plan §9.2:1267-1270) — **the `app-runtime:local-worker` entry
 * point**.
 *
 * > Outside production only, `EVER_WORKS_APPS_LOCAL_WORKER=true` switches dispatch to a local
 * > worker process: `pnpm --filter @ever-works/trigger-tasks app-runtime:local-worker` boots
 * > `TriggerAppRuntimeModule` and runs the same exported task run functions from a local queue.
 * > Production refuses to boot with that flag set.
 *
 * ## Why this file exists at all
 *
 * The `app-*` cluster tasks normally run inside Trigger.dev, where a run is a process of its own and
 * `NestFactory.createApplicationContext` is cheap. A developer machine and the e2e lane (FR-55)
 * have no Trigger.dev project wired, so without this entry point every App cluster path answers
 * `dispatch_unavailable` and ACC-E2E-02's twin, ACC-NEG-09 and T30/T31 cannot be exercised.
 *
 * ## "the same exported task run functions" is literal
 *
 * The four runners below are **imported from the four task files** — `runAppDeployTask`,
 * `runAppSmokeTask`, `runAppClusterOpTask`, `runAppHealthPollTask` — and are exactly the functions
 * the Trigger registrations use (`run: runAppDeployTask`, …). There is no second implementation of
 * any of them, so a change to a task body cannot reach one runtime and miss the other.
 *
 * ## The local queue
 *
 * {@link LocalAppRuntimeQueue} is a FIFO with the same concurrency limit the Trigger queue declares
 * (`app-cluster-io`, 20). `POST /run` submits into it and awaits the result, so a dispatcher sees
 * the same request/answer shape it would see from `trigger` + a status poll, and two concurrent
 * submits for the same Work are still the task's own problem (the deploy lock), not the queue's.
 *
 * ## The two hard rules
 *
 * 1. **`NODE_ENV=production` refuses to start** — and exits non-zero, before a context is booted, a
 *    port is bound or an internal secret is read. This worker runs cluster I/O outside Trigger.dev's
 *    isolated runtime, so it must never be a production path (§6.2:950-952, CONTRACTS §7).
 * 2. **No credential is ever printed.** The startup log names variables, never values.
 *
 * ## The health endpoint, and why it answers 200 even when degraded
 *
 * `.github/workflows/e2e.yml` waits for `GET http://127.0.0.1:3101/health` with `curl -sSf` ("App
 * runtime worker ready"), i.e. 2xx ⇔ up. If the module cannot boot there — in that workflow
 * `TRIGGER_INTERNAL_API_URL` / `TRIGGER_INTERNAL_SECRET` are **not** set, and the RPC client throws
 * when the URL is unset — answering non-2xx would fail the whole shard at "Starting the App runtime
 * worker", which is strictly worse than running the lane with App cluster work refused *by name*.
 * So a failed boot is reported loudly (stderr, `GET /health`'s `boot.error`, and a `503` from
 * `POST /run`) while the process still starts. A dispatcher therefore never sees a fake success:
 * it sees `503` with the boot error.
 *
 * The URL is defaulted to the local API's own address when unset (the local worker's counterpart
 * *is* the local API, `API_URL` in that workflow is `http://127.0.0.1:3100`). The **secret is
 * never defaulted**: a shared secret with a fallback value is a shared secret nobody rotated.
 *
 * ## Running it
 *
 * `pnpm --filter @ever-works/trigger-tasks app-runtime:local-worker` runs the compiled entry point
 * (`node dist/tasks/trigger/app-runtime-local-worker.js`), exactly as `start:prod` runs the API
 * from `dist/` — so `pnpm --filter @ever-works/trigger-tasks build` has to have run, which the e2e
 * workflow's "Build all packages" step does before it starts this worker. No credential is read at
 * import time, so importing this file (the barrel does) has no side effect.
 */

/** The task ids this worker drains, in §9.2's order. */
export const APP_RUNTIME_LOCAL_TASK_IDS = [
    APP_DEPLOY_TASK_ID,
    APP_SMOKE_TASK_ID,
    APP_CLUSTER_OP_TASK_ID,
    APP_HEALTH_POLL_TASK_ID,
] as const;

/** The port `.github/workflows/e2e.yml` curls. Overridable, but the default is a contract. */
export const APP_RUNTIME_LOCAL_WORKER_PORT = 3101 as const;

/** `true` ⇔ the API-side switch that routes App cluster dispatch at this worker is on. */
export const APP_RUNTIME_LOCAL_WORKER_FLAG = 'EVER_WORKS_APPS_LOCAL_WORKER' as const;

/** One entry of the local queue. */
interface LocalJob {
    id: string;
    task: string;
    payload: unknown;
    resolve: (value: LocalJobResult) => void;
}

/** What the queue answers for one job. */
export interface LocalJobResult {
    jobId: string;
    task: string;
    ok: boolean;
    result: unknown;
    error: string | null;
}

/**
 * The providers the local worker's tasks resolve. `health-poll` takes no payload; the other three
 * take the payload the dispatcher would have sent.
 */
const TASK_RUNNERS: Record<string, (payload: unknown) => Promise<unknown>> = {
    [APP_DEPLOY_TASK_ID]: (payload) => runAppDeployTask(payload as never),
    [APP_SMOKE_TASK_ID]: (payload) => runAppSmokeTask(payload as never),
    [APP_CLUSTER_OP_TASK_ID]: (payload) => runAppClusterOpTask(payload as never),
    [APP_HEALTH_POLL_TASK_ID]: () => runAppHealthPollTask(),
};

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `[app-runtime-local-worker]`-prefixed stderr line — this is a plain node process, not a run. */
function logError(message: string): void {
    // eslint-disable-next-line no-console
    console.error(`[app-runtime-local-worker] ${message}`);
}

/** `[app-runtime-local-worker]`-prefixed stdout line. */
function logInfo(message: string): void {
    // eslint-disable-next-line no-console
    console.log(`[app-runtime-local-worker] ${message}`);
}

/**
 * The local queue: a FIFO drained by at most `concurrency` runners at a time — the same limit
 * `app-cluster-io` declares, so a dev machine cannot accidentally run more cluster ops at once than
 * production would (`AppRuntimeTaskQueue.concurrencyLimit`, plan §6.2:942).
 */
export class LocalAppRuntimeQueue {
    private readonly pending: LocalJob[] = [];
    private running = 0;
    private sequence = 0;

    constructor(private readonly concurrency: number = APP_RUNTIME_TASK_QUEUE.concurrencyLimit) {}

    /** How many jobs are waiting and how many are executing — reported by `GET /health`. */
    get state(): { running: number; pending: number; concurrency: number } {
        return {
            running: this.running,
            pending: this.pending.length,
            concurrency: this.concurrency,
        };
    }

    submit(task: string, payload: unknown): Promise<LocalJobResult> {
        const runner = TASK_RUNNERS[task];
        const jobId = `app-local-${++this.sequence}`;

        if (!runner) {
            // Refused before it is queued: an unknown id is a dispatcher bug, not a job.
            return Promise.resolve({
                jobId,
                task,
                ok: false,
                result: null,
                error: `unknown task "${task}" — this worker drains ${APP_RUNTIME_LOCAL_TASK_IDS.join(
                    ', ',
                )}`,
            });
        }

        return new Promise<LocalJobResult>((resolve) => {
            this.pending.push({ id: jobId, task, payload, resolve });
            this.drain();
        });
    }

    private drain(): void {
        while (this.running < this.concurrency && this.pending.length > 0) {
            const job = this.pending.shift() as LocalJob;
            this.running += 1;

            void runOne(job).then((result) => {
                this.running -= 1;
                job.resolve(result);
                this.drain();
            });
        }
    }
}

/** Execute one job. Never rejects — a task's own refusal is a `result`, a throw is an `error`. */
async function runOne(job: LocalJob): Promise<LocalJobResult> {
    try {
        const result = await TASK_RUNNERS[job.task](job.payload);
        return { jobId: job.id, task: job.task, ok: true, result, error: null };
    } catch (error) {
        const message = errorText(error);
        logError(`${job.task} ${job.id} threw — ${message}`);
        return { jobId: job.id, task: job.task, ok: false, result: null, error: message };
    }
}

/** Read the request body, with a bound so a runaway client cannot exhaust the worker. */
async function readBody(request: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('request body too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
    });
    response.end(text);
}

/**
 * `GET /health` — the readiness gate `.github/workflows/e2e.yml` waits on — plus `GET /tasks` and
 * `POST /run`, which is how a local dispatcher submits work.
 *
 * Bound to `127.0.0.1` **only**: this process holds the platform's cluster credentials, so it must
 * not be reachable from another host even on a dev machine.
 */
export function startLocalWorkerServer(input: {
    queue: LocalAppRuntimeQueue;
    context: INestApplicationContext | null;
    bootError: string | null;
    port?: number;
    host?: string;
}): Promise<Server> {
    const port = input.port ?? APP_RUNTIME_LOCAL_WORKER_PORT;
    const host = input.host ?? '127.0.0.1';

    const health = () => ({
        status: input.context ? 'ok' : 'degraded',
        worker: 'app-runtime-local-worker',
        workerContext: isAppClusterWorkerContext(),
        queue: APP_RUNTIME_TASK_QUEUE.name,
        tasks: [...APP_RUNTIME_LOCAL_TASK_IDS],
        boot: input.context ? { ok: true, error: null } : { ok: false, error: input.bootError },
        queueState: input.queue.state,
    });

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = request.url ?? '/';

        if (request.method === 'GET' && (url === '/health' || url === '/health/')) {
            sendJson(response, 200, health());
            return;
        }

        if (request.method === 'GET' && (url === '/tasks' || url === '/tasks/')) {
            sendJson(response, 200, {
                tasks: [...APP_RUNTIME_LOCAL_TASK_IDS],
                queue: health().queue,
            });
            return;
        }

        if (request.method === 'POST' && (url === '/run' || url === '/run/')) {
            if (!input.context) {
                // Never a fake success: a dispatcher must see that nothing ran, and why.
                sendJson(response, 503, {
                    ok: false,
                    reason: 'worker_context_unavailable',
                    error: input.bootError,
                });
                return;
            }

            try {
                const body = await readBody(request);
                const parsed = body
                    ? (JSON.parse(body) as { task?: string; payload?: unknown })
                    : {};
                const task = typeof parsed?.task === 'string' ? parsed.task : '';

                if (!task) {
                    sendJson(response, 400, { ok: false, reason: 'missing_task' });
                    return;
                }

                const result = await input.queue.submit(task, parsed.payload);
                sendJson(response, result.ok ? 200 : 500, result);
            } catch (error) {
                sendJson(response, 400, {
                    ok: false,
                    reason: 'invalid_request',
                    error: errorText(error),
                });
            }
            return;
        }

        sendJson(response, 404, { ok: false, reason: 'not_found', path: url });
    };

    const server = createServer((request, response) => {
        void handle(request, response);
    });

    return new Promise<Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}

/**
 * The entry point. Returns the process exit code — the CLI shim at the bottom of this file is what
 * calls `process.exit`, so a spec can drive every branch **without killing the test runner**.
 *
 * `1` is reserved for the two cases that must not be survivable: the production refusal (T32's
 * "exits non-zero under `NODE_ENV=production`") and a port that cannot be bound.
 */
export async function main(): Promise<number> {
    if (process.env.NODE_ENV === 'production') {
        logError(
            'refusing to start: NODE_ENV=production. This worker runs App cluster I/O outside ' +
                "Trigger.dev's isolated runtime and must never be a production path " +
                '(APW-06 plan §6.2, CONTRACTS §7 EVER_WORKS_APPS_LOCAL_WORKER).',
        );
        return 1;
    }

    // The local worker's counterpart IS the local API. Defaulting the URL is safe (it is this
    // machine's own loopback and the caller still has to present the shared secret); defaulting the
    // SECRET is not, and is deliberately not done.
    //
    // The path is `/internal/trigger` because that is the controller's own mount
    // (`@Controller('internal/trigger')`) and the shape `apps/api/.env.example` documents —
    // `TRIGGER_INTERNAL_API_URL=http://localhost:3100/internal/trigger`. `TriggerInternalApiClient`
    // composes `/remote/call` onto whatever base it is given, so a bare origin would 404 every call.
    if (!process.env.TRIGGER_INTERNAL_API_URL) {
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${
            process.env.API_PORT ?? 3100
        }/internal/trigger`;
        logInfo(
            `TRIGGER_INTERNAL_API_URL was unset — using ${process.env.TRIGGER_INTERNAL_API_URL}`,
        );
    }

    logInfo(
        `${APP_RUNTIME_LOCAL_WORKER_FLAG}=${process.env[APP_RUNTIME_LOCAL_WORKER_FLAG] ?? '(unset)'}; ` +
            `queue=${APP_RUNTIME_TASK_QUEUE.name} (concurrency ${APP_RUNTIME_TASK_QUEUE.concurrencyLimit}); ` +
            `tasks=${APP_RUNTIME_LOCAL_TASK_IDS.join(', ')}`,
    );

    let context: INestApplicationContext | null = null;
    let bootError: string | null = null;

    try {
        context = await NestFactory.createApplicationContext(TriggerAppRuntimeModule, {
            logger: false,
            // NOT the default. `abortOnError: true` (Nest's default) calls `process.abort()` on a
            // DI error — the process dies with no message and nothing to catch, which is the
            // opposite of the degraded-but-loud behaviour this entry point promises (and is
            // exactly what its first run did: two info lines, no stderr, no port). With it false
            // the failure surfaces as an exception the block below reports, and the worker still
            // answers `/health`.
            abortOnError: false,
        });
    } catch (error) {
        bootError = errorText(error);
        logError(
            `TriggerAppRuntimeModule did not boot — the worker is starting DEGRADED and every ` +
                `POST /run will answer 503 until this is fixed: ${bootError}`,
        );
        logError(
            'the usual cause is a missing TRIGGER_INTERNAL_SECRET (the worker owns no DataSource, ' +
                'so every repository it reads is an internal RPC call); the secret is never defaulted.',
        );
    }

    const queue = new LocalAppRuntimeQueue();
    const port =
        Number(process.env.EVER_WORKS_APPS_LOCAL_WORKER_PORT) || APP_RUNTIME_LOCAL_WORKER_PORT;

    let server: Server;
    try {
        server = await startLocalWorkerServer({ queue, context, bootError, port });
    } catch (error) {
        logError(`could not bind 127.0.0.1:${port} — ${errorText(error)}`);
        await context?.close();
        return 1;
    }

    logInfo(
        `listening on http://127.0.0.1:${port} (GET /health, GET /tasks, POST /run) — ` +
            `worker-context flag: ${isAppClusterWorkerContext()}`,
    );

    return new Promise<number>((resolve) => {
        const shutdown = (signal: string) => {
            logInfo(`${signal} received — shutting down.`);
            server.close(() => {
                void (async () => {
                    await context?.close();
                    resolve(0);
                })();
            });
        };

        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
    });
}

/* istanbul ignore next — the CLI shim; `main` carries every branch a spec drives. */
if (require.main === module) {
    void main().then((code) => {
        process.exitCode = code;
        // Nothing else keeps the loop alive once a refusal returned, so exit explicitly.
        if (code !== 0) process.exit(code);
    });
}
