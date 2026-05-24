'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { deleteKbDocumentAction } from '@/app/actions/works/kb-document';
import { KbDeleteConfirmDialog } from './KbDeleteConfirmDialog';

interface KbTreeClassDeleteButtonProps {
    workId: string;
    /** Localized class label (already resolved by the parent). */
    classLabel: string;
    /** All Work-owned docs in this class. */
    docs: Array<{ id: string; path: string }>;
}

/**
 * EW-641 KB workbench follow-up — bulk-delete every doc in a class.
 *
 * Rendered next to the per-class section header in the KB tree.
 * Clicking the trash opens the confirm dialog with a count + class
 * label; confirming fires `deleteKbDocumentAction` for every doc in
 * the group in parallel via `Promise.all` and surfaces a partial-
 * failure count if any rows didn't delete (e.g. a row got locked
 * between fetch + delete).
 *
 * The button is hidden until the parent group is hovered (mirrors the
 * per-row trash UX) so the row chrome stays calm in the resting state.
 */
export function KbTreeClassDeleteButton({
    workId,
    classLabel,
    docs,
}: KbTreeClassDeleteButtonProps) {
    const t = useTranslations('dashboard.workDetail.kb.delete');
    const router = useRouter();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const onDelete = useCallback(() => {
        setError(null);
        startTransition(async () => {
            const results = await Promise.all(
                docs.map((doc) =>
                    deleteKbDocumentAction({
                        workId,
                        docId: doc.id,
                        path: doc.path,
                    }),
                ),
            );
            const failures = results.filter((r) => !r.success).length;
            const successes = results.length - failures;
            if (failures === 0) {
                setConfirmOpen(false);
                router.refresh();
            } else if (successes === 0) {
                setError(t('errorFallback'));
            } else {
                // Partial failure — surface the breakdown so the user
                // knows how much survived; refresh anyway so the rows
                // that did delete disappear from the tree.
                setError(t('errorPartial', { ok: successes, failed: failures }));
                router.refresh();
            }
        });
    }, [docs, router, t, workId]);

    if (docs.length === 0) return null;

    return (
        <>
            <button
                type="button"
                data-testid="kb-tree-delete-class"
                data-class-label={classLabel}
                aria-label={t('classTooltip', { class: classLabel })}
                title={t('classTooltip', { class: classLabel })}
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmOpen(true);
                }}
                className={cn(
                    'flex h-5 w-5 items-center justify-center rounded',
                    'text-text-muted dark:text-text-muted-dark/70',
                    'hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400',
                    confirmOpen
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                    'transition-opacity',
                )}
            >
                <TrashIcon className="h-3 w-3" />
            </button>
            {confirmOpen ? (
                <KbDeleteConfirmDialog
                    title={t('classConfirmTitle', { count: docs.length, class: classLabel })}
                    body={t('classConfirmBody')}
                    busy={pending}
                    error={error}
                    onConfirm={onDelete}
                    onCancel={() => {
                        if (pending) return;
                        setConfirmOpen(false);
                        setError(null);
                    }}
                />
            ) : null}
        </>
    );
}

function TrashIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={className}
        >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
    );
}
