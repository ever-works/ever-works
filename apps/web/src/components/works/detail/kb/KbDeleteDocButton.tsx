'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { deleteKbDocumentAction } from '@/app/actions/works/kb-document';
import { KbDeleteConfirmDialog } from './KbDeleteConfirmDialog';

interface KbDeleteDocButtonProps {
    workId: string;
    docId: string;
    path: string;
    title: string | null;
}

/**
 * EW-641 KB workbench follow-up — detail-page "Delete document"
 * affordance.
 *
 * Rendered next to the lock controls inside `KbSidePanel`. Same trash
 * iconography + confirm dialog as the tree row's per-doc delete, but
 * sized as a labeled button (not an icon-only hover affordance) since
 * it lives in a section that's always visible. After a successful
 * delete the user lands back on the KB index (`ROUTES.DASHBOARD_WORK_KB`)
 * because the detail page they were viewing no longer exists.
 *
 * `useRouter` comes from `@/i18n/navigation` so the post-delete
 * `router.push` keeps the active locale prefix on the index route.
 */
export function KbDeleteDocButton({ workId, docId, path, title }: KbDeleteDocButtonProps) {
    const t = useTranslations('dashboard.workDetail.kb.delete');
    const router = useRouter();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const onDelete = useCallback(() => {
        setError(null);
        startTransition(async () => {
            const result = await deleteKbDocumentAction({
                workId,
                docId,
                path,
            });
            if (result.success) {
                setConfirmOpen(false);
                router.push(ROUTES.DASHBOARD_WORK_KB(workId));
            } else {
                setError(result.error ?? t('errorFallback'));
            }
        });
    }, [docId, path, router, t, workId]);

    const docTitle = title || path;

    return (
        <>
            <button
                type="button"
                data-testid="kb-doc-delete-button"
                data-doc-id={docId}
                onClick={() => setConfirmOpen(true)}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs',
                    'border-red-500/40 dark:border-red-400/40',
                    'bg-red-500/5 dark:bg-red-400/10',
                    'text-red-600 dark:text-red-400',
                    'hover:bg-red-500/10 dark:hover:bg-red-400/20',
                )}
            >
                <TrashIcon className="h-3.5 w-3.5" />
                <span>{t('confirm')}</span>
            </button>
            {confirmOpen ? (
                <KbDeleteConfirmDialog
                    title={t('docConfirmTitle')}
                    body={t('docConfirmBody', { title: docTitle })}
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
