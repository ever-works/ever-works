'use client';

import { useEffect, useImperativeHandle, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { MentionSuggestionItem } from './extensions/mention-suggestion';

export interface WorkbenchMentionSuggestionListHandle {
    onKeyDown: (event: KeyboardEvent) => boolean;
}

interface WorkbenchMentionSuggestionListProps {
    items: MentionSuggestionItem[];
    query: string;
    loading: boolean;
    onSelect: (item: MentionSuggestionItem) => void;
    ref?: React.Ref<WorkbenchMentionSuggestionListHandle>;
}

/**
 * EW-641 slice B — popover content for the workbench `@` trigger.
 *
 * Docs + Agents in a single section list, each row tagged with
 * `data-kind` so e2e can assert on the mix. Type-indicator pill on
 * each row makes the kind visible at a glance.
 */
export function WorkbenchMentionSuggestionList({
    items,
    query,
    loading,
    onSelect,
    ref,
}: WorkbenchMentionSuggestionListProps) {
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
            data-testid="kb-workbench-mention-suggestion-list"
            data-empty={items.length === 0 ? 'true' : 'false'}
            data-loading={loading ? 'true' : 'false'}
            className={cn(
                'min-w-[20rem] max-w-md rounded-md border shadow-lg',
                'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                'p-1',
            )}
        >
            {loading ? (
                <p
                    data-testid="kb-workbench-mention-suggestion-loading"
                    className="px-3 py-2 text-xs italic text-text-muted dark:text-text-muted-dark/70"
                >
                    {t('mention.searching')}
                </p>
            ) : items.length === 0 ? (
                <p
                    data-testid="kb-workbench-mention-suggestion-empty"
                    className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark/70"
                >
                    {query.trim().length === 0
                        ? t('mention.searching')
                        : t('mention.noMatches', { query: query.trim() })}
                </p>
            ) : (
                <ul role="listbox" aria-label={t('mention.listLabel')}>
                    {items.map((item, index) => {
                        const isActive = index === activeIndex;
                        const kindLabel =
                            item.kind === 'doc' ? t('mention.label.doc') : t('mention.label.agent');
                        return (
                            <li key={`${item.kind}-${item.id}`}>
                                <button
                                    type="button"
                                    data-testid="kb-workbench-mention-suggestion-item"
                                    data-kind={item.kind}
                                    data-id={item.id}
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
                                    <span className="grow truncate">{item.label}</span>
                                    <span
                                        className={cn(
                                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                            item.kind === 'doc'
                                                ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                                : 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
                                        )}
                                    >
                                        {kindLabel}
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
