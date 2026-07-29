'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * The Memory review queue.
 *
 * Memory Consolidation merges near-duplicate documents with an LLM and
 * lands the result as `reviewState: 'proposed'` — deliberately NOT
 * accepted, because an unreviewed machine merge must not teach every
 * agent in the organization. Those documents existed and were withheld,
 * but there was nowhere to see or accept them, so the queue silently
 * accumulated.
 *
 * Accept is the only action here on purpose. Rejecting needs its own
 * semantics — archive? delete? supersede back to the originals? — and
 * consolidation never deletes anything, so guessing at that would be the
 * one irreversible verb on this page.
 */

interface ReviewDocument {
    readonly id: string;
    readonly title: string;
    readonly path: string;
    readonly description?: string | null;
    readonly class?: string;
    readonly updatedAt?: string;
}

export function MemoryReviewPanel() {
    const t = useTranslations('dashboard.memoryPage.review');
    const [items, setItems] = useState<ReviewDocument[]>([]);
    const [loading, setLoading] = useState(true);
    const [accepting, setAccepting] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/memory/review?limit=50', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            if (!res.ok) {
                setItems([]);
                return;
            }
            const body = (await res.json()) as { items?: ReviewDocument[] };
            setItems(body.items ?? []);
        } catch {
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const accept = useCallback(async (docId: string) => {
        setAccepting(docId);
        try {
            const res = await fetch(`/api/memory/review/${docId}/accept`, { method: 'POST' });
            if (res.ok) {
                // Drop it locally rather than refetching: the row is
                // gone from the queue by definition once accepted, and
                // a refetch would make the whole list flicker.
                setItems((prev) => prev.filter((d) => d.id !== docId));
            }
        } catch {
            // Leave the row in place; the user can retry.
        } finally {
            setAccepting(null);
        }
    }, []);

    // An empty review queue is the normal, healthy state — showing a
    // permanent empty panel would be noise on every visit.
    if (!loading && items.length === 0) return null;

    return (
        <div
            data-testid="memory-review-panel"
            className={cn(
                'flex flex-col gap-3 rounded-lg border p-4',
                'bg-card dark:bg-card-primary-dark',
                'border-primary/40',
            )}
        >
            <div className="flex items-center gap-2">
                <ShieldQuestion className="w-4 h-4 text-primary shrink-0" strokeWidth={1.5} />
                <span className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title', { count: items.length })}
                </span>
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>

            <ul className="flex flex-col divide-y divide-card-border dark:divide-white/9">
                {items.map((doc) => (
                    <li
                        key={doc.id}
                        data-testid="memory-review-row"
                        className="flex items-center justify-between gap-3 py-2"
                    >
                        <div className="min-w-0">
                            <p className="truncate text-sm text-text dark:text-text-dark">
                                {doc.title}
                            </p>
                            <p className="truncate text-xs text-text-muted dark:text-text-muted-dark">
                                {doc.description || doc.path}
                            </p>
                        </div>
                        <button
                            type="button"
                            data-testid="memory-review-accept"
                            disabled={accepting === doc.id}
                            onClick={() => void accept(doc.id)}
                            className={cn(
                                'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                                'border-primary/40 text-primary hover:bg-primary/10',
                                'disabled:cursor-not-allowed disabled:opacity-40',
                            )}
                        >
                            {accepting === doc.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <Check className="w-3.5 h-3.5" />
                            )}
                            {t('accept')}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
