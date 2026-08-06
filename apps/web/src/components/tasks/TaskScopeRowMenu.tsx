'use client';

import { useState, useTransition } from 'react';
import { MoreVertical, TriangleAlertIcon, Unlink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { TaskScopeKey } from '@/lib/api/tasks.shared';
import { unassignTaskFromScopeAction } from '@/app/actions/tasks';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Per-row overflow menu on a scoped Tasks tab — the inverse of the
 * "Add existing" picker in the same header.
 *
 * A menu rather than a bare icon because the row is a link: an action
 * sitting loose on a clickable card is a mis-click waiting to happen,
 * and the menu also gives the action a readable name instead of asking
 * the operator to infer one from an icon.
 *
 * The confirm step follows the Mission Goals detach dialog, down to the
 * inline error: the API refuses to re-file a Task that heads a sub-tree
 * ("has N sub-task(s); re-file or detach them…"), and that sentence is
 * the only thing that tells the operator what to do next. It belongs in
 * front of them in the dialog, not in a toast that slides away while
 * they are still reading it.
 */
export function TaskScopeRowMenu({
    taskId,
    taskTitle,
    scopeKey,
    scopeId,
    className,
}: {
    taskId: string;
    taskTitle: string;
    scopeKey: TaskScopeKey;
    scopeId: string;
    className?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.scopedSection');
    const router = useRouter();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // One reset funnel, so reopening never shows the previous attempt's
    // error. Ignored mid-flight: closing under a running request would
    // strand the spinner.
    const closeConfirm = () => {
        if (pending) return;
        setConfirmOpen(false);
        setError(null);
    };

    const confirmRemove = () => {
        setError(null);
        startTransition(async () => {
            const result = await unassignTaskFromScopeAction(taskId, scopeKey, scopeId);
            if (!result.ok) {
                setError(result.message || t('removeFailed'));
                return;
            }
            setConfirmOpen(false);
            toast.success(t('removedToast', { title: taskTitle }));
            router.refresh();
        });
    };

    return (
        <>
            <div className={cn('w-7 shrink-0', className)}>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={t('rowMenuLabel', { title: taskTitle })}
                        className="h-7 w-7 cursor-pointer"
                    >
                        <MoreVertical className="w-4 h-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem
                            onClick={() => setConfirmOpen(true)}
                            className="gap-2 text-[11px] text-danger cursor-pointer"
                        >
                            <Unlink className="w-3.5 h-3.5 shrink-0" />
                            {t('removeMenuItem')}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <Dialog open={confirmOpen} onOpenChange={(open) => (open ? null : closeConfirm())}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('confirmTitle')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            {t('confirmBody', { title: taskTitle })}
                        </DialogDescription>
                    </DialogHeader>

                    {error && (
                        <p
                            role="alert"
                            data-testid={`task-remove-error-${taskId}`}
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
                            data-testid={`task-remove-cancel-${taskId}`}
                            disabled={pending}
                            onClick={closeConfirm}
                        >
                            {t('confirmCancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid={`task-remove-confirm-${taskId}`}
                            loading={pending}
                            onClick={confirmRemove}
                        >
                            {pending ? t('confirmPending') : t('confirmSubmit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
