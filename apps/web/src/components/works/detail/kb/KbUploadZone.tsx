'use client';

import {
    useCallback,
    useRef,
    useState,
    type ChangeEvent,
    type DragEvent,
    type ReactNode,
} from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    KbClassifyModal,
    type KbClassifyFileEntry,
    type KbClassifyResult,
} from './KbClassifyModal';
import type { KbDocumentClass } from '@ever-works/contracts';

interface KbUploadZoneProps {
    workId: string;
    /**
     * Optional pre-selected document class — when the operator is
     * viewing a doc in a class folder, the upload zone passes it to
     * the classify modal as the default selection.
     */
    targetClass?: KbDocumentClass;
}

type UploadEntryStatus = 'queued' | 'uploading' | 'succeeded' | 'failed';

interface UploadEntry {
    /** Stable id for React `key` + status updates. */
    id: string;
    name: string;
    size: number;
    status: UploadEntryStatus;
    /** Percentage 0-100, only meaningful while `uploading`. */
    progress: number;
    error: string | null;
    documentId: string | null;
}

/**
 * EW-641 Phase 1B/d row 7 + 8 — drag-drop upload zone + classify modal.
 *
 * Files picked by drop or browse open the `KbClassifyModal` so the
 * operator can confirm the target class, set a description, and add
 * tags before the multipart POST. Cancelling the modal discards the
 * batch; confirming kicks off the per-file `XMLHttpRequest`s with the
 * chosen metadata. Each upload streams progress through `xhr.upload`
 * (`fetch` doesn't expose request progress in Next.js client runtimes
 * today).
 *
 * On the first successful upload per batch the component calls
 * `router.refresh()` so the server-rendered tree panel re-fetches and
 * the new document appears in the left pane.
 *
 * Selectors locked for Playwright A12:
 *  - `data-testid="kb-upload-zone"` + `data-drag-active`
 *  - `data-testid="kb-upload-input"`
 *  - `data-testid="kb-upload-entries"` / `kb-upload-entry`
 *    (with `data-status` mirroring `UploadEntryStatus`)
 *  - The modal's own selectors live in `KbClassifyModal.tsx`.
 */
