import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    GoalOrchestratorService,
    GoalStatus,
    GoalsService,
    type GoalAdvanceResult,
    type GoalDto,
    type GoalEvaluationEntry,
    type GoalEventDto,
    type GoalMetricSampleDto,
    type GoalSessionDto,
} from '@ever-works/agent/goals';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';
import {
    ApproveGoalDodDto,
    NudgeGoalDto,
    PatchGoalDodCriterionDto,
    ProposeGoalDodDto,
    SetGoalDodDto,
    UpdateGoalLimitsDto,
} from './dto/goal-orchestration.dto';

/**
 * Goals & Metrics — PR-8 (spec FR-9..FR-14). User-owned measurable
 * targets evaluated against `metrics-provider` plugins (PR-7).
 *
 * Endpoints:
 *   GET    /api/me/goals                   list mine
 *   POST   /api/me/goals                   create (status=draft)
 *   GET    /api/me/goals/:id               get one
 *   GET    /api/me/goals/:id/samples       observation history
 *   PATCH  /api/me/goals/:id               partial update (incl. outcome override)
 *   DELETE /api/me/goals/:id               delete (cascades samples + links)
 *   POST   /api/me/goals/:id/activate      (draft|paused|completed) → active
 *   POST   /api/me/goals/:id/pause         active → paused
 *   POST   /api/me/goals/:id/evaluate-now  manual tick (bypasses nextCheckAt,
 *                                          NOT the budget guard)
 *
 * Autonomy layer (`GoalOrchestratorService`) adds the execution loop:
 *   PATCH  /api/me/goals/:id/limits            budgets + routing hints
 *   PUT    /api/me/goals/:id/dod               replace the DoD checklist
 *   POST   /api/me/goals/:id/dod/propose       planner-authored entries
 *   POST   /api/me/goals/:id/dod/approve       approve proposed entries
 *   PATCH  /api/me/goals/:id/dod/:criterionId  tick / untick / waive one
 *   GET    /api/me/goals/:id/events            orchestrator log
 *   GET    /api/me/goals/:id/sessions          iteration tasks + runs
 *   POST   /api/me/goals/:id/advance           run the router now
 *   POST   /api/me/goals/:id/nudge             steer the live session
 *   POST   /api/me/goals/:id/loop/start|pause|resume|restart|cancel
 *   POST   /api/me/goals/:id/archive|unarchive
 *
 * Mission link/unlink lives on the MissionsController
 * (`/api/me/missions/:id/goals`). Same throttling posture as
 * Missions: 30/min writes, 10/min for evaluate-now (it hits an
 * upstream metrics provider). Advance/restart share the 10/min bucket —
 * each one can start a paid agent run.
 */
