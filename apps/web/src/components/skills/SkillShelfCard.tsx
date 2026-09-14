'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import {
    deriveSkillCardState,
    type SkillCardState,
    type SkillProvenance,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Skill } from '@/lib/api/skills';
import { refreshSkillReadiness, setSkillEnabled } from '@/lib/api/skill-shelf-client';
import { SkillReadinessBadge } from './SkillReadinessBadge';

const PROVENANCE_KEYS = {
    firstParty: 'provenanceFirstParty',
    plugin: 'provenancePlugin',
    package: 'provenancePackage',
    authored: 'provenanceAuthored',
} as const satisfies Record<SkillProvenance, string>;

/**
 * Skills shelf — one card.
 *
 * Title (links to the full definition), description, tags, provenance,
 * version and reach, plus the two things that change the product: the on/off
 * toggle (optimistic, reverted with an inline error if the save fails) and the
 * readiness badge, whose action is the shortest repair path for its state —
 * switch it back on, attach it, or re-check.
 */
export function SkillShelfCard({ skill }: { skill: Skill }) {
    const t = useTranslations('dashboard.skillsPage.shelf');
    const tr = useTranslations('dashboard.skillsPage.readiness');
    const tc = useTranslations('dashboard.skillsPage');

    const [enabled, setEnabled] = useState(!skill.disabledAt);
    const [readiness, setReadiness] = useState({
        state: skill.cardState ?? deriveSkillCardState(skill),
        detail: skill.readinessDetail ?? null,
    });
    const [error, setError] = useState<string | null>(null);
    const [saving, startSaving] = useTransition();
    const [checking, startChecking] = useTransition();

    useEffect(() => {
        setEnabled(!skill.disabledAt);
        setReadiness({
            state: skill.cardState ?? deriveSkillCardState(skill),
            detail: skill.readinessDetail ?? null,
        });
    }, [skill]);

    // The switch is layered over the verdict: turning a Skill back on shows
    // whatever it was before it was switched off.
    const storedState: SkillCardState =
        readiness.state === 'disabled' ? (skill.readiness ?? 'unknown') : readiness.state;
    const shownState: SkillCardState = enabled ? storedState : 'disabled';

    const onToggle = (next: boolean) => {
        const previous = enabled;
        setEnabled(next);
        setError(null);
        startSaving(async () => {
            try {
                const result = await setSkillEnabled(skill.id, next);
                setEnabled(!result.disabledAt);
                setReadiness((current) => ({
                    state: result.cardState === 'disabled' ? current.state : result.cardState,
                    detail: current.detail,
                }));
            } catch {
                setEnabled(previous);
                setError(t('toggleFailed'));
            }
        });
    };

    const onRecheck = () => {
        setError(null);
        startChecking(async () => {
            try {
                const result = await refreshSkillReadiness(skill.id);
                setReadiness({ state: result.cardState, detail: result.readinessDetail });
            } catch {
                setError(tr('recheckFailed'));
            }
        });
    };

    const action =
        shownState === 'disabled' ? (
            <button
                type="button"
                data-testid="skill-card-switch-on"
                onClick={() => onToggle(true)}
                disabled={saving}
                className="underline underline-offset-2"
            >
                {tr('fixSwitchOn')}
            </button>
        ) : shownState === 'needs_setup' ? (
            <Link
                href={`${ROUTES.DASHBOARD_SKILL(skill.id)}#skill-bindings`}
                data-testid="skill-card-attach"
                className="underline underline-offset-2"
            >
                {tr('fixAttach')}
            </Link>
        ) : shownState === 'unknown' ||
          shownState === 'missing_requirements' ||
          shownState === 'blocked_by_access' ? (
            <button
                type="button"
                data-testid="skill-card-recheck"
                onClick={onRecheck}
                disabled={checking}
                aria-label={tr('recheck')}
                title={tr('recheck')}
                className="inline-flex items-center"
            >
                <RefreshCw
                    className={cn('h-3.5 w-3.5', checking && 'animate-spin')}
                    aria-hidden="true"
                />
            </button>
        ) : null;

    const tags = skill.tags ?? [];
    const toggleId = `skill-toggle-${skill.id}`;

    return (
        <article
            data-testid="skill-shelf-card"
            data-skill-id={skill.id}
            data-state={shownState}
            className={cn(
                'flex flex-col rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border dark:border-border-dark/60 dark:bg-card-primary-dark dark:hover:border-border-dark',
                !enabled && 'opacity-80',
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate text-sm font-semibold text-text dark:text-text-dark">
                    <Link href={ROUTES.DASHBOARD_SKILL(skill.id)} className="hover:underline">
                        {skill.title}
                    </Link>
                </h3>
                <div className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor={toggleId} className="sr-only">
                        {t('toggleLabel', { title: skill.title })}
                    </label>
                    <button
                        id={toggleId}
                        type="button"
                        role="switch"
                        data-testid="skill-card-toggle"
                        aria-checked={enabled}
                        aria-describedby={`${toggleId}-hint`}
                        disabled={saving}
                        onClick={() => onToggle(!enabled)}
                        className={cn(
                            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                            enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600',
                            saving && 'opacity-60',
                        )}
                    >
                        <span
                            className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                enabled ? 'translate-x-4' : 'translate-x-0.5',
                            )}
                        />
                    </button>
                    <span id={`${toggleId}-hint`} className="sr-only">
                        {t('toggleHint')}
                    </span>
                </div>
            </div>

            <p className="mt-1.5 line-clamp-2 min-h-8 text-xs text-text-muted dark:text-text-muted-dark">
                {skill.description}
            </p>

            {tags.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1" aria-label={t('tagsLabel')}>
                    {tags.map((tag) => (
                        <li
                            key={tag}
                            className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-secondary dark:bg-surface-secondary-dark dark:text-text-secondary-dark"
                        >
                            {tag}
                        </li>
                    ))}
                </ul>
            ) : null}

            <div className="mt-2 flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-mono text-[10px] text-text-muted dark:text-text-muted-dark">
                    {skill.slug}
                </span>
                {skill.invocationSlug ? (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                        /{skill.invocationSlug}
                    </span>
                ) : null}
            </div>

            <SkillReadinessBadge
                className="mt-3"
                state={shownState}
                detail={readiness.detail}
                showRequirements={shownState === 'missing_requirements'}
                pending={checking}
                action={action}
            />
            {shownState === 'disabled' ? (
                <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {tr('disabledBody')}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="mt-1 text-[11px] text-danger">
                    {error}
                </p>
            ) : null}

            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-3 text-[11px] text-text-secondary dark:border-border-dark/40 dark:text-text-secondary-dark">
                <span className="min-w-0 truncate" data-testid="skill-card-reach">
                    {t('reach', { count: skill.boundTargetCount ?? 0 })}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded bg-surface-secondary px-1.5 py-0.5 uppercase tracking-wide dark:bg-surface-secondary-dark">
                        {skill.ownerType}
                    </span>
                    {skill.provenance ? (
                        <span data-testid="skill-card-provenance">
                            {tr(PROVENANCE_KEYS[skill.provenance])}
                        </span>
                    ) : skill.sourceCatalogSlug ? (
                        <span>{tc('card.fromCatalog')}</span>
                    ) : null}
                    <span>v{skill.version}</span>
                </span>
            </div>
        </article>
    );
}
