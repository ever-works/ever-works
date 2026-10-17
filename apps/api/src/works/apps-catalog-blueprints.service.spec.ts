// The facades barrel loads most of the agent package (it OOMs a lone suite);
// the service only needs the class as a DI token, and every case passes a double.
jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class GitFacadeService {} }));

import {
    APPS_CATALOG_BLUEPRINTS_FAILURE_TTL_MS,
    APPS_CATALOG_BLUEPRINTS_TTL_MS,
    APPS_CATALOG_BLUEPRINT_TOPIC,
    AppsCatalogBlueprintsService,
    blueprintDisplayName,
    blueprintIdOf,
    filterBlueprints,
    toBlueprintItem,
} from './apps-catalog-blueprints.service';

function repo(name: string, over: Record<string, unknown> = {}) {
    return {
        owner: 'ever-works',
        name,
        fullName: `ever-works/${name}`,
        description: `${name} description`,
        defaultBranch: 'main',
        isPrivate: false,
        url: `https://github.com/ever-works/${name}`,
        cloneUrl: `https://github.com/ever-works/${name}.git`,
        topics: [APPS_CATALOG_BLUEPRINT_TOPIC],
        stars: 3,
        licenseSpdx: 'MIT',
        ...over,
    } as never;
}

describe('apps catalog blueprints', () => {
    it('maps only public, unarchived ever-works repositories carrying the Blueprint topic', () => {
        expect(toBlueprintItem(repo('umami-template'))).toMatchObject({
            id: 'umami',
            name: 'Umami',
            repo: 'ever-works/umami-template',
            url: 'https://github.com/ever-works/umami-template',
            spdx: 'MIT',
        });
        expect(
            toBlueprintItem(repo('directory-web-template', { topics: ['website-template'] })),
        ).toBeNull();
        expect(toBlueprintItem(repo('x-template', { topics: undefined }))).toBeNull();
        expect(toBlueprintItem(repo('x-template', { isPrivate: true }))).toBeNull();
        expect(toBlueprintItem(repo('x-template', { archived: true }))).toBeNull();
        expect(toBlueprintItem(repo('x-template', { owner: 'someone-else' }))).toBeNull();
    });

    it('derives the id and display name from the repository name', () => {
        expect(blueprintIdOf('Cal-Com-Template')).toBe('cal-com');
        expect(blueprintDisplayName('cal-com')).toBe('Cal Com');
    });

    it('searches only from two characters', () => {
        const items = [
            toBlueprintItem(repo('umami-template'))!,
            toBlueprintItem(repo('cal-template'))!,
        ];
        expect(filterBlueprints(items, 'u')).toHaveLength(2);
        expect(filterBlueprints(items, 'um').map((item) => item.id)).toEqual(['umami']);
    });

    it('lists once per TTL, pages until a short page, and fails soft for a short while', async () => {
        const git = { listPublicRepositories: jest.fn() };
        const service = new AppsCatalogBlueprintsService(git as never);
        let now = 1_000;
        const clock = () => now;

        git.listPublicRepositories.mockResolvedValueOnce([
            repo('umami-template'),
            repo('plain', { topics: [] }),
        ]);
        const first = await service.list(undefined, clock);
        expect(first).toMatchObject({ available: true, total: 1, source: 'github-topic' });
        expect(git.listPublicRepositories).toHaveBeenCalledWith('github', 1, 100, {
            owner: 'ever-works',
            type: 'org',
        });

        await service.list('umami', clock);
        expect(git.listPublicRepositories).toHaveBeenCalledTimes(1);

        now += APPS_CATALOG_BLUEPRINTS_TTL_MS + 1;
        git.listPublicRepositories.mockRejectedValueOnce(new Error('rate limited'));
        const failed = await service.list(undefined, clock);
        expect(failed).toEqual({ items: [], total: 0, available: false, source: 'github-topic' });

        now += APPS_CATALOG_BLUEPRINTS_FAILURE_TTL_MS + 1;
        git.listPublicRepositories.mockResolvedValueOnce([repo('cal-template')]);
        expect((await service.list(undefined, clock)).items.map((item) => item.id)).toEqual([
            'cal',
        ]);
    });
});
