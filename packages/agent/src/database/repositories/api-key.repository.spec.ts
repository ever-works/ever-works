import { LessThan } from 'typeorm';
import { FLEET_RUN_API_KEY_KIND, PERSONAL_API_KEY_KIND } from '@ever-works/contracts';
import { ApiKeyRepository } from './api-key.repository';

describe('ApiKeyRepository', () => {
    let repository: {
        delete: jest.Mock;
        find: jest.Mock;
        count: jest.Mock;
        update: jest.Mock;
    };
    let apiKeyRepository: ApiKeyRepository;

    beforeEach(() => {
        repository = {
            delete: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            update: jest.fn().mockResolvedValue({ affected: 0 }),
        };

        apiKeyRepository = new ApiKeyRepository(repository as any);
    });

    it('uses Date values when deleting expired timestamp-transformed keys', async () => {
        repository.delete.mockResolvedValue({ affected: 2 });

        const deletedCount = await apiKeyRepository.deleteExpiredKeys();

        expect(deletedCount).toBe(2);

        const where = repository.delete.mock.calls[0][0];
        const expiresAt = where.expiresAt;
        const lessThanOperator = expiresAt._value[1];

        expect(lessThanOperator).toEqual(LessThan(expect.any(Date)));
    });

    /**
     * Self-build slice Z (EW-796) — the two api-key KINDS stay apart.
     *
     * A fleet run mints a fresh `ew_run_` credential on every lease
     * renewal. If those rows appeared in the owner's key listing they
     * would look like keys the owner created (and could be revoked by
     * hand mid-run); if they counted toward the ten-key cap, a single
     * long run would lock its own owner out of creating a real key.
     * Both listings therefore filter on `kind = 'personal'`.
     */
    describe('personal keys are the only ones a user sees or is capped on', () => {
        it('lists only personal keys', async () => {
            await apiKeyRepository.findByUserId('user-1');

            const where = repository.find.mock.calls[0][0].where;
            expect(where).toMatchObject({ userId: 'user-1', kind: PERSONAL_API_KEY_KIND });
        });

        it('counts only personal keys toward the per-user cap', async () => {
            await apiKeyRepository.countByUserId('user-1');

            const where = repository.count.mock.calls[0][0].where;
            // Both OR branches (never-expires / not-yet-expired) carry the
            // filter — a run token must not slip through either of them.
            expect(where).toHaveLength(2);
            for (const clause of where) {
                expect(clause).toMatchObject({ userId: 'user-1', kind: PERSONAL_API_KEY_KIND });
            }
        });
    });

    describe('fleet-run credentials are addressed by their bound job', () => {
        it('finds only ACTIVE run tokens for one job', async () => {
            await apiKeyRepository.findActiveByBoundJob('job-1');

            expect(repository.find.mock.calls[0][0].where).toEqual({
                boundJobId: 'job-1',
                kind: FLEET_RUN_API_KEY_KIND,
                isActive: true,
            });
        });

        it('revokes by deactivating, never by deleting, and reports the count', async () => {
            repository.update.mockResolvedValue({ affected: 2 });

            await expect(apiKeyRepository.deactivateByBoundJob('job-1')).resolves.toBe(2);

            const [where, patch] = repository.update.mock.calls[0];
            expect(where).toEqual({
                boundJobId: 'job-1',
                kind: FLEET_RUN_API_KEY_KIND,
                isActive: true,
            });
            // `isActive: false` is what `findByHashedKey` already refuses, so
            // revoking reuses the ONE check that has always refused a revoked
            // personal key — and the row survives as the audit record.
            expect(patch).toEqual({ isActive: false });
            expect(repository.delete).not.toHaveBeenCalled();
        });

        it('is idempotent: a second revoke over the same job affects nothing', async () => {
            repository.update.mockResolvedValue({ affected: 0 });
            await expect(apiKeyRepository.deactivateByBoundJob('job-1')).resolves.toBe(0);
        });

        it('never touches a personal key, whatever its bound columns say', async () => {
            await apiKeyRepository.deactivateByBoundJob('job-1');
            expect(repository.update.mock.calls[0][0].kind).toBe(FLEET_RUN_API_KEY_KIND);
            expect(FLEET_RUN_API_KEY_KIND).not.toBe(PERSONAL_API_KEY_KIND);
        });
    });
});
