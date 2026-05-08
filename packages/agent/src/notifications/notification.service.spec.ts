import { BadRequestException } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationType, NotificationCategory } from '@src/entities';

function makeRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        findByDeduplicationKey: jest.fn(),
        create: jest.fn(),
        findByUserId: jest.fn(),
        getUnreadCount: jest.fn(),
        findByIdAndUserId: jest.fn(),
        markAsRead: jest.fn(),
        markAllAsRead: jest.fn(),
        dismiss: jest.fn(),
        getPersistentNotifications: jest.fn(),
        clearDeduplicationKey: jest.fn(),
        deleteExpired: jest.fn(),
        deleteOlderThan: jest.fn(),
        ...overrides,
    };
}

function makeService(repoOverrides: Record<string, jest.Mock> = {}) {
    const repository = makeRepository(repoOverrides);
    const service = new NotificationService(repository as any);
    return { service, repository };
}

describe('NotificationService', () => {
    describe('create — deduplication', () => {
        it('returns the existing notification when one with the dedup key is present and not dismissed', async () => {
            const existing = { id: 'n1', isDismissed: false };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(existing),
                create: jest.fn(),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-1',
            } as any);

            expect(result).toBe(existing);
            expect(repository.findByDeduplicationKey).toHaveBeenCalledWith('u1', 'dk-1');
            expect(repository.create).not.toHaveBeenCalled();
        });

        it('proceeds to create when the existing dedup-keyed notification IS dismissed', async () => {
            const existing = { id: 'n1', isDismissed: true };
            const created = { id: 'n2' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(existing),
                create: jest.fn().mockResolvedValue(created),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-1',
            } as any);

            expect(result).toBe(created);
            expect(repository.create).toHaveBeenCalledTimes(1);
        });

        it('skips the dedup lookup entirely when dto.deduplicationKey is missing', async () => {
            const created = { id: 'n2' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn(),
                create: jest.fn().mockResolvedValue(created),
            });

            await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
            } as any);

            expect(repository.findByDeduplicationKey).not.toHaveBeenCalled();
            expect(repository.create).toHaveBeenCalledTimes(1);
        });

        it('proceeds to create when no existing notification matches the dedup key', async () => {
            const created = { id: 'n3' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue(created),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-fresh',
            } as any);

            expect(result).toBe(created);
            expect(repository.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('create — race-condition recovery on unique-constraint error', () => {
        it('recovers from a Postgres 23505 race by re-reading the existing notification', async () => {
            const existing = { id: 'n-existing' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest
                    .fn()
                    .mockResolvedValueOnce(null) // first lookup: no existing
                    .mockResolvedValueOnce(existing), // post-error refetch
                create: jest.fn().mockRejectedValue({ code: '23505' }),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-race',
            } as any);

            expect(result).toBe(existing);
            expect(repository.findByDeduplicationKey).toHaveBeenCalledTimes(2);
        });

        it('recovers from a MySQL ER_DUP_ENTRY race', async () => {
            const existing = { id: 'n-existing' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest
                    .fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(existing),
                create: jest.fn().mockRejectedValue({ code: 'ER_DUP_ENTRY' }),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-race',
            } as any);

            expect(result).toBe(existing);
            expect(repository.findByDeduplicationKey).toHaveBeenCalledTimes(2);
        });

        it('recovers from a SQLite SQLITE_CONSTRAINT race', async () => {
            const existing = { id: 'n-existing' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest
                    .fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(existing),
                create: jest.fn().mockRejectedValue({ code: 'SQLITE_CONSTRAINT' }),
            });

            const result = await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                deduplicationKey: 'dk-race',
            } as any);

            expect(result).toBe(existing);
            expect(repository.findByDeduplicationKey).toHaveBeenCalledTimes(2);
        });

        it('rethrows the original error when the post-error refetch returns null', async () => {
            const err = { code: '23505', message: 'duplicate key' };
            const { service } = makeService({
                findByDeduplicationKey: jest
                    .fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(null),
                create: jest.fn().mockRejectedValue(err),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                    deduplicationKey: 'dk-race',
                } as any),
            ).rejects.toEqual(err);
        });

        it('rethrows non-unique-constraint errors verbatim (no refetch attempted)', async () => {
            const err = new Error('connection refused');
            const findSpy = jest.fn().mockResolvedValueOnce(null);
            const { service } = makeService({
                findByDeduplicationKey: findSpy,
                create: jest.fn().mockRejectedValue(err),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                    deduplicationKey: 'dk-race',
                } as any),
            ).rejects.toBe(err);

            // Only the first pre-create lookup; no post-error refetch.
            expect(findSpy).toHaveBeenCalledTimes(1);
        });

        it('rethrows unique-constraint errors when no dedup key was provided (refetch not possible)', async () => {
            const err = { code: '23505' };
            const { service, repository } = makeService({
                create: jest.fn().mockRejectedValue(err),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                } as any),
            ).rejects.toEqual(err);
            expect(repository.findByDeduplicationKey).not.toHaveBeenCalled();
        });

        it('treats null/undefined errors as non-constraint and rethrows', async () => {
            const { service } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockRejectedValue(null),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                    deduplicationKey: 'dk',
                } as any),
            ).rejects.toBeNull();
        });

        it('treats string errors as non-constraint and rethrows', async () => {
            const { service } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockRejectedValue('boom'),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                    deduplicationKey: 'dk',
                } as any),
            ).rejects.toBe('boom');
        });

        it('treats objects without a `code` property as non-constraint and rethrows', async () => {
            const err = { message: 'oops' };
            const { service } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockRejectedValue(err),
            });

            await expect(
                service.create({
                    userId: 'u1',
                    type: NotificationType.INFO,
                    category: NotificationCategory.SYSTEM,
                    title: 't',
                    message: 'm',
                    deduplicationKey: 'dk',
                } as any),
            ).rejects.toEqual(err);
        });
    });

    describe('getNotifications', () => {
        it('forwards (userId, options) to repository.findByUserId', async () => {
            const out = [{ id: 'a' }];
            const { service, repository } = makeService({
                findByUserId: jest.fn().mockResolvedValue(out),
            });

            const result = await service.getNotifications('u', {
                unreadOnly: true,
                limit: 10,
            } as any);

            expect(result).toBe(out);
            expect(repository.findByUserId).toHaveBeenCalledWith('u', {
                unreadOnly: true,
                limit: 10,
            });
        });

        it('forwards undefined options when caller omits them', async () => {
            const { service, repository } = makeService({
                findByUserId: jest.fn().mockResolvedValue([]),
            });

            await service.getNotifications('u');

            expect(repository.findByUserId).toHaveBeenCalledWith('u', undefined);
        });
    });

    describe('getUnreadCount', () => {
        it('forwards userId to repository.getUnreadCount', async () => {
            const { service, repository } = makeService({
                getUnreadCount: jest.fn().mockResolvedValue(7),
            });

            const result = await service.getUnreadCount('u');

            expect(result).toBe(7);
            expect(repository.getUnreadCount).toHaveBeenCalledWith('u');
        });
    });

    describe('markAsRead', () => {
        it('throws BadRequestException when the notification does not belong to the user', async () => {
            const { service, repository } = makeService({
                findByIdAndUserId: jest.fn().mockResolvedValue(null),
            });

            await expect(service.markAsRead('u', 'n')).rejects.toBeInstanceOf(BadRequestException);
            expect(repository.markAsRead).not.toHaveBeenCalled();
        });

        it('calls repository.markAsRead when the notification belongs to the user', async () => {
            const { service, repository } = makeService({
                findByIdAndUserId: jest.fn().mockResolvedValue({ id: 'n1' }),
                markAsRead: jest.fn().mockResolvedValue(undefined),
            });

            await service.markAsRead('u', 'n1');

            expect(repository.findByIdAndUserId).toHaveBeenCalledWith('n1', 'u');
            expect(repository.markAsRead).toHaveBeenCalledWith('n1');
        });
    });

    describe('markAllAsRead', () => {
        it('forwards userId to repository.markAllAsRead', async () => {
            const { service, repository } = makeService({
                markAllAsRead: jest.fn().mockResolvedValue(undefined),
            });

            await service.markAllAsRead('u');

            expect(repository.markAllAsRead).toHaveBeenCalledWith('u');
        });
    });

    describe('dismiss', () => {
        it('throws BadRequestException when the notification does not belong to the user', async () => {
            const { service, repository } = makeService({
                findByIdAndUserId: jest.fn().mockResolvedValue(null),
            });

            await expect(service.dismiss('u', 'n')).rejects.toBeInstanceOf(BadRequestException);
            expect(repository.dismiss).not.toHaveBeenCalled();
        });

        it('refuses to dismiss a persistent notification with the documented error message', async () => {
            const { service, repository } = makeService({
                findByIdAndUserId: jest.fn().mockResolvedValue({ id: 'n', isPersistent: true }),
            });

            await expect(service.dismiss('u', 'n')).rejects.toThrow(
                'Persistent notifications cannot be dismissed. Please resolve the underlying issue first.',
            );
            expect(repository.dismiss).not.toHaveBeenCalled();
        });

        it('calls repository.dismiss for non-persistent notifications', async () => {
            const { service, repository } = makeService({
                findByIdAndUserId: jest.fn().mockResolvedValue({ id: 'n', isPersistent: false }),
                dismiss: jest.fn().mockResolvedValue(undefined),
            });

            await service.dismiss('u', 'n');

            expect(repository.dismiss).toHaveBeenCalledWith('n');
        });
    });

    describe('getPersistentNotifications', () => {
        it('forwards userId to repository.getPersistentNotifications', async () => {
            const out = [{ id: 'p1' }];
            const { service, repository } = makeService({
                getPersistentNotifications: jest.fn().mockResolvedValue(out),
            });

            const result = await service.getPersistentNotifications('u');

            expect(result).toBe(out);
            expect(repository.getPersistentNotifications).toHaveBeenCalledWith('u');
        });
    });

    describe('clearByDeduplicationKey', () => {
        it('forwards (userId, deduplicationKey) to repository.clearDeduplicationKey', async () => {
            const { service, repository } = makeService({
                clearDeduplicationKey: jest.fn().mockResolvedValue(undefined),
            });

            await service.clearByDeduplicationKey('u', 'dk-x');

            expect(repository.clearDeduplicationKey).toHaveBeenCalledWith('u', 'dk-x');
        });
    });

    describe('notifyAiCreditsDepleted', () => {
        it('emits a persistent ERROR notification with the default templated message and stable dedup key', async () => {
            const created = { id: 'created' };
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue(created),
            });

            await service.notifyAiCreditsDepleted('u', 'OpenAI');

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u',
                    type: NotificationType.ERROR,
                    category: NotificationCategory.AI_CREDITS,
                    title: 'AI Credits Depleted',
                    message:
                        'Your OpenAI credits have been exhausted. Please add more credits to continue.',
                    actionUrl: '/settings',
                    actionLabel: 'Add Credits',
                    isPersistent: true,
                    deduplicationKey: 'ai_credits_depleted_openai',
                }),
            );
        });

        it('uses the explicit errorMessage override over the default template', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyAiCreditsDepleted('u', 'Anthropic', 'Custom error text');

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'Custom error text' }),
            );
        });

        it('lower-cases the provider in the dedup key', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyAiCreditsDepleted('u', 'OpenAI');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.deduplicationKey).toBe('ai_credits_depleted_openai');
        });
    });

    describe('notifyAiProviderError', () => {
        it('emits a NON-persistent ERROR notification with provider+error in message', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyAiProviderError('u', 'Anthropic', 'Bad request');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.title).toBe('AI Provider Error');
            expect(args.message).toBe('Error with Anthropic: Bad request');
            expect(args.actionUrl).toBe('/settings');
            expect(args.actionLabel).toBe('Check Settings');
            expect(args.deduplicationKey).toBe('ai_provider_error_anthropic');
            // No `isPersistent: true` for this convenience method
            expect(args.isPersistent).toBeUndefined();
        });
    });

    describe('notifyGenerationAccountError', () => {
        it('emits an ERROR notification with workId-stable dedup key + workId/workName metadata', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyGenerationAccountError('u', 'work-123', 'Best Tools', 'OOM');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.title).toBe('Generation Failed');
            expect(args.message).toBe('Generation for "Best Tools" failed: OOM');
            expect(args.actionUrl).toBe('/works/work-123');
            expect(args.actionLabel).toBe('View Work');
            expect(args.metadata).toEqual({ workId: 'work-123', workName: 'Best Tools' });
            expect(args.deduplicationKey).toBe('generation_error_work-123');
        });
    });

    describe('notifySchedulePaused', () => {
        it('emits a WARNING notification routed to the per-work schedule page', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifySchedulePaused('u', 'w42', 'My Work', 'Quota exhausted');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.type).toBe(NotificationType.WARNING);
            expect(args.category).toBe(NotificationCategory.GENERATION);
            expect(args.title).toBe('Schedule Paused');
            expect(args.message).toBe('Scheduled updates for "My Work" paused: Quota exhausted');
            expect(args.actionUrl).toBe('/works/w42/generator/schedule');
            expect(args.actionLabel).toBe('View Schedule');
            expect(args.metadata).toEqual({ workId: 'w42', workName: 'My Work' });
            expect(args.deduplicationKey).toBe('schedule_paused_w42');
        });
    });

    describe('notifyGitAuthExpired', () => {
        it('emits a persistent ERROR notification routed to /settings/oauth', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyGitAuthExpired('u', 'GitHub');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.type).toBe(NotificationType.ERROR);
            expect(args.category).toBe(NotificationCategory.SECURITY);
            expect(args.title).toBe('Git Authentication Expired');
            expect(args.message).toBe('Your GitHub authentication has expired. Please reconnect.');
            expect(args.actionUrl).toBe('/settings/oauth');
            expect(args.actionLabel).toBe('Reconnect');
            expect(args.isPersistent).toBe(true);
            expect(args.deduplicationKey).toBe('git_auth_expired_github');
        });

        it('lower-cases the provider segment of the dedup key', async () => {
            const { service, repository } = makeService({
                findByDeduplicationKey: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'c' }),
            });

            await service.notifyGitAuthExpired('u', 'GitLab');

            const args = (repository.create as jest.Mock).mock.calls[0][0];
            expect(args.deduplicationKey).toBe('git_auth_expired_gitlab');
        });
    });

    describe('cleanup', () => {
        it('runs three deletes (expired / 7-day-dismissed / 30-day-old) and returns counts', async () => {
            const { service, repository } = makeService({
                deleteExpired: jest.fn().mockResolvedValue(5),
                deleteOlderThan: jest.fn(),
            });
            (repository.deleteOlderThan as jest.Mock)
                .mockResolvedValueOnce(3) // 7d dismissed
                .mockResolvedValueOnce(11); // 30d old

            const result = await service.cleanup();

            expect(result).toEqual({ expired: 5, dismissed: 3, old: 11 });
            expect(repository.deleteExpired).toHaveBeenCalledTimes(1);
            expect(repository.deleteOlderThan).toHaveBeenCalledTimes(2);
            expect(repository.deleteOlderThan).toHaveBeenNthCalledWith(1, {
                olderThanDays: 7,
                isDismissed: true,
            });
            expect(repository.deleteOlderThan).toHaveBeenNthCalledWith(2, {
                olderThanDays: 30,
            });
        });

        it('runs the deletes in order: expired, then 7-day-dismissed, then 30-day-old', async () => {
            const order: string[] = [];
            const { service, repository } = makeService({
                deleteExpired: jest.fn().mockImplementation(async () => {
                    order.push('expired');
                    return 0;
                }),
                deleteOlderThan: jest.fn().mockImplementation(async (opts: any) => {
                    order.push(`olderThan-${opts.isDismissed ? 'dismissed-7' : 'all-30'}`);
                    return 0;
                }),
            });

            await service.cleanup();

            expect(order).toEqual(['expired', 'olderThan-dismissed-7', 'olderThan-all-30']);
            expect(repository).toBeDefined();
        });
    });
});
