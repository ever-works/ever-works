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

type DirectoryScheduleCardProps = {
    directoryId: string;
    schedule: DirectoryScheduleDto | null;
};

const cadenceLabels: Record<DirectoryScheduleCadence, string> = {
    [DirectoryScheduleCadence.HOURLY]: 'Every hour',
    [DirectoryScheduleCadence.DAILY]: 'Every day',
    [DirectoryScheduleCadence.WEEKLY]: 'Every week',
    [DirectoryScheduleCadence.MONTHLY]: 'Every month',
};

const planLabels: Record<string, string> = {
    free: 'Free',
    standard: 'Standard',
    premium: 'Premium',
};

export function DirectoryScheduleCard({ directoryId, schedule }: DirectoryScheduleCardProps) {
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
    const planLabel = planLabels[schedule?.planCode || 'free'] || schedule?.planCode || 'Free';

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
                setError('Enable pay-per-use billing to use this cadence.');
                return;
            }

            const result = await updateDirectorySchedule(directoryId, {
                enable: form.enable,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
            });

            if (!result.success) {
                setError(result.error || 'Failed to update schedule.');
                return;
            }

            setMessage(result.message || 'Schedule updated.');
            router.refresh();
        });
    };

    const runNow = () => {
        startRunning(async () => {
            setError(null);
            setMessage(null);

            const result = await runDirectorySchedule(directoryId);

            if (!result.success) {
                setError(result.error || 'Failed to trigger run.');
                return;
            }

            setMessage(
                result.message || 'Scheduled run started. This page will update once it completes.',
            );
            router.refresh();
        });
    };

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        Scheduled updates
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        Automate directory updates on a cadence.
                    </p>
                </div>
                <span className="px-2 py-1 rounded-full text-xs font-semibold bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                    {planLabel}
                </span>
            </div>

            {schedule ? (
                <div className="grid md:grid-cols-3 gap-4 mb-6 text-sm">
                    <ScheduleStat
                        label="Next run"
                        value={nextRunDisplay || 'Not scheduled'}
                        muted={!nextRunDisplay}
                    />
                    <ScheduleStat
                        label="Last run"
                        value={lastRunDisplay || 'Not available'}
                        muted={!lastRunDisplay}
                        status={schedule.lastRunStatus}
                    />
                    <ScheduleStat
                        label="Status"
                        value={formatStatus(schedule.status)}
                        muted={schedule.status === DirectoryScheduleStatus.DISABLED}
                    />
                </div>
            ) : (
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-6">
                    No schedule configured yet.
                </p>
            )}

            <div className="space-y-5">
                <Switch
                    label="Enable scheduled updates"
                    checked={form.enable}
                    onChange={(checked) => updateForm({ enable: checked })}
                    helperText="When enabled, updates run automatically based on the cadence below."
                />

                <Select
                    label="Update cadence"
                    value={form.cadence}
                    disabled={!form.enable}
                    onChange={(event) =>
                        updateForm({ cadence: event.target.value as DirectoryScheduleCadence })
                    }
                >
                    {schedule?.allowedCadences?.map((item) => (
                        <option key={item.cadence} value={item.cadence} disabled={!item.allowed}>
                            {cadenceLabels[item.cadence]}
                            {!item.allowed ? ' (Upgrade required)' : ''}
                        </option>
                    )) || cadenceOptionsFallback()}
                </Select>

                {requiresUsage && (
                    <div className="rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/30 p-3 text-sm text-amber-800 dark:text-amber-200">
                        This cadence isn&apos;t covered by your plan. Enable pay-per-use billing to
                        run it on demand.
                    </div>
                )}

                <Switch
                    label="Bill per run"
                    checked={form.billingMode === DirectoryScheduleBillingMode.USAGE}
                    onChange={(checked) =>
                        updateForm({
                            billingMode: checked
                                ? DirectoryScheduleBillingMode.USAGE
                                : DirectoryScheduleBillingMode.SUBSCRIPTION,
                        })
                    }
                    helperText="Pay only when the schedule runs. Required for cadences outside your plan."
                    disabled={!form.enable}
                />

                <div className="grid md:grid-cols-2 gap-4">
                    <Input
                        type="number"
                        min={1}
                        max={10}
                        label="Pause after failures"
                        helperText="Automatically pause if runs fail in a row."
                        value={form.maxFailureBeforePause}
                        onChange={(event) => {
                            const parsed = parseInt(event.target.value || '1', 10);
                            const clamped = Number.isNaN(parsed)
                                ? 1
                                : Math.min(10, Math.max(1, parsed));
                            updateForm({ maxFailureBeforePause: clamped });
                        }}
                    />
                    <div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mb-1">
                            Allowed cadences
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {(schedule?.allowedCadences || []).map((cadence) => (
                                <span
                                    key={cadence.cadence}
                                    className={cn(
                                        'px-2 py-1 rounded-full text-xs font-medium border',
                                        cadence.allowed
                                            ? 'bg-primary/10 text-primary border-primary/30'
                                            : 'bg-transparent text-text-muted dark:text-text-muted-dark border-border dark:border-border-dark',
                                    )}
                                >
                                    {cadenceLabels[cadence.cadence]}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {message && (
                <p className="text-sm text-emerald-600 dark:text-emerald-300 mt-4" role="status">
                    {message}
                </p>
            )}
            {error && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-4" role="alert">
                    {error}
                </p>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
                <Button onClick={saveSchedule} disabled={isSaving || !schedule}>
                    {isSaving ? 'Saving...' : 'Save schedule'}
                </Button>
                <Button
                    variant="secondary"
                    onClick={runNow}
                    disabled={
                        isRunning || !schedule || schedule.status !== DirectoryScheduleStatus.ACTIVE
                    }
                >
                    {isRunning ? 'Starting...' : 'Run now'}
                </Button>
            </div>
        </div>
    );
}

function ScheduleStat({
    label,
    value,
    muted,
    status,
}: {
    label: string;
    value: string;
    muted?: boolean;
    status?: GenerateStatusType | null;
}) {
    let badge: string | null = null;
    if (status === GenerateStatusType.ERROR) {
        badge = 'Failed';
    }
    if (status === GenerateStatusType.GENERATED) {
        badge = 'Success';
    }

    return (
        <div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-1">{label}</p>
            <p
                className={cn(
                    'text-sm font-medium text-text dark:text-text-dark',
                    muted && 'text-text-muted dark:text-text-muted-dark',
                )}
            >
                {value}
            </p>
            {badge && (
                <span
                    className={cn(
                        'inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold mt-1',
                        badge === 'Failed'
                            ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200',
                    )}
                >
                    {badge}
                </span>
            )}
        </div>
    );
}

function cadenceOptionsFallback() {
    return Object.values(DirectoryScheduleCadence).map((value) => (
        <option key={value} value={value}>
            {cadenceLabels[value]}
        </option>
    ));
}

function formatStatus(status: DirectoryScheduleStatus) {
    switch (status) {
        case DirectoryScheduleStatus.ACTIVE:
            return 'Active';
        case DirectoryScheduleStatus.PAUSED:
            return 'Paused';
        case DirectoryScheduleStatus.CANCELED:
            return 'Cancelled';
        default:
            return 'Disabled';
    }
}

function formatDate(value?: string | null) {
    if (!value) {
        return null;
    }

    try {
        return new Date(value).toLocaleString();
    } catch {
        return value;
    }
}
