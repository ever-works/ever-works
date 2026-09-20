'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeSummaryDto } from '@ever-works/contracts';
import { AttentionSection } from '@/components/dashboard/AttentionSection';
import type { AttentionItem } from '@/components/dashboard/dashboard-signals.types';
import { SoonSection } from '@/components/dashboard/SoonSection';
import { Link, useRouter } from '@/i18n/navigation';
import { useActiveScope } from '@/lib/hooks/use-active-scope';
import { ROUTES } from '@/lib/constants';
import { HomeStartComposer } from './HomeStartComposer';
import { NeedsYouBlock } from './NeedsYouBlock';
import { RecentActivityBlock } from './RecentActivityBlock';
import { ThisWeekPanel } from './ThisWeekPanel';
import { WorkingNowPanel } from './WorkingNowPanel';

interface HomeMorningStackProps {
    /** The composed morning read; null when the whole summary could not be read. */
    summary: HomeSummaryDto | null;
    /** Failures the platform raised on its own, composed from the page's existing reads. */
    attentionItems: AttentionItem[];
    jobRuntimeConfigured: boolean | null;
    /**
     * The `Your workspace` stats card (Today + All), built by the page because
     * half of it is page data rather than morning-read data. Rendered second,
     * directly under the composer.
     */
    workspaceStats: ReactNode;
    /** Work-kind chip values whose PostHog flag resolved to `false`, for the composer. */
    disabledKinds?: readonly string[];
}

/**
 * A brand-new account: nothing needs the owner, nothing ran, nothing is due,
 * nothing was ever spent and nothing happened. Every block has to have
 * answered for this to hold — a failed block is never read as "nothing yet".
 */
export function isFirstRunSummary(summary: HomeSummaryDto): boolean {
    const { needsYou, glance, today, thisWeek, workingNow, recentActivity } = summary;
    const ok = [needsYou, glance, today, thisWeek, workingNow, recentActivity].every(
        (block) => block?.status === 'ok' && block.data,
    );
    if (!ok) return false;
    const g = glance!.data!;
    return (
        needsYou!.data!.total === 0 &&
        g.needsYou + g.workingNow + g.doneToday + g.failedToday === 0 &&
        today!.data!.ran.length === 0 &&
        today!.data!.dueTotal === 0 &&
        thisWeek!.data!.everSpent === false &&
        workingNow!.data!.total === 0 &&
        recentActivity!.data!.entries.length === 0
    );
}

/**
 * Home (AW-19) — the morning stack, in the order the owner set on 2026-09-18:
 *
 *   1. the composer (the `/new` prompt + kind chips, one line tall)
 *   2. `Your workspace` — the Today counters and the All totals in one card
 *   3. `Needs you` — what is waiting on the human
 *   4. `Working now` — what is running
 *   5. `Today` beside `This week`
 *   6. `Recent activity` — last, deliberately: the tail of the story, not its head
 *
 * The greeting, the page subtitle, the date line and the "Times shown in UTC."
 * footnote are gone by the owner's instruction; the timezone is now a setting
 * (see the profile's `Time zone` control) rather than a note under the title.
 *
 * Each block renders its own state from the one summary; the composer never
 * depends on it. Retry re-renders the page, which reads the summary afresh.
 */
export function HomeMorningStack({
    summary,
    attentionItems,
    jobRuntimeConfigured,
    workspaceStats,
    disabledKinds = [],
}: HomeMorningStackProps) {
    const t = useTranslations('dashboard.home');
    const router = useRouter();
    const { activeOrganization } = useActiveScope();
    const retry = () => router.refresh();

    const composer = <HomeStartComposer disabledKinds={disabledKinds} />;

    if (!summary) {
        return (
            <div data-testid="home-morning" className="space-y-4">
                {composer}
                {workspaceStats}
                <div
                    role="alert"
                    data-testid="home-summary-error"
                    className="rounded-xl border border-warning/30 bg-warning/8 p-6 text-center"
                >
                    <AlertTriangle
                        aria-hidden="true"
                        className="mx-auto mb-2 h-5 w-5 text-warning"
                    />
                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('summaryError.title')}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('summaryError.body')}
                    </p>
                    <button
                        type="button"
                        onClick={retry}
                        className="mt-3 rounded-md border border-border/60 px-3 py-1.5 text-sm font-medium text-text hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:border-white/12 dark:text-text-dark"
                    >
                        {t('summaryError.action')}
                    </button>
                </div>
                {attentionItems.length > 0 ? <AttentionSection items={attentionItems} /> : null}
            </div>
        );
    }

    if (isFirstRunSummary(summary) && attentionItems.length === 0) {
        return (
            <div data-testid="home-morning" className="space-y-4">
                {composer}
                {workspaceStats}
                <div
                    data-testid="home-first-run"
                    className="rounded-xl border border-card-border bg-card p-8 text-center dark:border-white/8 dark:bg-card-primary-dark/60"
                >
                    <Sun aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-warning" />
                    <p className="text-base font-semibold text-text dark:text-text-dark">
                        {t('firstRun.title')}
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('firstRun.body')}
                    </p>
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_NEW}
                        className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 dark:bg-white dark:text-gray-900"
                    >
                        {t('firstRun.action')}
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div data-testid="home-morning" className="space-y-4">
            {composer}
            {workspaceStats}
            <NeedsYouBlock block={summary.needsYou} alsoBroken={attentionItems} onRetry={retry} />
            <WorkingNowPanel block={summary.workingNow} onRetry={retry} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <SoonSection
                    today={summary.today?.status === 'ok' ? summary.today.data : null}
                    failed={summary.today?.status !== 'ok'}
                    timeZone={summary.timezone}
                    onRetry={retry}
                />
                <ThisWeekPanel
                    block={summary.thisWeek}
                    organizationName={
                        activeOrganization
                            ? (activeOrganization.displayName ??
                              activeOrganization.legalName ??
                              activeOrganization.slug)
                            : null
                    }
                    onRetry={retry}
                />
            </div>
            <RecentActivityBlock
                block={summary.recentActivity}
                now={new Date(summary.computedAt)}
                onRetry={retry}
            />
        </div>
    );
}
