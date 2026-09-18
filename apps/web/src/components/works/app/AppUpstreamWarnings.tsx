'use client';

import { useTranslations } from 'next-intl';
import { ROUTES } from '@/lib/constants';
import type { AppUpstreamStateResponse, AppUpstreamWarning } from '@ever-works/contracts';

/**
 * APW-02 T30 — the warning list under the Upstream card (plan §5.2,
 * `plan.md:635`; spec §6.2, `spec.md:519-534`).
 *
 * ## One row per code, never a composed sentence
 *
 * Every warning is a member of the closed set `APP_UPSTREAM_WARNING_CODES`
 * (`packages/contracts/src/apps/app-upstream.ts:116-132`, FR-65) and renders the
 * leaf `appUpstream.warnings.<code>` — so the test id
 * (`app-upstream-warning-<code>`), the leaf name and the wire value are the same
 * string and a new member arrives with its copy, not with a special case here.
 *
 * ## The actions of spec §6.2
 *
 * | Warning                                       | Action                                          |
 * | --------------------------------------------- | ----------------------------------------------- |
 * | `upstreamUnavailable`                         | **Check again** → re-reads the card             |
 * | `forkMissing` · `privateCopyMissing` · `needsAdmin` | **Open on GitHub** → the Work Repository  |
 * | `historyRewritten`                            | **Open pull request** → the sync pull request   |
 * | `appPermissionMissing`                        | **Review GitHub App access** → settings         |
 * | `workflowsGated`                              | **Enable the build workflow** → the Actions tab |
 * | everything else                               | no action (the row is the whole message)        |
 *
 * **Check again** is a re-read and nothing else, and that is a deliberate,
 * documented seam: the epic ships exactly three routes (`plan.md:492-496`) and
 * none of them re-checks an unavailable upstream on demand — the daily re-check
 * is the dispatcher's (`plan.md:812-813`,
 * `apps/api/src/app-works/app-upstream.controller.ts:56-61`) — and a manual sync
 * is refused with `409 sync_paused` while the upstream is unavailable
 * (`plan.md:513`). Re-reading is therefore the only honest thing the button can
 * do until a re-check route exists; it never claims to have changed anything.
 */
export interface AppUpstreamWarningsProps {
    warnings: AppUpstreamWarning[];
    /** The Work Repository the two "Open on GitHub" actions point at. */
    dataRepository: AppUpstreamStateResponse['dataRepository'];
    /** The open sync pull request, when there is one (`historyRewritten`). */
    pullRequest?: { number: number; url: string };
    /** **Check again** — re-reads the card. */
    onCheckAgain?: () => void;
}

/** The warnings that carry an action, and which one (spec §6.2). */
type WarningAction =
    | 'checkAgain'
    | 'openOnGitHub'
    | 'openPullRequest'
    | 'reviewGitHubAppAccess'
    | 'enableBuildWorkflow';

const WARNING_ACTIONS: Partial<Record<AppUpstreamWarning['code'], WarningAction>> = {
    upstreamUnavailable: 'checkAgain',
    forkMissing: 'openOnGitHub',
    privateCopyMissing: 'openOnGitHub',
    needsAdmin: 'openOnGitHub',
    historyRewritten: 'openPullRequest',
    appPermissionMissing: 'reviewGitHubAppAccess',
    workflowsGated: 'enableBuildWorkflow',
};

export function AppUpstreamWarnings({
    warnings,
    dataRepository,
    pullRequest,
    onCheckAgain,
}: AppUpstreamWarningsProps) {
    const t = useTranslations('dashboard.workDetail.appUpstream');

    if (warnings.length === 0) {
        return null;
    }

    return (
        <ul className="space-y-1.5" aria-live="polite">
            {warnings.map((warning) => {
                const action = WARNING_ACTIONS[warning.code];

                return (
                    <li
                        key={`${warning.code}:${JSON.stringify(warning.params ?? {})}`}
                        data-testid={`app-upstream-warning-${warning.code}`}
                        className="flex flex-wrap items-baseline gap-x-2 text-xs text-amber-700 dark:text-amber-300"
                    >
                        <span>{t(`warnings.${warning.code}`, warning.params)}</span>
                        {action === 'checkAgain' && onCheckAgain && (
                            <button
                                type="button"
                                data-testid={`app-upstream-warning-${warning.code}-action`}
                                onClick={onCheckAgain}
                                className="font-medium underline hover:no-underline"
                            >
                                {t('warnings.checkAgain')}
                            </button>
                        )}
                        {action === 'openOnGitHub' && (
                            <a
                                data-testid={`app-upstream-warning-${warning.code}-action`}
                                href={dataRepository.url}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline hover:no-underline"
                            >
                                {t('warnings.openOnGitHub')}
                            </a>
                        )}
                        {action === 'openPullRequest' && pullRequest && (
                            <a
                                data-testid={`app-upstream-warning-${warning.code}-action`}
                                href={pullRequest.url}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline hover:no-underline"
                            >
                                {t('openPullRequest')}
                            </a>
                        )}
                        {action === 'reviewGitHubAppAccess' && (
                            <a
                                data-testid={`app-upstream-warning-${warning.code}-action`}
                                href={ROUTES.DASHBOARD_SETTINGS_GITHUB_APP}
                                className="font-medium underline hover:no-underline"
                            >
                                {t('warnings.reviewGitHubAppAccess')}
                            </a>
                        )}
                        {/*
                         * Spec §6.2's action for a gated fork is "Enable the build
                         * workflow". Provisional seam — **no route enables it**:
                         * T51 does it from the readiness job through
                         * `setActionsPermissions` (`tasks.md:802-822`), the epic
                         * ships no HTTP door for a person, and the whole-
                         * repository Actions switch is `administration`, which the
                         * matrix grants the member rather than the platform
                         * (`plan.md:592-606`). The action therefore points at the
                         * fork's own Actions tab — the one place a person can do
                         * it today — instead of pretending a platform route exists.
                         */}
                        {action === 'enableBuildWorkflow' && (
                            <a
                                data-testid={`app-upstream-warning-${warning.code}-action`}
                                href={`${dataRepository.url}/actions`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline hover:no-underline"
                            >
                                {t('warnings.enableBuildWorkflow')}
                            </a>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
