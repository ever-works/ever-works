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
    Logger,
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
    AgentRunLogRepository,
    AgentRunRepository,
    AgentScheduleDispatcherService,
    AGENT_HEARTBEAT_TRIGGER,
    AgentsService,
    AgentExportService,
    AgentScope,
    AGENT_RUN_CANCELLER,
    type AgentRunCanceller,
    RunDispatchGateService,
    RunSteeringService,
    SkillBindingRepository,
    type AgentDto,
    type AgentExportEnvelope,
    type AgentFileName,
    type AgentHeartbeatTrigger,
    type AgentImportConflictMode,
    type AgentImportResult,
    type AgentScorecardMetric,
    type AgentTarget,
    type AgentTemplate,
    AgentTemplatesService,
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
import type { TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import {
    AddAgentAttachmentDto,
    AgentTargetBodyDto,
    AssignTaskToAgentDto,
    CreateAgentDto,
    CreateAgentFromTemplateDto,
    ListAgentRunsQueryDto,
    ListAgentsQueryDto,
    ListRunSessionsQueryDto,
    ResumeRunDto,
    SessionDetailQueryDto,
    SteerRunDto,
    UpdateAgentDto,
    UpdateAgentGuardrailsDto,
} from './dto/agent.dto';
// Type-only (erased at compile time) so the spec-side jest.mock factories
// for '@ever-works/agent/agents' never have to know about entity shapes.
import type { AgentRun, AgentRunLog } from '@ever-works/agent/entities';

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
 *   POST   /api/agents/:id/targets  assign an Agent to a Mission/Idea/Work
 *   DELETE /api/agents/:id/targets/:targetType/:targetId   unassign it
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
/**
 * Activity-log action types surfaced as "lifecycle events" in the
 * per-Agent activity feed (GET :id/events). Rows are matched by
 * `details.resourceId = agentId`, so adding a type here is enough to
 * surface any future tryLog() emitter.
 */
const AGENT_LIFECYCLE_EVENT_TYPES: ActivityActionType[] = [
    ActivityActionType.AGENT_CREATED,
    ActivityActionType.AGENT_PAUSED,
    ActivityActionType.AGENT_RESUMED,
    ActivityActionType.AGENT_ARCHIVED,
    ActivityActionType.AGENT_UNARCHIVED,
    ActivityActionType.AGENT_EXPORTED,
    ActivityActionType.AGENT_IMPORTED,
    ActivityActionType.AGENT_BUDGET_EXCEEDED,
    // Run-lifecycle events. All three are emitted by this controller via
    // tryLog() — run-now, cancel, and assign-task — but were absent from this
    // list, so every one of them was written to activity_logs and then never
    // returned by GET :id/events. Nothing surfaced the fact that a run was
    // triggered, cancelled, or assigned.
    ActivityActionType.AGENT_RUN_TRIGGERED,
    ActivityActionType.AGENT_RUN_CANCELLED,
    ActivityActionType.AGENT_TASK_ASSIGNED,
    // Agent Collaborators — allow-list edits are emitted by
    // `AgentCollaboratorsController` with `details.resourceId` = the
    // PARENT agent, so they belong in this agent's feed.
    ActivityActionType.AGENT_COLLABORATOR_ENABLED,
    ActivityActionType.AGENT_COLLABORATOR_DISABLED,
    ActivityActionType.AGENT_COLLABORATOR_REMOVED,
];

/**
 * Attach-session action (Wave 4 M8) — is this run's terminal actually
 * attachable RIGHT NOW?
 *
 * Two conditions, both required:
 *  - the terminal lifecycle says a session exists or is coming up
 *    (`starting` | `attached`) — `ended` sessions have no PTY to join; and
 *  - the run itself is still open (`queued` | `running`) — a terminal run's
 *    columns can legitimately still read `attached` (the last write the
 *    worker managed before it died, which the terminal sweeper only corrects
 *    minutes later), and offering Attach there is a guaranteed dead end.
 *
 * Computed server-side and shipped as one boolean so the Sessions list, the
 * Task detail controls and any future surface can never drift on the rule.
 */
export function isSessionAttachable(run: {
    status: string;
    terminalState?: string | null;
}): boolean {
    const live = run.status === 'queued' || run.status === 'running';
    return live && (run.terminalState === 'attached' || run.terminalState === 'starting');
}

// ── Session detail (Feature K) ─────────────────────────────────────
// Step names the timeline/counts are composed from. Kept as local
// literals (mirroring the step names `AgentRunService`'s capture writes —
// see the reciprocal note in packages/agent/src/agents/run-capture.ts,
// which documents them but exports no constant) rather than imported: five
// spec files jest.mock '@ever-works/agent/agents' with explicit export
// lists, and a runtime value import here would arrive as `undefined`
// in every one of them.
const SESSION_TIMELINE_STEPS = [
    'assistant-message',
    'user-message',
    'tool-invocation',
    'capture-truncated',
] as const;
const SESSION_MESSAGE_STEPS = ['assistant-message', 'user-message'] as const;

/** One rendered row of the session-detail timeline. */
export interface SessionTimelineEntry {
    id: string;
    kind: 'assistant-message' | 'user-message' | 'tool-call' | 'marker';
    createdAt: string;
    /** Message rows + marker rows: the (already redacted, capped) text. */
    text: string | null;
    toolName: string | null;
    callId: string | null;
    argsPreview: string | null;
    resultPreview: string | null;
    durationMs: number | null;
    isError: boolean;
    truncated: boolean;
}

function toSessionTimelineEntry(log: AgentRunLog): SessionTimelineEntry {
    const md = (log.metadata ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const isTool = log.step === 'tool-invocation';
    return {
        id: log.id,
        kind: isTool
            ? 'tool-call'
            : log.step === 'assistant-message' || log.step === 'user-message'
              ? log.step
              : 'marker',
        createdAt: log.createdAt.toISOString(),
        text: isTool ? null : log.message,
        toolName: isTool ? str(md.toolName) : null,
        callId: isTool ? str(md.callId) : null,
        argsPreview: isTool ? str(md.argsPreview) : null,
        resultPreview: isTool ? str(md.resultPreview) : null,
        durationMs: isTool ? num(md.durationMs) : null,
        isError: isTool && log.level !== 'INFO',
        truncated:
            md.truncated === true || md.argsTruncated === true || md.resultTruncated === true,
    };
}

/**
 * Parse the `<epochMillis>_<uuid>` cursor the previous page returned.
 * The DTO already regex-validated the shape; a still-unparsable value
 * degrades to "first page" rather than erroring.
 */
function parseTimelineCursor(cursor?: string): { createdAt: Date; id: string } | undefined {
    if (!cursor) return undefined;
    const separator = cursor.indexOf('_');
    if (separator <= 0) return undefined;
    const ms = Number(cursor.slice(0, separator));
    const id = cursor.slice(separator + 1);
    if (!Number.isFinite(ms) || id.length === 0) return undefined;
    return { createdAt: new Date(ms), id };
}

function timelineCursorOf(log: AgentRunLog): string {
    return `${log.createdAt.getTime()}_${log.id}`;
}

@ApiTags('agents')
@Controller('api/agents')
export class AgentsController {
    private readonly logger = new Logger(AgentsController.name);

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
        private readonly agentRunLogs: AgentRunLogRepository,
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
        // Appended LAST on purpose — every `new AgentsController(...)` in the
        // specs is positional, so a new trailing optional param keeps them
        // compiling. Unlike assignTask, cancel must degrade rather than 500
        // when this is unbound: the DB transition is the authoritative answer.
        @Optional()
        @Inject(AGENT_RUN_CANCELLER)
        private readonly runCanceller?: AgentRunCanceller,
        // Run orchestration (Wave 4 M2) — a successful cancel frees a
        // concurrency slot, so the Work's parked queue is drained. Trailing
        // + Optional for the same positional-spec reason as above.
        @Optional()
        private readonly dispatchGate?: RunDispatchGateService,
        // Wave 10 — prebuilt agent-template activation. Trailing +
        // Optional for the same positional-spec reason as above.
        @Optional()
        private readonly agentTemplates?: AgentTemplatesService,
        // Run steering (Wave 4 M5) — steer / interrupt / resume. Trailing +
        // Optional for the same positional-spec reason as above; when unbound
        // the three endpoints report 500 "not available" rather than
        // pretending the control landed.
        @Optional()
        private readonly steering?: RunSteeringService,
        @Optional()
        private readonly scopeContext?: ScopeContextService,
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
        const { rows, total } = await this.service.list(
            auth.userId,
            {
                scope: query.scope,
                status: query.status,
                missionId: query.missionId,
                ideaId: query.ideaId,
                workId: query.workId,
                assignedWorkId: query.assignedWorkId,
                assignedIdeaId: query.assignedIdeaId,
                search: query.search,
                limit,
                offset,
            },
            this.scopeContext?.getScope(),
        );
        return { data: rows, meta: { total, limit, offset } };
    }

    @Post()
    @ApiOperation({ summary: 'Create a new Agent' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateAgentDto,
    ): Promise<AgentDto> {
        return this.service.create(
            auth.userId,
            {
                scope: body.scope,
                missionId: body.missionId ?? null,
                ideaId: body.ideaId ?? null,
                workId: body.workId ?? null,
                name: body.name,
                title: body.title ?? null,
                capabilities: body.capabilities ?? null,
                aiProviderId: body.aiProviderId ?? null,
                modelId: body.modelId ?? null,
                // Environments — service validates same-user + published
                // (draft → 422, cross-user/unknown → 404).
                environmentId: body.environmentId ?? null,
                maxSkillContextTokens: body.maxSkillContextTokens,
                heartbeatCadence: body.heartbeatCadence ?? null,
                idleBehavior: body.idleBehavior,
                pauseAfterFailures: body.pauseAfterFailures,
                permissions: body.permissions,
                targets: (body.targets ?? null) as AgentTarget[] | null,
                avatarMode: body.avatarMode,
                avatarIcon: body.avatarIcon ?? null,
                avatarImageUploadId: body.avatarImageUploadId ?? null,
                committerName: body.committerName ?? null,
                committerEmail: body.committerEmail ?? null,
            },
            this.scopeContext?.getScope(),
        );
    }

    /**
     * Run orchestration (Wave 4 M3) — the Sessions list: every AgentRun
     * of the acting user across all Agents/Works, filterable + paginated.
     * Declared BEFORE the `:id` routes so the literal `runs` segment
     * never reaches ParseUUIDPipe.
     *
     * Security: `listSessionsForUser` applies `userId = auth.userId`
     * at the repository layer — cross-user rows are unreachable by
     * construction, filters can only narrow the caller's own set.
     */
    @Get('runs')
    @ApiOperation({
        summary:
            'Sessions list — my AgentRuns across all Agents (filter by status/workId/agentId/kind).',
    })
    @HttpCode(HttpStatus.OK)
    async listRunSessions(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListRunSessionsQueryDto,
    ): Promise<{
        data: Array<{
            id: string;
            agentId: string;
            status: string;
            triggerKind: string;
            taskId: string | null;
            workId: string | null;
            awaitingInput: boolean;
            queuedReason: string | null;
            /** Wave 4 M6 - platform-raised needs-attention flag. */
            attentionReason: string | null;
            attentionAt: string | null;
            runnerKind: string | null;
            startedAt: string | null;
            finishedAt: string | null;
            durationMs: number | null;
            summary: string | null;
            errorMessage: string | null;
            currentActivity: string | null;
            totalTokens: number | null;
            changedFilesCount: number | null;
            costCents: number | null;
            gateStatus: string | null;
            gateAttempts: number;
            resolvedChecks: TaskAcceptanceCheck[] | null;
            checkResults: TaskCheckResult[] | null;
            persistent: boolean;
            terminalState: string | null;
            terminalEndedReason: string | null;
            terminalProviderId: string | null;
            sessionAttachable: boolean;
            createdAt: string;
        }>;
        meta: { total: number; limit: number; offset: number };
    }> {
        const limit = query.limit ?? 25;
        const offset = query.offset ?? 0;
        const [rows, total] = await this.agentRuns.listSessionsForUser(
            auth.userId,
            {
                status: query.status,
                workId: query.workId,
                agentId: query.agentId,
                taskId: query.taskId,
                triggerKind: query.kind,
                // Wave 4 M6 - `attention=1` is the union of "the agent
                // asked" and "the platform flagged"; the repository owns
                // that OR so this surface and the per-Work summary chip
                // can never drift apart.
                attention: query.attention !== undefined,
            },
            limit,
            offset,
            this.scopeContext?.getScope(),
        );
        return {
            data: rows.map((r) => this.toSessionRow(r)),
            meta: { total, limit, offset },
        };
    }

    /**
     * The wire projection of one `agent_runs` row shared by the Sessions
     * list and the session-detail endpoint — factored out (Feature K) so
     * the two surfaces can never drift on a field. `currentActivity` is
     * plain text by contract (the UI must never render it as markup);
     * `sessionAttachable` is the server-computed attach gate (Wave 4 M8);
     * the quality-gate columns carry the dispatch-frozen check set +
     * per-check results for the Checks section.
     */
    private toSessionRow(r: AgentRun): {
        id: string;
        agentId: string;
        tenantId: string | null;
        organizationId: string | null;
        status: string;
        triggerKind: string;
        taskId: string | null;
        workId: string | null;
        awaitingInput: boolean;
        queuedReason: string | null;
        attentionReason: string | null;
        attentionAt: string | null;
        runnerKind: string | null;
        startedAt: string | null;
        finishedAt: string | null;
        durationMs: number | null;
        summary: string | null;
        errorMessage: string | null;
        currentActivity: string | null;
        totalTokens: number | null;
        changedFilesCount: number | null;
        costCents: number | null;
        gateStatus: string | null;
        gateAttempts: number;
        resolvedChecks: TaskAcceptanceCheck[] | null;
        checkResults: TaskCheckResult[] | null;
        persistent: boolean;
        terminalState: string | null;
        terminalEndedReason: string | null;
        terminalProviderId: string | null;
        sessionAttachable: boolean;
        createdAt: string;
    } {
        return {
            id: r.id,
            agentId: r.agentId,
            tenantId: r.tenantId ?? null,
            organizationId: r.organizationId ?? null,
            status: r.status,
            triggerKind: r.triggerKind,
            taskId: r.taskId ?? null,
            workId: r.workId ?? null,
            awaitingInput: r.awaitingInput ?? false,
            queuedReason: r.queuedReason ?? null,
            attentionReason: r.attentionReason ?? null,
            attentionAt: r.attentionAt?.toISOString() ?? null,
            runnerKind: r.runnerKind ?? null,
            startedAt: r.startedAt?.toISOString() ?? null,
            finishedAt: r.finishedAt?.toISOString() ?? null,
            durationMs: r.durationMs ?? null,
            summary: r.summary ?? null,
            errorMessage: r.errorMessage ?? null,
            currentActivity: r.currentActivity ?? null,
            totalTokens: r.totalTokens ?? null,
            changedFilesCount: r.changedFilesCount ?? null,
            costCents: r.costCents ?? null,
            gateStatus: r.gateStatus ?? null,
            gateAttempts: r.gateAttempts ?? 0,
            resolvedChecks: r.resolvedChecks ?? null,
            checkResults: r.checkResults ?? null,
            persistent: r.persistent ?? false,
            terminalState: r.terminalState ?? null,
            terminalEndedReason: r.terminalEndedReason ?? null,
            terminalProviderId: r.terminalProviderId ?? null,
            sessionAttachable: isSessionAttachable(r),
            createdAt: r.createdAt.toISOString(),
        };
    }

    /**
     * Session detail (Feature K) — the drill-in behind each Sessions row:
     * the full session projection + message/tool-call/file counts + one
     * cursor page of the captured timeline + the touched-file list.
     *
     * Addressed by runId ALONE (under the literal `runs` segment, declared
     * before every `:id` route so it never reaches ParseUUIDPipe as an
     * agent id) because the caller — /agents/sessions — holds run ids,
     * not agent ids. Security: `findByIdAndUser` scopes by the acting
     * user, so a cross-user runId 404s (architecture/security §9,
     * no-existence-leak).
     */
    @Get('runs/:runId/detail')
    @ApiOperation({
        summary:
            'Session detail — one run with counts, touched files and a cursor page of its captured timeline.',
    })
    @HttpCode(HttpStatus.OK)
    async getRunSessionDetail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('runId', ParseUUIDPipe) runId: string,
        @Query() query: SessionDetailQueryDto,
    ): Promise<{
        run: ReturnType<AgentsController['toSessionRow']> & {
            chatMessageId: string | null;
            memorySessionId: string | null;
        };
        counts: { messages: number; toolCalls: number; filesTouched: number };
        /** Explicit paths when capture recorded them; may be empty while
         *  `counts.filesTouched` still carries the workspace-diff rollup. */
        filesTouched: string[];
        timeline: { entries: SessionTimelineEntry[]; nextCursor: string | null; limit: number };
    }> {
        const scope = this.scopeContext?.getScope();
        const run = scope
            ? await this.agentRuns.findByIdAndUser(runId, auth.userId, scope)
            : await this.agentRuns.findByIdAndUser(runId, auth.userId);
        if (!run) {
            throw new NotFoundException(`AgentRun not found.`);
        }
        try {
            await this.service.getOne(auth.userId, run.agentId, scope);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw new NotFoundException(`AgentRun not found.`);
            }
            throw error;
        }
        const limit = query.limit ?? 100;
        const after = parseTimelineCursor(query.cursor);
        const [timelineRows, messages, toolCalls] = await Promise.all([
            this.agentRunLogs.findTimelineByRun(runId, SESSION_TIMELINE_STEPS, limit, after),
            this.agentRunLogs.countByRunSteps(runId, SESSION_MESSAGE_STEPS),
            this.agentRunLogs.countByRunSteps(runId, ['tool-invocation']),
        ]);
        const filesTouched = (run.workspaceMeta?.filesTouched ?? []).filter(
            (p): p is string => typeof p === 'string' && p.length > 0,
        );
        const last = timelineRows.length > 0 ? timelineRows[timelineRows.length - 1] : null;
        return {
            run: {
                ...this.toSessionRow(run),
                chatMessageId: run.chatMessageId ?? null,
                memorySessionId: run.memorySessionId ?? null,
            },
            counts: {
                messages,
                toolCalls,
                // Explicit capture wins; `changedFilesCount` (the workspace
                // provider's diff rollup) is the fallback for runs whose
                // loop never reported paths.
                filesTouched:
                    filesTouched.length > 0 ? filesTouched.length : (run.changedFilesCount ?? 0),
            },
            filesTouched,
            timeline: {
                entries: timelineRows.map((row) => toSessionTimelineEntry(row)),
                // A full page means there MAY be more; the client stops on
                // the first short page.
                nextCursor: last && timelineRows.length === limit ? timelineCursorOf(last) : null,
                limit,
            },
        };
    }

    /**
     * Wave 10 — prebuilt agent-template catalog (in-code, fully
     * specified presets with prompts + safe defaults). Complements the
     * repo-backed `GET /api/agent-templates` metadata catalog. Declared
     * BEFORE the `:id` routes so the literal `templates` segment never
     * reaches ParseUUIDPipe.
     */
    @Get('templates')
    @ApiOperation({ summary: 'List prebuilt agent templates (marketing/sales/ops presets)' })
    @HttpCode(HttpStatus.OK)
    async listTemplates(): Promise<{ data: AgentTemplate[] }> {
        if (!this.agentTemplates) {
            throw new InternalServerErrorException('Agent templates service is not available.');
        }
        return { data: [...this.agentTemplates.list()] };
    }

    /**
     * Wave 10 — create MY Agent from a prebuilt template. Owner-scoped:
     * the created Agent belongs to the caller, starts in DRAFT with the
     * template's prompt (SOUL.md), conservative permissions, and
     * review-before-act guardrails. Body fields are optional placement
     * overrides only. Declared BEFORE the `:id` routes (literal segment).
     */
    @Post('from-template/:slug')
    @ApiOperation({ summary: 'Create an Agent for the current user from a prebuilt template' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async createFromTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() body: CreateAgentFromTemplateDto,
    ): Promise<AgentDto> {
        if (!this.agentTemplates) {
            throw new InternalServerErrorException('Agent templates service is not available.');
        }
        return this.agentTemplates.createFromTemplate(
            auth.userId,
            slug,
            {
                name: body.name ?? null,
                scope: body.scope,
                missionId: body.missionId ?? null,
                ideaId: body.ideaId ?? null,
                workId: body.workId ?? null,
            },
            this.scopeContext?.getScope(),
        );
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Agent' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        return this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update Agent fields (partial)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateAgentDto,
    ): Promise<AgentDto> {
        return this.service.update(
            auth.userId,
            id,
            {
                name: body.name,
                title: body.title,
                capabilities: body.capabilities,
                aiProviderId: body.aiProviderId,
                modelId: body.modelId,
                // Environments — `undefined` leaves the assignment alone,
                // `null` clears it, an id is validated by the service.
                environmentId: body.environmentId,
                maxSkillContextTokens: body.maxSkillContextTokens,
                memoryRecallEnabled: body.memoryRecallEnabled,
                heartbeatCadence: body.heartbeatCadence,
                idleBehavior: body.idleBehavior,
                pauseAfterFailures: body.pauseAfterFailures,
                permissions: body.permissions,
                targets: body.targets as AgentTarget[] | null | undefined,
                avatarMode: body.avatarMode,
                avatarIcon: body.avatarIcon,
                avatarImageUploadId: body.avatarImageUploadId,
                committerName: body.committerName,
                committerEmail: body.committerEmail,
                reportsToAgentId: body.reportsToAgentId,
                scorecard: body.scorecard as AgentScorecardMetric[] | null | undefined,
                // Merge-policy matrix (Wave 3, D4) — the Agent-scoped slice.
                mergePolicy: body.mergePolicy,
                // Capabilities tab — init script (advisory v1).
                initScript: body.initScript,
            },
            this.scopeContext?.getScope(),
        );
    }

    /**
     * Assign an existing Agent to a Mission / Idea / Work
     * — the write behind the Work header's "Assign existing Agent"
     * picker. Idempotent: re-assigning an Agent that already reaches the
     * target returns it unchanged rather than 409-ing.
     */
    @Post(':id/targets')
    @ApiOperation({ summary: 'Assign an existing Agent to a Mission / Idea / Work' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async addTarget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AgentTargetBodyDto,
    ): Promise<AgentDto> {
        return this.service.addTarget(
            auth.userId,
            id,
            { type: body.type, id: body.id },
            this.scopeContext?.getScope(),
        );
    }

    /** Inverse of `addTarget` — also idempotent. */
    @Delete(':id/targets/:targetType/:targetId')
    @ApiOperation({ summary: 'Unassign an Agent from a Mission / Idea / Work' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async removeTarget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('targetType') targetType: string,
        @Param('targetId', ParseUUIDPipe) targetId: string,
    ): Promise<AgentDto> {
        if (targetType !== 'mission' && targetType !== 'idea' && targetType !== 'work') {
            throw new BadRequestException(
                `Unsupported target type "${targetType}" — expected mission, idea or work.`,
            );
        }
        return this.service.removeTarget(
            auth.userId,
            id,
            { type: targetType, id: targetId },
            this.scopeContext?.getScope(),
        );
    }

    @Put(':id/guardrails')
    @ApiOperation({
        summary:
            'Replace the Agent\'s dispatch guardrails (mode + auto-approve / blocked action types). Pass {"guardrails": null} to clear back to the default queue-everything posture.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setGuardrails(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateAgentGuardrailsDto,
    ): Promise<AgentDto> {
        // Cross-user 404 (never 403) + defense-in-depth validation both
        // happen inside the service (`requireOwned` + `validateGuardrails`).
        return this.service.setGuardrails(
            auth.userId,
            id,
            body.guardrails ?? null,
            this.scopeContext?.getScope(),
        );
    }

    @Delete(':id')
    @ApiOperation({
        summary: 'Archive Agent (soft-delete). Pass ?hard=true to permanently delete + cascade.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('hard') hard?: string,
    ): Promise<{ archived?: true; deleted?: true }> {
        if (hard === 'true') {
            return this.service.deleteHard(auth.userId, id, this.scopeContext?.getScope());
        }
        return this.service.archive(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause an active Agent (ACTIVE → PAUSED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        const dto = await this.service.pause(auth.userId, id, this.scopeContext?.getScope());
        // agents/spec.md — status transitions MUST leave an activity
        // trail; surfaced in the /agents/[id]/activity feed via
        // GET :id/events.
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_PAUSED,
            details: { status: dto.status },
        });
        return dto;
    }

    @Post(':id/resume')
    @ApiOperation({ summary: 'Resume a paused/errored Agent (→ ACTIVE)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        const dto = await this.service.resume(auth.userId, id, this.scopeContext?.getScope());
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_RESUMED,
            details: { status: dto.status },
        });
        return dto;
    }

    @Post(':id/unarchive')
    @ApiOperation({
        summary:
            'Restore an archived Agent (ARCHIVED → PAUSED). Lands on PAUSED, not ACTIVE, so a cron-cadence Agent does not resume firing heartbeats on restore.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async unarchive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentDto> {
        const dto = await this.service.unarchive(auth.userId, id, this.scopeContext?.getScope());
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_UNARCHIVED,
            details: { status: dto.status },
        });
        return dto;
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
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
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
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async writeFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
        @Body() body: { body: string; expectedHash?: string },
    ): Promise<{ newHash: string }> {
        this.assertValidFileName(name);
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
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
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async exportOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<AgentExportEnvelope> {
        return this.exportService.exportOne(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post('import')
    @ApiOperation({
        summary:
            'Import an Agent envelope. Conflict mode: skip | overwrite | rename (default rename — appends -2, -3, etc.).',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
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
        return this.exportService.importOne(
            auth.userId,
            body,
            {
                onConflict: mode,
                overrideScope: scope,
                missionId: missionId ?? null,
                ideaId: ideaId ?? null,
                workId: workId ?? null,
            },
            this.scopeContext?.getScope(),
        );
    }

    // ── FU-2 — runtime endpoints (run-now / runs / cancel / skills / budget / assign-task) ─

    @Post(':id/run-now')
    @ApiOperation({
        summary:
            'Manually trigger an agent-heartbeat run NOW, bypassing the heartbeatCadence schedule.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async runNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ outcome: string; runId?: string; reason?: string }> {
        // Cross-user 404 via service-level access check.
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
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
            tenantId: string | null;
            organizationId: string | null;
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
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
        const limit = query.limit ?? 25;
        const offset = query.offset ?? 0;
        // Security (EW-710 wave M): use the user-scoped repository variants —
        // the unscoped findByAgent/countByAgent are @internal-only and would
        // become a latent IDOR if the getOne() ownership gate above were ever
        // refactored away.
        const scope = this.scopeContext?.getScope();
        const [rows, total] = scope
            ? await Promise.all([
                  this.agentRuns.findByAgentAndUser(id, auth.userId, limit, offset, scope),
                  this.agentRuns.countByAgentAndUser(id, auth.userId, scope),
              ])
            : await Promise.all([
                  this.agentRuns.findByAgentAndUser(id, auth.userId, limit, offset),
                  this.agentRuns.countByAgentAndUser(id, auth.userId),
              ]);
        return {
            data: rows.map((r) => ({
                id: r.id,
                tenantId: r.tenantId ?? null,
                organizationId: r.organizationId ?? null,
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

    @Get(':id/runs/:runId')
    @ApiOperation({
        summary: 'Full detail for one AgentRun, including its structured step logs.',
    })
    @HttpCode(HttpStatus.OK)
    async getRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{
        id: string;
        tenantId: string | null;
        organizationId: string | null;
        status: string;
        triggerKind: string;
        startedAt: string | null;
        finishedAt: string | null;
        durationMs: number | null;
        summary: string | null;
        errorMessage: string | null;
        taskId: string | null;
        chatMessageId: string | null;
        memorySessionId: string | null;
        createdAt: string;
        logs: Array<{
            id: string;
            level: 'INFO' | 'WARN' | 'ERROR';
            step: string;
            message: string;
            metadata: Record<string, unknown> | null;
            createdAt: string;
        }>;
    }> {
        const run = await this.requireScopedRun(auth.userId, id, runId);
        const logs = await this.agentRunLogs.findByRun(runId, 500);
        return {
            id: run.id,
            tenantId: run.tenantId ?? null,
            organizationId: run.organizationId ?? null,
            status: run.status,
            triggerKind: run.triggerKind,
            startedAt: run.startedAt?.toISOString() ?? null,
            finishedAt: run.finishedAt?.toISOString() ?? null,
            durationMs: run.durationMs ?? null,
            summary: run.summary ?? null,
            errorMessage: run.errorMessage ?? null,
            taskId: run.taskId ?? null,
            chatMessageId: run.chatMessageId ?? null,
            memorySessionId: run.memorySessionId ?? null,
            createdAt: run.createdAt.toISOString(),
            logs: logs.map((l) => ({
                id: l.id,
                level: l.level,
                step: l.step,
                message: l.message,
                metadata: l.metadata ?? null,
                createdAt: l.createdAt.toISOString(),
            })),
        };
    }

    @Get(':id/events')
    @ApiOperation({
        summary:
            'Paginated Agent lifecycle events (paused / resumed / created / archived / …) from the activity log.',
    })
    @HttpCode(HttpStatus.OK)
    async listEvents(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListAgentRunsQueryDto,
    ): Promise<{
        data: Array<{
            id: string;
            actionType: string;
            details: Record<string, unknown> | null;
            createdAt: string;
        }>;
        meta: { total: number; limit: number; offset: number };
    }> {
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
        const limit = query.limit ?? 25;
        const offset = query.offset ?? 0;
        // ActivityLogService is @Optional — when unbound the feed simply
        // has no lifecycle rows (mirrors tryLog's best-effort posture).
        if (!this.activityLog) {
            return { data: [], meta: { total: 0, limit, offset } };
        }
        const { activities, total } = await this.activityLog.findAgentEvents({
            userId: auth.userId,
            agentId: id,
            actionTypes: AGENT_LIFECYCLE_EVENT_TYPES,
            limit,
            offset,
        });
        return {
            data: activities.map((a) => ({
                id: a.id,
                actionType: a.actionType,
                details: a.details ?? null,
                createdAt: a.createdAt.toISOString(),
            })),
            meta: { total, limit, offset },
        };
    }

    @Post(':id/runs/:runId/cancel')
    @ApiOperation({
        summary: 'Cancel a queued / running AgentRun. No-op for already-terminal runs.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async cancelRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{ cancelled: boolean; previousStatus?: string }> {
        await this.requireScopedRun(auth.userId, id, runId);
        const scope = this.scopeContext?.getScope();
        const result = scope
            ? await this.agentRuns.cancel(runId, auth.userId, scope)
            : await this.agentRuns.cancel(runId, auth.userId);
        if (!result.found) {
            throw new NotFoundException(`AgentRun not found.`);
        }
        const wasOpen = result.previousStatus === 'queued' || result.previousStatus === 'running';
        // DB first, then the remote run. The reverse order risks a cancelled
        // Trigger.dev run behind a row still reading `running`, which nothing
        // would ever reap — there is no agent_runs sweeper. This way the worst
        // case is wasted compute, and the worker cannot resurrect the row
        // because markCompleted/markFailed are CAS-guarded.
        //
        // Awaited, not fire-and-forget: the port cannot throw by contract, so
        // awaiting costs nothing and keeps the endpoint deterministic to test.
        if (wasOpen && result.triggerRunId && this.runCanceller) {
            const outcome = await this.runCanceller.cancel(result.triggerRunId);
            if (outcome !== 'cancelled') {
                // Deliberately not an error response — the run IS cancelled as
                // far as the platform is concerned. Logged with both ids so an
                // operator seeing a wall of 'not-configured' can tell a missing
                // TRIGGER_SECRET_KEY from the benign already-terminal race.
                this.logger.warn(
                    `AgentRun ${runId}: DB cancel committed but Trigger.dev cancel of ${result.triggerRunId} returned '${outcome}'.`,
                );
            }
        }
        if (wasOpen) {
            void this.tryLog({
                userId: auth.userId,
                agentId: id,
                actionType: ActivityActionType.AGENT_RUN_CANCELLED,
                details: { runId, previousStatus: result.previousStatus },
            });
            // Run orchestration (Wave 4 M2) — the cancel freed a concurrency
            // slot; promote the oldest parked run for the same Work. Fire-
            // and-forget: drainForWork never throws by contract, and the
            // cancel response must not wait on a fresh dispatch.
            if (result.workId && this.dispatchGate) {
                void this.dispatchGate.drainForWork(result.workId).catch(() => undefined);
            }
        }
        return { cancelled: wasOpen, previousStatus: result.previousStatus };
    }

    /**
     * Run steering (Wave 4 M5) — send a message to a run.
     *
     * LIVE run ⇒ the message is queued for the executing tool loop, which
     * injects it between model round-trips (`dispatched: 'injected'`).
     * TERMINAL run ⇒ `dispatched: 'new-run'`, telling the caller to start a
     * fresh run instead. Deliberately NOT a 409: "the run finished while you
     * were typing" is a normal race, not a client error, and the caller has a
     * defined next step.
     *
     * Ownership is enforced twice — `getOne` 404s a cross-user Agent, and
     * `RunSteeringService` loads the run through `findByIdAndUser`, so a run
     * id belonging to someone else is indistinguishable from a missing one.
     */
    @Post(':id/runs/:runId/steer')
    @ApiOperation({
        summary:
            'Send a steering message to a run: injected into the live session, or ' +
            'answered with new-run when the run already finished.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async steerRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
        @Body() body: SteerRunDto,
    ): Promise<{ dispatched: 'injected' | 'new-run'; runId: string; queuedCount?: number }> {
        await this.requireScopedRun(auth.userId, id, runId);
        const steering = this.requireSteering();
        const scope = this.scopeContext?.getScope();
        return steering.steer({
            runId,
            userId: auth.userId,
            message: body.message,
            ...(scope ? { ownershipScope: scope } : {}),
        });
    }

    /**
     * Run steering (Wave 4 M5) — cooperative stop request.
     *
     * The run's tool loop honours it at its next per-iteration checkpoint, so
     * the run stops BETWEEN iterations and finishes `completed` with a summary
     * instead of being killed mid-round-trip. 409 when the run is already
     * terminal — unlike steer, there is no meaningful fallback action.
     *
     * "Stop" (kill the process now) stays the existing
     * `POST :id/runs/:runId/cancel` endpoint; it is not duplicated here.
     */
    @Post(':id/runs/:runId/interrupt')
    @ApiOperation({
        summary:
            'Request a cooperative stop: the run halts between tool-loop iterations ' +
            'and completes with a summary. 409 when the run is already terminal.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async interruptRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<{ interrupted: boolean; runId: string }> {
        await this.requireScopedRun(auth.userId, id, runId);
        const steering = this.requireSteering();
        const scope = this.scopeContext?.getScope();
        const outcome = scope
            ? await steering.interrupt(runId, auth.userId, scope)
            : await steering.interrupt(runId, auth.userId);
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_RUN_CANCELLED,
            details: { runId, control: 'interrupt' },
        });
        return outcome;
    }

    /**
     * Run steering (Wave 4 M5) — resume a parked / awaiting-input run.
     *
     * Dispatches a NEW run carrying the source run's `cliSessionId` (the
     * pipeline plugin's own conversation id) and, optionally, a first message.
     * Runs are immutable: the source row stays terminal. 409 when the run is
     * not resumable (still live, or ended for a non-parked reason).
     */
    @Post(':id/runs/:runId/resume')
    @ApiOperation({
        summary:
            'Resume a parked / awaiting-input run as a NEW run carrying the same ' +
            'pipeline session. 409 when the run is not resumable.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resumeRun(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('runId', ParseUUIDPipe) runId: string,
        @Body() body: ResumeRunDto,
    ): Promise<{
        dispatched: 'new-run';
        runId: string;
        resumedFromRunId: string;
        carriedCliSession: boolean;
        queued: boolean;
    }> {
        await this.requireScopedRun(auth.userId, id, runId);
        const steering = this.requireSteering();
        const scope = this.scopeContext?.getScope();
        const outcome = scope
            ? await steering.resume(runId, auth.userId, body.message ?? null, scope)
            : await steering.resume(runId, auth.userId, body.message ?? null);
        void this.tryLog({
            userId: auth.userId,
            agentId: id,
            actionType: ActivityActionType.AGENT_RUN_TRIGGERED,
            details: { runId: outcome.runId, source: 'resume', resumedFromRunId: runId },
        });
        return outcome;
    }

    /**
     * The steering service is @Optional() so every positional spec
     * constructor keeps compiling. An unbound service means the deployment is
     * misconfigured — say so loudly rather than answering 200 for a control
     * that never reached anything.
     */
    private requireSteering(): RunSteeringService {
        if (!this.steering) {
            throw new InternalServerErrorException(
                'RunSteeringService is not available on this deployment.',
            );
        }
        return this.steering;
    }

    private async requireScopedRun(
        userId: string,
        agentId: string,
        runId: string,
    ): Promise<AgentRun> {
        const scope = this.scopeContext?.getScope();
        const run = scope
            ? await this.agentRuns.findByIdAndUser(runId, userId, scope)
            : await this.agentRuns.findByIdAndUser(runId, userId);
        if (!run || run.agentId !== agentId) {
            throw new NotFoundException(`AgentRun not found.`);
        }
        try {
            await this.service.getOne(userId, agentId, scope);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw new NotFoundException(`AgentRun not found.`);
            }
            throw error;
        }
        return run;
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
        const agent = await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
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
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
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
            'Assign a Task to this Agent — pre-creates an AgentRun for the (taskId, agentId) pair and enqueues `agent-task-execute`. Over the concurrency valve the run is created parked (`queued: true`) and promoted by the drain when a slot frees.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async assignTask(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AssignTaskToAgentDto,
    ): Promise<{ runId: string; queued?: boolean; queuedReason?: string }> {
        await this.service.getOne(auth.userId, id, this.scopeContext?.getScope());
        // Cross-user 404 on the Task too — surfaces via TasksService.
        const scope = this.scopeContext?.getScope();
        const task = scope
            ? await this.tasks.getOne(auth.userId, body.taskId, scope)
            : await this.tasks.getOne(auth.userId, body.taskId);
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
        const inflight = scope
            ? await this.agentRuns.findInFlightForTaskAgent(body.taskId, id, auth.userId, scope)
            : await this.agentRuns.findInFlightForTaskAgent(body.taskId, id);
        if (inflight) {
            return { runId: inflight.id };
        }
        // Run orchestration — this endpoint used to enqueue straight past
        // the concurrency valve, so an assign-task loop could put
        // unbounded runs on a Work that the board / fan-out paths would
        // have parked. It now goes through the SAME gate, with the row
        // created inside the admission critical section.
        //
        // `workId` is denormalized here for the same reason the fan-out
        // does it: without it this run counts toward nothing, and the
        // per-Work valve cannot see it.
        let created: { id: string } | undefined;
        const reserve = async (verdict: {
            admitted: boolean;
            queuedReason?: string;
        }): Promise<void> => {
            created = await this.agentRuns.createQueued({
                agentId: id,
                userId: auth.userId,
                triggerKind: 'task',
                taskId: body.taskId,
                workId: task.workId ?? null,
                queuedReason: verdict.admitted ? null : (verdict.queuedReason ?? null),
                ...(scope ?? {}),
            });
        };
        let admission: { admitted: boolean; queuedReason?: string } = { admitted: true };
        if (this.dispatchGate) {
            try {
                admission = await this.dispatchGate.admit(
                    {
                        userId: auth.userId,
                        workId: task.workId ?? null,
                        organizationId: task.organizationId ?? null,
                    },
                    reserve,
                );
            } catch (gateErr) {
                // Fail-open — a broken safety valve must never 500 a
                // legitimate assignment.
                this.logger.warn(
                    `Dispatch gate admit failed for task ${body.taskId} — failing open: ${gateErr}`,
                );
            }
            if (!created) await reserve(admission);
        } else {
            await reserve(admission);
        }
        const run = created!;
        if (!admission.admitted) {
            // Parked: the row exists with its `queuedReason`, the enqueue
            // is SKIPPED, and `RunDispatchGateService.drainForWork`
            // promotes it on the next terminal transition for this Work.
            void this.tryLog({
                userId: auth.userId,
                agentId: id,
                actionType: ActivityActionType.AGENT_TASK_ASSIGNED,
                details: {
                    runId: run.id,
                    taskId: body.taskId,
                    queued: true,
                    queuedReason: admission.queuedReason,
                },
            });
            return { runId: run.id, queued: true, queuedReason: admission.queuedReason };
        }
        let handle: { runId: string } | undefined;
        try {
            handle = await this.taskExecuteDispatcher.enqueue({
                agentId: id,
                userId: auth.userId,
                taskId: body.taskId,
                dedupKey: `${body.taskId}:${id}:assigned:${run.id}`,
                runId: run.id,
            });
        } catch (err) {
            // FU-2 review fix (codex P1): without this rollback, the
            // queued AgentRun row stays forever and
            // `findInFlightForTaskAgent` keeps short-circuiting future
            // assign-task calls (because the queued row passes its
            // "in flight" filter). Mark it failed so retries can
            // re-dispatch cleanly.
            // FU-3: markDispatchFailed is `queued`-only — if this enqueue threw
            // on a timeout but was nevertheless accepted, the worker owns the
            // row from `markStarted` onwards and the rollback must no-op.
            const message = err instanceof Error ? err.message : String(err);
            await this.agentRuns
                .markDispatchFailed(run.id, `enqueue-failed: ${message}`)
                .catch(() => undefined);
            throw new InternalServerErrorException(`assign-task enqueue failed: ${message}`);
        }
        // Stamp OUTSIDE the try above: the enqueue has already succeeded, so a
        // stamp failure must not take the rollback path and 500 a request that
        // did dispatch. Losing the stamp only costs a remote cancel.
        if (handle?.runId) {
            await this.agentRuns.setTriggerRunId(run.id, handle.runId).catch(() => undefined);
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

    /**
     * Agent attachment surface — list/add/remove `AgentAttachment`
     * edges (FK to `work_knowledge_uploads`). Same shape as the
     * Mission / Idea endpoints; reference files / specs attached to
     * an Agent profile (separate from the Agent's `avatarImageUploadId`).
     */
    @Get(':id/attachments')
    @ApiOperation({ summary: "List an Agent's attached uploads" })
    async listAttachments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.listAttachments(auth.userId, id, this.scopeContext?.getScope());
    }

    @Post(':id/attachments')
    @ApiOperation({ summary: 'Attach an uploaded file to an Agent' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async addAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        // Security (EW-710 wave M): class-validator DTO (mirrors the Task /
        // WorkProposal attachment endpoints) so the global ValidationPipe
        // enforces a UUID `uploadId` instead of a raw inline object type.
        @Body() body: AddAgentAttachmentDto,
    ) {
        return this.service.addAttachment(
            auth.userId,
            id,
            body?.uploadId,
            this.scopeContext?.getScope(),
        );
    }

    @Delete(':id/attachments/:attachmentId')
    @ApiOperation({ summary: 'Detach an upload from an Agent' })
    @HttpCode(HttpStatus.OK)
    async removeAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    ) {
        return this.service.removeAttachment(
            auth.userId,
            id,
            attachmentId,
            this.scopeContext?.getScope(),
        );
    }
}
