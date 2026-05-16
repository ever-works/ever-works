// EW-628 G7 — same barrel-mock pattern as data-sync.service.spec.ts.
// `@ever-works/agent/{database,config}` barrels transitively import
// NestJS modules whose source uses the agent-side `@src/...` path
// alias, which the API jest config rewrites to a non-existent dir.
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            getMaxBatch: () => 25,
            dataSync: {
                dispatcherEnabled: jest.fn().mockReturnValue(true),
                getDebounceMs: () => 30_000,
            },
        },
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { WorkRepository } from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';
import { DataSyncDispatcherService } from './data-sync-dispatcher.service';
import { DataSyncService } from './data-sync.service';
import type { DataSyncOutcome } from './data-sync.types';

const dispatcherEnabledMock = config.subscriptions.dataSync.dispatcherEnabled as jest.Mock;

describe('DataSyncDispatcherService (EW-628 G7)', () => {
    let service: DataSyncDispatcherService;
    let workRepository: {
        findWebhookFlushDueWorks: jest.Mock;
        findPollerDueWorks: jest.Mock;
        update: jest.Mock;
    };
    let dataSyncService: { runDataSync: jest.Mock };

    beforeEach(async () => {
        dispatcherEnabledMock.mockReset();
        dispatcherEnabledMock.mockReturnValue(true);
        workRepository = {
            findWebhookFlushDueWorks: jest.fn().mockResolvedValue([]),
            findPollerDueWorks: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(null),
        };
        dataSyncService = { runDataSync: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSyncDispatcherService,
                { provide: WorkRepository, useValue: workRepository },
                { provide: DataSyncService, useValue: dataSyncService },
            ],
        }).compile();

        service = module.get(DataSyncDispatcherService);
    });

    const successOutcome = (): DataSyncOutcome => ({
        status: 'success',
        stats: { filesChanged: 1, durationMs: 10 },
    });
    const skippedOutcome = (reason: 'sync-in-progress' = 'sync-in-progress'): DataSyncOutcome => ({
        status: 'skipped',
        reason,
    });
    const failedOutcome = (): DataSyncOutcome => ({
        status: 'failed',
        errorClass: 'data-repo-unreachable',
        errorTail: 'remote: Repository not found.',
    });

    describe('flag gate', () => {
        it('returns an empty summary and runs neither path when dispatcherEnabled = false', async () => {
            dispatcherEnabledMock.mockReturnValue(false);

            const summary = await service.dispatchDue();
            expect(summary).toEqual({
                limit: expect.any(Number),
                dueCount: 0,
                dispatched: 0,
                skipped: 0,
                failed: 0,
                entries: [],
            });
            expect(workRepository.findWebhookFlushDueWorks).not.toHaveBeenCalled();
            expect(workRepository.findPollerDueWorks).not.toHaveBeenCalled();
            expect(dataSyncService.runDataSync).not.toHaveBeenCalled();
        });
    });

    describe('Path A — webhook flush', () => {
        it('calls runDataSync(workId, "webhook") for each webhook-due Work', async () => {
            workRepository.findWebhookFlushDueWorks.mockResolvedValue([
                { id: 'w-1' },
                { id: 'w-2' },
            ]);
            dataSyncService.runDataSync.mockResolvedValue(successOutcome());

            const summary = await service.dispatchDue();

            expect(workRepository.findWebhookFlushDueWorks).toHaveBeenCalledWith(
                30_000,
                expect.any(Number),
            );
            expect(dataSyncService.runDataSync).toHaveBeenNthCalledWith(1, 'w-1', 'webhook');
            expect(dataSyncService.runDataSync).toHaveBeenNthCalledWith(2, 'w-2', 'webhook');
            expect(summary.dueCount).toBe(2);
            expect(summary.dispatched).toBe(2);
            expect(summary.entries).toHaveLength(2);
        });
    });

    describe('Path B — poller', () => {
        it('stamps lastPolledAt then calls runDataSync(workId, "poll") for every poller-due Work', async () => {
            workRepository.findPollerDueWorks.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
            dataSyncService.runDataSync.mockResolvedValue(successOutcome());

            await service.dispatchDue();

            expect(workRepository.update).toHaveBeenCalledTimes(2);
            expect(workRepository.update).toHaveBeenNthCalledWith(
                1,
                'p-1',
                expect.objectContaining({ lastPolledAt: expect.any(Date) }),
            );
            expect(workRepository.update).toHaveBeenNthCalledWith(
                2,
                'p-2',
                expect.objectContaining({ lastPolledAt: expect.any(Date) }),
            );
            expect(dataSyncService.runDataSync).toHaveBeenNthCalledWith(1, 'p-1', 'poll');
            expect(dataSyncService.runDataSync).toHaveBeenNthCalledWith(2, 'p-2', 'poll');
        });

        it('still runs the sync even if the lastPolledAt UPDATE fails (defence in depth)', async () => {
            workRepository.findPollerDueWorks.mockResolvedValue([{ id: 'p-fail' }]);
            workRepository.update.mockRejectedValueOnce(new Error('row locked'));
            dataSyncService.runDataSync.mockResolvedValue(successOutcome());

            const summary = await service.dispatchDue();
            expect(dataSyncService.runDataSync).toHaveBeenCalledWith('p-fail', 'poll');
            expect(summary.dispatched).toBe(1);
        });
    });

    describe('outcome accounting', () => {
        it('classifies skipped outcomes into summary.skipped + entry.outcome="skipped"', async () => {
            workRepository.findWebhookFlushDueWorks.mockResolvedValue([{ id: 'w-skip' }]);
            dataSyncService.runDataSync.mockResolvedValue(skippedOutcome('sync-in-progress'));

            const summary = await service.dispatchDue();
            expect(summary.skipped).toBe(1);
            expect(summary.dispatched).toBe(0);
            expect(summary.entries[0]).toMatchObject({
                workId: 'w-skip',
                source: 'webhook',
                outcome: 'skipped',
                message: 'sync-in-progress',
            });
        });

        it('classifies failed outcomes into summary.failed + entry.outcome="failed"', async () => {
            workRepository.findWebhookFlushDueWorks.mockResolvedValue([{ id: 'w-fail' }]);
            dataSyncService.runDataSync.mockResolvedValue(failedOutcome());

            const summary = await service.dispatchDue();
            expect(summary.failed).toBe(1);
            expect(summary.entries[0]).toMatchObject({
                workId: 'w-fail',
                source: 'webhook',
                outcome: 'failed',
                message: 'data-repo-unreachable',
            });
        });

        it('catches a runDataSync throw (defence in depth) and records it as failed', async () => {
            workRepository.findWebhookFlushDueWorks.mockResolvedValue([{ id: 'w-throw' }]);
            dataSyncService.runDataSync.mockRejectedValue(new Error('lock service crashed'));

            const summary = await service.dispatchDue();
            expect(summary.failed).toBe(1);
            expect(summary.entries[0]).toMatchObject({
                workId: 'w-throw',
                outcome: 'failed',
                message: 'lock service crashed',
            });
        });

        it('mixes Path A and Path B outcomes in a single summary', async () => {
            workRepository.findWebhookFlushDueWorks.mockResolvedValue([{ id: 'w-1' }]);
            workRepository.findPollerDueWorks.mockResolvedValue([{ id: 'p-1' }]);
            dataSyncService.runDataSync.mockResolvedValueOnce(successOutcome());
            dataSyncService.runDataSync.mockResolvedValueOnce(skippedOutcome());

            const summary = await service.dispatchDue();
            expect(summary.dueCount).toBe(2);
            expect(summary.dispatched).toBe(1);
            expect(summary.skipped).toBe(1);
            expect(summary.failed).toBe(0);
        });
    });
});
