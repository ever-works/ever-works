import type { ComputerSessionService } from '@ever-works/agent/computer';
import { ComputerSessionEndedEvent } from '@ever-works/agent/computer';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { NodeDispatcherFactory, type FleetJobStore } from '@ever-works/job-runtime-node-plugin';
import { ComputerRelayRegistry } from './computer-relay.registry';
import { createComputerSessionDispatcher } from './computer-session.dispatcher.provider';
import { ComputerSessionListener } from './computer-session.listener';

/**
 * The glue that keeps a live view honest from outside the owner's own
 * "End session": an ended session always pins its end frame, a settled
 * fleet job always ends its session, and the session job reaches the fleet
 * through the real node dispatcher factory with derived capability tags.
 */

const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

describe('ComputerSessionListener', () => {
    function build() {
        const sessions = {
            closeForSettledJob: jest.fn(async () => undefined),
            withdrawLeaseIfOver: jest.fn(async () => false),
        };
        const relay = new ComputerRelayRegistry();
        const listener = new ComputerSessionListener(
            sessions as unknown as ComputerSessionService,
            relay,
        );
        return { listener, sessions, relay };
    }

    it('pins the end frame for every attached and later viewer', () => {
        const { listener, relay } = build();
        const received: string[] = [];
        relay.attach(SESSION, { id: 'v', role: 'viewer', send: (wire) => received.push(wire) });

        listener.onSessionEnded(new ComputerSessionEndedEvent(SESSION, 'node-1', 'stopped'));

        expect(received.map((wire) => JSON.parse(wire))).toEqual([
            { kind: 'end', reason: 'stopped' },
        ]);
        expect(relay.getStatus(SESSION)).toMatchObject({ ended: true, endReason: 'stopped' });
    });

    it('ends the session its settled job carried, and ignores every other kind of job', async () => {
        const { listener, sessions } = build();
        const job = (kind: string, payload: Record<string, unknown> | null) =>
            ({ id: 'job-1', kind, status: 'failed', payload }) as never;

        await listener.onJobCompleted(
            new FleetJobCompletedEvent(
                job('agent-task', { sessionId: SESSION }),
                'u',
                'lease-expired' as never,
            ),
        );
        await listener.onJobCompleted(
            new FleetJobCompletedEvent(
                job('computer-session', null),
                'u',
                'lease-expired' as never,
            ),
        );
        expect(sessions.closeForSettledJob).not.toHaveBeenCalled();

        await listener.onJobCompleted(
            new FleetJobCompletedEvent(
                job('computer-session', { sessionId: SESSION }),
                'u',
                'node-report' as never,
            ),
        );
        expect(sessions.closeForSettledJob).toHaveBeenCalledWith(SESSION, 'job-1');
    });

    it('checks every leased session job against its view, and ignores every other kind of job', async () => {
        const { listener, sessions } = build();
        const leased = (kind: string, payload: Record<string, unknown> | null) =>
            new FleetJobLeasedEvent(
                { id: 'job-1', kind, status: 'leased', payload } as never,
                'node-1',
                'owner-1',
            );

        await listener.onJobLeased(leased('agent-task', { sessionId: SESSION }));
        await listener.onJobLeased(leased('computer-session', null));
        expect(sessions.withdrawLeaseIfOver).not.toHaveBeenCalled();

        await listener.onJobLeased(leased('computer-session', { sessionId: SESSION }));
        expect(sessions.withdrawLeaseIfOver).toHaveBeenCalledWith(SESSION, 'job-1');

        sessions.withdrawLeaseIfOver.mockRejectedValueOnce(new Error('db down'));
        jest.spyOn(
            (listener as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        await expect(
            listener.onJobLeased(leased('computer-session', { sessionId: SESSION })),
        ).resolves.toBeUndefined();
    });

    it('never throws into the event bus', async () => {
        const { listener, sessions } = build();
        sessions.closeForSettledJob.mockRejectedValueOnce(new Error('db down'));
        jest.spyOn(
            (listener as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        await expect(
            listener.onJobCompleted(
                new FleetJobCompletedEvent(
                    {
                        id: 'job-1',
                        kind: 'computer-session',
                        payload: { sessionId: SESSION },
                    } as never,
                    'u',
                    'node-report' as never,
                ),
            ),
        ).resolves.toBeUndefined();
    });
});

describe('createComputerSessionDispatcher', () => {
    function store() {
        const enqueued: Array<Record<string, unknown>> = [];
        const fleetStore: FleetJobStore = {
            enqueue: jest.fn(async (request) => {
                enqueued.push(request as never);
                return { id: 'job-7' } as never;
            }),
            cancel: jest.fn(async () => true),
        };
        return { enqueued, fleetStore };
    }

    const payload = {
        sessionId: SESSION,
        userId: 'owner-1',
        organizationId: null,
        agentId: 'agent-1',
        nodeId: 'node-1',
        profileKey: 'opaque',
        quality: 'sharp' as const,
    };

    it('enqueues one idempotent, single-attempt job whose tags come from the channels', async () => {
        const { enqueued, fleetStore } = store();
        const dispatcher = createComputerSessionDispatcher(
            new NodeDispatcherFactory({ store: fleetStore }),
        );

        expect(await dispatcher.enqueue({ ...payload, channels: ['terminal'] })).toEqual({
            jobId: 'job-7',
        });

        expect(enqueued[0]).toMatchObject({
            userId: 'owner-1',
            kind: 'computer-session',
            requiredCapabilities: ['attended', 'terminal'],
            maxAttempts: 1,
            idempotencyKey: `computer-session:${SESSION}`,
            payload: expect.objectContaining({
                sessionId: SESSION,
                nodeId: 'node-1',
                channels: ['terminal'],
            }),
        });
        expect(enqueued[0].requiredCapabilities).not.toContain('screen');
    });

    it('withdraws a job through the factory’s cancel', async () => {
        const { fleetStore } = store();
        const dispatcher = createComputerSessionDispatcher(
            new NodeDispatcherFactory({ store: fleetStore }),
        );
        expect(await dispatcher.cancel?.('job-7')).toBe(true);
        expect(fleetStore.cancel).toHaveBeenCalledWith('job-7');
    });
});
