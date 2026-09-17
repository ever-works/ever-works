'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import {
    MEMORY_FACT_VIEWS,
    type MemoryFactCounts,
    type MemoryFactView,
} from '@/lib/api/memory-facts-types';

/**
 * The existing Memory panels the rail can jump to, by the `data-testid`
 * each panel already renders on its root. Addressed by selector rather than
 * by wrapping the panels, so their internals — and the DOM order the page's
 * specs pin — stay exactly as they are.
 */
export const MEMORY_RAIL_SECTIONS = [
    { key: 'review', selector: '[data-testid="memory-review-panel"]' },
    { key: 'files', selector: '[data-testid="memory-files-panel"]' },
    { key: 'uploads', selector: '[data-testid="memory-uploads-panel"]' },
    { key: 'agentMemory', selector: '[data-testid="agent-memory-panel"]' },
    { key: 'meetings', selector: '#meetings' },
    { key: 'settings', selector: '[data-testid="memory-schedule-panel"]' },
] as const;

const VIEW_LABEL_KEYS: Record<
    MemoryFactView,
    'filterAll' | 'filterPinned' | 'filterProposed' | 'filterForgotten'
> = {
    all: 'filterAll',
    pinned: 'filterPinned',
    proposed: 'filterProposed',
    forgotten: 'filterForgotten',
};

function countFor(view: MemoryFactView, counts: MemoryFactCounts): number {
    switch (view) {
        case 'pinned':
            return counts.pinned;
        case 'proposed':
            return counts.proposed;
        case 'forgotten':
            return counts.forgotten;
        default:
            return counts.active;
    }
}

interface MemoryRailProps {
    counts: MemoryFactCounts;
    view: MemoryFactView;
    onSelectView: (view: MemoryFactView) => void;
}

/**
 * The Memory page's section rail (AW-07).
 *
 * **Facts** — the four views of the facts list with their counts; choosing
 * one filters the list beside it.
 *
 * **Also here** — jump links to every panel the page already had (review
 * queue, files, uploads, agent memory, meetings, consolidation settings).
 * Nothing moved: each panel still renders in its place on the page, and the
 * rail only scrolls to it. A panel that is not on screen (the review queue
 * hides itself when empty) is simply skipped.
 */
export function MemoryRail({ counts, view, onSelectView }: MemoryRailProps) {
    const t = useTranslations('dashboard.memoryPage.rail');
    const tFacts = useTranslations('dashboard.memoryPage.facts');

    const jumpTo = (selector: string) => {
        const target = document.querySelector<HTMLElement>(selector);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <nav
            aria-label={t('label')}
            data-testid="memory-rail"
            className="flex flex-col gap-4 text-sm lg:sticky lg:top-4 self-start"
        >
            <div className="flex flex-col gap-1">
                <span className="px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                    {t('facts')}
                </span>
                <div
                    role="tablist"
                    aria-label={tFacts('viewsLabel')}
                    className="flex flex-row flex-wrap lg:flex-col gap-0.5"
                >
                    {MEMORY_FACT_VIEWS.map((candidate) => {
                        const selected = candidate === view;
                        return (
                            <button
                                key={candidate}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                data-testid={`memory-rail-view-${candidate}`}
                                onClick={() => onSelectView(candidate)}
                                className={cn(
                                    'flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                                    selected
                                        ? 'bg-primary/10 text-primary dark:text-white font-medium'
                                        : 'text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/5',
                                )}
                            >
                                <span>{tFacts(VIEW_LABEL_KEYS[candidate])}</span>
                                <span
                                    data-testid={`memory-rail-count-${candidate}`}
                                    className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark"
                                >
                                    {countFor(candidate, counts)}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <span className="px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                    {t('alsoHere')}
                </span>
                <ul className="flex flex-row flex-wrap lg:flex-col gap-0.5">
                    {MEMORY_RAIL_SECTIONS.map((section) => (
                        <li key={section.key}>
                            <button
                                type="button"
                                data-testid={`memory-rail-jump-${section.key}`}
                                onClick={() => jumpTo(section.selector)}
                                className="w-full rounded-md px-2 py-1.5 text-left text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/5 transition-colors"
                            >
                                {t(section.key)}
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </nav>
    );
}
