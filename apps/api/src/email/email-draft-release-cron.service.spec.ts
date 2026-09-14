jest.mock('@ever-works/agent/cache', () => ({
    DistributedTaskLockService: class DistributedTaskLockService {},
}));
jest.mock('@ever-works/agent/email', () => ({
    EmailDraftService: class EmailDraftService {},
}));

import {
    EMAIL_DRAFT_RELEASE_SWEEP_LOCK_KEY,
    EmailDraftReleaseCronService,
} from './email-draft-release-cron.service';

/**
 * Agent email (AW-05) — the clock that releases approved drafts the
 * in-process decision listener missed. Which drafts qualify, and that a
 * release is sent once, are tested beside `EmailDraftService` and the
 * repository query; here: the sweep runs exclusively and never throws.
 */
describe('EmailDraftReleaseCronService', () => {
    function build(opts: { locked?: boolean; sweepError?: Error } = {}) {
        const drafts = {
            releaseApprovedDrafts: opts.sweepError
                ? jest.fn().mockRejectedValue(opts.sweepError)
                : jest.fn().mockResolvedValue({ considered: 1, released: 1, failed: 0 }),
        };
        const taskLockService = {
            runExclusive: jest.fn(
                async (
                    _key: string,
                    work: () => Promise<void>,
                    options: { onLocked?: () => void; ttlMs?: number },
                ) => {
                    if (opts.locked) {
                        options.onLocked?.();
                        return;
                    }
                    await work();
                },
            ),
        };
        const cron = new EmailDraftReleaseCronService(drafts as never, taskLockService as never);
        const logger = (
            cron as unknown as {
                logger: { warn: () => void; error: () => void; debug: () => void };
            }
        ).logger;
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
        return { cron, drafts, taskLockService };
    }

    it('releases stranded drafts under a distributed lock', async () => {
        const { cron, drafts, taskLockService } = build();

        await cron.sweep();

        expect(taskLockService.runExclusive).toHaveBeenCalledTimes(1);
        expect(taskLockService.runExclusive.mock.calls[0][0]).toBe(
            EMAIL_DRAFT_RELEASE_SWEEP_LOCK_KEY,
        );
        expect(drafts.releaseApprovedDrafts).toHaveBeenCalledTimes(1);
    });

    it('does nothing when another instance holds the lock', async () => {
        const { cron, drafts } = build({ locked: true });
        await cron.sweep();
        expect(drafts.releaseApprovedDrafts).not.toHaveBeenCalled();
    });

    it('never throws — an unhandled rejection in a @Cron handler takes the pod down', async () => {
        const { cron } = build({ sweepError: new Error('database down') });
        await expect(cron.sweep()).resolves.toBeUndefined();
    });

    it('holds the lock for no less than its own one-minute interval', async () => {
        const { cron, taskLockService } = build();
        await cron.sweep();
        expect(taskLockService.runExclusive.mock.calls[0][2].ttlMs).toBeGreaterThanOrEqual(60_000);
    });
});
