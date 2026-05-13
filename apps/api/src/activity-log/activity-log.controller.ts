import {
    Body,
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    Query,
    Res,
    DefaultValuePipe,
    ParseIntPipe,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiQuery,
    ApiParam,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { WorkRepository } from '@ever-works/agent/database';
import type { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { IngestEventDto } from './dto/ingest-event.dto';
import { PlatformSecretGuard } from './guards/platform-secret.guard';

type CsvResponse = {
    setHeader(name: string, value: string): void;
    send(body: string): void;
};

const ACTIVITY_RECONCILE_TTL_MS = 5000;

@ApiTags('Activity Log')
@ApiBearerAuth('JWT-auth')
@Controller('api/activity-log')
export class ActivityLogController {
    private readonly reconcileInFlight = new Map<string, Promise<void>>();
    private readonly reconcileCompletedAt = new Map<string, number>();

    constructor(
        private readonly activityLogService: ActivityLogService,
        private readonly workRepository: WorkRepository,
    ) {}

    private async reconcileActivities(userId: string) {
        const existing = this.reconcileInFlight.get(userId);
        if (existing) {
            await existing;
            return;
        }

        const lastCompletedAt = this.reconcileCompletedAt.get(userId);
        if (
            typeof lastCompletedAt === 'number' &&
            Date.now() - lastCompletedAt < ACTIVITY_RECONCILE_TTL_MS
        ) {
            return;
        }

        const reconcilePromise: Promise<void> = this.activityLogService
            .reconcileStaleGenerationActivities(userId)
            .then(() => {
                this.reconcileCompletedAt.set(userId, Date.now());
            })
            .catch(() => {
                // Activity listing should remain available even if stale-state cleanup fails.
            })
            .finally(() => {
                if (this.reconcileInFlight.get(userId) === reconcilePromise) {
                    this.reconcileInFlight.delete(userId);
                }
            });

        this.reconcileInFlight.set(userId, reconcilePromise);
        await reconcilePromise;
    }

    @Get()
    @ApiOperation({
        summary: 'List activity log entries',
        description: 'Get paginated, filtered activity log for the current user',
    })
    @ApiQuery({ name: 'actionType', required: false, description: 'Filter by action type' })
    @ApiQuery({ name: 'workId', required: false, description: 'Filter by work' })
    @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
    @ApiQuery({ name: 'dateFrom', required: false, description: 'Start of date range (ISO)' })
    @ApiQuery({ name: 'dateTo', required: false, description: 'End of date range (ISO)' })
    @ApiQuery({ name: 'search', required: false, description: 'Search summary and work name' })
    @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
    @ApiQuery({ name: 'offset', required: false, description: 'Pagination offset' })
    @ApiResponse({ status: 200, description: 'Activity log entries with total count' })
    async getActivities(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('actionType') actionType?: string,
        @Query('workId') workId?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
        @Query('search') search?: string,
        @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
    ) {
        await this.reconcileActivities(auth.userId);

        const result = await this.activityLogService.findAll({
            userId: auth.userId,
            actionType: actionType as ActivityActionType,
            workId,
            status: status as ActivityStatus,
            dateFrom: dateFrom ? new Date(dateFrom) : undefined,
            dateTo: dateTo ? new Date(dateTo) : undefined,
            search,
            limit: Math.min(limit!, 100),
            offset,
        });

        return {
            activities: result.activities,
            total: result.total,
        };
    }

    @Get('running-count')
    @ApiOperation({
        summary: 'Get count of running operations',
        description: 'Returns the number of in-progress activities for the sidebar badge',
    })
    @ApiResponse({ status: 200, description: 'Running operations count' })
    async getRunningCount(@CurrentUser() auth: AuthenticatedUser) {
        await this.reconcileActivities(auth.userId);

        const count = await this.activityLogService.countRunning(auth.userId);
        return { count };
    }

    @Get('summary')
    @ApiOperation({
        summary: 'Get activity log summary counts',
        description: 'Returns counts grouped by activity status for the current user',
    })
    @ApiResponse({ status: 200, description: 'Activity summary counts' })
    async getSummary(@CurrentUser() auth: AuthenticatedUser) {
        await this.reconcileActivities(auth.userId);

        const counts = await this.activityLogService.summarizeStatuses(auth.userId);
        return { counts };
    }

    @Get('export')
    @ApiOperation({
        summary: 'Export activity log as CSV',
        description: 'Download activity log entries as a CSV file',
    })
    @ApiQuery({ name: 'actionType', required: false })
    @ApiQuery({ name: 'workId', required: false })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'dateFrom', required: false })
    @ApiQuery({ name: 'dateTo', required: false })
    @ApiResponse({ status: 200, description: 'CSV file download' })
    async exportCsv(
        @CurrentUser() auth: AuthenticatedUser,
        @Res() res: CsvResponse,
        @Query('actionType') actionType?: string,
        @Query('workId') workId?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        await this.reconcileActivities(auth.userId);

        const csv = await this.activityLogService.exportCsv({
            userId: auth.userId,
            actionType: actionType as ActivityActionType,
            workId,
            status: status as ActivityStatus,
            dateFrom: dateFrom ? new Date(dateFrom) : undefined,
            dateTo: dateTo ? new Date(dateTo) : undefined,
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=activity-log.csv');
        res.send(csv);
    }

    @Post('ingest')
    @Public()
    @UseGuards(PlatformSecretGuard)
    // The shared `PLATFORM_API_SECRET_TOKEN` is pushed to every deployed
    // site, so its blast radius if leaked is wide. Cap per-IP throughput to
    // 60/min on top of the bearer check, mitigating spam even if a token
    // is compromised before rotation lands.
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    @HttpCode(202)
    @ApiOperation({
        summary: 'Ingest a website-sourced activity event (EW-120)',
        description:
            'Called by the deployed directory site when a user registers, submits an item, or files/resolves a report. Authenticated via the `PLATFORM_API_SECRET_TOKEN` bearer token; idempotent by `(workId, eventId)`; rate-limited at 60 req/min per IP.',
    })
    @ApiResponse({ status: 202, description: 'Event accepted' })
    @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
    @ApiResponse({ status: 404, description: 'Work not found' })
    async ingestWebsiteEvent(@Body() dto: IngestEventDto) {
        try {
            const activity = await this.activityLogService.ingestFromWebsite({
                workId: dto.workId,
                eventId: dto.eventId,
                actionType: dto.actionType,
                occurredAt: new Date(dto.occurredAt),
                summary: dto.summary,
                metadata: dto.metadata,
            });
            return { id: activity.id };
        } catch (err) {
            if (err instanceof Error && /not found/i.test(err.message)) {
                throw new NotFoundException(err.message);
            }
            throw err;
        }
    }

    @Get(':id')
    @ApiOperation({
        summary: 'Get activity log entry details',
        description: 'Get a single activity log entry with full details',
    })
    @ApiParam({ name: 'id', description: 'Activity log entry ID' })
    @ApiResponse({ status: 200, description: 'Activity log entry details' })
    @ApiResponse({ status: 404, description: 'Activity not found' })
    async getActivity(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.reconcileActivities(auth.userId);

        const activity = await this.activityLogService.findByIdAndUserId(id, auth.userId);
        if (!activity) {
            throw new NotFoundException('Activity not found');
        }

        let liveLogs = activity.details?.liveLogs;

        if (activity.status === 'in_progress' && activity.workId) {
            const work = await this.workRepository.findById(activity.workId);
            if (work?.generateStatus?.recentLogs?.length) {
                liveLogs = work.generateStatus.recentLogs;
            }
        }

        return {
            activity: {
                ...activity,
                details: {
                    ...(activity.details ?? {}),
                    ...(liveLogs ? { liveLogs } : {}),
                },
            },
        };
    }
}
