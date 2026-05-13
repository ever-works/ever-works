// Mock the agent-package barrels first so importing the controller does not
// pull the real ActivityLogService / WorkRepository runtime trees (TypeORM,
// nest entities, etc.). Mirrors the convention in
// `notifications.controller.spec.ts` and `activity-log.listener.spec.ts`.
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WORK_CREATED: 'WORK_CREATED',
        GENERATION: 'GENERATION',
        DEPLOYMENT: 'DEPLOYMENT',
        WEBSITE_USER_REGISTERED: 'website_user_registered',
        WEBSITE_ITEM_SUBMITTED: 'website_item_submitted',
        WEBSITE_REPORT_FILED: 'website_report_filed',
        WEBSITE_REPORT_RESOLVED: 'website_report_resolved',
    },
    ActivityStatus: {
        IN_PROGRESS: 'in_progress',
        COMPLETED: 'completed',
        FAILED: 'failed',
        CANCELLED: 'cancelled',
    },
}));

import { NotFoundException } from '@nestjs/common';
import { ActivityLogController } from './activity-log.controller';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { WorkRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('ActivityLogController', () => {
    let activityLogService: jest.Mocked<
        Pick<
            ActivityLogService,
            | 'reconcileStaleGenerationActivities'
            | 'findAll'
            | 'countRunning'
            | 'summarizeStatuses'
            | 'exportCsv'
            | 'findByIdAndUserId'
        >
    >;
    let workRepository: jest.Mocked<Pick<WorkRepository, 'findById'>>;
    let controller: ActivityLogController;

    const auth = {
        userId: 'user-1',
        email: 'u@e.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    } as AuthenticatedUser;

    const buildController = () => {
        controller = new ActivityLogController(
            activityLogService as unknown as ActivityLogService,
            workRepository as unknown as WorkRepository,
        );
    };

    beforeEach(() => {
        activityLogService = {
            reconcileStaleGenerationActivities: jest.fn().mockResolvedValue(0),
            findAll: jest.fn(),
            countRunning: jest.fn(),
            summarizeStatuses: jest.fn(),
            exportCsv: jest.fn(),
            findByIdAndUserId: jest.fn(),
            ingestFromWebsite: jest.fn(),
        } as any;
        workRepository = {
            findById: jest.fn(),
        } as any;
        buildController();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('reconcileActivities (private behaviour observable through endpoints)', () => {
        it('runs reconcile exactly once for two concurrent calls (in-flight dedup)', async () => {
            // Hold the first reconcile open until we explicitly resolve it,
            // so the second call observes the in-flight Map entry and awaits
            // the same promise rather than starting a new run.
            let resolveFirst: () => void = () => undefined;
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                () =>
                    new Promise<number>((resolve) => {
                        resolveFirst = () => resolve(0);
                    }),
            );
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            const first = controller.getActivities(auth);
            const second = controller.getActivities(auth);

            // Resolve the in-flight reconcile so the queued requests can finish.
            resolveFirst();
            await Promise.all([first, second]);

            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenCalledTimes(1);
        });

        it('skips reconcile a second time if the first completed within the 5-second TTL', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            await controller.getActivities(auth);
            // Advance time but still within 5-second TTL.
            jest.setSystemTime(new Date('2026-01-01T00:00:04Z'));
            await controller.getActivities(auth);

            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenCalledTimes(1);
        });

        it('runs reconcile a second time once the 5-second TTL elapses', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            await controller.getActivities(auth);
            // Advance past TTL boundary (>= 5000 ms). Use 5001 to be safe.
            jest.setSystemTime(new Date('2026-01-01T00:00:05.001Z'));
            await controller.getActivities(auth);

            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenCalledTimes(2);
        });

        it('still serves the request when reconcile rejects (failure is swallowed)', async () => {
            activityLogService.reconcileStaleGenerationActivities.mockRejectedValueOnce(
                new Error('reconcile failed'),
            );
            activityLogService.findAll.mockResolvedValue({
                activities: [{ id: 'a1' }],
                total: 1,
            } as any);

            const result = await controller.getActivities(auth);

            expect(result).toEqual({ activities: [{ id: 'a1' }], total: 1 });
        });

        it('does NOT cache completion when reconcile rejected — next call retries', async () => {
            activityLogService.reconcileStaleGenerationActivities
                .mockRejectedValueOnce(new Error('first failed'))
                .mockResolvedValueOnce(0);
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            await controller.getActivities(auth);
            await controller.getActivities(auth);

            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenCalledTimes(2);
        });

        it('isolates the in-flight Map per user (different userIds run independently)', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);
            const otherAuth = { ...auth, userId: 'user-2' } as AuthenticatedUser;

            await Promise.all([
                controller.getActivities(auth),
                controller.getActivities(otherAuth),
            ]);

            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenCalledTimes(2);
            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenNthCalledWith(
                1,
                'user-1',
            );
            expect(activityLogService.reconcileStaleGenerationActivities).toHaveBeenNthCalledWith(
                2,
                'user-2',
            );
        });

        it('reconciles before invoking findAll (ordering pinned)', async () => {
            const order: string[] = [];
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                async () => {
                    order.push('reconcile');
                    return 0;
                },
            );
            activityLogService.findAll.mockImplementationOnce(async () => {
                order.push('findAll');
                return { activities: [], total: 0 } as any;
            });

            await controller.getActivities(auth);

            expect(order).toEqual(['reconcile', 'findAll']);
        });
    });

    describe('getActivities', () => {
        it('forwards every filter + caps limit at 100 + parses ISO dates', async () => {
            activityLogService.findAll.mockResolvedValue({
                activities: [{ id: 'a1' }],
                total: 1,
            } as any);

            const result = await controller.getActivities(
                auth,
                'WORK_CREATED',
                'work-77',
                'completed',
                '2026-01-01T00:00:00Z',
                '2026-01-31T23:59:59Z',
                'search-term',
                250, // capped to 100
                40,
            );

            expect(activityLogService.findAll).toHaveBeenCalledTimes(1);
            const call = activityLogService.findAll.mock.calls[0]![0]!;
            expect(call.userId).toBe('user-1');
            expect(call.actionType).toBe('WORK_CREATED');
            expect(call.workId).toBe('work-77');
            expect(call.status).toBe('completed');
            expect(call.dateFrom).toBeInstanceOf(Date);
            expect(call.dateFrom!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
            expect(call.dateTo).toBeInstanceOf(Date);
            expect(call.dateTo!.toISOString()).toBe('2026-01-31T23:59:59.000Z');
            expect(call.search).toBe('search-term');
            expect(call.limit).toBe(100);
            expect(call.offset).toBe(40);

            expect(result).toEqual({ activities: [{ id: 'a1' }], total: 1 });
        });

        it('passes through limit when below cap and forwards undefined dates', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            await controller.getActivities(
                auth,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                25,
                0,
            );

            const call = activityLogService.findAll.mock.calls[0]![0]!;
            expect(call.limit).toBe(25);
            expect(call.offset).toBe(0);
            expect(call.dateFrom).toBeUndefined();
            expect(call.dateTo).toBeUndefined();
            expect(call.actionType).toBeUndefined();
            expect(call.workId).toBeUndefined();
            expect(call.status).toBeUndefined();
            expect(call.search).toBeUndefined();
        });

        it('treats limit equal to cap (100) as 100', async () => {
            activityLogService.findAll.mockResolvedValue({ activities: [], total: 0 } as any);

            await controller.getActivities(
                auth,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                100,
                0,
            );

            const call = activityLogService.findAll.mock.calls[0]![0]!;
            expect(call.limit).toBe(100);
        });

        it('returns the {activities, total} envelope (other service fields are not leaked)', async () => {
            activityLogService.findAll.mockResolvedValue({
                activities: [{ id: 'a1' }],
                total: 9,
                // Hypothetical extra fields the service might add later — must not leak.
                cursor: 'should-not-leak',
            } as any);

            const result = await controller.getActivities(auth);

            expect(result).toEqual({ activities: [{ id: 'a1' }], total: 9 });
        });

        it('propagates service errors after reconcile completes', async () => {
            activityLogService.findAll.mockRejectedValueOnce(new Error('db down'));

            await expect(controller.getActivities(auth)).rejects.toThrow('db down');
        });
    });

    describe('getRunningCount', () => {
        it('returns count from service wrapped in {count}', async () => {
            activityLogService.countRunning.mockResolvedValue(3);

            const result = await controller.getRunningCount(auth);

            expect(activityLogService.countRunning).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ count: 3 });
        });

        it('propagates service errors', async () => {
            activityLogService.countRunning.mockRejectedValueOnce(new Error('boom'));

            await expect(controller.getRunningCount(auth)).rejects.toThrow('boom');
        });

        it('runs reconcile before countRunning', async () => {
            const order: string[] = [];
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                async () => {
                    order.push('reconcile');
                    return 0;
                },
            );
            activityLogService.countRunning.mockImplementationOnce(async () => {
                order.push('countRunning');
                return 0;
            });

            await controller.getRunningCount(auth);

            expect(order).toEqual(['reconcile', 'countRunning']);
        });
    });

    describe('getSummary', () => {
        it('returns counts from service wrapped in {counts}', async () => {
            const counts = {
                in_progress: 1,
                completed: 4,
                failed: 0,
                cancelled: 0,
            };
            activityLogService.summarizeStatuses.mockResolvedValue(counts as any);

            const result = await controller.getSummary(auth);

            expect(activityLogService.summarizeStatuses).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ counts });
        });

        it('runs reconcile before summarizeStatuses', async () => {
            const order: string[] = [];
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                async () => {
                    order.push('reconcile');
                    return 0;
                },
            );
            activityLogService.summarizeStatuses.mockImplementationOnce(async () => {
                order.push('summarizeStatuses');
                return {} as any;
            });

            await controller.getSummary(auth);

            expect(order).toEqual(['reconcile', 'summarizeStatuses']);
        });

        it('propagates service errors', async () => {
            activityLogService.summarizeStatuses.mockRejectedValueOnce(new Error('agg failed'));

            await expect(controller.getSummary(auth)).rejects.toThrow('agg failed');
        });
    });

    describe('exportCsv', () => {
        let res: { setHeader: jest.Mock; send: jest.Mock };

        beforeEach(() => {
            res = { setHeader: jest.fn(), send: jest.fn() };
        });

        it('forwards filters + writes Content-Type + Content-Disposition headers + body', async () => {
            activityLogService.exportCsv.mockResolvedValue('id,summary\nrow1,foo');

            await controller.exportCsv(
                auth,
                res as any,
                'GENERATION',
                'work-1',
                'failed',
                '2026-01-01T00:00:00Z',
                '2026-01-31T23:59:59Z',
            );

            expect(activityLogService.exportCsv).toHaveBeenCalledTimes(1);
            const call = activityLogService.exportCsv.mock.calls[0]![0]!;
            expect(call.userId).toBe('user-1');
            expect(call.actionType).toBe('GENERATION');
            expect(call.workId).toBe('work-1');
            expect(call.status).toBe('failed');
            expect(call.dateFrom).toBeInstanceOf(Date);
            expect(call.dateFrom!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
            expect(call.dateTo).toBeInstanceOf(Date);
            expect(call.dateTo!.toISOString()).toBe('2026-01-31T23:59:59.000Z');

            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
            expect(res.setHeader).toHaveBeenCalledWith(
                'Content-Disposition',
                'attachment; filename=activity-log.csv',
            );
            expect(res.send).toHaveBeenCalledWith('id,summary\nrow1,foo');
        });

        it('forwards undefined filters + dates when not provided', async () => {
            activityLogService.exportCsv.mockResolvedValue('id,summary');

            await controller.exportCsv(auth, res as any);

            const call = activityLogService.exportCsv.mock.calls[0]![0]!;
            expect(call.actionType).toBeUndefined();
            expect(call.workId).toBeUndefined();
            expect(call.status).toBeUndefined();
            expect(call.dateFrom).toBeUndefined();
            expect(call.dateTo).toBeUndefined();
            expect(res.send).toHaveBeenCalledWith('id,summary');
        });

        it('runs reconcile BEFORE the CSV is generated (so the export never sees stale rows)', async () => {
            const order: string[] = [];
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                async () => {
                    order.push('reconcile');
                    return 0;
                },
            );
            activityLogService.exportCsv.mockImplementationOnce(async () => {
                order.push('exportCsv');
                return '';
            });

            await controller.exportCsv(auth, res as any);

            expect(order).toEqual(['reconcile', 'exportCsv']);
        });

        it('propagates service errors and does NOT touch the response', async () => {
            activityLogService.exportCsv.mockRejectedValueOnce(new Error('csv failed'));

            await expect(controller.exportCsv(auth, res as any)).rejects.toThrow('csv failed');
            expect(res.setHeader).not.toHaveBeenCalled();
            expect(res.send).not.toHaveBeenCalled();
        });
    });

    describe('getActivity', () => {
        it('throws NotFoundException when service returns null', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce(null);

            await expect(controller.getActivity(auth, 'a1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(activityLogService.findByIdAndUserId).toHaveBeenCalledWith('a1', 'user-1');
            // No work lookup when activity is missing.
            expect(workRepository.findById).not.toHaveBeenCalled();
        });

        it('returns activity wrapped in {activity} (details preserved when no liveLogs override)', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'completed',
                workId: 'work-1',
                details: { existing: true },
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result).toEqual({
                activity: {
                    id: 'a1',
                    status: 'completed',
                    workId: 'work-1',
                    details: { existing: true },
                },
            });
            // Live-logs path is NOT exercised when status !== 'in_progress'.
            expect(workRepository.findById).not.toHaveBeenCalled();
        });

        it('keeps details intact when activity has no details object (defaults to {})', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'completed',
                workId: 'work-1',
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result.activity.details).toEqual({});
        });

        it('overrides liveLogs from work.generateStatus.recentLogs when status is in_progress AND work has logs', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'in_progress',
                workId: 'work-1',
                details: { liveLogs: ['stale-1'], other: 'kept' },
            } as any);
            workRepository.findById.mockResolvedValueOnce({
                generateStatus: { recentLogs: ['fresh-1', 'fresh-2'] },
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(workRepository.findById).toHaveBeenCalledWith('work-1');
            expect(result.activity.details).toEqual({
                liveLogs: ['fresh-1', 'fresh-2'],
                other: 'kept',
            });
        });

        it('preserves activity.details.liveLogs when status is in_progress but work has no recentLogs', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'in_progress',
                workId: 'work-1',
                details: { liveLogs: ['existing'], other: 'kept' },
            } as any);
            workRepository.findById.mockResolvedValueOnce({
                generateStatus: { recentLogs: [] },
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result.activity.details).toEqual({
                liveLogs: ['existing'],
                other: 'kept',
            });
        });

        it('preserves activity.details.liveLogs when status is in_progress but work is null', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'in_progress',
                workId: 'work-1',
                details: { liveLogs: ['existing'] },
            } as any);
            workRepository.findById.mockResolvedValueOnce(null as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result.activity.details).toEqual({ liveLogs: ['existing'] });
        });

        it('preserves activity.details.liveLogs when status is in_progress but work has no generateStatus', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'in_progress',
                workId: 'work-1',
                details: { liveLogs: ['existing'] },
            } as any);
            workRepository.findById.mockResolvedValueOnce({} as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result.activity.details).toEqual({ liveLogs: ['existing'] });
        });

        it('does NOT call workRepository.findById when status is in_progress but workId is missing', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'in_progress',
                workId: null,
                details: {},
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(workRepository.findById).not.toHaveBeenCalled();
            // No liveLogs property added because activity.details.liveLogs was undefined.
            expect(result.activity.details).toEqual({});
        });

        it('does NOT inject liveLogs key when activity has no liveLogs and override is empty', async () => {
            activityLogService.findByIdAndUserId.mockResolvedValueOnce({
                id: 'a1',
                status: 'completed',
                workId: 'work-1',
                details: { foo: 'bar' },
            } as any);

            const result = await controller.getActivity(auth, 'a1');

            expect(result.activity.details).toEqual({ foo: 'bar' });
            expect(result.activity.details).not.toHaveProperty('liveLogs');
        });

        it('runs reconcile before the lookup (ordering pinned)', async () => {
            const order: string[] = [];
            activityLogService.reconcileStaleGenerationActivities.mockImplementationOnce(
                async () => {
                    order.push('reconcile');
                    return 0;
                },
            );
            activityLogService.findByIdAndUserId.mockImplementationOnce(async () => {
                order.push('findByIdAndUserId');
                return { id: 'a1', status: 'completed', workId: 'w1', details: {} } as any;
            });

            await controller.getActivity(auth, 'a1');

            expect(order).toEqual(['reconcile', 'findByIdAndUserId']);
        });

        it('cross-user lookup returns null → 404 (composite-key safety)', async () => {
            // findByIdAndUserId is the composite-key safety surface — returning
            // null when the activity belongs to a different user is what
            // turns into a 404 here.
            activityLogService.findByIdAndUserId.mockResolvedValueOnce(null);

            await expect(controller.getActivity(auth, 'someone-elses')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('ingestWebsiteEvent (EW-120)', () => {
        const dto = {
            workId: '11111111-1111-1111-1111-111111111111',
            eventId: '22222222-2222-2222-2222-222222222222',
            actionType: 'website_user_registered' as never,
            occurredAt: '2026-05-13T10:00:00.000Z',
            summary: 'User signed up',
        };

        it('delegates to ActivityLogService.ingestFromWebsite and returns the new id', async () => {
            (activityLogService as any).ingestFromWebsite.mockResolvedValueOnce({ id: 'al-new' });
            const result = await controller.ingestWebsiteEvent(dto as never);

            expect((activityLogService as any).ingestFromWebsite).toHaveBeenCalledWith({
                workId: dto.workId,
                eventId: dto.eventId,
                actionType: dto.actionType,
                occurredAt: new Date(dto.occurredAt),
                summary: dto.summary,
                metadata: undefined,
            });
            expect(result).toEqual({ id: 'al-new' });
        });

        it('rethrows "work … not found" as a 404 NotFoundException', async () => {
            (activityLogService as any).ingestFromWebsite.mockRejectedValueOnce(
                new Error('Work missing not found'),
            );

            await expect(controller.ingestWebsiteEvent(dto as never)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('forwards optional metadata to the service unchanged', async () => {
            (activityLogService as any).ingestFromWebsite.mockResolvedValueOnce({ id: 'al-meta' });
            await controller.ingestWebsiteEvent({
                ...dto,
                metadata: { itemId: 'i-1', actor: 'bob' },
            } as never);

            const call = (activityLogService as any).ingestFromWebsite.mock.calls[0]![0];
            expect(call.metadata).toEqual({ itemId: 'i-1', actor: 'bob' });
        });
    });
});
