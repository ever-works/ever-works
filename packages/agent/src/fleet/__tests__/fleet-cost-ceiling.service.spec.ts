import type { FleetNode } from '../../entities/fleet-node.entity';
import { FleetCostCeilingService, utcDay, utcDayStart } from '../fleet-cost-ceiling.service';

/**
 * Fleet cost accounting (EW-777) — the per-node and fleet-wide DAILY
 * model-spend ceilings.
 *
 * What these pin, in order of how much it would hurt to lose:
 *
 *   1. no ceiling configured ⇒ nothing happens (the shipped default);
 *   2. crossing a ceiling DRAINS through the drain endpoint's exact pair
 *      (disable first, then requeue) and files ONE Inbox notice per day —
 *      a second crossing the same day drains again and says nothing;
 *   3. FAIL CLOSED: a configured ceiling whose spend cannot be evaluated
 *      (the CLI printed no price, the sum threw, the lookup threw) drains
 *      the node and says why, instead of permitting;
 *   4. the fleet-wide ceiling drains every enrolled node of the owner,
 *      never an `enrolling` token row;
 *   5. the day is UTC, and the sums are bounded by midnight UTC.
 */

const USER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const JOB = 'job-1';
const NOW = new Date('2026-09-05T23:59:59.000Z');

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE,
        userId: USER,
        organizationId: null,
        name: 'everdesk2',
        kind: 'desktop-node',
        status: 'online',
        enrollmentTokenHash: 'hash',
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'win32/x64',
        version: '1.0.0',
        cliVersion: 'claude 1.4.2',
        diskFreeBytes: null,
        modelIdentity: 'claude-code: ops@example.com (Acme, max)',
        dailyCostCeilingCents: null,
        dailyCostTrippedOn: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

