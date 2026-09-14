import {
    catalogSearchRank,
    playbookSearchFields,
    type CatalogSearchFields,
    type PlaybookCategory,
    type PlaybookReadinessState,
    type PlaybookSummary,
} from '@ever-works/contracts';
import type { WorkflowStatus } from '@/lib/api/workflows.shared';

/**
 * Capability catalogue (AW-21) — the serialisable shape the index page hands
 * to its client shell, and the pure filtering the shell applies to it.
 */

/** One section's slice of data: what loaded, the true total, and whether the source failed. */
export interface CatalogSectionData<T> {
    readonly items: readonly T[];
    readonly total: number;
    readonly error: boolean;
}

export interface CatalogSkillCard {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly installed: boolean;
}

export interface CatalogWorkflowCard {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: WorkflowStatus;
    readonly nodeCount: number;
    readonly runCount: number;
    readonly lastRunAt: string | null;
}

export interface CatalogTaskTemplateCard {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly stepCount: number;
    readonly needApprovalCount: number;
}

export type CatalogStartingPointKind = 'work' | 'website' | 'mission';

export interface CatalogStartingPoint {
    readonly kind: CatalogStartingPointKind;
    readonly count: number;
}

export interface CatalogIndexData {
    readonly playbooks: CatalogSectionData<PlaybookSummary>;
    readonly skills: CatalogSectionData<CatalogSkillCard>;
    readonly workflows: CatalogSectionData<CatalogWorkflowCard>;
    readonly taskTemplates: CatalogSectionData<CatalogTaskTemplateCard>;
    readonly startingPoints: CatalogSectionData<CatalogStartingPoint>;
}

/** The three readiness chips and the states each one selects. */
export const READINESS_FILTERS = {
    readyNow: 'ready',
    needsConnection: 'needs_connection',
    alreadySetUp: 'adopted',
} as const satisfies Record<string, PlaybookReadinessState>;

export type ReadinessFilterKey = keyof typeof READINESS_FILTERS;

export interface CatalogFilters {
    readonly query: string;
    readonly categories: ReadonlySet<PlaybookCategory>;
    readonly readiness: ReadonlySet<ReadinessFilterKey>;
}

/** Filter by search, ranking title-first; a stable sort keeps the original order among equals. */
function rankItems<T>(
    items: readonly T[],
    query: string,
    fieldsOf: (item: T) => CatalogSearchFields,
): T[] {
    return items
        .map((item, index) => ({ item, index, rank: catalogSearchRank(fieldsOf(item), query) }))
        .filter((row): row is { item: T; index: number; rank: number } => row.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((row) => row.item);
}

/**
 * Apply the page's search and chip filters to every section at once.
 *
 * Search narrows all five sections. Category and readiness chips narrow the
 * Playbooks section only; chips are additive (any-of) within a row and
 * intersect across rows. With no search, playbooks that are ready now come
 * first so a new workspace sees what it can use immediately.
 */
export function filterCatalog(data: CatalogIndexData, filters: CatalogFilters) {
    const { query } = filters;
    const wantedStates = new Set<PlaybookReadinessState>(
        [...filters.readiness].map((key) => READINESS_FILTERS[key]),
    );

    const chipFiltered = data.playbooks.items.filter(
        (item) =>
            (filters.categories.size === 0 || filters.categories.has(item.category)) &&
            (wantedStates.size === 0 || wantedStates.has(item.readiness)),
    );
    const readyFirst = query.trim()
        ? chipFiltered
        : [...chipFiltered].sort(
              (a, b) => Number(b.readiness === 'ready') - Number(a.readiness === 'ready'),
          );

    return {
        playbooks: rankItems(readyFirst, query, playbookSearchFields),
        skills: rankItems(data.skills.items, query, (skill) => ({
            title: skill.title,
            tags: skill.tags,
            summary: [skill.description],
        })),
        workflows: rankItems(data.workflows.items, query, (workflow) => ({
            title: workflow.name,
            summary: [workflow.description],
        })),
        taskTemplates: rankItems(data.taskTemplates.items, query, (template) => ({
            title: template.name,
            tags: template.labels,
            summary: [template.description],
        })),
    };
}
