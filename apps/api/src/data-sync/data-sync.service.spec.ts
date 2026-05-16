import { Test, TestingModule } from '@nestjs/testing';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DataSyncService } from './data-sync.service';
import type { SyncSource } from './data-sync.types';

/**
 * Phase 3 (EW-628) tests — pin the public surface of {@link DataSyncService}
 * that the dispatcher (Phase 4), webhook handler (Phase 5), and force-sync
 * endpoint (Phase 6) compile against.
 *
 * The full six-branch coverage of the three-gate body (success,
 * gen-in-progress first/repeat, retry-backoff, sync-in-progress, failed)
 * arrives with the gate implementation as a follow-up commit on this
 * same PR. Keeping these two changes split (skeleton vs. logic) makes
 * the diffs reviewable in isolation.
 */
describe('DataSyncService (EW-628 Phase 3 skeleton)', () => {
    let service: DataSyncService;
    let taskLockService: jest.Mocked<DistributedTaskLockService>;

    beforeEach(async () => {
        taskLockService = {
            runExclusive: jest.fn(),
        } as unknown as jest.Mocked<DistributedTaskLockService>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSyncService,
                { provide: DistributedTaskLockService, useValue: taskLockService },
            ],
        }).compile();

        service = module.get(DataSyncService);
    });

    it('is provided as an injectable NestJS service', () => {
        expect(service).toBeInstanceOf(DataSyncService);
    });

    describe('isLocked', () => {
        it('returns false as a conservative no-op until the cache_entries peek lands', async () => {
            await expect(service.isLocked('work-123')).resolves.toBe(false);
            // Phase 3 follow-up: this assertion flips to verify the peek
            // actually hits the cache_entries table.
        });

        it('does not invoke the task-lock service in the no-op path', async () => {
            await service.isLocked('work-456');
            expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        });
    });

    describe('runDataSync', () => {
        const sources: SyncSource[] = ['webhook', 'poll', 'manual'];

        it.each(sources)(
            'throws "not yet implemented" for source=%s until the three-gate body lands',
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
