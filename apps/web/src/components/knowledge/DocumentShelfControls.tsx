'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Download, FolderClosed, FolderInput, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { KbDocumentDto } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { archiveKbDocumentAction, unarchiveKbDocumentAction } from '@/app/actions/works/kb-review';
import { formatFolderPath } from '@/lib/api/knowledge-library-types';
import { cn } from '@/lib/utils/cn';
import { DocumentFilePicker } from './DocumentFilePicker';
import { knowledgeLibraryClient } from './library-client';
import { shelfBlockReason, type ShelfBlockKey } from './shelf-block-reason';
import { useLibraryDocument } from './use-library-document';

export interface DocumentShelfControlsProps {
    workId: string;
    document: KbDocumentDto;
}

/**
 * The library's curation controls on the per-Work workbench header: the
 * folder breadcrumb, File, Archive / Restore and Export as Markdown — so a
 * document can be shelved without leaving the Work.
 *
 * Archive and Restore go through the Work's own endpoints, so they work for
 * every Work. Filing and export belong to an Organization's library: in the
 * personal workspace (or for a document the library cannot read) those two
 * stay visible but disabled, with the reason as their tooltip. A member
 * without edit access sees File / Archive / Restore disabled the same way —
 * never hidden.
 */
export function DocumentShelfControls({ workId, document }: DocumentShelfControlsProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const router = useRouter();
    const { state, document: row, refresh } = useLibraryDocument(document.id);
    const [status, setStatus] = useState(document.status);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pending, setPending] = useState(false);

    useEffect(() => setStatus(document.status), [document.id, document.status]);

    const archived = status === 'archived';
    const reasonText = (key: ShelfBlockKey | null) => (key ? t(key) : null);
    const fileReason = reasonText(shelfBlockReason('file', state, row));
    const exportReason = reasonText(shelfBlockReason('export', state, row));
    const archiveReason = reasonText(
        shelfBlockReason(archived ? 'restore' : 'archive', state, row),
    );

    const archiveOrRestore = useCallback(async () => {
        if (pending || archiveReason) return;
        setPending(true);
        try {
            if (archived) {
                const result = await unarchiveKbDocumentAction({
                    workId,
                    docId: document.id,
                    path: document.path,
                });
                if (!result.success || !result.data) {
                    toast.error(t('restoreFailed'));
                    return;
                }
                setStatus(result.data.document.status);
                const next = await knowledgeLibraryClient
                    .getDocument(document.id)
                    .catch(() => null);
                toast.success(
                    result.data.restoredToUnfiled
                        ? t('restoredToUnfiledToast', { title: document.title })
                        : t('restoredToast', {
                              title: document.title,
                              folder: formatFolderPath(next?.folderPath) ?? t('unfiled'),
                          }),
                );
            } else {
                const result = await archiveKbDocumentAction({
                    workId,
                    docId: document.id,
                    path: document.path,
                });
                if (!result.success || !result.data) {
                    toast.error(t('archiveFailed'));
                    return;
                }
                setStatus(result.data.status);
                toast.success(t('archivedToast', { title: document.title }));
            }
            await refresh();
            router.refresh();
        } finally {
            setPending(false);
        }
    }, [
        archived,
        archiveReason,
        document.id,
        document.path,
        document.title,
        pending,
        refresh,
        router,
        t,
        workId,
    ]);

    const exportMarkdown = useCallback(async () => {
        if (exportReason || pending) return;
        setPending(true);
        try {
            await knowledgeLibraryClient.exportMarkdown(
                document.id,
                `${document.slug || 'document'}.md`,
            );
        } catch {
            toast.error(t('exportFailed'));
        } finally {
            setPending(false);
        }
    }, [document.id, document.slug, exportReason, pending, t]);

    const folderLabel =
        state === 'ready' && row ? (formatFolderPath(row.folderPath) ?? t('unfiled')) : null;

    return (
        <div
            data-testid="kb-workbench-shelf-controls"
            data-library-state={state}
            className="flex flex-wrap items-center gap-1"
        >
            {folderLabel ? (
                <span
                    data-testid="kb-workbench-folder-breadcrumb"
                    title={t('breadcrumbLabel')}
                    className="inline-flex max-w-[16rem] items-center gap-1 rounded-full bg-card-hover px-2 py-0.5 text-[11px] text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70"
                >
                    <FolderClosed className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{folderLabel}</span>
                </span>
            ) : null}
            <ShelfButton
                testId="kb-workbench-file-button"
                icon={<FolderInput className="h-3.5 w-3.5" aria-hidden="true" />}
                label={t('fileLabel')}
                reason={fileReason}
                busy={pending}
                onClick={() => setPickerOpen(true)}
            />
            <ShelfButton
                testId={archived ? 'kb-workbench-restore-button' : 'kb-workbench-archive-button'}
                icon={
                    archived ? (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                    )
                }
                label={archived ? t('restore') : t('archive')}
                reason={archiveReason}
                busy={pending}
                onClick={() => void archiveOrRestore()}
            />
            <ShelfButton
                testId="kb-workbench-export-button"
                icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                label={t('export')}
                reason={exportReason}
                busy={pending}
                onClick={() => void exportMarkdown()}
            />
            {row && pickerOpen ? (
                <DocumentFilePicker
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    document={row}
                    onFiled={() => void refresh()}
                />
            ) : null}
        </div>
    );
}

function ShelfButton({
    testId,
    icon,
    label,
    reason,
    busy,
    onClick,
}: {
    testId: string;
    icon: ReactNode;
    label: string;
    reason: string | null;
    busy: boolean;
    onClick: () => void;
}) {
    const blocked = reason !== null || busy;
    return (
        <button
            type="button"
            data-testid={testId}
            aria-disabled={blocked}
            data-disabled-reason={reason ?? undefined}
            title={reason ?? label}
            onClick={() => {
                if (!blocked) onClick();
            }}
            className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]',
                'text-text-muted hover:bg-card-hover hover:text-text dark:text-text-muted-dark/80 dark:hover:bg-card-primary-dark/40 dark:hover:text-text-dark',
                blocked && 'cursor-not-allowed opacity-50',
            )}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
