'use client';

import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';
import { browserApiFetch } from '@/lib/api/browser-api';
import { cn } from '@/lib/utils/cn';

/**
 * "Originals" for global Memory — upload + extraction status.
 *
 * The Memory page could read every KB document in the organization but had
 * no way to ADD one: uploads were per-Work all the way down to the schema
 * (`work_knowledge_uploads.workId` was NOT NULL), so there was nowhere to
 * put an org-scoped original. This is the client half of closing that gap;
 * it talks to `POST/GET /api/memory/uploads`.
 *
 * Deliberately mirrors the per-Work workbench Originals panel rather than
 * inventing a second visual language for the same concept — Memory is the
 * org-wide counterpart of a Work's KB, not a different kind of thing.
 *
 * **Transport (EW-786).** Both calls go through `browserApiFetch`, never
 * a raw `fetch()`. This panel is the most org-dependent surface in
 * Memory — its whole subject is "the active Organization's originals" —
 * and the BFF can only tell the API which Organization that is by
 * turning the per-tab `x-ever-workspace` selector into `X-Scope-Slug`.
 * With a raw `fetch()` the list came back `{ items: [], total: 0 }` at
 * HTTP 200 (indistinguishable from a genuinely empty org) and every
 * upload took the 422 branch below, so the panel rendered `noOrg` at a
 * user who was looking straight at their Organization.
 */

interface MemoryUpload {
    readonly id: string;
    readonly originalFilename: string;
    readonly mimeType: string;
    readonly fileSize: number | string;
    readonly extractionStatus: string;
    readonly extractionError?: string | null;
    readonly createdAt: string;
}

interface PendingUpload {
    readonly localId: string;
    readonly name: string;
    error?: string;
}

let seq = 0;
const nextLocalId = () => `mem-up-${(seq += 1)}`;

function formatSize(bytes: number | string): string {
    const n = typeof bytes === 'string' ? Number(bytes) : bytes;
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function MemoryUploadsPanel() {
    const t = useTranslations('dashboard.memoryPage.uploads');
    const [items, setItems] = useState<MemoryUpload[]>([]);
    const [pending, setPending] = useState<PendingUpload[]>([]);
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await browserApiFetch('/api/memory/uploads?limit=50', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            if (!res.ok) return;
            const body = (await res.json()) as { items?: MemoryUpload[] };
            setItems(body.items ?? []);
        } catch {
            // Best-effort: keep whatever list we already have rather than
            // blanking the panel on a transient network error.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const upload = useCallback(
        async (files: File[]) => {
            if (files.length === 0) return;
            const staged = files.map((f) => ({ localId: nextLocalId(), name: f.name }));
            setPending((prev) => [...prev, ...staged]);

            await Promise.all(
                files.map(async (file, index) => {
                    const entry = staged[index];
                    const form = new FormData();
                    form.append('file', file);
                    // Let the server pick the class from the extracted text
                    // instead of forcing everything to `freeform` — the
                    // uploader rarely knows or cares which bucket it lands in.
                    form.append('autoClassify', 'true');
                    try {
                        const res = await browserApiFetch('/api/memory/uploads', {
                            method: 'POST',
                            body: form,
                        });
                        if (!res.ok) {
                            // 422 is the "no active Organization" case and has
                            // its own copy — anything else is a generic failure.
                            const message = res.status === 422 ? t('noOrg') : t('failed');
                            setPending((prev) =>
                                prev.map((p) =>
                                    p.localId === entry.localId ? { ...p, error: message } : p,
                                ),
                            );
                            return;
                        }
                        setPending((prev) => prev.filter((p) => p.localId !== entry.localId));
                    } catch {
                        setPending((prev) =>
                            prev.map((p) =>
                                p.localId === entry.localId ? { ...p, error: t('failed') } : p,
                            ),
                        );
                    }
                }),
            );
            await refresh();
        },
        [refresh, t],
    );

    const statusLabel = (status: string): string => {
        switch (status) {
            case 'succeeded':
                return t('statusSucceeded');
            case 'running':
                return t('statusRunning');
            case 'failed':
                return t('statusFailed');
            case 'skipped':
                return t('statusSkipped');
            default:
                return t('statusPending');
        }
    };

    return (
        <div
            data-testid="memory-uploads-panel"
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                setDragging(false);
                const files = Array.from(e.dataTransfer?.files ?? []);
                if (files.length > 0) void upload(files);
            }}
            className={cn(
                'flex flex-col gap-3 rounded-lg border p-4 transition-colors',
                'bg-card dark:bg-card-primary-dark',
                dragging ? 'border-primary/60' : 'border-card-border dark:border-white/9',
            )}
        >
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <FileText
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0"
                        strokeWidth={1.5}
                    />
                    <span className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </span>
                </div>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    hidden
                    data-testid="memory-upload-input"
                    onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length > 0) void upload(files);
                        e.target.value = '';
                    }}
                />
                <button
                    type="button"
                    data-testid="memory-upload-button"
                    onClick={() => inputRef.current?.click()}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                        'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                        'text-text dark:text-text-dark hover:border-border-secondary dark:hover:border-white/20',
                    )}
                >
                    <Upload className="w-4 h-4" strokeWidth={1.5} />
                    {t('action')}
                </button>
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                {dragging ? t('dropHint') : t('subtitle')}
            </p>

            {pending.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {pending.map((p) => (
                        <li
                            key={p.localId}
                            data-testid="memory-upload-pending"
                            className="flex items-center gap-2 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {p.error ? (
                                <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                            ) : (
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                            )}
                            <span className="truncate">{p.name}</span>
                            <span className={cn(p.error && 'text-danger')}>
                                {p.error ?? t('uploading')}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {items.length === 0 && pending.length === 0 ? (
                <p
                    data-testid="memory-uploads-empty"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('empty')}
                </p>
            ) : (
                <ul className="flex flex-col divide-y divide-card-border dark:divide-white/9">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            data-testid="memory-upload-row"
                            className="flex items-center justify-between gap-3 py-2"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                {item.extractionStatus === 'succeeded' ? (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                                ) : item.extractionStatus === 'failed' ? (
                                    <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                                ) : (
                                    <FileText className="w-3.5 h-3.5 text-text-muted shrink-0" />
                                )}
                                <span className="truncate text-sm text-text dark:text-text-dark">
                                    {item.originalFilename}
                                </span>
                                <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                                    {formatSize(item.fileSize)}
                                </span>
                            </div>
                            <span
                                className="text-xs text-text-muted dark:text-text-muted-dark shrink-0"
                                title={item.extractionError ?? undefined}
                            >
                                {statusLabel(item.extractionStatus)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
