'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    AlertTriangle,
    CheckCircle2,
    CircleDashed,
    CircleHelp,
    Eye,
    Loader2,
    PowerOff,
    ShieldAlert,
    Unplug,
    type LucideIcon,
} from 'lucide-react';
import type { SkillCardState, SkillReadinessDetail } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import {
    SKILL_CARD_STATE_TITLE_KEYS,
    SKILL_REQUIREMENT_KIND_KEYS,
    skillRequirementFixHref,
    skillRequirementFixLabelKey,
    skillRequirementStatusKey,
    unmetSkillRequirements,
} from '@/lib/skill-readiness';

const ICONS: Record<SkillCardState, LucideIcon> = {
    ready: CheckCircle2,
    needs_setup: Unplug,
    missing_requirements: AlertTriangle,
    blocked_by_access: ShieldAlert,
    // Not checked yet: a neutral, dashed "pending" mark, never a warning.
    unknown: CircleDashed,
    check_failed: CircleHelp,
    disabled: PowerOff,
    needs_review: Eye,
};

const TONES: Record<SkillCardState, string> = {
    ready: 'border-success/30 bg-success/10 text-success',
    needs_setup: 'border-warning/30 bg-warning/10 text-warning',
    missing_requirements: 'border-warning/30 bg-warning/10 text-warning',
    blocked_by_access: 'border-danger/30 bg-danger/10 text-danger',
    unknown:
        'border-border/60 bg-surface-secondary text-text-secondary dark:border-border-dark/60 dark:bg-surface-secondary-dark dark:text-text-secondary-dark',
    check_failed: 'border-warning/30 bg-warning/10 text-warning',
    disabled:
        'border-border/60 bg-surface-secondary text-text-secondary dark:border-border-dark/60 dark:bg-surface-secondary-dark dark:text-text-secondary-dark',
    needs_review: 'border-primary/30 bg-primary/10 text-primary',
};

export interface SkillReadinessBadgeProps {
    state: SkillCardState;
    detail?: SkillReadinessDetail | null;
    /** Enumerate the unmet requirements under the title (card + panel). */
    showRequirements?: boolean;
    /** `ready` renders nothing on a card; the detail panel asks for it explicitly. */
    showReady?: boolean;
    /** Swap the icon for a spinner while a re-check is in flight. */
    pending?: boolean;
    /** The badge's primary action (a repair path), rendered beside the title. */
    action?: ReactNode;
    className?: string;
}

/**
 * Skills shelf — one readiness badge. Pure presentation: a card state in, an
 * icon plus a translated title out, and (optionally) every unmet requirement
 * named by its own identifier — "Connection: billing-api (not connected)" —
 * with a link to where it is fixed. The title is always text, so the state is
 * never carried by colour alone.
 */
export function SkillReadinessBadge({
    state,
    detail,
    showRequirements = false,
    showReady = false,
    pending = false,
    action,
    className,
}: SkillReadinessBadgeProps) {
    const t = useTranslations('dashboard.skillsPage.readiness');
    if (state === 'ready' && !showReady) return null;

    const Icon = pending ? Loader2 : ICONS[state];
    const unmet = unmetSkillRequirements(detail);
    const missingCount = unmet.filter((row) => row.status === 'missing').length;
    const title =
        state === 'missing_requirements'
            ? t('missingTitle', { count: Math.max(missingCount, 1) })
            : t(SKILL_CARD_STATE_TITLE_KEYS[state]);

    return (
        <div
            data-testid="skill-readiness-badge"
            data-state={state}
            className={cn('rounded-md border px-2.5 py-1.5 text-xs', TONES[state], className)}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                    <Icon
                        className={cn('h-3.5 w-3.5 shrink-0', pending && 'animate-spin')}
                        aria-hidden="true"
                    />
                    <span className="truncate">{title}</span>
                </span>
                {action ? <span className="shrink-0">{action}</span> : null}
            </div>
            {showRequirements && unmet.length > 0 ? (
                <ul className="mt-1.5 space-y-1" data-testid="skill-readiness-requirements">
                    {unmet.map((requirement) => {
                        const href = skillRequirementFixHref(requirement);
                        return (
                            <li
                                key={`${requirement.kind}:${requirement.id}`}
                                className="flex flex-wrap items-center gap-x-1.5 text-text-secondary dark:text-text-secondary-dark"
                            >
                                <span>{t(SKILL_REQUIREMENT_KIND_KEYS[requirement.kind])}:</span>
                                <code className="font-mono text-text dark:text-text-dark">
                                    {requirement.id}
                                </code>
                                <span>({t(skillRequirementStatusKey(requirement))})</span>
                                {href ? (
                                    <Link
                                        href={href}
                                        className="underline underline-offset-2 hover:text-text dark:hover:text-text-dark"
                                    >
                                        {t(skillRequirementFixLabelKey(requirement))}
                                    </Link>
                                ) : null}
                            </li>
                        );
                    })}
                    {detail?.truncated ? (
                        <li className="text-text-muted dark:text-text-muted-dark">
                            {t('truncated', { count: detail.truncatedCount ?? 0 })}
                        </li>
                    ) : null}
                </ul>
            ) : null}
        </div>
    );
}
