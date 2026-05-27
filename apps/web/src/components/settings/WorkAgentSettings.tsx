'use client';

import { useEffect, useState, useTransition } from 'react';
import type { ComponentType } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
    Bot,
    CircleStop,
    Clock,
    ListChecks,
    Play,
    RotateCcw,
    ShieldCheck,
    Sparkles,
    Wallet,
    Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    cancelWorkAgentGoalAction,
    createWorkAgentGoalAction,
    updateWorkAgentPreferencesAction,
} from '@/app/actions/settings/work-agent';
import type {
    WorkAgentGoal,
    WorkAgentPreferences,
    WorkAgentRun,
    WorkAgentRunLog,
} from '@/lib/api/work-agent';
import {
    DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS,
    DEFAULT_AUTOBUILD_THROTTLE,
    DEFAULT_BATCH_SIZE,
    DEFAULT_CADENCE_MINUTES,
    DEFAULT_MISSION_OUTSTANDING_CAP,
    LiveRun,
    MoneyField,
    NumberField,
    StatusPill,
    ToggleRow,
    formatCadenceMinutes,
    formatCapCents,
    parseCadenceMinutes,
    parseCapCents,
} from '@/components/work-agent';

interface WorkAgentSettingsProps {
    preferences: WorkAgentPreferences;
    goals: WorkAgentGoal[];
    activeRun: WorkAgentRun | null;
    logs: WorkAgentRunLog[];
}

