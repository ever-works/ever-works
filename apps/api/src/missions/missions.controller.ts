import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    MissionCloneService,
    MissionStatus,
    MissionsService,
    type CloneMissionResult,
    type MissionDto,
    type MissionGuardrailsOverride,
} from '@ever-works/agent/missions';
import { BudgetService, type OwnerBudgetSummary } from '@ever-works/agent/budgets';
import { BudgetOwnerType } from '@ever-works/agent/entities';
import { GoalsService, type MissionGoalLinkDto } from '@ever-works/agent/goals';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { LinkMissionGoalDto } from '../goals/dto/goal.dto';
import {
    AddMissionAttachmentDto,
    AttachMissionWorkDto,
    CloneMissionDto,
    CompleteMissionDto,
    CreateMissionDto,
    UpdateMissionDto,
} from './dto/mission.dto';
import {
    MISSION_WORK_RELATIONS,
    MissionOutcome,
    type MissionWorkRelation,
} from '@ever-works/agent/entities';

/**
 * Phase 3 PR H — full Missions CRUD + lifecycle surface
 * (Missions/Ideas/Works build).
 *
 * Endpoints:
 *   GET    /api/me/missions              list mine
 *   POST   /api/me/missions              create
 *   GET    /api/me/missions/:id          get one
 *   PATCH  /api/me/missions/:id          partial update
 *   DELETE /api/me/missions/:id          delete (any status)
 *   POST   /api/me/missions/:id/pause    ACTIVE → PAUSED
 *   POST   /api/me/missions/:id/resume   PAUSED → ACTIVE
 *   POST   /api/me/missions/:id/complete (ACTIVE | PAUSED) → COMPLETED
 *   POST   /api/me/missions/:id/run-now  manually trigger a tick (placeholder)
 *
 * Phase 3 PR HH adds `POST /:id/clone`; PR J wires the actual
 * Trigger.dev tick dispatch.
 *
 * Decorated with @ApiTags('missions') + @ApiOperation per
 * Decision A19 so the Phase 9 PR Z2 MCP whitelist auto-derivation
 * picks each route up.
 *
 * Write endpoints are rate-limited to 30/min — looser than the
 * 10/min on /me/work-proposals (Phase 1 PR B) because Mission
 * operations are coarser (one Mission tends to spawn many Ideas)
 * and users may flip toggles via settings UI.
 */
