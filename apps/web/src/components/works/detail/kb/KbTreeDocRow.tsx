'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { deleteKbDocumentAction } from '@/app/actions/works/kb-document';
import { KbDeleteConfirmDialog } from './KbDeleteConfirmDialog';

interface KbTreeDocRowProps {
    workId: string;
    doc: {
        id: string;
        path: string;
        title: string | null;
        locked: boolean;
    };
    href: string;
    isActive: boolean;
}

/**
 * EW-641 KB workbench follow-up — interactive Work-owned tree row.
 *
 * Wraps the existing `<Link>` row (preserved markup + selectors) with a
 * hover-revealed trash button that triggers the
 * `deleteKbDocumentAction` server action. Inherited rows are NOT
 * rendered through this component (they live in the `KbInheritedSection`
 * inside `KbTreePanel.tsx`) — the trash affordance only ever appears
 * for docs the current Work actually owns.
 *
 * The Link itself stays the row's primary target; the trash button is
 * a sibling so a click on it doesn't bubble through to navigation.
 */
export function KbTreeDocRow({ workId, doc, href, isActive }: KbTreeDocRowProps) {
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
                docId: doc.id,
                path: doc.path,
            });
            if (result.success) {
                setConfirmOpen(false);
                // Refresh the server-rendered tree so the row disappears.
                // `useRouter` from `@/i18n/navigation` keeps the locale
                // prefix on the catch-all KB route.
                router.refresh();
            } else {
                setError(result.error ?? t('errorFallback'));
            }
        });
    }, [router, t, workId, doc.id, doc.path]);

    const title = doc.title || doc.path;

    return (
        <div className="group relative flex items-center">
            <Link
                href={href}
                data-testid="kb-tree-item"
                data-doc-path={doc.path}
                data-locked={doc.locked ? 'true' : undefined}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                    'flex flex-1 items-center gap-2 rounded px-2 py-1.5 pr-8 text-sm transition-colors',
                    isActive
                        ? 'bg-primary/10 text-primary dark:bg-primary/20'
                        : 'text-text-secondary dark:text-text-secondary-dark/80 hover:bg-card-hover dark:hover:bg-card-primary-dark/40 hover:text-text dark:hover:text-text-dark',
                )}
            >
                <span className="truncate">{title}</span>
                {doc.locked ? (
                    <span
                        aria-label="locked"
                        className="ml-auto text-xs text-text-muted dark:text-text-muted-dark/60"
                    >
                        🔒
                    </span>
                ) : null}
            </Link>
            <button
                type="button"
                data-testid="kb-tree-delete-doc"
                data-doc-id={doc.id}
                aria-label={t('docTooltip')}
                title={t('docTooltip')}
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmOpen(true);
                }}
                className={cn(
                    'absolute right-1 flex h-6 w-6 items-center justify-center rounded',
                    'text-text-muted dark:text-text-muted-dark/70',
                    'hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400',
                    // Stay visible while the dialog is open so the user
                    // can re-trigger if they dismiss + re-confirm.
                    confirmOpen
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                    'transition-opacity',
                )}
            >
                <TrashIcon className="h-3.5 w-3.5" />
            </button>
            {confirmOpen ? (
                <KbDeleteConfirmDialog
                    title={t('docConfirmTitle')}
                    body={t('docConfirmBody', { title })}
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
        </div>
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
