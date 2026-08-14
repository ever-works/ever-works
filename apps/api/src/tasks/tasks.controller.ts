import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    TasksService,
    TaskChatService,
    TaskReviewRejectionService,
    TaskStatus,
    TaskPriority,
    RUN_BATCH_MAX_TASKS,
    TaskPrStatusService,
    type TaskActorType,
    type ListTasksFilter,
} from '@ever-works/agent/tasks-domain';
// Tasks upgrades — the per-Task activity feed reads the activity rows the
// task-domain writers stamp with details.resourceType='task'.
import { ActivityLogService } from '@ever-works/agent/activity-log';
// Judgment layer G3 - the Task-detail escalation feed. Provided +
// exported by AgentsModule, which this module already imports.
import { AgentEscalationService } from '@ever-works/agent/agents';
import { DEFAULT_DIFF_MAX_BYTES, DEFAULT_DIFF_MAX_FILES } from '@ever-works/plugin';
import { PluginUsageRepository } from '@ever-works/agent/database';
// Review-fix I5 (second-pass NEW-1 corrected): populate the postChat
// `lookups.ownedAgentSlugs` map so the mention parser can resolve
// `@<slug>` tokens to real Agent ids; resolved agent mentions then
// drive the chat-dispatch fan-out (TaskChatService:136-168). The
// repository class lives under `@ever-works/agent/database` (the
// agents barrel re-exports services + module only).
import { AgentRepository } from '@ever-works/agent/database';
import { TaskWorkspaceService } from '@ever-works/agent/tasks-domain';
// Re-litigation guard (memory upgrades M6) — provided + exported by
// `KnowledgeBaseModule`, which the api-side TasksModule imports.
import { DecisionConflictService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    AddApproverDto,
    AddAssigneeDto,
    AddAttachmentDto,
    AddBlockerDto,
    AddRelationDto,
    AddReviewerDto,
    CreateTaskDto,
    RejectTaskDto,
    ResolveEscalationDto,
    PostTaskChatDto,
    RunTaskDto,
    RunTasksBatchDto,
    ScheduleTaskDto,
    SetTaskRecurringDto,
    TransitionTaskDto,
    UpdateTaskDto,
} from './tasks.dto';

/**
 * Tasks feature — Phase 12.3.
 *
 *   GET    /api/tasks                          list with filters
 *   POST   /api/tasks                          create
 *   GET    /api/tasks/:id                      get one
 *   PATCH  /api/tasks/:id                      partial update
 *   DELETE /api/tasks/:id                      delete (cascade-DB)
 *   POST   /api/tasks/:id/transition           explicit state-machine move
 *   POST   /api/tasks/:id/assignees            add assignee
 *   DELETE /api/tasks/:id/assignees/:id        remove
 *   POST   /api/tasks/:id/reviewers            add reviewer
 *   POST   /api/tasks/:id/reject               record reviewer rejection (M9)
 *   GET    /api/tasks/:id/escalations          escalation feed (G3)
 *   POST   /api/tasks/:id/escalations/:eid/resolve  close one (G3)
 *   POST   /api/tasks/:id/approvers            add approver
 *   POST   /api/tasks/:id/blocks               add blocker
 *   DELETE /api/tasks/:id/blocks/:blockId      remove
 *   POST   /api/tasks/:id/relations            add related/duplicates/follow-up
 *
 * Chat + attachments + spend endpoints land in Phase 13.
 *
 * Cross-user reads return 404 (no existence leak via 403).
 */
/**
 * PR insights (kanban M6) — the platform ceiling on one diff response.
 * A caller may ask for LESS (the sheet does, for its first paint); asking
 * for more is silently clamped, here and again inside `capDiffFiles`.
 */
const MAX_DIFF_FILES = DEFAULT_DIFF_MAX_FILES;
const MAX_DIFF_BYTES = DEFAULT_DIFF_MAX_BYTES;

