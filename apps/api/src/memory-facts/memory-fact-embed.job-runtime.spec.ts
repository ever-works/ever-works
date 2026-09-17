import { Test } from '@nestjs/testing';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
    BullMqDispatcherFactory,
    BullMqJobRuntimePlugin,
    BullMqWorkerHostFactory,
    type BullMqDeps,
    type BullMqJobView,
} from '@ever-works/job-runtime-bullmq-plugin';
import {
    PgBossDispatcherFactory,
    PgBossJobRuntimePlugin,
    PgBossWorkerHostFactory,
    type PgBossInstance,
    type PgBossJobView,
} from '@ever-works/job-runtime-pgboss-plugin';
import {
    InMemoryJobRuntimeProviderRegistry,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    MEMORY_FACT_EMBED_DISPATCHER,
    MEMORY_FACT_EMBED_JOB_ID,
    buildJobRuntimeProviders,
    runMemoryFactEmbedJob,
    type MemoryFactEmbedDispatcher,
    type MemoryFactEmbedPayload,
} from '@ever-works/agent/tasks';

/**
 * AW-07 — `memory-fact-embed` is not a Trigger.dev-only job.
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` resolves through the job-runtime binding
 * factory (`buildJobRuntimeProviders()` → `JOB_RUNTIME_PROVIDER_REGISTRY` →
 * the ACTIVE provider's `dispatchers`), the same seam every other
 * `*_DISPATCHER` symbol uses. This spec proves it end to end on two
 * different, real provider plugins — BullMQ and pg-boss — with the plugins'
 * own dispatcher and worker-host factories, the way an operator wires them
 * (see each plugin's README): the dispatcher is resolved from a Nest
 * container, the enqueue lands on the runtime's queue, and the runtime's
 * worker host runs the runtime-neutral `runMemoryFactEmbedJob` handler.
 *
 * The queue transports are in-memory fakes of the `bullmq` / `pg-boss`
 * surfaces the plugins declare (`BullMqDeps`, `PgBossInstance`) — the
 * plugin packages themselves never import either library.
 */

const FACT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PAYLOAD: MemoryFactEmbedPayload = { factId: FACT_ID, userId: USER_ID };

/** In-memory stand-in for `bullmq`'s Queue/Worker pair: add() runs the worker inline. */
function createFakeBullMq() {
    const processors = new Map<string, (job: BullMqJobView) => Promise<unknown>>();
    const queueOpts: Array<{ name: string; opts?: Readonly<Record<string, unknown>> }> = [];
    const processed: unknown[] = [];
    let seq = 0;

    class FakeQueue {
        constructor(
            private readonly name: string,
            opts?: Readonly<Record<string, unknown>>,
        ) {
            queueOpts.push({ name, opts });
        }
        async add(jobName: string, data: unknown) {
            const id = `bull-${++seq}`;
            const processor = processors.get(this.name);
            if (processor) processed.push(await processor({ id, name: jobName, data }));
            return { id };
        }
        async close() {
            /* nothing held */
        }
    }

    class FakeWorker {
        constructor(name: string, processor: (job: BullMqJobView) => Promise<unknown>) {
            processors.set(name, processor);
        }
        on() {
            /* no events in the fake */
        }
        async close() {
            /* nothing held */
        }
    }

    const deps = { Queue: FakeQueue, Worker: FakeWorker } as unknown as BullMqDeps;
    return { deps, processors, processed, queueOpts };
}

