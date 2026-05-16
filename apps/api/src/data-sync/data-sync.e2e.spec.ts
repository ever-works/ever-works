/**
 * EW-628 in-process integration spec — drives the data-sync stack
 * end-to-end through the **real** orchestration code:
 *
 *   - `DataSyncController.forceSync` (the public force-sync endpoint)
 *   - `DataSyncService.runDataSync` three-gate body (G3)
 *   - `DataSyncDispatcherService.dispatchDue` Path A / Path B fan-out (G7)
 *   - `classifyError` + the typed `SyncEventPayload` emit path (G4)
 *
 * External boundaries are stubbed so we don't reach a real GitHub
 * API or a real git server:
 *
 *   - `WorkRepository` — in-memory map of Works keyed by id.
 *   - `MarkdownGeneratorService.syncFromDataRepo` — configurable per
 *     test (throws on data-repo-unreachable; returns stub stats on
 *     happy path).
 *   - `ActivityLogService.log` — captures emitted rows.
 *   - `CACHE_MANAGER` — in-memory Map<string, string> with no TTL
 *     semantics (we just need set/get/del to observe retry-backoff /
 *     noise-window writes).
 *   - `DistributedTaskLockService.runExclusive` — runs the callback
 *     in-process. Per-test we can toggle to `{ acquired: false }`
 *     for the AC-3 contention path.
 *
 * These cover the acceptance criteria the original Playwright spec
 * scaffolded (AC-1, AC-2, AC-3, AC-7, AC-10) with no fixtures
 * required to spin up a real GitHub App / Redis lock service. The
 * Playwright file at `apps/web/e2e/data-sync.spec.ts` keeps its
 * `test.fixme()` blocks for the full browser-level happy paths once
 * those fixtures land.
 */

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
                webhookEnabled: jest.fn().mockReturnValue(true),
                dispatcherEnabled: jest.fn().mockReturnValue(true),
                getDebounceMs: () => 30_000,
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
import { DataSyncController } from './data-sync.controller';
import { DataSyncDispatcherService } from './data-sync-dispatcher.service';
import { DataSyncService } from './data-sync.service';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const stubUser: AuthenticatedUser = { userId: 'user-1' } as unknown as AuthenticatedUser;

