import {
    Controller,
    Get,
    Param,
    Query,
    Res,
    DefaultValuePipe,
    ParseIntPipe,
    NotFoundException,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiQuery,
    ApiParam,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt.types';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import type { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { Response } from 'express';

@ApiTags('Activity Log')
@ApiBearerAuth('JWT-auth')
@Controller('api/activity-log')
export class ActivityLogController {
    constructor(private readonly activityLogService: ActivityLogService) {}

    @Get()
    @ApiOperation({
        summary: 'List activity log entries',
        description: 'Get paginated, filtered activity log for the current user',
    })
    @ApiQuery({ name: 'actionType', required: false, description: 'Filter by action type' })
    @ApiQuery({ name: 'directoryId', required: false, description: 'Filter by directory' })
    @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
    @ApiQuery({ name: 'dateFrom', required: false, description: 'Start of date range (ISO)' })
    @ApiQuery({ name: 'dateTo', required: false, description: 'End of date range (ISO)' })
    @ApiQuery({ name: 'search', required: false, description: 'Search summary and directory name' })
    @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
    @ApiQuery({ name: 'offset', required: false, description: 'Pagination offset' })
    @ApiResponse({ status: 200, description: 'Activity log entries with total count' })
    async getActivities(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('actionType') actionType?: string,
        @Query('directoryId') directoryId?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
        @Query('search') search?: string,
        @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
    ) {
        const result = await this.activityLogService.findAll({
            userId: auth.userId,
            actionType: actionType as ActivityActionType,
            directoryId,
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
        const counts = await this.activityLogService.summarizeStatuses(auth.userId);
        return { counts };
    }

    @Get('export')
    @ApiOperation({
        summary: 'Export activity log as CSV',
        description: 'Download activity log entries as a CSV file',
    })
    @ApiQuery({ name: 'actionType', required: false })
    @ApiQuery({ name: 'directoryId', required: false })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'dateFrom', required: false })
    @ApiQuery({ name: 'dateTo', required: false })
    @ApiResponse({ status: 200, description: 'CSV file download' })
    async exportCsv(
        @CurrentUser() auth: AuthenticatedUser,
        @Res() res: Response,
        @Query('actionType') actionType?: string,
        @Query('directoryId') directoryId?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        const csv = await this.activityLogService.exportCsv({
            userId: auth.userId,
            actionType: actionType as ActivityActionType,
            directoryId,
            status: status as ActivityStatus,
            dateFrom: dateFrom ? new Date(dateFrom) : undefined,
            dateTo: dateTo ? new Date(dateTo) : undefined,
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=activity-log.csv');
        res.send(csv);
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
        const activity = await this.activityLogService.findByIdAndUserId(id, auth.userId);
        if (!activity) {
            throw new NotFoundException('Activity not found');
        }
        return { activity };
    }
}