/** In-memory stand-in for a `pg-boss` instance: send() runs the worker inline. */
function createFakePgBoss() {
    const handlers = new Map<
        string,
        (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
    >();
    const processed: unknown[] = [];
    let seq = 0;
    const boss: PgBossInstance = {
        async createQueue() {
            /* idempotent no-op */
        },
        async send(name, data) {
            const id = `boss-${++seq}`;
            const handler = handlers.get(name);
            if (handler) processed.push(await handler([{ id, name, data }]));
            return id;
        },
        async work(name, _options, handler) {
            handlers.set(name, handler);
            return `sub-${name}`;
        },
        async cancel() {
            /* not exercised */
        },
        async start() {
            return undefined;
        },
        async stop() {
            /* not exercised */
        },
    };
    return { boss, handlers, processed };
}

/** Resolve the dispatcher exactly as the API does: through the binding factory. */
async function resolveDispatcher(
    provider: IJobRuntimeProvider | null,
): Promise<MemoryFactEmbedDispatcher | null> {
    const registry = new InMemoryJobRuntimeProviderRegistry();
    if (provider) registry.register(provider);
    const moduleRef = await Test.createTestingModule({
        providers: [
            { provide: JOB_RUNTIME_PROVIDER_REGISTRY, useValue: registry },
            ...buildJobRuntimeProviders(),
        ],
    }).compile();
    return moduleRef.get<MemoryFactEmbedDispatcher | null>(MEMORY_FACT_EMBED_DISPATCHER);
}

describe('memory-fact-embed on non-Trigger.dev job runtimes', () => {
    it('the binding factory binds MEMORY_FACT_EMBED_DISPATCHER', () => {
        const tokens = buildJobRuntimeProviders().map((p) => (p as { provide: symbol }).provide);
        expect(tokens).toContain(MEMORY_FACT_EMBED_DISPATCHER);
    });

    it('resolves to null with no runtime registered — the save path stays unembedded, not broken', async () => {
        await expect(resolveDispatcher(null)).resolves.toBeNull();
    });

    it('BullMQ: resolves through the registry, enqueues, and the worker host runs the handler', async () => {
        const bull = createFakeBullMq();
        const embedFact = jest.fn(async (factId: string) => ({ status: 'embedded', factId }));

        const dispatchers = new BullMqDispatcherFactory(bull.deps, { connection: {} });
        const workerHost = new BullMqWorkerHostFactory(bull.deps, { connection: {} });
        workerHost.register(MEMORY_FACT_EMBED_JOB_ID, (job) =>
            runMemoryFactEmbedJob(job.data, { embedFact }),
        );
        const plugin = new BullMqJobRuntimePlugin()
            .useDispatchers({
                dispatchMemoryFactEmbed: (payload: MemoryFactEmbedPayload) =>
                    dispatchers
                        .forQueue(MEMORY_FACT_EMBED_JOB_ID)
                        .dispatch(MEMORY_FACT_EMBED_JOB_ID, payload),
            })
            .useDispatcherFactory(dispatchers)
            .useWorkerHostFactory(workerHost);
        const handle = await plugin.startWorkerHost({ concurrency: 2 });

        const dispatcher = await resolveDispatcher(plugin);
        expect(dispatcher).toBe(plugin.dispatchers);

        const runId = await dispatcher!.dispatchMemoryFactEmbed(PAYLOAD);

        expect(runId).toBe('bull-1');
        expect(embedFact).toHaveBeenCalledWith(FACT_ID);
        expect(bull.processed).toEqual([{ status: 'embedded', factId: FACT_ID }]);
        await handle.stop();
    });

    it('pg-boss: resolves through the registry, enqueues, and the worker host runs the handler', async () => {
        const pg = createFakePgBoss();
        const embedFact = jest.fn(async (factId: string) => ({ status: 'embedded', factId }));

        const dispatchers = new PgBossDispatcherFactory({ boss: pg.boss });
        const workerHost = new PgBossWorkerHostFactory({ boss: pg.boss });
        workerHost.register(MEMORY_FACT_EMBED_JOB_ID, { teamSize: 2 }, async (jobs) => {
            const batch = Array.isArray(jobs) ? jobs : [jobs];
            const outcomes = [];
            for (const job of batch as PgBossJobView[]) {
                outcomes.push(await runMemoryFactEmbedJob(job.data, { embedFact }));
            }
            return outcomes;
        });
        const plugin = new PgBossJobRuntimePlugin()
            .useDispatchers({
                dispatchMemoryFactEmbed: (payload: MemoryFactEmbedPayload) =>
                    dispatchers.send(MEMORY_FACT_EMBED_JOB_ID, payload),
            })
            .useDispatcherFactory(dispatchers)
            .useWorkerHostFactory(workerHost);
        await plugin.startWorkerHost();

        const dispatcher = await resolveDispatcher(plugin);
        const runId = await dispatcher!.dispatchMemoryFactEmbed(PAYLOAD);

        expect(runId).toBe('boss-1');
        expect(embedFact).toHaveBeenCalledWith(FACT_ID);
        expect(pg.processed).toEqual([[{ status: 'embedded', factId: FACT_ID }]]);
    });

    it('the handler refuses a non-UUID fact id on every runtime, before the embed service', async () => {
        const pg = createFakePgBoss();
        const embedFact = jest.fn();
        const workerHost = new PgBossWorkerHostFactory({ boss: pg.boss });
        workerHost.register(MEMORY_FACT_EMBED_JOB_ID, {}, async (jobs) => {
            const [job] = (Array.isArray(jobs) ? jobs : [jobs]) as PgBossJobView[];
            return runMemoryFactEmbedJob(job.data, { embedFact });
        });
        await workerHost.start();

        await expect(
            pg.boss.send(MEMORY_FACT_EMBED_JOB_ID, { factId: "1' OR 1=1", userId: USER_ID }),
        ).rejects.toThrow(/Invalid payload.factId/);
        expect(embedFact).not.toHaveBeenCalled();
    });

    it('the tenant overlay applies: a bound tenant view enqueues on its own queue prefix', async () => {
        const bull = createFakeBullMq();
        const embedFact = jest.fn(async (factId: string) => ({ status: 'embedded', factId }));
        const workerHost = new BullMqWorkerHostFactory(bull.deps, {
            connection: {},
            prefix: 'tenant-acme',
        });
        workerHost.register(MEMORY_FACT_EMBED_JOB_ID, (job) =>
            runMemoryFactEmbedJob(job.data, { embedFact }),
        );
        await workerHost.start();

        const plugin = new BullMqJobRuntimePlugin({
            dispatchersBuilder: (snapshot) => {
                const perTenant = new BullMqDispatcherFactory(bull.deps, {
                    connection: {},
                    prefix: String(snapshot.credentials.queuePrefix),
                });
                return {
                    dispatchMemoryFactEmbed: (payload: MemoryFactEmbedPayload) =>
                        perTenant
                            .forQueue(MEMORY_FACT_EMBED_JOB_ID)
                            .dispatch(MEMORY_FACT_EMBED_JOB_ID, payload),
                };
            },
        });
        const snapshot: TenantCredentialSnapshot = {
            tenantId: 'tenant-acme',
            providerId: 'bullmq',
            credentialVersion: 1,
            credentials: { queuePrefix: 'tenant-acme' },
        };

        const view = plugin.bindToTenant(snapshot);
        const runId = await (
            view.dispatchers as unknown as MemoryFactEmbedDispatcher
        ).dispatchMemoryFactEmbed(PAYLOAD);

        expect(runId).toBeTruthy();
        expect(bull.queueOpts).toContainEqual({
            name: MEMORY_FACT_EMBED_JOB_ID,
            opts: expect.objectContaining({ prefix: 'tenant-acme' }),
        });
        expect(embedFact).toHaveBeenCalledWith(FACT_ID);
    });
});
