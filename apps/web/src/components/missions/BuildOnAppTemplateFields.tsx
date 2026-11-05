'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { WorkSelect } from '@/components/tasks/WorkSelect';
import type { MissionTemplateInputs, MissionTemplateManifestView } from '@/lib/api/missions';

/** The cadence the summary line's copy describes ("Every Monday 08:00 UTC"). */
const MONDAY_0800_UTC = '0 8 * * 1';

/** FR-56 — Product and Business are each at most 80 characters (the API refuses longer). */
export const TEMPLATE_INPUT_MAX_CHARS = 80;

export type BuildOnAppTemplateValue = MissionTemplateInputs;

/** What **Propose these rules** calls: one App change request on the chosen App Work. */
export type ProposeRulesFn = (
    workId: string,
    request: string,
) => Promise<{ success: boolean; code?: string }>;

/** A template manifest that is about an App Work (the only kind this component renders for). */
export function templateTakesAppWork(
    manifest: MissionTemplateManifestView | null | undefined,
): manifest is MissionTemplateManifestView & {
    appWork: NonNullable<MissionTemplateManifestView['appWork']>;
} {
    return !!manifest?.appWork;
}

/** The three inputs are filled in (the create button stays off until they are). */
export function templateInputsComplete(value: BuildOnAppTemplateValue): boolean {
    const product = value.product.trim();
    const business = value.business.trim();
    return (
        product.length > 0 &&
        product.length <= TEMPLATE_INPUT_MAX_CHARS &&
        business.length > 0 &&
        business.length <= TEMPLATE_INPUT_MAX_CHARS &&
        value.appWorkId.length > 0
    );
}

/**
 * APW-08 T40 (FR-59) — the change request **Propose these rules** files on the App Work. It asks
 * for a pull request that changes the App spec; the platform never writes the App spec itself.
 * English on purpose: it is an instruction to the Agent, stored as the Task's description.
 */
