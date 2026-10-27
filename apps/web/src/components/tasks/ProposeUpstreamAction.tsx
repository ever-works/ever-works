'use client';

import { useTranslations } from 'next-intl';
import { GitPullRequestArrow } from 'lucide-react';
import { UPSTREAM_REFUSAL_CODES } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';

/** The eligibility facts the action renders (a subset of `UpstreamEligibilityView`). */
export interface ProposeUpstreamActionView {
    allowed: boolean;
    code?: string;
    limit?: string;
    limitValue?: number;
    nextSlotAt?: string;
    relation: string | null;
    preparationAvailable: boolean;
    activeProposalId?: string | null;
    target: { owner: string; repo: string; forkOwner: string; forkRepo: string } | null;
}

/**
 * APW-09 T11 — the Task's **Propose upstream** action.
 *
 * - **Hidden** for a linked repository (S11: its Tasks' pull requests already go to the
 *   project) and for a Work with no recorded relation.
 * - **Disabled with the reason** otherwise. Until the preparation step ships
 *   (`preparationAvailable: false`) nothing can be prepared, so even an eligible Task shows a
 *   disabled button with "Preparing an upstream pull request isn't available yet." — never a
 *   button that does nothing. A private copy shows the S10 copy, a refusal its §6.5 copy, an
 *   active proposal the FR-5 copy.
 *
 * The server decides everything (`GET …/upstream-pull-requests/eligibility`); this component
 * only renders the answer, so hiding or enabling it here could never be a bypass.
 */
export function ProposeUpstreamAction({ view }: { view: ProposeUpstreamActionView }) {
    const t = useTranslations('dashboard.tasksPage.proposeUpstream');
    const refusals = useTranslations('dashboard.workDetail.upstream.refusals');

    if (view.relation !== 'fork' && view.relation !== 'private-copy') return null;

    const upstream = view.target ? `${view.target.owner}/${view.target.repo}` : t('theUpstream');
    const fork = view.target ? `${view.target.forkOwner}/${view.target.forkRepo}` : t('yourFork');
    const time = view.nextSlotAt ? new Date(view.nextSlotAt).toLocaleString() : '';
    const count = view.limitValue ?? 1;

    let reason: string;
    if (view.relation === 'private-copy') {
        reason = t('privateCopy', { upstream });
    } else if (view.activeProposalId) {
        reason = t('activeProposal');
    } else if (view.code === 'rateLimited' && view.limit === 'openPerUpstream') {
        reason = t('limits.openPerUpstream', { count, upstream });
    } else if (
        view.code === 'rateLimited' &&
        view.limit &&
        view.limit !== 'openedPerUpstreamPer24h'
    ) {
        reason = t('limits.window', { count, time });
    } else if (view.code && (UPSTREAM_REFUSAL_CODES as readonly string[]).includes(view.code)) {
        // `view.code` was just checked against the closed refusal set; every value has a key.
        reason = refusals(view.code as Parameters<typeof refusals>[0], {
            upstream,
            fork,
            count,
            time,
            path: '',
            lines: 0,
            limit: 0,
            command: '',
        });
    } else if (!view.allowed) {
        reason = t('unavailable');
    } else {
        reason = t('notAvailableYet');
    }

    const enabled = view.allowed && view.preparationAvailable;

    return (
        <div className="flex flex-col items-end gap-0.5" data-testid="propose-upstream-action">
            <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!enabled}
                aria-disabled={!enabled}
                title={reason}
                aria-describedby="propose-upstream-reason"
                data-testid="propose-upstream-button"
            >
                <GitPullRequestArrow className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('action')}
            </Button>
            <p
                id="propose-upstream-reason"
                className="max-w-xs text-right text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="propose-upstream-reason"
            >
                {reason}
            </p>
        </div>
    );
}
