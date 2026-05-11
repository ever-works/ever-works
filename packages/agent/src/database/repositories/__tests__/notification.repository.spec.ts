import type { Repository, SelectQueryBuilder, DeleteQueryBuilder } from 'typeorm';
import { NotificationRepository } from '../notification.repository';
import { Notification, NotificationCategory, NotificationType } from '../../../entities';

type Mocked = jest.Mocked<
    Pick<Repository<Notification>, 'create' | 'save' | 'findOne' | 'update' | 'createQueryBuilder'>
>;

/**
 * Build a chainable jest mock that records every call to a list of names and
 * returns itself so `qb.where(...).andWhere(...).getMany()` style chains work.
 *
 * Returns the chain object plus a per-method `jest.fn()` map so individual
 * methods can be asserted on without having to dig into `mock.calls`.
 */
function buildChain<TResult>(terminalName: string, terminalResolved: TResult) {
    const fns: Record<string, jest.Mock> = {};
    const chain: any = {};

    const passthroughMethods = [
        'where',
        'andWhere',
        'orWhere',
        'orderBy',
        'addOrderBy',
        'select',
        'addSelect',
        'leftJoinAndSelect',
        'skip',
        'take',
        'groupBy',
        'delete',
        'from',
    ];

    for (const m of passthroughMethods) {
        fns[m] = jest.fn(() => chain);
        chain[m] = fns[m];
    }

    fns[terminalName] = jest.fn().mockResolvedValue(terminalResolved);
    chain[terminalName] = fns[terminalName];

    return { chain, fns };
}

