// The executor now imports WorkLifecycleService / WorkGenerationService
// (real-generation path), whose transitive generator imports include
// ESM-only packages (github-slugger) Jest can't parse. Same mock header
// the work-lifecycle specs use — these classes are never constructed in
// this suite (the optionals are left undefined).
jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import type { Repository } from 'typeorm';
import { IdeaBuildExecutorService } from '../idea-build-executor.service';
import {
    WorkBuildRequest,
    WorkBuildRequestSource,
    WorkBuildRequestStatus,
} from '../../entities/work-build-request.entity';
import { WorkAgentRun, WorkAgentRunStatus } from '../../entities/work-agent-run.entity';
import { WorkAgentRunLog } from '../../entities/work-agent-run-log.entity';
import type { WorkAgentService } from '../work-agent.service';
import type {
    GoalCompletionDecision,
    WorkProposalService,
} from '../../user-research/work-proposal.service';
import type { WorkProposalRepository } from '../../user-research/work-proposal.repository';

const ENABLED = 'EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED';
const DRY_RUN = 'EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN';
const OUTCOME = 'EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN_OUTCOME';

function makeGoal(overrides: Partial<WorkBuildRequest> = {}): WorkBuildRequest {
    return {
        id: 'goal-1',
        userId: 'user-1',
        instruction: 'build me a thing',
        status: WorkBuildRequestStatus.WAITING_FOR_APPROVAL,
        source: WorkBuildRequestSource.USER,
        dryRun: false,
        guardrailsOverride: null,
        agentPlanSummary: null,
        approvalSummary: null,
        ideaId: 'idea-1',
        createdAt: new Date('2026-07-19'),
        updatedAt: new Date('2026-07-19'),
        ...overrides,
    } as WorkBuildRequest;
}

function makeGoalsRepo(goal: WorkBuildRequest | null, count = 1) {
    const saved: WorkBuildRequest[] = [];
    return {
        _saved: saved,
        findOne: jest.fn(async () => goal),
        save: jest.fn(async (g: WorkBuildRequest) => {
            // snapshot the status at save time so the RUNNING→COMPLETED
            // sequence is observable in assertions.
            saved.push({ ...g });
            return g;
        }),
        count: jest.fn(async () => count),
    } as unknown as Repository<WorkBuildRequest> & {
        findOne: jest.Mock;
        save: jest.Mock;
        count: jest.Mock;
        _saved: WorkBuildRequest[];
    };
}

function makeRunsRepo(run: WorkAgentRun | null) {
    return {
        findOne: jest.fn(async () => run),
        save: jest.fn(async (r: WorkAgentRun) => r),
    } as unknown as Repository<WorkAgentRun> & { findOne: jest.Mock; save: jest.Mock };
}

function makeLogsRepo() {
    return {
        create: jest.fn((x: Partial<WorkAgentRunLog>) => x as WorkAgentRunLog),
        save: jest.fn(async (x: WorkAgentRunLog) => x),
    } as unknown as Repository<WorkAgentRunLog> & { create: jest.Mock; save: jest.Mock };
}

function makeWorkAgent() {
    return {
        getPreferences: jest.fn(async () => ({
            maxAutoRetries: 2,
            backoffSeconds: 60,
            exponentialBackoffFactor: 2,
        })),
    } as unknown as WorkAgentService & { getPreferences: jest.Mock };
}

function makeWorkProposals(decision: GoalCompletionDecision) {
    return {
        handleGoalCompletion: jest.fn(async () => decision),
    } as unknown as WorkProposalService & { handleGoalCompletion: jest.Mock };
}

function makeWorkProposalRepo() {
    return {
        markBuilding: jest.fn(async () => true),
    } as unknown as WorkProposalRepository & { markBuilding: jest.Mock };
}

