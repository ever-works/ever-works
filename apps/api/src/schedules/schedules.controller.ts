import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { SchedulesService } from '@ever-works/agent/schedules';
import type {
    ScheduleOwnerType,
    ScheduleSourceType,
    ScheduleView,
} from '@ever-works/agent/schedules';

const SOURCE_TYPES: ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
];

const OWNER_TYPES: ScheduleOwnerType[] = ['task', 'agent', 'work', 'mission'];

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
    @ApiQuery({
        name: 'sourceType',
        required: false,
        description: 'Filter to one schedule source type',
    })
    @ApiQuery({
        name: 'entityKind',
        required: false,
        description: 'Filter to one owning entity kind (task | agent | work | mission)',
    })
    @ApiQuery({
        name: 'enabledOnly',
        required: false,
        description: 'When "true", drop paused/disabled/ended schedules',
    })
    @ApiResponse({ status: 200, description: 'Unified schedule read-model' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('sourceType') sourceType?: string,
        @Query('entityKind') entityKind?: string,
        @Query('enabledOnly') enabledOnly?: string,
    ): Promise<ScheduleView[]> {
        const filters: {
            sourceType?: ScheduleSourceType;
            ownerType?: ScheduleOwnerType;
            enabledOnly?: boolean;
        } = {};
        if (sourceType && SOURCE_TYPES.includes(sourceType as ScheduleSourceType)) {
            filters.sourceType = sourceType as ScheduleSourceType;
        }
        if (entityKind && OWNER_TYPES.includes(entityKind as ScheduleOwnerType)) {
            filters.ownerType = entityKind as ScheduleOwnerType;
        }
        if (enabledOnly === 'true') {
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
