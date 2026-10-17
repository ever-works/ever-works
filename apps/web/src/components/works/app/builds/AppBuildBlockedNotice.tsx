'use client';

import { useTranslations } from 'next-intl';
import { Ban, ExternalLink } from 'lucide-react';
import {
    APP_BUILD_BLOCKED_REASONS,
    APP_BUILD_BLOCKED_REASON_ACTIONS,
    type AppBuildBlockedAction,
    type AppBuildSummary,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    appBuildMessageParams,
    isKnownBlockedReason,
    type AppBuildBlockedLink,
} from '@/lib/works/app-builds.shared';

/**
 * APW-05 T26 — a blocked Build's notice: one sentence per reason and the one
 * action that unblocks it (spec §6.4, `APP_BUILD_BLOCKED_REASON_ACTIONS`).
 *
 * The values come from `blockedDetail` (names and numbers only, never a value).
 */
export interface AppBuildBlockedNoticeProps {
    workId: string;
    build: Pick<AppBuildSummary, 'blockedReason' | 'blockedDetail'>;
    /** The build workflow's setup pull request, from the list response. */
    workflowPullRequestUrl?: string | null;
    /** `owner/repo` of the Work Repository, for the GitHub settings links. */
    repositoryFullName?: string | null;
    canEdit: boolean;
    /** Wired for the `rebuild` action. */
    onRebuild?: () => void;
}

function linkFor(
    action: AppBuildBlockedAction,
    props: Pick<
        AppBuildBlockedNoticeProps,
        'workId' | 'workflowPullRequestUrl' | 'repositoryFullName'
    >,
): AppBuildBlockedLink {
    const repo = props.repositoryFullName;
    switch (action) {
        case 'reviewPullRequest':
            return props.workflowPullRequestUrl
                ? { kind: 'external', href: props.workflowPullRequestUrl }
                : null;
        case 'turnOnActions':
            return repo
                ? { kind: 'external', href: `https://github.com/${repo}/settings/actions` }
                : null;
        case 'openRepositorySettings':
            return repo ? { kind: 'external', href: `https://github.com/${repo}/settings` } : null;
        case 'setValue':
        case 'openEnvironment':
            return { kind: 'internal', href: ROUTES.DASHBOARD_WORK_SETTINGS(props.workId) };
        case 'useLargerRunner':
            // Build settings live on the build plugin's Work settings (plan §5).
            return { kind: 'internal', href: ROUTES.DASHBOARD_WORK_PLUGINS(props.workId) };
        case 'reconnectGithub':
            return { kind: 'internal', href: ROUTES.DASHBOARD_SETTINGS_CONNECTIONS };
        case 'rebuild':
            return { kind: 'rebuild' };
        default:
            return null;
    }
}

const actionClass =
    'inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline dark:text-primary-dark';

export function AppBuildBlockedNotice(props: AppBuildBlockedNoticeProps) {
    const t = useTranslations('dashboard.workDetail.builds');
    const reason = props.build.blockedReason;
    if (!isKnownBlockedReason(reason, APP_BUILD_BLOCKED_REASONS)) return null;

    const params = appBuildMessageParams(props.build.blockedDetail ?? undefined);
    const action = APP_BUILD_BLOCKED_REASON_ACTIONS[reason];
    const link = action ? linkFor(action, props) : null;

    return (
        <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-amber-800 dark:text-amber-300"
            data-testid={`app-build-blocked-${reason}`}
        >
            <span className="inline-flex items-center gap-1">
                <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                {t(`blocked.${reason}`, params)}
            </span>
            {action && link?.kind === 'external' && (
                <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={actionClass}
                >
                    {t(`blockedAction.${action}`)}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
            )}
            {action && link?.kind === 'internal' && (
                <Link href={link.href} className={actionClass}>
                    {t(`blockedAction.${action}`)}
                </Link>
            )}
            {action && link?.kind === 'rebuild' && props.onRebuild && (
                <button
                    type="button"
                    className={actionClass}
                    onClick={() => props.onRebuild?.()}
                    disabled={!props.canEdit}
                    title={props.canEdit ? undefined : t('viewerDisabled')}
                >
                    {t(`blockedAction.${action}`)}
                </button>
            )}
        </div>
    );
}
