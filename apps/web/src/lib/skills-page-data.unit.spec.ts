import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';

const listInstalled = vi.fn();
const listCatalog = vi.fn();

vi.mock('@/lib/api/skills', () => ({
    skillsAPI: {
        listInstalled: (...args: unknown[]) => listInstalled(...args),
        listCatalog: (...args: unknown[]) => listCatalog(...args),
    },
}));

import {
    SKILLS_PAGE_SIZE,
    buildSkillsHref,
    loadSkillsPageData,
    parseSkillsSearchParams,
    type SkillsPageFilters,
} from './skills-page-data';

const DEFAULT_FILTERS: SkillsPageFilters = {
    section: 'installed',
    search: '',
    installedOffset: 0,
    catalogOffset: 0,
};

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: 'skill-1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'custom',
        title: 'Custom',
        description: 'Custom skill',
        frontmatter: { name: 'custom', description: 'Custom skill' },
        instructionsMd: '# Custom',
        contentHash: 'hash',
        sourcePath: null,
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        version: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeCatalogEntry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
    return {
        slug: 'catalog-one',
        title: 'Catalog One',
        description: 'Catalog skill',
        frontmatter: { name: 'catalog-one', description: 'Catalog skill' },
        body: '# Catalog',
        version: '1.0.0',
        tags: [],
        ...overrides,
    };
}

describe('parseSkillsSearchParams', () => {
    it('falls back to the installed section with empty search and zero offsets', () => {
        expect(parseSkillsSearchParams({})).toEqual(DEFAULT_FILTERS);
    });

    it('keeps a known section and drops an unknown one', () => {
        expect(parseSkillsSearchParams({ section: 'custom' }).section).toBe('custom');
        expect(parseSkillsSearchParams({ section: 'available' }).section).toBe('available');
        expect(parseSkillsSearchParams({ section: 'bogus' }).section).toBe('installed');
    });

    it('takes the first value when a param repeats', () => {
        const filters = parseSkillsSearchParams({
            section: ['custom', 'available'],
            search: ['  alpha  ', 'beta'],
            installedOffset: ['50', '100'],
        });
        expect(filters.section).toBe('custom');
        expect(filters.search).toBe('alpha');
        expect(filters.installedOffset).toBe(50);
    });

    it('clamps non-positive, fractional and non-numeric offsets to 0', () => {
        expect(parseSkillsSearchParams({ installedOffset: '-5' }).installedOffset).toBe(0);
        expect(parseSkillsSearchParams({ installedOffset: 'abc' }).installedOffset).toBe(0);
        expect(parseSkillsSearchParams({ installedOffset: '1.5' }).installedOffset).toBe(0);
        expect(parseSkillsSearchParams({ catalogOffset: '0' }).catalogOffset).toBe(0);
        expect(parseSkillsSearchParams({ catalogOffset: '50' }).catalogOffset).toBe(50);
    });
});

describe('buildSkillsHref', () => {
    it('omits an empty query string and appends the hash', () => {
        expect(buildSkillsHref('/agents', DEFAULT_FILTERS, '#skills')).toBe('/agents#skills');
        expect(buildSkillsHref('/skills', DEFAULT_FILTERS)).toBe('/skills');
    });

    it('serialises only the non-default filters, hash last', () => {
        expect(
            buildSkillsHref('/agents', { ...DEFAULT_FILTERS, section: 'custom' }, '#skills'),
        ).toBe('/agents?section=custom#skills');
        expect(
            buildSkillsHref(
                '/agents',
                {
                    section: 'available',
                    search: 'pdf tools',
                    installedOffset: 50,
                    catalogOffset: 100,
                },
                '#skills',
            ),
        ).toBe(
            '/agents?section=available&search=pdf+tools&installedOffset=50&catalogOffset=100#skills',
        );
    });
});

describe('loadSkillsPageData', () => {
    beforeEach(() => {
        listInstalled.mockReset();
        listCatalog.mockReset();
    });

    it('passes the paging window + search to both endpoints and returns their payloads', async () => {
        const skill = makeSkill();
        const entry = makeCatalogEntry();
        listInstalled.mockResolvedValue({
            data: [skill],
            meta: { total: 1, limit: SKILLS_PAGE_SIZE, offset: 0 },
        });
        listCatalog.mockResolvedValue({ entries: [entry], total: 1 });

        const data = await loadSkillsPageData({
            section: 'available',
            search: 'pdf',
            installedOffset: 50,
            catalogOffset: 100,
        });

        expect(listInstalled).toHaveBeenCalledWith({
            limit: SKILLS_PAGE_SIZE,
            offset: 50,
            search: 'pdf',
        });
        expect(listCatalog).toHaveBeenCalledWith({
            limit: SKILLS_PAGE_SIZE,
            offset: 100,
            search: 'pdf',
        });
        expect(data.installed).toEqual([skill]);
        expect(data.catalog).toEqual([entry]);
        expect(data.catalogTotal).toBe(1);
        expect(data.catalogLimit).toBe(SKILLS_PAGE_SIZE);
        expect(data.loadErrors).toEqual({ installed: null, catalog: null });
    });

    it('degrades to an empty installed list flagged with loadErrors.installed', async () => {
        listInstalled.mockRejectedValue(new Error('boom'));
        listCatalog.mockResolvedValue({ entries: [makeCatalogEntry()], total: 1 });

        const data = await loadSkillsPageData({ ...DEFAULT_FILTERS, installedOffset: 50 });

        expect(data.loadErrors).toEqual({ installed: 'installed', catalog: null });
        expect(data.installed).toEqual([]);
        expect(data.installedMeta).toEqual({ total: 0, limit: SKILLS_PAGE_SIZE, offset: 50 });
        expect(data.catalog).toHaveLength(1);
    });

    it('degrades to an empty catalog flagged with loadErrors.catalog', async () => {
        listInstalled.mockResolvedValue({
            data: [makeSkill()],
            meta: { total: 1, limit: SKILLS_PAGE_SIZE, offset: 0 },
        });
        listCatalog.mockRejectedValue(new Error('catalog plugin down'));

        const data = await loadSkillsPageData(DEFAULT_FILTERS);

        expect(data.loadErrors).toEqual({ installed: null, catalog: 'catalog' });
        expect(data.catalog).toEqual([]);
        expect(data.catalogTotal).toBe(0);
        expect(data.installed).toHaveLength(1);
    });

    it('normalises missing collections from a partial backend payload', async () => {
        listInstalled.mockResolvedValue({ meta: { total: 0, limit: SKILLS_PAGE_SIZE, offset: 0 } });
        listCatalog.mockResolvedValue({});

        const data = await loadSkillsPageData(DEFAULT_FILTERS);

        expect(data.installed).toEqual([]);
        expect(data.catalog).toEqual([]);
        expect(data.catalogTotal).toBe(0);
    });
});
