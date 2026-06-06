'use client';

import { useEffect, useImperativeHandle, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { WikilinkSuggestionItem } from './extensions/wikilink-suggestion';

export interface WorkbenchWikilinkSuggestionListHandle {
    onKeyDown: (event: KeyboardEvent) => boolean;
}

interface WorkbenchWikilinkSuggestionListProps {
    items: WikilinkSuggestionItem[];
    query: string;
    loading: boolean;
    onSelect: (item: WikilinkSuggestionItem) => void;
    ref?: React.Ref<WorkbenchWikilinkSuggestionListHandle>;
}

/**
 * EW-641 slice B — popover content for the workbench `[[` trigger.
 *
 * Slim ListBox: arrow-key cursor + Enter/Tab to commit + outside-click
 * dismisses (the Tiptap suggestion plugin handles outside-click by
 * firing `onExit` when the cursor leaves the trigger range, so we
 * don't replicate it here).
 *
 * Selectors are slice-B-prefixed so the slice-A `kb-wikilink-…`
 * selectors stay untouched on the existing `KbEditor`.
 */
export function WorkbenchWikilinkSuggestionList({
    items,
    query,
    loading,
    onSelect,
    ref,
}: WorkbenchWikilinkSuggestionListProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench');
    const [activeIndex, setActiveIndex] = useState(0);

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
                if (event.key === 'Enter' || event.key === 'Tab') {
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
            data-testid="kb-workbench-wikilink-suggestion-list"
            data-empty={items.length === 0 ? 'true' : 'false'}
            data-loading={loading ? 'true' : 'false'}
            className={cn(
                'min-w-[18rem] max-w-md rounded-md border shadow-lg',
                'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                'p-1',
            )}
        >
            {loading ? (
                <p
                    data-testid="kb-workbench-wikilink-suggestion-loading"
                    className="px-3 py-2 text-xs italic text-text-muted dark:text-text-muted-dark/70"
                >
                    {t('wikilink.searching')}
                </p>
            ) : items.length === 0 ? (
                <p
                    data-testid="kb-workbench-wikilink-suggestion-empty"
                    className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark/70"
                >
                    {query.trim().length === 0
                        ? t('wikilink.searching')
                        : t('wikilink.noMatches', { query: query.trim() })}
                </p>
            ) : (
                <ul role="listbox" aria-label={t('wikilink.listLabel')}>
                    {items.map((item, index) => {
                        const isActive = index === activeIndex;
                        return (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    data-testid="kb-workbench-wikilink-suggestion-item"
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
                                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary dark:bg-primary/20">
                                        {item.class}
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
