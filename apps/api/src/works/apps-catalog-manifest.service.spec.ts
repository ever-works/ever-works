// The facades barrel loads most of the agent package (it OOMs a lone suite);
// the service only needs the class as a DI token, and every case passes a double.
jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class GitFacadeService {} }));

import {
    AppsCatalogManifestService,
    appsCatalogSource,
    isPinnedRef,
    listingItemsOf,
    pageListing,
    plainText,
    toListingItem,
} from './apps-catalog-manifest.service';

/** The live `ever-works/templates` listing shape, reduced (2026-10-17). */
const LISTING = {
    schemaVersion: 1,
    templates: [
        {
            slug: 'web',
            name: 'Website',
            kind: 'website',
            status: 'production',
            template: { repo: 'ever-works/web-template' },
        },
        {
            slug: 'cal',
            name: 'Cal (community build)',
            summary: 'Open-source scheduling: <b>booking</b> pages.',
            kind: 'app',
            status: 'beta',
            appSource: { mode: 'repository', repo: 'calcom/cal.diy', defaultBranch: 'main' },
            template: {
                repo: 'ever-works/cal-template',
                ref: 'v0.1.0',
                sha: '55de074b7feeb82ede98d2c31eedd28201ebba01',
            },
            blueprint: { id: 'cal', version: '0.1.0', verified: false },
            upstreams: [{ repo: 'calcom/cal.diy', refs: { branches: ['main'] } }],
            license: { spdx: 'MIT', class: 'green' },
            managedHosting: { allowed: false, reason: 'Upstream recommends personal use.' },
            trademark: {
                notice: 'Cal.diy® is a trademark of Cal.com, Inc.',
                displayNameSuffix: '(community build)',
            },
            tags: ['calendar', 'Bad Tag', 'booking'],
        },
        {
            slug: 'umami',
            name: 'Umami',
            kind: 'app',
            status: 'beta',
            appSource: { repo: 'umami-software/umami', defaultBranch: 'master' },
            template: {
                repo: 'ever-works/umami-template',
                ref: 'v0.1.0',
                sha: '7aeb58047d1796ecf7826ef5e09a513e160473ec',
            },
            blueprint: { id: 'umami', version: '0.1.0' },
            license: { spdx: 'MIT', class: 'green' },
            managedHosting: { allowed: true },
            featured: true,
        },
        {
            slug: 'nope',
            kind: 'app',
            status: 'beta',
            appSource: { repo: 'x/y' },
            template: { repo: 'ever-works/nope-template' },
            license: { spdx: 'PolyForm-Noncommercial-1.0.0', class: 'red' },
        },
        {
            slug: 'evil',
            kind: 'app',
            status: 'beta',
            appSource: { repo: 'x/y' },
            template: { repo: 'someone/evil-template' },
            license: { class: 'green' },
        },
        {
            slug: 'soon',
            name: 'Soon',
            kind: 'app',
            status: 'placeholder',
            template: { repo: 'ever-works/soon-template' },
            license: { class: 'amber' },
            managedHosting: { allowed: true },
        },
    ],
};

