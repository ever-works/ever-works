import { Work } from '../work.entity';

/**
 * Pin the contract for Work.getMainRepo / getRepoOwner against the
 * `relatedRepositories.work` persisted JSON key.
 */
describe('Work.getMainRepo / getRepoOwner — relatedRepositories.work key', () => {
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

    it('reads main repo from relatedRepositories.work', () => {
        const work = makeWork({
            sourceRepository: {
                url: 'https://github.com/realorg/realrepo',
                owner: 'realorg',
                repo: 'realrepo',
                type: 'data_repo',
                importedAt: new Date(),
                relatedRepositories: {
                    work: { owner: 'realorg', repo: 'main-repo-name' },
                },
            },
        } as any);

        expect(work.getMainRepo()).toBe('main-repo-name');
        expect(work.getRepoOwner('work')).toBe('realorg');
    });

    it('falls back to slug-based default when relatedRepositories.work is missing', () => {
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
