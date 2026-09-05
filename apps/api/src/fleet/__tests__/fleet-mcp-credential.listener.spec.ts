import type { FleetJobView } from '@ever-works/contracts';
import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import type { FleetRunCredentialService } from '@ever-works/agent/fleet';
import { FleetMcpCredentialListener } from '../fleet-mcp-credential.listener';

/**
 * Self-build slice Z (EW-796) — "the token dies with the job", enforced
 * on the platform side.
 *
 * The node revokes explicitly at the end of its model step, and that is
 * the fast path. This listener is what covers the cases where the node
 * never gets there: it lost power, lost the network, or was drained
 * mid-run. Every one of those still settles the job — through a node
 * report, a cancel, the reclaim sweep, or the queue SLA — and every one
 * of those emits the SAME completion event.
 *
 * So the property under test is coverage: all four completion sources
 * revoke, and a revoke that throws is swallowed rather than allowed to
 * break the reconciliation chain behind it.
 */

function jobView(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: 'node-1',
        requiredCapabilities: [],
        payload: { taskId: 't1', runId: 'run-1' },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        ...over,
    };
}

function build(revokeForJob = jest.fn(async () => 1)) {
    const credentials = { revokeForJob } as unknown as FleetRunCredentialService;
    return { listener: new FleetMcpCredentialListener(credentials), revokeForJob };
}

/**
 * The listener is deliberately source-AGNOSTIC — that is the property
 * being pinned — so `source` is taken as a plain string here and widened
 * at the one call site rather than being enumerated against a union the
 * listener never reads.
 */
function completed(source: string, over: Partial<FleetJobView> = {}): FleetJobCompletedEvent {
    return new FleetJobCompletedEvent(
        jobView(over),
        'owner-1',
        source as ConstructorParameters<typeof FleetJobCompletedEvent>[2],
        'node-1',
    );
}

describe('FleetMcpCredentialListener', () => {
    it.each(['node-report', 'cancelled', 'lease-exhausted', 'queue-expired'])(
        'revokes when the job settles via %s',
        async (source) => {
            const { listener, revokeForJob } = build();

            await listener.onCompleted(completed(source));

            expect(revokeForJob).toHaveBeenCalledWith('job-1', 'job-settled');
        },
    );

    it('revokes a FAILED job as readily as a successful one', async () => {
        const { listener, revokeForJob } = build();

        await listener.onCompleted(completed('node-report', { status: 'failed' }));

        expect(revokeForJob).toHaveBeenCalledWith('job-1', 'job-settled');
    });

    it('ignores job kinds that can never carry a bridge', async () => {
        const { listener, revokeForJob } = build();

        await listener.onCompleted(completed('node-report', { kind: 'acceptance-checks' }));
        await listener.onCompleted(completed('node-report', { kind: 'browser-check' }));

        expect(revokeForJob).not.toHaveBeenCalled();
    });

    it('swallows a failing revoke rather than breaking the completion chain', async () => {
        const revokeForJob = jest.fn(async () => {
            throw new Error('database unreachable');
        });
        const { listener } = build(revokeForJob as never);

        await expect(listener.onCompleted(completed('node-report'))).resolves.toBeUndefined();
        // The token still expires with the lease it was minted under, so a
        // failed revoke narrows the window rather than opening one.
        expect(revokeForJob).toHaveBeenCalled();
    });

    it('is idempotent: a second completion for the same job revokes nothing more', async () => {
        const revokeForJob = jest
            .fn<Promise<number>, [string, string]>()
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        const { listener } = build(revokeForJob as never);
        const event = completed('node-report');

        await listener.onCompleted(event);
        await listener.onCompleted(event);

        expect(revokeForJob).toHaveBeenCalledTimes(2);
        await expect(revokeForJob.mock.results[1]?.value).resolves.toBe(0);
    });

    it('subscribes to the one event every terminal path emits', () => {
        // If this constant ever changes, the revoke silently stops firing —
        // the listener would keep compiling and keep doing nothing.
        expect(FleetJobCompletedEvent.EVENT_NAME).toBe('fleet.job.completed');
    });
});
