// Mock agent-package barrels at module-load time so importing the service
// doesn't drag in real TypeORM entities (which fail jest path resolution for
// agent-internal `@src/items-generator/*` imports).
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: Symbol('CACHE_MANAGER') }));
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
    },
    ActivityStatus: {
        PENDING: 'pending',
        IN_PROGRESS: 'in_progress',
        COMPLETED: 'completed',
        FAILED: 'failed',
        CANCELLED: 'cancelled',
    },
}));

import type { Cache } from '@ever-works/agent/cache';
import { ActivityActionType } from '@ever-works/agent/entities';
import { ActivityFeedService } from '../activity-feed.service';
import { FeedQueryDto } from '../dto/feed-query.dto';

type ActivityLogMock = { findAll: jest.Mock };
type HistoryRepoMock = { findByWorkFiltered: jest.Mock };
type DirectoryClientMock = { fetchActivityFeed: jest.Mock };
type WorkRepoMock = { findById: jest.Mock; updatePlatformSyncStatus: jest.Mock };
type CacheMock = { get: jest.Mock; set: jest.Mock; del: jest.Mock };

interface WorkLike {
    id: string;
    userId: string;
    platformSyncEnabled: boolean;
    platformSyncLastSuccessAt?: Date | null;
}

function makeWork(overrides: Partial<WorkLike> = {}): WorkLike {
    return {
        id: 'work-1',
        userId: 'user-1',
        platformSyncEnabled: true,
        ...overrides,
    };
}

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
    let directoryClient: DirectoryClientMock;
    let workRepo: WorkRepoMock;
    let cache: CacheMock;
    let service: ActivityFeedService;

    beforeEach(() => {
        activityLogService = { findAll: jest.fn() };
        historyRepo = { findByWorkFiltered: jest.fn() };
        directoryClient = { fetchActivityFeed: jest.fn() };
        workRepo = { findById: jest.fn(), updatePlatformSyncStatus: jest.fn() };
        cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
        service = new ActivityFeedService(
            activityLogService as never,
            historyRepo as never,
            directoryClient as never,
            workRepo as never,
            cache as unknown as Cache,
        );
    });

    describe('cache', () => {
        it('returns cached response without calling sources', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            const cached = {
                entries: [],
                nextCursor: null,
                serverTime: '2026-05-12T11:00:00.000Z',
            };
            cache.get.mockResolvedValue(cached);

            const result = await service.compose('work-1', 'user-1', new FeedQueryDto());

            expect(result).toBe(cached);
            expect(activityLogService.findAll).not.toHaveBeenCalled();
            expect(historyRepo.findByWorkFiltered).not.toHaveBeenCalled();
            expect(directoryClient.fetchActivityFeed).not.toHaveBeenCalled();
        });

        it('writes to cache after composing on a miss', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
            directoryClient.fetchActivityFeed.mockResolvedValue({
                ok: true,
                entries: [],
                nextCursor: null,
            });

            await service.compose('work-1', 'user-1', new FeedQueryDto());

            expect(cache.set).toHaveBeenCalledTimes(1);
            const [key, value, ttl] = cache.set.mock.calls[0];
            expect(key).toMatch(/^activity-feed:work-1:/);
            expect(ttl).toBe(30_000);
            expect(value.entries).toEqual([]);
        });
    });

    describe('merging', () => {
        it('merges sources sorted timestamp DESC and truncates to limit', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);

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
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });

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
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
            activityLogService.findAll.mockResolvedValue({
                activities: [makeActivityLog()],
                total: 1,
            });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });

            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());
            expect(response.nextCursor).toBeNull();
        });
    });

    describe('category filtering', () => {
        it('users category skips activity-log and history, only calls directory client', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });

            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);

            expect(activityLogService.findAll).not.toHaveBeenCalled();
            expect(historyRepo.findByWorkFiltered).not.toHaveBeenCalled();
            expect(directoryClient.fetchActivityFeed).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'work-1' }),
                expect.objectContaining({ types: ['users'] }),
            );
        });

        it('deployment category only queries activity-log', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
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
            expect(directoryClient.fetchActivityFeed).not.toHaveBeenCalled();
        });
    });

    describe('degraded propagation', () => {
        it('surfaces directory-site degraded reason in the response and updates lastError', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
            directoryClient.fetchActivityFeed.mockResolvedValue({
                ok: false,
                degraded: { reason: 'timeout', detail: 'after 5s' },
            });
            workRepo.updatePlatformSyncStatus.mockResolvedValue(undefined);

            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());

            expect(response.degraded?.directorySite?.reason).toBe('timeout');
            await new Promise((resolve) => setImmediate(resolve));
            expect(workRepo.updatePlatformSyncStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({ lastError: expect.stringContaining('timeout') }),
            );
        });

        it('records lastSuccessAt when all sources succeeded', async () => {
            workRepo.findById.mockResolvedValue(makeWork());
            cache.get.mockResolvedValue(null);
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });
            workRepo.updatePlatformSyncStatus.mockResolvedValue(undefined);

            await service.compose('work-1', 'user-1', new FeedQueryDto());
            await new Promise((resolve) => setImmediate(resolve));

            expect(workRepo.updatePlatformSyncStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({ lastSuccessAt: expect.any(Date), lastError: null }),
            );
        });
    });

    describe('defensive guards', () => {
        it('returns an empty response when the work cannot be found', async () => {
            workRepo.findById.mockResolvedValue(null);
            const response = await service.compose('missing', 'user-1', new FeedQueryDto());
            expect(response.entries).toEqual([]);
            expect(cache.set).not.toHaveBeenCalled();
        });
    });

    describe('cache invalidation', () => {
        it('deletes the per-Work cache keys on work-event', async () => {
            await service.onWorkEvent({ workId: 'work-42' });
            expect(cache.del).toHaveBeenCalledWith('activity-feed:work-42:all:50:null');
            expect(cache.del).toHaveBeenCalledWith('activity-feed:work-42:generation:50:null');
        });

        it('ignores events without a workId payload', async () => {
            await service.onWorkEvent({} as never);
            expect(cache.del).not.toHaveBeenCalled();
        });
    });
});
