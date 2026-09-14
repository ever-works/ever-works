import type { Provider } from '@nestjs/common';
import {
    COMPUTER_SESSION_DISPATCHER,
    buildComputerSessionEnqueueRequest,
    type ComputerSessionDispatcher,
} from '@ever-works/agent/computer';
import type { NodeDispatcherFactory } from '@ever-works/job-runtime-node-plugin';
import { NODE_JOB_RUNTIME_DISPATCHER_FACTORY } from '../fleet/node-job-runtime.providers';

/**
 * Agent computers — bind the session dispatch port to the fleet's node job
 * runtime, the same dispatcher factory the agent-run path enqueues through.
 *
 * Going through the factory rather than calling `FleetJobService` directly
 * keeps one set of enqueue semantics for every fleet job: owner required,
 * capability tags de-duplicated, idempotency honoured, cancel delivered the
 * one way the store knows. The factory is the plugin's; nothing here names a
 * runtime.
 */
export function createComputerSessionDispatcher(
    factory: NodeDispatcherFactory,
): ComputerSessionDispatcher {
    return {
        async enqueue(payload) {
            const request = buildComputerSessionEnqueueRequest(payload);
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
        cancel: (jobId) => factory.cancel(jobId),
    };
}

export const computerSessionDispatcherProvider: Provider = {
    provide: COMPUTER_SESSION_DISPATCHER,
    useFactory: (factory: NodeDispatcherFactory) => createComputerSessionDispatcher(factory),
    inject: [NODE_JOB_RUNTIME_DISPATCHER_FACTORY],
};