export function KbUploadZone({ workId, targetClass }: KbUploadZoneProps) {
    const t = useTranslations('dashboard.workDetail.kb.upload');
    const router = useRouter();
    const [entries, setEntries] = useState<UploadEntry[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const refreshScheduled = useRef(false);

    const updateEntry = useCallback((id: string, patch: Partial<UploadEntry>) => {
        setEntries((prev) =>
            prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        );
    }, []);

    const openClassifyFor = useCallback((files: File[]) => {
        if (files.length === 0) return;
        setPendingFiles(files);
    }, []);

    const onFiles = useCallback(
        (files: FileList | File[] | null) => {
            if (!files) return;
            const fileArray = Array.from(files);
            if (fileArray.length === 0) return;
            openClassifyFor(fileArray);
        },
        [openClassifyFor],
    );

    const onDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();
            setDragActive(false);
            onFiles(event.dataTransfer?.files ?? null);
        },
        [onFiles],
    );

    const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(true);
    }, []);

    const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(false);
    }, []);

    const onPick = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => {
            const files = event.target.files;
            onFiles(files);
            // Reset so picking the same file twice still triggers the
            // change event (browsers de-dup identical selections).
            event.target.value = '';
        },
        [onFiles],
    );

    const onBrowseClick = useCallback(() => {
        inputRef.current?.click();
    }, []);

    const onDismiss = useCallback((id: string) => {
        setEntries((prev) => prev.filter((entry) => entry.id !== id));
    }, []);

    const onClassifyCancel = useCallback(() => {
        setPendingFiles([]);
    }, []);

    const onClassifyConfirm = useCallback(
        (result: KbClassifyResult) => {
            const fileArray = pendingFiles;
            setPendingFiles([]);

            const queued: UploadEntry[] = fileArray.map((file) => ({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                name: file.name,
                size: file.size,
                status: 'queued',
                progress: 0,
                error: null,
                documentId: null,
            }));
            setEntries((prev) => [...queued, ...prev]);

            for (const [index, file] of fileArray.entries()) {
                const entryId = queued[index].id;
                const title = result.titles[index]?.trim() || titleFromFilename(file.name);
                void uploadOne({
                    workId,
                    targetClass: result.targetClass,
                    title,
                    description: result.description,
                    tags: result.tags,
                    file,
                    entryId,
                    updateEntry,
                    onSuccess: () => {
                        if (refreshScheduled.current) return;
                        refreshScheduled.current = true;
                        Promise.resolve().then(() => {
                            refreshScheduled.current = false;
                            router.refresh();
                        });
                    },
                });
            }
        },
        [pendingFiles, workId, updateEntry, router],
    );

    return (
        <section aria-label={t('title')} className="flex flex-col gap-3">
            <DropTarget
                dragActive={dragActive}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragEnter={onDragOver}
                onDragLeave={onDragLeave}
                onBrowseClick={onBrowseClick}
                title={t('title')}
                hint={t('hint')}
                browseLabel={t('browse')}
            >
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    data-testid="kb-upload-input"
                    className="sr-only"
                    onChange={onPick}
                />
            </DropTarget>

            {entries.length > 0 ? (
                <ul data-testid="kb-upload-entries" className="flex flex-col gap-1.5">
                    {entries.map((entry) => (
                        <UploadEntryRow
                            key={entry.id}
                            entry={entry}
                            labels={{
                                queued: t('status.queued'),
                                uploading: t('status.uploading'),
                                succeeded: t('status.succeeded'),
                                failed: t('status.failed'),
                                dismiss: t('dismiss'),
                            }}
                            onDismiss={onDismiss}
                        />
                    ))}
                </ul>
            ) : null}

            {pendingFiles.length > 0 ? (
                <KbClassifyModal
                    workId={workId}
                    files={pendingFiles.map<KbClassifyFileEntry>((file, index) => ({
                        index,
                        name: file.name,
                        title: titleFromFilename(file.name),
                    }))}
                    initialClass={targetClass}
                    onConfirm={onClassifyConfirm}
                    onCancel={onClassifyCancel}
                />
            ) : null}
        </section>
    );
}

/**
 * Strip the extension off `voice.md` → `voice`. Falls back to the
 * whole filename when there's no `.`, and trims trailing whitespace
 * so users can edit the value without weird leading spaces.
 */
function titleFromFilename(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    const base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
    return base.trim();
}

interface DropTargetProps {
    dragActive: boolean;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
    onBrowseClick: () => void;
    title: string;
    hint: string;
    browseLabel: string;
    children: ReactNode;
}

function DropTarget({
    dragActive,
    onDrop,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onBrowseClick,
    title,
    hint,
    browseLabel,
    children,
}: DropTargetProps) {
    return (
        <div
            data-testid="kb-upload-zone"
            data-drag-active={dragActive ? 'true' : 'false'}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            className={cn(
                'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
                dragActive
                    ? 'border-primary bg-primary/5 dark:bg-primary/10'
                    : 'border-border bg-card/30 dark:border-border-dark dark:bg-card-primary-dark/20',
            )}
        >
            <p className="text-sm font-medium text-text dark:text-text-dark">{title}</p>
            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark/60">{hint}</p>
            <div className="mt-3">
                <Button type="button" size="sm" onClick={onBrowseClick}>
                    {browseLabel}
                </Button>
            </div>
            {children}
        </div>
    );
}

interface UploadEntryRowProps {
    entry: UploadEntry;
    labels: {
        queued: string;
        uploading: string;
        succeeded: string;
        failed: string;
        dismiss: string;
    };
    onDismiss: (id: string) => void;
}

