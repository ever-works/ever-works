'use client';

import {
    useEffect,
    useMemo,
    useState,
    useTransition,
    type ComponentType,
    type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, PauseCircle, PlayCircle, Repeat } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
} from '@/lib/api/enums';
import { DirectoryScheduleDto } from '@/lib/api/types-only';
import {
    cancelDirectorySchedule,
    runDirectorySchedule,
    updateDirectorySchedule,
} from '@/app/actions/dashboard/directory-schedule';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { useDirectoryDetail } from '../DirectoryDetailContext';

type DirectoryScheduleCardProps = {
    schedule: DirectoryScheduleDto | null;
};

const cadenceOrder = [
    DirectoryScheduleCadence.HOURLY,
    DirectoryScheduleCadence.DAILY,
    DirectoryScheduleCadence.WEEKLY,
    DirectoryScheduleCadence.MONTHLY,
];

const defaultAllowances = cadenceOrder.map((cadence) => ({
    cadence,
    allowed: true,
}));

export function DirectoryScheduleCard({ schedule }: DirectoryScheduleCardProps) {
    const { directory } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();

    if (!schedule) {
        return (
            <ScheduleEmptyState
                title={t('empty.title')}
                description={t('empty.description')}
                actionLabel={t('empty.refresh')}
                onAction={() => router.refresh()}
            />
        );
    }

    return <ScheduleForm directoryId={directory.id} schedule={schedule} />;
}

