'use client';

import { useTranslations } from 'next-intl';
import { GitPullRequest } from 'lucide-react';
import type { FleetGitLinePullRequest } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { PR_PILL_TONE, prChecksGlyph, safeHttpsUrl } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-8, §5.1) — the pull-request pill:
 * `PR #912 open ✓`. Tones: open green, draft muted, merged violet, closed
 * grey; checks ✓ ⏳ ✗ (nothing when none are reported). Opens the pull
 * request on click — only an `https:` URL with no credentials becomes a link
 * (anything else renders as inert text). `unknownMinutes` is the "GitHub
 * unreachable" state (spec U12): the last good answer, with its age.
 */
export function PrPill({
    pr,
    unknownMinutes = null,
    className,
}: {
    pr: FleetGitLinePullRequest | null;
    /** Minutes GitHub has been unreachable, when it is. */
    unknownMinutes?: number | null;
    className?: string;
}) {
    const t = useTranslations('fleet.sessionGit.prPill');
    if (!pr) {
        if (unknownMinutes === null) return null;
        return (
            <span
                className={cn('text-xs text-text-muted dark:text-text-muted-dark', className)}
                data-testid="fleet-pr-pill-unknown"
            >
                {t('unknown', { minutes: unknownMinutes })}
            </span>
        );
    }
    const glyph = prChecksGlyph(pr.checks);
    const label = t('label', { number: pr.number, state: t(`states.${pr.state}`) });
    const checks = pr.checks ? t(`checks.${pr.checks}`) : t('checks.none');
    const href = safeHttpsUrl(pr.url);
    const body = (
        <>
            <GitPullRequest className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{label}</span>
            {glyph ? <span aria-hidden="true">{glyph}</span> : null}
            {unknownMinutes !== null ? (
                <span className="opacity-70">· {t('stale', { minutes: unknownMinutes })}</span>
            ) : null}
        </>
    );
    const classes = cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        PR_PILL_TONE[pr.state],
        className,
    );
    return href ? (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(classes, 'hover:underline')}
            title={`${label} · ${checks}`}
            data-testid="fleet-pr-pill"
            data-state={pr.state}
            data-checks={pr.checks ?? 'none'}
        >
            {body}
        </a>
    ) : (
        <span
            className={classes}
            title={`${label} · ${checks}`}
            data-testid="fleet-pr-pill"
            data-state={pr.state}
        >
            {body}
        </span>
    );
}
