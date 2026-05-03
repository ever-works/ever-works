import { Work } from '../work.entity';

/**
 * Regression tests for the Directory→Work rename.
 *
 * The class is renamed but the persisted JSON column
 * `directories.sourceRepository.relatedRepositories` keeps the legacy key
 * `'directory'`. These tests pin that contract so a future bulk rename
 * cannot silently swap `'directory'` → `'work'` and orphan every existing
 * production work's main-repo lookup.
 */
describe('Work.getMainRepo / getRepoOwner — legacy "directory" key', () => {
    function makeWork(overrides: Partial<Work> = {}): Work {
        const work = new Work();
        Object.assign(work, {
            id: 'w-1',
            userId: 'u-1',
            slug: 'my-work',
            name: 'My Work',
            owner: 'fallback-owner',
            user: { username: 'fallback-username' },
            ...overrides,
        });
        return work;
    }

    it('reads main repo from relatedRepositories.directory (legacy persisted key)', () => {
        const work = makeWork({
            sourceRepository: {
                url: 'https://github.com/realorg/realrepo',
                owner: 'realorg',
                repo: 'realrepo',
                type: 'data_repo',
                importedAt: new Date(),
                relatedRepositories: {
                    directory: { owner: 'realorg', repo: 'main-repo-name' },
                },
            },
        } as any);

        expect(work.getMainRepo()).toBe('main-repo-name');
        expect(work.getRepoOwner('directory')).toBe('realorg');
    });

    it('falls back to slug-based default when relatedRepositories.directory is missing', () => {
        const work = makeWork();
        expect(work.getMainRepo()).toBe('my-work');
    });

    it('reads data repo from relatedRepositories.data', () => {
        const work = makeWork({
            sourceRepository: {
                url: 'https://github.com/realorg/realrepo',
                owner: 'realorg',
                repo: 'realrepo',
                type: 'data_repo',
                importedAt: new Date(),
                relatedRepositories: {
                    data: { owner: 'data-owner', repo: 'persisted-data-repo' },
                },
            },
        } as any);

        expect(work.getDataRepo()).toBe('persisted-data-repo');
        expect(work.getRepoOwner('data')).toBe('data-owner');
    });

    it('reads website repo from relatedRepositories.website', () => {
        const work = makeWork({
            sourceRepository: {
                url: 'https://github.com/realorg/realrepo',
                owner: 'realorg',
                repo: 'realrepo',
                type: 'data_repo',
                importedAt: new Date(),
                relatedRepositories: {
                    website: { owner: 'web-owner', repo: 'persisted-website-repo' },
                },
            },
        } as any);

        expect(work.getWebsiteRepo()).toBe('persisted-website-repo');
        expect(work.getRepoOwner('website')).toBe('web-owner');
    });
});
