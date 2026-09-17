import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    Post,
    Query,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { ScheduleControlService, SchedulesService } from '@ever-works/agent/schedules';
import type {
    ScheduleHealthSummary,
    ScheduleOwnerType,
    SchedulePage,
    SchedulePageFilters,
    ScheduleRunNowResult,
    ScheduleSourceType,
    ScheduleView,
} from '@ever-works/agent/schedules';
import { ScheduleQueryDto } from './dto/schedules-query.dto';
import { PauseScheduleDto, SchedulePageQueryDto } from './dto/schedules-page-query.dto';
import { ParseScheduleIdPipe } from './pipes/parse-schedule-id.pipe';

/**
 * Schedules ("Cadence") — read-only aggregation endpoint (spec §4.1).
 *
 * `GET /api/schedules` returns the caller's unified schedule read-model:
 * one `ScheduleView` per recurring Task / Agent heartbeat / Work schedule
 * / Mission tick / source-validation check / data-sync poll, sorted by
 * next run. Auth-guarded by the global `AuthSessionGuard`; scope-aware
 * via the request-scoped `ScopeContextService` (personal scope filters
 * `organizationId IS NULL`). There is no cross-user path — every source
 * query filters by `userId`, so isolation is structural (404-never-403).
 *
 * Schedules workspace: the paged read, the health dry run and the three
 * row controls. Literal segments (`page`, `health`) are declared before the
 * `:id` routes, and a schedule id is validated by `ParseScheduleIdPipe`,
 * never `ParseUUIDPipe` — it is `${sourceType}:${ownerId}`.
 */
@ApiTags('Schedules')
@ApiBearerAuth('JWT-auth')
@Controller('api/schedules')
export class SchedulesController {
    constructor(
        private readonly schedulesService: SchedulesService,
        private readonly scopeContext: ScopeContextService,
        // Schedules workspace controls. Appended LAST + @Optional() so the
        // positional construction in the existing spec keeps compiling; a
        // module graph without it answers 503 on the control routes only.
        @Optional() private readonly controls?: ScheduleControlService,
    ) {}

    @Get()
    @ApiOperation({
        summary: "List the current user's schedules",
        description:
            'Read-only aggregation of every scheduled source the user owns (recurring tasks, agent heartbeats, work schedules, mission ticks, source-validation, data-sync, inbound triggers), sorted by next run ascending (nulls last).',
    })
    @ApiResponse({ status: 200, description: 'Unified schedule read-model' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ScheduleQueryDto,
    ): Promise<ScheduleView[]> {
        const filters: {
            sourceType?: ScheduleSourceType;
            ownerType?: ScheduleOwnerType;
            enabledOnly?: boolean;
        } = {};
        if (query.sourceType) {
            filters.sourceType = query.sourceType;
        }
        if (query.entityKind) {
            filters.ownerType = query.entityKind;
        }
        if (query.enabledOnly) {
            filters.enabledOnly = true;
        }

        return this.schedulesService.getSchedules(
            {
                userId: auth.userId,
                organizationId: this.scopeContext.getOrganizationId(),
            },
            filters,
        );
    }

    @Get('page')
    @ApiOperation({
        summary: 'One page of the workspace Schedules list',
        description:
            'The same projection as GET /api/schedules, paged 50 at a time with an opaque cursor, filterable by source, owner kind, agent, status, health and text. Carries per-source counts, the unfiltered total and the sources whose query failed.',
    })
    @ApiResponse({ status: 200, description: 'One page of schedules' })
    async page(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: SchedulePageQueryDto,
    ): Promise<SchedulePage> {
        const filters: SchedulePageFilters = {};
        if (query.sourceType) filters.sourceType = query.sourceType;
        if (query.entityKind) filters.ownerType = query.entityKind;
        if (query.enabledOnly) filters.enabledOnly = true;
        if (query.agentId) filters.agentId = query.agentId;
        if (query.status) filters.status = query.status;
        if (query.health) filters.health = query.health;
        if (query.q) filters.q = query.q;

        return this.schedulesService.getPage(
            { userId: auth.userId, organizationId: this.scopeContext.getOrganizationId() },
            filters,
            query.cursor ?? null,
            query.limit,
        );
    }

    @Get('health')
    @ApiOperation({
        summary: 'Schedules that will never run — a dry run',
        description:
            'Counts every Schedule that cannot fire and lists up to 200 of them with the exact before / after a repair would use. Side-effect free.',
    })
    @ApiResponse({ status: 200, description: 'Health summary' })
    async health(@CurrentUser() auth: AuthenticatedUser): Promise<ScheduleHealthSummary> {
        return this.schedulesService.getHealthSummary({
            userId: auth.userId,
            organizationId: this.scopeContext.getOrganizationId(),
        });
    }

    @Post(':id/run-now')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Run a schedule now, out of band',
        description:
            'Dispatches one fire immediately without moving the next scheduled fire. A recurring task or heartbeat returns the run ids; a mission tick raises ideas and returns the mission link instead. 409 codes: SCHEDULE_ALREADY_RUNNING, SCHEDULE_NO_AGENT, SCHEDULE_OWNER_ARCHIVED, SCHEDULE_CONTROL_UNAVAILABLE. 404 for a schedule that is not yours.',
    })
    async runNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseScheduleIdPipe) id: string,
    ): Promise<ScheduleRunNowResult> {
        return this.requireControls().runNow(this.context(auth), id);
    }

    @Post(':id/pause')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Pause a schedule, keeping its cadence',
        description:
            'Pauses without deleting anything. A mission tick requires acknowledgeMissionPause=true (409 MISSION_PAUSE_NOT_ACKNOWLEDGED otherwise), because it pauses the whole mission. Returns the refreshed row.',
    })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseScheduleIdPipe) id: string,
        @Body() body: PauseScheduleDto,
    ): Promise<ScheduleView> {
        return this.requireControls().pause(this.context(auth), id, {
            acknowledgeMissionPause: body?.acknowledgeMissionPause === true,
        });
    }

    @Post(':id/resume')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Resume a paused schedule',
        description:
            'Restores firing with the cadence it had. Fires missed while paused are not replayed. Returns the refreshed row.',
    })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseScheduleIdPipe) id: string,
    ): Promise<ScheduleView> {
        return this.requireControls().resume(this.context(auth), id);
    }

    private context(auth: AuthenticatedUser) {
        const scope = this.scopeContext.getScope();
        return {
            userId: auth.userId,
            tenantId: scope?.tenantId ?? null,
            organizationId: scope?.organizationId ?? null,
        };
    }

    private requireControls(): ScheduleControlService {
        if (!this.controls) {
            throw new ServiceUnavailableException('Schedule controls are not available.');
        }
        return this.controls;
    }
}