function UploadEntryRow({ entry, labels, onDismiss }: UploadEntryRowProps) {
    const statusLabel =
        entry.status === 'queued'
            ? labels.queued
            : entry.status === 'uploading'
              ? `${labels.uploading} ${entry.progress}%`
              : entry.status === 'succeeded'
                ? labels.succeeded
                : (entry.error ?? labels.failed);

    return (
        <li
            data-testid="kb-upload-entry"
            data-status={entry.status}
            data-entry-id={entry.id}
            className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
                'border-border dark:border-border-dark bg-card/30 dark:bg-card-primary-dark/20',
            )}
        >
            <span className="flex-1 truncate font-medium text-text dark:text-text-dark">
                {entry.name}
            </span>
            <span
                className={cn(
                    'rounded-full px-2 py-0.5',
                    entry.status === 'succeeded'
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : entry.status === 'failed'
                          ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                          : entry.status === 'uploading'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70',
                )}
            >
                {statusLabel}
            </span>
            {entry.status === 'succeeded' || entry.status === 'failed' ? (
                <button
                    type="button"
                    aria-label={labels.dismiss}
                    onClick={() => onDismiss(entry.id)}
                    className="text-text-muted hover:text-text dark:text-text-muted-dark/60 dark:hover:text-text-dark"
                >
                    ×
                </button>
            ) : null}
        </li>
    );
}

/**
 * Internal upload driver — uses `XMLHttpRequest` because `fetch` in
 * Node 22 / Next 16 client runtimes doesn't expose request-progress
 * events (the standard `progress` listener fires on the response,
 * not on the body upload). Server-Sent Events would also work, but
 * XHR is the standard pattern in this codebase (see
 * `apps/web/src/components/works/detail/items/ItemsImportClient.tsx`).
 */
function uploadOne(args: {
    workId: string;
    targetClass?: KbDocumentClass;
    title?: string;
    description?: string;
    tags?: string[];
    file: File;
    entryId: string;
    updateEntry: (id: string, patch: Partial<UploadEntry>) => void;
    onSuccess: (documentId: string | null) => void;
}): Promise<void> {
    const { workId, targetClass, title, description, tags, file, entryId, updateEntry, onSuccess } =
        args;
    return new Promise<void>((resolve) => {
        const form = new FormData();
        form.append('file', file);
        if (targetClass) form.append('targetClass', targetClass);
        if (title) form.append('title', title);
        if (description && description.length > 0) form.append('description', description);
        if (tags && tags.length > 0) {
            // NestJS `class-transformer` accepts repeated `tags[]` form
            // fields or a single comma-separated string — repeat is the
            // unambiguous shape because tags may legitimately contain
            // commas (e.g. "Tier 1, US").
            for (const tag of tags) form.append('tags', tag);
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/works/${workId}/kb/uploads`);
        xhr.responseType = 'json';

        xhr.upload.addEventListener('progress', (event) => {
            if (!event.lengthComputable) return;
            const progress = Math.min(100, Math.round((event.loaded / event.total) * 100));
            updateEntry(entryId, { status: 'uploading', progress });
        });
        xhr.addEventListener('error', () => {
            updateEntry(entryId, { status: 'failed', error: 'Network error' });
            resolve();
        });
        xhr.addEventListener('abort', () => {
            updateEntry(entryId, { status: 'failed', error: 'Upload aborted' });
            resolve();
        });
        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const docId =
                    (xhr.response &&
                        typeof xhr.response === 'object' &&
                        (xhr.response as { document?: { id?: string } | null }).document?.id) ||
                    null;
                updateEntry(entryId, {
                    status: 'succeeded',
                    progress: 100,
                    documentId: docId,
                });
                onSuccess(docId);
            } else {
                let message: string | null = null;
                const body = xhr.response;
                if (body && typeof body === 'object') {
                    const candidate = (body as { message?: unknown }).message;
                    if (typeof candidate === 'string') message = candidate;
                    else if (Array.isArray(candidate)) message = candidate.join(', ');
                }
                updateEntry(entryId, {
                    status: 'failed',
                    error: message ?? `HTTP ${xhr.status}`,
                });
            }
            resolve();
        });

        updateEntry(entryId, { status: 'uploading', progress: 0 });
        xhr.send(form);
    });
}
