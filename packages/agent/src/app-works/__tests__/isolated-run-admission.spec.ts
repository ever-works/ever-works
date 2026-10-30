import {
    RunDispatchGateService,
    QUEUED_REASON_AGENT_PAUSED,
} from '../../agents/run-dispatch-gate.service';
import { TaskTransitionService } from '../../tasks-domain/task-transition.service';
import { FLEET_SESSION_SCHEDULE_LABEL } from '../../tasks-domain/task-session-schedule.port';
import {
    APP_WORK_CONTAINMENT_DOWNGRADE_MESSAGE,
    APP_WORK_NO_ISOLATED_RUNTIME_MESSAGE,
    appWorkCloudRunRefusal,
    describeAppWorkNoPushCredential,
    isAppWorkRunAdmitted,
    type AppWorkRunPlacementPreview,
} from '../isolated-run-admission';
import {
    IsolatedRunAdmissionService,
    type AdmissionNode,
    type IsolatedRunAdmissionReads,
} from '../isolated-run-admission.service';

/**
 * APW-08 T12 (FR-12, FR-70, FR-75; ACC-08-08, ACC-08-34, ACC-08-39) — isolated-run admission.
 *
 * The nine cases of T12 run END TO END through site 1: `TaskTransitionService.dispatchAgentRun`
 * with the real `IsolatedRunAdmissionService` over plain doubles of the platform rows, and the
 * dispatcher's `previewPlacement` standing in for the fleet routing adapter. "Refused" therefore
 * means what a member sees: the dispatch `error` carries the code and the spec copy, no run row
 * exists and nothing was enqueued. The ninth case uses the REAL `RunDispatchGateService` with the
 * AW-23 brake, so "parked by the existing chain" is the chain's own verdict.
 *
 * After them: the predicate's pure edges, every non-App path byte-for-byte, the stop flag, the
 * fail-closed reads, the push-credential cache and site 2 (the cloud worker's pre-flight).
 */

const OWNER = 'user-1';
const AGENT = 'agent-1';
const APP_WORK = 'w-app';
const SITE_WORK = 'w-site';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';

const S15 = APP_WORK_NO_ISOLATED_RUNTIME_MESSAGE;
const S33 = APP_WORK_CONTAINMENT_DOWNGRADE_MESSAGE;
const S28 =
    "Ever Works can't push to maya/bookings from your machines. Install the Ever Works GitHub App on maya.";

/** A node report the way `normalizeFleetAgentTaskContainment` expects it from a node. */
const isolatedReport = (executionPath: 'ordinary' | 'hardened' = 'ordinary') => ({
    executionPath,
    isolatedHome: true,
    localSessionHome: 'C:\\Users\\maya\\.claude',
    downgrades: [
        { control: 'process-containment', reason: 'ordinary command runner' },
        { control: 'network-egress', reason: 'no egress control' },
    ],
});
const declinedReport = () => ({
    executionPath: 'ordinary',
    isolatedHome: false,
    localSessionHome: null,
    downgrades: [{ control: 'isolated-home', reason: 'modelHomeIsolation=inherit' }],
});

interface World {
    kind: Record<string, string>;
    allowances: Record<string, unknown[]>;
    nodes: AdmissionNode[];
    reports: Record<string, unknown>;
    pinned: string | null;
    installed: boolean;
    pipeline: { enforcesRuntimeNetworking?: boolean } | null;
    networking: 'limited' | 'unrestricted' | null;
    placement: AppWorkRunPlacementPreview;
}

function makeWorld(over: Partial<World> = {}): World {
    return {
        kind: { [APP_WORK]: 'app', [SITE_WORK]: 'directory' },
        allowances: {},
        nodes: [
            {
                id: NODE_A,
                userId: OWNER,
                name: 'Maya desktop',
                status: 'online',
                capabilities: ['git-push'],
            },
        ],
        reports: { [NODE_A]: isolatedReport() },
        pinned: null,
        installed: true,
        pipeline: null,
        networking: null,
        placement: { placement: 'fleet', requiredCapabilities: ['git-push'] },
        ...over,
    };
}

/** The Work row as the repository answers it (the entity's repository helpers included). */
const workOf = (world: World, id: string) =>
    world.kind[id]
        ? {
              id,
              userId: OWNER,
              kind: world.kind[id],
              appRunContainmentAllowances: world.allowances[id] ?? null,
              getRepoOwner: () => 'maya',
              getDataRepo: () => 'bookings-data',
              getWebsiteRepo: () => 'bookings',
          }
        : null;

