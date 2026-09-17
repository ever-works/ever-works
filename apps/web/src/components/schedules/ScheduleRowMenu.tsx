'use client';

import { useState, useTransition } from 'react';
import {
    ArrowUpRight,
    Copy,
    History,
    Lightbulb,
    MoreVertical,
    Pause,
    Pencil,
    Play,
    TriangleAlertIcon,
    UserRoundCog,
    Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { pauseSchedule, resumeSchedule, runScheduleNow } from '@/app/actions/dashboard/schedules';
import type {
    ScheduleControlName,
    ScheduleControlReasonKey,
    ScheduleEntry,
    ScheduleRunNowResult,
} from '@/lib/api/schedules';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
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

type OwnerEntryKey = 'openTask' | 'openAgent' | 'openMission' | 'openWork' | 'openTriggers';

/** What the owner entry opens, named per source (never a generic "Open"). */
export function ownerEntryKey(schedule: Pick<ScheduleEntry, 'sourceType'>): OwnerEntryKey {
    switch (schedule.sourceType) {
        case 'recurring_task':
            return 'openTask';
        case 'agent_heartbeat':
            return 'openAgent';
        case 'mission_tick':
            return 'openMission';
        case 'inbound_trigger':
            return 'openTriggers';
        default:
            return 'openWork';
    }
}

/**
 * Where the history of this Schedule's fires lives. A Mission tick raises
 * Ideas rather than dispatching a Run, so it points at the Ideas it raised —
 * never at a run list that could not contain it.
 */
function historyLink(
    schedule: ScheduleEntry,
): { key: 'seePastRuns' | 'seeIdeasRaised'; href: string } | null {
    switch (schedule.sourceType) {
        case 'recurring_task':
            return { key: 'seePastRuns', href: `/tasks/${schedule.ownerId}` };
        case 'agent_heartbeat':
            return { key: 'seePastRuns', href: `/agents/${schedule.ownerId}/activity` };
        case 'mission_tick':
            return { key: 'seeIdeasRaised', href: `/missions/${schedule.ownerId}` };
        default:
            return null;
    }
}

const REFUSAL_KEYS: Record<string, 'alreadyRunning' | 'noAgent' | 'ownerArchived' | 'rateLimited'> =
    {
        SCHEDULE_ALREADY_RUNNING: 'alreadyRunning',
        SCHEDULE_NO_AGENT: 'noAgent',
        SCHEDULE_OWNER_ARCHIVED: 'ownerArchived',
        RATE_LIMITED: 'rateLimited',
    };

/**
 * The per-row menu of the Schedules workspace.
 *
 * All six controls are always listed, in the same order; one that does not
 * apply is shown DISABLED with its reason underneath, never hidden, so the
 * owner learns why instead of hunting for a missing entry. Pausing a Mission
 * tick asks first, because it pauses the whole Mission.
 */
export function ScheduleRowMenu({
    schedule,
    onChanged,
}: {
    schedule: ScheduleEntry;
    /** Called after a control succeeded, with the refreshed row when there is one. */
    onChanged?: (updated?: ScheduleEntry) => void;
}) {
    const t = useTranslations('dashboard.schedules');
    const [pending, startTransition] = useTransition();
    const [missionConfirmOpen, setMissionConfirmOpen] = useState(false);
    const controls = schedule.controls;

    const reasonFor = (control: ScheduleControlName): string | null => {
        const key: ScheduleControlReasonKey | undefined = controls?.disabledReasons[control];
        return key ? t(`controlReasons.${key}`) : null;
    };
    const allowed = (control: ScheduleControlName) => Boolean(controls?.[control]) && !pending;

    const announceRun = (result: ScheduleRunNowResult) => {
        if (result.kind === 'mission-tick') {
            toast.success(t('runNow.missionTickToast'));
            return;
        }
        if (result.parked && result.queuedReason === 'insufficient-credits') {
            toast.error(t('runNow.creditsToast'));
            return;
        }
        toast.success(result.parked ? t('runNow.parkedToast') : t('runNow.queuedToast'));
    };

    const runNow = () =>
        startTransition(async () => {
            const response = await runScheduleNow(schedule.id);
            if (response.ok) {
                announceRun(response.result);
                onChanged?.();
                return;
            }
            const refusal = REFUSAL_KEYS[response.code];
            if (refusal) toast.error(t(`runNow.refused.${refusal}`));
            else if (response.status === 503) toast.error(t('runNow.refused.noRuntime'));
            else if (response.code === 'SCHEDULE_CONTROL_UNAVAILABLE')
                toast.error(t('runNow.refused.unavailable'));
            else toast.error(t('runNow.refused.failed'));
        });

    const pause = (acknowledgeMissionPause = false) =>
        startTransition(async () => {
            const response = await pauseSchedule(schedule.id, { acknowledgeMissionPause });
            if (!response.ok) {
                toast.error(t('pauseFailed'));
                return;
            }
            setMissionConfirmOpen(false);
            toast.success(t('pauseToast'));
            onChanged?.(response.schedule);
        });

    const resume = () =>
        startTransition(async () => {
            const response = await resumeSchedule(schedule.id);
            if (!response.ok) {
                toast.error(t('resumeFailed'));
                return;
            }
            toast.success(t('resumeToast'));
            onChanged?.(response.schedule);
        });

    const onPause = () => {
        if (controls?.pauseNeedsAcknowledgement) {
            setMissionConfirmOpen(true);
            return;
        }
        pause(false);
    };

    const history = historyLink(schedule);

    const item = (
        control: ScheduleControlName,
        icon: React.ReactNode,
        label: string,
        onClick: () => void,
    ) => {
        const reason = reasonFor(control);
        return (
            <DropdownMenuItem
                key={control}
                disabled={!allowed(control)}
                onClick={onClick}
                className="items-start gap-2 text-xs"
            >
                <span className="mt-0.5 shrink-0">{icon}</span>
                <span className="flex flex-col items-start text-left">
                    <span data-testid={`schedule-control-${control}`}>{label}</span>
                    {reason && (
                        <span
                            data-testid={`schedule-control-${control}-reason`}
                            className="text-[11px] font-normal text-text-muted dark:text-text-muted-dark"
                        >
                            {reason}
                        </span>
                    )}
                </span>
            </DropdownMenuItem>
        );
    };

    return (
        <>
            <div className="w-8 shrink-0">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={t('actions.menuLabel', { name: schedule.ownerName })}
                        className={cn('h-8 w-8 cursor-pointer', pending && 'opacity-60')}
                    >
                        <MoreVertical className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                        {item(
                            'runNow',
                            <Zap className="h-3.5 w-3.5" />,
                            t('actions.runNow'),
                            runNow,
                        )}
                        {item(
                            'pause',
                            <Pause className="h-3.5 w-3.5" />,
                            t('actions.pause'),
                            onPause,
                        )}
                        {item(
                            'resume',
                            <Play className="h-3.5 w-3.5" />,
                            t('actions.resume'),
                            resume,
                        )}
                        {controls?.edit ? (
                            <DropdownMenuItem asChild className="gap-2 text-xs">
                                <Link href={schedule.ownerLink} data-testid="schedule-control-edit">
                                    <Pencil className="h-3.5 w-3.5" />
                                    {t('actions.edit')}
                                </Link>
                            </DropdownMenuItem>
                        ) : (
                            item(
                                'edit',
                                <Pencil className="h-3.5 w-3.5" />,
                                t('actions.edit'),
                                () => undefined,
                            )
                        )}
                        {item(
                            'duplicate',
                            <Copy className="h-3.5 w-3.5" />,
                            t('actions.duplicate'),
                            () => undefined,
                        )}
                        {item(
                            'reassign',
                            <UserRoundCog className="h-3.5 w-3.5" />,
                            t('actions.reassign'),
                            () => undefined,
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild className="gap-2 text-xs">
                            <Link href={schedule.ownerLink} data-testid="schedule-owner-entry">
                                <ArrowUpRight className="h-3.5 w-3.5" />
                                {t(`actions.${ownerEntryKey(schedule)}`)}
                            </Link>
                        </DropdownMenuItem>
                        {history && (
                            <DropdownMenuItem asChild className="gap-2 text-xs">
                                <Link href={history.href} data-testid="schedule-history-entry">
                                    {history.key === 'seeIdeasRaised' ? (
                                        <Lightbulb className="h-3.5 w-3.5" />
                                    ) : (
                                        <History className="h-3.5 w-3.5" />
                                    )}
                                    {t(`actions.${history.key}`)}
                                </Link>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <Dialog
                open={missionConfirmOpen}
                onOpenChange={(open) => (open || pending ? null : setMissionConfirmOpen(false))}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <div className="mb-1 flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/50">
                                <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('missionPause.confirmTitle', { name: schedule.ownerName })}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            <span data-testid="schedule-mission-pause-confirm">
                                {t('missionPause.confirmBody')}
                            </span>
                        </DialogDescription>
                    </DialogHeader>
                    <p className="mt-3 text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('missionPause.alreadyRaisedNote')}
                    </p>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => setMissionConfirmOpen(false)}
                        >
                            {t('missionPause.cancel')}
                        </Button>
                        <Link
                            href={schedule.ownerLink}
                            className="inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium text-primary hover:underline"
                        >
                            {t('missionPause.openMissionInstead')}
                        </Link>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="schedule-mission-pause-confirm-button"
                            disabled={pending}
                            onClick={() => pause(true)}
                        >
                            {t('missionPause.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
