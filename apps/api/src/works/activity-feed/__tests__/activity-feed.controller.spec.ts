// Mock the agent-package barrels first so importing the controller does not
// pull the real WorkOwnershipService / TypeORM entities. Mirrors the
// convention in `activity-log.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: Symbol('CACHE_MANAGER') }));
jest.mock('@ever-works/agent/entities', () => ({
    // Importing the controller transitively loads `activity-feed.service`
    // which references these enum values at module top-level. Stub them
    // with their actual string-enum values.
    ActivityActionType: {
        GENERATION: 'generation',
        COMPARISON_GENERATION: 'comparison_generation',
        DEPLOYMENT: 'deployment',
        ITEM_ADDED: 'item_added',
        ITEM_UPDATED: 'item_updated',
        ITEM_REMOVED: 'item_removed',
        SETTINGS_UPDATED: 'settings_updated',
        WEBSITE_SETTINGS_UPDATED: 'website_settings_updated',
        PROMPTS_UPDATED: 'prompts_updated',
        WORKS_CONFIG_SYNC: 'works_config_sync',
        PLUGIN_ENABLED: 'plugin_enabled',
        PLUGIN_DISABLED: 'plugin_disabled',
        PLUGIN_CONFIGURED: 'plugin_configured',
        TEMPLATE_ADDED: 'template_added',
        TEMPLATE_UPDATED: 'template_updated',
        TEMPLATE_FORKED: 'template_forked',
        TEMPLATE_ARCHIVED: 'template_archived',
        TEMPLATE_DEFAULT_SET: 'template_default_set',
        WORK_UPDATED: 'work_updated',
        WORK_CREATED: 'work_created',
        SCHEDULE_CREATED: 'schedule_created',
        SCHEDULE_UPDATED: 'schedule_updated',
        SCHEDULE_DELETED: 'schedule_deleted',
        SCHEDULE_EXECUTED: 'schedule_executed',
        COMMUNITY_PR_MERGED: 'community_pr_merged',
        WEBSITE_USER_REGISTERED: 'website_user_registered',
        WEBSITE_ITEM_SUBMITTED: 'website_item_submitted',
        WEBSITE_REPORT_FILED: 'website_report_filed',
        WEBSITE_REPORT_RESOLVED: 'website_report_resolved',
    },
}));

import { ForbiddenException } from '@nestjs/common';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import { ActivityFeedController } from '../activity-feed.controller';
import type { ActivityFeedService } from '../activity-feed.service';
import { FeedQueryDto } from '../dto/feed-query.dto';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import type { FeedResponse } from '../dto/feed-response.dto';

describe('ActivityFeedController', () => {
    let ownershipService: jest.Mocked<Pick<WorkOwnershipService, 'ensureAccess'>>;
    let activityFeedService: jest.Mocked<Pick<ActivityFeedService, 'compose'>>;
    let controller: ActivityFeedController;

    const auth: AuthenticatedUser = {
        userId: 'user-1',
        email: 'a@b.c',
        username: 'a',
        provider: 'jwt',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    };

    beforeEach(() => {
        ownershipService = { ensureAccess: jest.fn() } as never;
        activityFeedService = { compose: jest.fn() } as never;
        controller = new ActivityFeedController(
            ownershipService as unknown as WorkOwnershipService,
            activityFeedService as unknown as ActivityFeedService,
        );
    });

    it('enforces access via ownership service before composing', async () => {
        const fakeResponse: FeedResponse = {
            entries: [],
            nextCursor: null,
            serverTime: new Date().toISOString(),
        };
        ownershipService.ensureAccess.mockResolvedValue({} as never);
        activityFeedService.compose.mockResolvedValue(fakeResponse);

        const query = new FeedQueryDto();
        query.limit = 10;
        const result = await controller.getActivityFeed(auth, 'work-1', query);

        expect(ownershipService.ensureAccess).toHaveBeenCalledWith('work-1', 'user-1');
        expect(activityFeedService.compose).toHaveBeenCalledWith('work-1', 'user-1', query);
        expect(result).toBe(fakeResponse);
    });

    it('propagates ForbiddenException from ownership service without calling compose', async () => {
        ownershipService.ensureAccess.mockRejectedValue(new ForbiddenException('no access'));

        const query = new FeedQueryDto();
        await expect(controller.getActivityFeed(auth, 'work-1', query)).rejects.toThrow(
            ForbiddenException,
        );
        expect(activityFeedService.compose).not.toHaveBeenCalled();
    });
});
