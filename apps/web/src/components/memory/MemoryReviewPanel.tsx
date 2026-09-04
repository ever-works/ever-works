'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { browserApiFetch } from '@/lib/api/browser-api';

/**
 * The Memory review queue.
 *
 * Memory Consolidation merges near-duplicate documents with an LLM and
 * lands the result as `reviewState: 'proposed'` — deliberately NOT
 * accepted, because an unreviewed machine merge must not teach every
 * agent in the organization. Those documents existed and were withheld,
 * but there was nowhere to see or act on them, so the queue silently
 * accumulated.
 *
 * Both verbs are here now. Reject ARCHIVES the document rather than
 * deleting it — consolidation never deletes anything, and neither does
 * this — so the row leaves the queue and stops being eligible for any
 * context, while the text itself stays readable. Nothing on this page is
 * irreversible.
 *
 * Every call here goes through `browserApiFetch`, never a raw `fetch()`.
 * The BFF routes behind `/api/memory/review` derive the Organization
 * solely from the per-tab `x-ever-workspace` selector that helper stamps
 * from the visible URL (EW-786); a plain `fetch()` sends no selector, and
 * the queue then read as permanently empty while both verbs would refuse.
 */

type ReviewAction = 'accept' | 'reject';

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
    // Which row is mid-flight, and doing what. Tracking the action too
    // (not just the id) is what lets only the clicked button spin while
    // both stay disabled — a single `pendingId` would spin both.
    const [pending, setPending] = useState<{ id: string; action: ReviewAction } | null>(null);
    // Ids whose action failed, and which action it was. Without this the
    // button simply stops spinning and the row stays put, which is
    // indistinguishable from "nothing happened" — the user cannot tell a
    // refusal from a no-op. The action is recorded so the message names
    // the verb that actually failed.
    const [failed, setFailed] = useState<Map<string, ReviewAction>>(new Map());

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await browserApiFetch('/api/memory/review?limit=50', {
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

    /**
     * Both verbs are the same transaction shape — POST, then drop the row
     * — so they share one handler. Accept and reject each remove the
     * document from the queue on success (accept moves `reviewState`,
     * reject archives it), and both leave the row in place with a named
     * error on failure so a refusal never reads as a no-op.
     */
    const act = useCallback(async (docId: string, action: ReviewAction) => {
        setPending({ id: docId, action });
        setFailed((prev) => {
            if (!prev.has(docId)) return prev;
            const next = new Map(prev);
            next.delete(docId);
            return next;
        });
        try {
            const res = await browserApiFetch(`/api/memory/review/${docId}/${action}`, {
                method: 'POST',
            });
            if (res.ok) {
                // Drop it locally rather than refetching: the row is
                // gone from the queue by definition once acted on, and
                // a refetch would make the whole list flicker.
                setItems((prev) => prev.filter((d) => d.id !== docId));
                return;
            }
            setFailed((prev) => new Map(prev).set(docId, action));
        } catch {
            // Leave the row in place and say so; the user can retry.
            setFailed((prev) => new Map(prev).set(docId, action));
        } finally {
            setPending(null);
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
                            <p
                                className={cn(
                                    'truncate text-xs',
                                    failed.has(doc.id)
                                        ? 'text-danger'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                                data-testid={failed.has(doc.id) ? 'memory-review-error' : undefined}
                            >
                                {failed.has(doc.id)
                                    ? failed.get(doc.id) === 'reject'
                                        ? t('rejectFailed')
                                        : t('acceptFailed')
                                    : doc.description || doc.path}
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                data-testid="memory-review-accept"
                                // Disabled while EITHER verb is in flight
                                // on this row: the two are mutually
                                // exclusive outcomes and letting both fire
                                // would race two writes at one document.
                                disabled={pending?.id === doc.id}
                                onClick={() => void act(doc.id, 'accept')}
                                className={cn(
                                    'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                                    'border-primary/40 text-primary hover:bg-primary/10',
                                    'disabled:cursor-not-allowed disabled:opacity-40',
                                )}
                            >
                                {pending?.id === doc.id && pending.action === 'accept' ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Check className="w-3.5 h-3.5" />
                                )}
                                {t('accept')}
                            </button>
                            <button
                                type="button"
                                data-testid="memory-review-reject"
                                disabled={pending?.id === doc.id}
                                onClick={() => void act(doc.id, 'reject')}
                                // Muted, not destructive-red: rejecting
                                // archives and is reversible, so styling it
                                // like a delete would overstate it.
                                title={t('rejectHint')}
                                className={cn(
                                    'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                                    'border-card-border text-text-muted hover:bg-card-border/30',
                                    'dark:border-white/9 dark:text-text-muted-dark dark:hover:bg-white/5',
                                    'disabled:cursor-not-allowed disabled:opacity-40',
                                )}
                            >
                                {pending?.id === doc.id && pending.action === 'reject' ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <X className="w-3.5 h-3.5" />
                                )}
                                {t('reject')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
