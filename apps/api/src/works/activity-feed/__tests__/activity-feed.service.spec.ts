// Mock agent-package barrels at module-load time so importing the service
// doesn't drag in real TypeORM entities (which fail jest path resolution for
// agent-internal `@src/items-generator/*` imports).
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
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
    ActivityStatus: {
        PENDING: 'pending',
        IN_PROGRESS: 'in_progress',
        COMPLETED: 'completed',
        FAILED: 'failed',
        CANCELLED: 'cancelled',
    },
}));

import { ActivityActionType } from '@ever-works/agent/entities';
import { ActivityFeedService } from '../activity-feed.service';
import { FeedQueryDto } from '../dto/feed-query.dto';

type ActivityLogMock = { findAll: jest.Mock };
type HistoryRepoMock = { findByWorkFiltered: jest.Mock };

function makeActivityLog(overrides: Record<string, unknown> = {}) {
    return {
        id: 'al-1',
        userId: 'user-1',
        workId: 'work-1',
        actionType: ActivityActionType.DEPLOYMENT,
        action: 'deployment.completed',
        status: 'completed',
        summary: 'Deployed',
        details: null,
        createdAt: new Date('2026-05-12T10:00:00.000Z'),
        updatedAt: new Date('2026-05-12T10:00:00.000Z'),
        ...overrides,
    };
}

function makeHistoryRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'h-1',
        workId: 'work-1',
        activityType: 'generation',
        status: 'completed',
        startedAt: new Date('2026-05-12T09:00:00.000Z'),
        createdAt: new Date('2026-05-12T09:00:00.000Z'),
        newItemsCount: 3,
        updatedItemsCount: 1,
        totalItemsCount: 10,
        durationInSeconds: 42,
        ...overrides,
    };
}

describe('ActivityFeedService', () => {
    let activityLogService: ActivityLogMock;
    let historyRepo: HistoryRepoMock;
    let service: ActivityFeedService;

    beforeEach(() => {
        activityLogService = { findAll: jest.fn() };
        historyRepo = { findByWorkFiltered: jest.fn() };
        service = new ActivityFeedService(activityLogService as never, historyRepo as never);
    });

    describe('merging', () => {
        it('merges sources sorted timestamp DESC and truncates to limit', async () => {
            activityLogService.findAll.mockResolvedValue({
                activities: [
                    makeActivityLog({
                        id: 'al-new',
                        createdAt: new Date('2026-05-12T12:00:00.000Z'),
                    }),
                ],
                total: 1,
            });
            historyRepo.findByWorkFiltered.mockResolvedValue([
                makeHistoryRow({
                    id: 'h-old',
                    startedAt: new Date('2026-05-12T08:00:00.000Z'),
                }),
                makeHistoryRow({
                    id: 'h-mid',
                    startedAt: new Date('2026-05-12T11:00:00.000Z'),
                }),
            ]);

            const query = new FeedQueryDto();
            query.limit = 2;
            const response = await service.compose('work-1', 'user-1', query);

            expect(response.entries.map((e) => e.timestamp)).toEqual([
                '2026-05-12T12:00:00.000Z',
                '2026-05-12T11:00:00.000Z',
            ]);
            // When limit is exactly matched, nextCursor is set to oldest entry.
            expect(response.nextCursor).toBe('2026-05-12T11:00:00.000Z');
        });

        it('omits nextCursor when fewer entries than limit are returned', async () => {
            activityLogService.findAll.mockResolvedValue({
                activities: [makeActivityLog()],
                total: 1,
            });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);

            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());
            expect(response.nextCursor).toBeNull();
        });
    });

    describe('category filtering', () => {
        it('users category queries activity-log with WEBSITE_USER_REGISTERED and skips history', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });

            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);

            expect(activityLogService.findAll).toHaveBeenCalledTimes(1);
            expect(activityLogService.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    actionType: ActivityActionType.WEBSITE_USER_REGISTERED,
                }),
            );
            expect(historyRepo.findByWorkFiltered).not.toHaveBeenCalled();
        });

        it('reports category queries both WEBSITE_REPORT_FILED and WEBSITE_REPORT_RESOLVED', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });

            const query = new FeedQueryDto();
            query.category = 'reports';
            await service.compose('work-1', 'user-1', query);

            expect(activityLogService.findAll).toHaveBeenCalledTimes(2);
            const types = activityLogService.findAll.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(types.sort()).toEqual(
                [
                    ActivityActionType.WEBSITE_REPORT_FILED,
                    ActivityActionType.WEBSITE_REPORT_RESOLVED,
                ].sort(),
            );
        });

        it('deployment category only queries activity-log', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });

            const query = new FeedQueryDto();
            query.category = 'deployment';
            await service.compose('work-1', 'user-1', query);

            expect(activityLogService.findAll).toHaveBeenCalledTimes(1);
            expect(activityLogService.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    actionType: ActivityActionType.DEPLOYMENT,
                }),
            );
            expect(historyRepo.findByWorkFiltered).not.toHaveBeenCalled();
        });
    });
});
