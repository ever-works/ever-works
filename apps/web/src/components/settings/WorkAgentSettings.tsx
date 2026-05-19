'use client';

import { useState, useTransition } from 'react';
import type { ComponentType } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, CircleStop, Clock, ListChecks, Play, ShieldCheck } from 'lucide-react';
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
import { cn } from '@/lib/utils/cn';

interface WorkAgentSettingsProps {
    preferences: WorkAgentPreferences;
    goals: WorkAgentGoal[];
    activeRun: WorkAgentRun | null;
    logs: WorkAgentRunLog[];
}

const STATUS_STYLES: Record<string, string> = {
    pending: 'bg-warning/10 text-warning border-warning/20',
    queued: 'bg-warning/10 text-warning border-warning/20',
    running: 'bg-info/10 text-info border-info/20',
    researching: 'bg-info/10 text-info border-info/20',
    generating: 'bg-info/10 text-info border-info/20',
    writing: 'bg-info/10 text-info border-info/20',
    completed: 'bg-success/10 text-success border-success/20',
    canceled: 'bg-surface-secondary text-text-muted border-border/70',
    failed: 'bg-danger/10 text-danger border-danger/20',
};

export function WorkAgentSettings({
    preferences,
    goals,
    activeRun,
    logs,
}: WorkAgentSettingsProps) {
    const t = useTranslations('dashboard.settings.workAgent');
    const [isSaving, startSaving] = useTransition();
    const [isCanceling, startCanceling] = useTransition();
    const [isQueueing, startQueueing] = useTransition();
    const [localPreferences, setLocalPreferences] = useState(preferences);
    const [instruction, setInstruction] = useState('');
    const [dryRun, setDryRun] = useState(preferences.guardrails.dryRunByDefault);

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
                    instruction,
                    dryRun,
                });
                setInstruction('');
                toast.success(t('toasts.goalQueued'));
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('toasts.goalError'));
            }
        });
    };

    const cancelGoal = (goalId: string) => {
        startCanceling(async () => {
            try {
                await cancelWorkAgentGoalAction(goalId);
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
                            onChange={(checked) =>
                                updateGuardrail('dryRunByDefault', checked)
                            }
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
                                {t('actions.queueGoal')}
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
                            {activeRun ? (
                                <>
                                    <div className="flex items-center justify-between gap-3">
                                        <StatusPill status={activeRun.status} />
                                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {activeRun.progressPercent}%
                                        </span>
                                    </div>
                                    <div className="h-2 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden">
                                        <div
                                            className="h-full bg-primary transition-all"
                                            style={{ width: `${activeRun.progressPercent}%` }}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        <Metric
                                            label={t('metrics.works')}
                                            value={activeRun.summary.worksCreated}
                                        />
                                        <Metric
                                            label={t('metrics.items')}
                                            value={activeRun.summary.itemsCreated}
                                        />
                                    </div>
                                    <LogList
                                        logs={logs}
                                        emptyText={t('empty.waitingForUpdate')}
                                    />
                                </>
                            ) : (
                                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('empty.noActiveRun')}
                                </p>
                            )}
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
                                                {goal.dryRun ? t('labels.dryRun') : t('labels.liveRun')}
                                            </span>
                                            {['pending', 'planning', 'waiting-for-approval', 'running'].includes(
                                                goal.status,
                                            ) && (
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

function ToggleRow({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                className="rounded border-border dark:border-border-dark"
            />
            <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {label}
            </span>
        </label>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="space-y-1.5">
            <span className="text-xs text-text-muted dark:text-text-muted-dark">{label}</span>
            <input
                type="number"
                value={value}
                min={min}
                max={max}
                onChange={(event) => onChange(Number(event.target.value))}
                className="w-full h-9 rounded-lg border border-border dark:border-border-dark bg-background dark:bg-background-dark px-3 text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-primary/25"
            />
        </label>
    );
}

function MoneyField({
    label,
    cents,
    onChange,
}: {
    label: string;
    cents: number;
    onChange: (value: number) => void;
}) {
    return (
        <NumberField
            label={label}
            value={Math.round(cents / 100)}
            min={0}
            max={10_000}
            onChange={(value) => onChange(Math.max(0, Math.round(value * 100)))}
        />
    );
}

function StatusPill({ status }: { status: string }) {
    return (
        <span
            className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                STATUS_STYLES[status] ?? 'bg-surface-secondary text-text-muted border-border/70',
            )}
        >
            {status.replaceAll('-', ' ')}
        </span>
    );
}

function Metric({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-lg border border-border/60 dark:border-border-dark/60 p-2">
            <div className="text-[11px] text-text-muted dark:text-text-muted-dark">{label}</div>
            <div className="text-sm font-semibold text-text dark:text-text-dark">{value}</div>
        </div>
    );
}

function LogList({ logs, emptyText }: { logs: WorkAgentRunLog[]; emptyText: string }) {
    if (logs.length === 0) {
        return (
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {emptyText}
            </p>
        );
    }

    return (
        <div className="space-y-2">
            {logs.slice(-6).map((log) => (
                <div
                    key={log.id}
                    className="rounded-lg bg-surface dark:bg-surface-dark px-3 py-2"
                >
                    <div className="text-[11px] uppercase text-text-muted dark:text-text-muted-dark">
                        {log.step}
                    </div>
                    <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {log.message}
                    </div>
                </div>
            ))}
        </div>
    );
}
