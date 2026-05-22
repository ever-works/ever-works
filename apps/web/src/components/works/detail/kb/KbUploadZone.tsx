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

interface KbUploadZoneProps {
    workId: string;
    /**
     * Optional pre-selected document class — when the operator drops
     * a file directly into a class folder in the tree (row 8 wires
     * this), the upload zone forwards the value so the backend
     * skips heuristics-based classification.
     */
    targetClass?: string;
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
 * EW-641 Phase 1B/d row 7 — drag-drop upload zone.
 *
 * Renders a dashed drop target that accepts file drops + clicks for
 * the hidden `<input type=file>` fallback. Each file becomes an
 * `UploadEntry` that streams progress through `XMLHttpRequest.upload`
 * (`fetch` doesn't expose progress in Next.js client runtimes today).
 *
 * On the first successful upload the component calls
 * `router.refresh()` so the server-rendered tree panel
 * (`KbTreePanel`) re-fetches and the new document appears in the
 * left pane. Errors stay on the entry until the operator either
 * dismisses or replaces them — the form never silently swallows a
 * 413 / 503 / 400 from the backend.
 *
 * Selectors locked for the Playwright A12 (drag-drop upload → KB
 * doc) suite:
 *  - `data-testid="kb-upload-zone"` (drop target)
 *  - `data-testid="kb-upload-input"` (hidden file input)
 *  - `data-testid="kb-upload-entries"` (entries list)
 *  - `data-testid="kb-upload-entry"` (one per file) +
 *    `data-status` attribute that mirrors `UploadEntryStatus`
 */
export function KbUploadZone({ workId, targetClass }: KbUploadZoneProps) {
    const t = useTranslations('dashboard.workDetail.kb.upload');
    const router = useRouter();
    const [entries, setEntries] = useState<UploadEntry[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const refreshScheduled = useRef(false);

    const updateEntry = useCallback((id: string, patch: Partial<UploadEntry>) => {
        setEntries((prev) =>
            prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        );
    }, []);

    const onFiles = useCallback(
        (files: FileList | File[] | null) => {
            if (!files) return;
            const fileArray = Array.from(files);
            if (fileArray.length === 0) return;

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
                void uploadOne({
                    workId,
                    targetClass,
                    file,
                    entryId,
                    updateEntry,
                    onSuccess: () => {
                        // Batch refreshes — N parallel uploads should
                        // only kick a single revalidation pass.
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
        [workId, targetClass, updateEntry, router],
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
        </section>
    );
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
    targetClass?: string;
    file: File;
    entryId: string;
    updateEntry: (id: string, patch: Partial<UploadEntry>) => void;
    onSuccess: (documentId: string | null) => void;
}): Promise<void> {
    const { workId, targetClass, file, entryId, updateEntry, onSuccess } = args;
    return new Promise<void>((resolve) => {
        const form = new FormData();
        form.append('file', file);
        if (targetClass) form.append('targetClass', targetClass);

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
