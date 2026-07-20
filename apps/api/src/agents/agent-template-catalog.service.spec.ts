// Mock the agent-package barrels the service imports. Importing the real
// `@ever-works/agent/facades` barrel under apps/api's jest drags in the
// agent package's `database.config` (which uses the agent-side `@src/*`
// alias that collides with apps/api's `@src` mapping). The service only
// needs `GitFacadeService` as a type and `CACHE_MANAGER`/`Cache` tokens,
// and this is a pure unit test (no Nest DI), so stub them out.
jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class {} }));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: 'CACHE_MANAGER', Cache: class {} }));
// ever-works/agents is public (#1647): a token is an optimization, not a
// requirement — token-less reads go through `fetchPublicRawFile`
// (raw.githubusercontent.com). Mock it so no network is touched.
jest.mock('../organizations/org-template-catalog.service', () => ({
    fetchPublicRawFile: jest.fn(),
}));

import { AgentTemplateCatalogService } from './agent-template-catalog.service';
import { fetchPublicRawFile } from '../organizations/org-template-catalog.service';

/**
 * Unit coverage for the agent-template catalog (ADR-011, spec FR-26..FR-30).
 * Mocks GitFacadeService + the cache so no network / DB is touched.
 */
describe('AgentTemplateCatalogService', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.restoreAllMocks();
    });

    const MANIFEST = JSON.stringify({
        templates: [
            {
                slug: 'ceo',
                name: 'CEO',
                title: 'CEO',
                summary: 'Chief Executive',
                scope: 'TENANT',
                avatarIcon: 'crown',
                tags: ['strategy', 'roadmap'],
            },
            {
                slug: 'starter-coder',
                name: 'Coder',
                summary: 'Ships small reviewed changes',
                avatarIcon: 'code-2',
                tags: ['engineering'],
            },
            { name: 'no-slug-here' }, // invalid → dropped
        ],
    });

    function make(
        getFileContent: jest.Mock,
        getInstallationTokenForOwner: jest.Mock = jest.fn(async () => null),
    ) {
        const git = { getFileContent, getInstallationTokenForOwner } as any;
        const store = new Map<string, unknown>();
        const cache = {
            get: jest.fn(async (k: string) => store.get(k)),
            set: jest.fn(async (k: string, v: unknown) => {
                store.set(k, v);
            }),
        } as any;
        return { svc: new AgentTemplateCatalogService(git, cache), git, cache };
    }

    it('returns [] for non-agent entities without touching git', async () => {
        const { svc, git } = make(jest.fn());
        await expect(svc.list('skill')).resolves.toEqual([]);
        await expect(svc.list('task')).resolves.toEqual([]);
        expect(git.getFileContent).not.toHaveBeenCalled();
    });

    it('uses the platform GitHub App installation token when available (no env needed)', async () => {
        delete process.env.EVER_WORKS_AGENTS_TOKEN;
        delete process.env.GITHUB_TOKEN;
        const getFileContent = jest.fn(async () => ({ content: MANIFEST, encoding: 'utf-8' }));
        const getInstallationTokenForOwner = jest.fn(async () => 'app-installation-token');
        const { svc } = make(getFileContent, getInstallationTokenForOwner);
        const rows = await svc.list('agent');
        expect(getInstallationTokenForOwner).toHaveBeenCalledWith('ever-works');
        expect(rows.map((r) => r.slug)).toEqual(['ceo', 'starter-coder']);
        // The App installation token is the one used to read the repo.
        const callArgs = getFileContent.mock.calls[0] as unknown[];
        expect(callArgs[3]).toEqual({
            token: 'app-installation-token',
            providerId: 'github',
        });
    });

    it('no token: reads the public repo (not git) and returns [] when it yields nothing', async () => {
        delete process.env.EVER_WORKS_AGENTS_TOKEN;
        delete process.env.GITHUB_TOKEN;
        // No env token and no App installation token -> the service reads the
        // public ever-works/agents repo unauthenticated. Public read yields
        // nothing here, so the mapped catalog is empty.
        (fetchPublicRawFile as jest.Mock).mockResolvedValue(null);
        const { svc, git } = make(jest.fn(async () => ({ content: MANIFEST, encoding: 'utf-8' })));
        await expect(svc.list('agent')).resolves.toEqual([]);
        expect(git.getFileContent).not.toHaveBeenCalled();
    });

    it('no token: maps rows from the public (unauthenticated) repo read', async () => {
        delete process.env.EVER_WORKS_AGENTS_TOKEN;
        delete process.env.GITHUB_TOKEN;
        (fetchPublicRawFile as jest.Mock).mockResolvedValue(MANIFEST);
        const { svc, git } = make(jest.fn());
        const rows = await svc.list('agent');
        expect(rows.map((r) => r.slug)).toEqual(['ceo', 'starter-coder']);
        expect(git.getFileContent).not.toHaveBeenCalled();
    });

    it('maps manifest rows, drops invalid ones, and caches the result', async () => {
        process.env.EVER_WORKS_AGENTS_TOKEN = 'tok';
        const { svc, cache } = make(
            jest.fn(async () => ({ content: MANIFEST, encoding: 'utf-8' })),
        );
        const rows = await svc.list('agent');
        expect(rows.map((r) => r.slug)).toEqual(['ceo', 'starter-coder']);
        const ceo = rows.find((r) => r.slug === 'ceo')!;
        expect(ceo.title).toBe('CEO');
        expect(ceo.description).toBe('Chief Executive');
        expect(ceo.iconName).toBe('Crown'); // kebab → Pascal
        expect(ceo.category).toBe('Strategy'); // first tag, capitalized
        const coder = rows.find((r) => r.slug === 'starter-coder')!;
        expect(coder.iconName).toBe('Code2');
        expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('serves from cache on the second call without re-fetching', async () => {
        process.env.GITHUB_TOKEN = 'tok';
        const getFileContent = jest.fn(async () => ({ content: MANIFEST, encoding: 'utf-8' }));
        const { svc } = make(getFileContent);
        await svc.list('agent');
        await svc.list('agent');
        expect(getFileContent).toHaveBeenCalledTimes(1);
    });

    it('returns [] when the repo read throws', async () => {
        process.env.GITHUB_TOKEN = 'tok';
        const { svc } = make(
            jest.fn(async () => {
                throw new Error('network down');
            }),
        );
        await expect(svc.list('agent')).resolves.toEqual([]);
    });

    it('returns [] on malformed manifest JSON', async () => {
        process.env.GITHUB_TOKEN = 'tok';
        const { svc } = make(jest.fn(async () => ({ content: 'not json {', encoding: 'utf-8' })));
        await expect(svc.list('agent')).resolves.toEqual([]);
    });

    it('returns [] when the manifest file is missing', async () => {
        process.env.GITHUB_TOKEN = 'tok';
        const { svc } = make(jest.fn(async () => null));
        await expect(svc.list('agent')).resolves.toEqual([]);
    });
});
