import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    InternalServerErrorException,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AgentFileService,
    AGENT_FILE_NAMES,
    AgentRunRepository,
    AgentScheduleDispatcherService,
    AGENT_HEARTBEAT_TRIGGER,
    AgentsService,
    AgentExportService,
    AgentScope,
    SkillBindingRepository,
    type AgentDto,
    type AgentExportEnvelope,
    type AgentFileName,
    type AgentHeartbeatTrigger,
    type AgentImportConflictMode,
    type AgentImportResult,
    type AgentTarget,
    PluginUsageRepository,
} from '@ever-works/agent/agents';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    type AgentTaskExecuteDispatcher,
    TasksService,
} from '@ever-works/agent/tasks-domain';
import {
    ActivityLogService,
    ActivityActionType,
    ActivityStatus,
} from '@ever-works/agent/activity-log';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    AssignTaskToAgentDto,
    CreateAgentDto,
    ListAgentRunsQueryDto,
    ListAgentsQueryDto,
    UpdateAgentDto,
} from './dto/agent.dto';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 3 API surface.
 *
 *   GET    /api/agents              list mine (filterable)
 *   POST   /api/agents              create
 *   GET    /api/agents/:id          get one
 *   PATCH  /api/agents/:id          partial update
 *   DELETE /api/agents/:id          archive (soft-delete) — operator can pass ?hard=true to delete
 *   POST   /api/agents/:id/pause    ACTIVE → PAUSED
 *   POST   /api/agents/:id/resume   PAUSED/ERROR → ACTIVE
 *
 * Runtime endpoints (`/run-now`, `/dry-run`, `/export`, `/import`,
 * `/files/:name`, `/runs`, `/skills`, `/budget`) land in later phases.
 *
 * Rate limits per `agents/plan.md §7.1`:
 *   - POST     /agents         30/min/user
 *   - PATCH    /agents/:id     30/min/user
 *   - DELETE   /agents/:id     30/min/user
 *   - status transitions       30/min/user
 *   - GET routes               default global throttler only
 *
 * Cross-user reads return 404 (architecture/security §9 — no
 * existence leak via 403).
 */
@ApiTags('agents')
@Controller('api/agents')
export class AgentsController {
    constructor(
        private readonly service: AgentsService,
        // Phase 4 — file read/write endpoints.
        private readonly files: AgentFileService,
        // Phase 6a — per-Agent export + import endpoints.
        private readonly exportService: AgentExportService,
        // FU-2 — runtime endpoints (run-now, runs, runs/cancel, skills,
        // budget, assign-task). The dispatchers + repos are reached for
        // directly here rather than going through a thicker service
        // layer because the surface stays read-mostly + tightly scoped.
        private readonly dispatcher: AgentScheduleDispatcherService,
        private readonly agentRuns: AgentRunRepository,
        private readonly skillBindings: SkillBindingRepository,
        private readonly pluginUsage: PluginUsageRepository,
        private readonly tasks: TasksService,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional()
        @Inject(AGENT_HEARTBEAT_TRIGGER)
        private readonly heartbeatTrigger?: AgentHeartbeatTrigger,
        @Optional()
        @Inject(AGENT_TASK_EXECUTE_DISPATCHER)
        private readonly taskExecuteDispatcher?: AgentTaskExecuteDispatcher,
    ) {}

