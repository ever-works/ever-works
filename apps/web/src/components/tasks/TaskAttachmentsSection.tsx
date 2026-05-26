'use client';

import { useRef, useState, useTransition } from 'react';
import { Paperclip, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { attachUploadAction, detachAttachmentAction } from '@/app/actions/tasks';
import type { TaskAttachmentRow } from '@/lib/api/tasks';

interface UploadedFileMeta {
    filename: string;
    sizeBytes: number;
    contentType: string;
}

interface Props {
    taskId: string;
    initial: TaskAttachmentRow[];
}

/**
 * FU-5 — task attachments panel mounted between transitions and
 * conversation on TaskDetailClient.
 *
 * Drag-and-drop file picker uploads via the proxy route at
 * `/api/uploads` (which forwards to the NestJS multipart endpoint),
 * then wires the returned uploadId into the Task via the existing
 * `POST /api/tasks/:id/attachments` endpoint. Filename + size are
 * captured client-side so the list reads as something more useful
 * than a bare uuid even before the joined upload metadata lands on
 * the API response.
 *
 * Image-only upload restriction comes from the api-side controller —
 * we surface the upstream error verbatim so the user sees the right
 * 413 / 415 / 400 message instead of a generic toast.
 */
export function TaskAttachmentsSection({ taskId, initial }: Props) {
    const [rows, setRows] = useState<TaskAttachmentRow[]>(initial);
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
                        const form = new FormData();
                        form.append('file', file);
                        const resp = await fetch('/api/uploads', {
                            method: 'POST',
                            body: form,
                        });
                        if (!resp.ok) {
                            const text = await resp.text().catch(() => '');
                            throw new Error(text || `Upload failed (${resp.status})`);
                        }
                        const body = (await resp.json()) as { id?: string };
                        if (!body?.id) {
                            throw new Error('Upload succeeded but response missing id field.');
                        }
                        const row = await attachUploadAction(taskId, body.id);
                        setRows((prev) => [row, ...prev]);
                        setMeta((prev) => ({
                            ...prev,
                            [row.id]: {
                                filename: file.name,
                                sizeBytes: file.size,
                                contentType: file.type,
                            },
                        }));
                    } catch (err) {
                        setError(err instanceof Error ? err.message : 'Upload failed');
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
                    await detachAttachmentAction(taskId, attachmentId);
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
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
            <header className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Attachments</h2>
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
                >
                    {busy ? 'Uploading…' : 'Browse'}
                </Button>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    onChange={handleSelect}
                    className="hidden"
                />
            </div>

            {error && (
                <p className="text-xs text-danger mt-2" role="alert">
                    {error}
                </p>
            )}

            {rows.length > 0 && (
                <ul className="mt-4 space-y-2">
                    {rows.map((r) => {
                        const m = meta[r.id] ?? r.upload ?? null;
                        const filename = m && 'filename' in m ? m.filename : r.uploadId;
                        const size =
                            m && 'sizeBytes' in m && typeof m.sizeBytes === 'number'
                                ? formatSize(m.sizeBytes)
                                : null;
                        return (
                            <li
                                key={r.id}
                                className="flex items-center gap-3 rounded-md border border-border/40 dark:border-border-dark/40 p-2.5"
                            >
                                <Paperclip className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0" />
                                <div className="min-w-0 flex-1">
                                    {/* FU-5 review fix (greptile + codex P1):
                                        the previous `<a href="/api/uploads/{uploadId}">`
                                        404'd because the existing backend GET is
                                        `/:userId/:filename` and there's no resolver
                                        that turns an uploadId alone into a download.
                                        Surface filename as plain text + a tooltip
                                        until the resolver lands — upload + detach
                                        still work end-to-end. */}
                                    <span
                                        className="text-sm text-text dark:text-text-dark truncate block"
                                        title="Download wiring pending — see FOLLOWUP-PROGRESS"
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
