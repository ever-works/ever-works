import { WorkRepository } from './work.repository';

/**
 * Tests for the EW-628 G6 webhook resolver — `findByDataRepoFullName`.
 *
 * The method narrows by `githubAppInstalled = true` in SQL (the
 * `idx_work_sync_webhook` composite index covers this prefix) and then
 * filters by data-repo owner/repo in-memory because `sourceRepository`
 * is a `simple-json` column and a portable JSON predicate would require
 * dialect-specific raw SQL. These tests pin both halves of that
 * contract.
 */
describe('WorkRepository.findByDataRepoFullName (EW-628 G6)', () => {
    let repository: { find: jest.Mock };
    let workRepository: WorkRepository;

    const work = (
        id: string,
        relatedRepositories?: { data?: { owner?: string; repo?: string } },
    ) => ({
        id,
        sourceRepository: relatedRepositories ? { relatedRepositories } : undefined,
    });

    beforeEach(() => {
        repository = { find: jest.fn() };
        workRepository = new WorkRepository(repository as any);
    });

    it('returns [] when the full_name is empty / missing the slash separator', async () => {
        await expect(workRepository.findByDataRepoFullName('')).resolves.toEqual([]);
        await expect(workRepository.findByDataRepoFullName('no-slash')).resolves.toEqual([]);
        expect(repository.find).not.toHaveBeenCalled();
    });

    it('scopes the SQL SELECT to githubAppInstalled = true', async () => {
        repository.find.mockResolvedValue([]);
        await workRepository.findByDataRepoFullName('o/r');
        expect(repository.find).toHaveBeenCalledWith({
            where: { githubAppInstalled: true },
        });
    });

    it('returns every Work whose data repo matches the full_name (case-insensitive)', async () => {
        repository.find.mockResolvedValue([
            work('w1', { data: { owner: 'Acme', repo: 'Data' } }),
            work('w2', { data: { owner: 'someone-else', repo: 'data' } }),
            work('w3', { data: { owner: 'acme', repo: 'data' } }),
        ]);

        const result = await workRepository.findByDataRepoFullName('acme/data');
        expect(result.map((w) => w.id)).toEqual(['w1', 'w3']);
    });

    it('skips Works with no sourceRepository or no relatedRepositories.data', async () => {
        repository.find.mockResolvedValue([
            work('w1'),
            work('w2', {}),
            work('w3', { data: undefined }),
            work('w4', { data: { owner: 'acme' } }),
            work('w5', { data: { owner: 'acme', repo: 'data' } }),
        ]);

        const result = await workRepository.findByDataRepoFullName('acme/data');
        expect(result.map((w) => w.id)).toEqual(['w5']);
    });

    it('returns [] when no Work matches even if the App is installed broadly', async () => {
        repository.find.mockResolvedValue([
            work('w1', { data: { owner: 'someone-else', repo: 'data' } }),
        ]);

        await expect(workRepository.findByDataRepoFullName('acme/data')).resolves.toEqual([]);
    });
});
