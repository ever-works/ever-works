// The `@ever-works/agent/{activity-log,generators}` barrels transitively
// import NestJS modules whose source uses the agent-side `@src/...` path
// alias — but the API jest config maps `@src/...` to `apps/api/src/...`
// (where those subdirectories do NOT exist). Stub the barrels to expose
// only the service classes we use as DI tokens. Class identity is
// preserved because both prod and test resolve to the same mocked module.
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
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
            dataSync: {
                getLockTtlSeconds: () => 300,
                getRetryBackoffSeconds: () => 300,
                getGenInProgressNoiseWindowMs: () => 900_000,
            },
        },
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ActivityActionType, CacheEntry, GenerateStatusType } from '@ever-works/agent/entities';
import { CACHE_MANAGER, DistributedTaskLockService } from '@ever-works/agent/cache';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { WorkRepository } from '@ever-works/agent/database';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { AnalyticsService } from '@ever-works/monitoring';
import { DataSyncService } from './data-sync.service';
import type { SyncSource } from './data-sync.types';

/**
 * Tests for {@link DataSyncService}.
 *
 * Coverage split:
 *   - `isLocked` — G2 (this file) — cache_entries peek paths.
 *   - `runDataSync` — G3 (this file) — three-gate body + outcome shape.
 *     The render gate calls into `MarkdownGeneratorService.syncFromDataRepo`
 *     and the activity-feed writes through `ActivityLogService.log` — both
 *     are mocked so the unit test focuses on the orchestration. The
 *     end-to-end Path A / Path B / lock-contention scenarios live in the
 *     Playwright spec (apps/web/e2e/data-sync.spec.ts) and the API e2e
 *     spec the dispatcher commit adds.
 */
