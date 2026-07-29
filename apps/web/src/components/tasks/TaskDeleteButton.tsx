'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { deleteTaskAction } from '@/app/actions/tasks';

// Outlined danger button — kept identical to `btnDanger` in
// components/meetings/MeetingDetailClient.tsx so the two detail-page
// delete actions stay visually in step.
const BTN_DANGER =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 dark:border-danger/20 text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

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

    const handleClose = () => {
        if (pending) return;
        setOpen(false);
        setError(null);
    };

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
            <button
                type="button"
                data-testid="task-delete-button"
                disabled={pending}
                className={cn(BTN_DANGER, 'shrink-0', className)}
                onClick={() => {
                    setError(null);
                    setOpen(true);
                }}
            >
                <Trash2 className="h-3.5 w-3.5" />
                {t('action')}
            </button>

            <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : handleClose())}>
                <DialogContent className="max-w-md">
                    <DialogClose onClose={handleClose} />
                    {/* No body section — `mb-0` keeps the confirm compact and
                        lets the footer's own `mt-6` set the single gap. */}
                    <DialogHeader className="mb-0">
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('title')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>{t('body', { slug: taskSlug })}</DialogDescription>
                    </DialogHeader>

                    {error && (
                        <p
                            role="alert"
                            data-testid="task-delete-error"
                            className="mt-4 text-xs text-danger"
                        >
                            {error}
                        </p>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="task-delete-cancel"
                            disabled={pending}
                            onClick={handleClose}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid="task-delete-confirm"
                            loading={pending}
                            onClick={handleConfirm}
                        >
                            {pending ? t('deleting') : t('confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
