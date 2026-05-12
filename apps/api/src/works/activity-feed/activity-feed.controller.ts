import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ActivityFeedService } from './activity-feed.service';
import { FeedQueryDto } from './dto/feed-query.dto';
import type { FeedResponse } from './dto/feed-response.dto';

@ApiTags('Activity Feed')
@Controller('api')
export class ActivityFeedController {
    constructor(
        private readonly ownershipService: WorkOwnershipService,
        private readonly activityFeedService: ActivityFeedService,
    ) {}

    @Get('works/:id/activity-feed')
    @ApiOperation({
        summary: 'Get directory Activity Feed',
        description:
            'Merged timeline of platform-internal events, per-Work generation history, and deployed-site events (users / submissions / reports). Used by the Activity Feed tab on the directory detail page (EW-120).',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({
        status: 200,
        description:
            'Merged feed payload with optional degraded reason for the deployed-site source.',
    })
    async getActivityFeed(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query() query: FeedQueryDto,
    ): Promise<FeedResponse> {
        // Throws ForbiddenException / NotFoundException if the user lacks access.
        await this.ownershipService.ensureAccess(id, auth.userId);
        return this.activityFeedService.compose(id, auth.userId, query);
    }
}
