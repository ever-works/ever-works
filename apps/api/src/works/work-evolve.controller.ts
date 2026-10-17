import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isAppWorkKind } from '@ever-works/contracts';
import {
    AppChangeRequestService,
    AppProvisioningService,
    EVOLVE_APP_AGENT_TEMPLATE,
    PROVISION_LABEL,
    type AppChangeRequestResult,
} from '@ever-works/agent/app-works';
import { ownershipScopeOf } from '@ever-works/agent/database';
import { AgentScope, AgentTemplatesService } from '@ever-works/agent/agents';
import { TaskRepository } from '@ever-works/agent/tasks-domain';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import {
    UpstreamPullRequestOpenService,
    type UpstreamPullRequestOpenResult,
} from '@ever-works/agent/upstream-pull-requests';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { EvolveWorkDto, ProvisionWorkDto, UpstreamPullRequestDto } from './dto/evolve-work.dto';

/**
 * APW-08 T25 + APW-04 — the App Work's "change it" and "provision it" doors.
 *
 * | Route | What |
 * |---|---|
 * | `POST /api/works/:id/evolve` | chat-to-modify: a Task on the Work for the resolved Agent, started now → `202 { taskId, taskSlug, runId, agentId, … }` |
 * | `GET  /api/works/:id/evolve` | the Work's change Tasks, newest first (the chat panel's history) |
 * | `POST /api/works/:id/provision` | APW-04 manual start (or `dryRun` inspection) |
 * | `GET  /api/works/:id/provisioning` | the open and recent `app-provision` Tasks |
 * | `POST /api/works/:id/upstream-pr` | APW-09: offer a fork branch (or a Task's branch) upstream as a draft PR |
 *
 * Everything after the Task exists is the existing Task / run machinery: follow a change
 * with `GET /api/tasks/:taskId` (status, `branchRef`, `prUrl`, `prState`, `ciState`), its
 * runs with the existing run routes, steer it through the Task chat. The controller decides
 * nothing about the change itself — the services answer a value with an `httpStatus`, and
 * that status is set verbatim (the `work-app-deploy.controller.ts` posture).
 *
 * Access: `edit` for the writes, `view` for the reads; a missing, invisible or other
 * account's Work is one `404`.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkEvolveController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly changes: AppChangeRequestService,
        private readonly provisioning: AppProvisioningService,
        private readonly tasks: TaskRepository,
        private readonly upstreamPullRequests: UpstreamPullRequestOpenService,
        // APW-08 GAP-14 — the one-click "create the evolve-app Agent" path. Optional so a
        // graph without the agents module still serves the rest of the routes.
        @Optional() private readonly agentTemplates?: AgentTemplatesService,
    ) {}

    @Post(':id/evolve')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Ask an Agent to change an App Work',
        description:
            'Creates a Task on the App Work (label `app-change`) with the request as its brief, assigned to the ' +
            'given Agent or the one APW-08’s rule resolves, and starts it through the same dispatch path as ' +
            '“Run” on the Task board (Fleet node or cloud runtime). The Agent changes the fork on the Task’s ' +
            'branch; the platform pushes it and opens a pull request into the fork’s base branch. Agents never ' +
            'merge protected branches. `warnings: ["cloudPushOff"]` means only a Fleet-node run will publish ' +
            '(APP_WORKS_CLOUD_PUSH_ENABLED is off).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({
        status: 202,
        description:
            '`{ status: "accepted", taskId, taskSlug, runId, agentId, agentSource, dispatched, parked, repository, warnings }`',
    })
    @ApiResponse({
        status: 404,
        description:
            'The Work is missing, not visible, or another account’s; or `agentNotEligible` for an unknown agentId.',
    })
    @ApiResponse({
        status: 409,
        description:
            '`agentRequired` with `candidates` (≤ 20) and, when none exist, `createFromTemplate`.',
    })
    @ApiResponse({
        status: 422,
        description: '`notAppWork`, `invalidRequest`, `agentNotEligible`, `taskCreateFailed`.',
    })
    async evolve(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: EvolveWorkDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<AppChangeRequestResult> {
        const access = await this.authorize(id, auth.userId, 'edit');
        const input = {
            work: access.work,
            actorUserId: auth.userId,
            request: body?.request ?? '',
            agentId: body?.agentId ?? null,
            channel: body?.channel ?? 'api',
        };
        let result = await this.changes.request(input);

        // GAP-14 (FR-42, S32) — the explicit one-click path. Only when the member asked for
        // it, only when the refusal says no committing Agent exists at all, and only for the
        // OWNER: the Agent is created in the owner's account, so an editor cannot mint one.
        if (
            body?.createAgentFromTemplate === true &&
            result.status === 'refused' &&
            result.code === 'agentRequired' &&
            result.createFromTemplate &&
            access.work.userId === auth.userId &&
            this.agentTemplates
        ) {
            const agent = await this.agentTemplates.createFromDefinition(
                auth.userId,
                EVOLVE_APP_AGENT_TEMPLATE,
                { scope: AgentScope.WORK, workId: access.work.id, activate: true },
                ownershipScopeOf(access.work),
            );
            result = await this.changes.request({ ...input, agentId: agent.id });
            if (result.status === 'accepted') {
                result = { ...result, agentCreated: true };
            }
        }

        response.status(result.httpStatus);
        return result;
    }

    @Get(':id/evolve')
    @ApiOperation({ summary: 'List the change Tasks of an App Work, newest first' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiQuery({ name: 'limit', required: false, description: '1–100, default 20' })
    async listChanges(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
    ) {
        const access = await this.authorize(id, auth.userId, 'view');
        const parsed = Number.parseInt(limit ?? '', 10);
        return {
            data: await this.changes.listChanges(
                access.work,
                Number.isFinite(parsed) ? parsed : 20,
            ),
        };
    }

    @Post(':id/provision')
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({
        summary: 'Provision an App Work (APW-04)',
        description:
            'Inspects the repository (Dockerfile, compose, Helm, manifests, lockfiles, env examples), drafts a ' +
            '`.works/works.yml` and validates it, then files an `app-provision` Task for the resolved Agent and ' +
            'starts it. Without an Agent the Task is filed unassigned (with an AI-refined draft when a model is ' +
            'configured) and the owner is notified. `dryRun: true` answers the inspection and creates nothing.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async provision(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ProvisionWorkDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ) {
        const access = await this.authorize(id, auth.userId, 'edit', true);
        if (body?.dryRun === true) {
            const inspection = await this.provisioning.inspect(access.work);
            response.status(HttpStatus.OK);
            const { files: _files, ...view } = inspection;
            return { status: 'inspected', ...view };
        }
        const result = await this.provisioning.start({
            workId: id,
            trigger: 'manual',
            userId: auth.userId,
            note: body?.note ?? null,
            agentId: body?.agentId ?? null,
            restart: body?.restart === true,
        });
        response.status(
            result.started || result.reason === 'alreadyProvisioning'
                ? HttpStatus.ACCEPTED
                : HttpStatus.UNPROCESSABLE_ENTITY,
        );
        return {
            status: result.started ? 'started' : 'refused',
            deduplicated: result.reason === 'alreadyProvisioning',
            ...result,
        };
    }

    @Get(':id/provisioning')
    @ApiOperation({ summary: 'The open and recent provisioning Tasks of an App Work (APW-04)' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async provisioningState(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        const access = await this.authorize(id, auth.userId, 'view', true);
        const work = access.work;
        const { rows } = await this.tasks.findByUserIdFiltered(
            work.userId,
            { workId: work.id, label: PROVISION_LABEL, limit: 10 },
            ownershipScopeOf(work),
        );
        const recent = rows.map((task) => ({
            taskId: task.id,
            taskSlug: task.slug,
            title: task.title,
            status: String(task.status),
            agentId: task.agentId ?? null,
            prUrl: task.prUrl ?? null,
            prState: task.prState ?? null,
            createdAt: task.createdAt ?? null,
            updatedAt: task.updatedAt ?? null,
        }));
        const active = recent.find((task) => !['done', 'cancelled'].includes(task.status)) ?? null;
        return { active, recent, canEdit: access.role !== 'viewer' };
    }

    @Post(':id/upstream-pr')
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({
        summary: 'Open a pull request from the fork into the upstream repository (APW-09)',
        description:
            'Offers a branch of the App Work’s fork — named, or taken from one of the Work’s Tasks — to the ' +
            'upstream repository, opened with the CALLER’s own git connection (FR-24), as a draft by default. ' +
            'Fork App Works only (`422 notAFork` for a private copy or a link).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    async upstreamPullRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpstreamPullRequestDto,
        @Res({ passthrough: true }) response: StatusOnlyResponse,
    ): Promise<UpstreamPullRequestOpenResult> {
        await this.authorize(id, auth.userId, 'edit', true);
        const result = await this.upstreamPullRequests.open({
            workId: id,
            callerUserId: auth.userId,
            taskId: body?.taskId ?? null,
            branch: body?.branch ?? null,
            title: body?.title ?? null,
            body: body?.body ?? null,
            draft: body?.draft ?? null,
            maintainerCanModify: body?.maintainerCanModify ?? null,
        });
        response.status(result.httpStatus);
        return result;
    }

    /** View/edit access to an App Work, or the one refusal each failure gets. */
    private async authorize(
        workId: string,
        userId: string,
        level: 'view' | 'edit',
        requireApp = false,
    ): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access =
                level === 'edit'
                    ? await this.ownership.ensureCanEdit(workId, userId)
                    : await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        {
                            status: 'error',
                            code: 'not_found',
                            message: `Work ${workId} not found.`,
                        },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }
        if (requireApp && !isAppWorkKind(access.work.kind)) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'notAppWork',
                    message: `Work ${workId} is not an App Work.`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }
        return access;
    }
}

/** The `@Res({ passthrough: true })` surface this controller needs — nothing else. */
interface StatusOnlyResponse {
    status(code: number): unknown;
}
