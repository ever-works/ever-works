'use client';

import { cn } from '@/lib/utils/cn';
import type { PullRequestView } from '@/lib/api/pull-requests';

/**
 * Wave 7 feature h — the status pills on the Work "Pull requests" tab.
 *
 * Two pills ship: the PR **state** (open / merged / closed) and the
 * platform's own **review** state (has the agent reviewed this PR).
 *
 * A **CI pill is deliberately absent**: the git-provider plugin contract
 * (`packages/plugin/src/contracts/capabilities/git-provider.interface.ts`)
 * exposes no check-run / commit-status surface, so there is no honest
 * source for one — rendering a green dot from nothing would be worse
 * than rendering nothing. Adding `listCheckRuns` to that capability (and
 * the github plugin) is the documented follow-up; this component takes
 * `ciState` already so the pill drops in without touching call sites.
 */

export type PullRequestCiState = 'success' | 'failure' | 'pending' | 'unknown';

const STATE_STYLES: Record<PullRequestView['state'], string> = {
    open: 'text-success bg-success/10 border-success/30',
    merged: 'text-info bg-info/10 border-info/30',
    closed: 'text-text-secondary bg-card/60 border-border dark:border-border-dark',
};

const CI_STYLES: Record<PullRequestCiState, string> = {
    success: 'text-success bg-success/10 border-success/30',
    failure: 'text-danger bg-danger/10 border-danger/30',
    pending: 'text-warning bg-warning/10 border-warning/30',
    unknown: 'text-text-secondary bg-card/60 border-border dark:border-border-dark',
};

const BASE_PILL =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function PullRequestStatePill({
    state,
    label,
}: {
    readonly state: PullRequestView['state'];
    readonly label: string;
}) {
    return (
        <span className={cn(BASE_PILL, STATE_STYLES[state])} data-testid={`pr-state-pill-${state}`}>
            {label}
        </span>
    );
}

export function PullRequestReviewPill({
    reviewed,
    label,
}: {
    readonly reviewed: boolean;
    readonly label: string;
}) {
    return (
        <span
            className={cn(
                BASE_PILL,
                reviewed
                    ? 'text-info bg-info/10 border-info/30'
                    : 'text-text-secondary bg-card/60 border-border dark:border-border-dark',
            )}
            data-testid={`pr-review-pill-${reviewed ? 'reviewed' : 'unreviewed'}`}
        >
            {label}
        </span>
    );
}

/**
 * CI pill. Rendered only when a caller can supply a real state — today
 * nothing can (see the file doc), so it returns null for `unknown`
 * rather than showing a hollow placeholder.
 */
export function PullRequestCiPill({
    ciState,
    label,
}: {
    readonly ciState: PullRequestCiState;
    readonly label: string;
}) {
    if (ciState === 'unknown') return null;
    return (
        <span className={cn(BASE_PILL, CI_STYLES[ciState])} data-testid={`pr-ci-pill-${ciState}`}>
            {label}
        </span>
    );
}
