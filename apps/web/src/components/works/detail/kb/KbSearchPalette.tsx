'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import type { KbDocumentDto } from '@ever-works/contracts';

interface KbSearchPaletteProps {
    workId: string;
    /** Override the 250 ms debounce — used by the unit spec. */
    debounceMs?: number;
}

interface SearchResponse {
    items: KbDocumentDto[];
    total: number;
}

type FetchState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; items: KbDocumentDto[]; total: number }
    | { status: 'error'; error: string };

const DEFAULT_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 20;

/**
 * EW-641 Phase 1B/d row 15 — CmdK-style search palette for the KB.
 *
 * Lightweight implementation (no `cmdk` dep) so the bundle stays
 * lean — the surface is small enough to roll by hand: global keyboard
 * listener, a centered dialog with a single input, debounced fetch
 * against `/api/works/:id/kb/search?q=…`, arrow-key navigation, Enter
 * to open, Esc to close.
 *
 * Mounted once per KB page (index + nested). The trigger button is
 * always visible so mouse-only operators don't need to remember the
 * shortcut.
 *
 * Selectors locked for Playwright A12-A17:
 *  - `kb-search-trigger` (button shown inline above the shell)
 *  - `kb-search-palette` (dialog root, `data-open` boolean)
 *  - `kb-search-input`
 *  - `kb-search-result` (per result, with `data-doc-id` + `data-doc-path`
 *    + `data-kb-class` + `data-active` for the keyboard cursor)
 *  - `kb-search-empty` (rendered when the query is non-trivial but the
 *    upstream returned zero rows)
 *  - `kb-search-loading` / `kb-search-error`
 */
