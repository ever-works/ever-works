'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    getKbDocumentHistoryAction,
    restoreKbDocumentAction,
} from '@/app/actions/works/kb-history';
import type { KbDocumentCommitDto } from '@ever-works/contracts';

interface KbHistoryDialogProps {
    workId: string;
    docId: string;
    /** Doc path used for `revalidatePath` after a successful restore. */
    path: string;
    open: boolean;
    onClose: () => void;
}

type FetchState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; items: KbDocumentCommitDto[] }
    | { status: 'error'; error: string };

/**
 * EW-641 Phase 1B/d row 18c — restore-from-history dialog.
 *
 * Renders a modal listing commits that touched the doc's `.md` body,
 * newest first. Click → confirm → POST `/restore { commitSha }`.
 *
 * Loading + error + empty + ready states are all explicit. The
 * "click → confirm" is a two-step interaction so the destructive
 * action (overwriting the doc body) requires a deliberate second
 * click rather than firing on a stray row select.
 *
 * Selectors locked for Playwright A12-A17:
 *  - `kb-history-dialog` (root, `data-open=true`)
 *  - `kb-history-empty` (when items.length === 0)
 *  - `kb-history-loading` / `kb-history-error`
 *  - `kb-history-row` (per commit, with `data-sha` + `data-active`)
 *  - `kb-history-restore-confirm` (the confirmation button)
 */
export function KbHistoryDialog({ workId, docId, path, open, onClose }: KbHistoryDialogProps) {
    const t = useTranslations('dashboard.workDetail.kb.history');
    const router = useRouter();
    const [state, setState] = useState<FetchState>({ status: 'idle' });
    const [activeSha, setActiveSha] = useState<string | null>(null);
    const [isRestoring, startRestore] = useTransition();
    const [restoreError, setRestoreError] = useState<string | null>(null);

    // Fetch on open; reset state on close.
    useEffect(() => {
        if (!open) {
            setState({ status: 'idle' });
            setActiveSha(null);
            setRestoreError(null);
            return;
        }
        let cancelled = false;
        setState({ status: 'loading' });
        void (async () => {
            const result = await getKbDocumentHistoryAction({ workId, docId });
            if (cancelled) return;
            if (!result.success || !result.data) {
                setState({
                    status: 'error',
                    error: result.error ?? 'Failed to load history',
                });
                return;
            }
            setState({ status: 'ready', items: result.data.items });
        })();
        return () => {
            cancelled = true;
        };
    }, [open, workId, docId]);

    const onConfirmRestore = useCallback(() => {
        if (!activeSha) return;
        setRestoreError(null);
        startRestore(async () => {
            const result = await restoreKbDocumentAction({
                workId,
                docId,
                path,
                commitSha: activeSha,
            });
            if (!result.success) {
                setRestoreError(result.error ?? 'Restore failed');
                return;
            }
            router.refresh();
            onClose();
        });
    }, [activeSha, workId, docId, path, router, onClose]);

    if (!open) return null;

    const formatRelative = (iso: string) => {
        try {
            return formatDistanceToNow(new Date(iso), { addSuffix: true });
        } catch {
            return iso;
        }
    };

    return (
        <div
            data-testid="kb-history-dialog"
            data-open="true"
            role="dialog"
            aria-modal="true"
            aria-label={t('dialogLabel')}
            className={cn(
                'fixed inset-0 z-50 flex items-start justify-center',
                'bg-black/40 px-4 pt-[12vh]',
            )}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className={cn(
                    'w-full max-w-xl rounded-lg border shadow-2xl',
                    // EW-639 dark-theme fix: see KbClassifyModal for context.
                    // `card-primary-dark` is intentionally translucent
                    // (#ffffff08) — wrong for a modal panel. `card-dark`
                    // (#1e293b) is the solid elevated-surface convention.
                    'border-border bg-card dark:border-border-dark dark:bg-card-dark',
                    'flex flex-col gap-2 p-4',
                )}
            >
                <header className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <button
                        type="button"
                        data-testid="kb-history-close"
                        onClick={onClose}
                        aria-label={t('close')}
                        className="rounded p-1 text-text-muted hover:bg-card-hover dark:text-text-muted-dark/70 dark:hover:bg-card-primary-dark/40"
                    >
                        ✕
                    </button>
                </header>

                <div className="max-h-[60vh] overflow-y-auto">
                    {state.status === 'loading' ? (
                        <p
                            data-testid="kb-history-loading"
                            className="px-3 py-6 text-center text-xs text-text-muted dark:text-text-muted-dark/70"
                        >
                            {t('loading')}
                        </p>
                    ) : null}
                    {state.status === 'error' ? (
                        <p
                            data-testid="kb-history-error"
                            className="px-3 py-6 text-center text-xs text-red-600 dark:text-red-400"
                        >
                            {t('error', { error: state.error })}
                        </p>
                    ) : null}
                    {state.status === 'ready' && state.items.length === 0 ? (
                        <p
                            data-testid="kb-history-empty"
                            className="px-3 py-6 text-center text-xs text-text-muted dark:text-text-muted-dark/70"
                        >
                            {t('empty')}
                        </p>
                    ) : null}
                    {state.status === 'ready' && state.items.length > 0 ? (
                        <ul role="listbox" aria-label={t('dialogLabel')} className="flex flex-col">
                            {state.items.map((commit) => {
                                const isActive = commit.sha === activeSha;
                                const shortSha = commit.sha.slice(0, 7);
                                return (
                                    <li key={commit.sha}>
                                        <button
                                            type="button"
                                            data-testid="kb-history-row"
                                            data-sha={commit.sha}
                                            data-active={isActive ? 'true' : 'false'}
                                            role="option"
                                            aria-selected={isActive}
                                            onClick={() => setActiveSha(commit.sha)}
                                            className={cn(
                                                'flex w-full flex-col items-start gap-1 rounded px-3 py-2 text-left text-sm',
                                                isActive
                                                    ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                                    : 'text-text-secondary hover:bg-card-hover dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40',
                                            )}
                                        >
                                            <div className="flex w-full items-center gap-2">
                                                <span className="font-mono text-[11px] text-text-muted dark:text-text-muted-dark/60">
                                                    {shortSha}
                                                </span>
                                                <span className="grow truncate">
                                                    {commit.message}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px] text-text-muted dark:text-text-muted-dark/60">
                                                <span>{commit.authorName}</span>
                                                <span>·</span>
                                                <span>{formatRelative(commit.authoredAt)}</span>
                                            </div>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                </div>

                {state.status === 'ready' && state.items.length > 0 ? (
                    <footer className="flex items-center justify-end gap-2 border-t border-border pt-2 dark:border-border-dark">
                        {restoreError ? (
                            <p
                                data-testid="kb-history-restore-error"
                                className="grow text-xs text-red-600 dark:text-red-400"
                            >
                                {restoreError}
                            </p>
                        ) : null}
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={onClose}
                            disabled={isRestoring}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="kb-history-restore-confirm"
                            disabled={activeSha === null || isRestoring}
                            aria-busy={isRestoring ? 'true' : undefined}
                            onClick={onConfirmRestore}
                        >
                            {isRestoring
                                ? t('restoring')
                                : t('restore', {
                                      sha: activeSha ? activeSha.slice(0, 7) : '',
                                  })}
                        </Button>
                    </footer>
                ) : null}
            </div>
        </div>
    );
}
