import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DataSyncService } from './data-sync.service';
import type { SyncSource } from './data-sync.types';

/**
 * Tests for {@link DataSyncService}. The G2 commit (EW-628) wires the
 * real `isLocked` cache-entries peek; the three-gate `runDataSync` body
 * still lands in G3 and is covered by its own test addition there.
 */
describe('DataSyncService (EW-628)', () => {
    let service: DataSyncService;
    let taskLockService: jest.Mocked<DistributedTaskLockService>;
    let cacheEntryRepository: { findOne: jest.Mock };

    beforeEach(async () => {
        taskLockService = {
            runExclusive: jest.fn(),
        } as unknown as jest.Mocked<DistributedTaskLockService>;

        cacheEntryRepository = { findOne: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSyncService,
                { provide: DistributedTaskLockService, useValue: taskLockService },
                { provide: getRepositoryToken(CacheEntry), useValue: cacheEntryRepository },
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

        it('uses the canonical lock-key format task-lock:data-sync:<workId>', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce(null);

            await service.isLocked('abc-def-ghi');
            expect(cacheEntryRepository.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { key: 'task-lock:data-sync:abc-def-ghi' },
                }),
            );
        });
    });

    describe('runDataSync', () => {
        const sources: SyncSource[] = ['webhook', 'poll', 'manual'];

        it.each(sources)(
            'throws "not yet implemented" for source=%s until the three-gate body lands (G3)',
            async (source) => {
                await expect(service.runDataSync('work-789', source)).rejects.toThrow(
                    /not yet implemented/i,
                );
            },
        );

        it('does not acquire the lock when the body is a stub (the throw happens before runExclusive)', async () => {
            await expect(service.runDataSync('work-stub', 'webhook')).rejects.toThrow();
            expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        });
    });
});