describe('apps catalog manifest projection', () => {
    it('keeps App rows only, drops red, foreign Blueprint repositories and bad ids, and sorts featured first', () => {
        const items = listingItemsOf(LISTING);
        expect(items.map((item) => item.id)).toEqual(['umami', 'cal', 'soon']);
    });

    it('projects the listing row: upstream to paste, Blueprint pin, plain text, valid tags', () => {
        const cal = toListingItem(LISTING.templates[1])!;
        expect(cal).toMatchObject({
            id: 'cal',
            summary: 'Open-source scheduling: booking pages.',
            status: 'beta',
            selectable: true,
            upstream: {
                repo: 'calcom/cal.diy',
                url: 'https://github.com/calcom/cal.diy',
                defaultBranch: 'main',
            },
            blueprint: {
                repo: 'ever-works/cal-template',
                version: '0.1.0',
                ref: 'v0.1.0',
                sha: '55de074b7feeb82ede98d2c31eedd28201ebba01',
                verified: false,
            },
            license: { spdx: 'MIT', class: 'green' },
            managedHosting: { allowed: false, reason: 'Upstream recommends personal use.' },
            trademark: { displayNameSuffix: '(community build)' },
            tags: ['calendar', 'booking'],
            yourCluster: true,
        });
    });

    it('a placeholder is listed but not selectable, and amber is never managed without an agreement', () => {
        const soon = toListingItem(LISTING.templates[5])!;
        expect(soon.selectable).toBe(false);
        expect(soon.upstream).toBeNull();
        expect(soon.managedHosting.allowed).toBe(false);
    });

    it('also reads the catalog.md §3 `apps[]` shape', () => {
        const items = listingItemsOf({
            schemaVersion: 1,
            apps: [
                {
                    id: 'cal',
                    name: 'Cal.diy',
                    summary: 'Scheduling',
                    status: 'beta',
                    upstreams: [{ repo: 'calcom/cal.diy', refs: { branches: ['main'] } }],
                    blueprint: {
                        repo: 'ever-works/cal-template',
                        version: '1.0.0',
                        sha: '0123456789abcdef0123456789abcdef01234567',
                    },
                    license: { spdx: 'MIT', class: 'green' },
                    managedHosting: { allowed: false },
                    verified: true,
                },
            ],
        });
        expect(items[0]).toMatchObject({
            id: 'cal',
            upstream: { url: 'https://github.com/calcom/cal.diy' },
            blueprint: { ref: 'v1.0.0', verified: true },
        });
    });

    it('searches from two characters, filters by status and pages', () => {
        const items = listingItemsOf(LISTING);
        expect(pageListing(items, { q: 'c' }).total).toBe(3);
        expect(pageListing(items, { q: 'calendar' }).items.map((item) => item.id)).toEqual(['cal']);
        expect(pageListing(items, { status: 'placeholder' }).items.map((item) => item.id)).toEqual([
            'soon',
        ]);
        expect(pageListing(items, { limit: 1, page: 2 })).toMatchObject({
            total: 3,
            page: 2,
            limit: 1,
        });
        expect(pageListing(items, { limit: 1, page: 2 }).items.map((item) => item.id)).toEqual([
            'cal',
        ]);
    });

    it('reads the source from the environment, validated, and knows a pinned ref', () => {
        expect(appsCatalogSource({})).toEqual({ repo: 'ever-works/templates', ref: 'main' });
        expect(
            appsCatalogSource({
                EVER_WORKS_APPS_CATALOG_REPO: 'ever-works/apps',
                EVER_WORKS_APPS_CATALOG_REF: 'e2e',
            }),
        ).toEqual({
            repo: 'ever-works/apps',
            ref: 'e2e',
        });
        expect(
            appsCatalogSource({
                EVER_WORKS_APPS_CATALOG_REPO: '../../etc',
                EVER_WORKS_APPS_CATALOG_REF: '../x',
            }),
        ).toEqual({
            repo: 'ever-works/templates',
            ref: 'main',
        });
        expect(isPinnedRef('v2026.10.17')).toBe(true);
        expect(isPinnedRef('55de074b7feeb82ede98d2c31eedd28201ebba01')).toBe(true);
        expect(isPinnedRef('main')).toBe(false);
        expect(plainText('<script>x</script>a\u0000b', 10)).toBe('xa b');
    });
});

describe('AppsCatalogManifestService', () => {
    const ENV = { ...process.env };
    afterEach(() => {
        process.env = { ...ENV };
    });

    it('reads tokenless from raw.githubusercontent, caches for the TTL, and fails soft', async () => {
        delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
        delete process.env.GITHUB_TOKEN;
        process.env.EVER_WORKS_APPS_CATALOG_REF = 'v0.1.0';
        const git = { getFileContent: jest.fn() };
        const service = new AppsCatalogManifestService(git as never);
        let now = 1_000;
        service.now = () => now;
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(LISTING),
        });
        service.fetchImpl = fetchImpl;

        const first = await service.list();
        expect(first).toMatchObject({
            available: true,
            total: 3,
            source: 'manifest',
            repo: 'ever-works/templates',
            ref: 'v0.1.0',
        });
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://raw.githubusercontent.com/ever-works/templates/v0.1.0/manifest.json',
        );
        expect(git.getFileContent).not.toHaveBeenCalled();

        await service.get('cal');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 3_600_001;
        fetchImpl.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });
        expect(await service.list()).toMatchObject({ available: false, total: 0, items: [] });
    });

    it('reads through the GitHub plugin when a platform token is configured', async () => {
        process.env.EVER_WORKS_APPS_CATALOG_TOKEN = 'catalog-token';
        process.env.EVER_WORKS_APPS_CATALOG_REF = 'e2e';
        const git = {
            getFileContent: jest
                .fn()
                .mockResolvedValue({ content: JSON.stringify(LISTING), encoding: 'utf-8' }),
        };
        const service = new AppsCatalogManifestService(git as never);
        service.fetchImpl = jest.fn();
        expect((await service.get('umami'))?.upstream?.repo).toBe('umami-software/umami');
        expect(git.getFileContent).toHaveBeenCalledWith(
            'ever-works',
            'templates',
            'manifest.json',
            { token: 'catalog-token', providerId: 'github' },
            'e2e',
        );
        expect(await service.get('Not An Id')).toBeNull();
    });
});
