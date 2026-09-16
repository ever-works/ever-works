'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { KB_LIBRARY_FILE_BATCH_MAX } from '@ever-works/contracts';
import {
    formatFolderPath,
    type KbLibraryDocumentDto,
    type KbLibraryTreeDto,
} from '@/lib/api/knowledge-library-types';
import { FolderPickerDialog, type FolderPickerTarget } from './FolderPickerDialog';
import { LibraryRequestError, knowledgeLibraryClient } from './library-client';

export interface DocumentFilePickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    document: KbLibraryDocumentDto;
    /** Called after the document moved, so the caller can re-read its row. */
    onFiled?: () => void;
}

/**
 * File one document into a shared folder from outside the Library view (the
 * workbench header, the tree's context menu). Loads the folder rail when it
 * opens, reports the outcome as a toast, and keeps the dialog open with the
 * reason when the filing is refused.
 */
export function DocumentFilePicker({
    open,
    onOpenChange,
    document,
    onFiled,
}: DocumentFilePickerProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const [tree, setTree] = useState<KbLibraryTreeDto | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Folders created from this picker, by id. Create-and-file files in the
    // same tick, before the `tree` this render captured carries the folder,
    // so the confirmation reads its path from here — as `LibraryPanel` does.
    const createdPaths = useRef(new Map<string, string>());

    useEffect(() => {
        if (!open) return;
        // Callers mount the picker per opening, so the error starts clear.
        let cancelled = false;
        knowledgeLibraryClient
            .tree()
            .then((next) => {
                if (!cancelled) setTree(next);
            })
            .catch(() => {
                if (!cancelled) setError(t('treeLoadFailed'));
            });
        return () => {
            cancelled = true;
        };
    }, [open, t]);

    const onFile = async (target: FolderPickerTarget) => {
        setError(null);
        try {
            await knowledgeLibraryClient.file([document.id], target);
        } catch (err) {
            setError(
                err instanceof LibraryRequestError && err.status === 403
                    ? t('noEditAccessFile')
                    : err instanceof LibraryRequestError && err.code === 'FileBatchLimit'
                      ? t('fileBatchLimit', { max: KB_LIBRARY_FILE_BATCH_MAX, count: 1 })
                      : t('fileFailed'),
            );
            throw err;
        }
        const path = target ? (createdPaths.current.get(target) ?? findPath(tree, target)) : null;
        toast.success(
            target
                ? t('filedToast', { count: 1, folder: formatFolderPath(path) ?? t('unfiled') })
                : t('unfiledToast', { count: 1 }),
        );
        onOpenChange(false);
        onFiled?.();
    };

    const onCreateFolder = async (name: string) => {
        try {
            const folder = await knowledgeLibraryClient.createFolder(name, null);
            createdPaths.current.set(folder.id, folder.path);
            setTree((prev) =>
                prev
                    ? {
                          ...prev,
                          folders: [
                              ...prev.folders,
                              {
                                  id: folder.id,
                                  name: folder.name,
                                  path: folder.path,
                                  parentId: null,
                                  depth: 1,
                                  documentCount: 0,
                                  subtreeDocumentCount: 0,
                                  hasUnread: false,
                                  children: [],
                              },
                          ],
                      }
                    : prev,
            );
            return folder.id;
        } catch (err) {
            setError(t('folderFailed'));
            throw err;
        }
    };

    return (
        <FolderPickerDialog
            open={open}
            onOpenChange={onOpenChange}
            documentCount={1}
            tree={tree}
            currentFolderId={document.folderId}
            onFile={onFile}
            onCreateFolder={tree?.canManageFolders ? onCreateFolder : undefined}
            error={error}
        />
    );
}

function findPath(tree: KbLibraryTreeDto | null, folderId: string): string | null {
    const stack = [...(tree?.folders ?? [])];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.id === folderId) return node.path;
        stack.push(...node.children);
    }
    return null;
}
