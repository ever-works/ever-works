'use client';

import { useTranslations } from 'next-intl';
import { AppWindow, MessageSquare } from 'lucide-react';
import type { AppUpstreamStateResponse, WorkAppSpecStateDto } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { ChatAboutButton } from '@/components/ai/conversations/ConversationEntryButtons';

/** The App spec states the card names; anything else reads "Not checked yet". */
const APP_SPEC_STATUS_LEAVES = new Set([
    'valid',
    'valid_with_warnings',
    'invalid',
    'missing',
    'unreadable',
]);

export type AppSpecStatusLeaf =
    | 'valid'
    | 'valid_with_warnings'
    | 'invalid'
    | 'missing'
    | 'unreadable'
    | 'pending'
    | 'unknown';

/** Which App spec status line to show (`null` state = not read / not checked yet). */
export function appSpecStatusLeaf(spec: WorkAppSpecStateDto | null): AppSpecStatusLeaf {
    if (!spec) return 'unknown';
    const status = String(spec.validationStatus ?? '');
    if (APP_SPEC_STATUS_LEAVES.has(status)) return status as AppSpecStatusLeaf;
    if (spec.dispatchedAt && !spec.lastEvaluatedAt) return 'pending';
    return 'unknown';
}

export interface AppWorkOverviewCardProps {
    workId: string;
    workName: string;
    /** `null` when the Upstream read failed — the card still renders its links. */
    upstreamState: AppUpstreamStateResponse | null;
    /** `null` when the App spec read failed or there is none yet. */
    appSpec: WorkAppSpecStateDto | null;
}

const row = 'flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-sm';
const label = 'text-text-secondary dark:text-text-secondary-dark';
const value = 'font-medium text-text dark:text-text-dark';

/**
 * APW-01 T24 — the App Work's Overview card: the Work Repository and its
 * relation to upstream, readiness, the App spec's status, the Blueprint, and
 * the way into Builds, Deploy and the Upstream tab — plus the entry point to
 * evolve the app by chatting with the Work's agent (APW-08; the Conversation
 * opens docked, with this Work attached as its context).
 */
export function AppWorkOverviewCard({
    workId,
    workName,
    upstreamState,
    appSpec,
}: AppWorkOverviewCardProps) {
    const t = useTranslations('dashboard.workDetail.appSource.overview');
    const tChat = useTranslations('dashboard.workDetail.appSource.chat');

    const relation = upstreamState?.relation ?? null;
    const repo = upstreamState?.dataRepository ?? null;
    const upstream = upstreamState?.upstream ?? null;
    const specLeaf = appSpecStatusLeaf(appSpec);
    const hasUpstreamTab = relation === 'fork' || relation === 'private-copy';

    return (
        <section
            data-testid="app-work-overview"
            className={cn(
                'rounded-lg border p-5 space-y-4',
                'bg-card dark:bg-transparent border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="flex items-center gap-2">
                <AppWindow
                    className="h-4 w-4 text-fuchsia-600 dark:text-fuchsia-300"
                    aria-hidden="true"
                />
                <h2 className="text-base font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
            </div>

            {!upstreamState && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('unavailable')}
                </p>
            )}

            <dl className="divide-y divide-border/60 dark:divide-border-dark/60">
                {repo && (
                    <div className={row}>
                        <dt className={label}>{t('repository')}</dt>
                        <dd className={value}>
                            <a
                                href={repo.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="hover:underline"
                            >
                                {repo.owner}/{repo.repo}
                            </a>
                        </dd>
                    </div>
                )}
                {relation && (
                    <div className={row}>
                        <dt className={label}>{t('relationLabel')}</dt>
                        <dd className={value} data-testid="app-work-overview-relation">
                            {t(`relations.${relation}`)}
                        </dd>
                    </div>
                )}
                {upstream && relation !== 'link' && (
                    <div className={row}>
                        <dt className={label}>{t('upstream')}</dt>
                        <dd className={value}>
                            <a
                                href={upstream.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="hover:underline"
                            >
                                {upstream.owner}/{upstream.repo}
                            </a>
                        </dd>
                    </div>
                )}
                {upstreamState && (
                    <div className={row}>
                        <dt className={label}>{t('readinessLabel')}</dt>
                        <dd className={value} data-testid="app-work-overview-readiness">
                            {t(`readiness.${upstreamState.readiness.state}`)}
                        </dd>
                    </div>
                )}
                <div className={row}>
                    <dt className={label}>{t('appSpecLabel')}</dt>
                    <dd
                        className={cn(value, 'flex flex-wrap items-baseline gap-2')}
                        data-testid="app-work-overview-spec"
                    >
                        <span>{t(`appSpecStatus.${specLeaf}`)}</span>
                        {appSpec &&
                            (specLeaf === 'invalid' || specLeaf === 'valid_with_warnings') && (
                                <span className="text-xs font-normal text-text-secondary dark:text-text-secondary-dark">
                                    {t('appSpecIssues', {
                                        errors: appSpec.errorCount,
                                        warnings: appSpec.warningCount,
                                    })}
                                </span>
                            )}
                        <Link
                            href={ROUTES.DASHBOARD_WORK_SETTINGS_APP_SPEC(workId)}
                            className="text-xs font-medium underline"
                        >
                            {t('openAppSpec')}
                        </Link>
                    </dd>
                </div>
                {appSpec?.blueprintId && (
                    <div className={row}>
                        <dt className={label}>{t('blueprintLabel')}</dt>
                        <dd className={value}>{appSpec.blueprintId}</dd>
                    </div>
                )}
            </dl>

            <nav className="flex flex-wrap gap-2" aria-label={t('title')}>
                <Link
                    href={ROUTES.DASHBOARD_WORK_BUILDS(workId)}
                    className="rounded-md border border-border dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/5"
                    data-testid="app-work-overview-builds"
                >
                    {t('builds')}
                </Link>
                <Link
                    href={ROUTES.DASHBOARD_WORK_DEPLOY(workId)}
                    className="rounded-md border border-border dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/5"
                    data-testid="app-work-overview-deploy"
                >
                    {t('deploy')}
                </Link>
                {hasUpstreamTab && (
                    <Link
                        href={ROUTES.DASHBOARD_WORK_UPSTREAM(workId)}
                        className="rounded-md border border-border dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/5"
                    >
                        {t('upstreamTab')}
                    </Link>
                )}
            </nav>

            <div
                className="rounded-md border border-dashed border-border dark:border-border-dark p-3 space-y-2"
                data-testid="app-work-overview-chat"
            >
                <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {tChat('title')}
                    </h3>
                </div>
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {tChat('body')}
                </p>
                {/* Opens the docked Conversation's participant switcher with this
                    Work attached, so the Work's agent works in its repository.
                    Renders nothing outside the dashboard chat shell. */}
                <ChatAboutButton contextType="work" contextId={workId} label={workName} />
            </div>
        </section>
    );
}
