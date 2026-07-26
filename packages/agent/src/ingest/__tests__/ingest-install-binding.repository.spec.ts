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
});
