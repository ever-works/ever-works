import 'reflect-metadata';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import {
    RAIL_REFUSAL_PRUNE_BATCH_SIZE,
    RAIL_REFUSAL_PRUNE_MAX_BATCHES,
    RAIL_REFUSAL_RETENTION_DAYS,
} from '@ever-works/contracts';
import { SafetyRefusalPruneService } from './safety-refusal-prune.service';

/**
 * Safety rails (AW-24) — the nightly retention pass over `rail_refusals`.
 *
 * The log is append-only, so this is the ONLY thing that ever removes a row.
 * Two properties matter and neither is visible from the repository's own spec:
 * the pass must drain a backlog in bounded batches rather than one statement,
 * and it must never be able to take a process down or hold the lock all night.
 */
describe('SafetyRefusalPruneService', () => {
    const build = (prune: jest.Mock, locked = false) => {
        const taskLock = {
            runExclusive: jest.fn(
                async (
                    _key: string,
                    work: () => Promise<void>,
                    options?: { onLocked?: () => void },
                ) => {
                    if (locked) {
                        options?.onLocked?.();
                        return;
                    }
                    await work();
                },
            ),
        };
        const refusals = { prune };
        return {
            service: new SafetyRefusalPruneService(refusals as never, taskLock as never),
            refusals,
            taskLock,
        };
    };

    it('deletes at the retention horizon the product promises', async () => {
        const { service, refusals } = build(jest.fn().mockResolvedValue(0));
        await service.prune();
        // FR-67: ninety days, and the number lives in the contract so the
        // screen and the prune cannot disagree about it.
        expect(refusals.prune).toHaveBeenCalledWith(
            RAIL_REFUSAL_RETENTION_DAYS,
            RAIL_REFUSAL_PRUNE_BATCH_SIZE,
        );
    });

    it('drains a backlog across batches and stops on the first short one', async () => {
        const prune = jest
            .fn()
            .mockResolvedValueOnce(RAIL_REFUSAL_PRUNE_BATCH_SIZE)
            .mockResolvedValueOnce(RAIL_REFUSAL_PRUNE_BATCH_SIZE)
            .mockResolvedValueOnce(12);
        const { service } = build(prune);

        await expect(service.prune()).resolves.toBe(RAIL_REFUSAL_PRUNE_BATCH_SIZE * 2 + 12);
        // A short batch means the horizon is clear, so the loop stops on it
        // rather than spending one more query to prove it.
        expect(prune).toHaveBeenCalledTimes(3);
    });

    it('stops at the batch ceiling rather than holding the lock all night', async () => {
        const prune = jest.fn().mockResolvedValue(RAIL_REFUSAL_PRUNE_BATCH_SIZE);
        const { service } = build(prune);

        await service.prune();

        expect(prune).toHaveBeenCalledTimes(RAIL_REFUSAL_PRUNE_MAX_BATCHES);
    });

    it('writes nothing on a second pass — the first already cleared the horizon', async () => {
        const prune = jest.fn().mockResolvedValueOnce(40).mockResolvedValueOnce(0);
        const { service } = build(prune);

        await expect(service.prune()).resolves.toBe(40);
        await expect(service.prune()).resolves.toBe(0);
    });

    it('takes the task lock so two replicas do not double-delete', async () => {
        const { service, taskLock } = build(jest.fn().mockResolvedValue(0));
        await service.pruneExpiredRefusals();
        expect(taskLock.runExclusive).toHaveBeenCalledWith(
            'safety-refusals:prune',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 60 * 60 * 1000 }),
        );
    });

    it('does nothing at all when another replica holds the lock', async () => {
        const prune = jest.fn();
        const { service } = build(prune, true);
        await service.pruneExpiredRefusals();
        expect(prune).not.toHaveBeenCalled();
    });

    it('swallows a failed prune — retention is never worth a process-level event', async () => {
        const { service } = build(jest.fn().mockRejectedValue(new Error('deadlock detected')));
        // Tomorrow's pass picks up whatever this one left: the cut-off is
        // computed from `now`, not from a stored cursor.
        await expect(service.pruneExpiredRefusals()).resolves.toBeUndefined();
    });

    it('runs daily, offset from the other nightly passes', () => {
        const cron = Reflect.getMetadata(
            SCHEDULE_CRON_OPTIONS,
            SafetyRefusalPruneService.prototype.pruneExpiredRefusals,
        ) as { cronTime?: string } | undefined;
        // 03:20 UTC — clear of the 00:05 credits grant, the 03:17 transcript
        // sweep, the 04:00 plugin-usage prune and the 07:15 digest, so the
        // nightly passes do not stack on one connection pool.
        expect(cron?.cronTime).toBe('20 3 * * *');
    });
});
