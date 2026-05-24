import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    WorkAgentGoal,
    WorkAgentGoalSource,
    WorkAgentGoalStatus,
} from '../entities/work-agent-goal.entity';
import { WorkAgentGuardrails, WorkAgentPreference } from '../entities/work-agent-preference.entity';
import { WorkAgentRun, WorkAgentRunStatus } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog, WorkAgentRunLogLevel } from '../entities/work-agent-run-log.entity';
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

        // Tri-state semantics for the 4 promoted-constant columns
        // (Phase 1 PR D): `undefined` in input means "leave existing
        // value untouched" (PATCH-like); `null` means "reset to
        // platform-hardcoded default" (NULL on the DB column).
        // `nullable3rd` lets us distinguish those two cases instead of
        // collapsing them via `??`.
        const nullable3rd = <T>(
            inputValue: T | null | undefined,
            existing: T | null | undefined,
        ): T | null | undefined => (inputValue === undefined ? (existing ?? null) : inputValue);

        const saved = await this.preferences.save({
            ...preference,
            enabled: input.enabled ?? preference.enabled,
            autoApproveLowImpact: input.autoApproveLowImpact ?? preference.autoApproveLowImpact,
            dailySuggestionsEnabled:
                input.dailySuggestionsEnabled ?? preference.dailySuggestionsEnabled,
            guardrails,
            // 4 promoted constants — nullable on the DB side, tri-state
            // input handling per nullable3rd above.
            autoGenerateCadence: nullable3rd(
                input.autoGenerateCadence,
                preference.autoGenerateCadence,
            ),
            autoGenerateBatchSize: nullable3rd(
                input.autoGenerateBatchSize,
                preference.autoGenerateBatchSize,
            ),
            autoBuildThrottlePerDay: nullable3rd(
                input.autoBuildThrottlePerDay,
                preference.autoBuildThrottlePerDay,
            ),
            missionDefaultOutstandingCap: nullable3rd(
                input.missionDefaultOutstandingCap,
                preference.missionDefaultOutstandingCap,
            ),
            // Auto-retry policy — NOT NULL on the DB side, simple `??` works.
            maxAutoRetries: input.maxAutoRetries ?? preference.maxAutoRetries,
            backoffSeconds: input.backoffSeconds ?? preference.backoffSeconds,
            exponentialBackoffFactor:
                input.exponentialBackoffFactor ?? preference.exponentialBackoffFactor,
            // Account-wide budget — cap is nullable; allowOverage is NOT NULL.
            accountWideMonthlyCapCents: nullable3rd(
                input.accountWideMonthlyCapCents,
                preference.accountWideMonthlyCapCents,
            ),
            accountWideAllowOverage:
                input.accountWideAllowOverage ?? preference.accountWideAllowOverage,
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

            const effectiveGuardrails = this.mergeGuardrails(
                preference.guardrails,
                guardrailsOverride,
            );
            const agentPlanSummary = this.buildInitialPlanSummary(input.instruction, dryRun);
            const approvalSummary = dryRun
                ? 'Dry-run plan prepared. Review before enabling live execution.'
                : 'Live execution requires approval before any Work is created.';

            const savedGoal = await goalRepo.save(
                goalRepo.create({
                    userId,
                    instruction: input.instruction.trim(),
                    status: WorkAgentGoalStatus.WAITING_FOR_APPROVAL,
                    source: WorkAgentGoalSource.USER,
                    dryRun,
                    guardrailsOverride:
                        Object.keys(guardrailsOverride).length > 0 ? guardrailsOverride : null,
                    agentPlanSummary,
                    approvalSummary,
                    ideaId: input.ideaId ?? null,
                }),
            );

            const savedRun = await runRepo.save(
                runRepo.create({
                    userId,
                    goalId: savedGoal.id,
                    status: WorkAgentRunStatus.WAITING_FOR_APPROVAL,
                    dryRun,
                    progressPercent: 10,
                    summary: {
                        worksPlanned: Math.min(1, effectiveGuardrails.maxWorksPerRun),
                        worksCreated: 0,
                        itemsPlanned: effectiveGuardrails.maxItemsPerWork,
                        itemsCreated: 0,
                        approvalsRequired: 1,
                    },
                }),
            );

            await logRepo.save([
                logRepo.create({
                    userId,
                    runId: savedRun.id,
                    level: WorkAgentRunLogLevel.INFO,
                    step: 'plan-prepared',
                    message: 'Goal converted into an approval-ready agent plan.',
                    metadata: {
                        dryRun,
                        guardrails: effectiveGuardrails,
                    },
                }),
                logRepo.create({
                    userId,
                    runId: savedRun.id,
                    level: WorkAgentRunLogLevel.INFO,
                    step: 'approval-required',
                    message: approvalSummary,
                }),
            ]);

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
                    // Phase 1 PR D — explicit defaults match the DB
                    // column defaults from migrations 0.4-0.6. The DB
                    // would set these on INSERT anyway; setting them
                    // here too keeps the in-memory entity shape
                    // (visible in tests and in the API layer before
                    // the row is reloaded) consistent with the DB row.
                    autoGenerateCadence: null,
                    autoGenerateBatchSize: null,
                    autoBuildThrottlePerDay: null,
                    missionDefaultOutstandingCap: null,
                    maxAutoRetries: 2,
                    backoffSeconds: 60,
                    exponentialBackoffFactor: 2.0,
                    accountWideMonthlyCapCents: null,
                    accountWideAllowOverage: true,
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

    private buildInitialPlanSummary(instruction: string, dryRun: boolean): string {
        const mode = dryRun ? 'dry-run' : 'live';
        return `Prepared a ${mode} Work-agent plan for: ${instruction.trim()}`;
    }

    private toPreferencesDto(preference: WorkAgentPreference): WorkAgentPreferencesDto {
        return {
            enabled: preference.enabled,
            autoApproveLowImpact: preference.autoApproveLowImpact,
            dailySuggestionsEnabled: preference.dailySuggestionsEnabled,
            guardrails: preference.guardrails,
            // Phase 1 PR D — surface the 4 promoted constants + 3
            // auto-retry knobs + 2 account-wide budget knobs through
            // the API. `?? null` normalizes `undefined` (TypeORM may
            // return undefined for never-set nullable columns) to
            // `null` so the JSON boundary is consistent.
            autoGenerateCadence: preference.autoGenerateCadence ?? null,
            autoGenerateBatchSize: preference.autoGenerateBatchSize ?? null,
            autoBuildThrottlePerDay: preference.autoBuildThrottlePerDay ?? null,
            missionDefaultOutstandingCap: preference.missionDefaultOutstandingCap ?? null,
            maxAutoRetries: preference.maxAutoRetries,
            backoffSeconds: preference.backoffSeconds,
            exponentialBackoffFactor: preference.exponentialBackoffFactor,
            accountWideMonthlyCapCents: preference.accountWideMonthlyCapCents ?? null,
            accountWideAllowOverage: preference.accountWideAllowOverage,
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
