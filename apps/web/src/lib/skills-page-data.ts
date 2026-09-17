import {
    SKILL_PROVENANCES,
    SKILL_READINESS_FILTERS,
    SKILL_SHELF_SORTS,
    SKILL_TAG_FILTER_MAX,
    normalizeSkillTag,
    type SkillProvenance,
    type SkillReadinessFilter,
    type SkillShelfSort,
} from '@ever-works/contracts';
import { skillsAPI } from '@/lib/api/skills';
import type {
    Skill,
    SkillCardStateCounts,
    SkillCatalogEntry,
    SkillTagFacet,
} from '@/lib/api/skills';

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
    // ── Skills shelf — each absent (undefined) at its default ──
    /** Selected tag chips (AND), normalised, at most 6. */
    tags?: string[];
    readiness?: SkillReadinessFilter;
    provenance?: SkillProvenance;
    enabled?: boolean;
    /** Absent = `updated`. */
    sort?: SkillShelfSort;
}

export interface SkillsPageData {
    installed: Skill[];
    installedMeta: { total: number; limit: number; offset: number };
    catalog: SkillCatalogEntry[];
    catalogTotal: number;
    catalogLimit: number;
    loadErrors: { installed: string | null; catalog: string | null };
    /** Skills shelf — tag chips. Empty when the facet call failed (the shelf still renders). */
    tagFacets?: SkillTagFacet[];
    /** Skills shelf — per-card-state counts for the summary line. */
    counts?: SkillCardStateCounts | null;
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

function parseTags(value: string | string[] | undefined): string[] | undefined {
    const raw = firstParam(value);
    if (!raw) return undefined;
    const tags: string[] = [];
    for (const part of raw.split(',')) {
        const tag = normalizeSkillTag(part);
        if (tag && !tags.includes(tag)) tags.push(tag);
    }
    return tags.length > 0 ? tags.slice(0, SKILL_TAG_FILTER_MAX) : undefined;
}

function parseOneOf<T extends string>(
    value: string | string[] | undefined,
    allowed: readonly T[],
): T | undefined {
    const raw = firstParam(value);
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function parseEnabled(value: string | string[] | undefined): boolean | undefined {
    const raw = firstParam(value);
    return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

/**
 * Whitelists the query params the Skills catalog understands: the original
 * four plus the shelf's five (`tags`, `readiness`, `provenance`, `enabled`,
 * `sort`). Anything unknown — or any malformed shelf value — is dropped rather
 * than forwarded, so a hand-crafted URL can't widen the backend query.
 */
export function parseSkillsSearchParams(params: SearchParams): SkillsPageFilters {
    const filters: SkillsPageFilters = {
        section: parseSection(params.section),
        search: firstParam(params.search)?.trim() ?? '',
        installedOffset: parseOffset(params.installedOffset),
        catalogOffset: parseOffset(params.catalogOffset),
    };
    const tags = parseTags(params.tags);
    if (tags) filters.tags = tags;
    const readiness = parseOneOf(params.readiness, SKILL_READINESS_FILTERS);
    if (readiness) filters.readiness = readiness;
    const provenance = parseOneOf(params.provenance, SKILL_PROVENANCES);
    if (provenance) filters.provenance = provenance;
    const enabled = parseEnabled(params.enabled);
    if (enabled !== undefined) filters.enabled = enabled;
    const sort = parseOneOf(params.sort, SKILL_SHELF_SORTS);
    if (sort && sort !== 'updated') filters.sort = sort;
    return filters;
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
    if (filters.tags?.length) params.set('tags', filters.tags.join(','));
    if (filters.readiness) params.set('readiness', filters.readiness);
    if (filters.provenance) params.set('provenance', filters.provenance);
    if (filters.enabled !== undefined) params.set('enabled', String(filters.enabled));
    if (filters.sort && filters.sort !== 'updated') params.set('sort', filters.sort);
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
    const [installed, catalog, facets] = await Promise.all([
        skillsAPI
            .listInstalled({
                limit: SKILLS_PAGE_SIZE,
                offset: filters.installedOffset,
                search: filters.search,
                tags: filters.tags,
                readiness: filters.readiness,
                provenance: filters.provenance,
                enabled: filters.enabled,
                sort: filters.sort,
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
        // Skills shelf — tag chips. Same defensive posture: a failing facet
        // call leaves the chip row empty, never the shelf. Wrapped so even a
        // synchronous throw becomes a handled rejection.
        Promise.resolve()
            .then(() => skillsAPI.listTags())
            .then(
                (result) => result?.tags ?? [],
                () => [] as SkillTagFacet[],
            ),
    ]);

    return {
        installed: installed.result.data ?? [],
        installedMeta: installed.result.meta,
        catalog: catalog.result.entries ?? [],
        catalogTotal: catalog.result.total ?? 0,
        catalogLimit: SKILLS_PAGE_SIZE,
        loadErrors: { installed: installed.error, catalog: catalog.error },
        tagFacets: facets,
        counts: 'counts' in installed.result ? (installed.result.counts ?? null) : null,
    };
}