describe('EW-628 data-sync e2e — orchestration across G3 + G7 + controller', () => {
    let controller: DataSyncController;
    let dispatcher: DataSyncDispatcherService;
    let workStore: Map<string, any>;
    let cache: Map<string, string>;
    let activityRows: any[];
    let markdownGenerator: { syncFromDataRepo: jest.Mock };
    let lockResultOverride: 'acquired' | 'contended' | null;

    beforeEach(async () => {
        workStore = new Map();
        cache = new Map();
        activityRows = [];
        lockResultOverride = null;

        markdownGenerator = {
            syncFromDataRepo: jest.fn().mockResolvedValue({
                beforeSha: undefined,
                afterSha: 'sha-after',
                filesChanged: 2,
                durationMs: 12,
            }),
        };

        const workRepository = {
            findById: jest.fn().mockImplementation(async (id: string) => workStore.get(id) ?? null),
            findWebhookFlushDueWorks: jest
                .fn()
                .mockImplementation(async () =>
                    [...workStore.values()].filter(
                        (w) => w.githubAppInstalled && w.pendingSyncRequestedAt,
                    ),
                ),
            findPollerDueWorks: jest
                .fn()
                .mockImplementation(async () =>
                    [...workStore.values()].filter(
                        (w) => !w.githubAppInstalled && w.syncIntervalMinutes > 0,
                    ),
                ),
            update: jest.fn().mockImplementation(async (id: string, patch: any) => {
                const existing = workStore.get(id);
                if (existing) workStore.set(id, { ...existing, ...patch });
                return null;
            }),
        };

        const cacheManager = {
            get: jest.fn().mockImplementation(async (key: string) => cache.get(key) ?? null),
            set: jest.fn().mockImplementation(async (key: string, value: string) => {
                cache.set(key, value);
            }),
            del: jest.fn().mockImplementation(async (key: string) => {
                cache.delete(key);
            }),
        };

        const taskLockService = {
            runExclusive: jest
                .fn()
                .mockImplementation(async (_key: string, fn: () => Promise<any>, options: any) => {
                    if (lockResultOverride === 'contended') {
                        options?.onLocked?.();
                        return { acquired: false };
                    }
                    return { acquired: true, result: await fn() };
                }),
        };

        const activityLogService = {
            log: jest.fn().mockImplementation(async (entry: any) => {
                activityRows.push(entry);
                return entry;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [DataSyncController],
            providers: [
                DataSyncService,
                DataSyncDispatcherService,
                { provide: DistributedTaskLockService, useValue: taskLockService },
                {
                    provide: getRepositoryToken(CacheEntry),
                    useValue: { findOne: jest.fn().mockResolvedValue(null) },
                },
                { provide: CACHE_MANAGER, useValue: cacheManager },
                { provide: ActivityLogService, useValue: activityLogService },
                { provide: WorkRepository, useValue: workRepository },
                { provide: MarkdownGeneratorService, useValue: markdownGenerator },
            ],
        }).compile();

        controller = module.get(DataSyncController);
        dispatcher = module.get(DataSyncDispatcherService);
    });

    const seedWork = (id: string, patch: Partial<Record<string, unknown>> = {}) => {
        const work = {
            id,
            user: { id: 'user-1' },
            generateStatus: { status: GenerateStatusType.GENERATED },
            githubAppInstalled: false,
            syncIntervalMinutes: 5,
            lastSyncedDataRepoSha: undefined,
            pendingSyncRequestedAt: null,
            lastPolledAt: null,
            ...patch,
        };
        workStore.set(id, work);
        return work;
    };

    describe('AC-1 — webhook flush dispatched via the cron', () => {
        it('runs syncFromDataRepo and emits a single data-sync.success row with source=webhook', async () => {
            seedWork('w-webhook', {
                githubAppInstalled: true,
                pendingSyncRequestedAt: new Date(Date.now() - 60_000),
            });

            const summary = await dispatcher.dispatchDue();

            expect(summary.dueCount).toBe(1);
            expect(summary.dispatched).toBe(1);
            expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledTimes(1);
            const successRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_SUCCESS,
            );
            expect(successRows).toHaveLength(1);
            expect(successRows[0].details).toMatchObject({
                kind: 'success',
                source: 'webhook',
                afterSha: 'sha-after',
                filesChanged: 2,
            });
        });
    });

    describe('AC-2 — poller flush dispatched via the cron', () => {
        it('stamps lastPolledAt, runs syncFromDataRepo, emits source=poll success', async () => {
            seedWork('w-poll', {
                githubAppInstalled: false,
                syncIntervalMinutes: 5,
                lastPolledAt: null,
            });

            const summary = await dispatcher.dispatchDue();

            expect(summary.dueCount).toBe(1);
            expect(summary.dispatched).toBe(1);
            expect(workStore.get('w-poll').lastPolledAt).toBeInstanceOf(Date);
            const successRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_SUCCESS,
            );
            expect(successRows[0].details).toMatchObject({ source: 'poll' });
        });
    });

    describe('AC-3 — mutex with the generation pipeline', () => {
        it('returns skipped:generation-in-progress when generateStatus === GENERATING and never calls the generator', async () => {
            seedWork('w-busy', {
                githubAppInstalled: true,
                pendingSyncRequestedAt: new Date(Date.now() - 60_000),
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            const summary = await dispatcher.dispatchDue();

            expect(summary.skipped).toBe(1);
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            const skippedRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_SKIPPED,
            );
            expect(skippedRows[0].details).toMatchObject({
                kind: 'skipped',
                reason: 'generation-in-progress',
            });
        });

        it('emits skipped:sync-in-progress when the lock is already held by another worker', async () => {
            seedWork('w-contended', {
                githubAppInstalled: true,
                pendingSyncRequestedAt: new Date(Date.now() - 60_000),
            });
            lockResultOverride = 'contended';

            const summary = await dispatcher.dispatchDue();
            expect(summary.skipped).toBe(1);
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            const skippedRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_SKIPPED,
            );
            expect(skippedRows[0].details).toMatchObject({ reason: 'sync-in-progress' });
        });
    });

    describe('AC-7 — data repo unreachable', () => {
        it('emits failed:data-repo-unreachable, writes the retry-backoff cache key, does NOT update lastSyncedDataRepoSha', async () => {
            seedWork('w-404', {
                githubAppInstalled: true,
                pendingSyncRequestedAt: new Date(Date.now() - 60_000),
                lastSyncedDataRepoSha: 'previous-sha',
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                Object.assign(new Error('GitHub 404 Not Found'), {
                    stderr: 'remote: Repository not found.',
                }),
            );

            const summary = await dispatcher.dispatchDue();

            expect(summary.failed).toBe(1);
            const failedRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_FAILED,
            );
            expect(failedRows[0].details).toMatchObject({
                kind: 'failed',
                errorClass: 'data-repo-unreachable',
            });
            expect(failedRows[0].details.errorTail).toMatch(/Repository not found/);
            expect(workStore.get('w-404').lastSyncedDataRepoSha).toBe('previous-sha');
            expect(cache.get('data-sync:retry-after:w-404')).toBe('1');
        });
    });

    describe('AC-10 — POST /api/works/:id/sync force-sync endpoint', () => {
        it('returns a 202-style envelope { status: "enqueued", outcome: "success", stats } on a healthy Work', async () => {
            seedWork('w-force');

            const result = await controller.forceSync(stubUser, 'w-force');
            expect(result).toMatchObject({ status: 'enqueued', outcome: 'success' });
            expect(result).toHaveProperty('stats');
            const successRows = activityRows.filter(
                (r) => r.actionType === ActivityActionType.DATA_SYNC_SUCCESS,
            );
            expect(successRows[0].details).toMatchObject({ source: 'manual' });
        });

        it('returns { status: "skipped", reason } when the pipeline is RUNNING (no error)', async () => {
            seedWork('w-busy-force', {
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            const result = await controller.forceSync(stubUser, 'w-busy-force');
            expect(result).toMatchObject({
                status: 'skipped',
                reason: 'generation-in-progress',
            });
        });

        it('returns { status: "failed", errorClass, errorTail } when the render throws', async () => {
            seedWork('w-fail-force');
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                new Error('push rejected: non-fast-forward'),
            );

            const result = await controller.forceSync(stubUser, 'w-fail-force');
            expect(result).toMatchObject({
                status: 'failed',
                errorClass: 'main-repo-push-rejected',
            });
            expect((result as { errorTail?: string }).errorTail).toMatch(/non-fast-forward/);
        });
    });
});
