import { ReleaseVerificationCronService } from './release-verification-cron.service';

/**
 * Post-deploy verification (self-build slice AJ, EW-809) — the clock.
 *
 * Small on purpose: the state machine is tested in
 * `packages/agent/src/tasks-domain/__tests__/release-verification.service.spec.ts`
 * against a real database. What has to be true HERE is that the sweep runs
 * exclusively, that it cannot take the process down, and that it does not
 * quietly do the work twice when two API replicas tick at the same second.
 */
describe('ReleaseVerificationCronService', () => {
    function build(opts: { locked?: boolean; sweepError?: Error } = {}) {
        const verification = {
            enqueueDueChecks: opts.sweepError
                ? jest.fn().mockRejectedValue(opts.sweepError)
                : jest.fn().mockResolvedValue({ considered: 2, enqueued: 1, settled: 1 }),
        };
        const taskLockService = {
            runExclusive: jest
                .fn()
                .mockImplementation(
                    async (
                        _key: string,
                        work: () => Promise<void>,
                        options: { onLocked?: () => void },
                    ) => {
                        if (opts.locked) {
                            options.onLocked?.();
                            return;
                        }
                        await work();
                    },
                ),
        };
        return {
            cron: new ReleaseVerificationCronService(
                verification as never,
                taskLockService as never,
            ),
            verification,
            taskLockService,
        };
    }

    it('runs the sweep under a distributed lock', async () => {
        // Every API replica has this cron. Without the lock they would all
        // claim attempts for the same rows on the same tick — and while the
        // per-row compare-and-set would still keep exactly one browser per
        // promotion, the wasted enqueues would burn the attempt budget that
        // bounds the whole lane.
        const { cron, verification, taskLockService } = build();

        await cron.sweep();

        expect(taskLockService.runExclusive).toHaveBeenCalledTimes(1);
        expect(taskLockService.runExclusive.mock.calls[0][0]).toBe(
            'release:post-deploy-verification',
        );
        expect(verification.enqueueDueChecks).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all when another instance holds the lock', async () => {
        const { cron, verification } = build({ locked: true });

        await cron.sweep();

        expect(verification.enqueueDueChecks).not.toHaveBeenCalled();
    });

    it('never throws — an unhandled rejection in a @Cron handler takes the pod down', async () => {
        const { cron } = build({ sweepError: new Error('database down') });

        await expect(cron.sweep()).resolves.toBeUndefined();
    });

    it('holds the lock for at least as long as its own interval', async () => {
        // A TTL shorter than the cron period lets the next tick start while
        // the previous one is still enqueueing.
        const { cron, taskLockService } = build();

        await cron.sweep();

        expect(taskLockService.runExclusive.mock.calls[0][2].ttlMs).toBeGreaterThanOrEqual(
            5 * 60_000,
        );
    });

    it('exposes no way to start, retry or force a verification', () => {
        // The lane's whole value is that it withholds a verdict until it
        // has one. A "run it now" entry point is how somebody talks a green
        // reading out of it — and it is also how a bounded lane stops being
        // bounded, because the attempt budget assumes one enqueuer.
        const methods = Object.getOwnPropertyNames(ReleaseVerificationCronService.prototype).filter(
            (name) => name !== 'constructor',
        );
        expect(methods).toEqual(['sweep']);
    });
});