/**
 * Parse a query-string number, clamp it into `1..max`, and fall back to
 * `max` for anything absent or unparseable. Deliberately total: a junk
 * `?maxFiles=abc` gets the platform default, never a 500 or an unbounded
 * read.
 */
function clampNumeric(raw: string | undefined, max: number): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return max;
    return Math.min(Math.floor(parsed), max);
}

@ApiTags('tasks')
@Controller('api/tasks')
export class TasksController {
    constructor(
        private readonly service: TasksService,
        private readonly chat: TaskChatService,
        private readonly pluginUsage: PluginUsageRepository,
        // Review-fix I5: AgentRepository for mention-lookup population.
        private readonly agents: AgentRepository,
        // Wave 2 M5/M6 — workspace conflict-resolve + discard actions.
        private readonly taskWorkspace: TaskWorkspaceService,
        // Memory upgrades M6 — deterministic re-litigation guard.
        private readonly decisionConflicts: DecisionConflictService,
        // Orchestration M9 — durable reviewer rejections. Appended last
        // so no existing positional construction changes.
        private readonly rejections: TaskReviewRejectionService,
        // Judgment layer G3 — escalation feed for the Task detail.
        private readonly escalations: AgentEscalationService,
        // Kanban run cockpit (plan 04 M5/M6) — PR status pill + diff sheet.
        private readonly prInsights: TaskPrStatusService,
        // Tasks upgrades — per-Task activity feed. Appended LAST +
        // @Optional() so every existing positional construction in the
        // specs keeps compiling; the endpoint degrades to an empty feed
        // when the module graph lacks it.
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    /**
     * Review-fix I5: build the `ownedAgentSlugs` map used by
     * `TaskChatService.parseMentions`. We pull a generous page of the
     * user's owned Agents (the platform's Agent count per user is
     * bounded to ~hundreds in v1; this is cheap). The map is rebuilt
     * per post — Agent slugs change rarely enough that caching is
     * unnecessary for v1.
     */
    private async buildMentionLookups(userId: string) {
        const ownedAgentSlugs = new Map<string, string>();
        try {
            const { rows } = await this.agents.findByUserIdScoped(userId, { limit: 500 });
            for (const a of rows) {
                if (a?.slug && a?.id) ownedAgentSlugs.set(a.slug, a.id);
            }
        } catch {
            // Best-effort. A failure here just means @<slug> mentions
            // are stripped (same as v1 default) — never propagated.
        }
        return { ownedAgentSlugs };
    }

    @Get()
    @ApiOperation({ summary: 'List my Tasks (filter by status/priority/scope/label/search).' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('status') status?: string,
        @Query('priority') priority?: string,
        @Query('missionId', new ParseUUIDPipe({ optional: true })) missionId?: string,
        @Query('ideaId', new ParseUUIDPipe({ optional: true })) ideaId?: string,
        @Query('workId', new ParseUUIDPipe({ optional: true })) workId?: string,
        @Query('teamId', new ParseUUIDPipe({ optional: true })) teamId?: string,
        @Query('agentId', new ParseUUIDPipe({ optional: true })) agentId?: string,
        @Query('goalId', new ParseUUIDPipe({ optional: true })) goalId?: string,
        @Query('parentTaskId', new ParseUUIDPipe({ optional: true })) parentTaskId?: string,
        @Query('label') label?: string,
        @Query('search') search?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        // Kanban run cockpit (Wave 2 M2) — opt-in latest-run embed. The
        // batch is keyed on the owner-scoped rows' `latestRunId` pointers
        // server-side; this flag only toggles the embed, it carries no ids.
        @Query('includeRun') includeRun?: string,
    ) {
        const filter: ListTasksFilter = {
            status: this.parseStatusList(status),
            priority: this.parsePriorityList(priority),
            missionId,
            ideaId,
            workId,
            teamId,
            agentId,
            goalId,
            parentTaskId,
            label,
            search,
            limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
            offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
        };
        const { rows, total } = await this.service.list(auth.userId, filter, {
            includeRun: includeRun === 'true',
        });
        return { data: rows, meta: { total, limit: filter.limit, offset: filter.offset } };
    }

    @Post()
    @ApiOperation({ summary: 'Create a Task.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateTaskDto) {
        if (!body?.title) throw new BadRequestException('title is required.');
        return this.service.create(auth.userId, {
            title: body.title,
            description: body.description ?? null,
            status: body.status,
            priority: body.priority,
            labels: body.labels ?? null,
            isolationMode: body.isolationMode ?? null,
            missionId: body.missionId ?? null,
            ideaId: body.ideaId ?? null,
            workId: body.workId ?? null,
            teamId: body.teamId ?? null,
            agentId: body.agentId ?? null,
            goalId: body.goalId ?? null,
            parentTaskId: body.parentTaskId ?? null,
            createdByType: 'user',
            createdById: auth.userId,
            requireAllApprovers: body.requireAllApprovers,
            acceptanceChecks: body.acceptanceChecks ?? null,
            maxGateAttempts: body.maxGateAttempts ?? null,
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        });
    }

    // Declared BEFORE every `:id` route: `run-batch` is a single path
    // segment, so a future `@Post(':id')` would otherwise shadow it.
    @Post('run-batch')
    @ApiOperation({
        summary: `Run up to ${RUN_BATCH_MAX_TASKS} Tasks in one call. Per-item results — one Task failing (no agent, run already in flight) never fails the others.`,
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async runBatch(@CurrentUser() auth: AuthenticatedUser, @Body() body: RunTasksBatchDto) {
        if (!Array.isArray(body?.items)) {
            throw new BadRequestException('items must be an array.');
        }
        return this.service.runTasksBatch(
            auth.userId,
            body.items.map((item) => ({ taskId: item.taskId, agentId: item.agentId ?? null })),
        );
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Task.' })
    @HttpCode(HttpStatus.OK)
    async getOne(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.getOne(auth.userId, id);
    }

    @Get(':id/decision-conflicts')
    @ApiOperation({
        summary:
            'Re-litigation guard — settled decisions this Task appears to re-open (advisory, never blocking).',
        description:
            "Deterministic term-overlap check (`term-overlap/v1`, no LLM) of the Task's title + description against the `class=decision, status=accepted` documents in the Task's Work Knowledge Base. Owner-scoped: a Task the caller does not own 404s, and every candidate read goes through the KB service's own view gate. Returns `{ conflicts, scanned, heuristic }`; an empty `conflicts` array is the normal case.",
    })
    @HttpCode(HttpStatus.OK)
    async decisionConflictsForTask(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        // Owner scope + existence: `getOne` throws NotFound for a Task
        // the caller doesn't own (no 403 existence leak).
        const task = await this.service.getOne(auth.userId, id);
        return this.decisionConflicts.checkIntent({
            workId: task.workId ?? null,
            userId: auth.userId,
            title: task.title,
            description: task.description ?? null,
        });
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update Task fields.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateTaskDto,
    ) {
        return this.service.update(auth.userId, id, body);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a Task (cascades to side rows).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.remove(auth.userId, id);
    }

    @Post(':id/recurring')
    @ApiOperation({
        summary:
            'Make this Task recurring (or update its cadence). Body: exactly one of {recurrenceRule (RFC 5545 RRULE)} or {recurrenceCron (5-field cron)}, plus recurrenceTimezone?, recurrenceEndsAt?, recurrenceMaxOccurrences?.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setRecurring(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetTaskRecurringDto,
    ) {
        if (!body?.recurrenceRule && !body?.recurrenceCron) {
            throw new BadRequestException('recurrenceRule or recurrenceCron is required.');
        }
        return this.service.setRecurring(auth.userId, id, {
            recurrenceRule: body.recurrenceRule ?? null,
            recurrenceCron: body.recurrenceCron ?? null,
            recurrenceTimezone: body.recurrenceTimezone,
            recurrenceEndsAt: body.recurrenceEndsAt ? new Date(body.recurrenceEndsAt) : null,
            recurrenceMaxOccurrences: body.recurrenceMaxOccurrences ?? null,
        });
    }

    // ── Schedule mode "Scheduled" (one-shot) ──────────────────────

    @Post(':id/schedule')
    @ApiOperation({
        summary:
            'Schedule this Task to run once at a future instant. Re-posting moves the slot. Body: {runAt: ISO datetime}.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async schedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ScheduleTaskDto,
    ) {
        if (!body?.runAt) throw new BadRequestException('runAt is required.');
        return this.service.scheduleTask(auth.userId, id, new Date(body.runAt));
    }

    @Delete(':id/schedule')
    @ApiOperation({ summary: 'Remove the one-shot schedule (back to Run Once).' })
    @HttpCode(HttpStatus.OK)
    async unschedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.unscheduleTask(auth.userId, id);
    }

    // ── Tasks upgrades — per-Task activity feed ───────────────────

    @Get(':id/activity')
    @ApiOperation({
        summary:
            "Activity rows for this Task (created / updated / transitioned / run dispatches), newest first. Owner-scoped: a Task the caller does not own 404s.",
    })
    @HttpCode(HttpStatus.OK)
    async listActivity(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        // 404-no-leak gate before any activity row is read.
        await this.service.getOne(auth.userId, id);
        if (!this.activityLog) {
            return { data: [], meta: { total: 0 } };
        }
        const { activities, total } = await this.activityLog.findResourceEvents({
            userId: auth.userId,
            resourceType: 'task',
            resourceId: id,
            limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 25)) : 25,
            offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
        });
        return { data: activities, meta: { total } };
    }

    @Delete(':id/recurring')
    @ApiOperation({
        summary: 'Stop recurrence on a template. Existing spawned instances are kept.',
    })
    @HttpCode(HttpStatus.OK)
    async clearRecurring(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.clearRecurring(auth.userId, id);
    }

    @Post(':id/transition')
    @ApiOperation({ summary: 'State-machine transition.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async transition(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: TransitionTaskDto,
    ) {
        if (!Object.values(TaskStatus).includes(body?.to)) {
            throw new BadRequestException(`Invalid target status: ${body?.to}`);
        }
        return this.service.transition(auth.userId, id, body.to, { force: body.force === true });
    }

    // ── Board dispatch (kanban M3 / M4) ───────────────────────────

    @Get(':id/run-candidates')
    @ApiOperation({
        summary:
            'Agents that can run this Task (assignees, then its own agent, then the Work default) — the board agent picker.',
    })
    @HttpCode(HttpStatus.OK)
    async runCandidates(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return { data: await this.service.listRunCandidates(auth.userId, id) };
    }

    @Post(':id/run')
    @ApiOperation({
        summary:
            'Run this Task now. Resolves the Agent (explicit agentId → assigned Agent → the Work default), then dispatches through the same gated path a status transition uses. 409 RUN_ALREADY_IN_FLIGHT when a run for that (task, agent) is still queued/running.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async run(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: RunTaskDto,
    ) {
        return this.service.runTask(auth.userId, id, { agentId: body?.agentId ?? null });
    }

    // ── PR insights (kanban M5 / M6) ──────────────────────────────

    @Get(':id/pr-status')
    @ApiOperation({
        summary:
            "Pull-request state + CI verdict for this Task's branch — the board's review pill.",
        description:
            'Serves the cached `prState`/`ciState`/`checks` written by the `task-pr-status-sync` cron, refreshing from the git provider only when the cache is older than the 60s floor (single-flight per Task, so a board full of review cards makes one call per PR). Owner-scoped: a Task the caller does not own 404s. A merged or closed PR is terminal and is never re-read. `409` when the connected git provider has no PR-status capability.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async prStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('refresh') refresh?: string,
    ) {
        return this.prInsights.getForTask(auth.userId, id, { refresh: refresh === 'true' });
    }

    @Get(':id/diff')
    @ApiOperation({
        summary: "Capped diff for this Task's pull request (or its pushed branch).",
        description: `Proxies the Work's git provider through the facade — the browser never talks to a provider API. Hard caps: ${MAX_DIFF_FILES} files and ${Math.floor(
            MAX_DIFF_BYTES / 1024,
        )} KiB of patch text, both clamped again inside the provider contract; \`truncated\` tells the client to link out for the rest. Owner-scoped (404 for a Task the caller does not own), 404 when the Task has no branch or PR, 409 when the git provider is not connected or cannot answer.`,
    })
    @HttpCode(HttpStatus.OK)
    // Repo content egress: this response carries the user's own source.
    // It must never enter a shared or browser cache — plan 04 §7.2.
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async diff(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('maxFiles') maxFiles?: string,
        @Query('maxBytes') maxBytes?: string,
    ) {
        return this.prInsights.getDiffForTask(auth.userId, id, {
            maxFiles: clampNumeric(maxFiles, MAX_DIFF_FILES),
            maxBytes: clampNumeric(maxBytes, MAX_DIFF_BYTES),
        });
    }

    @Post(':id/resolve-conflicts')
    @ApiOperation({ summary: 'Re-run the Task agent to resolve a workspace merge conflict.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async resolveConflicts(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        try {
            return await this.taskWorkspace.resolveConflicts(auth.userId, id);
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message === 'TASK_NOT_FOUND') throw new NotFoundException('Task not found');
            if (message === 'TASK_NOT_IN_CONFLICT') {
                throw new ConflictException('Task branch is not in a conflict state');
            }
            throw error;
        }
    }

    @Post(':id/discard-branch')
    @ApiOperation({
        summary: 'Delete the Task branch and reset its workspace identity (irreversible).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async discardBranch(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        try {
            await this.taskWorkspace.discardBranch(auth.userId, id);
            return { ok: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message === 'TASK_NOT_FOUND') throw new NotFoundException('Task not found');
            throw error;
        }
    }

    @Post(':id/assignees')
    @ApiOperation({ summary: 'Add an assignee.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async addAssignee(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddAssigneeDto,
    ) {
        this.assertActorType(body.assigneeType);
        return this.service.addAssignee(auth.userId, id, body.assigneeType, body.assigneeId);
    }

    @Delete(':id/assignees/:assigneeId')
    @ApiOperation({ summary: 'Remove an assignee.' })
    @HttpCode(HttpStatus.OK)
    async removeAssignee(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('assigneeId', ParseUUIDPipe) assigneeId: string,
    ) {
        return this.service.removeAssignee(auth.userId, id, assigneeId);
    }

    @Post(':id/reviewers')
    @ApiOperation({ summary: 'Add a reviewer.' })
    @HttpCode(HttpStatus.CREATED)
    async addReviewer(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddReviewerDto,
    ) {
        this.assertActorType(body.reviewerType);
        return this.service.addReviewer(auth.userId, id, body.reviewerType, body.reviewerId);
    }

    /**
     * Orchestration M9 — record a reviewer REJECTION with its feedback.
     *
     * This is the human half of the rejection loop: the text lands in
     * `task_review_rejections` and the NEXT resumed run for this Task is
     * seeded with it, ahead of whatever message the resumer types. It
     * also finally writes `task_reviewers.reviewState` — the advisory
     * signal that existed with no writer — so the two never disagree.
     *
     * 201 rather than 200: this creates a durable record.
     */
    @Post(':id/reject')
    @ApiOperation({
        summary:
            'Record a reviewer rejection with feedback. The next resumed run for this Task receives it as its first input.',
    })
    @HttpCode(HttpStatus.CREATED)
    async rejectTask(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: RejectTaskDto,
    ) {
        const row = await this.rejections.rejectTask(auth.userId, id, body.feedback, {
            runId: body.runId ?? null,
        });
        return {
            id: row.id,
            taskId: row.taskId,
            source: row.source,
            createdAt: row.createdAt,
        };
    }

    /**
     * Judgment layer G3 — everything an agent gave up on for this Task.
     *
     * Ownership is enforced by loading the Task first (404-no-leak); the
     * escalations that follow are Task-scoped, which is what the Task
     * detail renders.
     */
    @Get(':id/escalations')
    @ApiOperation({
        summary:
            'Escalations recorded for this Task (gate exhausted / guardrail refusal / budget stop / merge refused / parked).',
    })
    @HttpCode(HttpStatus.OK)
    async listEscalations(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        // 404-no-leak gate: getOne is owner-scoped and throws for a
        // foreign or missing Task before any escalation row is read.
        await this.service.getOne(auth.userId, id);
        return { data: await this.escalations.listForTask(id) };
    }

    /** Judgment layer G3 — a human answered; close the card. */
    @Post(':id/escalations/:escalationId/resolve')
    @ApiOperation({ summary: 'Resolve one escalation with an optional decision note.' })
    @HttpCode(HttpStatus.OK)
    async resolveEscalation(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('escalationId', ParseUUIDPipe) escalationId: string,
        @Body() body: ResolveEscalationDto,
    ) {
        await this.service.getOne(auth.userId, id);
        const resolved = await this.escalations.resolve(
            escalationId,
            auth.userId,
            body.note ?? null,
        );
        if (!resolved) {
            // Already resolved, or not this user's — the same answer for
            // both, so a foreign id is not an existence oracle.
            throw new NotFoundException(
                `Escalation ${escalationId} not found or already resolved.`,
            );
        }
        return { resolved: true, escalationId };
    }

    @Post(':id/approvers')
    @ApiOperation({ summary: 'Add an approver.' })
    @HttpCode(HttpStatus.CREATED)
    async addApprover(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddApproverDto,
    ) {
        this.assertActorType(body.approverType);
        return this.service.addApprover(auth.userId, id, body.approverType, body.approverId);
    }

    @Post(':id/blocks')
    @ApiOperation({ summary: 'Add a blocker.' })
    @HttpCode(HttpStatus.CREATED)
    async addBlocker(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddBlockerDto,
    ) {
        if (!body?.blockedByTaskId) throw new BadRequestException('blockedByTaskId is required.');
        return this.service.addBlocker(auth.userId, id, body.blockedByTaskId);
    }

    @Delete(':id/blocks/:blockId')
    @ApiOperation({ summary: 'Remove a blocker.' })
    @HttpCode(HttpStatus.OK)
    async removeBlocker(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('blockId', ParseUUIDPipe) blockId: string,
    ) {
        return this.service.removeBlocker(auth.userId, id, blockId);
    }

    @Get(':id/attachments')
    @ApiOperation({ summary: 'List Task attachments (FK pointers to work_knowledge_upload rows).' })
    @HttpCode(HttpStatus.OK)
    async listAttachments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.listAttachments(auth.userId, id);
    }

    @Post(':id/attachments')
    @ApiOperation({
        summary:
            'Attach an existing work_knowledge_upload to this Task. Upload via the existing KB pipeline first; pass the resulting uploadId here.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async addAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddAttachmentDto,
    ) {
        if (!body?.uploadId) throw new BadRequestException('uploadId is required.');
        return this.service.addAttachment(auth.userId, id, body.uploadId, body.role ?? 'initial');
    }

    @Delete(':id/attachments/:attachmentId')
    @ApiOperation({ summary: 'Detach an attachment (the upload row itself is preserved).' })
    @HttpCode(HttpStatus.OK)
    async removeAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    ) {
        return this.service.removeAttachment(auth.userId, id, attachmentId);
    }

    @Post(':id/relations')
    @ApiOperation({ summary: 'Add a related/duplicates/follow-up edge.' })
    @HttpCode(HttpStatus.CREATED)
    async addRelation(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddRelationDto,
    ) {
        if (!body?.relatedTaskId) throw new BadRequestException('relatedTaskId is required.');
        if (!['related', 'duplicates', 'follow-up'].includes(body.kind)) {
            throw new BadRequestException(`Invalid relation kind: ${body.kind}`);
        }
        return this.service.addRelation(auth.userId, id, body.relatedTaskId, body.kind);
    }

    private parseStatusList(value?: string): TaskStatus | TaskStatus[] | undefined {
        if (!value) return undefined;
        const parts = value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        const out: TaskStatus[] = [];
        for (const p of parts) {
            if (!Object.values(TaskStatus).includes(p as TaskStatus)) {
                throw new BadRequestException(`Invalid status filter: ${p}`);
            }
            out.push(p as TaskStatus);
        }
        return out.length === 1 ? out[0] : out;
    }

    private parsePriorityList(value?: string): TaskPriority | TaskPriority[] | undefined {
        if (!value) return undefined;
        const parts = value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        const out: TaskPriority[] = [];
        for (const p of parts) {
            if (!Object.values(TaskPriority).includes(p as TaskPriority)) {
                throw new BadRequestException(`Invalid priority filter: ${p}`);
            }
            out.push(p as TaskPriority);
        }
        return out.length === 1 ? out[0] : out;
    }

    private assertActorType(value: string): void {
        if (value !== 'user' && value !== 'agent') {
            throw new BadRequestException(`Invalid actor type: ${value}`);
        }
    }

    // ── Phase 13 — chat ───────────────────────────────────────────

    @Get(':id/chat')
    @ApiOperation({ summary: 'Paginated chat thread for a Task.' })
    @HttpCode(HttpStatus.OK)
    async listChat(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        const messages = await this.chat.list(auth.userId, id, {
            limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
            offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
        });
        return { data: messages };
    }

    @Get(':id/spend')
    @ApiOperation({ summary: 'Per-Task spend rollup in cents.' })
    @HttpCode(HttpStatus.OK)
    async spend(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('since') since?: string,
        @Query('until') until?: string,
        @Query('currency') currency?: string,
    ) {
        // Cross-user ownership check — 404 if Task doesn't belong to user.
        await this.service.getOne(auth.userId, id);
        const totalCents = await this.pluginUsage.getTotalSpendCentsForTask(id, {
            since: since ? new Date(since) : undefined,
            until: until ? new Date(until) : undefined,
            currency,
        });
        return { taskId: id, totalCents, currency: currency ?? 'usd' };
    }

    @Post(':id/chat')
    @ApiOperation({
        summary:
            'Post a chat message. Server parses @mentions + [[kb]] tokens and drops unknown ones.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async postChat(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: PostTaskChatDto,
    ) {
        if (typeof body?.body !== 'string') {
            throw new BadRequestException('body is required.');
        }
        // Review-fix I5: populate the mention-lookup map with the
        // user's owned Agent slugs so @<slug> mentions resolve →
        // chat-dispatch fan-out fires `agent-chat-reply` for each
        // mentioned Agent. Unknown tokens are still stripped (T6
        // posture). Known-user-slugs + known-kb-slugs maps land in
        // a follow-up once those domains expose lookup helpers.
        const lookups = await this.buildMentionLookups(auth.userId);
        return this.chat.post(
            auth.userId,
            {
                taskId: id,
                authorType: 'user',
                authorId: auth.userId,
                body: body.body,
                attachments: body.attachments,
            },
            lookups,
        );
    }
}
