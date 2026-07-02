'use client';

import { useRef, useState, useTransition } from 'react';
import {
    File as FileIcon,
    FileArchive,
    FileAudio,
    FileSpreadsheet,
    FileText,
    FileVideo,
    Image as ImageIcon,
    Trash2,
    Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { uploadFile, UploadError } from '@/lib/api/uploads';

/**
 * Generic per-entity attachment panel — shared by the Mission, Idea,
 * and Agent detail pages. Modeled on {@link TaskAttachmentsSection}
 * (which stays as-is to preserve its slightly different shape — Task
 * attachments carry joined upload metadata; the new entity types don't
 * yet).
 *
 * Flow per file:
 *   1. User drops or picks a file in the drag-and-drop zone.
 *   2. `POST /api/uploads/file` (auth-gated, broader MIME allow-list) →
 *      returns `{ id: <sha256>, url, filename, size, mimeType, hash }`.
 *   3. Caller-supplied `onAttach(uploadId)` wires the upload to the
 *      entity (calls one of the new
 *      `attachUploadTo{Mission,Idea,Agent}Action` server actions).
 *   4. The returned row is prepended to the local list with the
 *      client-known filename + size in `meta` so the user sees
 *      something useful before any joined metadata lands.
 *
 * The component is fully controlled-by-callbacks — it doesn't know
 * which entity type it's rendering for, which keeps the routing
 * decision (which API endpoint, which revalidate paths) at the call
 * site. That mirrors how `PromptComposer` exposes the same surface
 * across `/missions`, `/ideas`, `/new`, `/works/new`.
 */

interface UploadedFileMeta {
    filename: string;
    sizeBytes: number;
    contentType: string;
    /** API-served URL, present for in-session uploads — enables image previews. */
    url?: string;
}

/**
 * Maps a file to a preview affordance: an icon + accent tint, and whether
 * it can render an inline image thumbnail. Server-loaded rows only carry a
 * `uploadId` (no filename/mime), so they fall back to the generic icon; a
 * fresh upload has both mime + url, so images get a real thumbnail.
 */
interface FileKind {
    icon: typeof FileIcon;
    /** Icon/label text tint. */
    tint: string;
    /** Tinted background for the Drive-style preview area. */
    previewBg: string;
    /** Short label shown on the preview tile (e.g. PDF, MP4). */
    label: string;
    isImage: boolean;
}

function fileKind(filename: string, contentType?: string): FileKind {
    const ct = (contentType ?? '').toLowerCase();
    const ext = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
    const inExt = (list: string[]) => list.includes(ext);
    const label = (fallback: string) => (ext ? ext.toUpperCase() : fallback);

    if (ct.startsWith('image/') || inExt(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']))
        return {
            icon: ImageIcon,
            tint: 'text-info',
            previewBg: 'bg-info/10',
            label: label('IMG'),
            isImage: true,
        };
    if (ct === 'application/pdf' || ext === 'pdf')
        return {
            icon: FileText,
            tint: 'text-danger',
            previewBg: 'bg-danger/10',
            label: 'PDF',
            isImage: false,
        };
    if (ct.startsWith('video/') || inExt(['mp4', 'mov', 'webm', 'mkv', 'avi']))
        return {
            icon: FileVideo,
            tint: 'text-primary',
            previewBg: 'bg-primary/10',
            label: label('VIDEO'),
            isImage: false,
        };
    if (ct.startsWith('audio/') || inExt(['mp3', 'wav', 'ogg', 'flac', 'm4a']))
        return {
            icon: FileAudio,
            tint: 'text-warning',
            previewBg: 'bg-warning/10',
            label: label('AUDIO'),
            isImage: false,
        };
    if (inExt(['zip', 'tar', 'gz', 'rar', '7z']))
        return {
            icon: FileArchive,
            tint: 'text-text-muted',
            previewBg: 'bg-surface-secondary dark:bg-surface-secondary-dark',
            label: label('ZIP'),
            isImage: false,
        };
    if (inExt(['csv', 'xls', 'xlsx', 'ods']))
        return {
            icon: FileSpreadsheet,
            tint: 'text-success',
            previewBg: 'bg-success/10',
            label: label('SHEET'),
            isImage: false,
        };
    return {
        icon: FileIcon,
        tint: 'text-text-muted',
        previewBg: 'bg-surface-secondary dark:bg-surface-secondary-dark',
        label: label('FILE'),
        isImage: false,
    };
}

export interface EntityAttachmentRow {
    readonly id: string;
    readonly uploadId: string;
    readonly createdAt: string;
}

export interface EntityAttachmentsSectionProps<TRow extends EntityAttachmentRow> {
    /** Existing attachment rows (server-rendered initial state). */
    readonly initial: ReadonlyArray<TRow>;
    /**
     * Called after a successful `/api/uploads/file` upload to wire the
     * upload into the entity. Implementations should call the matching
     * `attachUploadTo{Mission,Idea,Agent}Action` server action and
     * return the new attachment row.
     */
    readonly onAttach: (uploadId: string) => Promise<TRow>;
    /**
     * Called when the user clicks the trash icon. Implementations
     * should call the matching `detach{...}Action`.
     */
    readonly onDetach: (attachmentId: string) => Promise<{ deleted: true }>;
    /** Visible heading. Defaults to "Attachments". */
    readonly title?: string;
    /** Stable test hook prefix. */
    readonly testId?: string;
}

export function EntityAttachmentsSection<TRow extends EntityAttachmentRow>({
    initial,
    onAttach,
    onDetach,
    title = 'Attachments',
    testId,
}: EntityAttachmentsSectionProps<TRow>) {
    const [rows, setRows] = useState<TRow[]>([...initial]);
    const [meta, setMeta] = useState<Record<string, UploadedFileMeta>>({});
    const [pending, startTransition] = useTransition();
    const [dragOver, setDragOver] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const uploadFiles = (files: File[]) => {
        if (files.length === 0) return;
        setError(null);
        setBusy(true);
        startTransition(() => {
            void (async () => {
                for (const file of files) {
                    try {
                        const res = await uploadFile(file);
                        const row = await onAttach(res.id);
                        setRows((prev) => [row, ...prev]);
                        setMeta((prev) => ({
                            ...prev,
                            [row.id]: {
                                filename: file.name,
                                sizeBytes: file.size,
                                contentType: file.type,
                                url: res.url,
                            },
                        }));
                    } catch (err) {
                        const message =
                            err instanceof UploadError
                                ? err.message
                                : err instanceof Error
                                  ? err.message
                                  : 'Upload failed';
                        setError(message);
                    }
                }
                setBusy(false);
            })();
        });
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        uploadFiles(files);
    };

    const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        uploadFiles(files);
        if (inputRef.current) inputRef.current.value = '';
    };

    const handleRemove = (attachmentId: string) => {
        startTransition(() => {
            void (async () => {
                try {
                    await onDetach(attachmentId);
                    setRows((prev) => prev.filter((r) => r.id !== attachmentId));
                    setMeta((prev) => {
                        const next = { ...prev };
                        delete next[attachmentId];
                        return next;
                    });
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Detach failed');
                }
            })();
        });
    };

    const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid={testId}
        >
            <header className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">{title}</h2>
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {rows.length} file{rows.length === 1 ? '' : 's'}
                </p>
            </header>

            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={cn(
                    'rounded-lg border-2 border-dashed transition-colors p-6 flex flex-col items-center justify-center gap-2 text-center',
                    dragOver
                        ? 'border-primary bg-primary/5'
                        : 'border-border/60 dark:border-border-dark/60',
                    busy && 'opacity-60',
                )}
            >
                <Upload className="w-5 h-5 text-text-muted dark:text-text-muted-dark" />
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    Drag &amp; drop a file here or
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => inputRef.current?.click()}
                    disabled={busy}
                    data-testid={testId ? `${testId}-browse` : undefined}
                >
                    {busy ? 'Uploading…' : 'Browse'}
                </Button>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    onChange={handleSelect}
                    className="hidden"
                    data-testid={testId ? `${testId}-input` : undefined}
                />
            </div>

            {error && (
                <p
                    className="text-xs text-danger mt-2"
                    role="alert"
                    data-testid={testId ? `${testId}-error` : undefined}
                >
                    {error}
                </p>
            )}

            {rows.length > 0 && (
                <ul
                    className="mt-4 grid grid-cols-2 sm:grid-cols-3 @2xl/main:grid-cols-4 gap-3"
                    data-testid={testId ? `${testId}-list` : undefined}
                >
                    {rows.map((r) => {
                        const m = meta[r.id] ?? null;
                        const filename = m?.filename ?? r.uploadId;
                        const size = m ? formatSize(m.sizeBytes) : null;
                        const kind = fileKind(filename, m?.contentType);
                        const KindIcon = kind.icon;
                        // Only in-session uploads carry a URL, so only those are openable.
                        const openUrl = m?.url;
                        // A type-aware icon tile — images get the image icon, PDFs the
                        // PDF icon, etc. (Drive-style, reliable — no broken thumbnails.)
                        const PreviewInner = (
                            <div className="flex flex-col items-center justify-center gap-1.5">
                                <KindIcon className={cn('w-8 h-8', kind.tint)} aria-hidden="true" />
                                <span
                                    className={cn(
                                        'text-[10px] font-semibold tracking-wide',
                                        kind.tint,
                                    )}
                                >
                                    {kind.label}
                                </span>
                            </div>
                        );
                        return (
                            <li
                                key={r.id}
                                className="group relative rounded-lg border border-border/50 dark:border-border-dark/50 bg-card dark:bg-card-primary-dark overflow-hidden hover:border-border dark:hover:border-border-dark hover:shadow-sm transition-all"
                            >
                                {/* Preview tile — Drive-style. Clickable when we
                                    have a URL (in-session uploads); otherwise a
                                    static thumbnail/type tile. */}
                                {openUrl ? (
                                    <a
                                        href={openUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={`Open ${filename}`}
                                        className={cn(
                                            'flex aspect-4/3 items-center justify-center overflow-hidden',
                                            kind.previewBg,
                                        )}
                                    >
                                        {PreviewInner}
                                    </a>
                                ) : (
                                    <div
                                        className={cn(
                                            'flex aspect-4/3 items-center justify-center overflow-hidden',
                                            kind.previewBg,
                                        )}
                                    >
                                        {PreviewInner}
                                    </div>
                                )}

                                {/* Footer — filename + meta */}
                                <div className="flex items-center gap-2 p-2.5 border-t border-border/40 dark:border-border-dark/40">
                                    <KindIcon
                                        className={cn('w-3.5 h-3.5 shrink-0', kind.tint)}
                                        aria-hidden="true"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <span
                                            className="block truncate text-xs font-medium text-text dark:text-text-dark"
                                            title={filename}
                                        >
                                            {filename}
                                        </span>
                                        <span className="block truncate text-[10px] text-text-muted dark:text-text-muted-dark">
                                            {size ? `${size} · ` : ''}
                                            {new Date(r.createdAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>

                                {/* Detach — reveals on hover, Drive-style */}
                                <button
                                    type="button"
                                    onClick={() => handleRemove(r.id)}
                                    disabled={pending}
                                    title="Detach"
                                    aria-label={`Detach ${filename}`}
                                    data-testid={testId ? `${testId}-detach-${r.id}` : undefined}
                                    className="absolute top-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-md bg-card/90 dark:bg-card-primary-dark/90 text-text-muted opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
