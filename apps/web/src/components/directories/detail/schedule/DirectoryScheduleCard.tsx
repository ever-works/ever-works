'use client';

import { useMemo, useState, useTransition, type ReactNode } from 'react';
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
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';

export type { ResolvedProvider };

type DirectoryScheduleCardProps = {
    schedule: DirectoryScheduleDto | null;
    errorMessage?: string | null;
    pipelineProviders?: ProviderOption[];
    activeProviders?: ResolvedProvider[];
};

const cadenceOrder = [
    DirectoryScheduleCadence.HOURLY,
    DirectoryScheduleCadence.EVERY_3_HOURS,
    DirectoryScheduleCadence.EVERY_8_HOURS,
    DirectoryScheduleCadence.EVERY_12_HOURS,
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
    errorMessage,
    pipelineProviders = [],
    activeProviders = [],
}: DirectoryScheduleCardProps) {
    const { directory } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();

    if (errorMessage) {
        return (
            <ScheduleStateCard
                title={t('title')}
                description={errorMessage}
                actionLabel={t('empty.refresh')}
                onAction={() => router.refresh()}
            />
        );
    }

    if (!schedule) {
        return (
            <ScheduleStateCard
                title={t('title')}
                description={t('empty.description')}
                actionLabel={t('empty.refresh')}
                onAction={() => router.refresh()}
            />
        );
    }

    const hasPersistedSchedule =
        schedule.cadence !== null || schedule.status !== DirectoryScheduleStatus.DISABLED;

    if (!schedule.featureEnabled && !hasPersistedSchedule) {
        return (
            <ScheduleStateCard
                title={t('summary.statusMap.disabled')}
                description={schedule.blockingReason ?? t('empty.description')}
                actionLabel={t('empty.refresh')}
                onAction={() => router.refresh()}
            />
        );
    }

    if (!hasPersistedSchedule && !schedule.canEnable) {
        return (
            <ScheduleStateCard
                title={
                    schedule.blockingCode === 'INITIAL_DIRECTORY_SETUP_REQUIRED'
                        ? t('empty.title')
                        : t('title')
                }
                description={schedule.blockingReason ?? t('empty.description')}
                actionLabel={t('empty.refresh')}
                onAction={() => router.refresh()}
            />
        );
    }

    return (
        <ScheduleForm
            directoryId={directory.id}
            schedule={schedule}
            readOnly={!schedule.featureEnabled}
            pipelineProviders={pipelineProviders}
            activeProviders={activeProviders}
        />
    );
}

function ScheduleForm({
    directoryId,
    schedule,
    readOnly,
    pipelineProviders,
    activeProviders,
}: {
    directoryId: string;
    schedule: DirectoryScheduleDto;
    readOnly: boolean;
    pipelineProviders: ProviderOption[];
    activeProviders: ResolvedProvider[];
}) {
    const { directory } = useDirectoryDetail();
    const t = useTranslations('dashboard.directoryDetail.schedule.card');
    const router = useRouter();

    const getCadenceLabel = (cadence: DirectoryScheduleCadence) => {
        switch (cadence) {
            case DirectoryScheduleCadence.HOURLY:
                return t('cadence.hourly');
            case DirectoryScheduleCadence.EVERY_3_HOURS:
                return t('cadence.every_3_hours');
            case DirectoryScheduleCadence.EVERY_8_HOURS:
                return t('cadence.every_8_hours');
            case DirectoryScheduleCadence.EVERY_12_HOURS:
                return t('cadence.every_12_hours');
            case DirectoryScheduleCadence.DAILY:
                return t('cadence.daily');
            case DirectoryScheduleCadence.WEEKLY:
                return t('cadence.weekly');
            case DirectoryScheduleCadence.MONTHLY:
                return t('cadence.monthly');
        }
    };

    const showPipelineSelector = pipelineProviders.length > 1;

    const allowances = useMemo(
        () => (schedule.allowedCadences?.length ? schedule.allowedCadences : defaultAllowances),
        [schedule.allowedCadences],
    );
    const providerOverridePipeline = schedule.providerOverrides?.pipeline;
    const initialForm = {
        enable: schedule.status === DirectoryScheduleStatus.ACTIVE,
        cadence:
            schedule.cadence ??
            allowances.find((item) => item.allowed)?.cadence ??
            DirectoryScheduleCadence.MONTHLY,
        billingMode: schedule.billingMode ?? DirectoryScheduleBillingMode.SUBSCRIPTION,
        maxFailureBeforePause: schedule.maxFailureBeforePause ?? 3,
        alwaysCreatePullRequest: schedule.alwaysCreatePullRequest ?? false,
        pipelineOverride: providerOverridePipeline ?? undefined,
    };
    const scheduleKey = JSON.stringify({
        status: schedule.status,
        cadence: schedule.cadence,
        billingMode: schedule.billingMode,
        maxFailureBeforePause: schedule.maxFailureBeforePause,
        alwaysCreatePullRequest: schedule.alwaysCreatePullRequest,
        providerOverridePipeline,
        allowances,
    });

    return (
        <ScheduleFormContent
            key={scheduleKey}
            directoryId={directoryId}
            directory={directory}
            schedule={schedule}
            readOnly={readOnly}
            allowances={allowances}
            pipelineProviders={pipelineProviders}
            activeProviders={activeProviders}
            showPipelineSelector={showPipelineSelector}
            getCadenceLabel={getCadenceLabel}
            initialForm={initialForm}
            t={t}
            router={router}
        />
    );
}

