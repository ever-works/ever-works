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

type ActivityLogMock = { findByWork: jest.Mock };
type HistoryRepoMock = { findByWorkFiltered: jest.Mock };
type WorkRepoMock = { findById: jest.Mock; updatePlatformSyncStatus: jest.Mock };
type DirectoryClientMock = { fetchActivityFeed: jest.Mock };

function makeWork(overrides: Record<string, unknown> = {}) {
    return {
        id: 'work-1',
        activitySyncMode: 'push', // default for tests that don't care
        website: 'https://example.com',
        platformSyncLastSuccessAt: null,
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
    let workRepo: WorkRepoMock;
    let directoryClient: DirectoryClientMock;
    let service: ActivityFeedService;

    beforeEach(() => {
        activityLogService = { findByWork: jest.fn() };
        historyRepo = { findByWorkFiltered: jest.fn() };
        workRepo = {
            findById: jest.fn().mockResolvedValue(makeWork()),
            updatePlatformSyncStatus: jest.fn().mockResolvedValue(undefined),
        };
        directoryClient = { fetchActivityFeed: jest.fn() };
        service = new ActivityFeedService(
            activityLogService as never,
            historyRepo as never,
            workRepo as never,
            directoryClient as never,
        );
    });

    it('passes the FULL requested limit to each top-level source (no perSourceLimit division)', async () => {
        // Codex P1 review fix (2026-05-13): the previous design divided
        // `limit / sourceCount` per source, which could drop newer events
        // from a dominant source. Pin the new contract: each source gets
        // the caller's `limit` budget; `mergeEntries(..., limit)` still
        // trims to the final budget.
        activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
        historyRepo.findByWorkFiltered.mockResolvedValue([]);

        const query = new FeedQueryDto();
        query.limit = 50;
        await service.compose('work-1', 'user-1', query);

        const activityCall = activityLogService.findByWork.mock.calls[0][0] as { limit: number };
        expect(activityCall.limit).toBe(50);
        const historyCall = historyRepo.findByWorkFiltered.mock.calls[0];
        // findByWorkFiltered(workId, limit, offset, types, before)
        expect(historyCall[1]).toBe(50);
    });

    it('does NOT pass userId to ActivityLogService — member viewers see owner-attributed rows', async () => {
        activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });

        const query = new FeedQueryDto();
        query.category = 'deployment';
        await service.compose('work-1', 'member-not-owner', query);

        const call = activityLogService.findByWork.mock.calls[0][0] as Record<string, unknown>;
        expect(call.workId).toBe('work-1');
        expect(call).not.toHaveProperty('userId');
    });

    describe('merging', () => {
        it('merges sources sorted timestamp DESC and truncates to limit', async () => {
            activityLogService.findByWork.mockResolvedValue({
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
            expect(response.nextCursor).toBe('2026-05-12T11:00:00.000Z');
        });

        it('omits nextCursor when fewer entries than limit are returned', async () => {
            activityLogService.findByWork.mockResolvedValue({
                activities: [makeActivityLog()],
                total: 1,
            });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);

            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());
            expect(response.nextCursor).toBeNull();
        });
    });

    describe('push-mode category filtering (default)', () => {
        beforeEach(() => {
            workRepo.findById.mockResolvedValue(makeWork({ activitySyncMode: 'push' }));
        });

        it('users category queries activity-log with WEBSITE_USER_REGISTERED (single IN query)', async () => {
            activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);

            // One call (not per-type fan-out) with the type array.
            expect(activityLogService.findByWork).toHaveBeenCalledTimes(1);
            const call = activityLogService.findByWork.mock.calls[0][0] as {
                workId: string;
                actionType: string[];
            };
            expect(call.workId).toBe('work-1');
            expect(call.actionType).toEqual([ActivityActionType.WEBSITE_USER_REGISTERED]);
            expect(directoryClient.fetchActivityFeed).not.toHaveBeenCalled();
        });

        it('reports category queries both WEBSITE_REPORT_* types in a single IN query', async () => {
            activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
            const query = new FeedQueryDto();
            query.category = 'reports';
            await service.compose('work-1', 'user-1', query);

            // One call with the array of both types — not two parallel queries.
            expect(activityLogService.findByWork).toHaveBeenCalledTimes(1);
            const types = (activityLogService.findByWork.mock.calls[0][0] as {
                actionType: string[];
            }).actionType;
            expect([...types].sort()).toEqual(
                [
                    ActivityActionType.WEBSITE_REPORT_FILED,
                    ActivityActionType.WEBSITE_REPORT_RESOLVED,
                ].sort(),
            );
            expect(directoryClient.fetchActivityFeed).not.toHaveBeenCalled();
        });

        it('never sets response.degraded in push mode', async () => {
            activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);

            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());
            expect(response.degraded).toBeUndefined();
        });
    });

    describe('pull-mode routing (EW-120)', () => {
        beforeEach(() => {
            workRepo.findById.mockResolvedValue(makeWork({ activitySyncMode: 'pull' }));
            activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
        });

        it('users category invokes the directory client, NOT the activity-log query', async () => {
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });

            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);

            expect(directoryClient.fetchActivityFeed).toHaveBeenCalledTimes(1);
            const call = directoryClient.fetchActivityFeed.mock.calls[0];
            expect(call[1]).toEqual(expect.objectContaining({ types: ['users'] }));
            // Activity-log query (now a single IN-array call) must NOT
            // include WEBSITE_* — those are the directory-client's job in
            // pull mode.
            const flatTypes = activityLogService.findByWork.mock.calls.flatMap((c) => {
                const t = (c[0] as { actionType?: string | string[] }).actionType;
                return Array.isArray(t) ? t : t ? [t] : [];
            });
            expect(flatTypes).not.toContain(ActivityActionType.WEBSITE_USER_REGISTERED);
        });

        it('surfaces directory-site degraded reason in response.degraded.directorySite', async () => {
            directoryClient.fetchActivityFeed.mockResolvedValue({
                ok: false,
                degraded: { reason: 'timeout', detail: 'after 5s' },
            });

            const query = new FeedQueryDto();
            query.category = 'users';
            const response = await service.compose('work-1', 'user-1', query);

            expect(response.degraded?.directorySite?.reason).toBe('timeout');
        });

        it('writes platformSyncLastErrorMessage on degraded run', async () => {
            directoryClient.fetchActivityFeed.mockResolvedValue({
                ok: false,
                degraded: { reason: 'unauthorized', detail: 'stale secret' },
            });

            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);
            await new Promise((resolve) => setImmediate(resolve));

            expect(workRepo.updatePlatformSyncStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    lastErrorMessage: expect.stringContaining('unauthorized'),
                }),
            );
        });

        it('writes platformSyncLastSuccessAt on successful run', async () => {
            directoryClient.fetchActivityFeed.mockResolvedValue({ ok: true, entries: [] });

            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);
            await new Promise((resolve) => setImmediate(resolve));

            expect(workRepo.updatePlatformSyncStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    lastSuccessAt: expect.any(Date),
                    lastErrorMessage: null,
                }),
            );
        });
    });

    describe('disabled-mode routing (EW-120)', () => {
        beforeEach(() => {
            workRepo.findById.mockResolvedValue(makeWork({ activitySyncMode: 'disabled' }));
            activityLogService.findByWork.mockResolvedValue({ activities: [], total: 0 });
            historyRepo.findByWorkFiltered.mockResolvedValue([]);
        });

        it('never queries the directory client', async () => {
            const query = new FeedQueryDto();
            query.category = 'users';
            await service.compose('work-1', 'user-1', query);

            expect(directoryClient.fetchActivityFeed).not.toHaveBeenCalled();
        });

        it('never sets response.degraded', async () => {
            const response = await service.compose('work-1', 'user-1', new FeedQueryDto());
            expect(response.degraded).toBeUndefined();
        });
    });

    describe('defensive guards', () => {
        it('returns an empty response when the work cannot be found', async () => {
            workRepo.findById.mockResolvedValue(null);
            const response = await service.compose('missing', 'user-1', new FeedQueryDto());
            expect(response.entries).toEqual([]);
        });
    });
});
