'use client';

import { useState, useTransition } from 'react';
import { ChevronLeft, Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
    MIN_CHECK_FREQUENCY_MINUTES,
    DEFAULT_CHECK_FREQUENCY_MINUTES,
    GOAL_KINDS,
    type GoalComparator,
    type GoalKind,
    type GoalWindow,
} from '@/lib/api/goals.shared';
import { createGoalAction } from './actions';
import { buildCreateGoalPayload, validateGoalFormFields } from './goal-form-payload';

const COMPARATORS: GoalComparator[] = ['gte', 'lte'];
const WINDOWS: GoalWindow[] = ['day', 'week', 'month', 'total', 'point'];

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4';

const fieldLabel = 'block text-xs font-medium text-text dark:text-text-dark mb-2';

const fieldHint = 'mt-1.5 text-xs text-text-muted dark:text-text-muted-dark';

const dateInput = cn(
    'w-full text-sm rounded-lg transition-colors outline-none px-4 py-2',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark',
    'focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20',
);

/**
 * Goals & Metrics — PR-8. Create-Goal form backing `/goals/new`.
 *
 * Two KINDS share the form (self-build slice AG, EW-795), chosen by the
 * selector in the Basics card:
 *
 *   - **Metric** (the default) — the original Goal: metric source
 *     (pluginId + metricId + optional params-JSON), target
 *     comparator/value/unit/window. Those sections render, and their
 *     fields are sent, ONLY for this kind.
 *   - **Delivery** — "ship feature X across three repos": no metric at
 *     all. A Definition of Done (one criterion per line, at least one) is
 *     collected instead, and the payload carries no metric key.
 *
 * Deadline and evaluation cadence apply to both (clamped server-side to
 * ≥15 min — surfaced here as a hint). New Goals land in `draft`;
 * activation happens from the detail page. The accept/reject decision and
 * the exact payload live in `goal-form-payload.ts`.
 */
