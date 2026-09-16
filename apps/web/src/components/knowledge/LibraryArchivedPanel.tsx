'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Archive, Download, FolderClosed, Loader2, RotateCcw } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { formatFolderPath, type KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';
import { cn } from '@/lib/utils/cn';
import { formatLibraryDate, libraryDocumentHref } from './LibraryDocumentRow';

export interface LibraryArchivedPanelProps {
    documents: KbLibraryDocumentDto[];
    /** Archived documents in the library, from the folder rail. */
    total: number;
    state: 'loading' | 'ready' | 'error';
    hasMore: boolean;
    isLoadingMore: boolean;
    onLoadMore: () => void;
    onRetry: () => void;
    onRestore: (document: KbLibraryDocumentDto) => void;
    onExport: (document: KbLibraryDocumentDto) => void;
    busyDocId?: string | null;
}

/**
 * The Archived view: documents taken off the shelf, still readable and
 * exportable, with Restore and Export on every row. Restoring returns a
 * document to the folder it was archived from (the parent reports where it
 * landed). A member without edit access sees Restore disabled with the reason.
 */
export function LibraryArchivedPanel({
    documents,
    total,
    state,
    hasMore,
    isLoadingMore,
    onLoadMore,
    onRetry,
    onRestore,
    onExport,
    busyDocId,
}: LibraryArchivedPanelProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const locale = useLocale();

    return (
        <section data-testid="library-archived-panel" className="flex flex-col gap-3">
            <header className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-text dark:text-text-dark">
                        <Archive className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                        {t('archivedTitle')}
                    </h2>
                    <span
                        data-testid="library-archived-count"
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('documentCount', { count: total })}
                    </span>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('archivedSubtitle')}
                </p>
            </header>

            {state === 'loading' ? (
                <div
                    data-testid="library-archived-loading"
                    className="flex items-center gap-2 py-6 text-sm text-text-muted dark:text-text-muted-dark"
                >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('loading')}
                </div>
            ) : state === 'error' ? (
                <div
                    data-testid="library-archived-error"
                    role="alert"
                    className="flex flex-col items-center gap-2 py-8 text-sm text-text dark:text-text-dark"
                >
                    <p>{t('loadFailed')}</p>
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-lg border border-card-border px-3 py-1.5 text-sm dark:border-white/9"
                    >
                        {t('tryAgain')}
                    </button>
                </div>
            ) : documents.length === 0 ? (
                <p
                    data-testid="library-archived-empty"
                    className="py-8 text-center text-sm text-text-muted dark:text-text-muted-dark"
                >
                    {t('archivedEmpty')}
                </p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {documents.map((doc) => {
                        const href = libraryDocumentHref(doc);
                        const busy = busyDocId === doc.id;
                        const blocked = !doc.canEdit;
                        return (
                            <li
                                key={doc.id}
                                data-testid={`library-archived-doc-${doc.id}`}
                                className="flex flex-wrap items-center gap-3 rounded-lg border border-card-border bg-card p-3 dark:border-white/9 dark:bg-card-primary-dark"
                            >
                                <div className="min-w-0 flex-1">
                                    {href ? (
                                        <Link
                                            href={href}
                                            className="truncate text-sm font-medium text-text hover:underline dark:text-text-dark"
                                        >
                                            {doc.title}
                                        </Link>
                                    ) : (
                                        <span className="truncate text-sm font-medium text-text dark:text-text-dark">
                                            {doc.title}
                                        </span>
                                    )}
                                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                                        <span className="inline-flex items-center gap-1">
                                            <FolderClosed
                                                className="h-3 w-3"
                                                strokeWidth={1.5}
                                                aria-hidden="true"
                                            />
                                            {formatFolderPath(doc.folderPath) ?? t('unfiled')}
                                        </span>
                                        {doc.archivedAt ? (
                                            <span>
                                                {t('archivedAt', {
                                                    date: formatLibraryDate(doc.archivedAt, locale),
                                                })}
                                            </span>
                                        ) : null}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        data-testid={`library-archived-restore-${doc.id}`}
                                        aria-disabled={blocked || busy}
                                        title={blocked ? t('noEditAccessRestore') : undefined}
                                        onClick={() => {
                                            if (!blocked && !busy) onRestore(doc);
                                        }}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
                                            'border-card-border text-text dark:border-white/9 dark:text-text-dark',
                                            (blocked || busy) && 'cursor-not-allowed opacity-50',
                                        )}
                                    >
                                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                        {t('restore')}
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`library-archived-export-${doc.id}`}
                                        onClick={() => onExport(doc)}
                                        disabled={busy}
                                        className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-xs text-text disabled:opacity-50 dark:border-white/9 dark:text-text-dark"
                                    >
                                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                        {t('export')}
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {state === 'ready' && hasMore ? (
                <div className="flex justify-center">
                    <button
                        type="button"
                        data-testid="library-archived-load-more"
                        onClick={onLoadMore}
                        disabled={isLoadingMore}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-card-border px-3 py-1.5 text-sm text-text disabled:opacity-60 dark:border-white/9 dark:text-text-dark"
                    >
                        {isLoadingMore ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : null}
                        {t('loadMore')}
                    </button>
                </div>
            ) : null}
        </section>
    );
}
