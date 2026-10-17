'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, ExternalLink } from 'lucide-react';
import {
    APP_BUILD_FAILURE_CLASSES,
    type AppBuildDetail,
    type AppBuildFailureClass,
    type AppBuildSummary,
} from '@ever-works/contracts';
import { getAppBuildAction } from '@/app/actions/dashboard/app-builds';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    appBuildImageReference,
    appBuildMessageParams,
    appBuildTriggerKey,
    formatAppBuildDuration,
    shortSha,
} from '@/lib/works/app-builds.shared';
import { AppBuildStatusChip } from './AppBuildStatusChip';
import { AppBuildBlockedNotice } from './AppBuildBlockedNotice';

/**
 * APW-05 T27 — one Build's detail drawer and its failure panel (spec §6.2,
 * §6.3).
 *
 * It opens with the row's summary at once and fills in the detail
 * (`GET /api/works/:id/builds/:buildId`) when it arrives, so a slow read never
 * shows an empty panel. `Esc` closes it and the dialog primitive returns focus
 * to the row that opened it; `C` copies the image reference (spec §6.6).
 */
export interface AppBuildDrawerProps {
    workId: string;
    build: AppBuildSummary | null;
    onClose: () => void;
    canEdit: boolean;
    workflowPullRequestUrl?: string | null;
    repositoryFullName?: string | null;
    /** Start a Build — of `commitSha` for **Rebuild this commit**, of the branch head otherwise. */
    onRebuild?: (commitSha?: string) => void;
}

function isFailureClass(value: unknown): value is AppBuildFailureClass {
    return (
        typeof value === 'string' &&
        (APP_BUILD_FAILURE_CLASSES as readonly string[]).includes(value)
    );
}

/**
 * The failure panel: the class's title and suggestion with the Build's
 * `failureDetail` values, and the redacted excerpt in a `<pre>`.
 */
export function AppBuildFailurePanel({
    failureClass,
    failureDetail,
    excerpt,
}: {
    failureClass: AppBuildFailureClass;
    failureDetail: Record<string, unknown> | null | undefined;
    excerpt?: readonly string[];
}) {
    const t = useTranslations('dashboard.workDetail.builds.failure');
    const params = appBuildMessageParams(failureDetail ?? undefined);
    return (
        <section
            data-testid={`app-build-failure-${failureClass}`}
            className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20"
        >
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">
                {t(`${failureClass}.title`, params)}
            </h3>
            <p className="mt-1 text-sm text-red-800/90 dark:text-red-200/90">
                {t(`${failureClass}.suggestion`, params)}
            </p>
            {excerpt && excerpt.length > 0 && (
                <div className="mt-3">
                    <p className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                        {t('excerptLabel')}
                    </p>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/80 p-2 text-xs text-gray-100 whitespace-pre-wrap break-all">
                        {excerpt.join('\n')}
                    </pre>
                </div>
            )}
        </section>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-[8rem_1fr] gap-3 py-1.5 text-sm">
            <dt className="text-text-secondary dark:text-text-secondary-dark">{label}</dt>
            <dd className="min-w-0 break-words text-text dark:text-text-dark">{children}</dd>
        </div>
    );
}

