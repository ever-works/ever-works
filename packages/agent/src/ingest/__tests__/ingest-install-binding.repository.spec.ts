jest.mock('@nestjs/typeorm', () => ({
    InjectRepository: () => () => undefined,
}));
jest.mock('../../entities/ingest-install-binding.entity', () => ({
    IngestInstallBinding: class IngestInstallBinding {},
}));

import { IngestInstallBindingRepository } from '../ingest-install-binding.repository';

/**
 * Workspace/installation → platform user bindings for the inbound
 * receivers. Every method runs on a PUBLIC webhook hot path, so the
 * contract is: exact indexed reads, and a write that resolves the
 * UNIQUE-index race by adopting the winner rather than throwing.
 */
describe('IngestInstallBindingRepository', () => {
    function makeRepo() {
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn((data: unknown) => data),
            save: jest.fn(async (row: unknown) => row),
        };
        return { repo: new IngestInstallBindingRepository(repository as any), repository };
    }

    it('looks a workspace up by (provider, externalWorkspaceId)', async () => {
        const { repo, repository } = makeRepo();
        await repo.findByWorkspace('slack', 'T-AAA');
        expect(repository.findOne).toHaveBeenCalledWith({
            where: { provider: 'slack', externalWorkspaceId: 'T-AAA' },
        });
    });

    it('never queries for an empty workspace id', async () => {
        const { repo, repository } = makeRepo();
        expect(await repo.findByWorkspace('slack', '')).toBeNull();
        expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('inserts a new binding with the enterprise id normalized to null', async () => {
        const { repo, repository } = makeRepo();
        await repo.record({
            provider: 'github',
            externalWorkspaceId: 'owner:octo',
            userId: 'u-a',
            pluginId: 'github',
        });
        expect(repository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                externalWorkspaceId: 'owner:octo',
                externalEnterpriseId: null,
                userId: 'u-a',
                pluginId: 'github',
            }),
        );
    });

    it('re-points an existing binding instead of inserting a duplicate', async () => {
        const { repo, repository } = makeRepo();
        const existing = {
            id: 'b-1',
            provider: 'slack',
            externalWorkspaceId: 'T-AAA',
            externalEnterpriseId: null,
            userId: 'u-old',
            pluginId: 'slack-connector',
        };
        repository.findOne.mockResolvedValue(existing);

        await repo.record({
            provider: 'slack',
            externalWorkspaceId: 'T-AAA',
            externalEnterpriseId: 'E-ONE',
            userId: 'u-new',
            pluginId: 'slack-connector',
        });

        expect(repository.create).not.toHaveBeenCalled();
        expect(repository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'b-1',
                userId: 'u-new',
                externalEnterpriseId: 'E-ONE',
            }),
        );
    });

    it('adopts the winner when a concurrent first delivery lost the UNIQUE race', async () => {
        const { repo, repository } = makeRepo();
        const winner = { id: 'b-winner', userId: 'u-a' };
        repository.save.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));
        repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);

        const result = await repo.record({
            provider: 'slack',
            externalWorkspaceId: 'T-AAA',
            userId: 'u-a',
            pluginId: 'slack-connector',
        });

        expect(result).toBe(winner);
    });

    it('returns null (never throws) when the insert fails and no winner exists', async () => {
        const { repo, repository } = makeRepo();
        repository.save.mockRejectedValue(new Error('db down'));

        await expect(
            repo.record({
                provider: 'slack',
                externalWorkspaceId: 'T-AAA',
                userId: 'u-a',
                pluginId: 'slack-connector',
            }),
        ).resolves.toBeNull();
    });

    /**
     * The write behind an authenticated FIRST-CLAIM surface (Sentry
     * installations). `record` re-points a row, which is right after a
     * signature proved ownership and wrong for a claim whose only
     * evidence is knowing the id — the loser of a race must get the
     * winner's row back, not overwrite it.
     */
    describe('recordIfAbsent (first claim wins)', () => {
        it('inserts when nothing holds the workspace yet', async () => {
            const { repo, repository } = makeRepo();
            await repo.recordIfAbsent({
                provider: 'sentry',
                externalWorkspaceId: 'installation:u1',
                userId: 'u-a',
                pluginId: 'sentry',
            });
            expect(repository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: 'sentry',
                    externalWorkspaceId: 'installation:u1',
                    userId: 'u-a',
                    externalEnterpriseId: null,
                }),
            );
        });

        it('⭐ returns the current holder and NEVER re-points it', async () => {
            const { repo, repository } = makeRepo();
            const held = {
                provider: 'sentry',
                externalWorkspaceId: 'installation:u1',
                userId: 'u-a',
                externalWorkspaceName: 'ever-co',
            };
            repository.findOne.mockResolvedValue(held);

            await expect(
                repo.recordIfAbsent({
                    provider: 'sentry',
                    externalWorkspaceId: 'installation:u1',
                    userId: 'u-b',
                    pluginId: 'sentry',
                    externalWorkspaceName: 'globex',
                }),
            ).resolves.toBe(held);
            expect(repository.save).not.toHaveBeenCalled();
            expect(held.userId).toBe('u-a');
            expect(held.externalWorkspaceName).toBe('ever-co');
        });

        it('adopts the winner when the UNIQUE index rejects a concurrent insert', async () => {
            const { repo, repository } = makeRepo();
            const winner = { provider: 'sentry', externalWorkspaceId: 'i:1', userId: 'u-a' };
            repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
            repository.save.mockRejectedValueOnce(new Error('duplicate key'));

            await expect(
                repo.recordIfAbsent({
                    provider: 'sentry',
                    externalWorkspaceId: 'i:1',
                    userId: 'u-b',
                    pluginId: 'sentry',
                }),
            ).resolves.toBe(winner);
        });

        it('returns null (never throws on a hot path) when the insert fails for another reason', async () => {
            const { repo, repository } = makeRepo();
            repository.findOne.mockResolvedValue(null);
            repository.save.mockRejectedValue(new Error('db down'));

            await expect(
                repo.recordIfAbsent({
                    provider: 'sentry',
                    externalWorkspaceId: 'i:1',
                    userId: 'u-b',
                    pluginId: 'sentry',
                }),
            ).resolves.toBeNull();
        });

        it('never writes for an empty workspace id', async () => {
            const { repo, repository } = makeRepo();
            await expect(
                repo.recordIfAbsent({
                    provider: 'sentry',
                    externalWorkspaceId: '',
                    userId: 'u-a',
                    pluginId: 'sentry',
                }),
            ).resolves.toBeNull();
            expect(repository.save).not.toHaveBeenCalled();
        });
    });

    describe('remove (Sentry installation.deleted / owner unbind)', () => {
        it('removes an existing binding and reports it', async () => {
            const { repo, repository } = makeRepo();
            const existing = {
                id: 'b-1',
                provider: 'sentry',
                externalWorkspaceId: 'installation:u1',
            };
            repository.findOne.mockResolvedValue(existing);
            (repository as any).remove = jest.fn().mockResolvedValue(undefined);

            await expect(repo.remove('sentry', 'installation:u1')).resolves.toBe(true);
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { provider: 'sentry', externalWorkspaceId: 'installation:u1' },
            });
            expect((repository as any).remove).toHaveBeenCalledWith(existing);
        });

        it('is a no-op for an unknown or empty workspace id', async () => {
            const { repo, repository } = makeRepo();
            (repository as any).remove = jest.fn();

            await expect(repo.remove('sentry', 'installation:nope')).resolves.toBe(false);
            await expect(repo.remove('sentry', '')).resolves.toBe(false);
            expect((repository as any).remove).not.toHaveBeenCalled();
        });
    });
});