@ApiTags('goals')
@Controller('api/me/goals')
export class GoalsController {
    constructor(
        private readonly service: GoalsService,
        private readonly orchestrator: GoalOrchestratorService,
        @Optional() private readonly scopeContext?: ScopeContextService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'List my goals' })
    // Why the explicit `@ApiQuery` rows: a bare `@Query('x') x?: string`
    // is emitted as REQUIRED by @nestjs/swagger (this build runs no CLI
    // plugin), and the MCP server turns that into a tool schema that forces
    // every filter. Declaring them optional here is the only fix upstream.
    @ApiQuery({ name: 'status', required: false, description: 'Filter by GoalStatus' })
    @ApiQuery({ name: 'limit', required: false, description: 'Page size' })
    @ApiQuery({ name: 'offset', required: false, description: 'Pagination offset (default 0)' })
    @ApiQuery({
        name: 'archived',
        required: false,
        description: "'true' | 'false' | 'all' (default: not archived)",
    })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('status') status?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('archived') archived?: string,
    ): Promise<GoalDto[]> {
        return this.service.listForUser(
            auth.userId,
            {
                status: this.parseStatus(status),
                limit: this.parseIntParam(limit, 'limit', 1, 101),
                offset: this.parseIntParam(offset, 'offset', 0),
                archived: this.parseArchived(archived),
            },
            this.scopeContext?.getScope(),
        );
    }

    @Post()
    @ApiOperation({
        summary:
            "Create a goal (status=draft; activate to start evaluation). goalKind 'metric' (default) needs metricSource + comparator + targetValue + unit + window; 'delivery' needs dodCriteria instead and carries no metric.",
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateGoalDto,
    ): Promise<GoalDto> {
        return this.service.create(
            auth.userId,
            {
                title: body.title,
                description: body.description ?? null,
                // Omitted = metric; the service refuses anything unknown.
                goalKind: body.goalKind,
                // Metric fields pass through possibly-undefined: the service
                // requires all of them for a metric Goal and refuses every one
                // of them for a delivery Goal.
                metricSource: body.metricSource,
                comparator: body.comparator,
                targetValue: body.targetValue,
                unit: body.unit,
                window: body.window,
                baselineValue: body.baselineValue ?? null,
                deadline: this.parseDeadline(body.deadline),
                checkFrequencyMinutes: body.checkFrequencyMinutes,
                // Judgment layer G1 - additive. Omitted stays undefined, which
                // the service persists as NULL: the single-metric Goal.
                criteria: body.criteria,
                constraints: body.constraints,
                // Required for a delivery Goal, optional seed for a metric one.
                dodCriteria: body.dodCriteria,
            },
            this.scopeContext?.getScope(),
        );
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one goal' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.getForUser(auth.userId, id, this.scopeContext?.getScope());
    }

    @Get(':id/samples')
    @ApiOperation({ summary: 'Observation history (append-only samples, newest first)' })
    @ApiQuery({ name: 'limit', required: false, description: 'Max samples (1..500, default 100)' })
    @HttpCode(HttpStatus.OK)
    async samples(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
    ): Promise<GoalMetricSampleDto[]> {
        return this.service.listSamples(
            auth.userId,
            id,
            this.parseIntParam(limit, 'limit', 1, 500) ?? 100,
            this.scopeContext?.getScope(),
        );
    }

    @Patch(':id')
    @ApiOperation({
        summary:
            'Update goal fields (partial). Setting a non-null `outcome` is the human override (completes the goal); `outcome: null` clears an auto-set outcome.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateGoalDto,
    ): Promise<GoalDto> {
        return this.service.update(
            auth.userId,
            id,
            {
                title: body.title,
                description: body.description,
                metricSource: body.metricSource,
                comparator: body.comparator,
                targetValue: body.targetValue,
                unit: body.unit,
                window: body.window,
                baselineValue: body.baselineValue,
                deadline:
                    body.deadline === undefined ? undefined : this.parseDeadline(body.deadline),
                checkFrequencyMinutes: body.checkFrequencyMinutes,
                outcome: body.outcome,
                criteria: body.criteria,
                constraints: body.constraints,
            },
            this.scopeContext?.getScope(),
        );
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a goal (cascades samples + mission links)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.delete(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post(':id/activate')
    @ApiOperation({
        summary:
            'Activate a goal ((draft|paused|completed) → active). Metric goals require metricSource pluginId + metricId; delivery goals require at least one approved Definition-of-Done criterion. Reactivating a completed goal clears its outcome.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async activate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.activate(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a goal (active → paused)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.pause(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post(':id/evaluate-now')
    @ApiOperation({
        summary:
            'Evaluate immediately (manual tick). Bypasses the nextCheckAt schedule but NOT the plugin budget guard. Metric goals read the provider; delivery goals re-check the Definition of Done and the deadline without any plugin call.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async evaluateNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ entry: GoalEvaluationEntry; goal: GoalDto }> {
        return this.service.evaluateNow(auth.userId, id, this.scopeContext?.getScope());
    }

    // ─── autonomy layer — limits ────────────────────────────────────

    @Patch(':id/limits')
    @ApiOperation({
        summary:
            'Adjust per-Goal budgets and routing hints live. Omitted fields are untouched; `null` CLEARS a ceiling.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async updateLimits(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateGoalLimitsDto,
    ): Promise<GoalDto> {
        // Every field is forwarded explicitly, and `undefined` (leave
        // alone) is preserved as distinct from `null` (clear) — a mapping
        // that collapsed the two would silently make "remove this cap"
        // impossible while the DTO advertised it.
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.updateLimits(
            auth.userId,
            id,
            {
                spendCapCents: body.spendCapCents,
                wallClockLimitHours: body.wallClockLimitHours,
                stuckThresholdIterations: body.stuckThresholdIterations,
                sessionBudgetMinutes: body.sessionBudgetMinutes,
                gracePeriodMinutes: body.gracePeriodMinutes,
                executionTarget: body.executionTarget,
                plannerModelHint: body.plannerModelHint,
                workerModelHint: body.workerModelHint,
                assignedAgentId: body.assignedAgentId,
            },
            this.scopeContext?.getScope(),
        );
    }

    // ─── autonomy layer — Definition of Done ────────────────────────

    @Put(':id/dod')
    @ApiOperation({
        summary: 'Replace the Definition-of-Done checklist. `criteria: null` clears it entirely.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setDod(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetGoalDodDto,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.setDodCriteria(auth.userId, id, body.criteria ?? null);
    }

    @Post(':id/dod/propose')
    @ApiOperation({
        summary:
            'Append planner-authored criteria for operator approval. Proposed criteria never count toward completion.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async proposeDod(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ProposeGoalDodDto,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.proposeDodCriteria(auth.userId, id, body.criteria);
    }

    @Post(':id/dod/approve')
    @ApiOperation({ summary: 'Approve proposed criteria (all, or the named subset)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async approveDod(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ApproveGoalDodDto,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.approveDodCriteria(auth.userId, id, body.criterionIds ?? null);
    }

    @Patch(':id/dod/:criterionId')
    @ApiOperation({ summary: 'Tick, untick or waive one criterion (waivers carry a note)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async patchDodCriterion(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('criterionId') criterionId: string,
        @Body() body: PatchGoalDodCriterionDto,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.patchDodCriterion(auth.userId, id, criterionId, {
            status: body.status,
            text: body.text,
            evidence: body.evidence,
            note: body.note,
        });
    }

    // ─── autonomy layer — orchestrator log + sessions ───────────────

    @Get(':id/events')
    @ApiOperation({ summary: 'Orchestrator log for this Goal (newest first)' })
    @HttpCode(HttpStatus.OK)
    async events(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
    ): Promise<GoalEventDto[]> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.listEvents(
            auth.userId,
            id,
            this.parseIntParam(limit, 'limit', 1, 500) ?? 100,
        );
    }

    @Get(':id/sessions')
    @ApiOperation({ summary: 'Iteration Tasks for this Goal, each with its latest agent run' })
    @HttpCode(HttpStatus.OK)
    async sessions(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalSessionDto[]> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.listSessions(auth.userId, id);
    }

    @Post(':id/spend-rollup')
    @ApiOperation({ summary: 'Recompute spent-to-date from the linked runs and persist it' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async spendRollup(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.rollupSpend(auth.userId, id);
    }

    // ─── autonomy layer — loop control ──────────────────────────────

    @Post(':id/loop/start')
    @ApiOperation({ summary: 'Start (or resume) the execution loop' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async startLoop(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.startLoop(auth.userId, id);
    }

    @Post(':id/loop/resume')
    @ApiOperation({ summary: 'Resume a paused or stuck execution loop' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resumeLoop(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.startLoop(auth.userId, id);
    }

    @Post(':id/loop/pause')
    @ApiOperation({ summary: 'Pause the execution loop (the in-flight session is left to land)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pauseLoop(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.pauseLoop(auth.userId, id);
    }

    @Post(':id/loop/cancel')
    @ApiOperation({ summary: 'Cancel the execution loop and its in-flight session' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async cancelLoop(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.cancelLoop(auth.userId, id);
    }

    @Post(':id/loop/restart')
    @ApiOperation({ summary: 'Cancel the in-flight session and route a fresh iteration' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async restartSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalAdvanceResult> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.restartSession(auth.userId, id);
    }

    @Post(':id/advance')
    @ApiOperation({
        summary:
            'Run the orchestrator now: evaluate DoD + budgets and either dispatch the next iteration or stop the loop.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async advance(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalAdvanceResult> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.advance(auth.userId, id);
    }

    @Post(':id/nudge')
    @ApiOperation({ summary: 'Inject a steering message into the live iteration run' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async nudge(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: NudgeGoalDto,
    ): Promise<{ goal: GoalDto; runId: string; queuedCount?: number }> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.nudge(auth.userId, id, body.message);
    }

    // ─── autonomy layer — archive ───────────────────────────────────

    @Post(':id/archive')
    @ApiOperation({ summary: 'Archive a Goal (hidden from the default catalog, never deleted)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async archive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.archive(auth.userId, id);
    }

    @Post(':id/unarchive')
    @ApiOperation({ summary: 'Restore an archived Goal to the catalog' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async unarchive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        await this.requireScopedGoal(auth.userId, id);
        return this.orchestrator.unarchive(auth.userId, id);
    }

    private async requireScopedGoal(userId: string, goalId: string): Promise<void> {
        await this.service.getForUser(userId, goalId, this.scopeContext?.getScope());
    }

    private parseStatus(value?: string): GoalStatus | undefined {
        if (!value) return undefined;
        if (!Object.values(GoalStatus).includes(value as GoalStatus)) {
            throw new BadRequestException(`Invalid status filter: ${value}`);
        }
        return value as GoalStatus;
    }

    private parseIntParam(
        value: string | undefined,
        name: string,
        min: number,
        max?: number,
    ): number | undefined {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n)) {
            throw new BadRequestException(`${name} must be an integer.`);
        }
        const clamped = Math.max(min, n);
        return max !== undefined ? Math.min(max, clamped) : clamped;
    }

    /**
     * `?archived=` — omitted/`false` hides archived Goals (the default
     * catalog), `true` shows only them, `all` drops the filter. Anything
     * else is a 400 rather than a silent fallback: a typo'd filter that
     * quietly returns the wrong set is worse than an error.
     */
    private parseArchived(value?: string): boolean | 'all' | undefined {
        if (value === undefined || value === '') return undefined;
        if (value === 'all') return 'all';
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
        throw new BadRequestException(`Invalid archived filter: ${value}. Use true, false or all.`);
    }

    private parseDeadline(value: string | null | undefined): Date | null {
        if (value === undefined || value === null || value === '') return null;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) {
            throw new BadRequestException('deadline must be an ISO-8601 date string.');
        }
        return new Date(ms);
    }
}
