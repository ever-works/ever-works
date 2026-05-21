import { AnonymousUserCleanupService } from '../anonymous-user-cleanup.service';

describe('AnonymousUserCleanupService (EW-617 G2)', () => {
    const buildService = (storage?: { deleteAllByOwner?: jest.Mock; providerName?: string }) => {
        const userRepository = {
            findExpiredAnonymous: jest.fn(),
            deleteAnonymous: jest.fn().mockResolvedValue(undefined),
        } as any;
        const service = new AnonymousUserCleanupService(userRepository, storage);
        return { service, userRepository, storage };
    };

    it('returns an empty summary when no expired anonymous users exist', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([]);

        const summary = await service.purgeExpired();

        expect(summary).toEqual({
            scanned: 0,
            deleted: 0,
            failed: 0,
            failures: [],
            storageDeleted: 0,
            storageFailed: 0,
        });
        expect(userRepository.deleteAnonymous).not.toHaveBeenCalled();
    });

    it('deletes every expired anonymous user and counts successes', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([
            { id: 'u-1' },
            { id: 'u-2' },
            { id: 'u-3' },
        ]);

        const summary = await service.purgeExpired();

        expect(userRepository.deleteAnonymous).toHaveBeenCalledTimes(3);
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(1, 'u-1');
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(2, 'u-2');
        expect(userRepository.deleteAnonymous).toHaveBeenNthCalledWith(3, 'u-3');
        expect(summary).toMatchObject({ scanned: 3, deleted: 3, failed: 0, failures: [] });
    });

    it('continues past a single delete failure and reports it', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([
            { id: 'u-1' },
            { id: 'u-stuck' },
            { id: 'u-3' },
        ]);
        userRepository.deleteAnonymous
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('fk constraint'))
            .mockResolvedValueOnce(undefined);

        const summary = await service.purgeExpired();

        expect(summary.scanned).toBe(3);
        expect(summary.deleted).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.failures).toEqual([{ userId: 'u-stuck', error: 'fk constraint' }]);
    });

    it('passes the `now` argument through to the repository for testability', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([]);

        const fixedNow = new Date('2026-05-14T03:17:00.000Z');
        await service.purgeExpired(fixedNow);

        expect(userRepository.findExpiredAnonymous).toHaveBeenCalledWith(fixedNow);
    });

    // EW-637 follow-up — when a storage plugin is wired, GC its files
    // BEFORE the user row goes away (so the prefix is still derivable
    // from userId).
    describe('storage GC integration', () => {
        it('calls backend.deleteAllByOwner for each expired user and tallies counts', async () => {
            const storage = {
                deleteAllByOwner: jest
                    .fn()
                    .mockResolvedValueOnce({ deleted: 2 })
                    .mockResolvedValueOnce({ deleted: 5 }),
                providerName: 'local-fs',
            };
            const { service, userRepository } = buildService(storage);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-a' }, { id: 'u-b' }]);

            const summary = await service.purgeExpired();

            expect(storage.deleteAllByOwner).toHaveBeenCalledTimes(2);
            expect(storage.deleteAllByOwner).toHaveBeenNthCalledWith(1, 'u-a');
            expect(storage.deleteAllByOwner).toHaveBeenNthCalledWith(2, 'u-b');
            expect(summary.storageDeleted).toBe(7);
            expect(summary.storageFailed).toBe(0);
            expect(summary.deleted).toBe(2);
        });

        it('still deletes the user row when storage GC fails for that user', async () => {
            const storage = {
                deleteAllByOwner: jest
                    .fn()
                    .mockResolvedValueOnce({ deleted: 1 })
                    .mockRejectedValueOnce(new Error('s3 5xx')),
                providerName: 'aws-s3',
            };
            const { service, userRepository } = buildService(storage);
            userRepository.findExpiredAnonymous.mockResolvedValue([
                { id: 'u-ok' },
                { id: 'u-bad-storage' },
            ]);

            const summary = await service.purgeExpired();

            expect(summary.storageFailed).toBe(1);
            expect(summary.storageDeleted).toBe(1);
            // Critical: row delete still happens — TTL contract holds even when storage misbehaves.
            expect(userRepository.deleteAnonymous).toHaveBeenCalledWith('u-bad-storage');
            expect(summary.deleted).toBe(2);
        });

        it('skips storage GC silently when no plugin is wired (legacy local-fs deployments)', async () => {
            const { service, userRepository } = buildService(undefined);
            userRepository.findExpiredAnonymous.mockResolvedValue([{ id: 'u-1' }]);

            const summary = await service.purgeExpired();

            expect(summary.storageDeleted).toBe(0);
            expect(summary.storageFailed).toBe(0);
            expect(summary.deleted).toBe(1);
        });
    });
});
