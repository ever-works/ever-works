'use client';

import { useState, useTransition, type KeyboardEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Gauge, RefreshCw } from 'lucide-react';
import {
    deriveSkillCardState,
    type SkillCardState,
    type SkillReadinessDetail,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill } from '@/lib/api/skills';
import { refreshSkillReadiness, setSkillEnabled } from '@/lib/api/skill-shelf-client';
import {
    SKILL_CARD_STATE_BODY_KEYS,
    SKILL_REQUIREMENT_KIND_KEYS,
    skillRequirementFixHref,
    skillRequirementFixLabelKey,
    skillRequirementStatusKey,
} from '@/lib/skill-readiness';
import { SkillReadinessBadge } from './SkillReadinessBadge';

interface PanelState {
    cardState: SkillCardState;
    detail: SkillReadinessDetail | null;
    checkedAt: string | null;
    stale: boolean;
}

/**
 * Skills shelf — the detail page's Readiness, Requirements and "Where it came
 * from" panels, rendered above the existing sections (nothing below moves).
 *
 * The state badge is the same `SkillReadinessBadge` the shelf card uses, so
 * the card and this panel can never disagree. Re-check runs in a transition
 * (also on `R` while the panel is focused); the requirements table lists every
 * declared tool, credential and connection with its status — identifiers only,
 * never a value.
 */
