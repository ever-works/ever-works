import type { Provider } from '@nestjs/common';
import {
    AGENT_SESSION_DISPATCHER,
    agentSessionIdempotencyKey,
    buildAgentSessionEnqueueRequest,
    FleetJobRepository,
    type AgentSessionDispatcher,
} from '@ever-works/agent/fleet';
import type { NodeDispatcherFactory } from '@ever-works/job-runtime-node-plugin';
import { NODE_JOB_RUNTIME_DISPATCHER_FACTORY } from '../node-job-runtime.providers';

/**
 * Sessions on computers (FL-04 P2) — bind the Agent-session dispatch port to
 * the fleet's node job runtime, the same dispatcher factory the agent-run and
 * computer-session paths enqueue through (one set of enqueue semantics: owner
 * required, capability tags de-duplicated, idempotency honoured, cancel
 * delivered the one way the store knows).
 *
 * `cancelForSession` finds the job by its idempotency key
 * (`fleet-session:<id>`), so the session row needs no job-id column.
 */
export function createAgentSessionDispatcher(
    factory: NodeDispatcherFactory,
    jobs: FleetJobRepository,
): AgentSessionDispatcher {
    return {
        async enqueue(input) {
            const request = buildAgentSessionEnqueueRequest(input);
            const jobId = await factory.enqueue(
                {
                    kind: request.kind,
                    userId: request.userId,
                    organizationId: request.organizationId,
                    payload: request.payload,
                    requiredCapabilities: request.requiredCapabilities,
                    maxAttempts: request.maxAttempts,
                },
                { idempotencyKey: request.idempotencyKey },
            );
            return { jobId };
        },
        async cancelForSession(fleetSessionId) {
            const job = await jobs.findByIdempotencyKey(agentSessionIdempotencyKey(fleetSessionId));
            if (!job) return false;
            // Already settled: nothing to withdraw.
            if (job.status === 'done' || job.status === 'failed') return true;
            return factory.cancel(job.id);
        },
    };
}

export const agentSessionDispatcherProvider: Provider = {
    provide: AGENT_SESSION_DISPATCHER,
    useFactory: (factory: NodeDispatcherFactory, jobs: FleetJobRepository) =>
        createAgentSessionDispatcher(factory, jobs),
    inject: [NODE_JOB_RUNTIME_DISPATCHER_FACTORY, FleetJobRepository],
};
