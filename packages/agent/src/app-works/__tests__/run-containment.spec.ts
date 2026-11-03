import {
    admitFleetContainment,
    applyAppRunContainmentAllowance,
    isNodeContainmentAdmissible,
    isNodeContainmentAllowed,
    needsOwnerAllowance,
    normalizeAppRunContainmentAllowances,
    readAgentRunContainmentRecord,
    toAppWorkRunContainment,
} from '../run-containment';
import {
    IsolatedRunAdmissionService,
    type IsolatedRunAdmissionReads,
} from '../isolated-run-admission.service';

/**
 * APW-08 T48 (XC-06, SK-14, GAP-21; FR-12, FR-70, ACC-08-34) — the containment a Fleet run got,
 * the per-node allowance, and the record on the Task's Cost view.
 *
 * - the coercion cases of `normalizeFleetAgentTaskContainment` read as LESS contained;
 * - `hardened` and `ordinary` are both admitted when `isolatedHome` is true;
 * - the allowance admits one node and not another (and one Work, not another);
 * - the record reaches `TaskCostView` (through `describeForTask`, what `GET /api/tasks/:id/cost`
 *   merges in);
 * - the reconciler's recorder leaves a non-App Task untouched.
 */

const OWNER = 'user-1';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const NODE_C = '33333333-3333-4333-8333-333333333333';
const DECLINED = {
    executionPath: 'ordinary',
    isolatedHome: false,
    localSessionHome: null,
    downgrades: [{ control: 'isolated-home', reason: 'modelHomeIsolation=inherit' }],
};

describe('run containment — the record, read toward LESS containment', () => {
    it('coerces every over-report down: unknown path → ordinary, non-literal true → false, missing pairing synthesised', () => {
        const forged = toAppWorkRunContainment({
            executionPath: 'quantum',
            isolatedHome: 'yes',
            downgrades: [],
        });
        expect(forged).toMatchObject({
            executionPath: 'ordinary',
            isolatedHome: false,
            needsOwnerAllowance: true,
        });
        expect(forged!.downgrades.map((d) => d.control)).toEqual(['isolated-home']);

        const unreadableEntry = toAppWorkRunContainment({
            executionPath: 'hardened',
            isolatedHome: true,
            downgrades: [42, { control: 7 }],
        });
        // Entries that could not be read are KEPT as `unknown` — the count of holes never shrinks.
        expect(unreadableEntry!.downgrades.map((d) => d.control)).toEqual(['unknown', 'unknown']);
        expect(unreadableEntry!.needsOwnerAllowance).toBe(false);

        // Nothing readable at all is no record — which the gate treats as a downgrade.
        for (const raw of [null, undefined, 'x', 3, []])
            expect(toAppWorkRunContainment(raw)).toBeNull();
        expect(needsOwnerAllowance(null)).toBe(true);
    });

    it('drops the node-local session path: the Task page never carries a path on the owner’s machine', () => {
        const record = toAppWorkRunContainment({
            executionPath: 'ordinary',
            isolatedHome: true,
            localSessionHome: 'C:\\Users\\maya\\.claude',
            downgrades: [],
        });
        expect(record).not.toHaveProperty('localSessionHome');
    });

    it('admits hardened AND ordinary when isolatedHome is true; the standing downgrades never hold a run', () => {
        for (const executionPath of ['hardened', 'ordinary'] as const) {
            const containment = toAppWorkRunContainment({
                executionPath,
                isolatedHome: true,
                downgrades: [
                    { control: 'process-containment', reason: 'ordinary runner' },
                    { control: 'network-egress', reason: 'no egress control' },
                    { control: 'toolchain-anchors', reason: 'PNPM_HOME and friends' },
                ],
            });
            expect(containment).toMatchObject({ executionPath, needsOwnerAllowance: false });
            expect(
                admitFleetContainment([{ nodeId: NODE_A, containment, allowed: false }]),
            ).toEqual({
                admitted: true,
                nodeId: NODE_A,
            });
        }
    });

    it('an isolated-home downgrade, or isolatedHome false, needs the owner’s allowance', () => {
        const declined = toAppWorkRunContainment(DECLINED);
        expect(declined!.needsOwnerAllowance).toBe(true);
        expect(
            admitFleetContainment([{ nodeId: NODE_A, containment: declined, allowed: false }]),
        ).toEqual({
            admitted: false,
            nodeId: NODE_A,
            containment: declined,
        });
        expect(
            admitFleetContainment([{ nodeId: NODE_A, containment: declined, allowed: true }]),
        ).toEqual({
            admitted: true,
            nodeId: NODE_A,
        });
        // Review of #3040: an EMPTY candidate set is held (no node named), never admitted.
        expect(admitFleetContainment([])).toEqual({
            admitted: false,
            nodeId: null,
            containment: null,
        });
    });

    it('reads a stored run record back without trusting it', () => {
        const stored = readAgentRunContainmentRecord({
            ...toAppWorkRunContainment(DECLINED),
            nodeId: ` ${NODE_A} `,
            reportedAt: '2026-10-30T01:00:00.000Z',
        });
        expect(stored).toMatchObject({ nodeId: NODE_A, needsOwnerAllowance: true });
        expect(readAgentRunContainmentRecord({ nodeId: NODE_A })).toMatchObject({
            isolatedHome: false,
            needsOwnerAllowance: true,
        });
        expect(readAgentRunContainmentRecord(null)).toBeNull();
    });
});

