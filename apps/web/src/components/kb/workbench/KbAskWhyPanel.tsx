'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';
import type { KbRetrievalTrail } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * "Ask why" (memory upgrades M11) — the deterministic retrieval trail
 * for one document.
 *
 * Answers "what made this a decision the agents keep seeing?" with
 * recorded facts only: the questions that retrieved it, when, how many
 * documents came back alongside it, and how often it was cited
 * afterwards. **No LLM anywhere in this path** — an explanation that
 * can hallucinate is worse than no explanation, because it is the one
 * surface a reader will trust unconditionally.
 *
 * Collapsed by default and fetched only on expand: the trail is a
 * diagnostic, not part of reading the document, so it must cost nothing
 * for the readers who never ask.
 */

export interface KbAskWhyPanelProps {
    workId: string;
    documentId: string;
    /** Injected in tests; production fetches on first expand. */
    initialTrail?: KbRetrievalTrail | null;
    /** Start expanded (tests, deep links). */
    defaultOpen?: boolean;
    className?: string;
}

export function KbAskWhyPanel({
    workId,
    documentId,
    initialTrail,
    defaultOpen,
    className,
}: KbAskWhyPanelProps) {
    const t = useTranslations('dashboard.workDetail.kb.askWhy');
    const [open, setOpen] = useState(defaultOpen ?? false);
    const [trail, setTrail] = useState<KbRetrievalTrail | null>(initialTrail ?? null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (trail) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/works/${encodeURIComponent(workId)}/kb/documents/${encodeURIComponent(
                    documentId,
                )}/retrieval-trail`,
                { cache: 'no-store' },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setTrail((await res.json()) as KbRetrievalTrail);
        } catch {
            setError(t('error'));
        } finally {
            setLoading(false);
        }
    }, [trail, workId, documentId, t]);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    const Chevron = open ? ChevronDown : ChevronRight;

    return (
        <div
            data-testid="kb-ask-why"
            className={cn('rounded-md border border-border dark:border-border-dark', className)}
        >
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                aria-expanded={open}
                data-testid="kb-ask-why-toggle"
                className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs font-medium',
                    'text-text-secondary transition-colors hover:bg-card-hover',
                    'dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
                )}
            >
                <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
                <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('trigger')}</span>
            </button>

            {open ? (
                <div className="border-t border-border px-3 py-2 dark:border-border-dark">
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark/70">
                        {t('subtitle')}
                    </p>

                    {loading ? (
                        <p
                            data-testid="kb-ask-why-loading"
                            className="mt-2 text-xs text-text-muted dark:text-text-muted-dark/60"
                        >
                            {t('loading')}
                        </p>
                    ) : null}

                    {error ? (
                        <p
                            data-testid="kb-ask-why-error"
                            className="mt-2 text-xs text-red-600 dark:text-red-400"
                        >
                            {error}
                        </p>
                    ) : null}

                    {!loading && !error && trail ? (
                        trail.entries.length === 0 ? (
                            <p
                                data-testid="kb-ask-why-empty"
                                className="mt-2 text-xs text-text-muted dark:text-text-muted-dark/60"
                            >
                                {t('empty', { days: trail.windowDays })}
                            </p>
                        ) : (
                            <>
                                <ul className="mt-2 flex flex-col gap-1.5">
                                    {trail.entries.map((entry, index) => (
                                        <li
                                            key={`${entry.at}-${index}`}
                                            data-testid="kb-ask-why-entry"
                                            className="flex flex-col gap-0.5 border-l-2 border-border pl-2 dark:border-border-dark"
                                        >
                                            <span className="text-xs text-text dark:text-text-dark">
                                                {entry.query ?? t('alwaysInjected')}
                                            </span>
                                            <span className="text-[11px] text-text-muted dark:text-text-muted-dark/60">
                                                {new Date(entry.at).toLocaleString()} ·{' '}
                                                {t('resultCount', { count: entry.resultCount })}
                                                {entry.consumerKind
                                                    ? ` · ${entry.consumerKind}`
                                                    : ''}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                                <p
                                    data-testid="kb-ask-why-summary"
                                    className="mt-2 text-[11px] text-text-muted dark:text-text-muted-dark/60"
                                >
                                    {t('total', {
                                        count: trail.totalRetrievals,
                                        days: trail.windowDays,
                                    })}{' '}
                                    · {t('citations', { count: trail.citations })}
                                </p>
                            </>
                        )
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
