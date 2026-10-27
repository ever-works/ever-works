import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { AppUpstreamCard } from '@/components/works/app/AppUpstreamCard';
import { upstreamPullRequestsAPI } from '@/lib/api/upstream-pull-requests';
import { UpstreamPullRequestsSection } from '@/components/works/detail/upstream/UpstreamPullRequestsSection';

/**
 * APW-02 T30 — the Upstream tab: `/works/:id/upstream`, one address, one card
 * (Resolution R-8, `plan.md:614-622`; FR-59, `spec.md:392-398`).
 *
 * The page reads `GET /api/works/:id/upstream` — the whole card in one answer —
 * and mounts {@link AppUpstreamCard} with `variant="tab"`: relation, readiness in
 * every state (with **Try again** when timed out or failed), divergence, sync
 * status and inherited workflows. Below the card sits an empty slot where APW-09
 * mounts its "Upstream pull requests" section; **no second tab or route is ever
 * added** (`plan.md:621-622`).
 *
 * ## Why the two 404s are 404s and not an empty card
 *
 * 1. **The read itself failed.** The API answers `404 not_found` for a Work that
 *    is missing, not kind `app`, or another account's
 *    (`apps/api/src/app-works/app-upstream.controller.ts:87-101`, ACC-02-21).
 *    Rendering the card from nothing would turn "you may not see this" into "this
 *    App Work has no upstream" — the same substitution a scope bug makes, and the
 *    one the spec forbids.
 * 2. **The relation is `link`.** A linked App Work has no upstream at all
 *    (FR-44, `packages/contracts/src/apps/app-upstream.ts:267-277`), and FR-59
 *    says the tab MUST NOT be shown for it. The tab strip already withholds it
 *    (`WorkTabs.tsx`); the address is withheld too, so a bookmark cannot render a
 *    card about an upstream that does not exist.
 *
 * ## APW-09's section (lane aw-upstream-prs)
 *
 * The slot now holds the **Upstream pull requests** section. Its list
 * (`GET /api/works/:id/upstream-pull-requests`) is read beside the card's read, never
 * instead of it: a failed list renders the section's own one-line notice (`rows: null`)
 * and never turns the tab into a 404, and it is started before the card's read is
 * awaited so the two run in parallel.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.upstream');
    return { title: t('tabName') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkUpstreamPage({ params }: Params) {
    const { id } = await params;

    // Started first so it runs beside the card's read; a failure is `null`, never a throw.
    const pullRequests = upstreamPullRequestsAPI.list(id, { limit: 20 }).then(
        (answer) => answer?.data ?? [],
        () => null,
    );

    let state;

    try {
        state = await workAPI.getUpstream(id);
    } catch {
        notFound();
    }

    if (state.relation === 'link') {
        notFound();
    }

    return (
        <div className="space-y-8">
            <AppUpstreamCard workId={id} variant="tab" initialState={state} />

            {/*
             * APW-09's slot: this epic owns the tab and the card, APW-09 adds the
             * "Upstream pull requests" section *below* it in the same tab (R-8,
             * `plan.md:621-622`). A second tab or a second route would break the one
             * Upstream surface the resolution fixes.
             */}
            <div data-testid="app-upstream-pull-requests-slot">
                <UpstreamPullRequestsSection
                    rows={await pullRequests}
                    relation={state.relation}
                    upstream={
                        state.upstream ? `${state.upstream.owner}/${state.upstream.repo}` : null
                    }
                />
            </div>
        </div>
    );
}