@ApiTags('missions')
@Controller('api/me/missions')
export class MissionsController {
    constructor(
        private readonly service: MissionsService,
        // Phase 3 PR HH — Mission Clone (Full Fork).
        private readonly cloneService: MissionCloneService,
        // Phase 7 PR U — per-Mission budget summary.
        private readonly budgetService: BudgetService,
        // Goals & Metrics PR-8 — Mission ↔ Goal link surface. The
        // GoalsService validates ownership of BOTH sides (Mission and
        // Goal) with 404-no-leak semantics.
        private readonly goalsService: GoalsService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'List my missions' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('status') status?: string,
        @Query('search') search?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<MissionDto[]> {
        return this.service.listForUser(auth.userId, {
            status: this.parseStatus(status),
            search: this.parseSearch(search),
            limit: this.parseLimit(limit),
            offset: this.parseOffset(offset),
        });
    }

    @Post()
    @ApiOperation({ summary: 'Create a new mission' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateMissionDto,
    ): Promise<MissionDto> {
        return this.service.create(auth.userId, {
            title: body.title,
            description: body.description,
            type: body.type,
            schedule: body.schedule ?? null,
            autoBuildWorks: body.autoBuildWorks,
            outstandingIdeasCap: body.outstandingIdeasCap ?? null,
            guardrailsOverride:
                (body.guardrailsOverride as MissionGuardrailsOverride | null | undefined) ?? null,
            missionTemplateRepo: body.missionTemplateRepo ?? null,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one mission' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.getForUser(auth.userId, id);
    }

    @Get(':id/budget')
    @ApiOperation({
        summary:
            'Current period spend + cap status for this Mission (Phase 7 PR U). Plugin-scoped caps not surfaced in v1.',
    })
    @HttpCode(HttpStatus.OK)
    async budget(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<OwnerBudgetSummary> {
        // Phase 7 PR U — ownership gate first so an unrelated user
        // can't introspect another user's per-Mission spend. The
        // service.getForUser call 404s when the Mission belongs to
        // another user, which translates to the standard NestJS
        // 404 response shape.
        await this.service.getForUser(auth.userId, id);
        return this.budgetService.summarizeForOwner({
            ownerType: BudgetOwnerType.MISSION,
            ownerId: id,
        });
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update mission fields (partial)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateMissionDto,
    ): Promise<MissionDto> {
        return this.service.update(auth.userId, id, {
            title: body.title,
            description: body.description,
            type: body.type,
            schedule: body.schedule,
            autoBuildWorks: body.autoBuildWorks,
            outstandingIdeasCap: body.outstandingIdeasCap,
            guardrailsOverride: body.guardrailsOverride as
                | MissionGuardrailsOverride
                | null
                | undefined,
            missionTemplateRepo: body.missionTemplateRepo,
        });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a mission (allowed from any status)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.delete(auth.userId, id);
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a mission (ACTIVE → PAUSED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.pause(auth.userId, id);
    }

    @Post(':id/resume')
    @ApiOperation({ summary: 'Resume a paused mission (PAUSED → ACTIVE)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.resume(auth.userId, id);
    }

    @Post(':id/complete')
    @ApiOperation({ summary: 'Mark a mission complete ((ACTIVE|PAUSED) → COMPLETED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async complete(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body?: CompleteMissionDto,
    ): Promise<MissionDto> {
        return this.service.complete(
            auth.userId,
            id,
            (body?.outcome ?? null) as MissionOutcome | null,
        );
    }

    @Post(':id/clone')
    @ApiOperation({
        summary:
            'Full-fork clone: metadata + non-DISMISSED Ideas (as PENDING) + sourceMissionId backlink. Works NOT cloned (Decisions A25, A26).',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async clone(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: CloneMissionDto,
    ): Promise<CloneMissionResult> {
        return this.cloneService.cloneForUser(auth.userId, id, {
            title: body.title,
        });
    }

    @Post(':id/run-now')
    @ApiOperation({
        summary:
            'Manually trigger a Mission tick — bypasses cron, enforces the outstanding-Ideas cap',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async runNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{
        status:
            | 'noop-placeholder'
            | 'queued'
            | 'spawned'
            | 'cap-hit'
            | 'no-ideas'
            | 'failed'
            | 'cron-no-match';
        missionId: string;
        ideasCreated?: number;
        ideasQueued?: number;
        message?: string;
    }> {
        return this.service.runNow(auth.userId, id);
    }

    /**
     * PR-2 (domain-model evolution) — the explicit Mission↔Work M:N
     * relation surface. A Mission may relate to any number of the
     * caller's Works (created|improves|operates|markets|researches|
     * retires) and one Work may be related to many Missions over its
     * lifetime. Attaching never transfers ownership and detaching /
     * deleting the Mission never touches the Work (invariants I-6/I-7).
     */
    @Get(':id/works')
    @ApiOperation({ summary: 'List the Works this Mission relates to' })
    async listWorks(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return { relations: await this.service.listWorks(auth.userId, id) };
    }

    @Post(':id/works')
    @ApiOperation({ summary: 'Attach an existing Work to this Mission with a typed relation' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async attachWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AttachMissionWorkDto,
    ) {
        return {
            relations: await this.service.attachWork(auth.userId, id, body.workId, body.relation),
        };
    }

    @Delete(':id/works/:workId/:relation')
    @ApiOperation({ summary: 'Detach a Mission↔Work relation (the Work is untouched)' })
    @HttpCode(HttpStatus.OK)
    async detachWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('workId', ParseUUIDPipe) workId: string,
        @Param('relation') relation: string,
    ) {
        if (!MISSION_WORK_RELATIONS.includes(relation as MissionWorkRelation)) {
            throw new BadRequestException(
                `Invalid relation "${relation}". Allowed: ${MISSION_WORK_RELATIONS.join(', ')}.`,
            );
        }
        return this.service.detachWork(auth.userId, id, workId, relation as MissionWorkRelation);
    }

    /**
     * PR-2 — reverse lookup for the Work-detail "Missions" panel:
     * which of my Missions relate to this Work. Kept under /me/missions
     * (owner-scoped like everything else here); declared with a static
     * prefix so it can't shadow the ':id' param routes.
     */
    @Get('related-to-work/:workId')
    @ApiOperation({ summary: 'List my Missions related to a Work' })
    async listMissionsForWork(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId', ParseUUIDPipe) workId: string,
    ) {
        return { relations: await this.service.listMissionsForWork(auth.userId, workId) };
    }

    /**
     * Mission attachment surface — list/add/remove `MissionAttachment`
     * edges (FK to `work_knowledge_uploads`). Backs the
     * PromptComposer's "files attached when creating a Mission" flow:
     * the composer uploads via `POST /api/uploads/file` and then the
     * caller hits `POST /api/me/missions/:id/attachments` to associate.
     *
     * Same security model as the rest of this controller — ownership
     * is enforced inside `MissionsService.{list,add,remove}Attachment`.
     */
    @Get(':id/attachments')
    @ApiOperation({ summary: "List a Mission's attached uploads" })
    async listAttachments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.listAttachments(auth.userId, id);
    }

    @Post(':id/attachments')
    @ApiOperation({ summary: 'Attach an uploaded file to a Mission' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async addAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AddMissionAttachmentDto,
    ) {
        return this.service.addAttachment(auth.userId, id, body?.uploadId);
    }

    @Delete(':id/attachments/:attachmentId')
    @ApiOperation({ summary: 'Detach an upload from a Mission' })
    @HttpCode(HttpStatus.OK)
    async removeAttachment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    ) {
        return this.service.removeAttachment(auth.userId, id, attachmentId);
    }

    /**
     * Goals & Metrics PR-8 — Mission ↔ Goal links (spec FR-11).
     * Goals are created standalone via `POST /api/me/goals` and
     * attached here. At most one primary Goal per Mission — linking
     * with `isPrimary: true` demotes any existing primary.
     *
     * Invariant I-4 note: Goal state never feeds back into Mission
     * status through these endpoints (or anywhere else) — a Mission
     * is completed only by an explicit human action.
     */
    @Get(':id/goals')
    @ApiOperation({ summary: "List a Mission's attached Goals (with isPrimary flags)" })
    @HttpCode(HttpStatus.OK)
    async listGoals(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionGoalLinkDto[]> {
        return this.goalsService.listForMission(auth.userId, id);
    }

    @Post(':id/goals')
    @ApiOperation({
        summary:
            'Attach a Goal to a Mission (idempotent; re-POST updates isPrimary; one primary per Mission)',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async linkGoal(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: LinkMissionGoalDto,
    ): Promise<MissionGoalLinkDto> {
        return this.goalsService.linkToMission(
            auth.userId,
            id,
            body.goalId,
            body.isPrimary ?? false,
        );
    }

    @Delete(':id/goals/:goalId')
    @ApiOperation({ summary: 'Detach a Goal from a Mission (the Goal itself is untouched)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async unlinkGoal(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('goalId', ParseUUIDPipe) goalId: string,
    ): Promise<{ deleted: true }> {
        return this.goalsService.unlinkFromMission(auth.userId, id, goalId);
    }

    private parseStatus(value?: string): MissionStatus | undefined {
        if (!value) return undefined;
        if (!Object.values(MissionStatus).includes(value as MissionStatus)) {
            throw new BadRequestException(`Invalid status filter: ${value}`);
        }
        return value as MissionStatus;
    }

    private parseSearch(value?: string): string | undefined {
        const trimmed = value?.trim();
        if (!trimmed) return undefined;
        if (trimmed.length > 500) {
            throw new BadRequestException('search must be 500 characters or fewer.');
        }
        return trimmed;
    }

    private parseLimit(value?: string): number | undefined {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n)) {
            throw new BadRequestException('limit must be an integer.');
        }
        return Math.min(101, Math.max(1, n));
    }

    private parseOffset(value?: string): number | undefined {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n)) {
            throw new BadRequestException('offset must be an integer.');
        }
        return Math.max(0, n);
    }
}