function ScheduleForm({
    directoryId,
    schedule,
}: {
    directoryId: string;
    schedule: DirectoryScheduleDto;
}) {
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();

    const allowances = useMemo(
        () => (schedule.allowedCadences?.length ? schedule.allowedCadences : defaultAllowances),
        [schedule.allowedCadences],
    );
    const [form, setForm] = useState({
        enable: schedule.status === DirectoryScheduleStatus.ACTIVE,
        cadence:
            schedule.cadence ??
            allowances.find((item) => item.allowed)?.cadence ??
            DirectoryScheduleCadence.MONTHLY,
        billingMode: schedule.billingMode ?? DirectoryScheduleBillingMode.SUBSCRIPTION,
        maxFailureBeforePause: schedule.maxFailureBeforePause ?? 3,
        alwaysCreatePullRequest: schedule.alwaysCreatePullRequest ?? false,
    });

    useEffect(() => {
        setForm({
            enable: schedule.status === DirectoryScheduleStatus.ACTIVE,
            cadence:
                schedule.cadence ??
                allowances.find((item) => item.allowed)?.cadence ??
                DirectoryScheduleCadence.MONTHLY,
            billingMode: schedule.billingMode ?? DirectoryScheduleBillingMode.SUBSCRIPTION,
            maxFailureBeforePause: schedule.maxFailureBeforePause ?? 3,
            alwaysCreatePullRequest: schedule.alwaysCreatePullRequest ?? false,
        });
    }, [
        schedule.status,
        schedule.cadence,
        schedule.billingMode,
        schedule.maxFailureBeforePause,
        schedule.alwaysCreatePullRequest,
        allowances,
    ]);

    const [isSaving, startSaving] = useTransition();
    const [isRunning, startRunning] = useTransition();
    const [isCancelling, startCancelling] = useTransition();

    const subscriptionsEnabled = schedule.subscriptionsEnabled;
    const cadenceInfo = allowances.find((item) => item.cadence === form.cadence);
    const requiresUsage = subscriptionsEnabled && cadenceInfo ? !cadenceInfo.allowed : false;

    const statusLabel = t(`summary.statusMap.${schedule.status}`);
    const planLabel =
        subscriptionsEnabled && schedule.planCode
            ? t(`plans.${schedule.planCode as 'free' | 'standard' | 'premium'}`)
            : subscriptionsEnabled
              ? t('plans.free')
              : t('plans.unmetered');

    const summaryItems = [
        { label: t('summary.status'), value: statusLabel },
        {
            label: t('summary.nextRun'),
            value: <ShowDateTime value={schedule.nextRunAt} default={t('summary.notScheduled')} />,
        },
        {
            label: t('summary.lastRun'),
            value: <ShowDateTime value={schedule.lastRunAt} default={t('summary.never')} />,
        },
        {
            label: t('summary.failures'),
            value: `${schedule.failureCount}/${form.maxFailureBeforePause}`,
        },
    ];

    const updateForm = (updates: Partial<typeof form>) => {
        setForm((prev) => ({ ...prev, ...updates }));
    };

    const saveSchedule = () => {
        startSaving(async () => {
            if (
                form.enable &&
                requiresUsage &&
                form.billingMode !== DirectoryScheduleBillingMode.USAGE
            ) {
                toast.error(t('errors.requireUsage'));
                return;
            }

            const result = await updateDirectorySchedule(directoryId, {
                enable: form.enable,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
                alwaysCreatePullRequest: form.alwaysCreatePullRequest,
            });

            if (!result.success) {
                toast.error(result.error || t('errors.updateFailed'));
                return;
            }

            toast.success(result.message || t('success.saved'));
            router.refresh();
        });
    };

    const runNow = () => {
        startRunning(async () => {
            const result = await runDirectorySchedule(directoryId);

            if (!result.success) {
                toast.error(result.error || t('errors.runFailed'));
                return;
            }

            toast.success(result.message || t('success.runStarted'));
            router.refresh();
        });
    };

    const cancelScheduleHandler = () => {
        startCancelling(async () => {
            const result = await cancelDirectorySchedule(directoryId);

            if (!result.success) {
                toast.error(result.error || t('errors.cancelFailed'));
                return;
            }

            toast.success(result.message || t('success.cancelled'));
            router.refresh();
        });
    };

    const updateWithPRElement = (
        <FieldCard label={t('fields.createPullRequest')} helper={t('fields.createPullRequestHelp')}>
            <Switch
                checked={form.alwaysCreatePullRequest}
                onChange={(checked) => updateForm({ alwaysCreatePullRequest: checked })}
            />
        </FieldCard>
    );

    return (
        <section className="rounded-2xl border border-card-border dark:border-card-border-dark bg-card dark:bg-card-dark p-6 shadow-sm space-y-6">
            <header className="space-y-2">
                <p className="text-lg font-semibold text-text dark:text-text-dark">{t('title')}</p>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                    {schedule.subscriptionsEnabled ? t('subtitle.enabled') : t('subtitle.disabled')}
                </p>
            </header>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {summaryItems.map((item) => (
                    <SummaryChip key={item.label} label={item.label} value={item.value} />
                ))}
            </div>

            <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                    <FieldCard label={t('fields.automation')} helper={t('fields.automationHelp')}>
                        <Switch
                            checked={form.enable}
                            onChange={(checked) => updateForm({ enable: checked })}
                        />
                    </FieldCard>

                    {subscriptionsEnabled ? (
                        <FieldCard label={t('fields.billing')} helper={t('fields.billingHelp')}>
                            <Select
                                value={form.billingMode}
                                onChange={(event) =>
                                    updateForm({
                                        billingMode: event.target
                                            .value as DirectoryScheduleBillingMode,
                                    })
                                }
                            >
                                <option value={DirectoryScheduleBillingMode.SUBSCRIPTION}>
                                    {t('billing.subscription')}
                                </option>
                                <option value={DirectoryScheduleBillingMode.USAGE}>
                                    {t('billing.usage')}
                                </option>
                            </Select>
                        </FieldCard>
                    ) : (
                        updateWithPRElement
                    )}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <FieldCard
                        label={t('fields.cadence')}
                        helper={
                            subscriptionsEnabled
                                ? t('fields.cadenceHelp', { plan: planLabel })
                                : t('fields.cadenceOpen')
                        }
                    >
                        <Select
                            value={form.cadence}
                            onChange={(event) =>
                                updateForm({
                                    cadence: event.target.value as DirectoryScheduleCadence,
                                })
                            }
                        >
                            {cadenceOrder.map((cadence) => (
                                <option
                                    key={cadence}
                                    value={cadence}
                                    disabled={
                                        subscriptionsEnabled &&
                                        !allowances.find((item) => item.cadence === cadence)
                                            ?.allowed
                                    }
                                >
                                    {t(`cadence.${cadence}`)}
                                </option>
                            ))}
                        </Select>

                        {subscriptionsEnabled && (
                            <>
                                {requiresUsage ? (
                                    <HelperPill tone="alert" icon={AlertCircle}>
                                        {t('usageRequired')}
                                    </HelperPill>
                                ) : (
                                    <HelperPill tone="success" icon={CheckCircle2}>
                                        {t('cadenceAllowed')}
                                    </HelperPill>
                                )}
                            </>
                        )}

                        {subscriptionsEnabled && (
                            <div className="flex flex-wrap gap-1 pt-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {allowances.map((item) => (
                                    <span
                                        key={item.cadence}
                                        className={cn(
                                            'rounded-full border px-2 py-0.5',
                                            item.allowed
                                                ? 'border-success/40 text-success'
                                                : 'border-border dark:border-border-dark text-text-secondary/70 dark:text-text-secondary-dark/70',
                                        )}
                                    >
                                        {t(`cadence.${item.cadence}`)}
                                    </span>
                                ))}
                            </div>
                        )}
                    </FieldCard>

                    <FieldCard label={t('fields.maxFailures')} helper={t('fields.maxFailuresHelp')}>
                        <Input
                            type="number"
                            min={1}
                            max={10}
                            value={form.maxFailureBeforePause}
                            onChange={(event) => {
                                const nextValue = Number(event.target.value);
                                const normalized = Number.isFinite(nextValue) ? nextValue : 1;
                                updateForm({
                                    maxFailureBeforePause: Math.min(10, Math.max(1, normalized)),
                                });
                            }}
                        />
                    </FieldCard>
                </div>

                {subscriptionsEnabled && (
                    <div className="grid gap-4 md:grid-cols-2">{updateWithPRElement}</div>
                )}
            </div>

            <div className="flex flex-wrap gap-3">
                <Button
                    variant="secondary"
                    onClick={runNow}
                    disabled={
                        isRunning ||
                        isSaving ||
                        isCancelling ||
                        schedule.status !== DirectoryScheduleStatus.ACTIVE
                    }
                    className="gap-2"
                >
                    {isRunning ? t('actions.starting') : t('actions.runNow')}
                    <PlayCircle className="h-4 w-4" aria-hidden />
                </Button>

                <Button onClick={saveSchedule} disabled={isSaving || isRunning || isCancelling}>
                    {isSaving ? t('actions.saving') : t('actions.save')}
                </Button>

                <Button
                    variant="ghost"
                    onClick={cancelScheduleHandler}
                    disabled={isSaving || isRunning || isCancelling}
                    className="gap-2"
                >
                    {isCancelling ? t('actions.cancelling') : t('actions.cancel')}
                    <PauseCircle className="h-4 w-4" aria-hidden />
                </Button>
            </div>
        </section>
    );
}

