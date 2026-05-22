'use client';

import { useEffect, useImperativeHandle, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { WikiLinkSuggestionItem } from './extensions/WikiLinkExtension';

export interface WikiLinkSuggestionListHandle {
    /**
     * Called by the Tiptap renderer wrapper when ProseMirror proxies a
     * keydown event. Returning `true` tells the upstream we handled it.
     */
    onKeyDown: (event: KeyboardEvent) => boolean;
}

interface WikiLinkSuggestionListProps {
    items: WikiLinkSuggestionItem[];
    query: string;
    onSelect: (item: WikiLinkSuggestionItem) => void;
    ref?: React.Ref<WikiLinkSuggestionListHandle>;
}

/**
 * EW-641 Phase 1B/d row 16b — popover content for the wikilink trigger.
 *
 * Rendered by `WikiLinkExtension` via `ReactRenderer` (`KbEditor`
 * wires the renderer factory). The component is deliberately small:
 * one `<ul>` of results, arrow-key cursor, Enter-to-commit,
 * hover-to-highlight. Empty state covers both the "no query yet" and
 * "query produced zero rows" cases.
 *
 * Stable selectors locked for Playwright A12-A17:
 *  - `kb-wikilink-suggestion-list` (root, `data-empty`)
 *  - `kb-wikilink-suggestion-item` (per row, with `data-doc-id`,
 *    `data-doc-path`, `data-kb-class`, `data-active`)
 *  - `kb-wikilink-suggestion-empty`
 */
export function WikiLinkSuggestionList({
    items,
    query,
    onSelect,
    ref,
}: WikiLinkSuggestionListProps) {
    const t = useTranslations('dashboard.workDetail.kb.wikilink');
    const [activeIndex, setActiveIndex] = useState(0);

    // Reset the cursor whenever the items list changes (new query).
    useEffect(() => {
        setActiveIndex(0);
    }, [items]);

    useImperativeHandle(
        ref,
        () => ({
            onKeyDown: (event: KeyboardEvent) => {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveIndex((idx) => (items.length === 0 ? 0 : (idx + 1) % items.length));
                    return true;
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveIndex((idx) =>
                        items.length === 0 ? 0 : (idx - 1 + items.length) % items.length,
                    );
                    return true;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    const item = items[activeIndex];
                    if (item) onSelect(item);
                    return true;
                }
                return false;
            },
        }),
        [items, activeIndex, onSelect],
    );

    return (
        <div
            data-testid="kb-wikilink-suggestion-list"
            data-empty={items.length === 0 ? 'true' : 'false'}
            className={cn(
                'min-w-[18rem] max-w-md rounded-md border shadow-lg',
                'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                'p-1',
            )}
        >
            {items.length === 0 ? (
                <p
                    data-testid="kb-wikilink-suggestion-empty"
                    className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark/70"
                >
                    {query.trim().length === 0 ? t('hint') : t('empty', { query: query.trim() })}
                </p>
            ) : (
                <ul role="listbox" aria-label={t('listLabel')}>
                    {items.map((item, index) => {
                        const isActive = index === activeIndex;
                        return (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    data-testid="kb-wikilink-suggestion-item"
                                    data-doc-id={item.id}
                                    data-doc-path={item.path}
                                    data-kb-class={item.class}
                                    data-active={isActive ? 'true' : 'false'}
                                    role="option"
                                    aria-selected={isActive}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onClick={() => onSelect(item)}
                                    className={cn(
                                        'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm',
                                        isActive
                                            ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                            : 'text-text-secondary hover:bg-card-hover dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
                                    )}
                                >
                                    <span className="grow truncate">{item.title || item.path}</span>
                                    <span
                                        className={cn(
                                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                            'bg-primary/10 text-primary dark:bg-primary/20',
                                        )}
                                    >
                                        {item.class}
                                    </span>
                                    <span className="shrink-0 font-mono text-[10px] text-text-muted dark:text-text-muted-dark/60">
                                        {item.path}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
