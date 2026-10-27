'use client';

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUpToLine, Copy, Download, Pause, Play, RotateCw } from 'lucide-react';
import type { FleetLogSource } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { CopyCommand } from '../link/CopyCommand';
import {
    filterHeld,
    formatLogTime,
    isAtBottom,
    logChipClass,
    logChipLabel,
    firstHeldAtOrAfter,
    logFooterParts,
    logsCopyText,
    logsDownloadName,
    shouldStopFollowing,
    type HeldLine,
} from './logs.shared';
import { useLogFollow } from './use-log-follow';

/**
 * Logs on computers (FL-08, spec §5.1 … §5.12, FR-12 … FR-24) — one open log:
 * the last lines, then live; a filter over held and live lines; Pause that
 * counts arrivals; scrolling up more than a screen stops the view moving and
 * shows "↓ N new lines — jump to latest"; colour and a text badge on errors
 * and warnings; copy of the selection or every shown line; a footer saying in
 * prose what the view is doing and what it has received. A windowed list
 * holds at most 5 000 lines.
 */

const ROW_HEIGHT = 20;
const OVERSCAN = 20;

export function LogViewer({
    nodeId,
    nodeName,
    source,
    sources,
    listed = [],
    title = null,
    at = null,
}: {
    nodeId: string;
    nodeName: string;
    /** The source as listed (the header names it); null for a typed path not in the list, or a merged view. */
    source: FleetLogSource | null;
    /** The ids to open (one; P2 a merged set of up to 12). */
    sources: readonly string[];
    /** P2: the listed sources, to name a merged view's chips. */
    listed?: readonly FleetLogSource[];
    /** P2: a merged view's name (a Compose project). */
    title?: string | null;
    /** P3 (FR-39): open positioned at this time — the first line at or after it, highlighted. */
    at?: string | null;
}) {
    const t = useTranslations('fleet.logs');
    const { state, pause, resume, reopen, startFollowing, loadEarlier } = useLogFollow({
        nodeId,
        sources,
    });
    const merged = sources.length > 1;
    const chips = useMemo(() => sources.map((id) => logChipLabel(id, listed)), [sources, listed]);
    const [filter, setFilter] = useState('');
    const [pinned, setPinned] = useState(true);
    const [newSinceUnpinned, setNewSinceUnpinned] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(480);
    const [copied, setCopied] = useState<'selection' | 'all' | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const filterRef = useRef<HTMLInputElement | null>(null);
    const lastAppended = useRef(0);
    const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
    const positioned = useRef(at === null);
    const earlierTries = useRef(0);
    const lastFirstSeq = useRef<number | null>(null);

    const shown = useMemo(
        () => filterHeld(state.window.lines, filter),
        [state.window.lines, filter],
    );
    const label = source?.label ?? sources[0]?.replace(/^[a-z]+:/, '') ?? '';
    const kind =
        source?.kind ??
        (sources[0]?.split(':', 1)[0] as FleetLogSource['kind'] | undefined) ??
        'file';

    // Count what arrives at the bottom while the view is not there (the pill).
    useEffect(() => {
        const added = Math.max(0, state.appended - lastAppended.current);
        lastAppended.current = state.appended;
        if (!pinned && added > 0) setNewSinceUnpinned((value) => value + added);
    }, [state.appended, pinned]);

    // P2: an older page prepended — keep the lines under the reader where they were.
    useLayoutEffect(() => {
        const first = state.window.lines[0]?.seq ?? null;
        const list = listRef.current;
        if (first !== lastFirstSeq.current && state.prepended > 0 && list && !pinned) {
            list.scrollTop += state.prepended * ROW_HEIGHT;
        }
        lastFirstSeq.current = first;
    }, [state.window.lines, state.prepended, pinned]);

    // Stay at the bottom while pinned and not paused.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (!list || !pinned || state.paused) return;
        list.scrollTop = list.scrollHeight;
    }, [shown.length, pinned, state.paused]);

    useEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => setHeight(list.clientHeight || 480));
        observer.observe(list);
        return () => observer.disconnect();
    }, []);

    const onScroll = () => {
        const list = listRef.current;
        if (!list) return;
        setScrollTop(list.scrollTop);
        if (shouldStopFollowing(list.scrollTop, list.scrollHeight, list.clientHeight))
            setPinned(false);
        else if (isAtBottom(list.scrollTop, list.scrollHeight, list.clientHeight)) {
            setPinned(true);
            setNewSinceUnpinned(0);
        }
    };

    const jumpToLatest = useCallback(() => {
        const list = listRef.current;
        setPinned(true);
        setNewSinceUnpinned(0);
        if (list) list.scrollTop = list.scrollHeight;
    }, []);

    const copy = useCallback(
        async (what: 'selection' | 'all') => {
            const text =
                what === 'selection'
                    ? ((typeof window !== 'undefined' ? window.getSelection()?.toString() : '') ??
                      '')
                    : logsCopyText(shown);
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                setCopied(what);
                setTimeout(() => setCopied(null), 1500);
            } catch {
                // the browser refused the clipboard: nothing to do
            }
        },
        [shown],
    );

    // P3 (FR-39): position at `at` once the batch is in — paging back (≤ 4 pages)
    // while the oldest line held is still later than the failure.
    useLayoutEffect(() => {
        if (positioned.current || !at || !state.loaded) return;
        const lines = state.window.lines;
        const oldest = lines[0]?.line.ts ?? null;
        const pageable = !merged && (source ? source.supportsEarlier : kind === 'file');
        if (
            oldest &&
            oldest > at &&
            pageable &&
            !state.earlierExhausted &&
            !state.earlierUnsupported &&
            earlierTries.current < 4
        ) {
            if (!state.loadingEarlier) {
                earlierTries.current += 1;
                loadEarlier(0);
            }
            return;
        }
        if (state.loadingEarlier) return;
        positioned.current = true;
        const index = firstHeldAtOrAfter(shown, at);
        if (index < 0) return;
        setPinned(false);
        setHighlightSeq(shown[index]!.seq);
        const list = listRef.current;
        if (list) list.scrollTop = Math.max(0, index * ROW_HEIGHT - ROW_HEIGHT * 2);
    }, [
        at,
        state.loaded,
        state.window.lines,
        state.loadingEarlier,
        state.earlierExhausted,
        state.earlierUnsupported,
        shown,
        merged,
        source,
        kind,
        loadEarlier,
    ]);

    const download = useCallback(() => {
        // P3 (FR-40): the filtered lines on screen, already scanned on the machine; nothing is stored.
        if (typeof window === 'undefined' || shown.length === 0) return;
        const blob = new Blob([`${logsCopyText(shown)}\n`], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = logsDownloadName(
            nodeName,
            merged ? (title ?? 'merged') : (sources[0] ?? 'log'),
            new Date(),
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }, [shown, nodeName, merged, title, sources]);

    // Keyboard (spec §5.12): `/` filter · Space pause/resume · End latest · Esc clear · C copy.
    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing =
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable);
            if (event.key === '/' && !typing) {
                event.preventDefault();
                filterRef.current?.focus();
            } else if (event.key === 'Escape' && target === filterRef.current) {
                setFilter('');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === ' ') {
            event.preventDefault();
            if (state.paused) resume();
            else pause();
        } else if (event.key === 'End') {
            event.preventDefault();
            jumpToLatest();
        } else if (event.key === 'c' || event.key === 'C') {
            if (!event.metaKey && !event.ctrlKey) void copy('selection');
        }
    };

    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(shown.length, start + Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2);
    const visible = shown.slice(start, end);

    const live = state.phase === 'live' && state.following && !state.paused;
    const badge =
        state.phase === 'reconnecting'
            ? { text: t('viewer.reconnecting'), className: 'text-warning' }
            : live
              ? { text: t('viewer.live'), className: 'text-success' }
              : null;

    const footer = logFooterParts({
        phase: state.phase,
        following: state.following && pinned,
        paused: state.paused,
        pausedCount: state.pausedCount,
        held: state.window.lines.length,
        shown: shown.length,
        filter,
        bytes: state.bytes,
        redactions: state.redactions,
        dropped: state.dropped,
        discarded: state.window.discarded,
    });

    const errorBody = state.error ? (
        <div
            role="alert"
            className="p-4 space-y-2"
            data-testid="fleet-logs-error"
            data-code={state.error.code}
        >
            <p className="text-sm font-medium text-danger">
                {state.error.details?.abandoned
                    ? t('states.loadingAbandoned', { node: nodeName })
                    : t('states.error', { source: label, node: nodeName })}
            </p>
            {state.error.hint && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark font-mono">
                    {state.error.hint}
                </p>
            )}
            <Button size="sm" variant="secondary" onClick={reopen} data-testid="fleet-logs-retry">
                <RotateCw className="w-3 h-3 mr-1" aria-hidden="true" />
                {t('states.tryAgain')}
            </Button>
        </div>
    ) : null;

    return (
        <section
            className="flex flex-col min-w-0 rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark"
            aria-label={t('a11y.region', { source: label })}
            data-testid="fleet-logs-viewer"
        >
            <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border dark:border-border-dark">
                <h3
                    className="text-sm font-medium text-text dark:text-text-dark truncate"
                    data-testid="fleet-logs-viewer-title"
                >
                    {merged
                        ? title
                            ? t('viewer.mergedTitle', {
                                  title,
                                  count: sources.length,
                                  node: nodeName,
                              })
                            : t('viewer.mergedTitleNoName', {
                                  count: sources.length,
                                  node: nodeName,
                              })
                        : t('viewer.title', {
                              source: label,
                              kind: t(`kinds.${kind}`),
                              node: nodeName,
                          })}
                </h3>
                {badge && (
                    <span
                        className={`text-xs font-semibold shrink-0 ${badge.className}`}
                        data-testid="fleet-logs-badge"
                    >
                        {badge.text}
                    </span>
                )}
            </header>

            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border dark:border-border-dark">
                <input
                    ref={filterRef}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('viewer.filterPlaceholder')}
                    aria-label={t('viewer.filterPlaceholder')}
                    className="flex-1 min-w-[10rem] rounded border border-border dark:border-border-dark bg-transparent px-2 py-1 text-xs"
                    data-testid="fleet-logs-filter"
                />
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={state.paused ? resume : pause}
                    disabled={!state.loaded}
                    data-testid="fleet-logs-pause"
                >
                    {state.paused ? (
                        <Play className="w-3 h-3 mr-1" aria-hidden="true" />
                    ) : (
                        <Pause className="w-3 h-3 mr-1" aria-hidden="true" />
                    )}
                    {state.paused ? t('viewer.resume') : t('viewer.pause')}
                </Button>
                {!state.following && state.loaded && state.phase === 'live' && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={startFollowing}
                        data-testid="fleet-logs-follow"
                    >
                        {t('viewer.follow')}
                    </Button>
                )}
                {!merged && state.loaded && (
                    <EarlierControl
                        supported={source ? source.supportsEarlier : kind === 'file'}
                        container={kind === 'container'}
                        loading={state.loadingEarlier}
                        exhausted={state.earlierExhausted}
                        unsupported={state.earlierUnsupported}
                        onLoad={() => loadEarlier(0)}
                    />
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy('selection')}
                    data-testid="fleet-logs-copy-selection"
                >
                    <Copy className="w-3 h-3 mr-1" aria-hidden="true" />
                    {copied === 'selection' ? t('viewer.copied') : t('viewer.copySelection')}
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy('all')}
                    data-testid="fleet-logs-copy-all"
                >
                    {copied === 'all' ? t('viewer.copied') : t('viewer.copyAllShown')}
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={download}
                    disabled={shown.length === 0}
                    data-testid="fleet-logs-download"
                >
                    <Download className="w-3 h-3 mr-1" aria-hidden="true" />
                    {t('viewer.download')}
                </Button>
            </div>

            {state.groupHint && (
                <div
                    className="px-3 py-2 border-b border-border dark:border-border-dark space-y-1"
                    data-testid="fleet-logs-group-notice"
                >
                    <p className="text-xs text-text dark:text-text-dark">
                        {t('notices.groupMembership', { node: nodeName })}
                    </p>
                    <CopyCommand command={state.groupHint} testId="fleet-logs-group-command" />
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('notices.groupMembershipAfter')}
                    </p>
                </div>
            )}

            {errorBody ?? (
                <div className="relative">
                    {!state.loaded && (
                        <p
                            className="p-4 text-xs text-text-muted dark:text-text-muted-dark"
                            role="status"
                            data-testid="fleet-logs-loading"
                        >
                            {state.slow
                                ? t('states.loadingSlow', { node: nodeName })
                                : t('states.loading', { node: nodeName })}
                        </p>
                    )}
                    <div
                        ref={listRef}
                        role="log"
                        aria-live="polite"
                        aria-label={
                            state.paused
                                ? t('a11y.paused', { count: state.pausedCount })
                                : t('a11y.following')
                        }
                        tabIndex={0}
                        onScroll={onScroll}
                        onKeyDown={onListKey}
                        className="h-[60vh] min-h-[16rem] overflow-auto font-mono text-xs focus:outline-none"
                        data-testid="fleet-logs-lines"
                    >
                        <div style={{ height: shown.length * ROW_HEIGHT, position: 'relative' }}>
                            {visible.map((held: HeldLine, index: number) => (
                                <LogRow
                                    key={held.seq}
                                    held={held}
                                    top={(start + index) * ROW_HEIGHT}
                                    chip={merged ? (chips[held.line.src] ?? '?') : null}
                                    highlight={held.seq === highlightSeq}
                                />
                            ))}
                        </div>
                    </div>
                    {!pinned && newSinceUnpinned > 0 && (
                        <button
                            type="button"
                            onClick={jumpToLatest}
                            className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-primary text-white px-3 py-1 text-xs shadow"
                            data-testid="fleet-logs-jump"
                        >
                            <ArrowDown className="w-3 h-3" aria-hidden="true" />
                            {t('viewer.jumpToLatest', { count: newSinceUnpinned })}
                        </button>
                    )}
                </div>
            )}

            {state.stopReason && state.stopReason !== 'not-following' && (
                <div
                    className="px-3 py-2 border-t border-border dark:border-border-dark flex items-center gap-2"
                    role="status"
                    data-testid="fleet-logs-stopped"
                    data-reason={state.stopReason}
                >
                    <p className="text-xs text-text dark:text-text-dark">
                        {state.stopReason === 'kill-switch'
                            ? t('states.killSwitch')
                            : state.stopReason === 'lost'
                              ? t('states.lost')
                              : state.stopReason === 'gone'
                                ? (state.stopHint ?? t('notices.gone', { source: label }))
                                : (state.stopHint ?? t('notices.stopped', { source: label }))}
                    </p>
                    {state.stopReason === 'lost' && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={reopen}
                            data-testid="fleet-logs-reopen"
                        >
                            {t('viewer.reopen')}
                        </Button>
                    )}
                </div>
            )}

            {merged && !state.stopReason && state.stopHint && (
                <p
                    className="px-3 py-1.5 border-t border-border dark:border-border-dark text-xs text-text-muted dark:text-text-muted-dark"
                    role="status"
                    data-testid="fleet-logs-merged-notice"
                >
                    {state.stopHint}
                </p>
            )}

            <footer
                className="px-3 py-1.5 border-t border-border dark:border-border-dark text-[11px] text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-logs-footer"
            >
                {footer
                    .map((part) => t(`viewer.${part.key}` as Parameters<typeof t>[0], part.values))
                    .join(' · ')}
            </footer>
        </section>
    );
}

