'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { deleteTaskAction } from '@/app/actions/tasks';

/**
 * Task detail "Delete" action — `DELETE /api/tasks/:id`.
 *
 * Deleting a Task cascades to its side rows (assignees, approvers,
 * reviewers, watchers, blockers, chat, attachments, relations), so the
 * action sits behind an explicit modal confirm rather than a bare
 * click. On success we leave the now-dead detail route for the list.
 *
 * Selectors locked for tests:
 *  - `data-testid="task-delete-button"` on the trigger
 *  - `data-testid="task-delete-dialog"` on the confirm dialog
 *  - `data-testid="task-delete-confirm"` / `"task-delete-cancel"`
 */
export function TaskDeleteButton({
    taskId,
    taskSlug,
    className,
}: {
    taskId: string;
    taskSlug: string;
    className?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.detail.delete');
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startDelete] = useTransition();
    const headingId = useId();
    const bodyId = useId();

    // ESC closes the dialog (mirrors the KB delete dialog).
    useEffect(() => {
        if (!open) return;
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape' && !pending) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, pending]);

    const handleConfirm = () => {
        setError(null);
        startDelete(() => {
            void (async () => {
                try {
                    await deleteTaskAction(taskId);
                    // The detail route no longer resolves — go to the list
                    // and refresh so the deleted row drops out of the cache.
                    router.replace(ROUTES.DASHBOARD_TASKS);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('error'));
                }
            })();
        });
    };

    return (
        <>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="task-delete-button"
                aria-label={t('action')}
                className={cn('text-xs gap-1.5 text-danger hover:bg-danger/10', className)}
                onClick={() => {
                    setError(null);
                    setOpen(true);
                }}
            >
                <Trash2 className="w-3.5 h-3.5" />
                {t('action')}
            </Button>

            {open && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={headingId}
                    aria-describedby={bodyId}
                    data-testid="task-delete-dialog"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={(event) => {
                        if (event.target === event.currentTarget && !pending) setOpen(false);
                    }}
                >
                    <div className="w-full max-w-md rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-dark p-5 shadow-xl flex flex-col gap-3">
                        <header className="flex flex-col gap-1">
                            <h2
                                id={headingId}
                                className="text-base font-semibold text-text dark:text-text-dark"
                            >
                                {t('title')}
                            </h2>
                            <p
                                id={bodyId}
                                className="text-sm text-text-muted dark:text-text-muted-dark/70"
                            >
                                {t('body', { slug: taskSlug })}
                            </p>
                        </header>

                        {error && (
                            <p
                                role="alert"
                                data-testid="task-delete-error"
                                className="text-xs text-danger"
                            >
                                {error}
                            </p>
                        )}

                        <footer className="flex items-center justify-end gap-2 pt-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                data-testid="task-delete-cancel"
                                disabled={pending}
                                onClick={() => setOpen(false)}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                data-testid="task-delete-confirm"
                                disabled={pending}
                                onClick={handleConfirm}
                            >
                                {pending ? t('deleting') : t('confirm')}
                            </Button>
                        </footer>
                    </div>
                </div>
            )}
        </>
    );
}
