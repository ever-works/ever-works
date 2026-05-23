'use client';

import { useEffect, useImperativeHandle, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { MentionItem } from './extensions/MentionExtension';

export interface MentionSuggestionListHandle {
    onKeyDown: (event: KeyboardEvent) => boolean;
}

interface MentionSuggestionListProps {
    items: MentionItem[];
    query: string;
    onSelect: (item: MentionItem) => void;
    ref?: React.Ref<MentionSuggestionListHandle>;
}

/**
 * EW-641 Phase 1B/d row 17 — popover content for the `@` mention trigger.
 *
 * Renders two sections (Docs / Agents) over a single flat ProseMirror
 * suggestion list — the cursor index walks through both sections in
 * order, matching the array passed in by the extension.
 *
 * Selectors locked for Playwright A12-A17:
 *  - `kb-mention-suggestion-list` (root, `data-empty`)
 *  - `kb-mention-suggestion-section` (per section, `data-kind` =
 *    `doc`/`agent`, with a count attr for assertions)
 *  - `kb-mention-suggestion-item` (per row, `data-kind`, plus
 *    `data-doc-path` or `data-agent-id` depending on kind,
 *    `data-active`)
 *  - `kb-mention-suggestion-empty`
 */
export function MentionSuggestionList({ items, query, onSelect, ref }: MentionSuggestionListProps) {
    const t = useTranslations('dashboard.workDetail.kb.mention');
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

    // Split the flat list into sections, preserving the original
    // global index per row (the keyboard cursor is global).
    const docs: Array<{ item: Extract<MentionItem, { kind: 'doc' }>; globalIndex: number }> = [];
    const agents: Array<{ item: Extract<MentionItem, { kind: 'agent' }>; globalIndex: number }> =
        [];
    items.forEach((item, globalIndex) => {
        if (item.kind === 'doc') docs.push({ item, globalIndex });
        else agents.push({ item, globalIndex });
    });

    return (
        <div
            data-testid="kb-mention-suggestion-list"
            data-empty={items.length === 0 ? 'true' : 'false'}
            className={cn(
                'min-w-[20rem] max-w-md rounded-md border shadow-lg',
                'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                'p-1',
            )}
        >
            {items.length === 0 ? (
                <p
                    data-testid="kb-mention-suggestion-empty"
                    className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark/70"
                >
                    {query.trim().length === 0 ? t('hint') : t('empty', { query: query.trim() })}
                </p>
            ) : (
                <>
                    <DocSection
                        title={t('sections.docs')}
                        rows={docs}
                        activeIndex={activeIndex}
                        onSelect={onSelect}
                        setActiveIndex={setActiveIndex}
                    />
                    <AgentSection
                        title={t('sections.agents')}
                        rows={agents}
                        activeIndex={activeIndex}
                        onSelect={onSelect}
                        setActiveIndex={setActiveIndex}
                    />
                </>
            )}
        </div>
    );
}

type MentionDoc = Extract<MentionItem, { kind: 'doc' }>;
type MentionAgent = Extract<MentionItem, { kind: 'agent' }>;

interface DocSectionProps {
    title: string;
    rows: Array<{ item: MentionDoc; globalIndex: number }>;
    activeIndex: number;
    onSelect: (item: MentionItem) => void;
    setActiveIndex: (index: number) => void;
}

function DocSection({ title, rows, activeIndex, onSelect, setActiveIndex }: DocSectionProps) {
    if (rows.length === 0) return null;
    return (
        <div
            data-testid="kb-mention-suggestion-section"
            data-kind="doc"
            data-count={rows.length}
            className="flex flex-col gap-0.5"
        >
            <h3
                className={cn(
                    'px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider',
                    'text-text-muted dark:text-text-muted-dark/70',
                )}
            >
                {title}
            </h3>
            <ul role="listbox">
                {rows.map(({ item, globalIndex }) => {
                    const isActive = globalIndex === activeIndex;
                    return (
                        <li key={item.id}>
                            <button
                                type="button"
                                data-testid="kb-mention-suggestion-item"
                                data-kind="doc"
                                data-doc-id={item.id}
                                data-doc-path={item.path}
                                data-kb-class={item.class}
                                data-active={isActive ? 'true' : 'false'}
                                role="option"
                                aria-selected={isActive}
                                onMouseEnter={() => setActiveIndex(globalIndex)}
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
        </div>
    );
}

interface AgentSectionProps {
    title: string;
    rows: Array<{ item: MentionAgent; globalIndex: number }>;
    activeIndex: number;
    onSelect: (item: MentionItem) => void;
    setActiveIndex: (index: number) => void;
}

function AgentSection({ title, rows, activeIndex, onSelect, setActiveIndex }: AgentSectionProps) {
    if (rows.length === 0) return null;
    return (
        <div
            data-testid="kb-mention-suggestion-section"
            data-kind="agent"
            data-count={rows.length}
            className="flex flex-col gap-0.5"
        >
            <h3
                className={cn(
                    'px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider',
                    'text-text-muted dark:text-text-muted-dark/70',
                )}
            >
                {title}
            </h3>
            <ul role="listbox">
                {rows.map(({ item, globalIndex }) => {
                    const isActive = globalIndex === activeIndex;
                    return (
                        <li key={item.id}>
                            <button
                                type="button"
                                data-testid="kb-mention-suggestion-item"
                                data-kind="agent"
                                data-agent-id={item.id}
                                data-active={isActive ? 'true' : 'false'}
                                role="option"
                                aria-selected={isActive}
                                onMouseEnter={() => setActiveIndex(globalIndex)}
                                onClick={() => onSelect(item)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm',
                                    isActive
                                        ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                        : 'text-text-secondary hover:bg-card-hover dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
                                )}
                            >
                                <span className="grow truncate">{item.name}</span>
                                <span className="shrink-0 font-mono text-[10px] text-text-muted dark:text-text-muted-dark/60">
                                    @{item.id}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