export function WorkAgentSettings({ preferences, goals, activeRun, logs }: WorkAgentSettingsProps) {
    const t = useTranslations('dashboard.settings.workAgent');
    const router = useRouter();
    const [isSaving, startSaving] = useTransition();
    const [isSavingAutoGen, startSavingAutoGen] = useTransition();
    const [isSavingAutoBuild, startSavingAutoBuild] = useTransition();
    const [isSavingAutoRetry, startSavingAutoRetry] = useTransition();
    const [isSavingAccountBudget, startSavingAccountBudget] = useTransition();
    const [isCanceling, startCanceling] = useTransition();
    const [isQueueing, startQueueing] = useTransition();
    const [localPreferences, setLocalPreferences] = useState(preferences);
    const [instruction, setInstruction] = useState('');
    const [dryRun, setDryRun] = useState(preferences.guardrails.dryRunByDefault);

    // Phase 4 PR L — local edit state for the four promoted constants.
    // `null` on the API field means "use platform default" — the UI
    // shows the platform default value in the input but tracks whether
    // the user has explicitly overridden it. On save, the override
    // value is sent; if the user wants to clear back to default they
    // hit "Use default" which sends null.
    const [cadenceMinutes, setCadenceMinutes] = useState<number>(
        parseCadenceMinutes(preferences.autoGenerateCadence) ?? DEFAULT_CADENCE_MINUTES,
    );
    const [batchSize, setBatchSize] = useState<number>(
        preferences.autoGenerateBatchSize ?? DEFAULT_BATCH_SIZE,
    );
    const [autoBuildThrottle, setAutoBuildThrottle] = useState<number>(
        preferences.autoBuildThrottlePerDay ?? DEFAULT_AUTOBUILD_THROTTLE,
    );
    const [missionCap, setMissionCap] = useState<number>(
        preferences.missionDefaultOutstandingCap ?? DEFAULT_MISSION_OUTSTANDING_CAP,
    );

    // Phase 4 PR EE — auto-retry policy (NOT NULL on the DB side per
    // PR 0.5 — these have hardcoded defaults in the entity, so we
    // just mirror whatever the API returns).
    const [maxAutoRetries, setMaxAutoRetries] = useState<number>(preferences.maxAutoRetries);
    const [backoffSeconds, setBackoffSeconds] = useState<number>(preferences.backoffSeconds);
    const [exponentialBackoffFactor, setExponentialBackoffFactor] = useState<number>(
        preferences.exponentialBackoffFactor,
    );

    // Phase 4 PR EE — account-wide budget. Cap is nullable bigint
    // (string-over-the-wire) — when null the user hasn't set an
    // explicit account-wide guard. `allowOverage` is NOT NULL with
    // default true on the entity side.
    const [accountCapCents, setAccountCapCents] = useState<number>(
        parseCapCents(preferences.accountWideMonthlyCapCents) ?? DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS,
    );
    const [accountCapEnabled, setAccountCapEnabled] = useState<boolean>(
        preferences.accountWideMonthlyCapCents !== null,
    );
    const [accountAllowOverage, setAccountAllowOverage] = useState<boolean>(
        preferences.accountWideAllowOverage,
    );

    useEffect(() => {
        if (!activeRun) {
            return;
        }

        const interval = window.setInterval(() => router.refresh(), 5000);
        return () => window.clearInterval(interval);
    }, [activeRun, router]);

    const updatePreference = <K extends keyof WorkAgentPreferences>(
        key: K,
        value: WorkAgentPreferences[K],
    ) => setLocalPreferences((current) => ({ ...current, [key]: value }));

    const updateGuardrail = (
        key: keyof WorkAgentPreferences['guardrails'],
        value: number | boolean,
    ) =>
        setLocalPreferences((current) => ({
            ...current,
            guardrails: { ...current.guardrails, [key]: value },
        }));

    const savePreferences = () => {
        startSaving(async () => {
            try {
                const saved = await updateWorkAgentPreferencesAction({
                    enabled: localPreferences.enabled,
                    autoApproveLowImpact: localPreferences.autoApproveLowImpact,
                    dailySuggestionsEnabled: localPreferences.dailySuggestionsEnabled,
                    ...localPreferences.guardrails,
                });
                setLocalPreferences(saved);
                router.refresh();
                toast.success(t('toasts.settingsSaved'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.settingsError'));
            }
        });
    };

    const queueGoal = () => {
        startQueueing(async () => {
            try {
                await createWorkAgentGoalAction({
                    instruction: instruction.trim(),
                    dryRun,
                });
                setInstruction('');
                router.refresh();
                toast.success(t('toasts.goalQueued'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.goalError'));
            }
        });
    };

    // Phase 4 PR L — section-scoped save handlers. Each section has
    // its own button so the user can adjust + save just the two
    // fields they care about without re-validating the rest of the
    // form. The save sends a tiny PATCH (just the two fields the
    // section owns) — the server PUT endpoint treats unmentioned
    // fields as "leave alone" per PR D's nullable3rd semantics.
    const saveAutoGeneratePrefs = (resetToDefault: boolean) => {
        startSavingAutoGen(async () => {
            try {
                const saved = await updateWorkAgentPreferencesAction(
                    resetToDefault
                        ? { autoGenerateCadence: null, autoGenerateBatchSize: null }
                        : {
                              autoGenerateCadence: formatCadenceMinutes(cadenceMinutes),
                              autoGenerateBatchSize: batchSize,
                          },
                );
                setLocalPreferences(saved);
                router.refresh();
                // After reset, refresh the displayed values to the new
                // platform-default-driven view.
                if (resetToDefault) {
                    setCadenceMinutes(
                        parseCadenceMinutes(saved.autoGenerateCadence) ?? DEFAULT_CADENCE_MINUTES,
                    );
                    setBatchSize(saved.autoGenerateBatchSize ?? DEFAULT_BATCH_SIZE);
                }
                toast.success(t('toasts.settingsSaved'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.settingsError'));
            }
        });
    };

    const saveAutoBuildPrefs = (resetToDefault: boolean) => {
        startSavingAutoBuild(async () => {
            try {
                const saved = await updateWorkAgentPreferencesAction(
                    resetToDefault
                        ? {
                              autoBuildThrottlePerDay: null,
                              missionDefaultOutstandingCap: null,
                          }
                        : {
                              autoBuildThrottlePerDay: autoBuildThrottle,
                              missionDefaultOutstandingCap: missionCap,
                          },
                );
                setLocalPreferences(saved);
                router.refresh();
                if (resetToDefault) {
                    setAutoBuildThrottle(
                        saved.autoBuildThrottlePerDay ?? DEFAULT_AUTOBUILD_THROTTLE,
                    );
                    setMissionCap(
                        saved.missionDefaultOutstandingCap ?? DEFAULT_MISSION_OUTSTANDING_CAP,
                    );
                }
                toast.success(t('toasts.settingsSaved'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.settingsError'));
            }
        });
    };

    const saveAutoRetryPrefs = (resetToDefault: boolean) => {
        startSavingAutoRetry(async () => {
            try {
                // Auto-retry fields are NOT NULL on the DB side, so
                // "Use default" can't send literal null. Instead it
                // snaps each value back to the entity default (PR 0.5
                // seeds: maxAutoRetries=2, backoffSeconds=60,
                // exponentialBackoffFactor=2.0) and sends those.
                const saved = await updateWorkAgentPreferencesAction(
                    resetToDefault
                        ? {
                              maxAutoRetries: 2,
                              backoffSeconds: 60,
                              exponentialBackoffFactor: 2,
                          }
                        : {
                              maxAutoRetries,
                              backoffSeconds,
                              exponentialBackoffFactor,
                          },
                );
                setLocalPreferences(saved);
                router.refresh();
                if (resetToDefault) {
                    setMaxAutoRetries(saved.maxAutoRetries);
                    setBackoffSeconds(saved.backoffSeconds);
                    setExponentialBackoffFactor(saved.exponentialBackoffFactor);
                }
                toast.success(t('toasts.settingsSaved'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.settingsError'));
            }
        });
    };

    const saveAccountBudgetPrefs = (resetToDefault: boolean) => {
        startSavingAccountBudget(async () => {
            try {
                // Cap: nullable. Either user enabled it (send the cents-
                // as-string) or they want no cap (send literal null —
                // server's nullable3rd treats that as "clear override").
                // The reset-to-default path also nulls the cap AND
                // restores allowOverage to its entity default (true).
                const saved = await updateWorkAgentPreferencesAction(
                    resetToDefault
                        ? {
                              accountWideMonthlyCapCents: null,
                              accountWideAllowOverage: true,
                          }
                        : {
                              accountWideMonthlyCapCents: accountCapEnabled
                                  ? formatCapCents(accountCapCents)
                                  : null,
                              accountWideAllowOverage: accountAllowOverage,
                          },
                );
                setLocalPreferences(saved);
                router.refresh();
                if (resetToDefault) {
                    setAccountCapEnabled(saved.accountWideMonthlyCapCents !== null);
                    setAccountCapCents(
                        parseCapCents(saved.accountWideMonthlyCapCents) ??
                            DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS,
                    );
                    setAccountAllowOverage(saved.accountWideAllowOverage);
                }
                toast.success(t('toasts.settingsSaved'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.settingsError'));
            }
        });
    };

    const cancelGoal = (goalId: string) => {
        startCanceling(async () => {
            try {
                await cancelWorkAgentGoalAction(goalId);
                router.refresh();
                toast.success(t('toasts.goalCanceled'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.cancelError'));
            }
        });
    };

    return (
        <div className="space-y-4">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <Header
                        icon={Bot}
                        title={t('sections.agent.title')}
                        description={t('sections.agent.description')}
                    />

                    <div className="pl-11 grid gap-4 @3xl/main:grid-cols-2">
                        <ToggleRow
                            label={t('fields.enabled')}
                            checked={localPreferences.enabled}
                            onChange={(checked) => updatePreference('enabled', checked)}
                        />
                        <ToggleRow
                            label={t('fields.autoApproveLowImpact')}
                            checked={localPreferences.autoApproveLowImpact}
                            onChange={(checked) =>
                                updatePreference('autoApproveLowImpact', checked)
                            }
                        />
                        <ToggleRow
                            label={t('fields.dailySuggestions')}
                            checked={localPreferences.dailySuggestionsEnabled}
                            onChange={(checked) =>
                                updatePreference('dailySuggestionsEnabled', checked)
                            }
                        />
                        <ToggleRow
                            label={t('fields.dryRunByDefault')}
                            checked={localPreferences.guardrails.dryRunByDefault}
                            onChange={(checked) => updateGuardrail('dryRunByDefault', checked)}
                        />
                    </div>
                </div>
            </section>

            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <Header
                        icon={ShieldCheck}
                        title={t('sections.guardrails.title')}
                        description={t('sections.guardrails.description')}
                    />

                    <div className="pl-11 grid gap-3 @3xl/main:grid-cols-2">
                        <NumberField
                            label={t('fields.maxWorksPerRun')}
                            value={localPreferences.guardrails.maxWorksPerRun}
                            min={1}
                            max={25}
                            onChange={(value) => updateGuardrail('maxWorksPerRun', value)}
                        />
                        <NumberField
                            label={t('fields.maxItemsPerWork')}
                            value={localPreferences.guardrails.maxItemsPerWork}
                            min={1}
                            max={500}
                            onChange={(value) => updateGuardrail('maxItemsPerWork', value)}
                        />
                        <MoneyField
                            label={t('fields.maxBudgetPerRun')}
                            cents={localPreferences.guardrails.maxBudgetCentsPerRun}
                            onChange={(value) => updateGuardrail('maxBudgetCentsPerRun', value)}
                        />
                        <MoneyField
                            label={t('fields.approvalThreshold')}
                            cents={localPreferences.guardrails.requireApprovalAboveBudgetCents}
                            onChange={(value) =>
                                updateGuardrail('requireApprovalAboveBudgetCents', value)
                            }
                        />
                        <ToggleRow
                            label={t('fields.confirmBeforeCreate')}
                            checked={localPreferences.guardrails.requireApprovalBeforeCreate}
                            onChange={(checked) =>
                                updateGuardrail('requireApprovalBeforeCreate', checked)
                            }
                        />
                        <ToggleRow
                            label={t('fields.confirmBeforeDelete')}
                            checked={localPreferences.guardrails.requireApprovalBeforeDelete}
                            onChange={(checked) =>
                                updateGuardrail('requireApprovalBeforeDelete', checked)
                            }
                        />
                    </div>

                    <div className="pl-11 pt-4">
                        <Button size="sm" onClick={savePreferences} disabled={isSaving}>
                            {t('actions.saveSettings')}
                        </Button>
                    </div>
                </div>
            </section>

            <section
                id="auto-generate-ideas"
                className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden scroll-mt-24"
            >
                <div className="p-5">
                    <Header
                        icon={Sparkles}
                        title={t('sections.autoGenerateIdeas.title')}
                        description={t('sections.autoGenerateIdeas.description')}
                    />

                    <div className="pl-11 grid gap-3 @3xl/main:grid-cols-2">
                        <NumberField
                            label={t('fields.autoGenerateCadenceMinutes')}
                            value={cadenceMinutes}
                            min={1}
                            max={1440}
                            onChange={setCadenceMinutes}
                        />
                        <NumberField
                            label={t('fields.autoGenerateBatchSize')}
                            value={batchSize}
                            min={1}
                            max={20}
                            onChange={setBatchSize}
                        />
                    </div>

                    <div className="pl-11 pt-4 flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            onClick={() => saveAutoGeneratePrefs(false)}
                            disabled={isSavingAutoGen}
                        >
                            {t('actions.saveSection')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => saveAutoGeneratePrefs(true)}
                            disabled={isSavingAutoGen}
                        >
                            {t('actions.useDefault')}
                        </Button>
                    </div>
                </div>
            </section>

            <section
                id="auto-build-works"
                className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden scroll-mt-24"
            >
                <div className="p-5">
                    <Header
                        icon={Zap}
                        title={t('sections.autoBuildWorks.title')}
                        description={t('sections.autoBuildWorks.description')}
                    />

                    <div className="pl-11 grid gap-3 @3xl/main:grid-cols-2">
                        <NumberField
                            label={t('fields.autoBuildThrottlePerDay')}
                            value={autoBuildThrottle}
                            min={0}
                            max={1000}
                            onChange={setAutoBuildThrottle}
                        />
                        <NumberField
                            label={t('fields.missionDefaultOutstandingCap')}
                            value={missionCap}
                            min={-1}
                            max={1000}
                            onChange={setMissionCap}
                        />
                    </div>

                    <div className="pl-11 pt-4 flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            onClick={() => saveAutoBuildPrefs(false)}
                            disabled={isSavingAutoBuild}
                        >
                            {t('actions.saveSection')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => saveAutoBuildPrefs(true)}
                            disabled={isSavingAutoBuild}
                        >
                            {t('actions.useDefault')}
                        </Button>
                    </div>
                </div>
            </section>

            <section
                id="auto-retry"
                className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden scroll-mt-24"
            >
                <div className="p-5">
                    <Header
                        icon={RotateCcw}
                        title={t('sections.autoRetry.title')}
                        description={t('sections.autoRetry.description')}
                    />

                    <div className="pl-11 grid gap-3 @3xl/main:grid-cols-3">
                        <NumberField
                            label={t('fields.maxAutoRetries')}
                            value={maxAutoRetries}
                            min={0}
                            max={5}
                            onChange={setMaxAutoRetries}
                        />
                        <NumberField
                            label={t('fields.backoffSeconds')}
                            value={backoffSeconds}
                            min={10}
                            max={3600}
                            onChange={setBackoffSeconds}
                        />
                        <NumberField
                            label={t('fields.exponentialBackoffFactor')}
                            value={exponentialBackoffFactor}
                            min={1}
                            max={4}
                            step={0.1}
                            onChange={setExponentialBackoffFactor}
                        />
                    </div>

                    <div className="pl-11 pt-4 flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            onClick={() => saveAutoRetryPrefs(false)}
                            disabled={isSavingAutoRetry}
                        >
                            {t('actions.saveSection')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => saveAutoRetryPrefs(true)}
                            disabled={isSavingAutoRetry}
                        >
                            {t('actions.useDefault')}
                        </Button>
                    </div>
                </div>
            </section>

            <section
                id="account-budgets"
                className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden scroll-mt-24"
            >
                <div className="p-5">
                    <Header
                        icon={Wallet}
                        title={t('sections.accountBudgets.title')}
                        description={t('sections.accountBudgets.description')}
                    />

                    <div className="pl-11 space-y-3">
                        <ToggleRow
                            label={t('fields.accountWideCapEnabled')}
                            checked={accountCapEnabled}
                            onChange={setAccountCapEnabled}
                        />
                        {accountCapEnabled && (
                            <div className="grid gap-3 @3xl/main:grid-cols-2">
                                <MoneyField
                                    label={t('fields.accountWideMonthlyCap')}
                                    cents={accountCapCents}
                                    onChange={setAccountCapCents}
                                />
                            </div>
                        )}
                        <ToggleRow
                            label={t('fields.accountWideAllowOverage')}
                            checked={accountAllowOverage}
                            onChange={setAccountAllowOverage}
                        />
                    </div>

                    <div className="pl-11 pt-4 flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            onClick={() => saveAccountBudgetPrefs(false)}
                            disabled={isSavingAccountBudget}
                        >
                            {t('actions.saveSection')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => saveAccountBudgetPrefs(true)}
                            disabled={isSavingAccountBudget}
                        >
                            {t('actions.useDefault')}
                        </Button>
                    </div>
                </div>
            </section>

            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <Header
                        icon={Play}
                        title={t('sections.queue.title')}
                        description={t('sections.queue.description')}
                    />

                    <div className="pl-11 space-y-3">
                        <textarea
                            value={instruction}
                            onChange={(event) => setInstruction(event.target.value)}
                            rows={4}
                            placeholder={t('queue.placeholder')}
                            className="w-full rounded-lg border border-border dark:border-border-dark bg-background dark:bg-background-dark px-3 py-2 text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-primary/25"
                        />
                        <div className="flex flex-col gap-3 @3xl/main:flex-row @3xl/main:items-center @3xl/main:justify-between">
                            <ToggleRow
                                label={t('fields.dryRunThisGoal')}
                                checked={dryRun}
                                onChange={setDryRun}
                            />
                            <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={queueGoal}
                                disabled={
                                    isQueueing ||
                                    !localPreferences.enabled ||
                                    instruction.trim().length < 10
                                }
                            >
                                <Play className="w-3.5 h-3.5" />
                                {t('actions.preparePlan')}
                            </Button>
                        </div>
                    </div>
                </div>
            </section>

            <div className="grid gap-4 @5xl/main:grid-cols-2">
                <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                    <div className="p-5">
                        <Header
                            icon={Clock}
                            title={t('sections.liveRun.title')}
                            description={t('sections.liveRun.description')}
                        />
                        <div className="pl-11 space-y-3">
                            <LiveRun
                                activeRun={activeRun}
                                logs={logs}
                                labels={{
                                    worksMetric: t('metrics.works'),
                                    itemsMetric: t('metrics.items'),
                                    emptyWaitingForUpdate: t('empty.waitingForUpdate'),
                                    emptyNoActiveRun: t('empty.noActiveRun'),
                                }}
                            />
                        </div>
                    </div>
                </section>

                <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                    <div className="p-5">
                        <Header
                            icon={ListChecks}
                            title={t('sections.recentGoals.title')}
                            description={t('sections.recentGoals.description')}
                        />
                        <div className="pl-11 space-y-3">
                            {goals.length === 0 ? (
                                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('empty.noGoals')}
                                </p>
                            ) : (
                                goals.map((goal) => (
                                    <div
                                        key={goal.id}
                                        className="rounded-lg border border-border/60 dark:border-border-dark/60 p-3"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="text-sm text-text dark:text-text-dark leading-relaxed">
                                                {goal.instruction}
                                            </p>
                                            <StatusPill status={goal.status} />
                                        </div>
                                        <div className="mt-3 flex items-center justify-between gap-3">
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {goal.dryRun
                                                    ? t('labels.dryRun')
                                                    : t('labels.liveRun')}
                                            </span>
                                            {[
                                                'pending',
                                                'planning',
                                                'waiting-for-approval',
                                                'running',
                                            ].includes(goal.status) && (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    className="h-7 px-2 text-xs gap-1"
                                                    onClick={() => cancelGoal(goal.id)}
                                                    disabled={isCanceling}
                                                >
                                                    <CircleStop className="w-3 h-3" />
                                                    {t('actions.stop')}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

function Header({
    icon: Icon,
    title,
    description,
}: {
    icon: ComponentType<{ className?: string }>;
    title: string;
    description: string;
}) {
    return (
        <div className="flex items-start gap-3.5 mb-5">
            <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0">
                <Icon className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
            </div>
            <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                    {title}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed mt-0.5">
                    {description}
                </p>
            </div>
        </div>
    );
}