describe('FleetCostCeilingService', () => {
    let nodes: {
        findById: jest.Mock;
        findByUser: jest.Mock;
        casTripDailyCeiling: jest.Mock;
    };
    let jobs: { sumCostCentsForNodeSince: jest.Mock; sumCostCentsForUserSince: jest.Mock };
    let policies: { findByUser: jest.Mock; casTrip: jest.Mock; upsertCeiling: jest.Mock };
    let fleet: { setDisabledForUser: jest.Mock };
    let jobService: { releaseClaimsForNode: jest.Mock };
    let inbox: { notice: jest.Mock } | undefined;

    const build = () =>
        new FleetCostCeilingService(
            nodes as never,
            jobs as never,
            policies as never,
            fleet as never,
            jobService as never,
            inbox as never,
        );

    const completion = (
        over: Partial<Parameters<FleetCostCeilingService['evaluateAfterCompletion']>[0]> = {},
    ) => ({
        userId: USER,
        nodeId: NODE,
        jobId: JOB,
        costCents: 100,
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        workId: 'work-1',
        now: NOW,
        ...over,
    });

    beforeEach(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
        nodes = {
            findById: jest.fn(async () => node()),
            findByUser: jest.fn(async () => [node(), node({ id: OTHER, name: 'everdesk3' })]),
            casTripDailyCeiling: jest.fn(async () => true),
        };
        jobs = {
            sumCostCentsForNodeSince: jest.fn(async () => 0),
            sumCostCentsForUserSince: jest.fn(async () => 0),
        };
        policies = {
            findByUser: jest.fn(async () => null),
            casTrip: jest.fn(async () => true),
            upsertCeiling: jest.fn(async () => null),
        };
        fleet = { setDisabledForUser: jest.fn(async () => ({ id: NODE, status: 'disabled' })) };
        jobService = { releaseClaimsForNode: jest.fn(async () => 1) };
        inbox = { notice: jest.fn(async () => undefined) };
    });

    afterAll(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
    });

    describe('no ceiling configured (the shipped default)', () => {
        it('sums nothing, drains nothing, files nothing', async () => {
            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('none');
            expect(verdict.fleet.outcome).toBe('none');
            expect(verdict.drainedNodeIds).toEqual([]);
            expect(verdict.noticesFiled).toBe(0);
            expect(jobs.sumCostCentsForNodeSince).not.toHaveBeenCalled();
            expect(jobs.sumCostCentsForUserSince).not.toHaveBeenCalled();
            expect(fleet.setDisabledForUser).not.toHaveBeenCalled();
            expect(inbox!.notice).not.toHaveBeenCalled();
        });

        it('does not fail closed on a null cost when there is no ceiling to evaluate', async () => {
            const verdict = await build().evaluateAfterCompletion(completion({ costCents: null }));
            expect(verdict.drainedNodeIds).toEqual([]);
        });
    });

    describe('per-node ceiling', () => {
        beforeEach(() => {
            nodes.findById.mockResolvedValue(node({ dailyCostCeilingCents: 2_500 }));
        });

        it("sums the node's jobs since midnight UTC of the completion's day", async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(1_000);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.day).toBe('2026-09-05');
            expect(jobs.sumCostCentsForNodeSince).toHaveBeenCalledWith(
                NODE,
                new Date('2026-09-05T00:00:00.000Z'),
            );
            expect(verdict.node).toEqual({ ceilingCents: 2_500, spendCents: 1_000, outcome: 'ok' });
            expect(fleet.setDisabledForUser).not.toHaveBeenCalled();
            expect(inbox!.notice).not.toHaveBeenCalled();
        });

        it("drains the node and files ONE notice when the day's spend reaches the ceiling", async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(2_500);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('crossed');
            expect(verdict.drainedNodeIds).toEqual([NODE]);
            expect(verdict.noticesFiled).toBe(1);
            // The drain endpoint's exact pair, in its order: disable FIRST,
            // so a requeued claim cannot be re-claimed by the drained node.
            expect(fleet.setDisabledForUser).toHaveBeenCalledWith(USER, NODE, true);
            expect(jobService.releaseClaimsForNode).toHaveBeenCalledWith(USER, NODE);
            expect(fleet.setDisabledForUser.mock.invocationCallOrder[0]).toBeLessThan(
                jobService.releaseClaimsForNode.mock.invocationCallOrder[0],
            );
            expect(nodes.casTripDailyCeiling).toHaveBeenCalledWith(NODE, '2026-09-05');
            expect(inbox!.notice).toHaveBeenCalledTimes(1);
            expect(inbox!.notice).toHaveBeenCalledWith(
                USER,
                expect.objectContaining({
                    title: 'Fleet daily cost ceiling reached: everdesk2',
                    agentRunId: 'run-1',
                    taskId: 'task-1',
                    workId: 'work-1',
                    agentId: 'agent-1',
                }),
            );
            const body: string = inbox!.notice.mock.calls[0][1].body;
            expect(body).toContain('$25.00');
            expect(body).toContain('2026-09-05 (UTC)');
            expect(body).toContain('re-enable');
            expect(body).toContain('Billed to: claude-code: ops@example.com (Acme, max)');
        });

        it('drains again on a second crossing the same day, but files no second notice', async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(3_000);
            // The CAS on `dailyCostTrippedOn` already belongs to today.
            nodes.casTripDailyCeiling.mockResolvedValue(false);

            const verdict = await build().evaluateAfterCompletion(completion({ jobId: 'job-2' }));

            expect(verdict.node.outcome).toBe('crossed');
            expect(verdict.drainedNodeIds).toEqual([NODE]);
            expect(fleet.setDisabledForUser).toHaveBeenCalledTimes(1);
            expect(verdict.noticesFiled).toBe(0);
            expect(inbox!.notice).not.toHaveBeenCalled();
        });

        it('falls back to the deployment default when the node has no ceiling of its own', async () => {
            nodes.findById.mockResolvedValue(node({ dailyCostCeilingCents: null }));
            process.env.FLEET_NODE_DAILY_COST_CEILING_USD = '5';
            jobs.sumCostCentsForNodeSince.mockResolvedValue(500);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node).toEqual({
                ceilingCents: 500,
                spendCents: 500,
                outcome: 'crossed',
            });
            expect(verdict.drainedNodeIds).toEqual([NODE]);
        });

        it('still drains when no Inbox producer is bound', async () => {
            inbox = undefined;
            jobs.sumCostCentsForNodeSince.mockResolvedValue(9_999);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.drainedNodeIds).toEqual([NODE]);
            expect(verdict.noticesFiled).toBe(0);
        });

        it("ignores a ceiling on a node that is not the owner's", async () => {
            nodes.findById.mockResolvedValue(
                node({ userId: 'someone-else', dailyCostCeilingCents: 1 }),
            );
            jobs.sumCostCentsForNodeSince.mockResolvedValue(9_999);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('none');
            expect(fleet.setDisabledForUser).not.toHaveBeenCalled();
        });
    });

    describe('fail closed', () => {
        beforeEach(() => {
            nodes.findById.mockResolvedValue(node({ dailyCostCeilingCents: 2_500 }));
        });

        it("drains and notices when the completing run's cost is unobservable (the CLI printed no price)", async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(0);

            const verdict = await build().evaluateAfterCompletion(completion({ costCents: null }));

            expect(verdict.node.outcome).toBe('unevaluable');
            expect(verdict.node.reason).toContain('no price');
            expect(verdict.drainedNodeIds).toEqual([NODE]);
            expect(verdict.noticesFiled).toBe(1);
            const body: string = inbox!.notice.mock.calls[0][1].body;
            expect(body).toContain('could not be evaluated');
            expect(body).toContain('fails closed');
        });

        it('drains and notices when the daily spend lookup throws', async () => {
            jobs.sumCostCentsForNodeSince.mockRejectedValue(new Error('fleet_jobs unavailable'));

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('unevaluable');
            expect(verdict.node.reason).toContain('fleet_jobs unavailable');
            expect(verdict.drainedNodeIds).toEqual([NODE]);
            expect(inbox!.notice).toHaveBeenCalledTimes(1);
        });

        it('drains and notices when the daily spend sum is not a number', async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(Number.NaN);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('unevaluable');
            expect(verdict.drainedNodeIds).toEqual([NODE]);
        });

        it('drains the reporting node when it cannot even tell whether a ceiling applies', async () => {
            nodes.findById.mockRejectedValue(new Error('fleet_nodes unavailable'));

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('unevaluable');
            expect(verdict.node.reason).toContain('ceiling lookup failed');
            expect(fleet.setDisabledForUser).toHaveBeenCalledWith(USER, NODE, true);
            expect(inbox!.notice).toHaveBeenCalledTimes(1);
        });

        it('never throws out of the evaluation, even when the drain itself fails', async () => {
            jobs.sumCostCentsForNodeSince.mockResolvedValue(9_999);
            fleet.setDisabledForUser.mockRejectedValue(new Error('cannot disable'));

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('crossed');
            expect(verdict.drainedNodeIds).toEqual([]);
        });
    });

    describe('fleet-wide ceiling', () => {
        beforeEach(() => {
            policies.findByUser.mockResolvedValue({
                userId: USER,
                dailyCeilingCents: 10_000,
                trippedOn: null,
            });
        });

        it('sums every job of the owner and stays quiet below the ceiling', async () => {
            jobs.sumCostCentsForUserSince.mockResolvedValue(4_000);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(jobs.sumCostCentsForUserSince).toHaveBeenCalledWith(
                USER,
                new Date('2026-09-05T00:00:00.000Z'),
            );
            expect(verdict.fleet).toEqual({
                ceilingCents: 10_000,
                spendCents: 4_000,
                outcome: 'ok',
            });
            expect(fleet.setDisabledForUser).not.toHaveBeenCalled();
        });

        it('drains EVERY enrolled node of the owner — never an enrolling token row — and files ONE notice', async () => {
            jobs.sumCostCentsForUserSince.mockResolvedValue(10_000);
            nodes.findByUser.mockResolvedValue([
                node(),
                node({ id: OTHER, name: 'everdesk3', status: 'offline' }),
                node({
                    id: '33333333-3333-4333-8333-333333333333',
                    name: 'pending',
                    status: 'enrolling',
                }),
            ]);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.fleet.outcome).toBe('crossed');
            expect(verdict.drainedNodeIds).toEqual([NODE, OTHER]);
            expect(fleet.setDisabledForUser).toHaveBeenCalledTimes(2);
            expect(jobService.releaseClaimsForNode).toHaveBeenCalledTimes(2);
            expect(policies.casTrip).toHaveBeenCalledWith(USER, '2026-09-05');
            expect(verdict.noticesFiled).toBe(1);
            expect(inbox!.notice).toHaveBeenCalledWith(
                USER,
                expect.objectContaining({ title: 'Fleet-wide daily cost ceiling reached' }),
            );
            expect(inbox!.notice.mock.calls[0][1].body).toContain('2 nodes have been drained');
        });

        it('drains again on a repeat crossing the same day, but the policy CAS keeps it to one notice', async () => {
            jobs.sumCostCentsForUserSince.mockResolvedValue(12_000);
            policies.casTrip.mockResolvedValue(false);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.drainedNodeIds).toEqual([NODE, OTHER]);
            expect(verdict.noticesFiled).toBe(0);
            expect(inbox!.notice).not.toHaveBeenCalled();
        });

        it('falls back to the deployment default when the owner set no fleet-wide ceiling', async () => {
            policies.findByUser.mockResolvedValue(null);
            process.env.FLEET_DAILY_COST_CEILING_USD = '20';
            jobs.sumCostCentsForUserSince.mockResolvedValue(2_000);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.fleet).toEqual({
                ceilingCents: 2_000,
                spendCents: 2_000,
                outcome: 'crossed',
            });
        });

        it('fails closed on an unobservable cost for the fleet scope too', async () => {
            const verdict = await build().evaluateAfterCompletion(completion({ costCents: null }));

            expect(verdict.fleet.outcome).toBe('unevaluable');
            expect(verdict.drainedNodeIds).toEqual([NODE, OTHER]);
            expect(verdict.noticesFiled).toBe(1);
        });

        it('drains each node once when both ceilings trip on the same completion, with one notice per scope', async () => {
            nodes.findById.mockResolvedValue(node({ dailyCostCeilingCents: 100 }));
            jobs.sumCostCentsForNodeSince.mockResolvedValue(100);
            jobs.sumCostCentsForUserSince.mockResolvedValue(10_000);

            const verdict = await build().evaluateAfterCompletion(completion());

            expect(verdict.node.outcome).toBe('crossed');
            expect(verdict.fleet.outcome).toBe('crossed');
            expect(verdict.drainedNodeIds).toEqual([NODE, OTHER]);
            expect(verdict.noticesFiled).toBe(2);
        });
    });

    describe('describeForUser', () => {
        it("reports the owner ceiling, today's fleet spend and the UTC day", async () => {
            policies.findByUser.mockResolvedValue({
                userId: USER,
                dailyCeilingCents: 5_000,
                trippedOn: '2026-09-04',
            });
            jobs.sumCostCentsForUserSince.mockResolvedValue(1_234);

            const view = await build().describeForUser(USER, NOW);

            expect(view).toEqual({
                dailyCeilingCents: 5_000,
                effectiveDailyCeilingCents: 5_000,
                source: 'owner',
                trippedOn: '2026-09-04',
                todaySpendCents: 1_234,
                day: '2026-09-05',
            });
        });

        it('names the deployment default as the source when the owner set none, and "none" when there is none', async () => {
            process.env.FLEET_DAILY_COST_CEILING_USD = '12.5';
            const defaulted = await build().describeForUser(USER, NOW);
            expect(defaulted).toMatchObject({
                dailyCeilingCents: null,
                effectiveDailyCeilingCents: 1_250,
                source: 'default',
            });

            delete process.env.FLEET_DAILY_COST_CEILING_USD;
            const none = await build().describeForUser(USER, NOW);
            expect(none).toMatchObject({ effectiveDailyCeilingCents: null, source: 'none' });
        });
    });

    describe('setFleetCeilingForUser', () => {
        it('persists a whole-cent ceiling and reads the view back', async () => {
            policies.findByUser.mockResolvedValue({
                userId: USER,
                dailyCeilingCents: 7_500,
                trippedOn: null,
            });

            const view = await build().setFleetCeilingForUser(USER, 7_500);

            expect(policies.upsertCeiling).toHaveBeenCalledWith(USER, 7_500);
            expect(view.dailyCeilingCents).toBe(7_500);
        });

        it('refuses a fractional, zero or oversize ceiling rather than clamping it', async () => {
            for (const value of [0, -1, 12.5, 10_000_001, '100']) {
                await expect(build().setFleetCeilingForUser(USER, value)).rejects.toThrow(
                    /whole number of cents/,
                );
            }
            expect(policies.upsertCeiling).not.toHaveBeenCalled();
        });
    });

    describe('UTC day helpers', () => {
        it('derive the day and its midnight from the instant, in UTC', () => {
            expect(utcDay(new Date('2026-09-05T23:59:59.999Z'))).toBe('2026-09-05');
            expect(utcDay(new Date('2026-09-06T00:00:00.000Z'))).toBe('2026-09-06');
            expect(utcDayStart(new Date('2026-09-05T23:59:59.999Z')).toISOString()).toBe(
                '2026-09-05T00:00:00.000Z',
            );
        });
    });
});