export function GoalForm() {
    const t = useTranslations('dashboard.goalNew');
    const router = useRouter();
    const [pending, startSubmit] = useTransition();

    const [kind, setKind] = useState<GoalKind>('metric');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [pluginId, setPluginId] = useState('');
    const [metricId, setMetricId] = useState('');
    const [paramsText, setParamsText] = useState('');
    const [paramsError, setParamsError] = useState<string | null>(null);
    const [comparator, setComparator] = useState<GoalComparator>('gte');
    const [targetValue, setTargetValue] = useState('');
    const [unit, setUnit] = useState('');
    const [metricWindow, setMetricWindow] = useState<GoalWindow>('month');
    const [dodText, setDodText] = useState('');
    const [deadline, setDeadline] = useState('');
    const [checkFrequencyMinutes, setCheckFrequencyMinutes] = useState(
        String(DEFAULT_CHECK_FREQUENCY_MINUTES),
    );

    const isMetric = kind === 'metric';

    const parseParams = (): { ok: true; value?: Record<string, unknown> } | { ok: false } => {
        const raw = paramsText.trim();
        if (!raw) {
            setParamsError(null);
            return { ok: true, value: undefined };
        }
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                setParamsError(t('fields.paramsNotObject'));
                return { ok: false };
            }
            setParamsError(null);
            return { ok: true, value: parsed as Record<string, unknown> };
        } catch {
            setParamsError(t('fields.paramsInvalid'));
            return { ok: false };
        }
    };

    const submit = () => {
        const fields = {
            title,
            description,
            pluginId,
            metricId,
            comparator,
            targetValue,
            unit,
            window: metricWindow,
            dodText,
            deadline: null as string | null,
            checkFrequencyMinutes: DEFAULT_CHECK_FREQUENCY_MINUTES,
        };

        // Kind-aware: a metric Goal keeps the legacy checks in the legacy
        // order (title → source → target → unit, EW-044's empty-target guard
        // included); a delivery Goal needs a title and at least one criterion.
        const problem = validateGoalFormFields(kind, fields);
        if (problem) {
            toast.error(t(problem));
            return;
        }

        let params: Record<string, unknown> | undefined;
        if (isMetric) {
            const parsed = parseParams();
            if (!parsed.ok) {
                toast.error(t('fields.paramsInvalid'));
                return;
            }
            params = parsed.value;
        }

        let deadlineIso: string | null = null;
        if (deadline) {
            const ms = Date.parse(deadline);
            if (!Number.isFinite(ms)) {
                toast.error(t('errors.deadlineInvalid'));
                return;
            }
            deadlineIso = new Date(ms).toISOString();
        }

        const freq = Number(checkFrequencyMinutes);
        const checkFreq =
            Number.isFinite(freq) && freq > 0 ? Math.round(freq) : DEFAULT_CHECK_FREQUENCY_MINUTES;

        const payload = buildCreateGoalPayload(kind, {
            ...fields,
            params,
            deadline: deadlineIso,
            checkFrequencyMinutes: checkFreq,
        });

        startSubmit(async () => {
            try {
                const goal = await createGoalAction(payload);
                toast.success(t('created'));
                router.push(`/goals/${goal.id}`);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('errors.createFailed'));
            }
        });
    };

    return (
        <div className="w-full p-6 max-w-3xl mx-auto space-y-6">
            <div>
                <Link
                    href="/goals"
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    {t('backToGoals')}
                </Link>
                <div className="mt-3 flex items-start gap-3">
                    <div className="shrink-0 w-10 h-10 rounded-xl bg-info/10 border border-info/20 flex items-center justify-center">
                        <Gauge className="w-5 h-5 text-info" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark leading-tight">
                            {t('title')}
                        </h1>
                        <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
            </div>

            {/* Basics */}
            <section className={sectionCard}>
                <Input
                    label={t('fields.title')}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    placeholder={t('fields.titlePlaceholder')}
                />
                <div>
                    <label className={fieldLabel}>{t('fields.description')}</label>
                    <Textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={3}
                        maxLength={10000}
                        placeholder={t('fields.descriptionPlaceholder')}
                    />
                </div>
                <div>
                    <label className={fieldLabel} htmlFor="goal-kind">
                        {t('fields.goalKind')}
                    </label>
                    <Select
                        id="goal-kind"
                        value={kind}
                        onValueChange={(v) => setKind(v as GoalKind)}
                        data-testid="goal-kind-select"
                    >
                        {GOAL_KINDS.map((k) => (
                            <option key={k} value={k}>
                                {t(`kinds.${k}`)}
                            </option>
                        ))}
                    </Select>
                    <p className={fieldHint}>{t(`kindHints.${kind}`)}</p>
                </div>
            </section>

            {/* Metric source — metric Goals only */}
            {isMetric ? (
                <section className={sectionCard}>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.metricSource')}
                    </h2>
                    <div className="grid gap-4 @lg/main:grid-cols-2">
                        <Input
                            label={t('fields.pluginId')}
                            value={pluginId}
                            onChange={(e) => setPluginId(e.target.value)}
                            maxLength={100}
                            placeholder="stripe"
                        />
                        <Input
                            label={t('fields.metricId')}
                            value={metricId}
                            onChange={(e) => setMetricId(e.target.value)}
                            maxLength={200}
                            placeholder="income"
                        />
                    </div>
                    <div>
                        <label className={fieldLabel}>{t('fields.params')}</label>
                        <Textarea
                            value={paramsText}
                            onChange={(e) => setParamsText(e.target.value)}
                            onBlur={parseParams}
                            rows={4}
                            placeholder={'{\n  "currency": "usd"\n}'}
                            className="font-mono text-xs"
                            error={paramsError ?? undefined}
                        />
                        <p className={fieldHint}>{t('fields.paramsHint')}</p>
                    </div>
                </section>
            ) : null}

            {/* Target — metric Goals only */}
            {isMetric ? (
                <section className={sectionCard}>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.target')}
                    </h2>
                    <div className="grid gap-4 @lg/main:grid-cols-3">
                        <div>
                            <label className={fieldLabel}>{t('fields.comparator')}</label>
                            <Select
                                value={comparator}
                                onValueChange={(v) => setComparator(v as GoalComparator)}
                            >
                                {COMPARATORS.map((c) => (
                                    <option key={c} value={c}>
                                        {t(`comparators.${c}`)}
                                    </option>
                                ))}
                            </Select>
                        </div>
                        <Input
                            type="number"
                            label={t('fields.targetValue')}
                            value={targetValue}
                            onChange={(e) => setTargetValue(e.target.value)}
                            step="any"
                            placeholder="1000"
                        />
                        <Input
                            label={t('fields.unit')}
                            value={unit}
                            onChange={(e) => setUnit(e.target.value)}
                            maxLength={32}
                            placeholder="usd"
                        />
                    </div>
                    <div>
                        <label className={fieldLabel}>{t('fields.window')}</label>
                        <Select
                            value={metricWindow}
                            onValueChange={(v) => setMetricWindow(v as GoalWindow)}
                        >
                            {WINDOWS.map((w) => (
                                <option key={w} value={w}>
                                    {t(`windows.${w}`)}
                                </option>
                            ))}
                        </Select>
                    </div>
                </section>
            ) : null}

            {/* Definition of Done — delivery Goals only */}
            {!isMetric ? (
                <section className={sectionCard}>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('sections.definitionOfDone')}
                    </h2>
                    <Textarea
                        label={t('fields.dodCriteria')}
                        value={dodText}
                        onChange={(e) => setDodText(e.target.value)}
                        rows={5}
                        placeholder={t('fields.dodCriteriaPlaceholder')}
                        helperText={t('fields.dodCriteriaHint')}
                        data-testid="goal-dod-text"
                    />
                </section>
            ) : null}

            {/* Cadence + deadline — both kinds */}
            <section className={sectionCard}>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('sections.cadence')}
                </h2>
                <div className="grid gap-4 @lg/main:grid-cols-2">
                    <Input
                        type="number"
                        label={t('fields.checkFrequency')}
                        value={checkFrequencyMinutes}
                        min={MIN_CHECK_FREQUENCY_MINUTES}
                        step={1}
                        onChange={(e) => setCheckFrequencyMinutes(e.target.value)}
                        helperText={t('fields.checkFrequencyHint', {
                            min: MIN_CHECK_FREQUENCY_MINUTES,
                        })}
                    />
                    <div>
                        <label className={fieldLabel}>{t('fields.deadline')}</label>
                        <input
                            type="datetime-local"
                            value={deadline}
                            onChange={(e) => setDeadline(e.target.value)}
                            className={dateInput}
                        />
                    </div>
                </div>
            </section>

            <div className="flex items-center gap-2">
                <Button onClick={submit} loading={pending} disabled={pending} size="md">
                    {t('actions.create')}
                </Button>
                <Button href="/goals" variant="ghost" size="md">
                    {t('actions.cancel')}
                </Button>
            </div>
        </div>
    );
}