function readsFor(world: World, spies: { push?: jest.Mock } = {}): IsolatedRunAdmissionReads {
    const push = spies.push ?? jest.fn(async () => world.installed);
    return {
        works: {
            findById: jest.fn(async (id: string) => workOf(world, id)),
            // A faithful compare-and-set over the world's column.
            casAppRunContainmentAllowances: jest.fn(
                async (id: string, _userId: string, previous: unknown, next: unknown[]) => {
                    if (
                        JSON.stringify(world.allowances[id] ?? null) !==
                        JSON.stringify(previous ?? null)
                    ) {
                        return false;
                    }
                    world.allowances[id] = next;
                    return true;
                },
            ),
        },
        fleet: {
            nodesForUser: jest.fn(async () => world.nodes),
            nodeById: jest.fn(async (id: string) => world.nodes.find((n) => n.id === id) ?? null),
            pinnedNodeFor: jest.fn(async () => world.pinned),
            latestContainment: jest.fn(
                async (_userId: string, nodeId: string) => world.reports[nodeId] ?? null,
            ),
        },
        pushCredential: push,
        cloudPipeline: jest.fn(async () => world.pipeline),
        environmentNetworking: jest.fn(async () => world.networking),
    };
}

interface Harness {
    svc: TaskTransitionService;
    admission: IsolatedRunAdmissionService;
    runs: { createQueued: jest.Mock; markDispatchFailed: jest.Mock; setTriggerRunId: jest.Mock };
    dispatcher: { enqueue: jest.Mock; previewPlacement: jest.Mock };
    works: { findById: jest.Mock };
    gate?: { admit: jest.Mock };
}

function makeHarness(
    world: World,
    opts: {
        dispatchGate?: unknown;
        noAdmission?: boolean;
        reads?: IsolatedRunAdmissionReads;
        sessionSchedules?: unknown;
        works?: { findById: jest.Mock };
    } = {},
): Harness {
    const runs = {
        createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
        markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        setTriggerRunId: jest.fn().mockResolvedValue(undefined),
    };
    const dispatcher = {
        enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }),
        previewPlacement: jest.fn(async () => world.placement),
    };
    const works = opts.works ?? {
        findById: jest.fn(async (id: string) => workOf(world, id)),
    };
    const agents = {
        findByIdAndUser: jest.fn(async (id: string, userId: string) => ({
            id,
            userId,
            permissions: { canCommitToRepo: true },
        })),
    };
    const admission = new IsolatedRunAdmissionService(opts.reads ?? readsFor(world));
    const svc = new (TaskTransitionService as unknown as new (
        ...args: unknown[]
    ) => TaskTransitionService)(
        { casUpdateStatus: jest.fn(), findById: jest.fn() },
        { findByTaskId: jest.fn().mockResolvedValue([]) },
        { allApproved: jest.fn().mockResolvedValue(true) },
        { findAgentAssignees: jest.fn().mockResolvedValue([]) },
        runs,
        dispatcher,
        undefined, // notifications
        undefined, // runDenorm
        opts.dispatchGate, // dispatchGate
        works,
        undefined, // terminalSessions
        agents,
        undefined, // agentReviews
        undefined, // domainEvents
        opts.sessionSchedules, // sessionSchedules
        opts.noAdmission ? undefined : admission,
    );
    return { svc, admission, runs, dispatcher, works };
}

const task = (workId: string | null = APP_WORK) =>
    ({
        id: 't1',
        userId: OWNER,
        workId,
        recurrenceOccurredCount: 0,
        tenantId: null,
        organizationId: null,
    }) as never;

function expectNothingDispatched(h: Harness): void {
    expect(h.runs.createQueued).not.toHaveBeenCalled();
    expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
}

