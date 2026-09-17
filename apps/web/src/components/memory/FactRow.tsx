'use client';

import { forwardRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Pin, PinOff, RotateCcw, Trash2, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { MemoryFactDto } from '@/lib/api/memory-facts-types';
import { FactComposer, type FactComposerResult } from './FactComposer';

export interface FactRowActions {
    onEdit: (fact: MemoryFactDto, body: string) => Promise<FactComposerResult>;
    onTogglePin: (fact: MemoryFactDto) => void;
    onForget: (fact: MemoryFactDto) => void;
    onRestore: (fact: MemoryFactDto) => void;
    onAccept: (fact: MemoryFactDto) => void;
    onDiscard: (fact: MemoryFactDto) => void;
}

interface FactRowProps extends FactRowActions {
    fact: MemoryFactDto;
    /** A row action is in flight — every button on the row is disabled. */
    busy?: boolean;
    /** Move keyboard focus to the previous / next row. */
    onMoveFocus?: (direction: -1 | 1) => void;
}

const ORIGIN_KEYS = {
    user: 'originYou',
    agent: 'originAgent',
    consolidation: 'originTidyUp',
    import: 'originImport',
} as const;

/** "3 days ago", in the viewer's locale. Server and client may disagree by a tick. */
function relative(iso: string, now = Date.now()): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.round((then - now) / 1000);
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 365 * 24 * 3600],
        ['month', 30 * 24 * 3600],
        ['week', 7 * 24 * 3600],
        ['day', 24 * 3600],
        ['hour', 3600],
        ['minute', 60],
    ];
    for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, 'second');
}

function shortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One memory fact (AW-07).
 *
 * Shows the text, where it came from and how old it is, the relevance bar
 * when the list is a meaning-based search, and the actions that make sense
 * for the fact's status: Edit / Pin / Forget for a live fact, Accept /
 * Discard for a proposal, Restore for a forgotten one.
 *
 * The relevance bar is never colour alone: its width, the number beside it
 * and the "contains your words" label all carry the same information.
 *
 * Keyboard, while the row has focus: `Enter` or `E` edits, `F` forgets,
 * `P` pins or unpins, `↑` / `↓` move between rows.
 */
