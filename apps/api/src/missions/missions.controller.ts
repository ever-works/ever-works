import {
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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    MissionCloneService,
    MissionsService,
    type CloneMissionResult,
    type MissionDto,
    type MissionGuardrailsOverride,
} from '@ever-works/agent/missions';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CloneMissionDto, CreateMissionDto, UpdateMissionDto } from './dto/mission.dto';

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
    ) {}

    @Get()
    @ApiOperation({ summary: 'List my missions' })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<MissionDto[]> {
        return this.service.listForUser(auth.userId);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new mission' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
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

    @Patch(':id')
    @ApiOperation({ summary: 'Update mission fields (partial)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
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
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.delete(auth.userId, id);
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a mission (ACTIVE → PAUSED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.pause(auth.userId, id);
    }

    @Post(':id/resume')
    @ApiOperation({ summary: 'Resume a paused mission (PAUSED → ACTIVE)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.resume(auth.userId, id);
    }

    @Post(':id/complete')
    @ApiOperation({ summary: 'Mark a mission complete ((ACTIVE|PAUSED) → COMPLETED)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async complete(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MissionDto> {
        return this.service.complete(auth.userId, id);
    }

    @Post(':id/clone')
    @ApiOperation({
        summary:
            'Full-fork clone: metadata + non-DISMISSED Ideas (as PENDING) + sourceMissionId backlink. Works NOT cloned (Decisions A25, A26).',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
}
