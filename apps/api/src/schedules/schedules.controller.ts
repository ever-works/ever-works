import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { SchedulesService } from '@ever-works/agent/schedules';
import type {
    ScheduleOwnerType,
    ScheduleSourceType,
    ScheduleView,
} from '@ever-works/agent/schedules';
import { ScheduleQueryDto } from './dto/schedules-query.dto';

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
 */
@ApiTags('Schedules')
@ApiBearerAuth('JWT-auth')
@Controller('api/schedules')
export class SchedulesController {
    constructor(
        private readonly schedulesService: SchedulesService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get()
    @ApiOperation({
        summary: "List the current user's schedules",
        description:
            'Read-only aggregation of every scheduled source the user owns (recurring tasks, agent heartbeats, work schedules, mission ticks, source-validation, data-sync), sorted by next run ascending (nulls last).',
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
}
