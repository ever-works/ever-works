'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import {
    SKILL_CARD_STATES,
    countSkillsNeedingAttention,
    type SkillReadinessFilter,
    type SkillShelfSort,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { SKILL_CARD_STATE_TITLE_KEYS } from '@/lib/skill-readiness';
import type { Skill, SkillCardStateCounts } from '@/lib/api/skills';
import { SkillShelfCard } from './SkillShelfCard';
import { SkillTagFilter, type SkillTagFacetItem } from './SkillTagFilter';

export interface SkillShelfFilters {
    search: string;
    tags?: string[];
    readiness?: SkillReadinessFilter;
    sort?: SkillShelfSort;
}

export interface SkillShelfProps {
    skills: Skill[];
    meta: { total: number; limit: number; offset: number };
    counts?: SkillCardStateCounts | null;
    tagFacets?: SkillTagFacetItem[];
    filters: SkillShelfFilters;
    /** Apply a filter change; the host serialises it into the URL and resets the page. */
    onFiltersChange: (
        updates: Partial<Omit<SkillShelfFilters, 'search'>> & { search?: string },
    ) => void;
    /** Jump back to the first page (past-the-end recovery). */
    onFirstPage: () => void;
    /** Switch the host to the catalogue section (empty-shelf recovery). */
    onBrowseCatalog?: () => void;
}

const SORTS: SkillShelfSort[] = ['updated', 'name', 'attention'];

const SORT_KEYS = {
    updated: 'sortUpdated',
    name: 'sortName',
    attention: 'sortAttention',
} as const satisfies Record<SkillShelfSort, string>;

/**
 * Skills shelf — the installed Skills as a filterable grid.
 *
 * Above the grid: the summary line ("{n} of {total} Skills need you"), which
 * is itself the needs-attention filter. It counts real problems only — a Skill
 * nothing has checked yet ("Not checked yet") is not one, and neither is one
 * the owner switched off on purpose — so a shelf of unchecked or switched-off
 * Skills says nothing needs you, without claiming they are all ready. Then the
 * sort and state controls (where `unknown` and `disabled` stay selectable), and the
 * tag chips. The grid renders from server-fetched rows, badges included, so
 * nothing reflows after first paint. Three empty states are kept distinct:
 * no Skills at all, nothing matching the filters, and a page past the end.
 */
