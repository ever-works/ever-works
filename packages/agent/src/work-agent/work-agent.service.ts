import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    WorkAgentGoal,
    WorkAgentGoalSource,
    WorkAgentGoalStatus,
} from '../entities/work-agent-goal.entity';
import {
    WorkAgentGuardrails,
    WorkAgentPreference,
} from '../entities/work-agent-preference.entity';
import {
    WorkAgentRun,
    WorkAgentRunStatus,
} from '../entities/work-agent-run.entity';
import {
    WorkAgentRunLog,
    WorkAgentRunLogLevel,
} from '../entities/work-agent-run-log.entity';
import type {
    CreateWorkAgentGoalInput,
    UpdateWorkAgentPreferencesInput,
    WorkAgentGoalDto,
    WorkAgentPreferencesDto,
    WorkAgentRunDto,
    WorkAgentRunLogDto,
} from './types';

export const DEFAULT_WORK_AGENT_GUARDRAILS: WorkAgentGuardrails = {
    maxWorksPerRun: 1,
    maxItemsPerWork: 50,
    maxBudgetCentsPerRun: 0,
    requireApprovalBeforeCreate: true,
    requireApprovalBeforeDelete: true,
    requireApprovalAboveBudgetCents: 0,
    dryRunByDefault: true,
};

const ACTIVE_RUN_STATUSES = [
    WorkAgentRunStatus.QUEUED,
    WorkAgentRunStatus.PLANNING,
    WorkAgentRunStatus.RESEARCHING,
    WorkAgentRunStatus.GENERATING,
    WorkAgentRunStatus.WRITING,
    WorkAgentRunStatus.WAITING_FOR_APPROVAL,
];

const CANCELABLE_GOAL_STATUSES = [
    WorkAgentGoalStatus.PENDING,
    WorkAgentGoalStatus.PLANNING,
    WorkAgentGoalStatus.WAITING_FOR_APPROVAL,
    WorkAgentGoalStatus.RUNNING,
];

@Injectable()
export class WorkAgentService {
    constructor(
        @InjectRepository(WorkAgentPreference)
        private readonly preferences: Repository<WorkAgentPreference>,
        @InjectRepository(WorkAgentGoal)
        private readonly goals: Repository<WorkAgentGoal>,
        @InjectRepository(WorkAgentRun)
        private readonly runs: Repository<WorkAgentRun>,
        @InjectRepository(WorkAgentRunLog)
        private readonly logs: Repository<WorkAgentRunLog>,
    ) {}

    async getPreferences(userId: string): Promise<WorkAgentPreferencesDto> {
        const preference = await this.findOrCreatePreferences(userId);
        return this.toPreferencesDto(preference);
    }

    async updatePreferences(
        userId: string,
        input: UpdateWorkAgentPreferencesInput,
    ): Promise<WorkAgentPreferencesDto> {
        const preference = await this.findOrCreatePreferences(userId);
        const guardrails = this.mergeGuardrails(preference.guardrails, input);

        const saved = await this.preferences.save({
            ...preference,
            enabled: input.enabled ?? preference.enabled,
            autoApproveLowImpact: input.autoApproveLowImpact ?? preference.autoApproveLowImpact,
            dailySuggestionsEnabled:
                input.dailySuggestionsEnabled ?? preference.dailySuggestionsEnabled,
            guardrails,
        });

        return this.toPreferencesDto(saved);
    }

