import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { FleetSessionService } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsController } from './fleet-sessions.controller';
import { FleetSessionsEnabledGuard } from './fleet-sessions-enabled.guard';
import type { FleetSessionAttachService } from './fleet-session-attach.service';
import type { FleetSessionPresenceService } from './fleet-session-presence.service';

const USER = { userId: 'user-1' } as never;
const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

/**
 * FL-04 — the session routes are where CONTRACTS §11.2 puts them, behind the
 * fleet switch AND `FLEET_SESSIONS_ENABLED` (404 when off), and hand every act
 * to `FleetSessionService` as the signed-in person. The service's own chain
 * (audience, kill switch, policy, machine, audit) is pinned in the agent
 * package (`fleet-session.service.spec.ts`).
 */
describe('FleetSessionsController', () => {
    let service: Record<string, jest.Mock>;
    let attach: { mint: jest.Mock };
    let presence: { presence: jest.Mock };
    let controller: FleetSessionsController;
    const saved = { ...process.env };

    beforeEach(() => {
        service = {
            listPage: jest.fn(async () => ({ sessions: [], nextCursor: null })),
            recentFolders: jest.fn(async () => ['~/code/app']),
            start: jest.fn(async () => ({ id: SESSION_ID })),
            restart: jest.fn(async () => ({ id: 'new' })),
            get: jest.fn(async () => ({ id: SESSION_ID })),
            rename: jest.fn(async () => ({ id: SESSION_ID })),
            end: jest.fn(async () => ({ id: SESSION_ID, state: 'ended' })),
        };
        attach = {
            mint: jest.fn(async () => ({
                token: 't',
                role: 'viewer',
                expiresInSec: 60,
                wsPath: `/ws/fleet/session/${SESSION_ID}`,
            })),
        };
        presence = { presence: jest.fn(() => ({ attached: [], drivers: 0, watchers: 0 })) };
        controller = new FleetSessionsController(
            service as unknown as FleetSessionService,
            attach as unknown as FleetSessionAttachService,
            presence as unknown as FleetSessionPresenceService,
        );
    });

    afterEach(() => {
        process.env = { ...saved };
    });

    it('is mounted under api/fleet behind both switches', () => {
        expect(Reflect.getMetadata(PATH_METADATA, FleetSessionsController)).toBe('api/fleet');
        expect(Reflect.getMetadata(GUARDS_METADATA, FleetSessionsController)).toEqual([
            FleetEnabledGuard,
            FleetSessionsEnabledGuard,
        ]);
        const routes: Array<[keyof FleetSessionsController, RequestMethod, string]> = [
            ['listForNode', RequestMethod.GET, 'nodes/:id/sessions'],
            ['start', RequestMethod.POST, 'nodes/:id/sessions'],
            ['list', RequestMethod.GET, 'sessions'],
            ['get', RequestMethod.GET, 'sessions/:id'],
            ['rename', RequestMethod.PATCH, 'sessions/:id'],
            ['end', RequestMethod.POST, 'sessions/:id/end'],
            ['restart', RequestMethod.POST, 'sessions/:id/restart'],
            ['attachToken', RequestMethod.POST, 'sessions/:id/attach-token'],
        ];
        for (const [method, verb, path] of routes) {
            const handler = FleetSessionsController.prototype[method];
            expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
            expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        }
    });

    it('answers 404 while FLEET_SESSIONS_ENABLED is off, and while the fleet is off', () => {
        const guard = new FleetSessionsEnabledGuard();
        delete process.env.FLEET_SESSIONS_ENABLED;
        expect(() => guard.canActivate()).toThrow(NotFoundException);
        process.env.FLEET_SESSIONS_ENABLED = 'true';
        expect(guard.canActivate()).toBe(true);
        process.env.FLEET_ENABLED = 'false';
        expect(() => guard.canActivate()).toThrow(NotFoundException);
    });

    it("lists a computer's sessions with its recent folders", async () => {
        const out = await controller.listForNode(USER, NODE_ID, { state: 'live', limit: 10 });
        expect(service.listPage).toHaveBeenCalledWith(
            { userId: 'user-1' },
            { state: 'live', limit: 10, nodeId: NODE_ID },
        );
        expect(out).toEqual({ sessions: [], nextCursor: null, recentFolders: ['~/code/app'] });
    });

    it('starts as the signed-in person, and a restartOf start restarts on that computer only', async () => {
        await controller.start(USER, NODE_ID, { kind: 'owner', provider: 'shell', cwd: '~' });
        expect(service.start).toHaveBeenCalledWith(
            NODE_ID,
            { userId: 'user-1' },
            {
                kind: 'owner',
                provider: 'shell',
                cwd: '~',
            },
        );
        await controller.start(USER, NODE_ID, {
            kind: 'owner',
            provider: 'shell',
            cwd: '~',
            restartOf: SESSION_ID,
            cols: 100,
        });
        expect(service.restart).toHaveBeenCalledWith(
            SESSION_ID,
            { userId: 'user-1' },
            { cols: 100, rows: undefined },
            { expectNodeId: NODE_ID },
        );
    });

    it('passes confirm through to end only when it is literally true', async () => {
        await controller.end(USER, SESSION_ID, {});
        expect(service.end).toHaveBeenLastCalledWith(
            SESSION_ID,
            { userId: 'user-1' },
            { confirm: false },
        );
        await controller.end(USER, SESSION_ID, { confirm: true });
        expect(service.end).toHaveBeenLastCalledWith(
            SESSION_ID,
            { userId: 'user-1' },
            { confirm: true },
        );
    });

    it('turns the since query into a date and drops one that is not', async () => {
        await controller.list(USER, { since: '2026-10-21T00:00:00.000Z', nodeId: NODE_ID });
        expect(service.listPage).toHaveBeenLastCalledWith(
            { userId: 'user-1' },
            { since: new Date('2026-10-21T00:00:00.000Z'), nodeId: NODE_ID },
        );
    });

    it('mints the attach token as the signed-in person, in the role asked for (P1b)', async () => {
        const grant = await controller.attachToken(USER, SESSION_ID, { role: 'driver' } as never);
        expect(attach.mint).toHaveBeenCalledWith(SESSION_ID, { userId: 'user-1' }, 'driver');
        expect(grant.wsPath).toBe(`/ws/fleet/session/${SESSION_ID}`);
    });

    it('adds who is attached to a live session, never to an ended one (P1b)', async () => {
        service.get.mockResolvedValueOnce({ id: SESSION_ID, state: 'working' });
        const live = await controller.get(USER, SESSION_ID);
        expect(live.presence).toEqual({ attached: [], drivers: 0, watchers: 0 });
        service.get.mockResolvedValueOnce({ id: SESSION_ID, state: 'ended' });
        const ended = await controller.get(USER, SESSION_ID);
        expect(ended.presence).toBeUndefined();
    });
});
