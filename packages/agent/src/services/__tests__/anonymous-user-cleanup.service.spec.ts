import { AnonymousUserCleanupService } from '../anonymous-user-cleanup.service';

describe('AnonymousUserCleanupService (EW-617 G2)', () => {
    const buildService = () => {
        const userRepository = {
            findExpiredAnonymous: jest.fn(),
            deleteAnonymous: jest.fn().mockResolvedValue(undefined),
        } as any;
        const service = new AnonymousUserCleanupService(userRepository);
        return { service, userRepository };
    };

    it('returns an empty summary when no expired anonymous users exist', async () => {
        const { service, userRepository } = buildService();
        userRepository.findExpiredAnonymous.mockResolvedValue([]);

        const summary = await service.purgeExpired();

        expect(summary).toEqual({ scanned: 0, deleted: 0, failed: 0, failures: [] });
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
        expect(summary).toEqual({ scanned: 3, deleted: 3, failed: 0, failures: [] });
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
});
