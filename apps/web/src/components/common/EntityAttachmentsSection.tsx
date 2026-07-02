'use client';

import { useRef, useState, useTransition } from 'react';
import {
    File as FileIcon,
    FileArchive,
    FileAudio,
    FileImage,
    FileSpreadsheet,
    FileText,
    FileVideo,
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
function fileKind(
    filename: string,
    contentType?: string,
): { icon: typeof FileIcon; tint: string; isImage: boolean } {
    const ct = (contentType ?? '').toLowerCase();
    const ext = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
    const inExt = (list: string[]) => list.includes(ext);

    if (ct.startsWith('image/') || inExt(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']))
        return { icon: FileImage, tint: 'text-info', isImage: true };
    if (ct === 'application/pdf' || ext === 'pdf')
        return { icon: FileText, tint: 'text-danger', isImage: false };
    if (ct.startsWith('video/') || inExt(['mp4', 'mov', 'webm', 'mkv', 'avi']))
        return { icon: FileVideo, tint: 'text-primary', isImage: false };
    if (ct.startsWith('audio/') || inExt(['mp3', 'wav', 'ogg', 'flac', 'm4a']))
        return { icon: FileAudio, tint: 'text-warning', isImage: false };
    if (inExt(['zip', 'tar', 'gz', 'rar', '7z']))
        return { icon: FileArchive, tint: 'text-text-muted', isImage: false };
    if (inExt(['csv', 'xls', 'xlsx', 'ods']))
        return { icon: FileSpreadsheet, tint: 'text-success', isImage: false };
    return { icon: FileIcon, tint: 'text-text-muted', isImage: false };
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
                <ul className="mt-4 space-y-2" data-testid={testId ? `${testId}-list` : undefined}>
                    {rows.map((r) => {
                        const m = meta[r.id] ?? null;
                        const filename = m?.filename ?? r.uploadId;
                        const size = m ? formatSize(m.sizeBytes) : null;
                        const kind = fileKind(filename, m?.contentType);
                        const KindIcon = kind.icon;
                        const thumbUrl = kind.isImage ? m?.url : undefined;
                        return (
                            <li
                                key={r.id}
                                className="flex items-center gap-3 rounded-md border border-border/40 dark:border-border-dark/40 p-2.5"
                            >
                                <div className="shrink-0 w-10 h-10 rounded-md border border-border/40 dark:border-border-dark/40 bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden flex items-center justify-center">
                                    {thumbUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element -- user-uploaded URL isn't a configured next/image domain; a plain thumbnail is sufficient here.
                                        <img
                                            src={thumbUrl}
                                            alt={filename}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <KindIcon
                                            className={cn('w-4 h-4', kind.tint)}
                                            aria-hidden="true"
                                        />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    {/* Download wiring pending — the upload
                                        URL needs the user id, which we don't
                                        carry on this row. Surface filename as
                                        plain text + a tooltip until a
                                        uploadId-only resolver lands (same
                                        constraint TaskAttachmentsSection
                                        documents). */}
                                    <span
                                        className="text-sm text-text dark:text-text-dark truncate block"
                                        title="Download wiring pending"
                                    >
                                        {filename}
                                    </span>
                                    <div className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {size ?? r.uploadId.slice(0, 12) + '…'} · attached{' '}
                                        {new Date(r.createdAt).toLocaleString()}
                                    </div>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRemove(r.id)}
                                    disabled={pending}
                                    className="text-danger hover:text-danger gap-1.5"
                                    title="Detach"
                                    data-testid={testId ? `${testId}-detach-${r.id}` : undefined}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
