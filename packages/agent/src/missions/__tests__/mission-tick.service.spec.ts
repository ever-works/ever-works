import type { Repository } from 'typeorm';
import { MissionTickService } from '../mission-tick.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import type { WorkProposalRepository } from '../../user-research/work-proposal.repository';
import type { WorkProposalService } from '../../user-research/work-proposal.service';
import type { WorkAgentService } from '../../work-agent/work-agent.service';

/** Hand-rolled Mission repository mock. Enough for tickDue's
 *  TypeORM `find({ where })` + runOnce's `findOne({ where })`. */
function makeMissionRepo() {
    const rows: Mission[] = [];
    return {
        find: jest.fn(async (opts: { where?: Partial<Mission> } = {}) => {
            const where = opts.where ?? {};
            return rows.filter((m) =>
                Object.entries(where).every(
                    ([k, v]) => (m as unknown as Record<string, unknown>)[k] === v,
                ),
            );
        }),
        findOne: jest.fn(async (opts: { where: { id: string; userId?: string } }) => {
            return (
                rows.find(
                    (r) =>
                        r.id === opts.where.id &&
                        (opts.where.userId === undefined || r.userId === opts.where.userId),
                ) ?? null
            );
        }),
        _seed: (m: Partial<Mission> & { id: string; userId: string }) => {
            const full: Mission = {
                id: m.id,
                userId: m.userId,
                title: m.title ?? 'T',
                description: m.description ?? 'D',
                type: m.type ?? MissionType.SCHEDULED,
                status: m.status ?? MissionStatus.ACTIVE,
                schedule: m.schedule ?? '* * * * *',
                autoBuildWorks: m.autoBuildWorks ?? false,
                outstandingIdeasCap: m.outstandingIdeasCap ?? null,
                guardrailsOverride: m.guardrailsOverride ?? null,
                missionTemplateRepo: m.missionTemplateRepo ?? null,
                missionRepo: m.missionRepo ?? null,
                sourceMissionId: m.sourceMissionId ?? null,
                createdAt: new Date('2026-05-24'),
                updatedAt: new Date('2026-05-24'),
            } as Mission;
            rows.push(full);
            return full;
        },
        _rows: rows,
    };
}

/** WorkProposalRepository mock — just countOutstandingByMission. */
function makeWorkProposalRepo(initialCount = 0) {
    return {
        countOutstandingByMission: jest.fn(async () => initialCount),
    } as unknown as WorkProposalRepository & {
        countOutstandingByMission: jest.Mock;
    };
}

/** WorkProposalService mock — generate + queueForBuild. */
function makeWorkProposalService(
    overrides: {
        generateResult?: {
            status: 'generated' | 'error' | 'skipped-no-profile' | 'skipped-low-confidence';
            proposals: WorkProposal[];
            error?: string;
        };
    } = {},
) {
    const result = overrides.generateResult ?? {
        status: 'generated' as const,
        proposals: [],
    };
    return {
        generate: jest.fn(async () => ({ ...result, tokensUsed: 0 })),
        queueForBuild: jest.fn(async (_userId: string, id: string) => {
            const p: Partial<WorkProposal> = { id, status: WorkProposalStatus.QUEUED };
            return p as WorkProposal;
        }),
    } as unknown as WorkProposalService & {
        generate: jest.Mock;
        queueForBuild: jest.Mock;
    };
}

function makeWorkAgentService(missionDefaultOutstandingCap: number | null = null) {
    return {
        getPreferences: jest.fn(async () => ({
            missionDefaultOutstandingCap,
        })),
    } as unknown as WorkAgentService & { getPreferences: jest.Mock };
}

/** Helper to build a fake WorkProposal returned from generate(). */
function makeProposal(id: string, missionId: string, userId: string): WorkProposal {
    return {
        id,
        userId,
        missionId,
        title: `Idea ${id}`,
        description: 'd',
        slugSuggestion: id,
        status: WorkProposalStatus.PENDING,
        source: WorkProposalSource.MISSION,
    } as WorkProposal;
}