    @Get()
    @ApiOperation({ summary: 'List my Agents (filter by scope/status/target/search)' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListAgentsQueryDto,
    ): Promise<{ data: AgentDto[]; meta: { total: number; limit: number; offset: number } }> {
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        const { rows, total } = await this.service.list(auth.userId, {
            scope: query.scope,
            status: query.status,
            missionId: query.missionId,
            ideaId: query.ideaId,
            workId: query.workId,
            search: query.search,
            limit,
            offset,
        });
        return { data: rows, meta: { total, limit, offset } };
    }

    @Post()
    @ApiOperation({ summary: 'Create a new Agent' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateAgentDto,
    ): Promise<AgentDto> {
        return this.service.create(auth.userId, {
            scope: body.scope,
            missionId: body.missionId ?? null,
            ideaId: body.ideaId ?? null,
            workId: body.workId ?? null,
            name: body.name,
            title: body.title ?? null,
            capabilities: body.capabilities ?? null,
            aiProviderId: body.aiProviderId ?? null,
            modelId: body.modelId ?? null,
            maxSkillContextTokens: body.maxSkillContextTokens,
            heartbeatCadence: body.heartbeatCadence ?? null,
            idleBehavior: body.idleBehavior,
            pauseAfterFailures: body.pauseAfterFailures,
            permissions: body.permissions,
            targets: (body.targets ?? null) as AgentTarget[] | null,
            avatarMode: body.avatarMode,
            avatarIcon: body.avatarIcon ?? null,
            avatarImageUploadId: body.avatarImageUploadId ?? null,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Agent' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        return this.service.getOne(auth.userId, id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update Agent fields (partial)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateAgentDto,
    ): Promise<AgentDto> {
        return this.service.update(auth.userId, id, {
            name: body.name,
            title: body.title,
            capabilities: body.capabilities,
            aiProviderId: body.aiProviderId,
            modelId: body.modelId,
            maxSkillContextTokens: body.maxSkillContextTokens,
            heartbeatCadence: body.heartbeatCadence,
            idleBehavior: body.idleBehavior,
            pauseAfterFailures: body.pauseAfterFailures,
            permissions: body.permissions,
            targets: body.targets as AgentTarget[] | null | undefined,
            avatarMode: body.avatarMode,
            avatarIcon: body.avatarIcon,
            avatarImageUploadId: body.avatarImageUploadId,
        });
    }

    @Delete(':id')
    @ApiOperation({
        summary: 'Archive Agent (soft-delete). Pass ?hard=true to permanently delete + cascade.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('hard') hard?: string,
    ): Promise<{ archived?: true; deleted?: true }> {
        if (hard === 'true') {
            return this.service.deleteHard(auth.userId, id);
        }
        return this.service.archive(auth.userId, id);
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause an active Agent (ACTIVE → PAUSED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        return this.service.pause(auth.userId, id);
    }

    @Post(':id/resume')
    @ApiOperation({ summary: 'Resume a paused/errored Agent (→ ACTIVE)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        return this.service.resume(auth.userId, id);
    }

    // ── Phase 4 — Agent file storage (5 canonical MD files + agent.yml) ─

    @Get(':id/files/:name')
    @ApiOperation({
        summary:
            'Read one Agent definition file (SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml)',
    })
    @HttpCode(HttpStatus.OK)
    async readFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
    ): Promise<{ name: AgentFileName; body: string; hash: string; storage: 'git' | 'db' }> {
        this.assertValidFileName(name);
        return this.files.read(auth.userId, id, name as AgentFileName);
    }

    @Put(':id/files/:name')
    @ApiOperation({
        summary:
            'Replace one Agent definition file body. Optimistic concurrency: pass `expectedHash` to guard against concurrent edits.',
    })
    @HttpCode(HttpStatus.OK)
    // PASS-4 review fix: plan §7.1 documents 60/min for PUT /:id/files/:name
    // ("UI typing autosave" rationale). Tick-42 I11 mis-read the spec and
    // tightened to 30; reverting to match the plan + docs/api/agents.md.
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async writeFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
        @Body() body: { body: string; expectedHash?: string },
    ): Promise<{ newHash: string }> {
        this.assertValidFileName(name);
        if (typeof body?.body !== 'string') {
            throw new BadRequestException('Request body must include a string `body` field.');
        }
        return this.files.write({
            userId: auth.userId,
            agentId: id,
            name: name as AgentFileName,
            body: body.body,
            expectedHash: body.expectedHash,
        });
    }

    private assertValidFileName(name: string): void {
        if (!AGENT_FILE_NAMES.includes(name as AgentFileName)) {
            throw new BadRequestException(
                `Invalid Agent file name "${name}". Allowed: ${AGENT_FILE_NAMES.join(', ')}.`,
            );
        }
    }

    // ── Phase 6a — per-Agent export / import (N5 override) ─────────────

    @Get(':id/export')
    @ApiOperation({
        summary:
            'Export one Agent as a JSON envelope (identity, files, runtime, avatar, skill bindings, budget).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async exportOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentExportEnvelope> {
        return this.exportService.exportOne(auth.userId, id);
    }

    @Post('import')
    @ApiOperation({
        summary:
            'Import an Agent envelope. Conflict mode: skip | overwrite | rename (default rename — appends -2, -3, etc.).',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async importOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: AgentExportEnvelope,
        @Query('onConflict') onConflict?: string,
        @Query('scope') overrideScope?: string,
        @Query('missionId') missionId?: string,
        @Query('ideaId') ideaId?: string,
        @Query('workId') workId?: string,
    ): Promise<AgentImportResult> {
        const mode: AgentImportConflictMode | undefined =
            onConflict === 'skip' || onConflict === 'overwrite' || onConflict === 'rename'
                ? onConflict
                : undefined;
        const scope: AgentScope | undefined =
            overrideScope && Object.values(AgentScope).includes(overrideScope as AgentScope)
                ? (overrideScope as AgentScope)
                : undefined;
        return this.exportService.importOne(auth.userId, body, {
            onConflict: mode,
            overrideScope: scope,
            missionId: missionId ?? null,
            ideaId: ideaId ?? null,
            workId: workId ?? null,
        });
    }

    // ── FU-2 — runtime endpoints (run-now / runs / cancel / skills / budget / assign-task) ─

    @Post(':id/run-now')
    @ApiOperation({
        summary:
            'Manually trigger an agent-heartbeat run NOW, bypassing the heartbeatCadence schedule.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async runNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ outcome: string; runId?: string; reason?: string }> {
        // Cross-user 404 via service-level access check.
        await this.service.getOne(auth.userId, id);
        if (!this.heartbeatTrigger) {
            throw new InternalServerErrorException(
                'AGENT_HEARTBEAT_TRIGGER not bound — run-now is unavailable until the Trigger.dev adapter wires up.',
            );
        }
        const result = await this.dispatcher.dispatchOne(this.heartbeatTrigger, id);
        if (result.outcome === 'failed') {
            throw new InternalServerErrorException(result.message);
        }
        if (result.outcome === 'skipped') {
            if (result.reason === 'agent-missing') {
                throw new NotFoundException(`Agent ${id} not found.`);
            }
            if (result.reason === 'inactive') {
                throw new ConflictException(
                    'Agent is not in an ACTIVE state — pause / resume it first.',
                );
            }
            // already-claimed
            return { outcome: 'skipped', reason: result.reason };
        }
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_RUN_TRIGGERED,
            details: { runId: result.runId, source: 'run-now' },
        });
        return { outcome: 'dispatched', runId: result.runId };
    }

    @Get(':id/runs')
    @ApiOperation({ summary: 'Paginated AgentRun history for this Agent.' })
    @HttpCode(HttpStatus.OK)
    async listRuns(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListAgentRunsQueryDto,
    ): Promise<{
        data: Array<{
            id: string;
            status: string;
            triggerKind: string;
            startedAt: string | null;
            finishedAt: string | null;
            durationMs: number | null;
            summary: string | null;
            errorMessage: string | null;
            taskId: string | null;
            createdAt: string;
        }>;
        meta: { total: number; limit: number; offset: number };
    }> {
        await this.service.getOne(auth.userId, id);
        const limit = query.limit ?? 25;
        const offset = query.offset ?? 0;
        const [rows, total] = await Promise.all([
            this.agentRuns.findByAgent(id, limit, offset),
            this.agentRuns.countByAgent(id),
        ]);
        return {
            data: rows.map((r) => ({
                id: r.id,
                status: r.status,
                triggerKind: r.triggerKind,
                startedAt: r.startedAt?.toISOString() ?? null,
                finishedAt: r.finishedAt?.toISOString() ?? null,
                durationMs: r.durationMs ?? null,
                summary: r.summary ?? null,
                errorMessage: r.errorMessage ?? null,
                taskId: r.taskId ?? null,
                createdAt: r.createdAt.toISOString(),
            })),
            meta: { total, limit, offset },
        };
    }

    @Post(':id/runs/:runId/cancel')
    @ApiOperation({
        summary: 'Cancel a queued / running AgentRun. No-op for already-terminal runs.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async cancelRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{ cancelled: boolean; previousStatus?: string }> {
        await this.service.getOne(auth.userId, id);
        const result = await this.agentRuns.cancel(runId, auth.userId);
        if (!result.found) {
            throw new NotFoundException(`AgentRun ${runId} not found.`);
        }
        const wasOpen = result.previousStatus === 'queued' || result.previousStatus === 'running';
        if (wasOpen) {
            void this.tryLog({
                userId: auth.userId,
                agentId: id,
                actionType: ActivityActionType.AGENT_RUN_CANCELLED,
                details: { runId, previousStatus: result.previousStatus },
            });
        }
        return { cancelled: wasOpen, previousStatus: result.previousStatus };
    }

    @Get(':id/skills')
    @ApiOperation({
        summary:
            'Active Skill bindings for this Agent (Skill + binding priority + targetType, lowest priority first).',
    })
    @HttpCode(HttpStatus.OK)
    async listSkills(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{
        data: Array<{
            bindingId: string;
            priority: number;
            targetType: string;
            skill: { id: string; slug: string; title: string; version: string };
        }>;
    }> {
        const agent = await this.service.getOne(auth.userId, id);
        const rows = await this.skillBindings.resolveActive({
            userId: auth.userId,
            agentId: id,
            workId: agent.workId ?? undefined,
            missionId: agent.missionId ?? undefined,
            ideaId: agent.ideaId ?? undefined,
            forAgentRun: true,
        });
        return {
            data: rows.map(({ binding, skill }) => ({
                bindingId: binding.id,
                priority: binding.priority,
                targetType: binding.targetType,
                skill: {
                    id: skill.id,
                    slug: skill.slug,
                    title: skill.title,
                    version: skill.version,
                },
            })),
        };
    }

    @Get(':id/budget')
    @ApiOperation({
        summary:
            'Current-period spend rollup for this Agent (from PluginUsageEvent rows attributed via ownerType=agent).',
    })
    @HttpCode(HttpStatus.OK)
    async getBudget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{
        currentSpendCents: number;
        capCents: number | null;
        periodStart: string;
        periodEnd: string;
        currency: string;
    }> {
        await this.service.getOne(auth.userId, id);
        // Default window — caller-tunable in a future revision; this
        // covers the rolling-30-day view shown in the budgets tab.
        const now = new Date();
        const periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const periodEnd = now;
        const currency = 'USD';
        const currentSpendCents = await this.pluginUsage.getTotalSpendCentsForOwner(
            'agent',
            id,
            periodStart,
            periodEnd,
            undefined,
            currency,
        );
        return {
            currentSpendCents,
            capCents: null,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            currency,
        };
    }

    @Post(':id/assign-task')
    @ApiOperation({
        summary:
            'Assign a Task to this Agent — pre-creates an AgentRun for the (taskId, agentId) pair and enqueues `agent-task-execute`.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async assignTask(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AssignTaskToAgentDto,
    ): Promise<{ runId: string }> {
        await this.service.getOne(auth.userId, id);
        // Cross-user 404 on the Task too — surfaces via TasksService.
        const task = await this.tasks.getOne(auth.userId, body.taskId);
        if (!task) {
            throw new NotFoundException(`Task ${body.taskId} not found.`);
        }
        if (!this.taskExecuteDispatcher) {
            throw new InternalServerErrorException(
                'AGENT_TASK_EXECUTE_DISPATCHER not bound — assign-task is unavailable until the Trigger.dev adapter wires up.',
            );
        }
        // Dedup: re-use an in-flight run for the same (taskId, agentId) pair
        // rather than spawning a parallel one.
        const inflight = await this.agentRuns.findInFlightForTaskAgent(body.taskId, id);
        if (inflight) {
            return { runId: inflight.id };
        }
        const run = await this.agentRuns.createQueued({
            agentId: id,
            userId: auth.userId,
            triggerKind: 'task',
            taskId: body.taskId,
        });
        try {
            await this.taskExecuteDispatcher.enqueue({
                agentId: id,
                userId: auth.userId,
                taskId: body.taskId,
                dedupKey: `${body.taskId}:${id}:assigned:${run.id}`,
            });
        } catch (err) {
            // FU-2 review fix (codex P1): without this rollback, the
            // queued AgentRun row stays forever and
            // `findInFlightForTaskAgent` keeps short-circuiting future
            // assign-task calls (because the queued row passes its
            // "in flight" filter). Mark it failed so retries can
            // re-dispatch cleanly.
            const message = err instanceof Error ? err.message : String(err);
            await this.agentRuns
                .markFailed(run.id, `enqueue-failed: ${message}`)
                .catch(() => undefined);
            throw new InternalServerErrorException(`assign-task enqueue failed: ${message}`);
        }
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_TASK_ASSIGNED,
            details: { runId: run.id, taskId: body.taskId },
        });
        return { runId: run.id };
    }

    private async tryLog(args: {
        userId: string;
        agentId: string;
        actionType: ActivityActionType;
        details?: Record<string, unknown>;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: args.userId,
                action: args.actionType,
                actionType: args.actionType,
                status: ActivityStatus.COMPLETED,
                summary: `agent ${args.agentId} — ${args.actionType}`,
                details: {
                    ...(args.details ?? {}),
                    resourceType: 'agent',
                    resourceId: args.agentId,
                },
            });
        } catch {
            // best-effort — log failure should never break the request.
        }
    }
}
