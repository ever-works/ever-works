import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type {
    FleetJobService,
    FleetNodeHealthService,
    FleetService,
} from '@ever-works/agent/fleet';
import type { FleetNodeView } from '@ever-works/contracts';
import { FleetHealthController } from './fleet-health.controller';

const USER = { userId: 'user-1' } as never;
const NODE_ID = '11111111-1111-4111-8111-111111111111';

function view(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: NODE_ID,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        health: null,
        ...overrides,
    };
}

/**
 * Computer health (FL-03) — `GET /api/fleet/nodes/:id/health`, a `view`-family
 * read: visibility is FL-01's `getVisibleForUser` (the owner, or someone the
 * node is shared with); anyone else gets the 404 of an unknown id and nothing
 * else is read. The "needs a look" routes are FL-01's (`fleet.controller.ts`);
 * FL-03's producers behind them are tested in the agent package.
 */
describe('FleetHealthController — GET /api/fleet/nodes/:id/health', () => {
    let service: { getVisibleForUser: jest.Mock };
    let jobs: { loadByNodeForUser: jest.Mock };
    let history: { isHistoryEnabled: jest.Mock };
    let controller: FleetHealthController;

    beforeEach(() => {
        service = {
            getVisibleForUser: jest.fn(async () => ({ view: view(), role: 'owner' })),
        };
        jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
        history = { isHistoryEnabled: jest.fn(() => false) };
        controller = new FleetHealthController(
            service as unknown as FleetService,
            jobs as unknown as FleetJobService,
            history as unknown as FleetNodeHealthService,
        );
    });

    it('is mounted where CONTRACTS §11.2 puts it', () => {
        expect(Reflect.getMetadata(PATH_METADATA, FleetHealthController)).toBe('api/fleet');
        expect(Reflect.getMetadata(PATH_METADATA, FleetHealthController.prototype.health)).toBe(
            'nodes/:id/health',
        );
        expect(Reflect.getMetadata(METHOD_METADATA, FleetHealthController.prototype.health)).toBe(
            RequestMethod.GET,
        );
    });

    it('answers the stored snapshot, fresh, with the computer’s state', async () => {
        const at = new Date(Date.now() - 48_000).toISOString();
        service.getVisibleForUser.mockResolvedValue({
            view: view({ health: { at, cpuPercent: 31, memPercent: 58 } }),
            role: 'owner',
        });
        history.isHistoryEnabled.mockReturnValue(true);
        expect(await controller.health(USER, NODE_ID)).toEqual({
            nodeId: NODE_ID,
            snapshot: { at, cpuPercent: 31, memPercent: 58 },
            stale: false,
            state: { state: 'online', params: {}, action: null },
            historyEnabled: true,
        });
    });

    it('marks a 2 h-old snapshot stale and a node without one as "no snapshot" (ACC-FL03-02)', async () => {
        const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
        service.getVisibleForUser.mockResolvedValue({
            view: view({ health: { at: old, cpuPercent: 3 } }),
            role: 'owner',
        });
        expect((await controller.health(USER, NODE_ID)).stale).toBe(true);
        service.getVisibleForUser.mockResolvedValue({
            view: view({ health: null }),
            role: 'owner',
        });
        const none = await controller.health(USER, NODE_ID);
        expect(none.snapshot).toBeNull();
        expect(none.stale).toBe(true);
    });

    it('composes the job count so the state can say "Busy · 2 jobs", and degrades without it', async () => {
        jobs.loadByNodeForUser.mockResolvedValue({
            [NODE_ID]: { activeJobCount: 2, currentJobKind: 'agent-task', currentJobId: 'j' },
        });
        expect((await controller.health(USER, NODE_ID)).state).toEqual({
            state: 'busy',
            params: { jobs: 2 },
            action: null,
        });
        jobs.loadByNodeForUser.mockRejectedValue(new Error('job runtime down'));
        expect((await controller.health(USER, NODE_ID)).state.state).toBe('online');
    });

    it('a stranger’s node id is a 404 and nothing else is read', async () => {
        service.getVisibleForUser.mockRejectedValue(new NotFoundException('Fleet node not found'));
        await expect(controller.health(USER, NODE_ID)).rejects.toBeInstanceOf(NotFoundException);
        expect(jobs.loadByNodeForUser).not.toHaveBeenCalled();
    });

    it('answers someone the computer is shared with, from the shared view and without the owner’s job ledger', async () => {
        const at = new Date(Date.now() - 30_000).toISOString();
        service.getVisibleForUser.mockResolvedValue({
            view: view({ health: { at, cpuPercent: 40 }, viewerRole: 'org-member' }),
            role: 'org-member',
        });
        jobs.loadByNodeForUser.mockResolvedValue({
            [NODE_ID]: { activeJobCount: 3, currentJobKind: 'agent-task', currentJobId: 'j' },
        });
        const answer = await controller.health(USER, NODE_ID);
        expect(answer.snapshot).toEqual({ at, cpuPercent: 40 });
        // Not "Busy · 3 jobs": the jobs are the owner's ledger, not the reader's.
        expect(answer.state.state).toBe('online');
        expect(jobs.loadByNodeForUser).not.toHaveBeenCalled();
    });

    it('a computer silent past the offline window reads offline even while its row still says online', async () => {
        const silentSince = new Date(Date.now() - 60 * 60_000).toISOString();
        service.getVisibleForUser.mockResolvedValue({
            view: view({
                status: 'online',
                workerState: 'quarantined',
                lastHeartbeatAt: silentSince,
                health: { at: silentSince, cpuPercent: 99 },
            }),
            role: 'owner',
        });
        const answer = await controller.health(USER, NODE_ID);
        expect(answer.state).toEqual({
            state: 'offline',
            params: { lastSeenAt: silentSince },
            action: null,
        });
        expect(answer.stale).toBe(true);
    });
});
