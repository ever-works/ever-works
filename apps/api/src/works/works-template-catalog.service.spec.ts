// Mock the agent-package barrels the service imports. Importing the real
// `@ever-works/agent/facades` barrel under apps/api's jest drags in the
// agent package's `database.config` (which uses the agent-side `@src/*`
// alias that collides with apps/api's `@src` mapping). The service only
// needs `GitFacadeService` as a type and `CACHE_MANAGER`/`Cache` tokens,
// and this is a pure unit test (no Nest DI), so stub them out.
jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class {} }));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: 'CACHE_MANAGER', Cache: class {} }));

import { WorksTemplateCatalogService } from './works-template-catalog.service';

/**
 * Unit coverage for the Work-blueprint catalog (Works Templates spec,
 * ADR-014). Mocks `global.fetch` (tokenless raw read) + GitFacadeService +
 * the cache so no network / DB is touched.
 */
describe('WorksTemplateCatalogService', () => {
    const ORIGINAL_ENV = { ...process.env };
    const ORIGINAL_FETCH = global.fetch;

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        global.fetch = ORIGINAL_FETCH;
        jest.restoreAllMocks();
    });

    const MANIFEST = JSON.stringify({
        version: 1,
        blueprints: [
            {
                slug: 'directory',
                name: 'Directory',
                title: 'Directory Website',
                summary: 'Next.js directory with categories, search, submissions.',
                kind: 'directory',
                chipType: 'directory',
                category: 'web',
                tags: ['nextjs', 'directory', 'seo'],
                isOrganization: false,
                default: true,
                featured: true,
                status: 'production',
                avatarIcon: 'folder-tree',
                template: {
                    repo: 'ever-works/directory-web-template',
                    ref: 'develop',
                    sha: null,
                },
                defaults: {
                    gitProvider: 'github',
                    storageProvider: 's3',
                    deployProvider: 'vercel',
                },
            },
            {
                slug: 'marketing-site',
                name: 'Marketing',
                title: 'Marketing Site',
                summary: 'Landing + marketing site.',
                kind: 'landing-page',
                chipType: 'landing',
                status: 'production',
                template: { repo: 'ever-works/ever-works-website-template', sha: 'abc123' },
            },
            {
                // placeholder — no repo yet; must be EXPOSED but flagged.
                slug: 'store',
                name: 'Store',
                title: 'Store',
                summary: 'Coming soon.',
                kind: 'store',
                chipType: 'store',
                status: 'placeholder',
                template: { repo: null },
            },
            {
                // SSRF guard — non-ever-works repo on a production row → dropped.
                slug: 'evil',
                name: 'Evil',
                title: 'Evil',
                summary: 'Hostile fork source.',
                kind: 'website',
                chipType: 'website',
                status: 'production',
                template: { repo: 'attacker/pwn' },
            },
            { name: 'no-slug-here' }, // invalid → dropped
        ],
    });

    function rawOk(body: string) {
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
    }

    function make(
        fetchImpl: jest.Mock,
        getFileContent: jest.Mock = jest.fn(),
        getInstallationTokenForOwner: jest.Mock = jest.fn(async () => null),
    ) {
        global.fetch = fetchImpl as unknown as typeof fetch;
        const git = { getFileContent, getInstallationTokenForOwner } as any;
        const store = new Map<string, unknown>();
        const cache = {
            get: jest.fn(async (k: string) => store.get(k)),
            set: jest.fn(async (k: string, v: unknown) => {
                store.set(k, v);
            }),
        } as any;
        return { svc: new WorksTemplateCatalogService(git, cache), git, cache, fetchImpl };
    }

    it('reads the public manifest tokenless, maps + sanitizes rows, drops invalid/SSRF ones', async () => {
        const { svc, git } = make(jest.fn(async () => rawOk(MANIFEST)));
        const rows = await svc.list();
        // `evil` (non-ever-works repo) + the no-slug row are dropped; `store`
        // placeholder is kept.
        expect(rows.map((r) => r.slug)).toEqual(['directory', 'marketing-site', 'store']);

        const directory = rows.find((r) => r.slug === 'directory')!;
        expect(directory.iconName).toBe('FolderTree'); // kebab → Pascal
        expect(directory.isDefault).toBe(true);
        expect(directory.templateRepoOwner).toBe('ever-works');
        expect(directory.templateRepoName).toBe('directory-web-template');
        expect(directory.templateRef).toBe('develop');
        expect(directory.gitProvider).toBe('github');

        // sha wins over ref.
        const marketing = rows.find((r) => r.slug === 'marketing-site')!;
        expect(marketing.templateRef).toBe('abc123');

        // placeholder kept but flagged + null repo coords.
        const store = rows.find((r) => r.slug === 'store')!;
        expect(store.status).toBe('placeholder');
        expect(store.templateRepoName).toBeNull();

        // No auth read when the tokenless read succeeds.
        expect(git.getFileContent).not.toHaveBeenCalled();
    });

    it('filters by chipType in-memory', async () => {
        const { svc } = make(jest.fn(async () => rawOk(MANIFEST)));
        const rows = await svc.list('directory');
        expect(rows.map((r) => r.slug)).toEqual(['directory']);
    });

    it('serves from cache on the second call without re-fetching', async () => {
        const fetchImpl = jest.fn(async () => rawOk(MANIFEST));
        const { svc } = make(fetchImpl);
        await svc.list();
        await svc.list('landing');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('falls back to the authenticated git read when the tokenless read is non-2xx', async () => {
        process.env.EVER_WORKS_WORKS_TOKEN = 'tok';
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
        const getFileContent = jest.fn(async () => ({ content: MANIFEST, encoding: 'utf-8' }));
        const { svc } = make(fetchImpl, getFileContent);
        const rows = await svc.list();
        expect(rows.map((r) => r.slug)).toEqual(['directory', 'marketing-site', 'store']);
        expect(getFileContent).toHaveBeenCalledTimes(1);
    });

    it('returns [] when tokenless read fails and no token is configured', async () => {
        delete process.env.EVER_WORKS_WORKS_TOKEN;
        delete process.env.GITHUB_TOKEN;
        const { svc, git } = make(
            jest.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
        );
        await expect(svc.list()).resolves.toEqual([]);
        expect(git.getFileContent).not.toHaveBeenCalled();
    });

    it('returns [] on a tokenless fetch throw (timeout/network)', async () => {
        delete process.env.EVER_WORKS_WORKS_TOKEN;
        delete process.env.GITHUB_TOKEN;
        const { svc } = make(
            jest.fn(async () => {
                throw new Error('aborted');
            }),
        );
        await expect(svc.list()).resolves.toEqual([]);
    });

    it('returns [] on malformed manifest JSON', async () => {
        const { svc } = make(jest.fn(async () => rawOk('not json {')));
        await expect(svc.list()).resolves.toEqual([]);
    });

    it('does not cache an empty (failed) result', async () => {
        const { svc, cache } = make(
            jest.fn(async () => ({ ok: false, status: 503 }) as unknown as Response),
        );
        await svc.list();
        expect(cache.set).not.toHaveBeenCalled();
    });
});
