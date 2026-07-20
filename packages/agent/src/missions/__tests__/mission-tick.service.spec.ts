import type { Repository } from 'typeorm';
import { MISSION_TICK_MAX_PER_TICK, MissionTickService } from '../mission-tick.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import type { WorkProposalRepository } from '../../user-research/work-proposal.repository';
import type { WorkProposalService } from '../../user-research/work-proposal.service';
import type { WorkAgentService } from '../../work-agent/work-agent.service';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';

/** Hand-rolled Mission repository mock. Enough for tickDue's
 *  TypeORM `find({ where, order, take })` + runOnce's `findOne({ where })`.
 *  `take` is honored (insertion order stands in for `createdAt ASC`) so the
 *  DoS-bound truncation test below exercises a real cut-off. */
function makeMissionRepo() {
    const rows: Mission[] = [];
    return {
        find: jest.fn(async (opts: { where?: Partial<Mission>; take?: number } = {}) => {
            const where = opts.where ?? {};
            const matched = rows.filter((m) =>
                Object.entries(where).every(
                    ([k, v]) => (m as unknown as Record<string, unknown>)[k] === v,
                ),
            );
            return typeof opts.take === 'number' ? matched.slice(0, opts.take) : matched;
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
        // PR-3 — criteria-guarded UPDATE (the FAILED-persistence path calls
        // `update({ id, status: ACTIVE }, { status: FAILED })`). Applies the
        // patch in place so tests can assert on `_rows` afterwards.
        update: jest.fn(async (criteria: Partial<Mission>, patch: Partial<Mission>) => {
            const matched = rows.filter((m) =>
                Object.entries(criteria).every(
                    ([k, v]) => (m as unknown as Record<string, unknown>)[k] === v,
                ),
            );
            for (const m of matched) Object.assign(m, patch);
            return { affected: matched.length };
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

/** ActivityLogService mock — just log(); resolves by default (PR-3). */
function makeActivityLog() {
    return { log: jest.fn().mockResolvedValue(undefined) };
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
        activityLog,
    }: {
        outstanding?: number;
        userCap?: number | null;
        generateResult?: Parameters<typeof makeWorkProposalService>[0]['generateResult'];
        /** PR-3 — trailing @Optional() ctor param; omit to test the unwired path. */
        activityLog?: ReturnType<typeof makeActivityLog>;
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
            activityLog as unknown as ActivityLogService | undefined,
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
            // Security (DoS hardening): the query is also bounded (`take`)
            // and deterministically ordered so an unbounded number of
            // scheduled Missions can't bloat every tick — this test pins
            // the bound to the query.
            await service.tickDue(new Date('2026-05-25T09:00:00Z'));
            expect(missionRepo.find).toHaveBeenCalledWith({
                where: { status: MissionStatus.ACTIVE, type: MissionType.SCHEDULED },
                order: { createdAt: 'ASC' },
                take: MISSION_TICK_MAX_PER_TICK,
            });
        });

        it('truncates the per-tick batch at MISSION_TICK_MAX_PER_TICK and warns (DoS bound)', async () => {
            build();
            // Seed one Mission more than the bound — all with a cron that
            // never matches the tick so the test stays generator-free.
            for (let i = 0; i < MISSION_TICK_MAX_PER_TICK + 1; i++) {
                missionRepo._seed({ id: `m${i}`, userId: 'u1', schedule: '0 9 * * MON' });
            }
            const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            // Sunday — the Monday cron never matches, so every loaded row is skipped.
            const summary = await service.tickDue(new Date('2026-05-24T09:00:00Z'));
            expect(summary.evaluated).toBe(MISSION_TICK_MAX_PER_TICK);
            expect(summary.skipped).toBe(MISSION_TICK_MAX_PER_TICK);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('per-tick bound'));
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

    describe('fatal generation failure persists FAILED (PR-3 review P4)', () => {
        it('flips ACTIVE → FAILED via a status-guarded update and logs mission_failed', async () => {
            const activityLog = makeActivityLog();
            build({ activityLog });
            proposals.generate.mockRejectedValueOnce(new Error('provider exploded'));
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.failed).toBe(1);
            expect(summary.entries[0].outcome).toBe('failed');
            expect(summary.entries[0].message).toBe('provider exploded');
            // Status-guarded write: only an ACTIVE row is flipped, so a
            // concurrent user pause/complete can't be clobbered.
            expect(missionRepo.update).toHaveBeenCalledWith(
                { id: 'm1', status: MissionStatus.ACTIVE },
                { status: MissionStatus.FAILED },
            );
            expect(missionRepo._rows[0].status).toBe(MissionStatus.FAILED);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    actionType: ActivityActionType.MISSION_FAILED,
                    action: 'tick-failed',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({
                        missionId: 'm1',
                        message: 'provider exploded',
                    }),
                }),
            );
            errorSpy.mockRestore();
        });

        it('no-ops cleanly when activityLog is absent (FAILED still persisted)', async () => {
            build();
            proposals.generate.mockRejectedValueOnce(new Error('boom'));
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('failed');
            expect(missionRepo._rows[0].status).toBe(MissionStatus.FAILED);
            errorSpy.mockRestore();
        });

        it('a FAILED-persistence error never masks the original failure (best-effort)', async () => {
            const activityLog = makeActivityLog();
            build({ activityLog });
            proposals.generate.mockRejectedValueOnce(new Error('original-tick-error'));
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            missionRepo.update.mockRejectedValueOnce(new Error('db down'));
            const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('failed');
            expect(summary.entries[0].message).toBe('original-tick-error');
            // The activity write sits after the persistence attempt in the
            // same guard — skipped when persistence throws.
            expect(activityLog.log).not.toHaveBeenCalled();
            errorSpy.mockRestore();
            warnSpy.mockRestore();
        });

        it('runOnce on a PAUSED mission: the guarded update leaves the row PAUSED', async () => {
            build();
            proposals.generate.mockRejectedValueOnce(new Error('boom'));
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                status: MissionStatus.PAUSED,
                schedule: '* * * * *',
            });
            const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            const res = await service.runOnce('m1', 'u1');
            expect(res.outcome).toBe('failed');
            expect(missionRepo._rows[0].status).toBe(MissionStatus.PAUSED);
            errorSpy.mockRestore();
        });
    });

    describe('cap-hit activity (PR-3 gap G3)', () => {
        it('writes mission_tick_capped when the cap blocks a tick', async () => {
            const activityLog = makeActivityLog();
            build({ outstanding: 5, activityLog });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: 5,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    actionType: ActivityActionType.MISSION_TICK_CAPPED,
                    action: 'tick-capped',
                    status: ActivityStatus.COMPLETED,
                    details: expect.objectContaining({ missionId: 'm1', outstanding: 5, cap: 5 }),
                }),
            );
        });

        it('does not write activity on a successful spawn', async () => {
            const activityLog = makeActivityLog();
            build({
                activityLog,
                generateResult: {
                    status: 'generated',
                    proposals: [makeProposal('p1', 'm1', 'u1')],
                },
            });
            missionRepo._seed({ id: 'm1', userId: 'u1', schedule: '* * * * *' });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('spawned');
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('no-ops cleanly when activityLog is absent (cap-hit outcome unchanged)', async () => {
            build({ outstanding: 5 });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: 5,
            });
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
        });

        it('an activity-write failure does not change the cap-hit outcome (best-effort)', async () => {
            const activityLog = makeActivityLog();
            activityLog.log.mockRejectedValue(new Error('activity db down'));
            build({ outstanding: 5, activityLog });
            missionRepo._seed({
                id: 'm1',
                userId: 'u1',
                schedule: '* * * * *',
                outstandingIdeasCap: 5,
            });
            const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            const summary = await service.tickDue(new Date('2026-05-24T10:00:00Z'));
            expect(summary.entries[0].outcome).toBe('cap-hit');
            expect(activityLog.log).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });
});
