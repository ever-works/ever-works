'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Ban, RotateCcw, Wand2 } from 'lucide-react';
import {
    cancelAppProvisioningAction,
    getAppProvisioningAction,
    startAppProvisioningAction,
} from '@/app/actions/dashboard/app-provisioning';
import { Link } from '@/i18n/navigation';
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
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    APP_PROVISIONING_POLL_MS,
    isProvisioningActive,
    provisioningHeadline,
    provisioningRefusalKey,
    provisioningTriggerKey,
    type AppProvisioningState,
    type AppProvisioningTaskView,
} from '@/lib/works/app-provisioning.shared';

/**
 * APW-04 T25/T27/T36 — the App Work's **Provisioning** card on the Overview.
 *
 * Provisioning runs on the Task machinery (an `app-provision` Task, worked by an Agent),
 * so the card is that Task's summary: a headline from its status, why it was filed, the
 * Task and its pull request, and three actions — **Provision** / **Re-provision** (each
 * behind a confirm dialog; the running variant sends `restart: true` and only it does),
 * and **Cancel** (behind its own confirm). A viewer sees the state and no action
 * (ACC-04-32). While a provisioning Task is open the card re-reads every 5 s and stops
 * as soon as it is terminal (ACC-04-26). The upstream-broke banner (T36) shows when the
 * newest open Task reacts to an upstream sync that broke the smoke tests.
 *
 * `initialState` is the server's first read; `null` (the route could not be read)
 * renders nothing — the Overview never shows a provisioning error.
 */
export interface AppProvisioningCardProps {
    workId: string;
    initialState: AppProvisioningState | null;
}

type DialogKind = 'start' | 'restart' | 'cancel' | null;

