import type { Provider } from '@nestjs/common';
import { FleetJobRepository, FleetJobService, toJobView } from '@ever-works/agent/fleet';
import {
    NodeDispatcherFactory,
    NodeJobRuntimePlugin,
    type FleetJobStore,
} from '@ever-works/job-runtime-node-plugin';

/**
 * Desktop PRD §6.2 / M4 — the operator-side construction of the `node`
 * job runtime.
 *
 * `job-runtime-node` ships the provider (`NodeJobRuntimePlugin`) and the
 * dispatcher (`NodeDispatcherFactory`), but both are inert until an
 * operator hands them the store their "queue" actually lives in. The
 * plugin package deliberately cannot do that itself — it must not import
 * `@ever-works/agent` (that would be a package cycle) — so it declares
 * the narrow {@link FleetJobStore} port and the wiring happens HERE,
 * exactly the way every sibling runtime is handed its own client.
 *
 * Before this file the fleet runtime was unreachable code: selecting
 * `EVER_WORKS_JOB_RUNTIME=node` (or setting a `tenant_job_runtime_config`
 * row to `node`) resolved to a plugin whose dispatcher factory was never
 * set, so `FleetJobService.enqueue` had zero production callers and an
 * enrolled machine's queue was permanently empty.
 *
 * ## Why this does NOT overwrite the instance-global active provider
 *
 * `JOB_RUNTIME_PROVIDER_REGISTRY` currently hands ONE provider's
 * `dispatchers` bag to all 11 internal `*_DISPATCHER` symbols (work
 * generation, KB embed/mirror/transcribe, webhook delivery, …). A fleet
 * node executes command-shaped work — a command and an exit code — and
 * has no model access and no platform credentials, so it cannot serve
 * those eleven. Registering it as the global active provider would
 * therefore replace surfaces it cannot implement, and every one of them
 * would start throwing `NodeDispatcherNotConfiguredError`. The fleet is
 * wired into the path it CAN serve instead: the agent-run dispatch path
 * (`AGENT_TASK_EXECUTE_DISPATCHER` → `FleetRunRouterService`), which is
 * where "run this Task on the owner's machine" actually means something.
 */

/** DI token for the {@link FleetJobStore} adapter over the fleet services. */
export const NODE_JOB_RUNTIME_STORE = 'NODE_JOB_RUNTIME_STORE' as const;

/** DI token for the constructed {@link NodeDispatcherFactory}. */
export const NODE_JOB_RUNTIME_DISPATCHER_FACTORY = 'NODE_JOB_RUNTIME_DISPATCHER_FACTORY' as const;

/** DI token for the constructed {@link NodeJobRuntimePlugin}. */
export const NODE_JOB_RUNTIME_PLUGIN = 'NODE_JOB_RUNTIME_PLUGIN' as const;

/**
 * Adapter from the plugin's narrow store port onto the real server-side
 * services. A pass-through by design: `FleetJobService` already IS the
 * lease protocol, and `FleetJobRepository` already resolves a row by id
 * — re-implementing either here would be a second place for the state
 * machine to drift.
 */
export function createFleetJobStore(
    jobs: FleetJobService,
    repository: FleetJobRepository,
): FleetJobStore {
    return {
        enqueue: (request) => jobs.enqueue(request),
        findById: async (jobId: string) => {
            const row = await repository.findById(jobId);
            return row ? toJobView(row) : null;
        },
        // Agent execution v2 (slice B) — before this the port's optional
        // `cancel` was simply absent, so `NodeJobRuntimePlugin.cancel`
        // answered `false` for every fleet job and a cancelled run kept
        // executing on the PC. A queued job is dropped; an active one is
        // flagged and the node aborts on its next refused heartbeat.
        cancel: async (jobId: string) => (await jobs.cancel(jobId)).cancelled,
    };
}

/**
 * NestJS providers that construct the fleet store adapter, the
 * dispatcher factory over it, and the plugin bound to that factory.
 *
 * Exported as a function (rather than inlined in the module) so a test
 * can build the same three objects over stub services and assert the
 * enqueue actually reaches `FleetJobService`.
 */
export function buildNodeJobRuntimeProviders(): Provider[] {
    return [
        {
            provide: NODE_JOB_RUNTIME_STORE,
            useFactory: (jobs: FleetJobService, repository: FleetJobRepository) =>
                createFleetJobStore(jobs, repository),
            inject: [FleetJobService, FleetJobRepository],
        },
        {
            provide: NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
            useFactory: (store: FleetJobStore) => new NodeDispatcherFactory({ store }),
            inject: [NODE_JOB_RUNTIME_STORE],
        },
        {
            provide: NODE_JOB_RUNTIME_PLUGIN,
            useFactory: (factory: NodeDispatcherFactory) =>
                new NodeJobRuntimePlugin().useDispatcherFactory(factory),
            inject: [NODE_JOB_RUNTIME_DISPATCHER_FACTORY],
        },
    ];
}
