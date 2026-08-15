import { NotificationService, NOTIFICATION_FANOUT_EVENT } from '../notification.service';
import { NotificationCategory, NotificationType } from '../../entities/notification.types';

/**
 * The "Local runner fallback → cloud" notice.
 *
 * Why this is a notification rather than a log line: choosing a local
 * runner is a statement that WHERE a run executes matters (the checkout,
 * the credentials, the GPU live on that machine). A silent relocation is
 * therefore a changed outcome, not a graceful degradation — and the
 * REASON is what tells the owner whether to wait, enrol another machine,
 * or move the Work to `local-wait`.
 *
 * The dedup key is per (task, reason) on purpose, and both halves are
 * tested: a Task retried in a loop while a laptop is closed must produce
 * one entry, but "busy" becoming "offline" is news and must get through.
 */
describe('NotificationService.notifyFleetRunnerFallback', () => {
    let repository: {
        create: jest.Mock;
        findByDeduplicationKey: jest.Mock;
    };
    let eventEmitter: { emit: jest.Mock };

    beforeEach(() => {
        repository = {
            create: jest.fn(async (dto) => ({ id: 'notification-1', ...dto })),
            findByDeduplicationKey: jest.fn(async () => null),
        };
        eventEmitter = { emit: jest.fn() };
    });

    const build = () => new NotificationService(repository as never, eventEmitter as never);

    it('writes an in-app row pointing at the fleet settings page', async () => {
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: 'runners-busy',
            runnerCount: 1,
        });

        const dto = repository.create.mock.calls[0][0];
        expect(dto.userId).toBe('user-1');
        expect(dto.type).toBe(NotificationType.INFO);
        expect(dto.category).toBe(NotificationCategory.AGENT);
        expect(dto.title).toContain('Local runner fallback');
        expect(dto.actionUrl).toBe('/settings/fleet');
        expect(dto.metadata).toMatchObject({
            taskId: 'task-1',
            reason: 'runners-busy',
            runnerCount: 1,
        });
    });

    it.each([
        ['no-runners', 'no local runner is enrolled'],
        ['runners-offline', 'your local runner is offline'],
        ['runners-busy', 'your local runner was busy'],
    ])('explains the %s reason in plain language', async (reason, expected) => {
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason,
            runnerCount: 0,
        });

        expect(repository.create.mock.calls[0][0].message).toContain(expected);
    });

    it('emits the v2 fanout under the fleet_runner_fallback event key', async () => {
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: 'runners-busy',
            runnerCount: 1,
        });

        expect(eventEmitter.emit).toHaveBeenCalledWith(
            NOTIFICATION_FANOUT_EVENT,
            expect.objectContaining({
                userId: 'user-1',
                // Must match the key seeded by both the migration AND
                // NotificationEventTypeBootstrap, or the fanout resolves
                // no subscription and the notice reaches nobody.
                eventKey: 'fleet_runner_fallback',
                urgent: false,
            }),
        );
    });

    it('dedups per (task, reason) so a retry loop cannot spam the owner', async () => {
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: 'runners-busy',
            runnerCount: 1,
        });

        expect(repository.create.mock.calls[0][0].deduplicationKey).toBe(
            'fleet_runner_fallback_task-1_runners-busy',
        );
    });

    it('lets a DIFFERENT reason through — busy becoming offline is news', async () => {
        const service = build();
        await service.notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: 'runners-busy',
            runnerCount: 1,
        });
        await service.notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: 'runners-offline',
            runnerCount: 1,
        });

        const keys = repository.create.mock.calls.map((call) => call[0].deduplicationKey);
        expect(new Set(keys).size).toBe(2);
    });

    it('sanitizes the reason token before it reaches the message or the key', async () => {
        // The reason is platform-written today, but it is INTERPOLATED
        // into rendered text, so it goes through the same label sanitizer
        // as every other interpolated value.
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            taskId: 'task-1',
            reason: '<script>alert(1)</script>',
            runnerCount: 0,
        });

        const dto = repository.create.mock.calls[0][0];
        expect(dto.metadata.reason).not.toContain('<');
        expect(dto.metadata.reason).not.toContain('>');
        expect(dto.deduplicationKey).not.toContain('<');
    });

    it('still writes the row when no task id is known', async () => {
        await build().notifyFleetRunnerFallback({
            userId: 'user-1',
            reason: 'no-runners',
            runnerCount: 0,
        });

        const dto = repository.create.mock.calls[0][0];
        expect(dto.metadata.taskId).toBeNull();
        expect(dto.deduplicationKey).toBe('fleet_runner_fallback_unknown_no-runners');
    });

    it('works without an EventEmitter (v1-only wiring)', async () => {
        const service = new NotificationService(repository as never);

        await expect(
            service.notifyFleetRunnerFallback({
                userId: 'user-1',
                reason: 'no-runners',
                runnerCount: 0,
            }),
        ).resolves.toBeUndefined();
        expect(repository.create).toHaveBeenCalledTimes(1);
    });
});