export function AppProvisioningCard({ workId, initialState }: AppProvisioningCardProps) {
    const t = useTranslations('dashboard.workDetail.appProvisioning');
    const [state, setState] = useState<AppProvisioningState | null>(initialState);
    const [dialog, setDialog] = useState<DialogKind>(null);
    const [pending, setPending] = useState(false);
    const inFlight = useRef(false);

    const active = state?.active ?? null;
    const polling = isProvisioningActive(active);

    const refresh = useCallback(async () => {
        const result = await getAppProvisioningAction(workId);
        if (result.success && result.data) setState(result.data);
    }, [workId]);

    // ACC-04-26 — poll only while a provisioning Task is open; a terminal state stops it.
    useEffect(() => {
        if (!polling) return undefined;
        const timer = setInterval(() => {
            void refresh();
        }, APP_PROVISIONING_POLL_MS);
        return () => clearInterval(timer);
    }, [polling, refresh]);

    if (!state) return null;

    const headline = provisioningHeadline(state);
    const latest: AppProvisioningTaskView | null = active ?? state.recent[0] ?? null;
    const earlier = state.recent.filter((task) => task.taskId !== latest?.taskId).slice(0, 3);
    const triggerKey = provisioningTriggerKey(latest?.trigger);

    const run = async (kind: Exclude<DialogKind, null>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        try {
            const result =
                kind === 'cancel'
                    ? await cancelAppProvisioningAction(workId)
                    : await startAppProvisioningAction(
                          workId,
                          kind === 'restart' ? { restart: true } : {},
                      );
            if (result.success) {
                toast.success(t(`toasts.${kind}`));
                setDialog(null);
                await refresh();
                return;
            }
            // A start refused because one is already open reopens the running variant.
            if (kind === 'start' && result.code === 'alreadyProvisioning') {
                setDialog('restart');
                await refresh();
                return;
            }
            toast.error(t(`errors.${provisioningRefusalKey(result.code)}`));
        } catch {
            toast.error(t('errors.failed'));
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    return (
        <section
            data-testid="app-provisioning-card"
            className={cn(
                'rounded-lg p-4 space-y-3',
                'bg-card dark:bg-transparent',
                'border border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                {state.canEdit && (
                    <div className="flex items-center gap-2">
                        {polling ? (
                            <>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setDialog('restart')}
                                    disabled={pending}
                                    data-testid="app-provisioning-restart"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('actions.restart')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setDialog('cancel')}
                                    disabled={pending}
                                    data-testid="app-provisioning-cancel"
                                >
                                    <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('actions.cancel')}
                                </Button>
                            </>
                        ) : (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => setDialog('start')}
                                disabled={pending}
                                data-testid="app-provisioning-start"
                            >
                                <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
                                {latest ? t('actions.reprovision') : t('actions.provision')}
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {state.upstreamSmokeBroken && (
                <p
                    role="status"
                    data-testid="app-provisioning-banner"
                    className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-sm text-text dark:text-text-dark"
                >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {t('banner.upstreamBroke')}
                </p>
            )}

            <p
                className="text-sm text-text dark:text-text-dark"
                data-testid="app-provisioning-headline"
                data-headline={headline}
            >
                {t(`headline.${headline}`)}
            </p>

            {latest && (
                <div className="space-y-1 text-sm">
                    {triggerKey && (
                        <p className="text-text-secondary dark:text-text-secondary-dark">
                            {t(`trigger.${triggerKey}`)}
                        </p>
                    )}
                    {latest.awaitingOwner && isProvisioningActive(latest) && (
                        <p
                            className="text-text-secondary dark:text-text-secondary-dark"
                            data-testid="app-provisioning-awaiting-owner"
                        >
                            {t('awaitingOwnerNote')}
                        </p>
                    )}
                    <p className="flex flex-wrap gap-3">
                        <Link
                            href={ROUTES.DASHBOARD_TASK(latest.taskId)}
                            className="font-medium text-primary hover:underline dark:text-primary-dark"
                            data-testid="app-provisioning-task-link"
                        >
                            {t('openTask', { slug: latest.taskSlug })}
                        </Link>
                        {latest.prUrl && (
                            <a
                                href={latest.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium text-primary hover:underline dark:text-primary-dark"
                                data-testid="app-provisioning-pr-link"
                            >
                                {t('openPullRequest')}
                            </a>
                        )}
                    </p>
                </div>
            )}

            {earlier.length > 0 && (
                <ul className="space-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {earlier.map((task) => (
                        <li key={task.taskId} data-testid="app-provisioning-earlier">
                            <Link
                                href={ROUTES.DASHBOARD_TASK(task.taskId)}
                                className="hover:underline"
                            >
                                {task.taskSlug}
                            </Link>{' '}
                            · {t(`status.${statusKey(task.status)}`)}
                        </li>
                    ))}
                </ul>
            )}

            {dialog && (
                <Dialog open onOpenChange={(open) => (open ? undefined : setDialog(null))}>
                    <DialogContent className="max-w-lg">
                        <DialogClose onClose={() => setDialog(null)} />
                        <div
                            className="space-y-4"
                            data-testid="app-provisioning-dialog"
                            data-kind={dialog}
                        >
                            <DialogHeader>
                                <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                    {t(`dialog.${dialog}.title`)}
                                </DialogTitle>
                                <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t(`dialog.${dialog}.description`)}
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setDialog(null)}
                                    disabled={pending}
                                >
                                    {t('dialog.back')}
                                </Button>
                                <Button
                                    type="button"
                                    onClick={() => void run(dialog)}
                                    disabled={pending}
                                    loading={pending}
                                    data-testid="app-provisioning-confirm"
                                >
                                    {t(`dialog.${dialog}.confirm`)}
                                </Button>
                            </DialogFooter>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </section>
    );
}

/** The i18n leaf for a Task status (camelCase, no dots). */
function statusKey(status: string): string {
    switch (status) {
        case 'in_progress':
            return 'inProgress';
        case 'in_review':
            return 'inReview';
        case 'backlog':
        case 'todo':
        case 'blocked':
        case 'done':
        case 'cancelled':
            return status;
        default:
            return 'unknown';
    }
}