export function buildProposeRulesRequest(
    appWork: NonNullable<MissionTemplateManifestView['appWork']>,
): string {
    const lines = [
        'Update this app’s App spec (`.works/works.yml`) by pull request with the rules the "Build on an open-source app" Mission template recommends. Change only the App spec, keep every existing rule, and do not loosen any of them.',
    ];
    if (appWork.requireHumanMergePaths.length > 0) {
        lines.push(
            `- \`agents.requireHumanMergePaths\`: add ${appWork.requireHumanMergePaths
                .map((path) => `\`${path}\``)
                .join(', ')} — changes to these paths are merged by a person.`,
        );
    }
    if (appWork.maxPullRequestChangedLines !== null) {
        lines.push(
            `- \`agents.maxPullRequestChangedLines\`: ${appWork.maxPullRequestChangedLines} — larger work is split into smaller Tasks.`,
        );
    }
    if (appWork.protectedPaths.length > 0) {
        lines.push(
            `- \`display.protectedPaths\`: add ${appWork.protectedPaths
                .map((path) => `\`${path}\``)
                .join(', ')}.`,
        );
    }
    return lines.join('\n').slice(0, 4000);
}

function fill(text: string, value: BuildOnAppTemplateValue, appWorkName: string | null): string {
    const values: Record<string, string> = {
        product: value.product.trim() || '{product}',
        business: value.business.trim() || '{business}',
        appWork: appWorkName ?? '{appWork}',
    };
    return text.replace(/\{(product|business|appWork)\}/g, (_match, key: string) => values[key]);
}

export interface BuildOnAppTemplateFieldsProps {
    manifest: MissionTemplateManifestView & {
        appWork: NonNullable<MissionTemplateManifestView['appWork']>;
    };
    value: BuildOnAppTemplateValue;
    onChange: (next: BuildOnAppTemplateValue) => void;
    proposeRules: ProposeRulesFn;
    disabled?: boolean;
}

/**
 * APW-08 T40 (FR-56…FR-59) — the **Build on an open-source app** template's part of the Mission
 * create form, shared by `/missions/new?template=…` (`NewMissionForm`) and the catalog's
 * **Use this Template** path (`/new?type=mission&template=…`, `NewPageClient`): Product, Business
 * and the App Work, the summary of what the template sets (FR-57), the draft Goals it creates
 * (FR-58), and the app rules it recommends with **Propose these rules** (FR-59), which files ONE
 * change request on the chosen App Work and writes nothing to its App spec.
 */
export function BuildOnAppTemplateFields({
    manifest,
    value,
    onChange,
    proposeRules,
    disabled = false,
}: BuildOnAppTemplateFieldsProps) {
    const t = useTranslations('dashboard.missionsPage.buildOnApp');
    const locale = useLocale();
    const [appWorkCount, setAppWorkCount] = useState<number | null>(null);
    const [proposing, setProposing] = useState(false);
    const [proposed, setProposed] = useState(false);

    const defaults = manifest.defaults;
    const appWork = manifest.appWork;
    const amount =
        defaults?.maxBudgetCentsPerRun !== null && defaults?.maxBudgetCentsPerRun !== undefined
            ? new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
                  defaults.maxBudgetCentsPerRun / 100,
              )
            : null;
    const showSummary =
        defaults?.cadence === MONDAY_0800_UTC && defaults.tasksPerTick !== null && amount !== null;

    const set = (patch: Partial<BuildOnAppTemplateValue>) => onChange({ ...value, ...patch });

    const handlePropose = () => {
        if (proposing || proposed) return;
        if (!value.appWorkId) {
            toast.error(t('proposeNeedsAppWork'));
            return;
        }
        setProposing(true);
        void (async () => {
            try {
                const result = await proposeRules(
                    value.appWorkId,
                    buildProposeRulesRequest(appWork),
                );
                if (result.success) {
                    setProposed(true);
                    toast.success(t('rulesProposed'));
                } else {
                    toast.error(t('rulesFailed'));
                }
            } catch {
                toast.error(t('rulesFailed'));
            } finally {
                setProposing(false);
            }
        })();
    };

    const fieldLabel = 'block text-xs text-text-secondary dark:text-text-secondary-dark mb-1';
    const fieldInput =
        'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark';

    return (
        <fieldset
            className="space-y-4 rounded-lg border border-border/60 dark:border-border-dark/60 p-4"
            data-testid="build-on-app-fields"
            disabled={disabled}
        >
            <div className="grid gap-4 sm:grid-cols-2">
                <div>
                    <label htmlFor="build-on-app-product" className={fieldLabel}>
                        {t('product')}
                    </label>
                    <input
                        id="build-on-app-product"
                        type="text"
                        value={value.product}
                        onChange={(e) => set({ product: e.target.value })}
                        maxLength={TEMPLATE_INPUT_MAX_CHARS}
                        required
                        className={fieldInput}
                        data-testid="build-on-app-product"
                    />
                </div>
                <div>
                    <label htmlFor="build-on-app-business" className={fieldLabel}>
                        {t('business')}
                    </label>
                    <input
                        id="build-on-app-business"
                        type="text"
                        value={value.business}
                        onChange={(e) => set({ business: e.target.value })}
                        maxLength={TEMPLATE_INPUT_MAX_CHARS}
                        required
                        className={fieldInput}
                        data-testid="build-on-app-business"
                    />
                </div>
            </div>

            <div>
                <label htmlFor="build-on-app-work" className={fieldLabel}>
                    {t('appWork')}
                </label>
                <WorkSelect
                    id="build-on-app-work"
                    value={value.appWorkId}
                    onValueChange={(appWorkId) => set({ appWorkId })}
                    noneLabel={t('appWorkPlaceholder')}
                    kinds={['app']}
                    onLoaded={setAppWorkCount}
                    testId="build-on-app-work"
                    disabled={disabled}
                />
                {appWorkCount === 0 && (
                    <p
                        className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="build-on-app-no-app-work"
                    >
                        {t('noAppWorks')}
                    </p>
                )}
            </div>

            <div
                className="space-y-2 rounded-md bg-surface-secondary/60 dark:bg-surface-secondary-dark/60 p-3 text-xs text-text-secondary dark:text-text-secondary-dark"
                data-testid="build-on-app-summary"
            >
                {showSummary && (
                    <p data-testid="build-on-app-summary-line">
                        {t('summary', { count: defaults.tasksPerTick as number, amount })}
                    </p>
                )}
                {defaults?.requireApprovalBeforeCreate && (
                    <p data-testid="build-on-app-backlog-note">{t('backlogNote')}</p>
                )}
                {manifest.suggestedGoals.length > 0 && (
                    <div>
                        <p className="font-medium text-text dark:text-text-dark">
                            {t('suggestedGoals')}
                        </p>
                        <ul className="mt-1 list-disc ps-5" data-testid="build-on-app-goals">
                            {manifest.suggestedGoals.map((goal) => (
                                <li key={goal.title}>{fill(goal.title, value, null)}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {appWork.maxPullRequestChangedLines !== null && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <p data-testid="build-on-app-rules">
                            {t('rules', { lines: appWork.maxPullRequestChangedLines })}
                        </p>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handlePropose}
                            disabled={disabled || proposing || proposed}
                            data-testid="build-on-app-propose-rules"
                        >
                            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('proposeRules')}
                        </Button>
                    </div>
                )}
            </div>
        </fieldset>
    );
}
