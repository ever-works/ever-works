'use client';

import { useState, useTransition } from 'react';
import {
    Check,
    ExternalLink,
    ListTodo,
    MoreVertical,
    Play,
    RotateCcw,
    TriangleAlertIcon,
    Unlink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { TaskStatus } from '@/lib/api/tasks';
import type { TaskScopeKey } from '@/lib/api/tasks.shared';
import { transitionTaskAction, unassignTaskFromScopeAction } from '@/app/actions/tasks';
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
 * The one transition each status is actually reached for, so the row menu
 * can carry a single self-labelling move.
 *
 * Every target here is legal under the server's state machine
 * (`TaskTransitionService.ALLOWED`), so the menu never offers a move the
 * API will refuse: `backlog` cannot jump straight to `in_progress`, which
 * is why its item reads "Move to To do" rather than "Start". `cancelled`
 * is terminal and deliberately absent — its rows show Open + Remove only.
 */
/** Spelled out rather than `string` so next-intl still type-checks `t(labelKey)`. */
type MoveLabelKey =
    | 'moveToTodoMenuItem'
    | 'startMenuItem'
    | 'resumeMenuItem'
    | 'markDoneMenuItem'
    | 'reopenMenuItem';

const NEXT_MOVE: Partial<
    Record<TaskStatus, { to: TaskStatus; labelKey: MoveLabelKey; Icon: LucideIcon }>
> = {
    backlog: { to: 'todo', labelKey: 'moveToTodoMenuItem', Icon: ListTodo },
    todo: { to: 'in_progress', labelKey: 'startMenuItem', Icon: Play },
    blocked: { to: 'in_progress', labelKey: 'resumeMenuItem', Icon: Play },
    in_progress: { to: 'done', labelKey: 'markDoneMenuItem', Icon: Check },
    in_review: { to: 'done', labelKey: 'markDoneMenuItem', Icon: Check },
    done: { to: 'in_progress', labelKey: 'reopenMenuItem', Icon: RotateCcw },
};

/**
 * Per-row overflow menu on a scoped Tasks tab — the inverse of the
 * "Add existing" picker in the same header.
 *
 * A menu rather than a bare icon because the row is a link: an action
 * sitting loose on a clickable card is a mis-click waiting to happen,
 * and the menu also gives the action a readable name instead of asking
 * the operator to infer one from an icon.
 *
 * Three items: Open leads (so a terminal Task's menu is never just a
 * destructive verb), then the one status move that status is actually
 * reached for, then the detach. The status move is fire-and-toast — a
 * refusal there is a server-side gate ("open blockers", "approvers
 * pending"), which the operator resolves on the Task itself, not in
 * this menu.
 *
 * The detach's confirm step follows the Mission Goals dialog, down to the
 * inline error: the API refuses to re-file a Task that heads a sub-tree
 * ("has N sub-task(s); re-file or detach them…"), and that sentence is
 * the only thing that tells the operator what to do next. It belongs in
 * front of them in the dialog, not in a toast that slides away while
 * they are still reading it.
 */
export function TaskScopeRowMenu({
    taskId,
    taskTitle,
    taskStatus,
    scopeKey,
    scopeId,
    className,
}: {
    taskId: string;
    taskTitle: string;
    taskStatus: TaskStatus;
    scopeKey: TaskScopeKey;
    scopeId: string;
    className?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.scopedSection');
    const tStatus = useTranslations('dashboard.tasksPage.status');
    const router = useRouter();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [statusPending, startStatusTransition] = useTransition();

    const move = NEXT_MOVE[taskStatus];

    const applyMove = () => {
        if (!move) return;
        startStatusTransition(async () => {
            try {
                await transitionTaskAction(taskId, move.to);
                toast.success(
                    t('statusUpdatedToast', { title: taskTitle, status: tStatus(move.to) }),
                );
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('statusUpdateFailed'));
            }
        });
    };

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
                        {/* Open leads the list because it is the item that
                            always applies, so the menu never opens onto a
                            lone red verb. */}
                        <DropdownMenuItem asChild>
                            <Link
                                href={ROUTES.DASHBOARD_TASK(taskId)}
                                className="gap-2 text-[11px] cursor-pointer"
                            >
                                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                                {t('openMenuItem')}
                            </Link>
                        </DropdownMenuItem>
                        {move && (
                            <DropdownMenuItem
                                onClick={applyMove}
                                disabled={statusPending}
                                className="gap-2 text-[11px] cursor-pointer"
                            >
                                <move.Icon className="w-3.5 h-3.5 shrink-0" />
                                {t(move.labelKey)}
                            </DropdownMenuItem>
                        )}
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
