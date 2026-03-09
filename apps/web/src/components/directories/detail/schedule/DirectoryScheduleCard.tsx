'use client';

import { useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, CircleStop, PlayCircle, Repeat, Square } from 'lucide-react';
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
import type { ProviderOption } from '@/lib/api/types-only';
import {
    runDirectorySchedule,
    updateDirectorySchedule,
} from '@/app/actions/dashboard/directory-schedule';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { ActiveProvidersBar, FieldCard, HelperPill, type ResolvedProvider } from '../shared';

export type { ResolvedProvider };

type DirectoryScheduleCardProps = {
    schedule: DirectoryScheduleDto | null;
    pipelineProviders?: ProviderOption[];
    activeProviders?: ResolvedProvider[];
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

export function DirectoryScheduleCard({
    schedule,
    pipelineProviders = [],
    activeProviders = [],
}: DirectoryScheduleCardProps) {
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

    return (
        <ScheduleForm
            directoryId={directory.id}
            schedule={schedule}
            pipelineProviders={pipelineProviders}
            activeProviders={activeProviders}
        />
    );
}

function ScheduleForm({
    directoryId,
    schedule,
    pipelineProviders,
    activeProviders,
}: {
    directoryId: string;
    schedule: DirectoryScheduleDto;
    pipelineProviders: ProviderOption[];
    activeProviders: ResolvedProvider[];
}) {
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();

    const showPipelineSelector = pipelineProviders.length > 1;

    const allowances = useMemo(
        () => (schedule.allowedCadences?.length ? schedule.allowedCadences : defaultAllowances),
        [schedule.allowedCadences],
    );

    const deriveFormState = () => ({
        enable: schedule.status === DirectoryScheduleStatus.ACTIVE,
        cadence:
            schedule.cadence ??
            allowances.find((item) => item.allowed)?.cadence ??
            DirectoryScheduleCadence.MONTHLY,
        billingMode: schedule.billingMode ?? DirectoryScheduleBillingMode.SUBSCRIPTION,
        maxFailureBeforePause: schedule.maxFailureBeforePause ?? 3,
        alwaysCreatePullRequest: schedule.alwaysCreatePullRequest ?? false,
        pipelineOverride: schedule.providerOverrides?.pipeline ?? undefined,
    });

    const [form, setForm] = useState(deriveFormState);
    const [dirty, setDirty] = useState(false);

    // Stable serialization of object/array deps to avoid reference-equality re-fires
    const providerOverridesKey = JSON.stringify(schedule.providerOverrides ?? null);
    const allowedCadencesKey = JSON.stringify(allowances.map((a) => `${a.cadence}:${a.allowed}`));

    useEffect(() => {
        // Only sync from server when the user has no unsaved changes
        if (!dirty) {
            setForm(deriveFormState());
        }
    }, [
        schedule.status,
        schedule.cadence,
        schedule.billingMode,
        schedule.maxFailureBeforePause,
        schedule.alwaysCreatePullRequest,
        providerOverridesKey,
        allowedCadencesKey,
        dirty,
    ]);

    const [isSaving, startSaving] = useTransition();
    const [isRunning, startRunning] = useTransition();

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

    const isActive = schedule.status === DirectoryScheduleStatus.ACTIVE;
    const anyBusy = isSaving || isRunning;

    const toggleAutomation = () => {
        updateForm({ enable: !form.enable });
        // Auto-save the toggle immediately
        startSaving(async () => {
            const providerOverrides =
                form.pipelineOverride !== undefined
                    ? { pipeline: form.pipelineOverride }
                    : undefined;

            const result = await updateDirectorySchedule(directoryId, {
                enable: !form.enable,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
                alwaysCreatePullRequest: form.alwaysCreatePullRequest,
                providerOverrides,
            });

            if (!result.success) {
                // Revert on failure without marking dirty
                setForm((prev) => ({ ...prev, enable: form.enable }));
                setDirty(false);
                toast.error(result.error || t('errors.updateFailed'));
                return;
            }

            setDirty(false);
            toast.success(form.enable ? t('success.stopped') : t('success.started'));
            router.refresh();
        });
    };

    const summaryItems = [
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
        setDirty(true);
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

            const providerOverrides =
                form.pipelineOverride !== undefined
                    ? { pipeline: form.pipelineOverride }
                    : undefined;

            const result = await updateDirectorySchedule(directoryId, {
                enable: form.enable,
                cadence: form.cadence,
                billingMode: form.billingMode,
                maxFailureBeforePause: form.maxFailureBeforePause,
                alwaysCreatePullRequest: form.alwaysCreatePullRequest,
                providerOverrides,
            });

            if (!result.success) {
                toast.error(result.error || t('errors.updateFailed'));
                return;
            }

            setDirty(false);
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
            <header className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                    <p className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </p>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                        {schedule.subscriptionsEnabled
                            ? t('subtitle.enabled')
                            : t('subtitle.disabled')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleAutomation}
                    disabled={anyBusy}
                    title={isActive ? t('actions.stopAutomation') : t('actions.startAutomation')}
                    className={cn(
                        'p-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0',
                        'border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-tertiary-dark',
                        isActive
                            ? 'text-danger hover:bg-surface-tertiary dark:hover:bg-card-hover-dark'
                            : 'text-primary hover:bg-surface-tertiary dark:hover:bg-card-hover-dark',
                    )}
                >
                    {isActive ? (
                        <Square className="h-4.5 w-4.5" aria-hidden />
                    ) : (
                        <PlayCircle className="h-4.5 w-4.5" aria-hidden />
                    )}
                </button>
            </header>

            {/* Summary chips */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-1">
                    <p className="text-xs uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                        {t('summary.status')}
                    </p>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                'h-2 w-2 rounded-full shrink-0',
                                isActive ? 'bg-success' : 'bg-text-muted dark:bg-text-muted-dark',
                            )}
                        />
                        <p className="text-base font-semibold text-text dark:text-text-dark">
                            {statusLabel}
                        </p>
                    </div>
                </div>
                {summaryItems.map((item) => (
                    <SummaryChip key={item.label} label={item.label} value={item.value} />
                ))}
            </div>

            {activeProviders.length > 0 && <ActiveProvidersBar providers={activeProviders} />}

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
                                    !allowances.find((item) => item.cadence === cadence)?.allowed
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

                {showPipelineSelector && (
                    <PipelineOverrideField
                        providers={pipelineProviders}
                        value={form.pipelineOverride}
                        onChange={(value) => updateForm({ pipelineOverride: value })}
                    />
                )}

                {subscriptionsEnabled && (
                    <FieldCard label={t('fields.billing')} helper={t('fields.billingHelp')}>
                        <Select
                            value={form.billingMode}
                            onChange={(event) =>
                                updateForm({
                                    billingMode: event.target.value as DirectoryScheduleBillingMode,
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
                )}

                {updateWithPRElement}
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button onClick={saveSchedule} disabled={anyBusy}>
                    {isSaving ? t('actions.saving') : t('actions.save')}
                </Button>

                <div className="flex-1" />

                <Button
                    variant={isActive ? 'danger' : 'secondary'}
                    onClick={toggleAutomation}
                    disabled={anyBusy}
                    className="gap-2"
                >
                    {isActive ? (
                        <>
                            <CircleStop className="h-4 w-4" aria-hidden />
                            {t('actions.stopAutomation')}
                        </>
                    ) : (
                        <>
                            <PlayCircle className="h-4 w-4" aria-hidden />
                            {t('actions.startAutomation')}
                        </>
                    )}
                </Button>

                <Button
                    variant="secondary"
                    onClick={runNow}
                    disabled={anyBusy || !isActive}
                    className="gap-2"
                >
                    <PlayCircle className="h-4 w-4" aria-hidden />
                    {isRunning ? t('actions.starting') : t('actions.runNow')}
                </Button>
            </div>
        </section>
    );
}

function PipelineOverrideField({
    providers,
    value,
    onChange,
}: {
    providers: ProviderOption[];
    value: string | undefined;
    onChange: (value: string | undefined) => void;
}) {
    const t = useTranslations('dashboard.directoryDetail.schedule.card');

    return (
        <FieldCard label={t('fields.pipeline')} helper={t('fields.pipelineHelp')}>
            <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
                <option value="">{t('pipeline.inherit')}</option>
                {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.configured}>
                        {p.name}
                        {!p.configured ? ` (${t('pipeline.notConfigured')})` : ''}
                    </option>
                ))}
            </Select>
        </FieldCard>
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