export function KbSearchPalette({
    workId,
    debounceMs = DEFAULT_DEBOUNCE_MS,
}: KbSearchPaletteProps) {
    const t = useTranslations('dashboard.workDetail.kb.search');
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [state, setState] = useState<FetchState>({ status: 'idle' });
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Global ⌘K / Ctrl+K to open. Single window-level listener; the
    // dialog itself owns Esc-to-close + Enter-to-open-result.
    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setOpen((prev) => !prev);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Focus the input when the dialog opens, reset transient state when
    // it closes.
    useEffect(() => {
        if (open) {
            inputRef.current?.focus();
        } else {
            setQuery('');
            setState({ status: 'idle' });
            setActiveIndex(0);
            abortRef.current?.abort();
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        }
    }, [open]);

    // Debounced fetch on query change.
    useEffect(() => {
        if (!open) return;
        const trimmed = query.trim();
        if (trimmed.length < MIN_QUERY_LENGTH) {
            setState({ status: 'idle' });
            setActiveIndex(0);
            return;
        }
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(() => {
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setState({ status: 'loading' });
            void (async () => {
                try {
                    const params = new URLSearchParams({ q: trimmed, limit: String(MAX_RESULTS) });
                    const response = await fetch(
                        `/api/works/${encodeURIComponent(workId)}/kb/search?${params.toString()}`,
                        { signal: controller.signal, cache: 'no-store' },
                    );
                    if (!response.ok) {
                        setState({ status: 'error', error: `HTTP ${response.status}` });
                        return;
                    }
                    const json = (await response.json()) as SearchResponse;
                    setState({
                        status: 'ready',
                        items: json.items ?? [],
                        total: json.total ?? json.items?.length ?? 0,
                    });
                    setActiveIndex(0);
                } catch (error) {
                    if ((error as Error).name === 'AbortError') return;
                    setState({
                        status: 'error',
                        error: error instanceof Error ? error.message : 'Search failed',
                    });
                }
            })();
        }, debounceMs);

        return () => {
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, [query, open, workId, debounceMs]);

    const navigateToDoc = useCallback(
        (doc: KbDocumentDto) => {
            setOpen(false);
            router.push(`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`);
        },
        [router, workId],
    );

    const onInputKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (state.status !== 'ready') {
                if (event.key === 'Escape') setOpen(false);
                return;
            }
            const items = state.items;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((idx) => (items.length === 0 ? 0 : (idx + 1) % items.length));
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((idx) =>
                    items.length === 0 ? 0 : (idx - 1 + items.length) % items.length,
                );
            } else if (event.key === 'Enter') {
                event.preventDefault();
                const doc = items[activeIndex];
                if (doc) navigateToDoc(doc);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
            }
        },
        [state, activeIndex, navigateToDoc],
    );

    return (
        <>
            <button
                type="button"
                data-testid="kb-search-trigger"
                onClick={() => setOpen(true)}
                className={cn(
                    'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
                    'border-border bg-card/40 dark:border-border-dark dark:bg-card-primary-dark/30',
                    'text-text-secondary dark:text-text-secondary-dark/80',
                    'hover:bg-card-hover dark:hover:bg-card-primary-dark/50',
                )}
            >
                <span aria-hidden="true">🔍</span>
                <span>{t('triggerLabel')}</span>
                <kbd className="ml-2 rounded border border-border/60 bg-card/70 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:border-border-dark/60 dark:bg-card-primary-dark/60 dark:text-text-muted-dark/70">
                    ⌘K
                </kbd>
            </button>

            {open ? (
                <div
                    data-testid="kb-search-palette"
                    data-open="true"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('dialogLabel')}
                    className={cn(
                        'fixed inset-0 z-50 flex items-start justify-center',
                        'bg-black/40 px-4 pt-[15vh]',
                    )}
                    onClick={(event) => {
                        if (event.target === event.currentTarget) setOpen(false);
                    }}
                >
                    <div
                        className={cn(
                            'w-full max-w-xl rounded-lg border shadow-2xl',
                            'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                        )}
                    >
                        <input
                            ref={inputRef}
                            data-testid="kb-search-input"
                            type="search"
                            value={query}
                            placeholder={t('placeholder')}
                            aria-label={t('inputLabel')}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={onInputKeyDown}
                            className={cn(
                                'w-full rounded-t-lg border-b bg-transparent px-4 py-3 text-sm outline-hidden',
                                'border-border placeholder:text-text-muted dark:border-border-dark',
                                'text-text dark:text-text-dark dark:placeholder:text-text-muted-dark/60',
                            )}
                        />
                        <div className="max-h-[50vh] overflow-y-auto p-1">
                            {state.status === 'loading' ? (
                                <p
                                    data-testid="kb-search-loading"
                                    className="px-3 py-4 text-center text-xs text-text-muted dark:text-text-muted-dark/70"
                                >
                                    {t('loading')}
                                </p>
                            ) : null}
                            {state.status === 'error' ? (
                                <p
                                    data-testid="kb-search-error"
                                    className="px-3 py-4 text-center text-xs text-red-600 dark:text-red-400"
                                >
                                    {t('error', { error: state.error })}
                                </p>
                            ) : null}
                            {state.status === 'idle' && query.trim().length < MIN_QUERY_LENGTH ? (
                                <p className="px-3 py-4 text-center text-xs text-text-muted dark:text-text-muted-dark/70">
                                    {t('hint', { min: MIN_QUERY_LENGTH })}
                                </p>
                            ) : null}
                            {state.status === 'ready' && state.items.length === 0 ? (
                                <p
                                    data-testid="kb-search-empty"
                                    className="px-3 py-4 text-center text-xs text-text-muted dark:text-text-muted-dark/70"
                                >
                                    {t('empty', { query: query.trim() })}
                                </p>
                            ) : null}
                            {state.status === 'ready' && state.items.length > 0 ? (
                                <ul role="listbox" aria-label={t('dialogLabel')}>
                                    {state.items.map((doc, index) => {
                                        const isActive = index === activeIndex;
                                        return (
                                            <li key={doc.id}>
                                                <button
                                                    type="button"
                                                    data-testid="kb-search-result"
                                                    data-doc-id={doc.id}
                                                    data-doc-path={doc.path}
                                                    data-kb-class={doc.class}
                                                    data-active={isActive ? 'true' : 'false'}
                                                    role="option"
                                                    aria-selected={isActive}
                                                    onMouseEnter={() => setActiveIndex(index)}
                                                    onClick={() => navigateToDoc(doc)}
                                                    className={cn(
                                                        'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm',
                                                        isActive
                                                            ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                                            : 'text-text-secondary hover:bg-card-hover dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
                                                    )}
                                                >
                                                    <span className="grow truncate">
                                                        {doc.title || doc.path}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                                            'bg-primary/10 text-primary dark:bg-primary/20',
                                                        )}
                                                    >
                                                        {doc.class}
                                                    </span>
                                                    <span className="shrink-0 font-mono text-[10px] text-text-muted dark:text-text-muted-dark/60">
                                                        {doc.path}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