export const FactRow = forwardRef<HTMLDivElement, FactRowProps>(function FactRow(
    { fact, busy = false, onMoveFocus, ...actions },
    ref,
) {
    const t = useTranslations('dashboard.memoryPage.facts');
    const [editing, setEditing] = useState(false);
    const [copied, setCopied] = useState(false);

    const isLive = fact.status === 'active';
    const isProposed = fact.status === 'proposed';
    const isForgotten = fact.status === 'forgotten';

    const copy = async () => {
        try {
            await navigator.clipboard?.writeText(fact.body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard can be unavailable (permissions, insecure context);
            // the text is still selectable on the row.
        }
    };

    if (editing) {
        return (
            <div
                ref={ref}
                data-testid={`fact-row-${fact.id}`}
                className="rounded-lg border p-3 bg-card dark:bg-card-primary-dark border-primary/40"
            >
                <FactComposer
                    testId={`fact-edit-${fact.id}`}
                    initialBody={fact.body}
                    onCancel={() => setEditing(false)}
                    onSubmit={async (body) => {
                        const result = await actions.onEdit(fact, body);
                        if (result.ok) setEditing(false);
                        return result;
                    }}
                />
            </div>
        );
    }

    const iconButton = cn(
        'inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
        'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
        'hover:bg-surface-secondary dark:hover:bg-white/5',
        'disabled:opacity-50 disabled:cursor-not-allowed',
    );

    return (
        <div
            ref={ref}
            tabIndex={0}
            data-testid={`fact-row-${fact.id}`}
            data-status={fact.status}
            aria-busy={busy || undefined}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget || busy) return;
                const key = event.key.toLowerCase();
                if (event.metaKey || event.ctrlKey || event.altKey) return;
                if (key === 'arrowdown' || key === 'arrowup') {
                    event.preventDefault();
                    onMoveFocus?.(key === 'arrowdown' ? 1 : -1);
                } else if ((key === 'enter' || key === 'e') && !isForgotten) {
                    event.preventDefault();
                    setEditing(true);
                } else if (key === 'f' && !isForgotten) {
                    event.preventDefault();
                    if (isProposed) actions.onDiscard(fact);
                    else actions.onForget(fact);
                } else if (key === 'p' && isLive) {
                    event.preventDefault();
                    actions.onTogglePin(fact);
                }
            }}
            className={cn(
                'group flex items-start gap-3 rounded-lg border p-3 transition-colors outline-none',
                'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                'hover:border-border-secondary dark:hover:border-white/20',
                'focus-visible:ring-2 focus-visible:ring-primary/50',
                isForgotten && 'opacity-70',
            )}
        >
            <span
                aria-hidden
                className={cn(
                    'mt-1 w-1 self-stretch rounded-full shrink-0',
                    fact.pinned ? 'bg-primary' : 'bg-surface-secondary dark:bg-white/10',
                )}
            />
            <div className="min-w-0 flex-1">
                <p
                    data-testid={`fact-body-${fact.id}`}
                    className={cn(
                        'text-sm text-text dark:text-text-dark whitespace-pre-wrap break-words',
                        isForgotten && 'line-through',
                    )}
                >
                    {fact.body}
                </p>

                {fact.score !== null && (
                    <div
                        className="mt-1.5 flex items-center gap-2"
                        data-testid={`fact-relevance-${fact.id}`}
                    >
                        <span
                            aria-hidden
                            className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-secondary dark:bg-white/10"
                        >
                            <span
                                className="block h-full rounded-full bg-primary"
                                style={{
                                    width: `${Math.round(Math.max(0, Math.min(1, fact.score)) * 100)}%`,
                                }}
                            />
                        </span>
                        <span className="text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
                            {t('relevance', { score: fact.score.toFixed(2) })}
                        </span>
                    </div>
                )}

                <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs text-text-muted dark:text-text-muted-dark">
                    {fact.pinned && (
                        <span className="inline-flex items-center gap-1 font-medium text-primary dark:text-white">
                            <Pin className="w-3 h-3" strokeWidth={1.5} aria-hidden />
                            {t('pinned')}
                        </span>
                    )}
                    {isProposed && (
                        <span className="inline-flex items-center rounded border border-card-border dark:border-white/9 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                            {t('proposedBadge')}
                        </span>
                    )}
                    <span>{t(ORIGIN_KEYS[fact.origin] ?? 'originYou')}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={fact.createdAt} suppressHydrationWarning>
                        {relative(fact.createdAt)}
                    </time>
                    {fact.recallCount > 0 && (
                        <>
                            <span aria-hidden>·</span>
                            <span>{t('usedInRuns', { count: fact.recallCount })}</span>
                        </>
                    )}
                    {fact.literalMatch && fact.score === null && (
                        <>
                            <span aria-hidden>·</span>
                            <span>{t('literalMatch')}</span>
                        </>
                    )}
                    {isForgotten && fact.restorableUntil && (
                        <>
                            <span aria-hidden>·</span>
                            <span suppressHydrationWarning>
                                {t('restorableUntil', { date: shortDate(fact.restorableUntil) })}
                            </span>
                        </>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0 flex-wrap justify-end">
                {isLive && (
                    <>
                        <button
                            type="button"
                            className={iconButton}
                            data-testid={`fact-edit-button-${fact.id}`}
                            onClick={() => setEditing(true)}
                            disabled={busy}
                        >
                            <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            {t('edit')}
                        </button>
                        <button
                            type="button"
                            className={iconButton}
                            data-testid={`fact-pin-button-${fact.id}`}
                            aria-pressed={fact.pinned}
                            onClick={() => actions.onTogglePin(fact)}
                            disabled={busy}
                        >
                            {fact.pinned ? (
                                <PinOff className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            ) : (
                                <Pin className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            )}
                            {fact.pinned ? t('unpin') : t('pin')}
                        </button>
                        <button
                            type="button"
                            className={iconButton}
                            data-testid={`fact-forget-button-${fact.id}`}
                            onClick={() => actions.onForget(fact)}
                            disabled={busy}
                        >
                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            {t('forget')}
                        </button>
                    </>
                )}
                {isProposed && (
                    <>
                        <button
                            type="button"
                            className={iconButton}
                            data-testid={`fact-accept-button-${fact.id}`}
                            onClick={() => actions.onAccept(fact)}
                            disabled={busy}
                        >
                            <Check className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            {t('accept')}
                        </button>
                        <button
                            type="button"
                            className={iconButton}
                            data-testid={`fact-discard-button-${fact.id}`}
                            onClick={() => actions.onDiscard(fact)}
                            disabled={busy}
                        >
                            <X className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                            {t('discard')}
                        </button>
                    </>
                )}
                {isForgotten && (
                    <button
                        type="button"
                        className={iconButton}
                        data-testid={`fact-restore-button-${fact.id}`}
                        onClick={() => actions.onRestore(fact)}
                        disabled={busy}
                    >
                        <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                        {t('restore')}
                    </button>
                )}
                <button
                    type="button"
                    className={iconButton}
                    data-testid={`fact-copy-button-${fact.id}`}
                    onClick={() => void copy()}
                    aria-label={t('copyText')}
                    title={t('copyText')}
                >
                    {copied ? (
                        <Check className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                    ) : (
                        <Copy className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
                    )}
                </button>
            </div>
        </div>
    );
});
