import 'reflect-metadata';
import type { FleetSessionService } from '@ever-works/agent/fleet';
import { FLEET_SESSION_MAX_VIEWERS } from '@ever-works/contracts';
import type {
    FleetLinkViewerGatewayService,
    FleetLinkViewerHandle,
} from '../../fleet-link/fleet-link-viewer-gateway.service';
import { FleetSessionPresenceService } from './fleet-session-presence.service';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function viewer(
    id: string,
    role: 'viewer' | 'driver',
    userId = `user-${id}`,
): FleetLinkViewerHandle {
    return {
        id,
        acceptedAt: Date.now(),
        claims: {
            userId,
            nodeId: 'node-1',
            family: 'session',
            target: SESSION_ID,
            role,
            params: {},
            requirement: {},
        },
    };
}

/**
 * FL-04 P1b — who is attached to a session through the browser, the
 * five-viewer cap, the attach audit row and ONE row per driver span.
 */
describe('FleetSessionPresenceService', () => {
    let sessions: { recordViewer: jest.Mock; canStillSee: jest.Mock };
    let gateway: { registerObserver: jest.Mock };
    let presence: FleetSessionPresenceService;

    beforeEach(() => {
        sessions = {
            recordViewer: jest.fn(async () => undefined),
            canStillSee: jest.fn(async () => true),
        };
        gateway = { registerObserver: jest.fn() };
        presence = new FleetSessionPresenceService(
            sessions as unknown as FleetSessionService,
            gateway as unknown as FleetLinkViewerGatewayService,
        );
    });

    it('observes the session family of the viewer gateway', () => {
        presence.onApplicationBootstrap();
        expect(gateway.registerObserver).toHaveBeenCalledWith('session', presence);
    });

    it('refuses the sixth browser limit_exceeded, naming the five', () => {
        for (let i = 0; i < FLEET_SESSION_MAX_VIEWERS; i += 1)
            presence.admit(viewer(`v${i}`, 'viewer'));
        expect(() => presence.admit(viewer('v6', 'viewer'))).toThrow(/already has 5 watchers/);
        try {
            presence.admit(viewer('v7', 'viewer'));
        } catch (error) {
            const body = (
                error as {
                    getResponse(): { error: { code: string; details: { watchers: string[] } } };
                }
            ).getResponse();
            expect(body.error.code).toBe('limit_exceeded');
            expect(body.error.details.watchers).toHaveLength(5);
        }
    });

    it('frees the slot when a viewer closes, and counts only opened ones', () => {
        const a = viewer('a', 'viewer');
        const b = viewer('b', 'driver');
        presence.admit(a);
        presence.admit(b);
        expect(presence.presence(SESSION_ID)).toEqual({ attached: [], drivers: 0, watchers: 0 });
        presence.opened(a);
        presence.opened(b);
        const now = presence.presence(SESSION_ID);
        expect(now.drivers).toBe(1);
        expect(now.watchers).toBe(1);
        presence.closed(a);
        expect(presence.attachedIds(SESSION_ID)).toEqual(['user-b']);
    });

    it('writes node.session.attach once the channel opened', () => {
        const a = viewer('a', 'viewer');
        presence.admit(a);
        presence.opened(a);
        expect(sessions.recordViewer).toHaveBeenCalledWith(
            'node.session.attach',
            'user-a',
            SESSION_ID,
            {
                role: 'viewer',
                outcome: 'attached',
            },
        );
    });

    it('writes ONE node.session.input per driver span with its byte count, never per keystroke', () => {
        const d = viewer('d', 'driver');
        presence.admit(d);
        presence.opened(d);
        for (let i = 0; i < 50; i += 1) presence.inbound(d, 9 + 1); // a header and one byte
        presence.closed(d);
        const spans = sessions.recordViewer.mock.calls.filter(
            ([action]) => action === 'node.session.input',
        );
        expect(spans).toHaveLength(1);
        expect(spans[0][3]).toMatchObject({ role: 'driver', outcome: 'span', bytes: 50 });
    });

    it('writes no span for a driver that never typed, nor for a watcher', () => {
        const d = viewer('d', 'driver');
        const v = viewer('v', 'viewer');
        presence.admit(d);
        presence.admit(v);
        presence.opened(d);
        presence.opened(v);
        presence.inbound(v, 100);
        presence.closed(d);
        presence.closed(v);
        expect(
            sessions.recordViewer.mock.calls.some(([action]) => action === 'node.session.input'),
        ).toBe(false);
    });

    it('asks the session service whether the person may still see the session', async () => {
        sessions.canStillSee.mockResolvedValueOnce(false);
        await expect(presence.stillAllowed(viewer('a', 'viewer'))).resolves.toBe(false);
        expect(sessions.canStillSee).toHaveBeenCalledWith(SESSION_ID, { userId: 'user-a' });
    });
});