describe('run containment — the allowance store (EW-807 pattern)', () => {
    it('admits the one node it names, never another', () => {
        const at = new Date('2026-10-30T02:00:00.000Z');
        const store = applyAppRunContainmentAllowance([], {
            nodeId: NODE_A,
            allow: true,
            actorUserId: OWNER,
            at,
            acceptedDowngrade: 'modelHomeIsolation=inherit',
        });
        expect(isNodeContainmentAllowed(store, NODE_A)).toBe(true);
        expect(isNodeContainmentAllowed(store, NODE_B)).toBe(false);
        expect(isNodeContainmentAllowed(store, null)).toBe(false);

        // Per node (what the LEASE judges): A is allowed, B is not. Since the review of #3040 the
        // dispatch-time set is admitted when ANY node is admissible (it names that node), and the
        // lease keeps B off the job; B alone holds the run.
        const declined = toAppWorkRunContainment(DECLINED);
        const facts = (nodeId: string) => ({
            nodeId,
            containment: declined,
            allowed: isNodeContainmentAllowed(store, nodeId),
        });
        expect(isNodeContainmentAdmissible(facts(NODE_A))).toBe(true);
        expect(isNodeContainmentAdmissible(facts(NODE_B))).toBe(false);
        expect(admitFleetContainment([facts(NODE_B), facts(NODE_A)])).toEqual({
            admitted: true,
            nodeId: NODE_A,
        });
        expect(admitFleetContainment([facts(NODE_B)])).toMatchObject({
            admitted: false,
            nodeId: NODE_B,
        });
    });

    it('is additive, idempotent and withdrawable; a second allow keeps the first author and time', () => {
        const first = applyAppRunContainmentAllowance([], {
            nodeId: NODE_A,
            allow: true,
            actorUserId: OWNER,
            at: new Date('2026-10-30T02:00:00.000Z'),
            acceptedDowngrade: null,
        });
        const both = applyAppRunContainmentAllowance(first, {
            nodeId: NODE_B,
            allow: true,
            actorUserId: OWNER,
            at: new Date('2026-10-30T03:00:00.000Z'),
            acceptedDowngrade: null,
        });
        const again = applyAppRunContainmentAllowance(both, {
            nodeId: NODE_A,
            allow: true,
            actorUserId: 'someone-else',
            at: new Date('2026-10-30T04:00:00.000Z'),
            acceptedDowngrade: null,
        });
        expect(again.find((e) => e.nodeId === NODE_A)).toMatchObject({
            allowedBy: OWNER,
            allowedAt: '2026-10-30T02:00:00.000Z',
        });
        const withdrawn = applyAppRunContainmentAllowance(again, {
            nodeId: NODE_A,
            allow: false,
            actorUserId: OWNER,
            at: new Date(),
            acceptedDowngrade: null,
        });
        expect(withdrawn.map((e) => e.nodeId)).toEqual([NODE_B]);
        // Withdrawing what is not there changes nothing.
        expect(
            applyAppRunContainmentAllowance(withdrawn, {
                nodeId: NODE_A,
                allow: false,
                actorUserId: OWNER,
                at: new Date(),
                acceptedDowngrade: null,
            }),
        ).toEqual(withdrawn);
    });

    it('reads the column without trusting it: junk and duplicates are dropped', () => {
        expect(normalizeAppRunContainmentAllowances('x')).toEqual([]);
        expect(
            normalizeAppRunContainmentAllowances([
                null,
                { nodeId: '' },
                { nodeId: NODE_A, allowedAt: 'a', allowedBy: OWNER },
                { nodeId: NODE_A, allowedAt: 'b', allowedBy: 'dup' },
            ]),
        ).toEqual([{ nodeId: NODE_A, allowedAt: 'a', allowedBy: OWNER, acceptedDowngrade: null }]);
    });
});

