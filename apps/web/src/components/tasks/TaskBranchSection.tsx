'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Copy, ExternalLink, GitBranch, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils/cn';
import type { Task, TaskBranchState, TaskIsolationMode } from '@/lib/api/tasks';
import {
    discardTaskBranchAction,
    resolveTaskConflictsAction,
    updateTaskAction,
} from '@/app/actions/tasks';

/**
 * Wave 2 M7 — Task detail "Branch" cockpit.
 *
 * When the Task has an isolated branch (`branchRef` set): branch name
 * with copy button, short base SHA, branch-state pill, PR link, a
 * conflict banner (listing `conflictPaths` verbatim + "Resolve
 * conflicts"), and a "Discard branch" action behind an irreversible
 * confirm.
 *
 * When the Task has no branch yet: a per-Task isolation override
 * select (inherit / on / off → `isolationMode` null / 'on' / 'off')
 * saved via the Task PATCH.
 */

const STATE_TONES: Record<TaskBranchState, string> = {
    created: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    pushed: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    'pr-open': 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    conflict: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    merged: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    discarded: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
    cleaned: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

const FALLBACK_TONE = 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300';

export function TaskBranchSection({ task }: { task: Task }) {
    if (task.branchRef) {
        return <BranchPanel task={task} />;
    }
    return <IsolationOverridePanel task={task} />;
}

function BranchPanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.branch');
    const router = useRouter();
    const [copied, setCopied] = useState(false);
    const [pendingResolve, startResolve] = useTransition();
    const [pendingDiscard, startDiscard] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const branchRef = task.branchRef as string;
    const tone = (task.branchState && STATE_TONES[task.branchState]) || FALLBACK_TONE;
    const conflictPaths = task.conflictPaths ?? [];

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(branchRef);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (permissions / insecure context) — no-op.
        }
    };

    const handleResolve = () => {
        setError(null);
        startResolve(() => {
            void (async () => {
                try {
                    await resolveTaskConflictsAction(task.id);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('resolveError'));
                }
            })();
        });
    };

    const handleDiscard = () => {
        if (!confirm(t('discardConfirm'))) return;
        setError(null);
        startDiscard(() => {
            void (async () => {
                try {
                    await discardTaskBranchAction(task.id);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('discardError'));
                }
            })();
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3"
            data-testid="task-branch-section"
        >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2">
                <GitBranch className="w-3.5 h-3.5" />
                {t('section')}
            </h2>

            {/* Conflict banner */}
            {task.branchState === 'conflict' && (
                <div
                    data-testid="task-conflict-banner"
                    className="rounded-md border border-danger/40 bg-danger/5 p-3 space-y-2"
                    role="alert"
                >
                    <p className="text-xs font-medium text-danger flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        {t('conflictTitle')}
                    </p>
                    {conflictPaths.length > 0 && (
                        <ul className="space-y-0.5">
                            {conflictPaths.map((path) => (
                                <li
                                    key={path}
                                    className="text-[11px] font-mono break-all text-text-secondary dark:text-text-secondary-dark"
                                >
                                    {path}
                                </li>
                            ))}
                        </ul>
                    )}
                    <Button
                        type="button"
                        size="sm"
                        disabled={pendingResolve || pendingDiscard}
                        onClick={handleResolve}
                        data-testid="task-resolve-conflicts"
                    >
                        {pendingResolve ? t('resolving') : t('resolve')}
                    </Button>
                </div>
            )}

            <dl className="space-y-3">
                <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
                    <dt className="text-xs text-text-muted pt-0.5">{t('branch')}</dt>
                    <dd className="min-w-0 flex items-center gap-1.5">
                        <span
                            className="text-xs font-mono break-all text-text dark:text-text-dark"
                            title={branchRef}
                        >
                            {branchRef}
                        </span>
                        <button
                            type="button"
                            onClick={handleCopy}
                            aria-label={t('copy')}
                            title={copied ? t('copied') : t('copy')}
                            className="shrink-0 text-text-muted hover:text-primary transition-colors"
                            data-testid="task-branch-copy"
                        >
                            {copied ? (
                                <Check className="w-3.5 h-3.5 text-success" />
                            ) : (
                                <Copy className="w-3.5 h-3.5" />
                            )}
                        </button>
                    </dd>
                </div>

                {task.baseSha && (
                    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
                        <dt className="text-xs text-text-muted pt-0.5">{t('baseSha')}</dt>
                        <dd className="min-w-0">
                            <span className="text-xs font-mono text-text-secondary dark:text-text-secondary-dark">
                                {task.baseSha.slice(0, 7)}
                            </span>
                        </dd>
                    </div>
                )}

                <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
                    <dt className="text-xs text-text-muted pt-0.5">{t('state')}</dt>
                    <dd className="min-w-0">
                        <span
                            className={cn(
                                'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium',
                                tone,
                            )}
                            data-testid="task-branch-state"
                        >
                            {task.branchState ?? '—'}
                        </span>
                    </dd>
                </div>

                {task.prUrl && (
                    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
                        <dt className="text-xs text-text-muted pt-0.5">{t('pullRequest')}</dt>
                        <dd className="min-w-0">
                            <a
                                href={task.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                data-testid="task-branch-pr-link"
                            >
                                {task.prNumber != null ? `#${task.prNumber}` : t('openPr')}
                                <ExternalLink className="w-3 h-3" />
                            </a>
                        </dd>
                    </div>
                )}
            </dl>

            {/* Actions / overflow area */}
            <div className="pt-2 border-t border-border/40 dark:border-border-dark/40">
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pendingResolve || pendingDiscard}
                    onClick={handleDiscard}
                    className="text-danger gap-1.5"
                    data-testid="task-discard-branch"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                    {pendingDiscard ? '…' : t('discard')}
                </Button>
            </div>

            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}

function IsolationOverridePanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.branch');
    const router = useRouter();
    const [mode, setMode] = useState<'inherit' | TaskIsolationMode>(
        task.isolationMode ?? 'inherit',
    );
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleChange = (next: string) => {
        const value = next as 'inherit' | TaskIsolationMode;
        const previous = mode;
        setMode(value);
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await updateTaskAction(task.id, {
                        isolationMode: value === 'inherit' ? null : value,
                    });
                    router.refresh();
                } catch (err) {
                    setMode(previous);
                    setError(err instanceof Error ? err.message : t('isolationSaveError'));
                }
            })();
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3"
            data-testid="task-isolation-override-section"
        >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2">
                <GitBranch className="w-3.5 h-3.5" />
                {t('isolationLabel')}
            </h2>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('isolationDescription')}
            </p>
            <Select
                value={mode}
                onValueChange={handleChange}
                disabled={pending}
                size="xs"
                data-testid="task-isolation-override"
            >
                <option value="inherit">{t('isolationInherit')}</option>
                <option value="on">{t('isolationOn')}</option>
                <option value="off">{t('isolationOff')}</option>
            </Select>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