describe('isolated-run admission — the nine T12 cases (site 1, dispatchAgentRun)', () => {
    it('1. a Fleet placement on an isolated node is admitted and dispatched', async () => {
        const h = makeHarness(makeWorld());
        const result = await h.svc.dispatchAgentRun(task(), AGENT);

        expect(result).toMatchObject({ runId: 'r1', dispatched: true, parked: false });
        expect(result.error).toBeUndefined();
        expect(h.dispatcher.previewPlacement).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: AGENT, userId: OWNER, taskId: 't1' }),
        );
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('2. a cloud placement through a networking-enforcing pipeline with a limited Environment is admitted', async () => {
        const h = makeHarness(
            makeWorld({
                placement: { placement: 'cloud' },
                pipeline: { enforcesRuntimeNetworking: true },
                networking: 'limited',
            }),
        );
        const result = await h.svc.dispatchAgentRun(task(), AGENT);

        expect(result).toMatchObject({ dispatched: true });
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('3. the same pipeline with an unrestricted Environment is refused with the S15 copy (ACC-08-08)', async () => {
        const h = makeHarness(
            makeWorld({
                placement: { placement: 'cloud' },
                pipeline: { enforcesRuntimeNetworking: true },
                networking: 'unrestricted',
            }),
        );
        const result = await h.svc.dispatchAgentRun(task(), AGENT);

        expect(result).toMatchObject({ runId: null, dispatched: false, parked: false });
        expect(result.error).toBe(`noIsolatedRuntime: ${S15}`);
        expectNothingDispatched(h);
    });

    it('4. a cloud placement whose pipeline declares no networking flag is refused (no flag)', async () => {
        for (const pipeline of [null, {}, { enforcesRuntimeNetworking: false }]) {
            const h = makeHarness(
                makeWorld({ placement: { placement: 'cloud' }, pipeline, networking: 'limited' }),
            );
            const result = await h.svc.dispatchAgentRun(task(), AGENT);
            expect(result.error).toBe(`noIsolatedRuntime: ${S15}`);
            expectNothingDispatched(h);
        }
    });

    it("5. an 'unknown' placement is judged as cloud and refused — also when the adapter cannot answer", async () => {
        const unknown = makeHarness(makeWorld({ placement: { placement: 'unknown' } }));
        expect((await unknown.svc.dispatchAgentRun(task(), AGENT)).error).toBe(
            `noIsolatedRuntime: ${S15}`,
        );
        expectNothingDispatched(unknown);

        const throwing = makeHarness(makeWorld());
        throwing.dispatcher.previewPlacement.mockRejectedValue(new Error('router down'));
        expect((await throwing.svc.dispatchAgentRun(task(), AGENT)).error).toBe(
            `noIsolatedRuntime: ${S15}`,
        );
        expectNothingDispatched(throwing);
    });

    it('6. a Fleet node reporting isolatedHome: false is needs_input, and is admitted once the owner allows it (ACC-08-34)', async () => {
        const world = makeWorld({
            reports: {
                [NODE_A]: { executionPath: 'ordinary', isolatedHome: false, downgrades: [] },
            },
        });
        const h = makeHarness(world);

        const held = await h.svc.dispatchAgentRun(task(), AGENT);
        expect(held).toMatchObject({ runId: null, dispatched: false, parked: false });
        expect(held.error).toBe(`containmentDowngrade: ${S33}`);
        expectNothingDispatched(h);

        // The verdict names the node so the Task can offer **Allow on this machine** for it.
        const verdict = await h.admission.admit({
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        });
        expect(verdict).toMatchObject({ admitted: false, outcome: 'needs_input', nodeId: NODE_A });

        const allowed = await h.admission.setContainmentAllowance({
            workId: APP_WORK,
            nodeId: NODE_A,
            allow: true,
            actorUserId: OWNER,
        });
        expect(allowed.status).toBe('ok');

        const after = await h.svc.dispatchAgentRun(task(), AGENT);
        expect(after).toMatchObject({ dispatched: true });
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('7. an isolated-home downgrade is needs_input; allowed it starts, and a withdrawn allowance holds it again (ACC-08-34, ACC-08-08)', async () => {
        const world = makeWorld({ reports: { [NODE_A]: declinedReport() } });
        const h = makeHarness(world);

        expect((await h.svc.dispatchAgentRun(task(), AGENT)).error).toBe(
            `containmentDowngrade: ${S33}`,
        );
        expectNothingDispatched(h);

        await h.admission.setContainmentAllowance({
            workId: APP_WORK,
            nodeId: NODE_A,
            allow: true,
            actorUserId: OWNER,
        });
        expect(await h.svc.dispatchAgentRun(task(), AGENT)).toMatchObject({ dispatched: true });

        await h.admission.setContainmentAllowance({
            workId: APP_WORK,
            nodeId: NODE_A,
            allow: false,
            actorUserId: OWNER,
        });
        expect((await h.svc.dispatchAgentRun(task(), AGENT)).error).toBe(
            `containmentDowngrade: ${S33}`,
        );
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('8. no push credential for the repository owner is refused with the S28 copy naming the owner; admitted once the installation exists (ACC-08-39)', async () => {
        const world = makeWorld({ installed: false });
        const h = makeHarness(world);

        const refused = await h.svc.dispatchAgentRun(task(), AGENT);
        expect(refused.error).toBe(`noPushCredential: ${S28}`);
        expect(describeAppWorkNoPushCredential('maya', 'bookings')).toBe(S28);
        expectNothingDispatched(h);

        world.installed = true; // the owner installs the Ever Works GitHub App on `maya`
        const started = await h.svc.dispatchAgentRun(task(), AGENT);
        expect(started).toMatchObject({ dispatched: true });
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('9. an ADMITTED App Work run whose Agent is paused is parked agent-paused by the existing chain, not refused (ACC-08-08, unit half)', async () => {
        const gateRuns = {
            countInFlightForWork: jest.fn().mockResolvedValue(0),
            countInFlightForUser: jest.fn().mockResolvedValue(0),
            countInFlightForOrganization: jest.fn().mockResolvedValue(0),
        };
        const brake = {
            shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: true, reason: 'user' }),
        };
        const gate = new RunDispatchGateService(
            gateRuns as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            brake as never,
        );
        const h = makeHarness(makeWorld(), { dispatchGate: gate });

        const result = await h.svc.dispatchAgentRun(task(), AGENT);

        expect(result).toMatchObject({
            runId: 'r1',
            dispatched: false,
            parked: true,
            queuedReason: QUEUED_REASON_AGENT_PAUSED,
        });
        expect(result.error).toBeUndefined();
        expect(brake.shouldHaltForAgent).toHaveBeenCalledWith(AGENT);
        expect(h.runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ queuedReason: QUEUED_REASON_AGENT_PAUSED }),
        );
        expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    });
});

describe('isolated-run admission — every other path is unchanged', () => {
    it('a Task on another kind computes no placement, reads no fleet fact and hands the gate its three keys', async () => {
        const admit = jest.fn(async () => ({ admitted: true }));
        const h = makeHarness(makeWorld(), { dispatchGate: { admit } });

        const result = await h.svc.dispatchAgentRun(task(SITE_WORK), AGENT);

        expect(result).toMatchObject({ dispatched: true });
        expect(h.dispatcher.previewPlacement).not.toHaveBeenCalled();
        expect(admit).toHaveBeenCalledWith(
            { userId: OWNER, workId: SITE_WORK, organizationId: null },
            expect.any(Function),
        );
    });

    it('a Work-less Task asks nothing', async () => {
        const h = makeHarness(makeWorld());
        expect(await h.svc.dispatchAgentRun(task(null), AGENT)).toMatchObject({ dispatched: true });
        expect(h.dispatcher.previewPlacement).not.toHaveBeenCalled();
    });

    it('with the port unbound, an App Work Task dispatches exactly as before', async () => {
        const h = makeHarness(makeWorld({ placement: { placement: 'cloud' } }), {
            noAdmission: true,
        });
        expect(await h.svc.dispatchAgentRun(task(), AGENT)).toMatchObject({ dispatched: true });
        expect(h.dispatcher.previewPlacement).not.toHaveBeenCalled();
    });

    it('a REVIEW run on an App Work is not a change and is not admission-checked', async () => {
        const world = makeWorld({ placement: { placement: 'cloud' } });
        const h = makeHarness(world);
        const result = await h.svc.dispatchAgentRun(task(), AGENT, { reviewId: 'review-1' });
        expect(result.error ?? '').not.toContain('noIsolatedRuntime');
        expect(h.dispatcher.previewPlacement).not.toHaveBeenCalled();
    });

    it('the global stop flag is not a refusal: the run goes on to the gate, which parks it', async () => {
        const admit = jest.fn(async () => ({ admitted: false, queuedReason: 'kill-switch' }));
        const h = makeHarness(makeWorld({ placement: { placement: 'unknown', halted: true } }), {
            dispatchGate: { admit },
        });

        const result = await h.svc.dispatchAgentRun(task(), AGENT);

        expect(result).toMatchObject({ parked: true, queuedReason: 'kill-switch' });
        expect(result.error).toBeUndefined();
    });

    it('a gate that throws refuses the App Work run (fail closed)', async () => {
        const h = makeHarness(makeWorld());
        jest.spyOn(h.admission, 'admit').mockRejectedValue(new Error('boom'));

        const result = await h.svc.dispatchAgentRun(task(), AGENT);
        expect(result.error).toBe(`noIsolatedRuntime: ${S15}`);
        expectNothingDispatched(h);
    });
});

describe('isolated-run admission — review of #3040 at site 1', () => {
    const UNREADABLE =
        /^dispatch-failed: work-unreadable: The Work w-\w+ of this Task could not be read, so no run was started\. Try again\.$/;

    it('a Work that cannot be read refuses (fail closed, retryable) — for an App Work and for any other kind', async () => {
        for (const workId of [APP_WORK, SITE_WORK]) {
            const world = makeWorld();
            const works = { findById: jest.fn().mockRejectedValue(new Error('db down')) };
            const h = makeHarness(world, { works });
            const result = await h.svc.dispatchAgentRun(task(workId), AGENT);
            expect(result).toMatchObject({ runId: null, dispatched: false, parked: false });
            expect(result.error).toMatch(UNREADABLE);
            expectNothingDispatched(h);
        }
    });

    it('the Work is read ONCE per dispatch, shared by T49, FR-9 and T12', async () => {
        const prior = process.env.EVER_WORKS_APP_CHANGES_ENABLED;
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        try {
            const h = makeHarness(makeWorld());
            const result = await h.svc.dispatchAgentRun(task(SITE_WORK), AGENT);
            // T49 off (switch off) reads it; T12 reuses that read.
            expect(result).toMatchObject({ dispatched: true });
            expect(h.works.findById).toHaveBeenCalledTimes(1);
        } finally {
            if (prior === undefined) delete process.env.EVER_WORKS_APP_CHANGES_ENABLED;
            else process.env.EVER_WORKS_APP_CHANGES_ENABLED = prior;
        }
        const h2 = makeHarness(makeWorld());
        await h2.svc.dispatchAgentRun(task(APP_WORK), AGENT);
        expect(h2.works.findById).toHaveBeenCalledTimes(1);
    });

    it('an Agent-session schedule fire on an App Work Task is admitted BEFORE the session branch, judged as a Fleet run', async () => {
        const sessionSchedules = {
            dispatch: jest.fn(async () => ({ runId: 's1', dispatched: true, parked: false })),
        };
        const sessionTask = () =>
            ({
                ...(task(APP_WORK) as object),
                labels: [FLEET_SESSION_SCHEDULE_LABEL],
            }) as never;

        const held = makeHarness(makeWorld({ reports: { [NODE_A]: declinedReport() } }), {
            sessionSchedules,
        });
        const refused = await held.svc.dispatchAgentRun(sessionTask(), AGENT);
        expect(refused.error).toBe(`containmentDowngrade: ${S33}`);
        expect(sessionSchedules.dispatch).not.toHaveBeenCalled();
        // A session runs on the pinned computer, not where the router would place a Task run.
        expect(held.dispatcher.previewPlacement).not.toHaveBeenCalled();

        const ok = makeHarness(makeWorld(), { sessionSchedules });
        expect(await ok.svc.dispatchAgentRun(sessionTask(), AGENT)).toMatchObject({ runId: 's1' });
        expect(sessionSchedules.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('isolated-run admission — the predicate and its facts', () => {
    // Rewritten in the review of #3040 (was "an unpinned run needs EVERY eligible node
    // admissible"): the LEASE now judges the node that actually takes the job
    // (`admitsLease`, below), so dispatch admits a run some eligible node may take, and the
    // downgraded sibling is simply never offered it. Every candidate held still holds the run.
    it('an unpinned run is admitted when ANY eligible node is admissible — the lease keeps the downgraded one off it; all held → the first is named', async () => {
        const world = makeWorld({
            nodes: [
                { id: NODE_A, userId: OWNER, status: 'online', capabilities: ['git-push'] },
                { id: NODE_B, userId: OWNER, status: 'offline', capabilities: ['git-push'] },
            ],
            reports: { [NODE_A]: isolatedReport(), [NODE_B]: declinedReport() },
        });
        const reads = readsFor(world);
        const admission = new IsolatedRunAdmissionService(reads);
        const input = {
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        };
        expect(await admission.admit(input)).toEqual({
            admitted: true,
            branch: 'fleet',
            workId: APP_WORK,
        });
        // …and the downgraded node is refused at the lease, the isolated one admitted.
        expect(
            await admission.admitsLease({
                userId: OWNER,
                nodeId: NODE_B,
                workId: APP_WORK,
                jobId: 'j1',
            }),
        ).toBe(false);
        expect(
            await admission.admitsLease({
                userId: OWNER,
                nodeId: NODE_A,
                workId: APP_WORK,
                jobId: 'j1',
            }),
        ).toBe(true);

        world.reports[NODE_A] = declinedReport();
        expect(await admission.admit(input)).toMatchObject({
            outcome: 'needs_input',
            code: 'containmentDowngrade',
            nodeId: NODE_A,
        });
    });

    // Rewritten in the review of #3040 (was "ineligible nodes (paused, missing tags) never hold
    // it"): a PAUSED or ENROLLING node can lease later, so it is a candidate now; only a node
    // without the tags the job requires is not.
    it('a pinned run is judged on its node alone; paused and enrolling nodes count as candidates, a node without the tags does not', async () => {
        const world = makeWorld({
            nodes: [
                { id: NODE_B, userId: OWNER, status: 'paused', capabilities: ['git-push'] },
                { id: 'node-e', userId: OWNER, status: 'enrolling', capabilities: ['git-push'] },
                { id: 'node-c', userId: OWNER, status: 'online', capabilities: [] },
            ],
            reports: { [NODE_B]: declinedReport(), 'node-c': isolatedReport('hardened') },
        });
        const admission = new IsolatedRunAdmissionService(readsFor(world));
        const input = {
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        };
        // The isolated node-c lacks the tag, so it is no candidate; the paused and the enrolling
        // node are, and neither is admissible.
        expect(await admission.admit(input)).toMatchObject({
            outcome: 'needs_input',
            code: 'containmentDowngrade',
            nodeId: NODE_B,
        });

        world.allowances[APP_WORK] = [
            { nodeId: 'node-e', allowedAt: 'x', allowedBy: OWNER, acceptedDowngrade: null },
        ];
        expect(await admission.admit(input)).toMatchObject({ admitted: true });

        world.pinned = NODE_B;
        expect(await admission.admit(input)).toMatchObject({
            outcome: 'needs_input',
            nodeId: NODE_B,
        });
    });

    it('review of #3040: an owner with no enrolled node at all is refused with S15; machines that cannot take it hold the run (never admitted)', async () => {
        const none = makeWorld({ nodes: [] });
        expect(
            await new IsolatedRunAdmissionService(readsFor(none)).admit({
                task: { id: 't1', userId: OWNER, workId: APP_WORK },
                agent: { id: AGENT, userId: OWNER },
                placement: none.placement,
            }),
        ).toMatchObject({ outcome: 'refused', code: 'noIsolatedRuntime', message: S15 });

        const untagged = makeWorld({
            nodes: [{ id: NODE_A, userId: OWNER, status: 'online', capabilities: [] }],
        });
        expect(
            await new IsolatedRunAdmissionService(readsFor(untagged)).admit({
                task: { id: 't1', userId: OWNER, workId: APP_WORK },
                agent: { id: AGENT, userId: OWNER },
                placement: untagged.placement,
            }),
        ).toMatchObject({ outcome: 'needs_input', code: 'noEligibleNode' });
    });

    it('follow-up to #3040: a DISABLED node is no candidate — its only admissible node disabled, the run is held, never admitted', async () => {
        const world = makeWorld({
            nodes: [
                { id: NODE_A, userId: OWNER, status: 'disabled', capabilities: ['git-push'] },
                { id: NODE_B, userId: OWNER, status: 'disabled', capabilities: ['git-push'] },
            ],
            reports: { [NODE_A]: isolatedReport('hardened'), [NODE_B]: isolatedReport('ordinary') },
        });
        const reads = readsFor(world);
        expect(
            await new IsolatedRunAdmissionService(reads).admit({
                task: { id: 't1', userId: OWNER, workId: APP_WORK },
                agent: { id: AGENT, userId: OWNER },
                placement: world.placement,
            }),
        ).toMatchObject({ admitted: false, outcome: 'needs_input', code: 'noEligibleNode' });
        // Nothing was even read for a node that cannot lease.
        expect(reads.fleet!.latestContainment).not.toHaveBeenCalled();
    });

    it('CodeRabbit on #3041: a run PINNED to a disabled node is held, never admitted, and never falls back to another node', async () => {
        const world = makeWorld({
            nodes: [
                { id: NODE_A, userId: OWNER, status: 'disabled', capabilities: ['git-push'] },
                { id: NODE_B, userId: OWNER, status: 'online', capabilities: ['git-push'] },
            ],
            reports: { [NODE_A]: isolatedReport('hardened'), [NODE_B]: isolatedReport('hardened') },
        });
        world.pinned = NODE_A;
        const reads = readsFor(world);
        expect(
            await new IsolatedRunAdmissionService(reads).admit({
                task: { id: 't1', userId: OWNER, workId: APP_WORK },
                agent: { id: AGENT, userId: OWNER },
                placement: world.placement,
            }),
        ).toMatchObject({ admitted: false, outcome: 'needs_input', code: 'noEligibleNode' });
        // The admissible online NODE_B was not used as a fallback.
        expect(reads.fleet!.latestContainment).not.toHaveBeenCalled();
    });

    it('follow-up to #3040: candidates are ordered before the cap — online first, then offline, paused, enrolling, then by id', async () => {
        const world = makeWorld({
            // Ids deliberately ordered AGAINST the statuses, so neither the input order nor the id
            // order alone yields the expected sequence.
            nodes: [
                { id: 'node-a-enrolling', userId: OWNER, status: 'enrolling', capabilities: ['git-push'] },
                { id: 'node-e-online', userId: OWNER, status: 'online', capabilities: ['git-push'] },
                { id: 'node-b-paused', userId: OWNER, status: 'paused', capabilities: ['git-push'] },
                { id: 'node-d-offline', userId: OWNER, status: 'offline', capabilities: ['git-push'] },
                { id: 'node-c-online', userId: OWNER, status: 'online', capabilities: ['git-push'] },
            ],
            reports: {},
        });
        const reads = readsFor(world);
        await new IsolatedRunAdmissionService(reads).admit({
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        });
        expect(
            (reads.fleet!.latestContainment as jest.Mock).mock.calls.map((call) => call[1]),
        ).toEqual([
            'node-c-online',
            'node-e-online',
            'node-d-offline',
            'node-b-paused',
            'node-a-enrolling',
        ]);
    });

    it('the lease: an unreported node, an unreadable Work and a missing Fleet read all refuse; the allowance admits that node only', async () => {
        const world = makeWorld({ reports: {} });
        const reads = readsFor(world);
        const admission = new IsolatedRunAdmissionService(reads);
        const lease = (nodeId: string) =>
            admission.admitsLease({ userId: OWNER, nodeId, workId: APP_WORK, jobId: 'j1' });
        expect(await lease(NODE_A)).toBe(false);

        world.allowances[APP_WORK] = [
            { nodeId: NODE_A, allowedAt: 'x', allowedBy: OWNER, acceptedDowngrade: null },
        ];
        expect(await lease(NODE_A)).toBe(true);
        expect(await lease(NODE_B)).toBe(false);

        (reads.works.findById as jest.Mock).mockRejectedValueOnce(new Error('db down'));
        expect(await lease(NODE_A)).toBe(false);
        // A Work that is not (any longer) an App Work has no containment rule.
        expect(
            await admission.admitsLease({
                userId: OWNER,
                nodeId: NODE_B,
                workId: SITE_WORK,
                jobId: 'j1',
            }),
        ).toBe(true);
    });

    it('APW-08 T51 (ACC-08-44, second half): a node whose last run of THIS Task reported a missing tool is not offered it again', async () => {
        const world = makeWorld({ reports: { [NODE_A]: isolatedReport('hardened') } });
        const reads = readsFor(world);
        const reported = new Set<string>([`${NODE_A}:t1`]);
        const since: number[] = [];
        reads.fleet!.missingToolReportedFor = jest.fn(
            async (_userId: string, nodeId: string, taskId: string, sinceMs: number) => {
                since.push(sinceMs);
                return reported.has(`${nodeId}:${taskId}`);
            },
        );
        const admission = new IsolatedRunAdmissionService({
            ...reads,
            now: () => new Date('2026-10-30T12:00:00Z'),
        });
        const lease = (taskId: string | null) =>
            admission.admitsLease({ userId: OWNER, nodeId: NODE_A, workId: APP_WORK, jobId: 'j1', taskId });

        // The node reported the tool missing for t1: passed over for t1 only.
        expect(await lease('t1')).toBe(false);
        expect(await lease('t2')).toBe(true);
        // The window is a day back from now.
        expect(since[0]).toBe(new Date('2026-10-29T12:00:00Z').getTime());
        // No task id on the job (an older payload): nothing to check, the containment decides.
        expect(await lease(null)).toBe(true);
        // The read failing ADMITS: this passes over a known-bad machine, it is not a safety rule.
        (reads.fleet!.missingToolReportedFor as jest.Mock).mockRejectedValueOnce(new Error('db down'));
        expect(await lease('t1')).toBe(true);
    });

    it('APW-08 T51: a missing-tool report never admits a node the containment rule refuses', async () => {
        const world = makeWorld({ reports: {} });
        const reads = readsFor(world);
        reads.fleet!.missingToolReportedFor = jest.fn(async () => false);
        const admission = new IsolatedRunAdmissionService(reads);
        expect(
            await admission.admitsLease({
                userId: OWNER,
                nodeId: NODE_A,
                workId: APP_WORK,
                jobId: 'j1',
                taskId: 't1',
            }),
        ).toBe(false);
        // Refused on containment first; the missing-tool record was not even asked.
        expect(reads.fleet!.missingToolReportedFor).not.toHaveBeenCalled();
    });

    it('a node that never reported (or whose report is unreadable) is an unknown containment — a downgrade', async () => {
        for (const report of [undefined, 'garbage', ['x']]) {
            const world = makeWorld({ reports: { [NODE_A]: report } });
            const admission = new IsolatedRunAdmissionService(readsFor(world));
            expect(
                await admission.admit({
                    task: { id: 't1', userId: OWNER, workId: APP_WORK },
                    agent: { id: AGENT, userId: OWNER },
                    placement: world.placement,
                }),
            ).toMatchObject({ outcome: 'needs_input', nodeId: NODE_A, containment: null });
        }
    });

    it('a node list that cannot be read holds the run (fail closed)', async () => {
        const world = makeWorld();
        const reads = readsFor(world);
        reads.fleet!.nodesForUser = jest.fn().mockRejectedValue(new Error('db down'));
        const verdict = await new IsolatedRunAdmissionService(reads).admit({
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        });
        expect(verdict).toMatchObject({ admitted: false, outcome: 'needs_input' });
    });

    it('GAP-15: a positive push answer is cached per (user, Work, owner/repo); a negative one never is', async () => {
        const world = makeWorld({ installed: false });
        const push = jest.fn(async () => world.installed);
        const admission = new IsolatedRunAdmissionService(readsFor(world, { push }));
        const input = {
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        };
        expect(await admission.admit(input)).toMatchObject({
            code: 'noPushCredential',
            owner: 'maya',
            repo: 'bookings',
        });
        expect(await admission.admit(input)).toMatchObject({ code: 'noPushCredential' });
        expect(push).toHaveBeenCalledTimes(2);

        world.installed = true;
        expect(await admission.admit(input)).toEqual({
            admitted: true,
            branch: 'fleet',
            workId: APP_WORK,
        });
        expect(await admission.admit(input)).toEqual({
            admitted: true,
            branch: 'fleet',
            workId: APP_WORK,
        });
        expect(push).toHaveBeenCalledTimes(3);
        expect(push).toHaveBeenLastCalledWith(OWNER, 'maya', 'bookings');
    });

    it('review of #3040: one member’s yes never admits another member’s Task (the cache key carries the Task owner)', async () => {
        const world = makeWorld();
        const push = jest.fn(async (userId: string) => userId === OWNER);
        const admission = new IsolatedRunAdmissionService(readsFor(world, { push }));
        const forUser = (userId: string) => ({
            task: { id: 't1', userId, workId: APP_WORK },
            agent: { id: AGENT, userId },
            placement: world.placement,
        });
        expect(await admission.admit(forUser(OWNER))).toMatchObject({ admitted: true });
        // The member's own nodes are what their run would lease; give them one.
        world.nodes.push({
            id: NODE_B,
            userId: 'member-2',
            status: 'online',
            capabilities: ['git-push'],
        });
        world.reports[NODE_B] = isolatedReport();
        expect(await admission.admit(forUser('member-2'))).toMatchObject({
            code: 'noPushCredential',
        });
        expect(push).toHaveBeenLastCalledWith('member-2', 'maya', 'bookings');
    });

    it('a push lookup that throws reads as "cannot mint" (refused)', async () => {
        const world = makeWorld();
        const push = jest.fn().mockRejectedValue(new Error('snapshot unreadable'));
        const verdict = await new IsolatedRunAdmissionService(readsFor(world, { push })).admit({
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        });
        expect(verdict).toMatchObject({ code: 'noPushCredential' });
    });

    it('the Environment is read only when the pipeline could admit at all', async () => {
        const world = makeWorld({ placement: { placement: 'cloud' }, pipeline: null });
        const reads = readsFor(world);
        await new IsolatedRunAdmissionService(reads).admit({
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: AGENT, userId: OWNER },
            placement: world.placement,
        });
        expect(reads.environmentNetworking).not.toHaveBeenCalled();
    });

    // Rewritten in the review of #3040 (was "no candidate is left to the router", which pinned an
    // empty candidate set as ADMITTED): with no node able to take it, a machine enrolled later
    // or a downgraded node unpaused later would be the one to lease it, so an empty set is now
    // held (`noEligibleNode`, needs_input), and no enrolled machine at all is S15.
    it('the pure predicate: push first; no enrolled machine is S15; an EMPTY candidate set is held, never admitted', () => {
        const t = { id: 't1', workId: APP_WORK };
        const push = { owner: 'maya', repo: 'bookings', available: true };
        expect(isAppWorkRunAdmitted(t, { placement: 'fleet', pushCredential: null })).toMatchObject(
            { code: 'noPushCredential' },
        );
        expect(
            isAppWorkRunAdmitted(t, {
                placement: 'fleet',
                pushCredential: push,
                fleetCandidates: [],
                fleetEnrolledNodes: 0,
            }),
        ).toMatchObject({ outcome: 'refused', code: 'noIsolatedRuntime' });
        expect(
            isAppWorkRunAdmitted(t, {
                placement: 'fleet',
                pushCredential: push,
                fleetCandidates: [],
                fleetEnrolledNodes: 2,
            }),
        ).toMatchObject({ admitted: false, outcome: 'needs_input', code: 'noEligibleNode' });
        expect(
            isAppWorkRunAdmitted(t, {
                placement: 'fleet',
                pushCredential: push,
                fleetCandidates: [],
            }),
        ).toMatchObject({ admitted: false, code: 'noEligibleNode' });
        expect(
            isAppWorkRunAdmitted(t, {
                placement: 'unknown',
                pipeline: { enforcesRuntimeNetworking: true },
                environmentNetworking: 'limited',
            }),
        ).toEqual({
            admitted: true,
            branch: 'isolated-cloud',
        });
    });
});

describe('isolated-run admission — site 2, the cloud worker pre-flight', () => {
    it('refuses every App Work run that reaches the cloud executor, with the S15 copy', () => {
        expect(
            appWorkCloudRunRefusal({
                taskId: 't1',
                workId: APP_WORK,
                isAppWork: true,
                reviewRun: false,
            }),
        ).toBe(`noIsolatedRuntime: ${S15}`);
    });

    it('lets a review run and every other kind through', () => {
        expect(
            appWorkCloudRunRefusal({ taskId: 't1', isAppWork: true, reviewRun: true }),
        ).toBeNull();
        expect(
            appWorkCloudRunRefusal({ taskId: 't1', isAppWork: false, reviewRun: false }),
        ).toBeNull();
    });
});
