'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { FolderInput, Loader2, X } from 'lucide-react';
import { KB_LIBRARY_FILE_BATCH_MAX } from '@ever-works/contracts';
import type { KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';
import { cn } from '@/lib/utils/cn';
import { LibraryDocumentRow } from './LibraryDocumentRow';

export interface LibraryDocumentListProps {
    documents: KbLibraryDocumentDto[];
    selectedIds: ReadonlySet<string>;
    onToggleSelect: (docId: string) => void;
    onClearSelection: () => void;
    /** Open the folder picker for the current selection. */
    onFileSelected: () => void;
    onFile: (document: KbLibraryDocumentDto) => void;
    onArchive: (document: KbLibraryDocumentDto) => void;
    onExport: (document: KbLibraryDocumentDto) => void;
    hasMore: boolean;
    isLoadingMore: boolean;
    onLoadMore: () => void;
    busyDocId?: string | null;
}

/**
 * The shelf's document rows, plus the bulk-filing bar and paging.
 *
 * Pages load on `nextCursor`: a sentinel below the last row asks for the next
 * page as it scrolls into view, and a Load more button does the same for
 * keyboard users and browsers without `IntersectionObserver`. Selection lives
 * here in the list's parent, never in a global store.
 */
export function LibraryDocumentList({
    documents,
    selectedIds,
    onToggleSelect,
    onClearSelection,
    onFileSelected,
    onFile,
    onArchive,
    onExport,
    hasMore,
    isLoadingMore,
    onLoadMore,
    busyDocId,
}: LibraryDocumentListProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const selectedCount = selectedIds.size;
    const overLimit = selectedCount > KB_LIBRARY_FILE_BATCH_MAX;
    const selectedDocs = documents.filter((doc) => selectedIds.has(doc.id));
    const selectionBlocked = selectedDocs.some((doc) => !doc.canEdit);

    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting) && !isLoadingMore) onLoadMore();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore]);

    return (
        <div className="flex flex-col gap-2">
            {selectedCount > 0 ? (
                <div
                    data-testid="library-selection-bar"
                    className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
                >
                    <span className="font-medium text-text dark:text-text-dark">
                        {t('selectedCount', { count: selectedCount })}
                    </span>
                    <button
                        type="button"
                        data-testid="library-selection-file"
                        aria-disabled={overLimit || selectionBlocked}
                        title={selectionBlocked ? t('noEditAccessFile') : undefined}
                        onClick={() => {
                            if (!overLimit && !selectionBlocked) onFileSelected();
                        }}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
                            'border-card-border bg-card text-text dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark',
                            (overLimit || selectionBlocked) && 'cursor-not-allowed opacity-50',
                        )}
                    >
                        <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('fileInto')}
                    </button>
                    <button
                        type="button"
                        data-testid="library-selection-clear"
                        onClick={onClearSelection}
                        className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                        {t('clearSelection')}
                    </button>
                    {overLimit ? (
                        <span
                            data-testid="library-selection-over-limit"
                            role="alert"
                            className="w-full text-xs text-red-600 dark:text-red-400"
                        >
                            {t('fileBatchLimit', {
                                max: KB_LIBRARY_FILE_BATCH_MAX,
                                count: selectedCount,
                            })}
                        </span>
                    ) : null}
                </div>
            ) : null}

            <ul data-testid="library-document-list" className="flex flex-col gap-2">
                {documents.map((doc) => (
                    <li key={doc.id}>
                        <LibraryDocumentRow
                            document={doc}
                            selected={selectedIds.has(doc.id)}
                            onToggleSelect={onToggleSelect}
                            onFile={onFile}
                            onArchive={onArchive}
                            onExport={onExport}
                            busy={busyDocId === doc.id}
                        />
                    </li>
                ))}
            </ul>

            {hasMore ? (
                <div ref={sentinelRef} className="flex justify-center py-2">
                    <button
                        type="button"
                        data-testid="library-load-more"
                        onClick={onLoadMore}
                        disabled={isLoadingMore}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-card px-3 py-1.5 text-sm text-text hover:border-border-secondary disabled:opacity-60 dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark"
                    >
                        {isLoadingMore ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : null}
                        {t('loadMore')}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