describe('MissionTickService', () => {
    let missionRepo: ReturnType<typeof makeMissionRepo>;
    let proposalRepo: ReturnType<typeof makeWorkProposalRepo>;
    let proposals: ReturnType<typeof makeWorkProposalService>;
    let workAgent: ReturnType<typeof makeWorkAgentService>;
    let service: MissionTickService;

    function build({
        outstanding = 0,
        userCap = null,
        generateResult,
    }: {
        outstanding?: number;
        userCap?: number | null;
        generateResult?: Parameters<typeof makeWorkProposalService>[0]['generateResult'];
    } = {}) {
        missionRepo = makeMissionRepo();
        proposalRepo = makeWorkProposalRepo(outstanding);
        proposals = makeWorkProposalService({ generateResult });
        workAgent = makeWorkAgentService(userCap);
        service = new MissionTickService(
            missionRepo as unknown as Repository<Mission>,
            proposals,
            proposalRepo,
            workAgent,
        );
    }

    describe('tickDue — cron filtering', () => {
        it('skips Missions whose cron does not match the tick time', async () => {
            build();
            // Schedule = "every Monday 9am UTC"; tick at Sunday 9am.
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '0 9 * * MON' });
            const summary = await service.tickDue(new Date('2026-05-24T09:00:00Z'));
            expect(summary.evaluated).toBe(1);
            expect(summary.skipped).toBe(1);
            expect(summary.ran).toBe(0);
            expect(summary.entries[0].outcome).toBe('cron-no-match');
            expect(proposals.generate).not.toHaveBeenCalled();
        });

        it('runs Missions whose cron matches the tick time', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            // 2026-05-25 is Monday — 9am UTC matches "0 9 * * MON".
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '0 9 * * MON' });
            const summary = await service.tickDue(new Date('2026-05-25T09:00:00Z'));
            expect(summary.ran).toBe(1);
            expect(summary.entries[0].outcome).toBe('spawned');
            expect(summary.entries[0].ideasCreated).toBe(1);
        });

        it('marks Missions with an invalid cron expression as failed (per-Mission, not bubbled)', async () => {
            build();
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: 'totally bogus' });
            const summary = await service.tickDue(new Date('2026-05-25T09:00:00Z'));
            expect(summary.failed).toBe(1);
            expect(summary.entries[0].outcome).toBe('failed');
            expect(summary.entries[0].message).toMatch(/invalid-schedule/);
            // Generator was not invoked — invalid-schedule shouldn't burn tokens.
            expect(proposals.generate).not.toHaveBeenCalled();
        });

        it('only fetches ACTIVE + SCHEDULED Missions (one-shot / paused / completed not evaluated)', async () => {
            build();
            // Use the find mock's where clause to verify the query shape.
            await service.tickDue(new Date('2026-05-25T09:00:00Z'));
            expect(missionRepo.find).toHaveBeenCalledWith({
                where: { status: MissionStatus.ACTIVE, type: MissionType.SCHEDULED },
            });
        });
    });

    describe('outstanding-Ideas cap', () => {
        it('per-Mission cap: skips when outstanding >= cap', async () => {
            build({ outstanding: 5 });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: 5,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
            expect(summary.entries[0].outstanding).toBe(5);
            expect(summary.entries[0].cap).toBe(5);
            expect(proposals.generate).not.toHaveBeenCalled();
        });

        it('per-Mission cap = -1 (unlimited): never cap-hits', async () => {
            build({
                outstanding: 9999,
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: -1,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('spawned');
            expect(summary.entries[0].cap).toBeNull();
        });

        it('falls back to user pref missionDefaultOutstandingCap when per-Mission is null', async () => {
            build({ outstanding: 3, userCap: 3 });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: null,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
            expect(summary.entries[0].cap).toBe(3);
        });

        it('falls back to platform default (20) when neither per-Mission nor user pref is set', async () => {
            build({ outstanding: 20, userCap: null });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: null,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
            expect(summary.entries[0].cap).toBe(20);
        });
    });

    describe('generation + auto-build', () => {
        it('passes source=MISSION + missionId + missionContext to the generator', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                description: 'Build the best cat business',
                schedule: '* * * * *',
            });
            await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(proposals.generate).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({
                    source: WorkProposalSource.MISSION,
                    missionId: 'm1',
                    missionContext: expect.objectContaining({
                        description: 'Build the best cat business',
                    }),
                }),
            );
        });

        it('autoBuildWorks=true queues every spawned Idea', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1'), makeProposal('p2', 'm1', 'u1')],
                },
            });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                autoBuildWorks: true,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].ideasCreated).toBe(2);
            expect(summary.entries[0].ideasQueued).toBe(2);
            expect(proposals.queueForBuild).toHaveBeenCalledTimes(2);
        });

        it('autoBuildWorks=false does NOT queue spawned Ideas (left at PENDING for user triage)', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                autoBuildWorks: false,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].ideasQueued).toBe(0);
            expect(proposals.queueForBuild).not.toHaveBeenCalled();
        });

        it('generator returning 0 proposals is reported as no-ideas, not failed', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [],
                },
            });
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.skipped).toBe(1);
            expect(summary.entries[0].outcome).toBe('no-ideas');
        });

        it('generator error (e.g. provider not configured) is reported as no-ideas with the error string', async () => {
            build({
                generateResult: {
                    status: 'error',
                    proposals: [],
                    error: 'ai-provider-not-configured',
                },
            });
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('no-ideas');
            expect(summary.entries[0].message).toBe('error');
        });
    });

    describe('runOnce (manual runNow path)', () => {
        it('bypasses the cron check', async () => {
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            // Schedule is "every Monday 9am UTC" — explicitly mismatched
            // against a Sunday afternoon clock.
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '0 9 * * MON',
            });
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('spawned');
        });

        it('still enforces the outstanding-Ideas cap', async () => {
            build({ outstanding: 5 });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                outstandingIdeasCap: 5,
                schedule: '0 9 * * MON',
            });
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('cap-hit');
        });

        it('allows PAUSED missions to run-now (parity with MissionsService gate)', async () => {
            // Codex review on PR #1013: `MissionsService.runNow` lets
            // PAUSED through, so the tick service must too — otherwise
            // the manual run-now button always fails for paused
            // missions.
            build({
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                status: MissionStatus.PAUSED,
                schedule: '* * * * *',
            });
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('spawned');
        });

        it('returns failed when Mission is COMPLETED', async () => {
            build();
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                status: MissionStatus.COMPLETED,
                schedule: '* * * * *',
            });
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('failed');
            expect(res.message).toMatch(/mission-not-runnable/);
        });

        it('returns failed when Mission is FAILED', async () => {
            build();
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                status: MissionStatus.FAILED,
                schedule: '* * * * *',
            });
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('failed');
            expect(res.message).toMatch(/mission-not-runnable/);
        });

        it('returns failed when the Mission does not exist for the user', async () => {
            build();
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const res = await service.runOnce('m1', 'someone-else');
            expect(res.outcome).toBe('failed');
            expect(res.message).toMatch(/not-found/);
        });
    });
});
