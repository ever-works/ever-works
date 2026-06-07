'use client';

import { useCallback, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { KbTreePanel, type KbTreePanelProps } from '@/components/kb/workbench/KbTreePanel';
import { UploadDropZone } from '@/components/kb/workbench/UploadDropZone';
import {
    UploadClassificationModal,
    type UploadClassificationModalInput,
} from '@/components/kb/workbench/UploadClassificationModal';
import { UploadProgress, type UploadEntry } from '@/components/kb/workbench/UploadProgress';
import { uploadKbFile, KbUploadError } from '@/lib/kb/kb-uploads';
import type { KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-641 slice C — workbench-level upload coordinator.
 *
 * Owned by the workbench page (index + `[...path]`). Wraps `KbTreePanel`
 * in an `UploadDropZone`, opens the classification modal on drop, runs
 * `uploadKbFile` per accepted file, threads progress events into the
 * toast stack, and bumps a refresh key on `KbTreePanel` after every
 * successful upload so the tree re-fetches the new doc list.
 *
 * The router refresh is a belt-and-suspenders move — on document detail
 * pages the server component needs a re-render to pick up any new doc;
 * for the index page the client-side tree refresh alone is enough but
 * `router.refresh()` is a no-op cost.
 */

export interface WorkbenchUploadCoordinatorProps {
    /** Forwarded to `KbTreePanel`. */
    readonly workId: string;
    /** Forwarded to `KbTreePanel` so the active row stays highlighted. */
    readonly currentDocPath?: string;
}

interface PendingDrop {
    readonly files: File[];
    readonly targetClass: KbDocumentClass;
}

function makeEntryId(file: File, idx: number): string {
    return `kb-upload-${Date.now().toString(36)}-${idx}-${file.name.replace(/[^a-z0-9-_.]/gi, '_')}`;
}

export function WorkbenchUploadCoordinator({
    workId,
    currentDocPath,
}: WorkbenchUploadCoordinatorProps) {
    const router = useRouter();
    const [pending, setPending] = useState<PendingDrop | null>(null);
    const [uploads, setUploads] = useState<UploadEntry[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    const handleDrop = useCallback((files: File[], targetClass: KbDocumentClass) => {
        if (files.length === 0) return;
        setPending({ files, targetClass });
    }, []);

    const dismissEntry = useCallback((entryId: string) => {
        setUploads((prev) => prev.filter((e) => e.id !== entryId));
    }, []);

    const startUploads = useCallback(
        async (input: UploadClassificationModalInput) => {
            if (!pending) return;
            const { files } = pending;
            const queued: UploadEntry[] = files.map((file, idx) => ({
                id: makeEntryId(file, idx),
                filename: file.name,
                bytesUploaded: 0,
                bytesTotal: file.size,
                status: 'uploading' as const,
            }));
            setUploads((prev) => [...prev, ...queued]);
            setPending(null);

            // Fire all uploads in parallel — `uploadKbFile` uses XHR so
            // each call is its own request, and they race independently.
            await Promise.all(
                files.map(async (file, idx) => {
                    const entryId = queued[idx].id;
                    try {
                        await uploadKbFile({
                            workId,
                            file,
                            class: input.class,
                            tags: input.tags,
                            description: input.description,
                            autoClassify: input.autoClassify,
                            onProgress: (loaded, total) => {
                                setUploads((prev) =>
                                    prev.map((e) =>
                                        e.id === entryId
                                            ? {
                                                  ...e,
                                                  bytesUploaded: loaded,
                                                  bytesTotal: total > 0 ? total : e.bytesTotal,
                                              }
                                            : e,
                                    ),
                                );
                            },
                        });
                        setUploads((prev) =>
                            prev.map((e) =>
                                e.id === entryId
                                    ? {
                                          ...e,
                                          status: 'done',
                                          bytesUploaded: e.bytesTotal,
                                      }
                                    : e,
                            ),
                        );
                    } catch (err) {
                        const message =
                            err instanceof KbUploadError
                                ? err.message
                                : err instanceof Error
                                  ? err.message
                                  : 'Upload failed';
                        setUploads((prev) =>
                            prev.map((e) =>
                                e.id === entryId ? { ...e, status: 'failed', error: message } : e,
                            ),
                        );
                    }
                }),
            );

            // Bump the tree refresh key so `KbTreePanel` re-fetches.
            setRefreshKey((x) => x + 1);
            // Belt-and-suspenders: refresh the RSC tree in case the
            // current detail page server-renders metadata that should
            // change.
            try {
                router.refresh();
            } catch {
                /* in tests `useRouter` is a no-op stub */
            }
        },
        [pending, workId, router],
    );

    const cancelModal = useCallback(() => {
        setPending(null);
    }, []);

    const treeProps: KbTreePanelProps = {
        workId,
        currentDocPath,
        refreshKey,
    };

    return (
        <>
            <UploadDropZone onDrop={handleDrop}>
                <KbTreePanel {...treeProps} />
            </UploadDropZone>
            {pending ? (
                <UploadClassificationModal
                    files={pending.files}
                    defaultClass={pending.targetClass}
                    onUpload={startUploads}
                    onCancel={cancelModal}
                />
            ) : null}
            <UploadProgress uploads={uploads} onAutoDismiss={dismissEntry} />
        </>
    );
}