/** P2 (FR-37): "Load 500 earlier", or why a source cannot page back. */
function EarlierControl({
    supported,
    container,
    loading,
    exhausted,
    unsupported,
    onLoad,
}: {
    supported: boolean;
    container: boolean;
    loading: boolean;
    exhausted: boolean;
    unsupported: boolean;
    onLoad(): void;
}) {
    const t = useTranslations('fleet.logs');
    if (!supported || unsupported) {
        return (
            <span
                className="text-[11px] text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-logs-no-earlier"
            >
                {container ? t('viewer.noEarlierContainer') : t('viewer.noEarlier')}
            </span>
        );
    }
    if (exhausted) {
        return (
            <span
                className="text-[11px] text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-logs-no-earlier"
            >
                {t('viewer.noEarlier')}
            </span>
        );
    }
    return (
        <Button
            size="sm"
            variant="ghost"
            onClick={onLoad}
            disabled={loading}
            data-testid="fleet-logs-load-earlier"
        >
            <ArrowUpToLine className="w-3 h-3 mr-1" aria-hidden="true" />
            {loading ? t('viewer.loadingEarlier') : t('viewer.loadEarlier')}
        </Button>
    );
}

function LogRow({
    held,
    top,
    chip,
    highlight,
}: {
    held: HeldLine;
    top: number;
    chip: string | null;
    highlight: boolean;
}) {
    const t = useTranslations('fleet.logs');
    const { line } = held;
    const tone =
        line.level === 'error'
            ? 'text-danger'
            : line.level === 'warning'
              ? 'text-warning'
              : 'text-text dark:text-text-dark';
    return (
        <div
            className={`absolute left-0 right-0 flex gap-3 px-3 whitespace-pre ${tone} ${
                highlight ? 'bg-warning/15 ring-1 ring-warning/40' : ''
            }`}
            style={{ top, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
            data-level={line.level}
            data-highlight={highlight ? 'true' : undefined}
        >
            <span className="shrink-0 text-text-muted dark:text-text-muted-dark select-none w-16">
                {formatLogTime(line.ts)}
            </span>
            {chip !== null && (
                <span
                    className={`shrink-0 rounded px-1.5 select-none max-w-[8rem] truncate ${logChipClass(line.src)}`}
                    title={chip}
                    data-testid="fleet-logs-chip"
                >
                    {chip}
                </span>
            )}
            <span className="flex-1">{line.text}</span>
            {line.level !== 'info' && (
                <span className="shrink-0 font-semibold select-none">
                    {line.level === 'error' ? t('viewer.levelError') : t('viewer.levelWarning')}
                </span>
            )}
        </div>
    );
}