    async createGoal(
        userId: string,
        input: CreateWorkAgentGoalInput,
    ): Promise<{ goal: WorkAgentGoalDto; run: WorkAgentRunDto }> {
        const preference = await this.findOrCreatePreferences(userId);
        if (!preference.enabled) {
            throw new BadRequestException('Work agent is disabled.');
        }

        const guardrailsOverride = this.pickGuardrailOverride(input);
        const dryRun = input.dryRun ?? preference.guardrails.dryRunByDefault;
        const { goal, run } = await this.goals.manager.transaction(async (manager) => {
            const goalRepo = manager.getRepository(WorkAgentGoal);
            const runRepo = manager.getRepository(WorkAgentRun);
            const logRepo = manager.getRepository(WorkAgentRunLog);

            const savedGoal = await goalRepo.save(
                goalRepo.create({
                    userId,
                    instruction: input.instruction.trim(),
                    status: WorkAgentGoalStatus.PENDING,
                    source: WorkAgentGoalSource.USER,
                    dryRun,
                    guardrailsOverride:
                        Object.keys(guardrailsOverride).length > 0 ? guardrailsOverride : null,
                }),
            );

            const savedRun = await runRepo.save(
                runRepo.create({
                    userId,
                    goalId: savedGoal.id,
                    status: WorkAgentRunStatus.QUEUED,
                    dryRun,
                    progressPercent: 0,
                    summary: {
                        worksPlanned: 0,
                        worksCreated: 0,
                        itemsPlanned: 0,
                        itemsCreated: 0,
                        approvalsRequired: preference.autoApproveLowImpact ? 0 : 1,
                    },
                }),
            );

            await logRepo.save(
                logRepo.create({
                    userId,
                    runId: savedRun.id,
                    level: WorkAgentRunLogLevel.INFO,
                    step: 'queued',
                    message: 'Goal queued for the Work agent.',
                    metadata: {
                        dryRun,
                        guardrails: this.mergeGuardrails(preference.guardrails, guardrailsOverride),
                    },
                }),
            );

            return { goal: savedGoal, run: savedRun };
        });

        return { goal: this.toGoalDto(goal), run: this.toRunDto(run) };
    }