export function SkillReadinessPanel({ skill }: { skill: Skill }) {
    const t = useTranslations('dashboard.skillsPage.readiness');
    const format = useFormatter();
    const [state, setState] = useState<PanelState>({
        cardState: deriveSkillCardState(skill),
        detail: skill.readinessDetail ?? null,
        checkedAt: skill.readinessCheckedAt ?? null,
        stale: false,
    });
    const [error, setError] = useState<string | null>(null);
    const [checking, startChecking] = useTransition();
    const [switching, startSwitching] = useTransition();

    const recheck = () => {
        setError(null);
        startChecking(async () => {
            try {
                const result = await refreshSkillReadiness(skill.id);
                setState({
                    cardState: result.cardState,
                    detail: result.readinessDetail,
                    checkedAt: result.readinessCheckedAt,
                    stale: Boolean(result.stale),
                });
            } catch {
                setError(t('recheckFailed'));
            }
        });
    };

    const switchOn = () => {
        setError(null);
        startSwitching(async () => {
            try {
                const result = await setSkillEnabled(skill.id, true);
                setState((current) => ({ ...current, cardState: result.cardState }));
            } catch {
                setError(t('recheckFailed'));
            }
        });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if (
            (event.key === 'r' || event.key === 'R') &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
        ) {
            event.preventDefault();
            if (!checking) recheck();
        }
    };

    const requirements = state.detail?.requirements ?? [];
    const muted =
        state.cardState === 'needs_setup' &&
        (state.detail?.boundTargetCount ?? 0) > 0 &&
        state.detail?.mutedBindingCount === state.detail?.boundTargetCount;

    return (
        <>
            <section
                tabIndex={-1}
                onKeyDown={onKeyDown}
                data-testid="skill-readiness-panel"
                aria-labelledby="skill-readiness-title"
                className="space-y-3 rounded-xl border border-border/60 bg-card p-5 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-border-dark/60 dark:bg-card-primary-dark"
            >
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2
                        id="skill-readiness-title"
                        className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark"
                    >
                        <Gauge
                            className="h-4 w-4 text-text-muted dark:text-text-muted-dark"
                            aria-hidden="true"
                        />
                        {t('panelTitle')}
                    </h2>
                    <div className="flex items-center gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                        <span data-testid="skill-readiness-checked">
                            {state.checkedAt
                                ? t('checkedAgo', {
                                      ago: format.relativeTime(new Date(state.checkedAt)),
                                  })
                                : t('neverChecked')}
                        </span>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={recheck}
                            disabled={checking}
                            className="gap-1.5"
                            aria-keyshortcuts="R"
                            data-testid="skill-readiness-recheck"
                        >
                            <RefreshCw
                                className={checking ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                                aria-hidden="true"
                            />
                            {checking ? t('rechecking') : t('recheck')}
                        </Button>
                    </div>
                </div>

                <div aria-live="polite">
                    <SkillReadinessBadge
                        state={state.cardState}
                        detail={state.detail}
                        showReady
                        pending={checking}
                        action={
                            state.cardState === 'disabled' ? (
                                <button
                                    type="button"
                                    onClick={switchOn}
                                    disabled={switching}
                                    className="underline underline-offset-2"
                                >
                                    {t('fixSwitchOn')}
                                </button>
                            ) : state.cardState === 'needs_setup' ? (
                                <a href="#skill-bindings" className="underline underline-offset-2">
                                    {t('fixAttach')}
                                </a>
                            ) : null
                        }
                    />
                    <p className="mt-1.5 text-xs text-text-secondary dark:text-text-secondary-dark">
                        {muted
                            ? t('needsSetupMuted')
                            : t(SKILL_CARD_STATE_BODY_KEYS[state.cardState])}
                    </p>
                    {state.stale ? (
                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('staleNote')}
                        </p>
                    ) : null}
                    {error ? (
                        <p role="alert" className="mt-1 text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            </section>

            <section
                data-testid="skill-requirements-panel"
                aria-labelledby="skill-requirements-title"
                className="space-y-3 rounded-xl border border-border/60 bg-card p-5 dark:border-border-dark/60 dark:bg-card-primary-dark"
            >
                <h2
                    id="skill-requirements-title"
                    className="text-sm font-medium text-text dark:text-text-dark"
                >
                    {t('requirementsTitle')}
                </h2>
                {requirements.length === 0 ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('requirementsEmpty')}
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="text-text-muted dark:text-text-muted-dark">
                                <tr>
                                    <th scope="col" className="py-1 pr-3 font-medium">
                                        {t('columnKind')}
                                    </th>
                                    <th scope="col" className="py-1 pr-3 font-medium">
                                        {t('columnName')}
                                    </th>
                                    <th scope="col" className="py-1 font-medium">
                                        {t('columnStatus')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {requirements.map((requirement) => {
                                    const href = skillRequirementFixHref(requirement);
                                    return (
                                        <tr
                                            key={`${requirement.kind}:${requirement.id}`}
                                            data-testid="skill-requirement-row"
                                            data-status={requirement.status}
                                            className="border-t border-border/40 dark:border-border-dark/40"
                                        >
                                            <td className="py-1.5 pr-3 text-text-secondary dark:text-text-secondary-dark">
                                                {t(SKILL_REQUIREMENT_KIND_KEYS[requirement.kind])}
                                            </td>
                                            <td className="py-1.5 pr-3 font-mono text-text dark:text-text-dark">
                                                {requirement.id}
                                            </td>
                                            <td className="py-1.5 text-text-secondary dark:text-text-secondary-dark">
                                                <span>
                                                    {t(skillRequirementStatusKey(requirement))}
                                                </span>
                                                {requirement.status !== 'met' && href ? (
                                                    <Link
                                                        href={href}
                                                        className="ml-2 text-primary underline-offset-2 hover:underline"
                                                    >
                                                        {t(
                                                            skillRequirementFixLabelKey(
                                                                requirement,
                                                            ),
                                                        )}
                                                    </Link>
                                                ) : null}
                                                {requirement.status !== 'met' &&
                                                requirement.kind === 'credential' ? (
                                                    <span className="ml-2 text-text-muted dark:text-text-muted-dark">
                                                        {t('fixCredentialHint')}
                                                    </span>
                                                ) : null}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {state.detail?.truncated ? (
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('truncated', { count: state.detail.truncatedCount ?? 0 })}
                            </p>
                        ) : null}
                    </div>
                )}
            </section>

            <section
                data-testid="skill-provenance-panel"
                aria-labelledby="skill-provenance-title"
                className="space-y-1.5 rounded-xl border border-border/60 bg-card p-5 text-xs text-text-secondary dark:border-border-dark/60 dark:bg-card-primary-dark dark:text-text-secondary-dark"
            >
                <h2
                    id="skill-provenance-title"
                    className="text-sm font-medium text-text dark:text-text-dark"
                >
                    {t('provenanceTitle')}
                </h2>
                <p>
                    {skill.sourceCatalogSlug
                        ? t('provenanceCatalogLong', {
                              slug: skill.sourceCatalogSlug,
                              version: skill.sourceCatalogVersion ?? skill.version,
                          })
                        : skill.capturedFromRunId
                          ? t('provenanceCapturedLong')
                          : t('provenanceAuthoredLong')}
                </p>
                {skill.capturedFromRunId ? (
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_SESSION(skill.capturedFromRunId)}
                        className="text-primary underline-offset-2 hover:underline"
                    >
                        {t('openRun')}
                    </Link>
                ) : null}
            </section>
        </>
    );
}