export function AppBuildDrawer({
    workId,
    build,
    onClose,
    canEdit,
    workflowPullRequestUrl,
    repositoryFullName,
    onRebuild,
}: AppBuildDrawerProps) {
    const t = useTranslations('dashboard.workDetail.builds');
    const [detail, setDetail] = useState<AppBuildDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    const buildId = build?.id ?? null;

    useEffect(() => {
        if (!buildId) {
            setDetail(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setLoadFailed(false);
        setDetail(null);
        void getAppBuildAction(workId, buildId)
            .then((result) => {
                if (cancelled) return;
                if (result.success && result.data) setDetail(result.data);
                else setLoadFailed(true);
            })
            .catch(() => {
                if (!cancelled) setLoadFailed(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // `build?.status`: the list's poll replaces the summary; a detail read
        // while the build was running must not keep overriding the newer status,
        // image and failure fields once it finishes — so refetch on a change.
    }, [workId, buildId, build?.status]);

    // The row's summary first, the detail over it once it arrives.
    const view: (AppBuildSummary & Partial<AppBuildDetail>) | null = build
        ? { ...build, ...(detail && detail.id === build.id ? detail : {}) }
        : null;
    const imageReference = view ? appBuildImageReference(view) : null;

    const copyImage = () => {
        if (!imageReference) return;
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard) {
            toast.error(t('detail.copyFailed'));
            return;
        }
        void clipboard.writeText(imageReference).then(
            () => toast.success(t('detail.copied')),
            () => toast.error(t('detail.copyFailed')),
        );
    };

    useEffect(() => {
        if (!build) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'c' && event.key !== 'C') return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (
                target &&
                (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
            ) {
                return;
            }
            copyImage();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // copyImage closes over the current image reference only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [build, imageReference]);

    const triggerLabel = view
        ? t(`trigger.${appBuildTriggerKey(view.trigger)}`, { number: view.pullRequestNumber ?? '' })
        : '';
    const failureClass = view && isFailureClass(view.failureClass) ? view.failureClass : null;

    return (
        <Dialog open={Boolean(build)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl">
                {view && (
                    <div data-testid="app-build-drawer">
                        <DialogHeader className="flex items-start justify-between gap-3">
                            <DialogTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold text-text dark:text-text-dark">
                                {t('detail.title', {
                                    number: view.number,
                                    sha: shortSha(view.commitSha),
                                    status: t(`status.${view.status}`),
                                })}
                                <AppBuildStatusChip status={view.status} />
                            </DialogTitle>
                            <DialogClose onClose={onClose} />
                        </DialogHeader>

                        {loading && (
                            <p className="mb-2 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('detail.loading')}
                            </p>
                        )}
                        {loadFailed && (
                            <p className="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">
                                {t('errors.detailFailed')}
                            </p>
                        )}

                        {view.status === 'blocked' && (
                            <div className="mb-3">
                                <AppBuildBlockedNotice
                                    workId={workId}
                                    build={view}
                                    canEdit={canEdit}
                                    workflowPullRequestUrl={workflowPullRequestUrl}
                                    repositoryFullName={repositoryFullName}
                                    onRebuild={onRebuild ? () => onRebuild() : undefined}
                                />
                            </div>
                        )}

                        {failureClass && (
                            <div className="mb-3">
                                <AppBuildFailurePanel
                                    failureClass={failureClass}
                                    failureDetail={view.failureDetail}
                                    excerpt={view.failureExcerpt}
                                />
                            </div>
                        )}

                        <dl className="divide-y divide-border dark:divide-border-dark">
                            <Row label={t('detail.trigger')}>
                                {view.triggeredBy?.name
                                    ? t('detail.triggeredBy', {
                                          trigger: triggerLabel,
                                          name: view.triggeredBy.name,
                                      })
                                    : triggerLabel}
                            </Row>
                            <Row label={t('detail.commit')}>
                                <code className="font-mono text-xs">
                                    {t('detail.commitValue', {
                                        sha: shortSha(view.commitSha),
                                        branch: view.branch,
                                    })}
                                </code>
                            </Row>
                            {view.runnerLabel && (
                                <Row label={t('detail.runner')}>{view.runnerLabel}</Row>
                            )}
                            <Row label={t('detail.duration')}>
                                {formatAppBuildDuration(view.durationSeconds) ||
                                    t('detail.notAvailable')}
                            </Row>
                            {imageReference && (
                                <Row label={t('detail.image')}>
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                        <code className="font-mono text-xs break-all">
                                            {imageReference}
                                        </code>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={copyImage}
                                            data-testid="app-build-copy-image"
                                        >
                                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                            {t('detail.copy')}
                                        </Button>
                                    </span>
                                </Row>
                            )}
                            {view.imageTags && view.imageTags.length > 0 && (
                                <Row label={t('detail.tags')}>
                                    <span className="font-mono text-xs">
                                        {view.imageTags.join('  ')}
                                    </span>
                                </Row>
                            )}
                            {view.status === 'succeeded' && (
                                <Row label={t('detail.deployable')}>
                                    {view.deployable
                                        ? t('detail.yes')
                                        : t('notDeployableLine', {
                                              reason: t(
                                                  `notDeployable.${view.notDeployableReason ?? 'notSucceeded'}`,
                                              ),
                                          })}
                                </Row>
                            )}
                            {view.buildValueNames && (
                                <Row label={t('detail.buildValues')}>
                                    {view.buildValueNames.length > 0
                                        ? t('detail.buildValuesValue', {
                                              count: view.buildValueNames.length,
                                              names: view.buildValueNames.join(', '),
                                          })
                                        : t('detail.noBuildValues')}
                                </Row>
                            )}
                            {view.receipt && (
                                <Row label={t('detail.receipt')}>
                                    {view.receipt.billableMinutes === null
                                        ? t('receipt.costUnknown')
                                        : t(
                                              view.receipt.payer === 'platform'
                                                  ? 'receipt.minutesPlatform'
                                                  : 'receipt.minutes',
                                              { minutes: view.receipt.billableMinutes },
                                          )}
                                    {view.receipt.checksBillableMinutes
                                        ? ` · ${t('receipt.checksMinutes', {
                                              checksMinutes: view.receipt.checksBillableMinutes,
                                          })}`
                                        : null}
                                </Row>
                            )}
                            {view.verificationResult && (
                                <Row label={t('detail.verification')}>
                                    <ul
                                        className="space-y-0.5"
                                        data-testid="app-build-verification"
                                    >
                                        <li>
                                            {view.verificationResult.componentsReady
                                                ? t('verification.componentsReady')
                                                : t('verification.componentsNotReady')}
                                        </li>
                                        {view.verificationResult.jobs.map((job) => (
                                            <li key={`job-${job.name}`}>
                                                {job.exitCode === null
                                                    ? t('verification.jobNoExit', {
                                                          name: job.name,
                                                      })
                                                    : t('verification.job', {
                                                          name: job.name,
                                                          exitCode: job.exitCode,
                                                      })}
                                            </li>
                                        ))}
                                        {view.verificationResult.smoke.map((smoke) => (
                                            <li key={`smoke-${smoke.name}`}>
                                                {smoke.passed
                                                    ? t('verification.smokePassed', {
                                                          name: smoke.name,
                                                      })
                                                    : t('verification.smokeFailed', {
                                                          name: smoke.name,
                                                          expected: smoke.expected,
                                                          observed: smoke.observed,
                                                      })}
                                            </li>
                                        ))}
                                    </ul>
                                </Row>
                            )}
                        </dl>

                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                            {view.logsUrl && (
                                <a
                                    href={view.logsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-dark"
                                >
                                    {t('detail.viewLogs')}
                                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                </a>
                            )}
                            {onRebuild && (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onRebuild(view.commitSha)}
                                    disabled={!canEdit}
                                    title={canEdit ? undefined : t('viewerDisabled')}
                                >
                                    {t('detail.rebuildThisCommit')}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
