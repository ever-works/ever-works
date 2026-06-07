'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { History, RotateCcw, X } from 'lucide-react';
import type { KbDocumentCommitDto, KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice E — Git history modal for a KB document.
 *
 * The backend ships `GET /api/works/:id/kb/documents/:docId/history?limit=`
 * (the slice A controller, line 228) and `POST .../restore` with
 * `{ commitSha }`. This modal renders the commit log and exposes a per-row
 * "Restore" button. Restore failures surface inline at the row level so
 * the rest of the history stays usable.
 */

export interface KbGitHistoryModalProps {
    workId: string;
    document: KbDocumentDto;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Defaults to 50 — matches the spec ask. */
    limit?: number;
    /** Test seam — swap the placeholder branch on or off explicitly. */
    backendAvailable?: boolean;
}

interface HistoryResponse {
    items: KbDocumentCommitDto[];
}

const DEFAULT_LIMIT = 50;

export function KbGitHistoryModal({
    workId,
    document,
    open,
    onOpenChange,
    limit = DEFAULT_LIMIT,
    backendAvailable = true,
}: KbGitHistoryModalProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.history');

    const [commits, setCommits] = useState<KbDocumentCommitDto[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [restoredSha, setRestoredSha] = useState<string | null>(null);
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!open || !backendAvailable) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setRowErrors({});
        setRestoredSha(null);
        fetch(
            `/api/works/${encodeURIComponent(workId)}/kb/documents/${encodeURIComponent(
                document.id,
            )}/history?limit=${limit}`,
            { cache: 'no-store' },
        )
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as HistoryResponse;
            })
            .then((data) => {
                if (cancelled) return;
                setCommits(data.items ?? []);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : t('failed'));
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, backendAvailable, workId, document.id, limit, t]);

    const onRestore = useCallback(
        async (sha: string) => {
            setRestoring(sha);
            setRowErrors((prev) => {
                const next = { ...prev };
                delete next[sha];
                return next;
            });
            try {
                const res = await fetch(
                    `/api/works/${encodeURIComponent(workId)}/kb/documents/${encodeURIComponent(
                        document.id,
                    )}/restore`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ commitSha: sha }),
                    },
                );
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                setRestoredSha(sha);
            } catch (err) {
                setRowErrors((prev) => ({
                    ...prev,
                    [sha]: err instanceof Error ? err.message : t('failed'),
                }));
            } finally {
                setRestoring(null);
            }
        },
        [workId, document.id, t],
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <div data-testid="kb-workbench-history-modal">
                    <DialogHeader>
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <History className="h-4 w-4" aria-hidden="true" />
                                <DialogTitle>{t('title')}</DialogTitle>
                            </div>
                            <button
                                type="button"
                                data-testid="kb-workbench-history-modal-close"
                                aria-label={t('close')}
                                onClick={() => onOpenChange(false)}
                                className="rounded p-1 text-text-muted hover:text-text"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                    </DialogHeader>

                    {backendAvailable ? (
                        <HistoryBody
                            commits={commits}
                            loading={loading}
                            error={error}
                            restoring={restoring}
                            restoredSha={restoredSha}
                            rowErrors={rowErrors}
                            onRestore={onRestore}
                            labels={{
                                restore: t('restore'),
                                restored: t('restored'),
                                failed: t('failed'),
                                empty: t('placeholder'),
                            }}
                        />
                    ) : (
                        <PlaceholderBody
                            title={t('placeholder')}
                            description={t('placeholderDescription')}
                        />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface HistoryBodyProps {
    commits: KbDocumentCommitDto[];
    loading: boolean;
    error: string | null;
    restoring: string | null;
    restoredSha: string | null;
    rowErrors: Record<string, string>;
    onRestore: (sha: string) => void;
    labels: {
        restore: string;
        restored: string;
        failed: string;
        empty: string;
    };
}

function HistoryBody({
    commits,
    loading,
    error,
    restoring,
    restoredSha,
    rowErrors,
    onRestore,
    labels,
}: HistoryBodyProps) {
    if (loading) {
        return (
            <div
                data-testid="kb-workbench-history-modal-loading"
                role="status"
                className="flex flex-col gap-2 py-4"
            >
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-12 animate-pulse rounded-md bg-card-secondary/60 dark:bg-card-primary-dark/40"
                    />
                ))}
            </div>
        );
    }

    if (error) {
        return (
            <div
                data-testid="kb-workbench-history-modal-error"
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-300"
            >
                {labels.failed}: {error}
            </div>
        );
    }

    if (commits.length === 0) {
        return (
            <div
                data-testid="kb-workbench-history-modal-empty"
                className="px-3 py-6 text-center text-sm text-text-muted"
            >
                {labels.empty}
            </div>
        );
    }

    return (
        <ul
            data-testid="kb-workbench-history-modal-list"
            className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto py-2"
        >
            {commits.map((commit) => {
                const isRestoring = restoring === commit.sha;
                const wasRestored = restoredSha === commit.sha;
                const rowError = rowErrors[commit.sha];
                return (
                    <li
                        key={commit.sha}
                        data-testid="kb-workbench-history-modal-row"
                        data-commit-sha={commit.sha}
                        className={cn(
                            'flex flex-col gap-1 rounded-md border px-3 py-2',
                            'border-border dark:border-border-dark',
                        )}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate text-sm font-medium">
                                    {commit.message}
                                </span>
                                <span className="text-[11px] text-text-muted">
                                    {commit.authorName} · {commit.authoredAt} ·{' '}
                                    <code className="font-mono">{commit.sha.slice(0, 7)}</code>
                                </span>
                            </div>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                data-testid="kb-workbench-history-modal-restore"
                                data-commit-sha={commit.sha}
                                disabled={isRestoring}
                                onClick={() => onRestore(commit.sha)}
                            >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                <span className="ml-1">
                                    {wasRestored ? labels.restored : labels.restore}
                                </span>
                            </Button>
                        </div>
                        {rowError ? (
                            <span
                                data-testid="kb-workbench-history-modal-row-error"
                                role="status"
                                className="text-[11px] text-red-600 dark:text-red-400"
                            >
                                {rowError}
                            </span>
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

function PlaceholderBody({ title, description }: { title: string; description: string }) {
    return (
        <div
            data-testid="kb-workbench-history-modal-placeholder"
            className={cn(
                'flex flex-col gap-2 rounded-md border border-dashed',
                'border-border dark:border-border-dark p-4 text-sm text-text-muted',
            )}
        >
            <span className="font-medium text-text dark:text-text-dark">{title}</span>
            <p>{description}</p>
            <a
                href="https://evertech.atlassian.net/browse/EW-732"
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
            >
                EW-732
            </a>
        </div>
    );
}