describe('DataSyncService (EW-628)', () => {
    let service: DataSyncService;
    let taskLockService: jest.Mocked<DistributedTaskLockService>;
    let cacheEntryRepository: { findOne: jest.Mock };
    let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
    let activityLogService: { log: jest.Mock };
    let workRepository: { findById: jest.Mock; update: jest.Mock };
    let markdownGenerator: { syncFromDataRepo: jest.Mock };
    let analyticsService: { track: jest.Mock };

    /**
     * Resolve `runExclusive` for the acquired path: invoke the callback,
     * return `{ acquired: true, result }`. For the contended path, call
     * `onLocked` once and return `{ acquired: false }`.
     */
    const stubLockServiceAcquired = () => {
        taskLockService.runExclusive.mockImplementation(async (_key, fn) => ({
            acquired: true,
            result: await fn(),
        }));
    };
    const stubLockServiceContended = () => {
        taskLockService.runExclusive.mockImplementation(async (_key, _fn, options) => {
            options?.onLocked?.();
            return { acquired: false };
        });
    };

    beforeEach(async () => {
        taskLockService = {
            runExclusive: jest.fn(),
        } as unknown as jest.Mocked<DistributedTaskLockService>;
        cacheEntryRepository = { findOne: jest.fn() };
        cacheManager = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
        activityLogService = { log: jest.fn().mockResolvedValue({}) };
        workRepository = {
            findById: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        };
        markdownGenerator = { syncFromDataRepo: jest.fn() };
        analyticsService = { track: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSyncService,
                { provide: DistributedTaskLockService, useValue: taskLockService },
                { provide: getRepositoryToken(CacheEntry), useValue: cacheEntryRepository },
                { provide: CACHE_MANAGER, useValue: cacheManager },
                { provide: ActivityLogService, useValue: activityLogService },
                { provide: WorkRepository, useValue: workRepository },
                { provide: MarkdownGeneratorService, useValue: markdownGenerator },
                { provide: AnalyticsService, useValue: analyticsService },
            ],
        }).compile();

        service = module.get(DataSyncService);
    });

    it('is provided as an injectable NestJS service', () => {
        expect(service).toBeInstanceOf(DataSyncService);
    });

    describe('isLocked', () => {
        it('returns false when no cache_entries row exists for the work', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce(null);

            await expect(service.isLocked('work-123')).resolves.toBe(false);
            expect(cacheEntryRepository.findOne).toHaveBeenCalledWith({
                where: { key: 'task-lock:data-sync:work-123' },
                select: ['key', 'expiresAt'],
            });
        });

        it('returns true when a row exists with expiresAt in the future', async () => {
            const future = Date.now() + 60_000;
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-456',
                expiresAt: future,
            });

            await expect(service.isLocked('work-456')).resolves.toBe(true);
        });

        it('returns false when the row exists but expiresAt is in the past (stale lock)', async () => {
            const past = Date.now() - 60_000;
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-789',
                expiresAt: past,
            });

            await expect(service.isLocked('work-789')).resolves.toBe(false);
        });

        it('returns true (defensive) when expiresAt is null — no TTL set means treat as held', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-ttlless',
                expiresAt: null,
            });

            await expect(service.isLocked('work-ttlless')).resolves.toBe(true);
        });

        it('does not invoke the task-lock service (peek-only, no acquire)', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce(null);

            await service.isLocked('work-peek-only');
            expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        });
    });

    describe('runDataSync — lock contention (no body run)', () => {
        const sources: SyncSource[] = ['webhook', 'poll', 'manual'];

        it.each(sources)(
            'returns skipped:sync-in-progress when the lock cannot be acquired (source=%s)',
            async (source) => {
                stubLockServiceContended();

                await expect(service.runDataSync('work-busy', source)).resolves.toEqual({
                    status: 'skipped',
                    reason: 'sync-in-progress',
                });
                // onLocked emits the activity row.
                expect(activityLogService.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                        details: expect.objectContaining({ reason: 'sync-in-progress', source }),
                    }),
                );
                expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            },
        );
    });

    describe('runDataSync — three gates inside the lock', () => {
        beforeEach(() => stubLockServiceAcquired());

        it('Gate 1: returns skipped:retry-backoff when the retry-after cache key is set', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key === 'data-sync:retry-after:work-1' ? '1' : null,
            );

            await expect(service.runDataSync('work-1', 'webhook')).resolves.toEqual({
                status: 'skipped',
                reason: 'retry-backoff',
            });
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                    details: expect.objectContaining({ reason: 'retry-backoff' }),
                }),
            );
            // Pipeline-RUNNING gate (Gate 2) is not exercised — markdown generator
            // is never invoked even though `findById` runs once for the row lookup
            // shared with the activity-row attribution.
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
        });

        it('Gate 2: returns skipped:generation-in-progress when work.generateStatus === GENERATING, and rate-limits the noise row', async () => {
            cacheManager.get.mockResolvedValue(null); // no backoff, no recent noise.
            workRepository.findById.mockResolvedValue({
                id: 'work-2',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            await expect(service.runDataSync('work-2', 'poll')).resolves.toEqual({
                status: 'skipped',
                reason: 'generation-in-progress',
            });
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                    details: expect.objectContaining({ reason: 'generation-in-progress' }),
                }),
            );
            expect(cacheManager.set).toHaveBeenCalledWith(
                'data-sync:gen-in-progress-noise:work-2',
                '1',
                expect.any(Number),
            );
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
        });

        it('Gate 2: does NOT re-emit the skip row when the noise window is active (still returns skipped)', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key.startsWith('data-sync:gen-in-progress-noise:') ? '1' : null,
            );
            workRepository.findById.mockResolvedValue({
                id: 'work-noise',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            const outcome = await service.runDataSync('work-noise', 'poll');
            expect(outcome).toEqual({ status: 'skipped', reason: 'generation-in-progress' });
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('Gate 3 success: calls markdown generator, updates the Work, clears noise window, emits success row', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-ok',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                beforeSha: 'aaa1111',
                afterSha: 'bbb2222',
                filesChanged: 3,
                durationMs: 1234,
            });

            await expect(service.runDataSync('work-ok', 'webhook')).resolves.toEqual({
                status: 'success',
                stats: {
                    beforeSha: 'aaa1111',
                    afterSha: 'bbb2222',
                    filesChanged: 3,
                    durationMs: 1234,
                },
            });
            expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'work-ok' }),
                expect.objectContaining({ id: 'owner-1' }),
                expect.any(Object),
            );
            expect(workRepository.update).toHaveBeenCalledWith(
                'work-ok',
                expect.objectContaining({
                    lastSyncedDataRepoSha: 'bbb2222',
                    pendingSyncRequestedAt: null,
                    lastPolledAt: expect.any(Date),
                }),
            );
            expect(cacheManager.del).toHaveBeenCalledWith(
                'data-sync:gen-in-progress-noise:work-ok',
            );
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SUCCESS,
                    details: expect.objectContaining({
                        source: 'webhook',
                        afterSha: 'bbb2222',
                        filesChanged: 3,
                    }),
                }),
            );
        });

        it('Gate 3 failed: catches render errors, sets retry-after cache, emits failed row, never throws', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-fail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            const renderError = Object.assign(new Error('GitHub 404 Not Found'), {
                stderr: 'remote: Repository not found.',
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(renderError);

            const outcome = await service.runDataSync('work-fail', 'webhook');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'data-repo-unreachable',
            });
            expect(outcome).toHaveProperty('errorTail');
            expect(workRepository.update).not.toHaveBeenCalled(); // No success write.
            expect(cacheManager.set).toHaveBeenCalledWith(
                'data-sync:retry-after:work-fail',
                '1',
                expect.any(Number),
            );
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_FAILED,
                    details: expect.objectContaining({
                        errorClass: 'data-repo-unreachable',
                        source: 'webhook',
                    }),
                }),
            );
        });

        it('Gate 3 failed: maps push-rejected errors to errorClass main-repo-push-rejected', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-pushfail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                new Error('push rejected: non-fast-forward'),
            );

            const outcome = await service.runDataSync('work-pushfail', 'manual');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'main-repo-push-rejected',
            });
        });

        it('Gate 2 work-not-found: returns failed:work-not-found when the row is missing', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue(null);

            const outcome = await service.runDataSync('work-ghost', 'poll');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'work-not-found',
            });
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });
    });

    // EW-628 G10 — telemetry counter increments via the optional
    // AnalyticsService. Names locked by DATA_SYNC_METRICS in
    // packages/agent/src/cache/data-sync-metrics.ts and the Phase 8
    // contract spec (data-sync-metrics.spec.ts).
    describe('telemetry counters (EW-628 G10)', () => {
        beforeEach(() => stubLockServiceAcquired());

        it('lock contention emits data_sync_lock_contention_total once with the source label', async () => {
            stubLockServiceContended();
            await service.runDataSync('work-busy', 'webhook');
            expect(analyticsService.track).toHaveBeenCalledWith(
                'work-busy',
                'data_sync_lock_contention_total',
                expect.objectContaining({ source: 'webhook' }),
            );
        });

        it('success emits data_sync_success_total + data_sync_duration_ms with stats labels', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-ok',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                afterSha: 'sha-x',
                filesChanged: 4,
                durationMs: 250,
            });

            await service.runDataSync('w-ok', 'manual');

            expect(analyticsService.track).toHaveBeenCalledWith('w-ok', 'data_sync_success_total', {
                source: 'manual',
            });
            expect(analyticsService.track).toHaveBeenCalledWith(
                'w-ok',
                'data_sync_duration_ms',
                expect.objectContaining({ source: 'manual', value: 250, filesChanged: 4 }),
            );
        });

        it('skipped emits data_sync_skipped_total with reason + source labels', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key === 'data-sync:retry-after:w-skip' ? '1' : null,
            );

            await service.runDataSync('w-skip', 'poll');

            expect(analyticsService.track).toHaveBeenCalledWith(
                'w-skip',
                'data_sync_skipped_total',
                expect.objectContaining({ source: 'poll', reason: 'retry-backoff' }),
            );
        });

        it('failed emits data_sync_failed_total with errorClass + source labels (errorTail not sent)', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-fail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                Object.assign(new Error('404 Not Found'), {
                    stderr: 'remote: Repository not found.',
                }),
            );

            await service.runDataSync('w-fail', 'webhook');

            const failCall = analyticsService.track.mock.calls.find(
                (c) => c[1] === 'data_sync_failed_total',
            );
            expect(failCall).toBeDefined();
            expect(failCall![0]).toBe('w-fail');
            expect(failCall![2]).toEqual({
                source: 'webhook',
                errorClass: 'data-repo-unreachable',
            });
            // errorTail (potentially PII / high-cardinality) must NOT leak into PostHog.
            expect(failCall![2]).not.toHaveProperty('errorTail');
        });

        it('telemetry failures never break the sync path', async () => {
            analyticsService.track.mockImplementation(() => {
                throw new Error('PostHog down');
            });
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-resilient',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                afterSha: 'sha-y',
                filesChanged: 1,
                durationMs: 10,
            });

            const outcome = await service.runDataSync('w-resilient', 'webhook');
            expect(outcome.status).toBe('success');
        });
    });
});
