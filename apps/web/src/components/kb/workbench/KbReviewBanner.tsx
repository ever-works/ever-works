'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Archive, Check, Loader2, ShieldQuestion } from 'lucide-react';
import type { KbDocumentDto } from '@ever-works/contracts';
import { acceptKbDocumentAction, archiveKbDocumentAction } from '@/app/actions/works/kb-review';

/**
 * Memory upgrades M8 — the "edit then accept" half of the review queue.
 *
 * The queue's **Edit & accept** action links to this document in the
 * existing workbench editor; this banner is what makes that flow
 * complete. It renders only while the document is still `proposed`, so
 * the operator can fix the wording first and then accept in place — no
 * second editor, no duplicated save logic.
 *
 * It also does double duty as a standing signal: any `proposed` document
 * opened from the tree now says out loud that it is NOT feeding agent
 * context yet, which was previously invisible everywhere in the UI.
 */

export interface KbReviewBannerProps {
    readonly workId: string;
    readonly document: Pick<KbDocumentDto, 'id' | 'path' | 'reviewState'>;
}

export function KbReviewBanner({ workId, document: doc }: KbReviewBannerProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const router = useRouter();
    const [resolved, setResolved] = useState(false);
    const [busy, setBusy] = useState<'accept' | 'archive' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const act = useCallback(
        (kind: 'accept' | 'archive') => {
            setBusy(kind);
            setError(null);
            void (async () => {
                const args = { workId, docId: doc.id, path: doc.path };
                const result =
                    kind === 'accept'
                        ? await acceptKbDocumentAction(args)
                        : await archiveKbDocumentAction(args);
                if (result.success) {
                    setResolved(true);
                    try {
                        router.refresh();
                    } catch {
                        /* the unit specs stub useRouter */
                    }
                    return;
                }
                setError(result.error ?? 'Action failed');
                setBusy(null);
            })();
        },
        [workId, doc.id, doc.path, router],
    );

    // Additive by construction: `null` / `accepted` renders nothing, so
    // dropping the banner into the document page changes nothing for the
    // overwhelming majority of documents.
    if (doc.reviewState !== 'proposed' || resolved) return null;

    return (
        <div
            data-testid="kb-review-banner"
            role="status"
            className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200"
        >
            <ShieldQuestion className="h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">{t('review.bannerMessage')}</p>
            <button
                type="button"
                data-testid="kb-review-banner-accept"
                disabled={busy !== null}
                onClick={() => act('accept')}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 font-medium disabled:opacity-50 hover:bg-amber-500/20"
            >
                {busy === 'accept' ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                    <Check className="h-3 w-3" aria-hidden="true" />
                )}
                {t('review.accept')}
            </button>
            <button
                type="button"
                data-testid="kb-review-banner-archive"
                disabled={busy !== null}
                onClick={() => act('archive')}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 font-medium disabled:opacity-50 hover:bg-amber-500/20"
            >
                {busy === 'archive' ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                    <Archive className="h-3 w-3" aria-hidden="true" />
                )}
                {t('review.archive')}
            </button>
            {error ? (
                <p role="alert" data-testid="kb-review-banner-error" className="w-full text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
