import {
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
    Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnvironmentsService, type EnvironmentDto } from '@ever-works/agent/environments';
import {
    ActivityLogService,
    ActivityActionType,
    ActivityStatus,
} from '@ever-works/agent/activity-log';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    CreateEnvironmentDto,
    ListEnvironmentsQueryDto,
    UpdateEnvironmentDto,
} from './dto/environment.dto';

/**
 * Environments (Settings → Environments) — CRUD + publish lifecycle for
 * the user's named runtime Environments.
 *
 * Auth: default JWT guard; every row is scoped to the authenticated
 * user. Cross-user access to a row = 404 (never 403 — no existence
 * leak), enforced in `EnvironmentsService.requireOwned`.
 *
 * DELETE is refused with 409 while any Agent still references the
 * Environment (service-side count), so an assignment can never dangle.
 */
@ApiTags('Environments')
@ApiBearerAuth('JWT-auth')
@Controller('api/environments')
export class EnvironmentsController {
    constructor(
        private readonly service: EnvironmentsService,
        // Best-effort lifecycle trail — same @Optional() posture as
        // AgentsController: a missing/broken activity log must never
        // break the request.
        @Optional()
        private readonly activityLog?: ActivityLogService,
    ) {}

    @Get()
    @ApiOperation({ summary: "List the caller's Environments (optionally by status)" })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListEnvironmentsQueryDto,
    ): Promise<{ data: EnvironmentDto[] }> {
        return { data: await this.service.list(auth.userId, query.status) };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Environment' })
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<EnvironmentDto> {
        return this.service.getOne(auth.userId, id);
    }

    @Post()
    @ApiOperation({ summary: 'Create an Environment (starts as draft)' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: CreateEnvironmentDto,
    ): Promise<EnvironmentDto> {
        const created = await this.service.create(auth.userId, dto);
        void this.tryLog(auth.userId, created.id, ActivityActionType.ENVIRONMENT_CREATED, {
            name: created.name,
        });
        return created;
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an Environment' })
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateEnvironmentDto,
    ): Promise<EnvironmentDto> {
        const updated = await this.service.update(auth.userId, id, dto);
        void this.tryLog(auth.userId, updated.id, ActivityActionType.ENVIRONMENT_UPDATED, {
            name: updated.name,
        });
        return updated;
    }

    @Post(':id/publish')
    @ApiOperation({ summary: 'Publish an Environment (makes it assignable to Agents)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async publish(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<EnvironmentDto> {
        const published = await this.service.publish(auth.userId, id);
        void this.tryLog(auth.userId, published.id, ActivityActionType.ENVIRONMENT_PUBLISHED, {
            name: published.name,
        });
        return published;
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an Environment (409 while any Agent references it)' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.remove(auth.userId, id);
        void this.tryLog(auth.userId, id, ActivityActionType.ENVIRONMENT_DELETED, {});
    }

    private async tryLog(
        userId: string,
        environmentId: string,
        actionType: ActivityActionType,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `environment ${environmentId} — ${actionType}`,
                details: {
                    ...details,
                    resourceType: 'environment',
                    resourceId: environmentId,
                },
            });
        } catch {
            // best-effort — log failure should never break the request.
        }
    }
}