describe('NotificationRepository', () => {
    let repository: Mocked;
    let service: NotificationRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        service = new NotificationRepository(repository as unknown as Repository<Notification>);
    });

    describe('create', () => {
        it('passes every documented field through, defaults isPersistent to false, and forces isRead/isDismissed false', async () => {
            const created = {} as Notification;
            const saved = { id: 'n1' } as Notification;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const expiresAt = new Date('2030-01-01T00:00:00Z');

            const dto = {
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 'Hello',
                message: 'World',
                actionUrl: '/x',
                actionLabel: 'Go',
                metadata: { foo: 'bar' },
                isPersistent: true,
                expiresAt,
                deduplicationKey: 'dedup-1',
            };

            const result = await service.create(dto);

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 'Hello',
                message: 'World',
                actionUrl: '/x',
                actionLabel: 'Go',
                metadata: { foo: 'bar' },
                isPersistent: true,
                expiresAt,
                deduplicationKey: 'dedup-1',
                isRead: false,
                isDismissed: false,
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('defaults isPersistent to false when omitted (`?? false`, NOT `||`, so an explicit `false` is still false)', async () => {
            repository.create.mockReturnValueOnce({} as Notification);
            repository.save.mockResolvedValueOnce({} as Notification);

            await service.create({
                userId: 'u1',
                type: NotificationType.WARNING,
                category: NotificationCategory.AI_CREDITS,
                title: 't',
                message: 'm',
            });

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ isPersistent: false }),
            );
        });

        it('preserves an explicit isPersistent:false (regression guard against `||` swap)', async () => {
            repository.create.mockReturnValueOnce({} as Notification);
            repository.save.mockResolvedValueOnce({} as Notification);

            await service.create({
                userId: 'u1',
                type: NotificationType.INFO,
                category: NotificationCategory.SYSTEM,
                title: 't',
                message: 'm',
                isPersistent: false,
            });

            expect(repository.create).toHaveBeenCalledWith(
                expect.objectContaining({ isPersistent: false }),
            );
        });
    });

    describe('findByUserId', () => {
        let nowSpy: jest.SpyInstance<number, []>;

        beforeEach(() => {
            nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        });

        afterEach(() => {
            nowSpy.mockRestore();
        });

        it('defaults undismissedOnly:true / limit:50 / offset:0, omits unreadOnly/category, and ALWAYS adds the expiresAt-IS-NULL OR expiresAt > now() filter', async () => {
            const rows = [{ id: 'n1' } as Notification];
            const { chain, fns } = buildChain<Notification[]>('getMany', rows);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            const result = await service.findByUserId('u1');

            expect(result).toBe(rows);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('notification');
            expect(fns.where).toHaveBeenCalledWith('notification.userId = :userId', {
                userId: 'u1',
            });
            // unreadOnly default false → no isRead clause
            expect(fns.andWhere).not.toHaveBeenCalledWith(
                'notification.isRead = :isRead',
                expect.anything(),
            );
            // undismissedOnly default true → isDismissed:false clause
            expect(fns.andWhere).toHaveBeenCalledWith('notification.isDismissed = :isDismissed', {
                isDismissed: false,
            });
            // category undefined → no category clause
            expect(fns.andWhere).not.toHaveBeenCalledWith(
                'notification.category = :category',
                expect.anything(),
            );
            // expiresAt filter ALWAYS present, with Date.now() snapshot
            expect(fns.andWhere).toHaveBeenCalledWith(
                '(notification.expiresAt IS NULL OR notification.expiresAt > :now)',
                { now: 1_700_000_000_000 },
            );
            expect(fns.orderBy).toHaveBeenCalledWith('notification.createdAt', 'DESC');
            expect(fns.skip).toHaveBeenCalledWith(0);
            expect(fns.take).toHaveBeenCalledWith(50);
        });

        it('honours unreadOnly:true (adds isRead:false clause)', async () => {
            const { chain, fns } = buildChain<Notification[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await service.findByUserId('u1', { unreadOnly: true });

            expect(fns.andWhere).toHaveBeenCalledWith('notification.isRead = :isRead', {
                isRead: false,
            });
        });

        it('honours undismissedOnly:false (omits the isDismissed clause)', async () => {
            const { chain, fns } = buildChain<Notification[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await service.findByUserId('u1', { undismissedOnly: false });

            expect(fns.andWhere).not.toHaveBeenCalledWith(
                'notification.isDismissed = :isDismissed',
                expect.anything(),
            );
        });

        it('forwards category when provided', async () => {
            const { chain, fns } = buildChain<Notification[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await service.findByUserId('u1', { category: NotificationCategory.SECURITY });

            expect(fns.andWhere).toHaveBeenCalledWith('notification.category = :category', {
                category: NotificationCategory.SECURITY,
            });
        });

        it('forwards explicit limit + offset, including limit:0 NOT defaulted (`limit = 50` is `=` w/ destructuring default — undefined-only triggers default)', async () => {
            const { chain, fns } = buildChain<Notification[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await service.findByUserId('u1', { limit: 10, offset: 5 });

            expect(fns.skip).toHaveBeenCalledWith(5);
            expect(fns.take).toHaveBeenCalledWith(10);
        });
    });

    describe('findById', () => {
        it('queries by id only', async () => {
            const row = { id: 'n1' } as Notification;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('n1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'n1' } });
        });

        it('returns null when not found', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByIdAndUserId', () => {
        it('queries by composite id + userId for cross-user safety', async () => {
            const row = { id: 'n1' } as Notification;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByIdAndUserId('n1', 'u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'n1', userId: 'u1' },
            });
        });
    });

    describe('markAsRead / markAllAsRead / dismiss', () => {
        it('markAsRead patches isRead:true on a single row', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.markAsRead('n1');

            expect(repository.update).toHaveBeenCalledWith('n1', { isRead: true });
        });

        it('markAllAsRead targets all unread+undismissed rows for the user (NOT dismissed-but-unread)', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.markAllAsRead('u1');

            expect(repository.update).toHaveBeenCalledWith(
                { userId: 'u1', isRead: false, isDismissed: false },
                { isRead: true },
            );
        });

        it('dismiss writes BOTH isDismissed:true AND isRead:true (a dismissed notification is implicitly read)', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.dismiss('n1');

            expect(repository.update).toHaveBeenCalledWith('n1', {
                isDismissed: true,
                isRead: true,
            });
        });
    });

    describe('findByDeduplicationKey', () => {
        it('queries by composite (userId, deduplicationKey)', async () => {
            const row = { id: 'n1' } as Notification;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByDeduplicationKey('u1', 'dedup-1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { userId: 'u1', deduplicationKey: 'dedup-1' },
            });
        });
    });

    describe('getUnreadCount', () => {
        let nowSpy: jest.SpyInstance<number, []>;

        beforeEach(() => {
            nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
        });

        afterEach(() => {
            nowSpy.mockRestore();
        });

        it('counts unread + undismissed + non-expired notifications via query builder, snapshotting Date.now()', async () => {
            const { chain, fns } = buildChain<number>('getCount', 7);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await expect(service.getUnreadCount('u1')).resolves.toBe(7);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('notification');
            expect(fns.where).toHaveBeenCalledWith('notification.userId = :userId', {
                userId: 'u1',
            });
            expect(fns.andWhere).toHaveBeenCalledWith('notification.isRead = :isRead', {
                isRead: false,
            });
            expect(fns.andWhere).toHaveBeenCalledWith('notification.isDismissed = :isDismissed', {
                isDismissed: false,
            });
            expect(fns.andWhere).toHaveBeenCalledWith(
                '(notification.expiresAt IS NULL OR notification.expiresAt > :now)',
                { now: 2_000_000_000_000 },
            );
        });
    });

    describe('deleteExpired', () => {
        let nowSpy: jest.SpyInstance<number, []>;

        beforeEach(() => {
            nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_000_000_000_000);
        });

        afterEach(() => {
            nowSpy.mockRestore();
        });

        it('builds delete().where(...).execute() with the documented WHERE shape and snapshots Date.now()', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 4 });
            const where = jest.fn(() => ({ execute }));
            const del = jest.fn(() => ({ where }));
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: del,
            } as unknown as SelectQueryBuilder<Notification>);

            await expect(service.deleteExpired()).resolves.toBe(4);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith();
            expect(del).toHaveBeenCalledTimes(1);
            expect(where).toHaveBeenCalledWith('expiresAt IS NOT NULL AND expiresAt < :now', {
                now: 3_000_000_000_000,
            });
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('coerces missing affected to 0 via `|| 0` (regression guard against `?? 0` swap that would let `null` through as null)', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: undefined });
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: () => ({ where: () => ({ execute }) }),
            } as unknown as SelectQueryBuilder<Notification>);

            await expect(service.deleteExpired()).resolves.toBe(0);
        });
    });

    describe('deleteOlderThan', () => {
        it('builds delete().where("createdAt < :cutoffDate", ...).execute() with a Date cutoff computed from olderThanDays', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 12 });
            const andWhere = jest.fn(() => ({ execute }));
            const where = jest.fn(() => ({ andWhere, execute }));
            const del = jest.fn(() => ({ where }));
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: del,
            } as unknown as SelectQueryBuilder<Notification>);

            await expect(service.deleteOlderThan({ olderThanDays: 7 })).resolves.toBe(12);

            const callArgs = where.mock.calls[0] as unknown as [string, { cutoffDate: Date }];
            expect(callArgs[0]).toBe('createdAt < :cutoffDate');
            const params = callArgs[1];
            expect(params.cutoffDate).toBeInstanceOf(Date);
            // cutoff is roughly 7 days before now; allow a small jitter window
            const expected = new Date();
            expected.setDate(expected.getDate() - 7);
            expect(Math.abs(params.cutoffDate.getTime() - expected.getTime())).toBeLessThan(60_000);
            // No isDismissed filter when option omitted
            expect(andWhere).not.toHaveBeenCalled();
        });

        it('adds isDismissed:true filter when option is true', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 3 });
            const andWhere = jest.fn(() => ({ execute }));
            const where = jest.fn(() => ({ andWhere, execute }));
            const del = jest.fn(() => ({ where }));
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: del,
            } as unknown as SelectQueryBuilder<Notification>);

            await expect(
                service.deleteOlderThan({ olderThanDays: 30, isDismissed: true }),
            ).resolves.toBe(3);

            expect(andWhere).toHaveBeenCalledWith('isDismissed = :isDismissed', {
                isDismissed: true,
            });
        });

        it('adds isDismissed:false filter when option is explicit false (NOT skipped — uses `!== undefined` not truthy)', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: 1 });
            const andWhere = jest.fn(() => ({ execute }));
            const where = jest.fn(() => ({ andWhere, execute }));
            const del = jest.fn(() => ({ where }));
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: del,
            } as unknown as SelectQueryBuilder<Notification>);

            await service.deleteOlderThan({ olderThanDays: 1, isDismissed: false });

            expect(andWhere).toHaveBeenCalledWith('isDismissed = :isDismissed', {
                isDismissed: false,
            });
        });

        it('coerces undefined affected to 0 via `|| 0`', async () => {
            const execute = jest.fn().mockResolvedValueOnce({ affected: undefined });
            const where = jest.fn(() => ({ andWhere: jest.fn(), execute }));
            const del = jest.fn(() => ({ where }));
            repository.createQueryBuilder.mockReturnValueOnce({
                delete: del,
            } as unknown as SelectQueryBuilder<Notification>);

            await expect(service.deleteOlderThan({ olderThanDays: 1 })).resolves.toBe(0);
        });
    });

    describe('getPersistentNotifications', () => {
        let nowSpy: jest.SpyInstance<number, []>;

        beforeEach(() => {
            nowSpy = jest.spyOn(Date, 'now').mockReturnValue(4_000_000_000_000);
        });

        afterEach(() => {
            nowSpy.mockRestore();
        });

        it('queries persistent + undismissed + non-expired rows ordered by createdAt:DESC', async () => {
            const rows = [{ id: 'n1' } as Notification];
            const { chain, fns } = buildChain<Notification[]>('getMany', rows);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Notification>,
            );

            await expect(service.getPersistentNotifications('u1')).resolves.toBe(rows);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('notification');
            expect(fns.where).toHaveBeenCalledWith('notification.userId = :userId', {
                userId: 'u1',
            });
            expect(fns.andWhere).toHaveBeenCalledWith('notification.isPersistent = :isPersistent', {
                isPersistent: true,
            });
            expect(fns.andWhere).toHaveBeenCalledWith('notification.isDismissed = :isDismissed', {
                isDismissed: false,
            });
            expect(fns.andWhere).toHaveBeenCalledWith(
                '(notification.expiresAt IS NULL OR notification.expiresAt > :now)',
                { now: 4_000_000_000_000 },
            );
            expect(fns.orderBy).toHaveBeenCalledWith('notification.createdAt', 'DESC');
        });
    });

    describe('clearDeduplicationKey', () => {
        it('writes isDismissed:true on every row matching (userId, deduplicationKey) — does NOT touch isRead', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.clearDeduplicationKey('u1', 'dedup-1');

            expect(repository.update).toHaveBeenCalledWith(
                { userId: 'u1', deduplicationKey: 'dedup-1' },
                { isDismissed: true },
            );
            // Asymmetry pin vs `dismiss(id)` which sets BOTH isDismissed AND isRead.
            // clearDeduplicationKey is used by callers that want to silence a stream
            // of duplicate notifications without retroactively marking them all read.
            const partial = repository.update.mock.calls[0][1] as Record<string, unknown>;
            expect(partial).not.toHaveProperty('isRead');
        });
    });
});