    async listGoals(userId: string, take = 20): Promise<WorkAgentGoalDto[]> {
        const rows = await this.goals.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            take,
        });
        return rows.map((goal) => this.toGoalDto(goal));
    }

    async getActiveRun(userId: string): Promise<WorkAgentRunDto | null> {
        const run = await this.runs.findOne({
            where: { userId, status: In(ACTIVE_RUN_STATUSES) },
            order: { createdAt: 'DESC' },
        });
        return run ? this.toRunDto(run) : null;
    }

    async listRunLogs(userId: string, runId: string): Promise<WorkAgentRunLogDto[]> {
        const run = await this.runs.findOne({ where: { id: runId, userId } });
        if (!run) {
            throw new NotFoundException('Work agent run not found.');
        }

        const rows = await this.logs.find({
            where: { userId, runId },
            order: { createdAt: 'ASC' },
            take: 100,
        });
        return rows.map((log) => this.toLogDto(log));
    }

    async cancelGoal(userId: string, goalId: string): Promise<WorkAgentGoalDto> {
        const savedGoal = await this.goals.manager.transaction(async (manager) => {
            const goalRepo = manager.getRepository(WorkAgentGoal);
            const runRepo = manager.getRepository(WorkAgentRun);
            const logRepo = manager.getRepository(WorkAgentRunLog);

            const goal = await goalRepo.findOne({ where: { id: goalId, userId } });
            if (!goal) {
                throw new NotFoundException('Work agent goal not found.');
            }
            if (!CANCELABLE_GOAL_STATUSES.includes(goal.status)) {
                throw new BadRequestException('Work agent goal can no longer be canceled.');
            }

            goal.status = WorkAgentGoalStatus.CANCELED;
            const canceledGoal = await goalRepo.save(goal);

            const activeRuns = await runRepo.find({
                where: { userId, goalId, status: In(ACTIVE_RUN_STATUSES) },
            });
            for (const run of activeRuns) {
                run.status = WorkAgentRunStatus.CANCELED;
                run.finishedAt = new Date();
                await runRepo.save(run);
                await logRepo.save(
                    logRepo.create({
                        userId,
                        runId: run.id,
                        level: WorkAgentRunLogLevel.INFO,
                        step: 'canceled',
                        message: 'Run canceled by the user.',
                    }),
                );
            }

            return canceledGoal;
        });

        return this.toGoalDto(savedGoal);
    }

    private async findOrCreatePreferences(userId: string): Promise<WorkAgentPreference> {
        const existing = await this.preferences.findOne({ where: { userId } });
        if (existing) {
            existing.guardrails = this.mergeGuardrails(
                DEFAULT_WORK_AGENT_GUARDRAILS,
                existing.guardrails,
            );
            return existing;
        }

        try {
            return await this.preferences.save(
                this.preferences.create({
                    userId,
                    enabled: false,
                    autoApproveLowImpact: false,
                    dailySuggestionsEnabled: true,
                    guardrails: { ...DEFAULT_WORK_AGENT_GUARDRAILS },
                }),
            );
        } catch (error) {
            if (!this.isUniqueConstraintError(error)) {
                throw error;
            }
            const raced = await this.preferences.findOne({ where: { userId } });
            if (!raced) {
                throw error;
            }
            raced.guardrails = this.mergeGuardrails(
                DEFAULT_WORK_AGENT_GUARDRAILS,
                raced.guardrails,
            );
            return raced;
        }
    }

    private isUniqueConstraintError(error: unknown): boolean {
        const code = (error as { code?: string })?.code;
        return code === '23505' || code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT';
    }

    private mergeGuardrails(
        base: WorkAgentGuardrails,
        override?: Partial<WorkAgentGuardrails> | null,
    ): WorkAgentGuardrails {
        return {
            maxWorksPerRun: this.clampInt(override?.maxWorksPerRun, base.maxWorksPerRun, 1, 25),
            maxItemsPerWork: this.clampInt(override?.maxItemsPerWork, base.maxItemsPerWork, 1, 500),
            maxBudgetCentsPerRun: this.clampInt(
                override?.maxBudgetCentsPerRun,
                base.maxBudgetCentsPerRun,
                0,
                1_000_000,
            ),
            requireApprovalBeforeCreate:
                override?.requireApprovalBeforeCreate ?? base.requireApprovalBeforeCreate,
            requireApprovalBeforeDelete:
                override?.requireApprovalBeforeDelete ?? base.requireApprovalBeforeDelete,
            requireApprovalAboveBudgetCents: this.clampInt(
                override?.requireApprovalAboveBudgetCents,
                base.requireApprovalAboveBudgetCents,
                0,
                1_000_000,
            ),
            dryRunByDefault: override?.dryRunByDefault ?? base.dryRunByDefault,
        };
    }

    private pickGuardrailOverride(
        input: Partial<WorkAgentGuardrails>,
    ): Partial<WorkAgentGuardrails> {
        const keys: Array<keyof WorkAgentGuardrails> = [
            'maxWorksPerRun',
            'maxItemsPerWork',
            'maxBudgetCentsPerRun',
            'requireApprovalBeforeCreate',
            'requireApprovalBeforeDelete',
            'requireApprovalAboveBudgetCents',
            'dryRunByDefault',
        ];
        return keys.reduce<Partial<WorkAgentGuardrails>>((acc, key) => {
            if (input[key] !== undefined) {
                (acc as Record<keyof WorkAgentGuardrails, unknown>)[key] = input[key];
            }
            return acc;
        }, {});
    }

    private clampInt(value: unknown, fallback: number, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, Math.trunc(value)));
    }

    private toPreferencesDto(preference: WorkAgentPreference): WorkAgentPreferencesDto {
        return {
            enabled: preference.enabled,
            autoApproveLowImpact: preference.autoApproveLowImpact,
            dailySuggestionsEnabled: preference.dailySuggestionsEnabled,
            guardrails: preference.guardrails,
        };
    }

    private toGoalDto(goal: WorkAgentGoal): WorkAgentGoalDto {
        return {
            id: goal.id,
            instruction: goal.instruction,
            status: goal.status,
            source: goal.source,
            dryRun: goal.dryRun,
            guardrailsOverride: goal.guardrailsOverride ?? null,
            agentPlanSummary: goal.agentPlanSummary ?? null,
            approvalSummary: goal.approvalSummary ?? null,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
        };
    }

    private toRunDto(run: WorkAgentRun): WorkAgentRunDto {
        return {
            id: run.id,
            goalId: run.goalId,
            status: run.status,
            dryRun: run.dryRun,
            progressPercent: run.progressPercent,
            summary: run.summary,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
            error: run.error ?? null,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
        };
    }

    private toLogDto(log: WorkAgentRunLog): WorkAgentRunLogDto {
        return {
            id: log.id,
            runId: log.runId,
            level: log.level,
            step: log.step,
            message: log.message,
            metadata: log.metadata ?? null,
            createdAt: log.createdAt,
        };
    }
}
