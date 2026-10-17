'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hammer } from 'lucide-react';
import type { AppBuildSummary } from '@ever-works/contracts';
import { listAppBuildsAction } from '@/app/actions/dashboard/app-builds';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatAppBuildDuration, shortSha } from '@/lib/works/app-builds.shared';
import { AppBuildStatusChip } from './AppBuildStatusChip';
import { useStartAppBuild } from './use-start-app-build';

/**
 * APW-05 T28 — the Overview's **Latest build** card (spec §6.4):
 * `✓ Succeeded · main · 9f8e7d6 · 18m 42s`, which commit the newest deployable
 * Build is from, **Open Builds**, and **Start build**.
 *
 * `initialBuilds` is the server's first read (`listLatestAppBuilds`), newest
 * first; `null` means the list could not be read, which renders the calm
 * "not available on this instance yet" line — the Overview never shows a Builds
 * error.
 */
export interface AppBuildsOverviewCardProps {
    workId: string;
    initialBuilds: AppBuildSummary[] | null;
    /** Edit access; defaults to `true` because the API refuses a viewer anyway. */
    canEdit?: boolean;
}

export function AppBuildsOverviewCard({
    workId,
    initialBuilds,
    canEdit = true,
}: AppBuildsOverviewCardProps) {
    const t = useTranslations('dashboard.workDetail.builds');
    const [builds, setBuilds] = useState<AppBuildSummary[] | null>(initialBuilds);

    const { start, starting } = useStartAppBuild({
        workId,
        canEdit,
        onStarted: async () => {
            const result = await listAppBuildsAction(workId, { pageSize: 20 });
            if (result.success && result.data) setBuilds(result.data.items);
        },
    });

    const latest = builds?.[0] ?? null;
    const latestDeployable = builds?.find((build) => build.deployable) ?? null;

    return (
        <section
            data-testid="app-builds-overview-card"
            className={cn(
                'rounded-lg p-4 space-y-3',
                'bg-card dark:bg-transparent',
                'border border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('overview.title')}
                </h3>
                <div className="flex items-center gap-2">
                    <Link
                        href={ROUTES.DASHBOARD_WORK_BUILDS(workId)}
                        className="text-sm font-medium text-primary hover:underline dark:text-primary-dark"
                    >
                        {t('overview.open')}
                    </Link>
                    {builds !== null && (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => start()}
                            disabled={!canEdit || starting}
                            loading={starting}
                            title={canEdit ? undefined : t('viewerDisabled')}
                            data-testid="app-build-overview-start"
                        >
                            <Hammer className="h-3.5 w-3.5" aria-hidden="true" />
                            {starting ? t('starting') : t('startBuild')}
                        </Button>
                    )}
                </div>
            </div>

            {builds === null && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('empty.unavailable')}
                </p>
            )}

            {builds !== null && !latest && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('empty.noBuilds')}
                </p>
            )}

            {latest && (
                <div className="space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-text dark:text-text-dark">
                        <AppBuildStatusChip status={latest.status} />
                        <span>
                            {[
                                latest.branch,
                                shortSha(latest.commitSha),
                                formatAppBuildDuration(latest.durationSeconds),
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                    </p>
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="app-builds-overview-deployable"
                    >
                        {latestDeployable
                            ? latestDeployable.commitSha === latest.commitSha
                                ? t('overview.deployableSame')
                                : t('overview.deployableOther', {
                                      sha: shortSha(latestDeployable.commitSha),
                                  })
                            : t('overview.noDeployable')}
                    </p>
                </div>
            )}
        </section>
    );
}
