'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { KbDocumentBodyDto, KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/c row 35c — hover-card for assistant-text
 * `kb:{class}/{slug}` citation tokens.
 *
 * Wraps a single citation span in the conversation message renderer
 * (row 35d will lift the row 35a `parseKbCitations` output and emit
 * one `<KbCitationHover>` per token). On hover, debounced 150 ms to
 * avoid storming the resolver as the user scrolls, the component
 * fetches `/api/works/:id/kb/citations/:cls/:...slug` (row 35c proxy
 * route — tries `.md` first, falls back to bare path; mirrors row
 * 35b's `KbMentionResolverService.resolveOne` semantics).
 *
 * The popover surface is a plain absolutely-positioned `<div role="tooltip">`
 * — no Radix / HeadlessUI dep, consistent with the lightweight
 * `KbSearchPalette` approach (PR #938). The popover stays open while
 * either the wrapper span OR the popover itself is hovered/focused
 * so users can navigate to the resolved doc via the in-popover link.
 *
 * Selectors locked for Playwright A18 (row 43) + row 35 future e2e:
 *  - `kb-citation-hover` (the wrapper span — always rendered, with
 *    `data-cls={cls}` + `data-slug={slug}` + `data-open=<bool>`),
 *  - `kb-citation-popover` (the popover root — rendered only while
 *    open, with `data-status={loading|resolved|missing|error}`),
 *  - `kb-citation-popover-title` / `-class` / `-path` / `-snippet` /
 *    `-link` (resolved-state slots),
 *  - `kb-citation-popover-loading` / `-missing` / `-error` (non-
 *    resolved-state copy).
 *
 * Snippet length is capped at 240 chars + ellipsis so the popover
 * stays small. The full body lives one click away via the
 * `kb-citation-popover-link` to `/works/:id/kb/:cls/:slug`.
 */

/** Maximum snippet chars in the popover before truncating with `…`. */
const SNIPPET_CHAR_CAP = 240;

/** Hover debounce — wait this long after `pointerenter` before fetching. */
const HOVER_DEBOUNCE_MS = 150;

/** Default popover route prefix — overridable so the component can be
 *  remounted under a different locale/route shell without surgery. */
const DEFAULT_KB_ROUTE_PREFIX = '/works';

export interface KbCitationHoverProps {
    /** Owning Work scope. Used for the resolution fetch + the popover link. */
    workId: string;
    /** Class segment (`brand` / `legal` / etc — validated by row 35a parser). */
    cls: KbDocumentClass;
    /** Slug segment (`voice`, `terms`, `research/v2.1`, …). */
    slug: string;
    /** Raw matched text from row 35a (defaults to `kb:{cls}/{slug}` if absent). */
    raw?: string;
    /** Override the 150 ms debounce — used by the unit spec. */
    debounceMs?: number;
    /** Override the `/works` route prefix — used by the unit spec / locale shells. */
    routePrefix?: string;
}

type FetchState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'resolved'; document: KbDocumentBodyDto }
    | { status: 'missing' }
    | { status: 'error'; error: string };

interface CitationResolveResponse {
    document: KbDocumentBodyDto | null;
}

/** Compute the popover snippet from the resolved doc body. */
function buildSnippet(body: string | null | undefined): string {
    if (!body) return '';
    const trimmed = body.trim();
    if (trimmed.length <= SNIPPET_CHAR_CAP) return trimmed;
    return `${trimmed.slice(0, SNIPPET_CHAR_CAP)}…`;
}

export function KbCitationHover({
    workId,
    cls,
    slug,
    raw,
    debounceMs = HOVER_DEBOUNCE_MS,
    routePrefix = DEFAULT_KB_ROUTE_PREFIX,
}: KbCitationHoverProps) {
    const t = useTranslations('dashboard.workDetail.kb.citation');
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<FetchState>({ status: 'idle' });
    const fetchedRef = useRef(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const wrapperRef = useRef<HTMLSpanElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const display = raw ?? `kb:${cls}/${slug}`;

    const runFetch = useCallback(() => {
        if (fetchedRef.current) {
            // Already resolved (or in-flight) for this citation — keep the
            // existing state when the hover re-opens the popover.
            return;
        }
        fetchedRef.current = true;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setState({ status: 'loading' });
        void (async () => {
            try {
                const slugPath = encodeURIComponent(slug);
                const response = await fetch(
                    `/api/works/${encodeURIComponent(workId)}/kb/citations/${encodeURIComponent(cls)}/${slugPath}`,
                    { signal: controller.signal, cache: 'no-store' },
                );
                if (!response.ok) {
                    setState({ status: 'error', error: `HTTP ${response.status}` });
                    return;
                }
                const json = (await response.json()) as CitationResolveResponse;
                if (!json || json.document === null) {
                    setState({ status: 'missing' });
                    return;
                }
                setState({ status: 'resolved', document: json.document });
            } catch (error) {
                if ((error as Error).name === 'AbortError') return;
                setState({
                    status: 'error',
                    error: error instanceof Error ? error.message : 'fetch-failed',
                });
                // Allow a retry on the next hover so a transient blip
                // doesn't permanently mark this citation un-resolvable.
                fetchedRef.current = false;
            }
        })();
    }, [workId, cls, slug]);

    const armOpen = useCallback(() => {
        if (closeTimerRef.current !== null) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(() => {
            setOpen(true);
            runFetch();
        }, debounceMs);
    }, [debounceMs, runFetch]);

    const disarmOpen = useCallback(() => {
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        // Small grace period so a tiny mouse-out-mouse-back into the
        // popover doesn't tear it down. Plays nicely with users scrubbing
        // across a long sentence of citations.
        closeTimerRef.current = setTimeout(() => setOpen(false), 80);
    }, []);

    // Click outside / Escape closes immediately.
    useEffect(() => {
        if (!open) return;
        function onDocPointerDown(event: PointerEvent) {
            const target = event.target as Node | null;
            if (!target) return;
            if (wrapperRef.current?.contains(target)) return;
            if (popoverRef.current?.contains(target)) return;
            setOpen(false);
        }
        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false);
        }
        document.addEventListener('pointerdown', onDocPointerDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDocPointerDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // Clear pending timers on unmount.
    useEffect(() => {
        return () => {
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
            if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
            abortRef.current?.abort();
        };
    }, []);

    const resolvedDoc = state.status === 'resolved' ? state.document : null;
    const docHref = resolvedDoc
        ? `${routePrefix}/${encodeURIComponent(workId)}/kb/${encodeURIComponent(cls)}/${encodeURIComponent(slug)}`
        : null;

    return (
        <span
            ref={wrapperRef}
            data-testid="kb-citation-hover"
            data-cls={cls}
            data-slug={slug}
            data-open={open ? 'true' : 'false'}
            className="relative inline-block"
            onPointerEnter={armOpen}
            onPointerLeave={disarmOpen}
            onFocus={armOpen}
            onBlur={disarmOpen}
            tabIndex={0}
        >
            <span
                className={cn(
                    'cursor-help underline decoration-dotted underline-offset-2',
                    'text-text-primary dark:text-text-primary-dark',
                    'hover:bg-card-hover/40 dark:hover:bg-card-primary-dark/30 rounded-sm px-0.5',
                )}
            >
                {display}
            </span>
            {open ? (
                <div
                    ref={popoverRef}
                    role="tooltip"
                    data-testid="kb-citation-popover"
                    data-status={state.status === 'idle' ? 'loading' : state.status}
                    className={cn(
                        'absolute left-0 top-full z-50 mt-1 w-72 rounded-md border p-3 text-xs shadow-md',
                        'border-border bg-card dark:border-border-dark dark:bg-card-primary-dark',
                        'text-text-primary dark:text-text-primary-dark',
                    )}
                    onPointerEnter={armOpen}
                    onPointerLeave={disarmOpen}
                >
                    {(state.status === 'idle' || state.status === 'loading') && (
                        <div data-testid="kb-citation-popover-loading">{t('loading')}</div>
                    )}
                    {state.status === 'missing' && (
                        <div data-testid="kb-citation-popover-missing">
                            {t('missing', { raw: display })}
                        </div>
                    )}
                    {state.status === 'error' && (
                        <div data-testid="kb-citation-popover-error">
                            {t('error', { error: state.error })}
                        </div>
                    )}
                    {state.status === 'resolved' && resolvedDoc && (
                        <>
                            <div
                                className="text-text-primary dark:text-text-primary-dark text-sm font-semibold"
                                data-testid="kb-citation-popover-title"
                            >
                                {resolvedDoc.title}
                            </div>
                            <div
                                className="text-text-secondary dark:text-text-secondary-dark/80 mt-1 flex items-center gap-2 text-[11px]"
                                data-testid="kb-citation-popover-meta"
                            >
                                <span
                                    data-testid="kb-citation-popover-class"
                                    className="bg-card-primary/30 dark:bg-card-primary-dark/50 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                                >
                                    {resolvedDoc.class}
                                </span>
                                <span
                                    data-testid="kb-citation-popover-path"
                                    className="truncate font-mono"
                                >
                                    {resolvedDoc.path}
                                </span>
                            </div>
                            <div
                                data-testid="kb-citation-popover-snippet"
                                className="text-text-secondary dark:text-text-secondary-dark/80 mt-2 line-clamp-4 whitespace-pre-wrap"
                            >
                                {buildSnippet(resolvedDoc.body)}
                            </div>
                            {docHref ? (
                                <a
                                    href={docHref}
                                    data-testid="kb-citation-popover-link"
                                    className="text-link dark:text-link-dark mt-2 inline-block text-[11px] hover:underline"
                                >
                                    {t('open')}
                                </a>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}
        </span>
    );
}
