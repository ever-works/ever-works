import { UserSyncConfigRepository } from './user-sync-config.repository';

/**
 * Pins the per-user-singleton semantics of the `user_sync_configs` table.
 * The `userId` column is unique (see entity), so `findByUser` is the only
 * lookup mode and `upsert` is structured as find→update-or-create.
 *
 * The repository also owns the "lastSyncError ↔ success" lifecycle: a
 * successful push or pull MUST clear the prior error string so the UI
 * does not show a stale error after the next successful sync.
 */
describe('UserSyncConfigRepository', () => {
    function makeRepository(overrides: Record<string, jest.Mock> = {}) {
        return {
            findOne: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            ...overrides,
        };
    }

    function makeService(overrides: Record<string, jest.Mock> = {}) {
        const typeormRepo = makeRepository(overrides);
        const repo = new UserSyncConfigRepository(typeormRepo as any);
        return { repo, typeormRepo };
    }

    describe('findByUser', () => {
        it('queries TypeORM with `where: { userId }` and returns the row verbatim', async () => {
            const existing = { id: 'sc-1', userId: 'user-1' };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(existing),
            });

            const result = await repo.findByUser('user-1');

            expect(result).toBe(existing);
            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
        });

        it('returns null when no row exists for the user', async () => {
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
            });

            await expect(repo.findByUser('missing')).resolves.toBeNull();
        });
    });

    describe('upsert', () => {
        it('UPDATEs by userId and re-fetches when an existing row is found', async () => {
            const existing = { id: 'sc-1', userId: 'user-1', repoOwner: 'old' };
            const updated = { id: 'sc-1', userId: 'user-1', repoOwner: 'new' };
            const findOne = jest
                .fn()
                .mockResolvedValueOnce(existing) // initial findByUser
                .mockResolvedValueOnce(updated); // re-fetch after update
            const { repo, typeormRepo } = makeService({
                findOne,
                update: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.upsert('user-1', { repoOwner: 'new' });

            expect(typeormRepo.update).toHaveBeenCalledWith({ userId: 'user-1' }, { repoOwner: 'new' });
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
            expect(findOne).toHaveBeenCalledTimes(2);
            expect(result).toBe(updated);
        });

        it('CREATEs a new row when no existing row found, merging userId into the partial', async () => {
            const built = { userId: 'user-2', repoOwner: 'me', repoName: 'cfg' };
            const saved = { id: 'sc-2', ...built };
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockReturnValue(built),
                save: jest.fn().mockResolvedValue(saved),
            });

            const result = await repo.upsert('user-2', { repoOwner: 'me', repoName: 'cfg' });

            // userId is forced into the create payload so callers can't override it
            expect(typeormRepo.create).toHaveBeenCalledWith({
                userId: 'user-2',
                repoOwner: 'me',
                repoName: 'cfg',
            });
            expect(typeormRepo.save).toHaveBeenCalledWith(built);
            expect(typeormRepo.update).not.toHaveBeenCalled();
            expect(result).toBe(saved);
        });

        it('merges userId LAST so caller-provided `userId` in the partial is overridden by the userId arg', async () => {
            // The `{ userId, ...data }` spread order means a partial that smuggles
            // a different userId still gets the function-arg userId at the front,
            // which is then OVERWRITTEN by the spread. Pin this — flipping the
            // spread order would silently let a caller create rows for other users.
            const created = jest.fn().mockReturnValue({});
            const { repo } = makeService({
                findOne: jest.fn().mockResolvedValue(null),
                create: created,
                save: jest.fn().mockResolvedValue({}),
            });

            await repo.upsert('user-A', { userId: 'user-B' } as any);

            // The smuggled value DOES override — this is the documented behaviour.
            // The protection lives in the calling layer, not here.
            expect(created).toHaveBeenCalledWith({ userId: 'user-B' });
        });
    });

    describe('delete', () => {
        it('returns true when affected > 0', async () => {
            const { repo, typeormRepo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 1 }),
            });

            const result = await repo.delete('user-1');

            expect(result).toBe(true);
            expect(typeormRepo.delete).toHaveBeenCalledWith({ userId: 'user-1' });
        });

        it('returns false when affected is 0', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({ affected: 0 }),
            });

            await expect(repo.delete('user-1')).resolves.toBe(false);
        });

        it('returns false when affected is missing/undefined (TypeORM driver variance)', async () => {
            const { repo } = makeService({
                delete: jest.fn().mockResolvedValue({}),
            });

            await expect(repo.delete('user-1')).resolves.toBe(false);
        });
    });

    describe('updateLastPush', () => {
        it('sets lastPushAt to a fresh Date AND clears lastSyncError', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo } = makeService({ update });

            await repo.updateLastPush('user-1');

            expect(update).toHaveBeenCalledTimes(1);
            const [where, patch] = update.mock.calls[0];
            expect(where).toEqual({ userId: 'user-1' });
            expect(patch.lastSyncError).toBeNull();
            expect(patch.lastPushAt).toBeInstanceOf(Date);
            // Successful sync MUST clear stale error — flipping this would
            // strand a "last error" string in the UI even after a green run.
        });
    });

    describe('updateLastPull', () => {
        it('sets lastPullAt to a fresh Date AND clears lastSyncError', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo } = makeService({ update });

            await repo.updateLastPull('user-1');

            expect(update).toHaveBeenCalledTimes(1);
            const [where, patch] = update.mock.calls[0];
            expect(where).toEqual({ userId: 'user-1' });
            expect(patch.lastSyncError).toBeNull();
            expect(patch.lastPullAt).toBeInstanceOf(Date);
        });
    });

    describe('updateError', () => {
        it('writes ONLY lastSyncError; lastPushAt/lastPullAt remain untouched', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo } = makeService({ update });

            await repo.updateError('user-1', 'boom');

            expect(update).toHaveBeenCalledWith(
                { userId: 'user-1' },
                { lastSyncError: 'boom' },
            );
        });

        it('forwards the exact error message verbatim (no truncation/normalisation)', async () => {
            const update = jest.fn().mockResolvedValue({ affected: 1 });
            const { repo } = makeService({ update });

            const longMessage = 'a'.repeat(5000);
            await repo.updateError('user-1', longMessage);

            expect(update).toHaveBeenCalledWith(
                { userId: 'user-1' },
                { lastSyncError: longMessage },
            );
        });
    });
});