function SummaryChip({ label, value }: { label: string; value: ReactNode | string }) {
    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-1">
            <p className="text-xs uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                {label}
            </p>
            <p className="text-base font-semibold text-text dark:text-text-dark">{value}</p>
        </div>
    );
}

function FieldCard({
    label,
    helper,
    children,
}: {
    label: string;
    helper?: string;
    children: ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-3">
            <div>
                <p className="text-sm font-medium text-text dark:text-text-dark">{label}</p>
                {helper && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {helper}
                    </p>
                )}
            </div>
            {children}
        </div>
    );
}

function HelperPill({
    children,
    tone,
    icon: Icon,
}: {
    children: ReactNode;
    tone: 'success' | 'alert';
    icon: ComponentType<{ className?: string }>;
}) {
    return (
        <span
            className={cn(
                'mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
                tone === 'success'
                    ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive',
            )}
        >
            <Icon className="h-4 w-4" aria-hidden />
            {children}
        </span>
    );
}

function ScheduleEmptyState({
    title,
    description,
    actionLabel,
    onAction,
}: {
    title: string;
    description: string;
    actionLabel: string;
    onAction: () => void;
}) {
    return (
        <div className="rounded-2xl border border-dashed border-border dark:border-border-dark bg-card dark:bg-card-dark p-10 text-center space-y-4">
            <Repeat
                className="mx-auto h-10 w-10 text-text-secondary dark:text-text-secondary-dark"
                aria-hidden
            />
            <p className="text-xl font-semibold text-text dark:text-text-dark">{title}</p>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-xl mx-auto">
                {description}
            </p>
            <Button
                variant="secondary"
                onClick={onAction}
                className="inline-flex items-center gap-2"
            >
                {actionLabel}
            </Button>
        </div>
    );
}
