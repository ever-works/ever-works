'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileDiff, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { getTaskDiffAction } from '@/app/actions/tasks';
import type { TaskDiff, TaskDiffFile } from '@/lib/api/tasks';
import { safePrUrl } from './TaskPrPill';

/**
 * PR insights (kanban run cockpit M6) — the diff preview sheet.
 *
 * Opened from the `± N files` affordance on a card; a side sheet with
 * the file list (path + add/del counts) and each file's patch behind a
 * disclosure. Read-only by design — inline diff COMMENTING is
 * deliberately delegated to the git provider's own PR UI (plan 04 §1
 * non-goals), which is why every truncation and every "see the rest"
 * path links out rather than trying to paginate here.
 *
 * Rendering rules:
 *
 *  - patches render inside `<pre>` as TEXT with per-line +/- tinting; no
 *    diff library, no `dangerouslySetInnerHTML`. Repo content is
 *    third-party text on our page (plan 04 §7.3);
 *  - the server caps bytes and files and says so via `truncated`; the
 *    sheet surfaces that rather than pretending it has the whole change;
 *  - failures are keyed off the action's stable `code`, never a message
 *    (production redacts Server-Action messages).
 */

const FAILURE_COPY: Record<string, string> = {
    NOT_FOUND: 'This Task has no branch or pull request to diff yet.',
    PROVIDER_UNAVAILABLE:
        'The connected git provider cannot supply a diff. Connect a provider that supports it, or open the pull request directly.',
    DIFF_FAILED: 'The diff could not be loaded. Try again in a moment.',
};

function lineTone(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) {
        return 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/8';
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
        return 'text-red-700 dark:text-red-300 bg-red-500/8';
    }
    if (line.startsWith('@@')) return 'text-violet-600 dark:text-violet-400';
    return 'text-text-secondary dark:text-text-secondary-dark';
}

function DiffFileRow({ file }: { file: TaskDiffFile }) {
    const [open, setOpen] = useState(false);
    const lines = file.patch ? file.patch.split('\n') : [];

    return (
        <li
            data-testid="task-diff-file"
            className="border border-border/60 dark:border-border-dark/60 rounded-md overflow-hidden"
        >
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                disabled={!file.patch}
                data-testid="task-diff-file-toggle"
                className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 text-left',
                    'bg-surface-secondary/60 dark:bg-surface-secondary-dark/40',
                    file.patch ? 'hover:bg-surface-secondary' : 'cursor-default',
                )}
            >
                <span className="flex-1 truncate text-[11px] font-mono text-text dark:text-text-dark">
                    {file.path}
                </span>
                <span className="shrink-0 text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                    +{file.additions}
                </span>
                <span className="shrink-0 text-[10px] font-mono text-red-600 dark:text-red-400">
                    −{file.deletions}
                </span>
            </button>
            {file.patchOmitted && (
                <p
                    className="px-2.5 py-1 text-[10px] text-text-muted"
                    data-testid="task-diff-patch-omitted"
                >
                    Patch omitted — the response reached its size budget.
                </p>
            )}
            {open && file.patch && (
                <pre
                    data-testid="task-diff-patch"
                    className="m-0 overflow-x-auto text-[10px] leading-4 font-mono p-2"
                >
                    {lines.map((line, index) => (
                        <div key={index} className={cn('whitespace-pre', lineTone(line))}>
                            {line || ' '}
                        </div>
                    ))}
                </pre>
            )}
        </li>
    );
}

export function TaskDiffSheet({
    taskId,
    open,
    onClose,
}: {
    taskId: string;
    open: boolean;
    onClose: () => void;
}) {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<TaskDiff | null>(null);
    const [errorCode, setErrorCode] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setErrorCode(null);
        const result = await getTaskDiffAction(taskId);
        if (result.ok) {
            setData(result.data);
        } else {
            setData(null);
            setErrorCode(result.code);
        }
        setLoading(false);
    }, [taskId]);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    // Escape closes the sheet. Registered only while open so the board
    // keeps its own key handling (the `r` run shortcut) when it is not.
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const prHref = safePrUrl(data?.prUrl);

    return (
        <div
            className="fixed inset-0 z-50 flex justify-end bg-black/30"
            data-testid="task-diff-sheet-overlay"
            onClick={onClose}
        >
            <aside
                role="dialog"
                aria-label="Task changes"
                data-testid="task-diff-sheet"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-2xl h-full overflow-y-auto bg-card dark:bg-card-primary-dark border-l border-border/60 dark:border-border-dark/60 p-4"
            >
                <header className="flex items-center gap-2 mb-3">
                    <FileDiff className="w-4 h-4 text-text-muted shrink-0" />
                    <h2 className="flex-1 text-sm font-medium text-text dark:text-text-dark">
                        Changes
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        data-testid="task-diff-close"
                        className="p-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>

                {loading && (
                    <p
                        className="flex items-center gap-2 text-xs text-text-muted"
                        data-testid="task-diff-loading"
                        role="status"
                    >
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading the diff…
                    </p>
                )}

                {!loading && errorCode && (
                    <p className="text-xs text-danger" role="alert" data-testid="task-diff-error">
                        {FAILURE_COPY[errorCode] ?? FAILURE_COPY.DIFF_FAILED}
                    </p>
                )}

                {!loading && data && (
                    <>
                        <p
                            className="text-[11px] text-text-muted mb-2"
                            data-testid="task-diff-summary"
                        >
                            {data.diff.totalFiles} file{data.diff.totalFiles === 1 ? '' : 's'} ·{' '}
                            <span className="text-emerald-600 dark:text-emerald-400">
                                +{data.diff.totalAdditions}
                            </span>{' '}
                            <span className="text-red-600 dark:text-red-400">
                                −{data.diff.totalDeletions}
                            </span>
                            {data.source === 'compare' && data.baseRef && data.branchRef
                                ? ` · ${data.baseRef}…${data.branchRef}`
                                : null}
                        </p>

                        {data.diff.truncated && (
                            <p
                                className="text-[11px] text-amber-700 dark:text-amber-300 mb-2"
                                data-testid="task-diff-truncated"
                                role="status"
                            >
                                This preview is capped.{' '}
                                {prHref ? (
                                    <a
                                        href={prHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline"
                                        data-testid="task-diff-full-link"
                                    >
                                        Open the full diff on the pull request
                                    </a>
                                ) : (
                                    'Open the branch on your git provider for the full diff.'
                                )}
                                .
                            </p>
                        )}

                        {data.diff.files.length === 0 ? (
                            <p className="text-xs text-text-muted" data-testid="task-diff-empty">
                                No file changes on this branch yet.
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1.5">
                                {data.diff.files.map((file) => (
                                    <DiffFileRow key={file.path} file={file} />
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </aside>
        </div>
    );
}
