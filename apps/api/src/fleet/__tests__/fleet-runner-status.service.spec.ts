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
    modelIdentity: 'claude-code: ops@example.com (Acme, max)',
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
 *      state rather than claiming capacity it could not verify;
 *   3. (self-build slice S) with an eligibility filter, `availability`
 *      counts only the nodes that could take THE job — the pinned node,
 *      the nodes advertising the required tags — and says how big the
 *      whole fleet was, so a pin to a closed laptop reads 1/0/0 of 6.
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
                // Fleet cost accounting (EW-777): the seat the spend is billed to.
                modelIdentity: 'claude-code: ops@example.com (Acme, max)',
                busy: true,
                activeJobCount: 1,
                currentJobKind: 'agent-task',
                // Fleet health signals (EW-776): what the MACHINE says
                // about itself, alongside what the platform infers. Null
                // here because this fixture's daemon reports neither.
                workerState: null,
                workerStateReason: null,
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

    describe('availability — eligibility (self-build slice S)', () => {
        const sixNodes = () => [
            node({ id: 'a', status: 'online' }),
            node({ id: 'b', status: 'offline' }),
            node({ id: 'c', status: 'online' }),
            node({ id: 'd', status: 'online' }),
            node({ id: 'e', status: 'online' }),
            node({ id: 'f', status: 'online' }),
        ];

        it('keeps the fleet-wide three-field shape when no eligibility is given', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());

            // Exactly three keys: the legacy callers (and the pure rule's
            // legacy shapes) see byte-for-byte what they always saw.
            await expect(build().availability('user-1')).resolves.toEqual({
                total: 6,
                online: 5,
                free: 5,
            });
        });

        it('REGRESSION (R5): a pin to an offline node with five idle siblings is 1/0/0 of 6, not 6/5/5', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());

            await expect(build().availability('user-1', { targetNodeId: 'b' })).resolves.toEqual({
                total: 1,
                online: 0,
                free: 0,
                fleetTotal: 6,
                pinnedNodeId: 'b',
            });
        });

        it('a pinned node that is online and idle is placeable', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());

            await expect(build().availability('user-1', { targetNodeId: 'a' })).resolves.toEqual({
                total: 1,
                online: 1,
                free: 1,
                fleetTotal: 6,
                pinnedNodeId: 'a',
            });
        });

        it('a pinned node that is online but busy is eligible, not free', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());
            jobs.loadByNodeForUser.mockResolvedValue({
                a: { activeJobCount: 1, currentJobKind: 'agent-task', currentJobId: 'j' },
            });

            await expect(
                build().availability('user-1', { targetNodeId: 'a' }),
            ).resolves.toMatchObject({ total: 1, online: 1, free: 0 });
        });

        it.each(['paused', 'disabled'] as const)(
            'a pinned node that is %s is not online (the lease would refuse it)',
            async (status) => {
                fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a', status })]);

                await expect(
                    build().availability('user-1', { targetNodeId: 'a' }),
                ).resolves.toMatchObject({ total: 1, online: 0, free: 0 });
            },
        );

        it('a pinned node that is no longer enrolled is no eligible runner at all', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());

            await expect(
                build().availability('user-1', { targetNodeId: 'ghost' }),
            ).resolves.toEqual({
                total: 0,
                online: 0,
                free: 0,
                fleetTotal: 6,
                pinnedNodeId: 'ghost',
            });
        });

        it('excludes nodes that do not advertise EVERY required tag', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'claude', capabilities: ['terminal', 'claude-code'] }),
                node({ id: 'codex', capabilities: ['terminal', 'codex'] }),
                node({ id: 'bare', capabilities: [] }),
            ]);

            await expect(
                build().availability('user-1', { requiredCapabilities: ['claude-code'] }),
            ).resolves.toEqual({
                total: 1,
                online: 1,
                free: 1,
                fleetTotal: 3,
                pinnedNodeId: null,
            });
            await expect(
                build().availability('user-1', {
                    requiredCapabilities: ['terminal', 'claude-code'],
                }),
            ).resolves.toMatchObject({ total: 1 });
            await expect(
                build().availability('user-1', { requiredCapabilities: ['gpu'] }),
            ).resolves.toMatchObject({ total: 0, fleetTotal: 3 });
        });

        it('applies both filters: the pinned node must also advertise the tags', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'a', capabilities: ['terminal'] }),
                node({ id: 'b', capabilities: ['terminal', 'claude-code'] }),
            ]);

            await expect(
                build().availability('user-1', {
                    targetNodeId: 'a',
                    requiredCapabilities: ['claude-code'],
                }),
            ).resolves.toEqual({
                total: 0,
                online: 0,
                free: 0,
                fleetTotal: 2,
                pinnedNodeId: 'a',
            });
        });

        it('treats an empty filter as "every enrolled node", with the fleet fields attached', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());

            await expect(build().availability('user-1', {})).resolves.toEqual({
                total: 6,
                online: 5,
                free: 5,
                fleetTotal: 6,
                pinnedNodeId: null,
            });
        });

        it('still reports ZERO free for the eligible set when the job load could not be read', async () => {
            fleet.listEnrolledForUser.mockResolvedValue(sixNodes());
            jobs.loadByNodeForUser.mockRejectedValue(new Error('fleet_jobs unreachable'));

            await expect(build().availability('user-1', { targetNodeId: 'a' })).resolves.toEqual({
                total: 1,
                online: 1,
                free: 0,
                fleetTotal: 6,
                pinnedNodeId: 'a',
            });
        });

        it('keeps the pin on the "fleet unavailable" answer when the registry read throws', async () => {
            fleet.listEnrolledForUser.mockRejectedValue(new Error('db down'));

            await expect(build().availability('user-1', { targetNodeId: 'b' })).resolves.toEqual({
                total: 0,
                online: 0,
                free: 0,
                fleetTotal: 0,
                pinnedNodeId: 'b',
            });
        });
    });

    /**
     * Fleet health signals (EW-776, finding OPS-02) — the defect this
     * whole slice exists for, seen from the router's side.
     *
     * A self-quarantined machine keeps heartbeating (that is what makes
     * the quarantine observable instead of a blackout), so it reads
     * `online` with no live claim: idle, healthy, free. It was refusing
     * every lease. The pill said "1 of 1 online", `local-fallback` runs
     * were "placed" on it, and `local-wait` runs queued behind it forever.
     */
    describe('worker state', () => {
        it('projects the worker state and its reason onto the pill row', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({
                    id: 'a',
                    workerState: 'quarantined',
                    workerStateReason: 'process tree could not be proven terminated',
                }),
            ]);

            const snapshot = await build().snapshot('user-1');

            expect(snapshot.nodes[0].workerState).toBe('quarantined');
            expect(snapshot.nodes[0].workerStateReason).toBe(
                'process tree could not be proven terminated',
            );
        });

        it('reports null for a daemon that has never said what it is doing', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a' })]);

            const snapshot = await build().snapshot('user-1');

            expect(snapshot.nodes[0].workerState).toBeNull();
            expect(snapshot.nodes[0].workerStateReason).toBeNull();
        });

        it.each([['quarantined'], ['throttled'], ['paused']] as const)(
            'still counts a %s node as ONLINE but never as free',
            async (workerState) => {
                // Online is the truth — the machine is reachable and the
                // operator must keep seeing it. Free is the lie.
                fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a', workerState })]);

                await expect(build().availability('user-1')).resolves.toEqual({
                    total: 1,
                    online: 1,
                    free: 0,
                });
            },
        );

        it.each([['idle'], ['working']] as const)(
            'leaves a %s node counted as free when it holds no claim',
            async (workerState) => {
                fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a', workerState })]);

                await expect(build().availability('user-1')).resolves.toEqual({
                    total: 1,
                    online: 1,
                    free: 1,
                });
            },
        );

        it('leaves a node that reports nothing counted as free', async () => {
            // Unknown is not a refusal. Treating it as one would empty the
            // fleet of every machine running a build older than this field.
            fleet.listEnrolledForUser.mockResolvedValue([node({ id: 'a' })]);

            await expect(build().availability('user-1')).resolves.toEqual({
                total: 1,
                online: 1,
                free: 1,
            });
        });

        it('leaves the free count intact when only ONE of two nodes is quarantined', async () => {
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'a', workerState: 'quarantined' }),
                node({ id: 'b', workerState: 'idle' }),
            ]);

            await expect(build().availability('user-1')).resolves.toEqual({
                total: 2,
                online: 2,
                free: 1,
            });
        });

        it('does not hide a quarantined node from the pill counts', async () => {
            // Routing must not send work to it; the operator must still see
            // it, and see WHY. Those are different questions.
            fleet.listEnrolledForUser.mockResolvedValue([
                node({ id: 'a', workerState: 'quarantined' }),
            ]);

            const snapshot = await build().snapshot('user-1');

            expect(snapshot.total).toBe(1);
            expect(snapshot.online).toBe(1);
            expect(snapshot.offline).toBe(0);
        });
    });
});
