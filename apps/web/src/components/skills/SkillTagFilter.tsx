'use client';

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { SKILL_TAG_CHIPS_SHOWN, SKILL_TAG_FILTER_MAX } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

export interface SkillTagFacetItem {
    tag: string;
    count: number;
}

export interface SkillTagFilterProps {
    facets: SkillTagFacetItem[];
    selected: string[];
    onChange: (tags: string[]) => void;
    /** Chips shown inline before "+N more". */
    shown?: number;
    /** Most tags selectable at once. */
    max?: number;
}

/**
 * Skills shelf — the tag chip row.
 *
 * The most-used tags render as chips with their counts; the rest are behind a
 * "+N more" control with its own search box. Selection narrows the shelf to
 * Skills carrying ALL selected tags, capped at six — past the cap the other
 * chips disable with the reason in their title. Keyboard: ←/→ move between
 * chips (roving tabindex), Space/Enter toggle, Backspace deselects.
 */
export function SkillTagFilter({
    facets,
    selected,
    onChange,
    shown = SKILL_TAG_CHIPS_SHOWN,
    max = SKILL_TAG_FILTER_MAX,
}: SkillTagFilterProps) {
    const t = useTranslations('dashboard.skillsPage.shelf');
    const [focusIndex, setFocusIndex] = useState(0);
    const [moreOpen, setMoreOpen] = useState(false);
    const [query, setQuery] = useState('');
    const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const atCap = selected.length >= max;
    const inline = useMemo(() => {
        const top = facets.slice(0, shown);
        // A selected tag that sits past the cut still shows as a chip, so the
        // current filter is always visible and removable.
        const extra = facets.slice(shown).filter((facet) => selected.includes(facet.tag));
        return [...top, ...extra];
    }, [facets, shown, selected]);
    const overflow = facets.length - Math.min(facets.length, shown);
    const overflowMatches = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return facets.slice(shown).filter((facet) => (needle ? facet.tag.includes(needle) : true));
    }, [facets, shown, query]);

    if (facets.length === 0 && selected.length === 0) return null;

    const toggle = (tag: string) => {
        if (selected.includes(tag)) {
            onChange(selected.filter((entry) => entry !== tag));
        } else if (!atCap) {
            onChange([...selected, tag]);
        }
    };

    const onChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, tag: string) => {
        const move = (next: number) => {
            const bounded = (next + inline.length) % inline.length;
            setFocusIndex(bounded);
            chipRefs.current[bounded]?.focus();
        };
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            move(index + 1);
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            move(index - 1);
        } else if (event.key === 'Backspace') {
            event.preventDefault();
            if (selected.includes(tag)) toggle(tag);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="skill-tag-filter">
            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('tagsLabel')}
            </span>
            <div
                role="toolbar"
                aria-label={t('tagsLabel')}
                className="flex flex-wrap items-center gap-1.5"
            >
                {inline.map((facet, index) => {
                    const isSelected = selected.includes(facet.tag);
                    const disabled = !isSelected && atCap;
                    return (
                        <button
                            key={facet.tag}
                            ref={(element) => {
                                chipRefs.current[index] = element;
                            }}
                            type="button"
                            data-testid="skill-tag-chip"
                            data-tag={facet.tag}
                            aria-pressed={isSelected}
                            aria-disabled={disabled || undefined}
                            aria-label={t('tagCount', { tag: facet.tag, count: facet.count })}
                            title={disabled ? t('tagsLimitTooltip') : undefined}
                            tabIndex={index === focusIndex ? 0 : -1}
                            onClick={() => toggle(facet.tag)}
                            onKeyDown={(event) => onChipKeyDown(event, index, facet.tag)}
                            onFocus={() => setFocusIndex(index)}
                            className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                                isSelected
                                    ? 'border-primary/40 bg-primary/10 text-primary'
                                    : 'border-border/60 text-text-secondary hover:border-border dark:border-border-dark/60 dark:text-text-secondary-dark',
                                disabled && 'cursor-not-allowed opacity-50',
                            )}
                        >
                            {isSelected ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                            <span>{facet.tag}</span>
                            <span
                                className="text-text-muted dark:text-text-muted-dark"
                                aria-hidden="true"
                            >
                                {facet.count}
                            </span>
                        </button>
                    );
                })}
            </div>

            {overflow > 0 ? (
                <div className="relative">
                    <button
                        type="button"
                        data-testid="skill-tag-more"
                        aria-expanded={moreOpen}
                        onClick={() => setMoreOpen((open) => !open)}
                        className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-text-secondary hover:border-border dark:border-border-dark/60 dark:text-text-secondary-dark"
                    >
                        {t('tagsMore', { count: overflow })}
                    </button>
                    {moreOpen ? (
                        <div
                            data-testid="skill-tag-more-panel"
                            className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-border/60 bg-card p-2 shadow-lg dark:border-border-dark/60 dark:bg-card-primary-dark"
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') setMoreOpen(false);
                            }}
                        >
                            <label className="sr-only" htmlFor="skill-tag-more-search">
                                {t('tagsSearchLabel')}
                            </label>
                            <input
                                id="skill-tag-more-search"
                                type="search"
                                autoFocus
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t('tagsSearchPlaceholder')}
                                className="mb-2 h-8 w-full rounded border border-border/60 bg-card px-2 text-xs text-text outline-none focus:border-primary dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-dark"
                            />
                            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                                {overflowMatches.length === 0 ? (
                                    <li className="px-1 py-1 text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('tagsNoMatch')}
                                    </li>
                                ) : (
                                    overflowMatches.map((facet) => {
                                        const isSelected = selected.includes(facet.tag);
                                        const disabled = !isSelected && atCap;
                                        return (
                                            <li key={facet.tag}>
                                                <button
                                                    type="button"
                                                    data-testid="skill-tag-more-option"
                                                    aria-pressed={isSelected}
                                                    aria-disabled={disabled || undefined}
                                                    title={
                                                        disabled ? t('tagsLimitTooltip') : undefined
                                                    }
                                                    onClick={() => toggle(facet.tag)}
                                                    className={cn(
                                                        'flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-xs hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                                                        isSelected
                                                            ? 'text-primary'
                                                            : 'text-text dark:text-text-dark',
                                                        disabled && 'cursor-not-allowed opacity-50',
                                                    )}
                                                >
                                                    <span>{facet.tag}</span>
                                                    <span className="text-text-muted dark:text-text-muted-dark">
                                                        {facet.count}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })
                                )}
                            </ul>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {selected.length > 0 ? (
                <button
                    type="button"
                    data-testid="skill-tag-clear"
                    onClick={() => onChange([])}
                    className="inline-flex items-center gap-1 text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline dark:text-text-muted-dark dark:hover:text-text-dark"
                >
                    <X className="h-3 w-3" aria-hidden="true" />
                    {t('tagsClear')}
                </button>
            ) : null}
        </div>
    );
}
