import {
    ComputerControlChangedEvent,
    ComputerSessionEndedEvent,
    type ComputerControlChange,
} from '@ever-works/agent/computer';
import { ActivityActionType } from '@ever-works/agent/entities';
import { ComputerControlListener } from './computer-control.listener';
import { ComputerRelayRegistry, type ComputerRelayClient } from './computer-relay.registry';

/**
 * The relay follows every change of control, whichever path moved the lock;
 * every stretch of control lands once on the Agent's Activity feed; and an
 * ended view never keeps a machine locked. None of it ever throws into the
 * event bus.
 */

const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

function change(patch: Partial<ComputerControlChange>): ComputerControlChange {
    return {
        nodeId: 'node-1',
        sessionId: SESSION,
        ownerUserId: 'user-1',
        agentId: 'agent-1',
        actorUserId: 'user-1',
        held: true,
        untilMs: Date.now() + 60_000,
        reason: null,
        heldMs: null,
        ...patch,
    };
}

function build() {
    const relay = new ComputerRelayRegistry(undefined, true);
    const control = { releaseForSession: jest.fn(async () => true) };
    const activityLog = { log: jest.fn(async () => ({})) };
    const listener = new ComputerControlListener(control as never, relay, activityLog as never);
    return { relay, control, activityLog, listener };
}

describe('ComputerControlListener', () => {
    it('applies a grant and a release to the relay, telling the machine each time', () => {
        const { relay, listener } = build();
        const node: string[] = [];
        const machine: ComputerRelayClient = {
            id: 'node',
            role: 'worker',
            send: (w) => node.push(w),
        };
        relay.attach(SESSION, machine);

        listener.onControlChanged(new ComputerControlChangedEvent(change({ held: true })));
        expect(relay.getControl(SESSION)).toMatchObject({ held: true });
        listener.onControlChanged(
            new ComputerControlChangedEvent(
                change({ held: false, untilMs: null, reason: 'given-back', heldMs: 125_000 }),
            ),
        );
        expect(relay.getControl(SESSION)).toEqual({ held: false, untilMs: null });
        expect(node.map((wire) => JSON.parse(wire))).toEqual([
            { kind: 'mode', mode: 'controlling' },
            { kind: 'mode', mode: 'watching' },
        ]);
    });

    it('writes one Activity row per stretch of control, on the Agent’s feed, when it ends', async () => {
        const { listener, activityLog } = build();
        listener.onControlChanged(new ComputerControlChangedEvent(change({ held: true })));
        expect(activityLog.log).not.toHaveBeenCalled();

        listener.onControlChanged(
            new ComputerControlChangedEvent(
                change({ held: false, untilMs: null, reason: 'idle', heldMs: 11 * 60_000 }),
            ),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(activityLog.log).toHaveBeenCalledTimes(1);
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                actionType: ActivityActionType.AGENT_COMPUTER_CONTROLLED,
                details: expect.objectContaining({
                    resourceType: 'agent',
                    resourceId: 'agent-1',
                    releaseReason: 'idle',
                    heldMs: 11 * 60_000,
                }),
            }),
        );
    });

    it('never throws into the event bus when the Activity Log is down', async () => {
        const { listener, activityLog } = build();
        activityLog.log.mockRejectedValue(new Error('db down'));
        expect(() =>
            listener.onControlChanged(
                new ComputerControlChangedEvent(
                    change({ held: false, reason: 'given-back', heldMs: 1 }),
                ),
            ),
        ).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
    });

    it('releases whatever an ended view held, and swallows a failure', async () => {
        const { listener, control } = build();
        await listener.onSessionEnded(
            new ComputerSessionEndedEvent(SESSION, 'node-1', 'no-viewer'),
        );
        expect(control.releaseForSession).toHaveBeenCalledWith(SESSION, 'session-ended');

        control.releaseForSession.mockRejectedValue(new Error('db down'));
        await expect(
            listener.onSessionEnded(new ComputerSessionEndedEvent(SESSION, 'node-1', 'stopped')),
        ).resolves.toBeUndefined();
    });
});
