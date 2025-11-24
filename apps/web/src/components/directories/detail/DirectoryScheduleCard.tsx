'use client';

import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@/lib/api/enums';
import { DirectoryScheduleDto } from '@/lib/api/types-only';
import { useRouter } from 'next/navigation';
import {
    runDirectorySchedule,
    updateDirectorySchedule,
} from '@/app/actions/dashboard/directory-schedule';
import { useTranslations } from 'next-intl';

type DirectoryScheduleCardProps = {
    directoryId: string;
    schedule: DirectoryScheduleDto | null;
};

const cadenceOrder = [
    DirectoryScheduleCadence.HOURLY,
    DirectoryScheduleCadence.DAILY,
    DirectoryScheduleCadence.WEEKLY,
    DirectoryScheduleCadence.MONTHLY,
];

export function DirectoryScheduleCard({ directoryId, schedule }: DirectoryScheduleCardProps) {
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();
    const initialStatus = schedule?.status || DirectoryScheduleStatus.DISABLED;
    const [form, setForm] = useState({
        enable: initialStatus === DirectoryScheduleStatus.ACTIVE,
        cadence: schedule?.cadence ?? DirectoryScheduleCadence.MONTHLY,
        billingMode: schedule?.billingMode || DirectoryScheduleBillingMode.SUBSCRIPTION,
        maxFailureBeforePause: schedule?.maxFailureBeforePause || 3,
    });
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isSaving, startSaving] = useTransition();
    const [isRunning, startRunning] = useTransition();

    const cadenceInfo = schedule?.allowedCadences?.find((item) => item.cadence === form.cadence);
    const requiresUsage = cadenceInfo ? !cadenceInfo.allowed : false;

    const nextRunDisplay = useMemo(() => formatDate(schedule?.nextRunAt), [schedule?.nextRunAt]);
    const lastRunDisplay = useMemo(() => formatDate(schedule?.lastRunAt), [schedule?.lastRunAt]);

    const planLabel = (() => {
        const known = ['free', 'standard', 'premium'] as const;
        if (schedule?.planCode && (known as readonly string[]).includes(schedule.planCode)) {
            return t(`plans.${schedule.planCode as 'free' | 'standard' | 'premium'}`);
        }
        return schedule?.planCode || t('plans.free');
    })();

    const updateForm = (updates: Partial<typeof form>) => {
        setForm((prev) => ({ ...prev, ...updates }));
        setMessage(null);
        setError(null);
    };

    const saveSchedule = () => {
        startSaving(async () => {
            setError(null);
            setMessage(null);

            if (
                form.enable &&
                requiresUsage &&
                form.billingMode !== DirectoryScheduleBillingMode.USAGE
            ) {
                setError(t('errors.requireUsage'));
                return;
            }

            const result = await updateDirectorySchedule(directoryId, {
                enable: form.enable,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
            });

            if (!result.success) {
                setError(result.error || t('errors.updateFailed'));
                return;
            }

            setMessage(result.message || t('success.saved'));
            router.refresh();
        });
    };

    const runNow = () => {
        startRunning(async () => {
            setError(null);
            setMessage(null);

            const result = await runDirectorySchedule(directoryId);

            if (!result.success) {
                setError(result.error || t('errors.runFailed'));
                return;
            }

            setMessage(result.message || t('success.runStarted'));
            router.refresh();
        });
    };

    const cancelSchedule = () => {
        startSaving(async () => {
            setError(null);
            setMessage(null);

            if (form.enable) {
                setError(t('errors.disableBeforeCancel'));
                return;
            }

            const result = await updateDirectorySchedule(directoryId, {
                enable: false,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
            });

            if (!result.success) {
                setError(result.error || t('errors.cancelFailed'));
                return;
            }

            setMessage(result.message || t('success.cancelled'));
            router.refresh();
        });
    };

    const cardClass = cn(
        'bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-xl p-6 shadow-sm space-y-6',
    );

    return (
        <div className={cardClass}>
            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <p className="text-xl font-semibold">{t('title')}</p>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-xl">
                            {t('subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-text-secondary dark:text-text-secondary-dark">
                                {form.enable ? t('labels.enabled') : t('labels.disabled')}
                            </span>
                            <Switch
                                checked={form.enable}
                                onChange={(checked) => updateForm({ enable: checked })}
                            />
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-text-secondary dark:text-text-secondary-dark">
                                {t('labels.billing')}
                            </span>
                            <Select
                                value={form.billingMode}
                                onChange={(e) =>
                                    updateForm({
                                        billingMode: e.target.value as DirectoryScheduleBillingMode,
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
                        </div>
                    </div>
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('labels.cadence')}
                        </label>
                        <Select
                            value={form.cadence}
                            onChange={(event) =>
                                updateForm({
                                    cadence: event.target.value as DirectoryScheduleCadence,
                                })
                            }
                        >
                            {(
                                schedule?.allowedCadences ||
                                cadenceOrder.map((value) => ({ cadence: value, allowed: true }))
                            )
                                .map((item) => ({
                                    value: item.cadence,
                                    label: t(`cadence.${item.cadence}`),
                                    disabled: !item.allowed,
                                }))
                                .map((item) => (
                                    <option
                                        key={item.value}
                                        value={item.value}
                                        disabled={item.disabled}
                                    >
                                        {item.label}
                                    </option>
                                ))}
                        </Select>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('planNote', {
                                plan: planLabel,
                            })}{' '}
                            {requiresUsage ? t('usageRequired') : t('cadenceAllowed')}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('labels.maxFailures')}
                        </label>
                        <Input
                            type="number"
                            min={1}
                            max={10}
                            value={form.maxFailureBeforePause}
                            onChange={(e) =>
                                updateForm({
                                    maxFailureBeforePause: parseInt(e.target.value, 10) || 1,
                                })
                            }
                        />
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('help.maxFailures')}
                        </p>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-2 gap-3 bg-muted/60 dark:bg-muted-dark/60 rounded-lg p-3">
                        <InfoStat
                            label={t('stats.nextRun')}
                            value={nextRunDisplay || t('stats.notScheduled')}
                        />
                        <InfoStat
                            label={t('stats.lastRun')}
                            value={lastRunDisplay || t('stats.never')}
                        />
                        <InfoStat
                            label={t('stats.status')}
                            value={schedule?.status || t('stats.disabled')}
                        />
                        <InfoStat
                            label={t('stats.failures')}
                            value={`${schedule?.failureCount ?? 0}/${form.maxFailureBeforePause}`}
                        />
                    </div>
                </div>
            </div>

            {schedule && (
                <div className="flex flex-wrap gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                    <Badge>{t('labels.plan', { plan: planLabel })}</Badge>
                    <Badge>
                        {t('labels.nextRun', { next: nextRunDisplay || t('stats.notScheduled') })}
                    </Badge>
                    <Badge>
                        {t('labels.lastRun', { last: lastRunDisplay || t('stats.never') })}
                    </Badge>
                </div>
            )}

            <div className="flex flex-wrap gap-3">
                <Button onClick={saveSchedule} disabled={isSaving || isRunning}>
                    {isSaving ? t('actions.saving') : t('actions.save')}
                </Button>
                <Button variant="secondary" onClick={runNow} disabled={isSaving || isRunning}>
                    {isRunning ? t('actions.starting') : t('actions.runNow')}
                </Button>
                <Button variant="ghost" onClick={cancelSchedule} disabled={isSaving || isRunning}>
                    {t('actions.cancel')}
                </Button>
            </div>

            {(message || error) && (
                <div
                    className={cn(
                        'text-sm rounded-md px-3 py-2',
                        error
                            ? 'bg-destructive/10 text-destructive border border-destructive/40'
                            : 'bg-success/10 text-success border border-success/40',
                    )}
                >
                    {error || message}
                </div>
            )}
        </div>
    );
}

function Badge({ children }: { children: React.ReactNode }) {
    return (
        <span className="rounded-full bg-muted dark:bg-muted-dark px-3 py-1 font-medium text-text-secondary dark:text-text-secondary-dark">
            {children}
        </span>
    );
}

function InfoStat({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                {label}
            </p>
            <p className="text-sm font-medium text-text dark:text-text-dark">{value}</p>
        </div>
    );
}

function formatDate(value?: string | null) {
    if (!value) {
        return null;
    }

    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(new Date(value));
    } catch {
        return value;
    }
}
