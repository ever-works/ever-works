import type { FleetSessionService } from '@ever-works/agent/fleet';
import type { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';
import { FleetSessionLinkListener } from './fleet-session-link.listener';

const NODE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

/**
 * FL-04 — node reports reach `FleetSessionService` parsed by the contract, in
 * the order they arrived per node, and not at all while sessions are off.
 */
describe('FleetSessionLinkListener', () => {
    const saved = { ...process.env };
    let handlers: Map<string, (nodeId: string, message: Record<string, unknown>) => void>;
    let sessions: { applyNodeEvent: jest.Mock; reconcileList: jest.Mock };
    let listener: FleetSessionLinkListener;
    let order: string[];

    beforeEach(() => {
        process.env.FLEET_SESSIONS_ENABLED = 'true';
        delete process.env.FLEET_ENABLED;
        handlers = new Map();
        order = [];
        const registry = {
            onNodeControl: jest.fn((type: string, handler: (nodeId: string, message: Record<string, unknown>) => void) => {
                handlers.set(type, handler);
                return () => handlers.delete(type);
            }),
        };
        sessions = {
            applyNodeEvent: jest.fn(async (_nodeId: string, message: { event: string }) => {
                // The first report is slow: a later one must still wait for it.
                if (message.event === 'started') await new Promise((resolve) => setTimeout(resolve, 20));
                order.push(message.event);
            }),
            reconcileList: jest.fn(async () => {
                order.push('list');
            }),
        };
        listener = new FleetSessionLinkListener(
            registry as unknown as FleetLinkRegistry,
            sessions as unknown as FleetSessionService,
        );
        listener.onModuleInit();
    });

    afterEach(() => {
        listener.onModuleDestroy();
        process.env = { ...saved };
    });

    it('subscribes to session.event and session.list, and unsubscribes on shutdown', () => {
        expect([...handlers.keys()].sort()).toEqual(['session.event', 'session.list']);
        listener.onModuleDestroy();
        expect(handlers.size).toBe(0);
    });

    it("applies one node's reports in arrival order", async () => {
        handlers.get('session.event')!(NODE, { type: 'session.event', sessionId: SESSION, event: 'started' });
        handlers.get('session.event')!(NODE, {
            type: 'session.event',
            sessionId: SESSION,
            event: 'exited',
            exitCode: 0,
        });
        handlers.get('session.list')!(NODE, {
            type: 'session.list',
            sessions: [],
            daemon: { state: 'running', sessions: 0 },
        });
        await listener.idle();
        expect(order).toEqual(['started', 'exited', 'list']);
    });

    it('drops a malformed report and everything while sessions are off', async () => {
        handlers.get('session.event')!(NODE, { type: 'session.event', sessionId: 'bad id!', event: 'started' });
        handlers.get('session.list')!(NODE, { type: 'session.list', sessions: 'nope' });
        process.env.FLEET_SESSIONS_ENABLED = 'false';
        handlers.get('session.event')!(NODE, { type: 'session.event', sessionId: SESSION, event: 'started' });
        await listener.idle();
        expect(sessions.applyNodeEvent).not.toHaveBeenCalled();
        expect(sessions.reconcileList).not.toHaveBeenCalled();
    });

    it('keeps going after a report fails', async () => {
        sessions.applyNodeEvent.mockRejectedValueOnce(new Error('db down'));
        handlers.get('session.event')!(NODE, { type: 'session.event', sessionId: SESSION, event: 'activity' });
        handlers.get('session.event')!(NODE, { type: 'session.event', sessionId: SESSION, event: 'title', title: 't' });
        await listener.idle();
        expect(sessions.applyNodeEvent).toHaveBeenCalledTimes(2);
        expect(order).toEqual(['title']);
    });
});