function makeRun(): WorkAgentRun {
    return {
        id: 'run-1',
        userId: 'user-1',
        buildRequestId: 'goal-1',
        status: WorkAgentRunStatus.WAITING_FOR_APPROVAL,
        dryRun: true,
        progressPercent: 10,
        summary: {
            worksPlanned: 1,
            worksCreated: 0,
            itemsPlanned: 50,
            itemsCreated: 0,
            approvalsRequired: 1,
        },
        startedAt: null,
        finishedAt: null,
        error: null,
        createdAt: new Date('2026-07-19'),
        updatedAt: new Date('2026-07-19'),
    } as WorkAgentRun;
}

describe('IdeaBuildExecutorService', () => {
    const OLD_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...OLD_ENV };
        jest.clearAllMocks();
    });

    function build(
        goal: WorkBuildRequest | null,
        decision: GoalCompletionDecision = {
            outcome: 'accepted',
            ideaId: 'idea-1',
            workId: 'goal-1',
        },
        opts: { run?: WorkAgentRun | null; goalCount?: number } = {},
    ) {
        const goals = makeGoalsRepo(goal, opts.goalCount ?? 1);
        const runs = makeRunsRepo(opts.run === undefined ? makeRun() : opts.run);
        const logs = makeLogsRepo();
        const workAgent = makeWorkAgent();
        const workProposals = makeWorkProposals(decision);
        const repo = makeWorkProposalRepo();
        const service = new IdeaBuildExecutorService(
            goals,
            runs,
            logs,
            workAgent,
            workProposals,
            repo,
        );
        return { service, goals, runs, logs, workAgent, workProposals, repo };
    }

    describe('feature flag OFF (default)', () => {
        it('does NOT execute — returns skipped and never touches the completion machine', async () => {
            delete process.env[ENABLED];
            const { service, goals, workProposals, repo } = build(makeGoal());

            const result = await service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(result).toEqual({ status: 'skipped', reason: 'executor-disabled' });
            expect(goals.save).not.toHaveBeenCalled();
            expect(workProposals.handleGoalCompletion).not.toHaveBeenCalled();
            expect(repo.markBuilding).not.toHaveBeenCalled();
        });
    });

    describe('feature flag ON + dry-run (success outcome)', () => {
        beforeEach(() => {
            process.env[ENABLED] = 'true';
            process.env[DRY_RUN] = 'true';
            delete process.env[OUTCOME]; // default = success
        });

        it('drives goal WAITING_FOR_APPROVAL → RUNNING → COMPLETED, marks Idea BUILDING, and accepts the Idea', async () => {
            const { service, goals, workProposals, repo } = build(makeGoal());

            const result = await service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            // Idea marked BUILDING before completion.
            expect(repo.markBuilding).toHaveBeenCalledWith('idea-1', 'user-1');

            // The FULL completion state machine was driven with a success outcome.
            expect(workProposals.handleGoalCompletion).toHaveBeenCalledTimes(1);
            const call = workProposals.handleGoalCompletion.mock.calls[0][0];
            expect(call.ideaId).toBe('idea-1');
            expect(call.outcome.kind).toBe('success');
            // Deterministic synthetic workId = the goal id.
            expect(call.outcome.workId).toBe('goal-1');
            expect(call.policy).toEqual({
                maxAutoRetries: 2,
                backoffSeconds: 60,
                exponentialBackoffFactor: 2,
            });

            // Goal transitioned RUNNING then COMPLETED (observable via save order).
            const statuses = goals._saved.map((g) => g.status);
            expect(statuses).toEqual([
                WorkBuildRequestStatus.RUNNING,
                WorkBuildRequestStatus.COMPLETED,
            ]);

            expect(result).toEqual({
                status: 'completed',
                goalId: 'goal-1',
                ideaId: 'idea-1',
                decision: 'accepted',
                workId: 'goal-1',
                dryRun: true,
            });
        });

        it('is idempotent — a terminal goal is skipped without re-running completion', async () => {
            const { service, workProposals } = build(
                makeGoal({ status: WorkBuildRequestStatus.COMPLETED }),
            );

            const result = await service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(result).toEqual({ status: 'skipped', reason: 'goal-completed' });
            expect(workProposals.handleGoalCompletion).not.toHaveBeenCalled();
        });

        it('skips a goal with no ideaId (power-user direct goal)', async () => {
            const { service, workProposals } = build(makeGoal({ ideaId: null }));
            const result = await service.executeBuild({ goalId: 'goal-1', userId: 'user-1' });
            expect(result).toEqual({ status: 'skipped', reason: 'not-an-idea-goal' });
            expect(workProposals.handleGoalCompletion).not.toHaveBeenCalled();
        });
    });

    describe('feature flag ON + dry-run (failure outcome)', () => {
        beforeEach(() => {
            process.env[ENABLED] = 'true';
            process.env[DRY_RUN] = 'true';
            process.env[OUTCOME] = 'failure';
        });

        it('drives the terminal-failure path — goal FAILED, Idea failed decision', async () => {
            const { service, goals, workProposals } = build(makeGoal(), {
                outcome: 'failed',
                ideaId: 'idea-1',
                kind: 'unknown' as never,
                message: 'synthetic',
            });

            const result = await service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(workProposals.handleGoalCompletion).toHaveBeenCalledTimes(1);
            expect(workProposals.handleGoalCompletion.mock.calls[0][0].outcome.kind).toBe(
                'failure',
            );
            const statuses = goals._saved.map((g) => g.status);
            expect(statuses).toEqual([
                WorkBuildRequestStatus.RUNNING,
                WorkBuildRequestStatus.FAILED,
            ]);
            expect(result.status).toBe('failed');
        });
    });

    describe('feature flag ON, dry-run OFF (real generation)', () => {
        beforeEach(() => {
            process.env[ENABLED] = 'true';
            process.env[DRY_RUN] = 'false';
        });

        function makeIdea(overrides: Record<string, unknown> = {}) {
            return {
                id: 'aaaaaaaa-1111-2222-3333-444444444444',
                userId: 'user-1',
                title: 'Best AI Tools',
                description: 'A directory of the best AI tools with reviews.',
                slugSuggestion: 'best-ai-tools',
                generatedPrompt: null,
                targetWorkId: null,
                extraPrompt: null,
                ...overrides,
            };
        }

        function buildReal(
            goal: WorkBuildRequest | null,
            idea: Record<string, unknown> | null,
            decision: GoalCompletionDecision = {
                outcome: 'accepted',
                ideaId: 'idea-1',
                workId: 'work-new',
            },
        ) {
            const goals = makeGoalsRepo(goal, 1);
            const runs = makeRunsRepo(makeRun());
            const logs = makeLogsRepo();
            const workAgent = makeWorkAgent();
            const workProposals = makeWorkProposals(decision);
            const repo = {
                markBuilding: jest.fn(async () => true),
                findByIdForUser: jest.fn(async () => idea),
            } as unknown as WorkProposalRepository & {
                markBuilding: jest.Mock;
                findByIdForUser: jest.Mock;
            };
            const users = { findById: jest.fn(async () => ({ id: 'user-1', username: 'u' })) };
            const workRepo = { existsByUserAndSlug: jest.fn(async () => false) };
            const workLifecycle = {
                createWork: jest.fn(async () => ({
                    status: 'success',
                    work: { id: 'work-new' },
                })),
            };
            const workGeneration = {
                generateItems: jest.fn(async () => ({ status: 'pending' })),
                updateItemsGenerator: jest.fn(async () => ({ status: 'pending' })),
            };
            const service = new IdeaBuildExecutorService(
                goals,
                runs,
                logs,
                workAgent,
                workProposals,
                repo,
                users as never,
                workRepo as never,
                workLifecycle as never,
                workGeneration as never,
            );
            return {
                service,
                goals,
                workProposals,
                repo,
                users,
                workRepo,
                workLifecycle,
                workGeneration,
            };
        }

        it('with real deps unwired: skips WITHOUT mutating Goal/Idea state (never-strand invariant)', async () => {
            // goal.dryRun must also be false, else the executor treats it as dry-run.
            const { service, goals, workProposals, repo } = build(makeGoal({ dryRun: false }));

            const result = await service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(result).toEqual({
                status: 'skipped',
                reason: 'real-generation-dependencies-unwired',
            });
            expect(goals.save).not.toHaveBeenCalled();
            expect(repo.markBuilding).not.toHaveBeenCalled();
            expect(workProposals.handleGoalCompletion).not.toHaveBeenCalled();
        });

        it('CREATE path: creates a Work from the Idea, runs generation, and accepts on success', async () => {
            const h = buildReal(makeGoal({ dryRun: false }), makeIdea());

            const result = await h.service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(h.workLifecycle.createWork).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'best-ai-tools', name: 'Best AI Tools' }),
                expect.objectContaining({ id: 'user-1' }),
            );
            expect(h.workGeneration.generateItems).toHaveBeenCalledWith(
                'work-new',
                expect.objectContaining({
                    prompt: expect.stringContaining('best AI tools'),
                }),
                expect.objectContaining({ id: 'user-1' }),
                true,
                { triggeredBy: 'api' },
            );
            expect(h.workProposals.handleGoalCompletion).toHaveBeenCalledWith(
                expect.objectContaining({
                    outcome: { kind: 'success', workId: 'work-new' },
                }),
            );
            expect(result).toMatchObject({ status: 'completed', decision: 'accepted' });
            // Goal went RUNNING then COMPLETED.
            const statuses = h.goals._saved.map((g) => g.status);
            expect(statuses).toEqual([
                WorkBuildRequestStatus.RUNNING,
                WorkBuildRequestStatus.COMPLETED,
            ]);
        });

        it('RE-RUN path: targetWorkId re-runs generation with the composed prompt override', async () => {
            const h = buildReal(
                makeGoal({ dryRun: false }),
                makeIdea({ targetWorkId: 'work-existing', extraPrompt: 'Also add pricing pages.' }),
            );

            await h.service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(h.workGeneration.updateItemsGenerator).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-existing',
                    updateDto: expect.objectContaining({
                        prompt: expect.stringContaining('Also add pricing pages.'),
                    }),
                    awaitCompletion: true,
                    context: { triggeredBy: 'api' },
                }),
            );
            expect(h.workLifecycle.createWork).not.toHaveBeenCalled();
            expect(h.workProposals.handleGoalCompletion).toHaveBeenCalledWith(
                expect.objectContaining({
                    outcome: { kind: 'success', workId: 'work-existing' },
                }),
            );
        });

        it('generation failure flows into the completion machine as a failure outcome', async () => {
            const h = buildReal(makeGoal({ dryRun: false }), makeIdea(), {
                outcome: 'failed',
                ideaId: 'idea-1',
                kind: 'generation' as never,
                message: 'boom',
            } as GoalCompletionDecision);
            h.workGeneration.generateItems.mockRejectedValueOnce(new Error('generation blew up'));

            const result = await h.service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(h.workProposals.handleGoalCompletion).toHaveBeenCalledWith(
                expect.objectContaining({
                    outcome: expect.objectContaining({ kind: 'failure' }),
                }),
            );
            expect(result).toMatchObject({ status: 'failed', decision: 'failed', dryRun: false });
            const statuses = h.goals._saved.map((g) => g.status);
            expect(statuses).toEqual([
                WorkBuildRequestStatus.RUNNING,
                WorkBuildRequestStatus.FAILED,
            ]);
        });

        it('slug collision falls back to an id-suffixed slug', async () => {
            const h = buildReal(makeGoal({ dryRun: false }), makeIdea());
            h.workRepo.existsByUserAndSlug.mockResolvedValueOnce(true);

            await h.service.executeBuild({
                goalId: 'goal-1',
                userId: 'user-1',
                ideaId: 'idea-1',
            });

            expect(h.workLifecycle.createWork).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'best-ai-tools-aaaaaaaa' }),
                expect.anything(),
            );
        });
    });
});