function ScheduleFormContent({
    directoryId,
    directory,
    schedule,
    readOnly,
    allowances,
    pipelineProviders,
    activeProviders,
    showPipelineSelector,
    getCadenceLabel,
    initialForm,
    t,
    router,
}: {
    directoryId: string;
    directory: ReturnType<typeof useDirectoryDetail>['directory'];
    schedule: DirectoryScheduleDto;
    readOnly: boolean;
    allowances: { cadence: DirectoryScheduleCadence; allowed: boolean }[];
    pipelineProviders: ProviderOption[];
    activeProviders: ResolvedProvider[];
    showPipelineSelector: boolean;
    getCadenceLabel: (cadence: DirectoryScheduleCadence) => string;
    initialForm: {
        enable: boolean;
        cadence: DirectoryScheduleCadence;
        billingMode: DirectoryScheduleBillingMode;
        maxFailureBeforePause: number;
        alwaysCreatePullRequest: boolean;
        pipelineOverride?: string;
    };
    t: ReturnType<typeof useTranslations<'dashboard.directoryDetail.schedule.card'>>;
    router: ReturnType<typeof useRouter>;
}) {
    const [form, setForm] = useState(initialForm);
    const [dirty, setDirty] = useState(false);

    const [isSaving, startSaving] = useTransition();
    const [isRunning, startRunning] = useTransition();

    const subscriptionsEnabled = schedule.subscriptionsEnabled;
    const readOnlyReason = readOnly ? schedule.blockingReason : null;
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
    const isGenerationRunning = directory.generateStatus?.status === 'generating';
    const anyBusy = isSaving || isRunning;
    const controlsDisabled = anyBusy || readOnly;

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
                runImmediately: !form.enable,
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

            const nextForm = { ...form, enable: !form.enable };
            setForm(nextForm);
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

            setForm(form);
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
            router.push(ROUTES.DASHBOARD_DIRECTORY_GENERATOR(directoryId));
        });
    };

    const updateWithPRElement = (
        <FieldCard label={t('fields.createPullRequest')} helper={t('fields.createPullRequestHelp')}>
            <Switch
                checked={form.alwaysCreatePullRequest}
                disabled={readOnly}
                onChange={(checked) => updateForm({ alwaysCreatePullRequest: checked })}
            />
        </FieldCard>
    );

    return (
        <section className="rounded-xl border border-card-border dark:border-border-secondary-dark bg-card dark:bg-card-primary-dark/10 p-6 space-y-6">
            <header className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                        {schedule.subscriptionsEnabled
                            ? t('subtitle.enabled')
                            : t('subtitle.disabled')}
                    </p>
                    {readOnlyReason ? (
                        <HelperPill tone="alert" icon={AlertCircle}>
                            {readOnlyReason}
                        </HelperPill>
                    ) : null}
                </div>
                <button
                    type="button"
                    onClick={toggleAutomation}
                    disabled={controlsDisabled}
                    title={isActive ? t('actions.stopAutomation') : t('actions.startAutomation')}
                    className={cn(
                        'p-2 cursor-pointer rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0',
                        'border border-border dark:border-border-dark',
                        'bg-gray-100 dark:bg-white/6',
                        isActive
                            ? 'text-danger hover:bg-gray-200 dark:hover:bg-white/12'
                            : 'text-primary hover:bg-gray-200 dark:hover:bg-white/12',
                    )}
                >
                    {isActive ? (
                        <Square className="h-4 w-4" aria-hidden />
                    ) : (
                        <PlayCircle className="h-4 w-4" aria-hidden />
                    )}
                </button>
            </header>

            {/* Summary chips */}
            <div className="grid gap-3 @sm/main:grid-cols-2 @3xl/main:grid-cols-4">
                <div className="rounded-lg border border-card-border dark:border-border-secondary-dark bg-card dark:bg-card-primary-dark/10 p-4 space-y-1">
                    <p className="text-xs uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                        {t('summary.status')}
                    </p>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                'h-1.5 w-1.5 rounded-full shrink-0',
                                isActive ? 'bg-success' : 'bg-text-muted dark:bg-text-muted-dark',
                            )}
                        />
                        <p className="text-sm font-semibold text-text dark:text-text-dark">
                            {statusLabel}
                        </p>
                    </div>
                </div>
                {summaryItems.map((item) => (
                    <SummaryChip key={item.label} label={item.label} value={item.value} />
                ))}
            </div>

            {activeProviders.length > 0 && <ActiveProvidersBar providers={activeProviders} />}

            <div className="grid gap-4 @lg/main:grid-cols-2">
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
                        disabled={readOnly}
                        onValueChange={(val) =>
                            updateForm({
                                cadence: val as DirectoryScheduleCadence,
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
                                {getCadenceLabel(cadence)}
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
                                    {getCadenceLabel(item.cadence)}
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
                        disabled={readOnly}
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
                        disabled={readOnly}
                        onChange={(value) => updateForm({ pipelineOverride: value })}
                    />
                )}

                {subscriptionsEnabled && (
                    <FieldCard label={t('fields.billing')} helper={t('fields.billingHelp')}>
                        <Select
                            value={form.billingMode}
                            disabled={readOnly}
                            onValueChange={(val) =>
                                updateForm({
                                    billingMode: val as DirectoryScheduleBillingMode,
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
                <Button onClick={saveSchedule} disabled={controlsDisabled} className="text-sm">
                    {isSaving ? t('actions.saving') : t('actions.save')}
                </Button>

                <div className="flex-1" />

                <Button
                    variant={isActive ? 'danger' : 'secondary'}
                    onClick={toggleAutomation}
                    disabled={controlsDisabled}
                    className="gap-2 text-sm"
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
                    disabled={controlsDisabled || !isActive || isGenerationRunning}
                    title={
                        readOnlyReason
                            ? readOnlyReason
                            : isGenerationRunning
                              ? 'Generation is running, please wait it to finish'
                              : !isActive
                                ? 'Schedule must be active to run now'
                                : undefined
                    }
                    className="gap-2 text-sm"
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
    disabled,
    onChange,
}: {
    providers: ProviderOption[];
    value: string | undefined;
    disabled?: boolean;
    onChange: (value: string | undefined) => void;
}) {
    const t = useTranslations('dashboard.directoryDetail.schedule.card');

    return (
        <FieldCard label={t('fields.pipeline')} helper={t('fields.pipelineHelp')}>
            <Select
                value={value ?? '__inherit__'}
                disabled={disabled}
                onValueChange={(val) => onChange(val === '__inherit__' ? undefined : val)}
            >
                <option value="__inherit__">{t('pipeline.inherit')}</option>
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
        <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-1">
            <p className="text-xs uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                {label}
            </p>
            <p className="text-sm font-semibold text-text dark:text-text-dark">{value}</p>
        </div>
    );
}

function ScheduleStateCard({
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
        <div className="rounded-2xl border border-dashed border-border dark:border-border-dark bg-card dark:bg-card-primary-dark/30 p-10 text-center space-y-4">
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