export function SkillShelf({
    skills,
    meta,
    counts,
    tagFacets = [],
    filters,
    onFiltersChange,
    onFirstPage,
    onBrowseCatalog,
}: SkillShelfProps) {
    const t = useTranslations('dashboard.skillsPage.shelf');
    const tr = useTranslations('dashboard.skillsPage.readiness');

    const tags = filters.tags ?? [];
    const total = counts
        ? SKILL_CARD_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0)
        : null;
    const needAttention = counts && total !== null ? countSkillsNeedingAttention(counts) : null;
    const notChecked = counts?.unknown ?? 0;
    const switchedOff = counts?.disabled ?? 0;
    const attentionOn = filters.readiness === 'attention';
    const hasFilters = Boolean(filters.search.trim() || tags.length || filters.readiness);

    return (
        <div className="space-y-3" data-testid="skill-shelf">
            {total !== null && total > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    {needAttention && needAttention > 0 ? (
                        <>
                            <span
                                data-testid="skill-shelf-summary"
                                className="text-text dark:text-text-dark"
                            >
                                {t('attentionSummary', { count: needAttention, total })}
                            </span>
                            <button
                                type="button"
                                data-testid="skill-shelf-attention-toggle"
                                aria-pressed={attentionOn}
                                onClick={() =>
                                    onFiltersChange({
                                        readiness: attentionOn ? undefined : 'attention',
                                    })
                                }
                                className="text-xs text-primary underline-offset-2 hover:underline"
                            >
                                {attentionOn ? t('attentionFilterOff') : t('attentionFilterOn')}
                            </button>
                        </>
                    ) : notChecked > 0 ? (
                        <span
                            data-testid="skill-shelf-summary"
                            className="text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('attentionNoneNotChecked', { count: notChecked, total })}
                        </span>
                    ) : switchedOff > 0 ? (
                        <span
                            data-testid="skill-shelf-summary"
                            className="text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('attentionNoneSwitchedOff', { count: switchedOff, total })}
                        </span>
                    ) : (
                        <span
                            data-testid="skill-shelf-summary"
                            className="text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('attentionAllReady', { total })}
                        </span>
                    )}
                </div>
            ) : null}

            <div
                className="flex flex-wrap items-center gap-3"
                role="group"
                aria-label={t('filtersLabel')}
            >
                <label className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('sortLabel')}
                    <select
                        data-testid="skill-shelf-sort"
                        value={filters.sort ?? 'updated'}
                        onChange={(event) =>
                            onFiltersChange({
                                sort:
                                    event.target.value === 'updated'
                                        ? undefined
                                        : (event.target.value as SkillShelfSort),
                            })
                        }
                        className="h-8 rounded-md border border-border/60 bg-card px-2 text-xs text-text dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-dark"
                    >
                        {SORTS.map((sort) => (
                            <option key={sort} value={sort}>
                                {t(SORT_KEYS[sort])}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('readinessLabel')}
                    <select
                        data-testid="skill-shelf-readiness"
                        value={filters.readiness ?? ''}
                        onChange={(event) =>
                            onFiltersChange({
                                readiness: (event.target.value || undefined) as
                                    | SkillReadinessFilter
                                    | undefined,
                            })
                        }
                        className="h-8 rounded-md border border-border/60 bg-card px-2 text-xs text-text dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-dark"
                    >
                        <option value="">{t('readinessAny')}</option>
                        <option value="attention">{t('sortAttention')}</option>
                        {SKILL_CARD_STATES.map((state) => (
                            <option key={state} value={state}>
                                {state === 'missing_requirements'
                                    ? tr('missingTitle', { count: 2 })
                                    : tr(SKILL_CARD_STATE_TITLE_KEYS[state])}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <SkillTagFilter
                facets={tagFacets}
                selected={tags}
                onChange={(next) => onFiltersChange({ tags: next })}
            />

            <ShelfBody
                skills={skills}
                meta={meta}
                hasFilters={hasFilters}
                shelfIsEmpty={total === 0}
                filters={filters}
                onClear={() => onFiltersChange({ search: '', tags: [], readiness: undefined })}
                onFirstPage={onFirstPage}
                onBrowseCatalog={onBrowseCatalog}
            />
        </div>
    );
}

function ShelfBody({
    skills,
    meta,
    hasFilters,
    shelfIsEmpty,
    filters,
    onClear,
    onFirstPage,
    onBrowseCatalog,
}: {
    skills: Skill[];
    meta: { total: number; limit: number; offset: number };
    hasFilters: boolean;
    shelfIsEmpty: boolean;
    filters: SkillShelfFilters;
    onClear: () => void;
    onFirstPage: () => void;
    onBrowseCatalog?: () => void;
}) {
    const t = useTranslations('dashboard.skillsPage.shelf');

    if (skills.length > 0) return <SkillShelfGrid skills={skills} />;

    const boxClass =
        'rounded-md border border-border/60 bg-card p-6 text-sm text-text-muted dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-muted-dark';

    if (meta.offset > 0 && meta.total > 0) {
        return (
            <div className={boxClass} data-testid="skill-shelf-past-end">
                <p>{t('pastEnd')}</p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={onFirstPage}>
                    {t('backToFirstPage')}
                </Button>
            </div>
        );
    }

    if (hasFilters && !shelfIsEmpty) {
        const query = filters.search.trim();
        const tags = (filters.tags ?? []).join(', ');
        const message =
            query && tags
                ? t('noResultsTagged', { query, tags })
                : query
                  ? t('noResultsPlain', { query })
                  : tags
                    ? t('noResultsTagsOnly', { tags })
                    : t('noResultsFilters');
        return (
            <div className={boxClass} data-testid="skill-shelf-no-results">
                <p className="font-medium text-text dark:text-text-dark">{message}</p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={onClear}>
                    {t('clearFilters')}
                </Button>
            </div>
        );
    }

    return (
        <div className={boxClass} data-testid="skill-shelf-empty">
            <p className="font-medium text-text dark:text-text-dark">{t('emptyTitle')}</p>
            <p className="mt-1">{t('emptyBody')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
                {onBrowseCatalog ? (
                    <Button size="sm" variant="secondary" onClick={onBrowseCatalog}>
                        {t('emptyBrowse')}
                    </Button>
                ) : null}
                <Button
                    size="sm"
                    variant="primary"
                    href={ROUTES.DASHBOARD_SKILL_NEW}
                    className="gap-1.5"
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('emptyNew')}
                </Button>
                <span title={t('emptyFromRunTooltip')}>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled
                        aria-describedby="skill-shelf-from-run-hint"
                    >
                        {t('emptyFromRun')}
                    </Button>
                </span>
                <span id="skill-shelf-from-run-hint" className="sr-only">
                    {t('emptyFromRunTooltip')}
                </span>
            </div>
        </div>
    );
}

/** The card grid on its own — also used by the Custom section, which has no filters. */
export function SkillShelfGrid({ skills }: { skills: Skill[] }) {
    return (
        <div
            className="grid grid-cols-1 gap-4 @lg/main:grid-cols-2 @3xl/main:grid-cols-3"
            data-testid="skill-shelf-grid"
        >
            {skills.map((skill) => (
                <SkillShelfCard key={skill.id} skill={skill} />
            ))}
        </div>
    );
}
