import { skillsAPI } from '@/lib/api/skills';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';

/**
 * Navigation consolidation (docs/specs/features/navigation-consolidation):
 * the Skills catalog is no longer a standalone page — it renders as a block
 * on the Agents tab (`/agents#skills`) and `/skills` (index) redirects there.
 *
 * Both surfaces need the exact same search-param whitelisting and the exact
 * same defensive `Promise.all` fetch the old `/skills` page did, so it lives
 * here once instead of being duplicated into the redirect route and the
 * Agents page.
 *
 * Server-side only: `@/lib/api/skills` declares `server-only`, so importing
 * this module from a `'use client'` component breaks the Next build. Client
 * components keep their own local copies of the section union.
 */

export const SKILLS_PAGE_SIZE = 50;

export const SKILLS_SECTIONS = ['installed', 'available', 'custom'] as const;

export type SkillsSection = (typeof SKILLS_SECTIONS)[number];

export interface SkillsPageFilters {
    section: SkillsSection;
    search: string;
    installedOffset: number;
    catalogOffset: number;
}

export interface SkillsPageData {
    installed: Skill[];
    installedMeta: { total: number; limit: number; offset: number };
    catalog: SkillCatalogEntry[];
    catalogTotal: number;
    catalogLimit: number;
    loadErrors: { installed: string | null; catalog: string | null };
}

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function parseOffset(value: string | string[] | undefined): number {
    const raw = firstParam(value);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseSection(value: string | string[] | undefined): SkillsSection {
    const raw = firstParam(value);
    return SKILLS_SECTIONS.includes(raw as SkillsSection) ? (raw as SkillsSection) : 'installed';
}

/**
 * Whitelists the four query params the Skills catalog understands. Anything
 * unknown is dropped rather than forwarded, so a hand-crafted URL can't widen
 * the backend query.
 */
export function parseSkillsSearchParams(params: SearchParams): SkillsPageFilters {
    return {
        section: parseSection(params.section),
        search: firstParam(params.search)?.trim() ?? '',
        installedOffset: parseOffset(params.installedOffset),
        catalogOffset: parseOffset(params.catalogOffset),
    };
}

/**
 * Rebuilds a catalog URL on an arbitrary base path, omitting every filter that
 * is already at its default so the common case stays a clean `/agents#skills`.
 * Mirrors `SkillsPageClient`'s `updateUrl` param order.
 */
export function buildSkillsHref(
    basePath: string,
    filters: SkillsPageFilters,
    hash: string = '',
): string {
    const params = new URLSearchParams();
    if (filters.section !== 'installed') params.set('section', filters.section);
    if (filters.search.trim()) params.set('search', filters.search.trim());
    if (filters.installedOffset > 0) params.set('installedOffset', String(filters.installedOffset));
    if (filters.catalogOffset > 0) params.set('catalogOffset', String(filters.catalogOffset));
    return `${basePath}${params.size ? `?${params}` : ''}${hash}`;
}

/**
 * Server-fetches the installed Skills + the catalog union in parallel.
 *
 * Defensive `.then(ok, fail)` so a partial backend failure (e.g. a flaky
 * catalog plugin) still renders the surface with the section that did load —
 * the failing side reports through `loadErrors` instead of throwing the whole
 * page into the error boundary.
 */
export async function loadSkillsPageData(filters: SkillsPageFilters): Promise<SkillsPageData> {
    const [installed, catalog] = await Promise.all([
        skillsAPI
            .listInstalled({
                limit: SKILLS_PAGE_SIZE,
                offset: filters.installedOffset,
                search: filters.search,
            })
            .then(
                (result) => ({ result, error: null as string | null }),
                () => ({
                    result: {
                        data: [] as Skill[],
                        meta: {
                            total: 0,
                            limit: SKILLS_PAGE_SIZE,
                            offset: filters.installedOffset,
                        },
                    },
                    error: 'installed',
                }),
            ),
        skillsAPI
            .listCatalog({
                limit: SKILLS_PAGE_SIZE,
                offset: filters.catalogOffset,
                search: filters.search,
            })
            .then(
                (result) => ({ result, error: null as string | null }),
                () => ({
                    result: { entries: [] as SkillCatalogEntry[], total: 0 },
                    error: 'catalog',
                }),
            ),
    ]);

    return {
        installed: installed.result.data ?? [],
        installedMeta: installed.result.meta,
        catalog: catalog.result.entries ?? [],
        catalogTotal: catalog.result.total ?? 0,
        catalogLimit: SKILLS_PAGE_SIZE,
        loadErrors: { installed: installed.error, catalog: catalog.error },
    };
}
