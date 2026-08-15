import type { FleetJobService, FleetService } from '@ever-works/agent/fleet';
import type { FleetNodeView } from '@ever-works/contracts';
import { FLEET_RUNNER_STATUS_REFRESH_SEC } from '@ever-works/contracts';
import { FleetRunnerStatusService } from '../fleet-runner-status.service';

const node = (overrides: Partial<FleetNodeView> = {}): FleetNodeView => ({
    id: 'node-1',
    name: 'laptop',
    kind: 'desktop-node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.2.0',
    capabilities: ['terminal'],
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    persisted: true,
    capabilitiesPinned: false,
    cliVersion: 'claude 1.4.2',
    diskFreeBytes: 900_000_000,
    ...overrides,
});

/**
 * `FleetRunnerStatusService` is the ONE composer behind both the sidebar
 * pill and the run router's availability check. These tests pin the two
 * properties that sharing is supposed to buy:
 *
 *   1. the numbers come from the same read, so the pill and the routing
 *      decision cannot disagree about the same machines;
 *   2. a job-runtime hiccup degrades (nodes still render, `busy` reads
 *      false, `loadUnavailable` says so) instead of taking down the read
 *      — and, crucially, `availability` reports ZERO free runners in that
 *      state rather than claiming capacity it could not verify.
 */
describe('FleetRunnerStatusService', () => {
    let fleet: { listEnrolledForUser: jest.Mock };
    let jobs: { loadByNodeForUser: jest.Mock };

    beforeEach(() => {
        fleet = { listEnrolledForUser: jest.fn(async () => []) };
        jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
    });

    const build = () =>
        new FleetRunnerStatusService(
            fleet as unknown as FleetService,
            jobs as unknown as FleetJobService,
        );

    describe('snapshot', () => {
        it('counts online / busy / offline / drained across the fleet', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'a', status: 'online' }),
                node({ id: 'b', status: 'online' }),
                node({ id: 'c', status: 'offline' }),
                node({ id: 'd', status: 'paused' }),
                node({ id: 'e', status: 'disabled' }),
            ]);
            jobs.loadByNodeForUser.mockResolvedValue({
                b: { activeJobCount: 2, currentJobKind: 'agent-task', currentJobId: 'job-1' },
            });

            const status = await build().snapshot('user-1');

            expect(status.total).toBe(5);
            expect(status.online).toBe(2);
            expect(status.busy).toBe(1);
            expect(status.offline).toBe(1);
            expect(status.drained).toBe(2);
            expect(status.loadUnavailable).toBe(false);
            expect(status.refreshIntervalSec).toBe(FLEET_RUNNER_STATUS_REFRESH_SEC);
        });

        it('projects the telemetry the popover renders, renaming version → daemonVersion', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([node()]);
            jobs.loadByNodeForUser.mockResolvedValue({
                'node-1': { activeJobCount: 1, currentJobKind: 'agent-task', currentJobId: 'j1' },
            });

            const [row] = (await build().snapshot('user-1')).nodes;

            expect(row).toEqual({
                id: 'node-1',
                name: 'laptop',
                kind: 'desktop-node',
                status: 'online',
                lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
                // `version` is ambiguous once a second version exists.
                daemonVersion: '1.2.0',
                cliVersion: 'claude 1.4.2',
                diskFreeBytes: 900_000_000,
                busy: true,
                activeJobCount: 1,
                currentJobKind: 'agent-task',
            });
        });

        it('uses the enrolled-only read, never the cluster-merging one', async () => {
            // A `kind: 'k8s'` row is not a runner the platform leases onto;
            // counting one would have the pill claim capacity that cannot
            // execute anything, and it costs a cluster round-trip per poll.
            await build().snapshot('user-1');
            expect(fleet.listEnrolledForUser).toHaveBeenCalledWith('user-1');
        });

        it('degrades to registry-only when the job load cannot be read', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([node()]);
            jobs.loadByNodeForUser.mockRejectedValue(new Error('fleet_jobs unreachable'));

            const status = await build().snapshot('user-1');

            expect(status.loadUnavailable).toBe(true);
            // The node still renders — a job-runtime hiccup must not make
            // a live runner look like it disappeared.
            expect(status.nodes).toHaveLength(1);
            expect(status.nodes[0].busy).toBe(false);
            expect(status.online).toBe(1);
        });
    });

    describe('availability', () => {
        it('counts only online, leasable, idle runners as free', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'idle', status: 'online' }),
                node({ id: 'busy', status: 'online' }),
                // Paused/disabled keep heartbeating so they stay
                // observable, but `FleetJobService.lease` refuses them.
                node({ id: 'paused', status: 'paused' }),
                node({ id: 'off', status: 'offline' }),
            ]);
            jobs.loadByNodeForUser.mockResolvedValue({
                busy: { activeJobCount: 1, currentJobKind: 'agent-task', currentJobId: 'j' },
            });

            const availability = await build().availability('user-1');

            expect(availability).toEqual({ total: 4, online: 2, free: 1 });
        });

        it('reports no free runners when every online node is busy', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a', status: 'online' })]);
            jobs.loadByNodeForUser.mockResolvedValue({
                a: { activeJobCount: 3, currentJobKind: 'agent-task', currentJobId: 'j' },
            });

            await expect(build().availability('user-1')).resolves.toEqual({
                total: 1,
                online: 1,
                free: 0,
            });
        });

        it('reports ZERO free when the job load could not be read at all', async () => {
            // REGRESSION: `snapshot` degrades to `busy: false` for every
            // node when `fleet_jobs` cannot be read — right for the pill,
            // wrong for routing. Counting those as free made a
            // `local-fallback` run enqueue onto a fleet whose runners may
            // all be saturated, so it waited in the queue instead of
            // taking the cloud path that mode exists to guarantee.
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'a', status: 'online' }),
                node({ id: 'b', status: 'online' }),
            ]);
            jobs.loadByNodeForUser.mockRejectedValue(new Error('fleet_jobs unreachable'));

            await expect(build().availability('user-1')).resolves.toEqual({
                total: 2,
                // The registry half IS verified, so it is still reported —
                // that is what keeps the fallback reason `runners-busy`
                // rather than the misleading `no-runners`.
                online: 2,
                free: 0,
            });
        });

        it('reports the fleet as unavailable when the registry read throws', async () => {
            fleet.listEnrolledForUser.mockRejectedValue(new Error('db down'));

            // Zero, not "assume free": a `local-fallback` run goes to the
            // cloud and a `local-wait` run queues. Both are safe; claiming
            // capacity we could not verify is not.
            await expect(build().availability('user-1')).resolves.toEqual({
                total: 0,
                online: 0,
                free: 0,
            });
        });
    });
});
