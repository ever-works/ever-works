import { UserSyncConfigRepository } from './user-sync-config.repository';

/**
 * Pins the per-user-singleton semantics of the `user_sync_configs` table.
 * The `userId` column is unique (see entity), so `findByUser` is the only
 * lookup mode and `upsert` is a single atomic DB-level INSERT … ON CONFLICT
 * (conflictPaths: ['userId']) followed by a re-fetch — this closes the TOCTOU
 * race that the prior find→update-or-create flow exposed.
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
            upsert: jest.fn(),
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
        it('issues a single atomic upsert keyed on userId (conflictPaths) — no find→update-or-create race', async () => {
            const updated = { id: 'sc-1', userId: 'user-1', repoOwner: 'new' };
            // findOne is ONLY the post-upsert re-fetch now (no pre-read), so the
            // window between "does a row exist?" and "write it" is gone.
            const findOne = jest.fn().mockResolvedValue(updated);
            const upsert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'sc-1' }] });
            const { repo, typeormRepo } = makeService({ findOne, upsert });

            const result = await repo.upsert('user-1', { repoOwner: 'new' });

            // Atomic DB-level upsert with the unique userId as the conflict target.
            expect(typeormRepo.upsert).toHaveBeenCalledWith(
                { userId: 'user-1', repoOwner: 'new' },
                { conflictPaths: ['userId'] },
            );
            // No TOCTOU pre-read / branch: the legacy update/create/save path is gone.
            expect(typeormRepo.update).not.toHaveBeenCalled();
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
            // The single findOne is the re-fetch that returns the durable row.
            expect(findOne).toHaveBeenCalledTimes(1);
            expect(findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
            expect(result).toBe(updated);
        });

        it('merges userId into the partial and re-fetches the row whether or not it pre-existed', async () => {
            const saved = { id: 'sc-2', userId: 'user-2', repoOwner: 'me', repoName: 'cfg' };
            const findOne = jest.fn().mockResolvedValue(saved);
            const upsert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'sc-2' }] });
            const { repo, typeormRepo } = makeService({ findOne, upsert });

            const result = await repo.upsert('user-2', { repoOwner: 'me', repoName: 'cfg' });

            // userId is merged into the upsert payload; one path handles both
            // insert and update, so create/save are never reached.
            expect(typeormRepo.upsert).toHaveBeenCalledWith(
                { userId: 'user-2', repoOwner: 'me', repoName: 'cfg' },
                { conflictPaths: ['userId'] },
            );
            expect(typeormRepo.create).not.toHaveBeenCalled();
            expect(typeormRepo.save).not.toHaveBeenCalled();
            expect(typeormRepo.update).not.toHaveBeenCalled();
            expect(result).toBe(saved);
        });

        it('merges userId FIRST so caller-provided `userId` in the partial overrides the userId arg', async () => {
            // The `{ userId, ...data }` spread order is preserved by the atomic
            // rewrite: a partial that smuggles a different userId still has that
            // value win via the spread. Pin this — flipping the spread order would
            // change which user's row is targeted. The protection against smuggling
            // lives in the calling layer, not here.
            const upsert = jest.fn().mockResolvedValue({ identifiers: [{}] });
            const { repo, typeormRepo } = makeService({
                findOne: jest.fn().mockResolvedValue({}),
                upsert,
            });

            await repo.upsert('user-A', { userId: 'user-B' } as any);

            // The smuggled value DOES override — this is the documented behaviour.
            expect(typeormRepo.upsert).toHaveBeenCalledWith(
                { userId: 'user-B' },
                { conflictPaths: ['userId'] },
            );
            // And the re-fetch uses the ARG userId, not the smuggled one — so a
            // caller smuggling user-B still only gets back user-A's row.
            expect(typeormRepo.findOne).toHaveBeenCalledWith({ where: { userId: 'user-A' } });
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

            expect(update).toHaveBeenCalledWith({ userId: 'user-1' }, { lastSyncError: 'boom' });
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