describe('run containment — the service: record, Cost view, allowance route', () => {
    interface World {
        works: Record<string, { kind: string; allowances: unknown }>;
        tasks: Record<string, { id: string; workId: string | null }>;
        runRecords: Record<string, unknown>;
        reports: Record<string, unknown>;
    }

    function makeService(world: World) {
        const recordContainment = jest.fn(async (runId: string, record: unknown) => {
            world.runRecords[runId] = record;
        });
        // A faithful compare-and-set over the world's column (what `WorkRepository` does in SQL).
        const casAppRunContainmentAllowances = jest.fn(
            async (id: string, _userId: string, previous: unknown, next: unknown) => {
                const current = world.works[id].allowances ?? null;
                if (JSON.stringify(current) !== JSON.stringify(previous ?? null)) return false;
                world.works[id].allowances = next;
                return true;
            },
        );
        const reads: IsolatedRunAdmissionReads = {
            works: {
                findById: async (id) =>
                    world.works[id]
                        ? {
                              id,
                              userId: OWNER,
                              kind: world.works[id].kind,
                              appRunContainmentAllowances: world.works[id].allowances,
                              getRepoOwner: () => 'maya',
                              getDataRepo: () => 'bookings-data',
                              getWebsiteRepo: () => 'bookings',
                          }
                        : null,
                casAppRunContainmentAllowances,
            },
            tasks: { findById: async (id) => world.tasks[id] ?? null },
            runs: {
                recordContainment,
                findRecentForTask: async (taskId) =>
                    Object.entries(world.runRecords)
                        .filter(([runId]) => runId.startsWith(taskId))
                        .map(([id, containment]) => ({ id, agentId: 'agent-1', containment })),
            },
            fleet: {
                nodesForUser: async () => [
                    {
                        id: NODE_A,
                        userId: OWNER,
                        name: 'Maya desktop',
                        status: 'online',
                        capabilities: [],
                    },
                ],
                nodeById: async (id) =>
                    id === NODE_A
                        ? { id: NODE_A, userId: OWNER, name: 'Maya desktop' }
                        : id === NODE_C
                          ? { id: NODE_C, userId: OWNER, name: 'Maya laptop' }
                          : id === NODE_B
                            ? { id: NODE_B, userId: 'someone-else', name: 'Not yours' }
                            : null,
                latestContainment: async (_userId, nodeId) => world.reports[nodeId] ?? null,
            },
            placementFor: async () => ({ placement: 'fleet', requiredCapabilities: [] }),
            now: () => new Date('2026-10-30T05:00:00.000Z'),
        };
        return {
            service: new IsolatedRunAdmissionService(reads),
            recordContainment,
            casAppRunContainmentAllowances,
            reads,
        };
    }

    const world = (): World => ({
        works: {
            'w-app': { kind: 'app', allowances: null },
            'w-site': { kind: 'directory', allowances: null },
        },
        tasks: {
            't-app': { id: 't-app', workId: 'w-app' },
            't-site': { id: 't-site', workId: 'w-site' },
        },
        runRecords: {},
        reports: { [NODE_A]: DECLINED },
    });

    it('the reconciler’s recorder writes the normalized record for an App Work run…', async () => {
        const w = world();
        const { service, recordContainment } = makeService(w);
        expect(
            await service.recordRunContainment({
                taskId: 't-app',
                runId: 't-app-run-1',
                userId: OWNER,
                workId: 'w-app',
                nodeId: NODE_A,
                rawContainment: DECLINED,
            }),
        ).toBe(true);
        expect(recordContainment).toHaveBeenCalledWith('t-app-run-1', {
            executionPath: 'ordinary',
            isolatedHome: false,
            downgrades: [{ control: 'isolated-home', reason: 'modelHomeIsolation=inherit' }],
            needsOwnerAllowance: true,
            nodeId: NODE_A,
            reportedAt: '2026-10-30T05:00:00.000Z',
        });
    });

    it('…and leaves a non-App Task untouched: no job marker, nothing written; its Cost view gains nothing', async () => {
        const w = world();
        const { service, recordContainment } = makeService(w);
        // The reconciler asks only for a job whose payload names its App Work (`appWorkId`);
        // without one there is nothing to record, and nothing is read to find out.
        expect(
            await service.recordRunContainment({
                taskId: 't-site',
                runId: 't-site-run-1',
                userId: OWNER,
                workId: '',
                nodeId: NODE_A,
                rawContainment: DECLINED,
            }),
        ).toBe(false);
        expect(recordContainment).not.toHaveBeenCalled();
        expect(
            await service.describeForTask({ id: 't-site', userId: OWNER, workId: 'w-site' }),
        ).toBeNull();
    });

    it('the record reaches TaskCostView with the node, the downgrade and the owner’s allowance (ACC-08-34)', async () => {
        const w = world();
        const { service } = makeService(w);
        await service.recordRunContainment({
            taskId: 't-app',
            runId: 't-app-run-1',
            userId: OWNER,
            workId: 'w-app',
            nodeId: NODE_A,
            rawContainment: DECLINED,
        });

        const before = await service.describeForTask({
            id: 't-app',
            userId: OWNER,
            workId: 'w-app',
            viewerUserId: OWNER,
        });
        expect(before!.containment).toMatchObject({
            runId: 't-app-run-1',
            nodeId: NODE_A,
            nodeName: 'Maya desktop',
            isolatedHome: false,
            needsOwnerAllowance: true,
            allowedByOwner: false,
            reported: true,
            viewerOwnsNode: true,
        });
        // The next run is held on that node until the owner allows it.
        expect(before!.containmentHolds).toEqual([
            expect.objectContaining({
                runId: null,
                nodeId: NODE_A,
                needsOwnerAllowance: true,
                allowedByOwner: false,
            }),
        ]);

        expect(
            await service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: NODE_A,
                allow: true,
                actorUserId: OWNER,
            }),
        ).toMatchObject({ status: 'ok' });
        const after = await service.describeForTask({
            id: 't-app',
            userId: OWNER,
            workId: 'w-app',
        });
        expect(after!.containment).toMatchObject({
            nodeId: NODE_A,
            allowedByOwner: true,
            acceptedDowngrade: 'modelHomeIsolation=inherit',
        });
        expect(after!.containmentHolds).toEqual([]);
        // The accepted downgrade is kept with the allowance, for the Cost view (S33).
        expect(w.works['w-app'].allowances).toEqual([
            {
                nodeId: NODE_A,
                allowedAt: '2026-10-30T05:00:00.000Z',
                allowedBy: OWNER,
                acceptedDowngrade: 'modelHomeIsolation=inherit',
            },
        ]);
    });

    it('an allowance on one Work is not implied on another; another account’s or an unknown node is notFound', async () => {
        const w = world();
        w.works['w-app-2'] = { kind: 'app', allowances: null };
        const { service } = makeService(w);
        await service.setContainmentAllowance({
            workId: 'w-app',
            nodeId: NODE_A,
            allow: true,
            actorUserId: OWNER,
        });
        expect(w.works['w-app-2'].allowances).toBeNull();

        expect(
            await service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: NODE_B,
                allow: true,
                actorUserId: OWNER,
            }),
        ).toEqual({ status: 'notFound' });
        expect(
            await service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: 'nope',
                allow: true,
                actorUserId: OWNER,
            }),
        ).toEqual({ status: 'notFound' });
        expect(
            await service.setContainmentAllowance({
                workId: 'w-site',
                nodeId: NODE_A,
                allow: true,
                actorUserId: OWNER,
            }),
        ).toEqual({ status: 'notAppWork' });
    });

    it('review of #3040: Allow / Withdraw are offered only on the VIEWER’s own nodes; a node list that cannot be read is a hold naming nothing', async () => {
        const w = world();
        const { service, reads } = makeService(w);
        await service.recordRunContainment({
            taskId: 't-app',
            runId: 't-app-run-1',
            userId: OWNER,
            workId: 'w-app',
            nodeId: NODE_A,
            rawContainment: DECLINED,
        });
        const asMember = await service.describeForTask({
            id: 't-app',
            userId: OWNER,
            workId: 'w-app',
            viewerUserId: 'org-member',
        });
        expect(asMember!.containment).toMatchObject({ nodeId: NODE_A, viewerOwnsNode: false });
        expect(asMember!.containmentHolds).toEqual([
            expect.objectContaining({ nodeId: NODE_A, viewerOwnsNode: false }),
        ]);

        reads.fleet!.nodesForUser = async () => {
            throw new Error('db down');
        };
        const unreadable = await service.describeForTask({
            id: 't-app',
            userId: OWNER,
            workId: 'w-app',
            viewerUserId: OWNER,
        });
        expect(unreadable!.containmentHolds).toEqual([
            expect.objectContaining({ nodeId: null, viewerOwnsNode: false, reported: false }),
        ]);
    });

    it('review of #3040: two concurrent allowances for different nodes BOTH land (compare-and-set, retried)', async () => {
        const w = world();
        const { service, reads, casAppRunContainmentAllowances } = makeService(w);
        // Force the race: both calls read the column before either writes.
        const realFind = reads.works.findById;
        let arrived = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => (release = resolve));
        reads.works.findById = async (id) => {
            const row = await realFind(id);
            arrived += 1;
            if (arrived === 2) release();
            if (arrived <= 2) await bothRead;
            return row;
        };

        const [a, c] = await Promise.all([
            service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: NODE_A,
                allow: true,
                actorUserId: OWNER,
            }),
            service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: NODE_C,
                allow: true,
                actorUserId: OWNER,
            }),
        ]);
        expect(a.status).toBe('ok');
        expect(c.status).toBe('ok');
        expect(
            (w.works['w-app'].allowances as Array<{ nodeId: string }>).map((e) => e.nodeId).sort(),
        ).toEqual([NODE_A, NODE_C].sort());
        // One of them lost the first compare-and-set and retried on a fresh read.
        expect(casAppRunContainmentAllowances).toHaveBeenCalledTimes(3);
    });

    it('review of #3040: a compare-and-set that keeps losing gives up as a conflict and reports no success', async () => {
        const w = world();
        const { service, reads } = makeService(w);
        reads.works.casAppRunContainmentAllowances = jest.fn(async () => false);
        expect(
            await service.setContainmentAllowance({
                workId: 'w-app',
                nodeId: NODE_A,
                allow: true,
                actorUserId: OWNER,
            }),
        ).toEqual({ status: 'conflict' });
        expect(w.works['w-app'].allowances).toBeNull();
    });
});
