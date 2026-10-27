'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Activity, FlaskConical, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { appRuntimeOpsClient } from '@/lib/api/app-runtime-ops.client';
import type { AppStatusRequestView, AppStatusView } from '@/lib/api/app-runtime.types';
import { AppComponentsTable } from './AppComponentsTable';
import { AppSmokeResults } from './AppSmokeResults';
import { AppJobsList } from './AppJobsList';
import { AppCronList } from './AppCronList';
import { AppLogsDrawer, type AppLogsTarget } from './AppLogsDrawer';
import { minutesSince, useClientNow } from './app-ops-format';
import { isAppStatusBusy } from './useAppStatusPoll';

export interface AppLiveCardProps {
    workId: string;
    status: AppStatusView;
    /** Whether the member can deploy: Refresh, Run smoke checks, Run now and logs (S28). */
    canEdit: boolean;
    /** Re-read the status now (after an action was accepted). */
    onReload?: () => void | Promise<void>;
}

/** FR-46 — a snapshot older than this reads "Last checked <n> minutes ago". */
const STALE_MINUTES = 3;

/** An op id → its `live.requests.*` leaf. */
const REQUEST_LEAF = {
    'status-refresh': 'refresh',
    'job-run': 'job',
    smoke: 'smoke',
} as const;
type RequestLeaf = (typeof REQUEST_LEAF)[keyof typeof REQUEST_LEAF];

/** Refusals of Refresh / Run smoke checks with their own sentence → `live.refusals.*`. */
const ACTION_REFUSALS = {
    app_not_deployed: 'notDeployed',
    app_paused: 'paused',
    deploy_in_progress: 'deployInProgress',
    APP_WORK_DELETING: 'deleting',
    forbidden: 'forbidden',
} as const;
type ActionRefusalLeaf = (typeof ACTION_REFUSALS)[keyof typeof ACTION_REFUSALS];

/**
 * Lane aw-ops (APW-06 T38, spec §6.3 "Deploy tab — live", FR-46) — what is running now: the
 * components with their replicas and restarts, the latest smoke results and network isolation,
 * the jobs with **Logs** / **Run now**, the scheduled calls, the operations still in flight, and
 * when the cluster was last observed.
 *
 * **Refresh** asks the isolated worker for a new snapshot — once per 15 s per App Work; a refusal
 * inside the window becomes a countdown. **Run smoke checks** re-runs the App spec's checks
 * against the live Deployment. Viewers see everything here but none of the buttons (S28).
 */
export function AppLiveCard({ workId, status, canEdit, onReload }: AppLiveCardProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.live');
    const tApp = useTranslations('dashboard.workDetail.appDeploy');
    const now = useClientNow(15_000);
    const [pending, setPending] = useState<'refresh' | 'smoke' | null>(null);
    const [cooldown, setCooldown] = useState(0);
    const [logsTarget, setLogsTarget] = useState<AppLogsTarget | null>(null);
    const inFlight = useRef(false);

    useEffect(() => {
        if (cooldown <= 0) return;
        const id = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1_000);
        return () => clearTimeout(id);
    }, [cooldown]);

    const snapshot = status.snapshot ?? null;
    const components = snapshot?.components ?? [];
    const jobs = snapshot?.jobs ?? [];
    const cron = snapshot?.cron ?? [];
    const deployed = status.state !== 'not-deployed' && status.state !== 'deleting';
    const paused = status.state === 'paused';
    const deploying = isAppStatusBusy({ ...status, requests: [] });
    const minutes = minutesSince(status.observedAt, now);
    const inFlightRequests = (status.requests ?? []).filter(
        (request) => request.state === 'queued' || request.state === 'running',
    );
    const failedRequests = (status.requests ?? []).filter((request) => request.state === 'failed').slice(0, 3);

    const act = async (kind: 'refresh' | 'smoke') => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(kind);
        try {
            const result =
                kind === 'refresh'
                    ? await appRuntimeOpsClient.refreshStatus(workId)
                    : await appRuntimeOpsClient.runSmoke(workId);
            if (result.ok) {
                if (result.data?.dispatched === false) toast.error(t('notDispatched'));
                else toast.success(kind === 'refresh' ? t('refreshQueued') : t('smokeQueued'));
                await onReload?.();
                return;
            }
            if (result.status === 429) {
                const wait = Math.max(1, result.retryAfterSeconds ?? 15);
                setCooldown(wait);
                toast.error(t('refreshWait', { seconds: wait }));
                return;
            }
            const leaf = result.code
                ? (ACTION_REFUSALS as Readonly<Record<string, ActionRefusalLeaf>>)[result.code]
                : undefined;
            toast.error(
                leaf ? t(`refusals.${leaf}`) : t('actionFailed', { reason: result.message ?? result.code ?? '' }),
            );
        } finally {
            inFlight.current = false;
            setPending(null);
        }
    };

    return (
        <section
            className="space-y-4 rounded-lg border border-card-border p-4 dark:border-border-secondary-dark"
            aria-labelledby="app-live-title"
            data-testid="app-live-card"
            data-state={status.state}
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                    <Activity className="mt-0.5 h-4 w-4 text-text-secondary" aria-hidden="true" />
                    <div className="space-y-0.5">
                        <h3 id="app-live-title" className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h3>
                        <p className="text-xs text-text-secondary" data-testid="app-live-observed">
                            {status.observedAt === null
                                ? t('notObserved')
                                : minutes === null
                                  ? t('observed')
                                  : status.stale || minutes >= STALE_MINUTES
                                    ? tApp('stale', { minutes: Math.max(1, minutes) })
                                    : t('observedRecently')}
                        </p>
                    </div>
                </div>
                {canEdit && deployed && (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => void act('refresh')}
                            loading={pending === 'refresh'}
                            disabled={pending !== null || cooldown > 0}
                            data-testid="app-live-refresh"
                        >
                            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            {cooldown > 0 ? t('refreshIn', { seconds: cooldown }) : t('refresh')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => void act('smoke')}
                            loading={pending === 'smoke'}
                            disabled={pending !== null || paused || deploying}
                            title={paused ? t('refusals.paused') : deploying ? t('refusals.deployInProgress') : undefined}
                            data-testid="app-live-smoke"
                        >
                            <FlaskConical className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            {t('runSmoke')}
                        </Button>
                    </div>
                )}
            </div>

            {(inFlightRequests.length > 0 || failedRequests.length > 0) && (
                <ul className="space-y-0.5 text-xs" data-testid="app-live-requests">
                    {inFlightRequests.map((request) => (
                        <li key={request.requestId} className="text-text-secondary">
                            {t('requests.inFlight', { what: requestLabel(request, t) })}
                        </li>
                    ))}
                    {failedRequests.map((request) => (
                        <li key={request.requestId} className="text-red-700 dark:text-red-400">
                            {t('requests.failed', { what: requestLabel(request, t), code: request.code ?? '' })}
                        </li>
                    ))}
                </ul>
            )}

            <div className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('components')}</h4>
                {snapshot ? (
                    <AppComponentsTable
                        components={components}
                        canReadLogs={canEdit}
                        onLogs={(name) => setLogsTarget({ kind: 'component', name })}
                    />
                ) : (
                    <p className="text-sm text-text-secondary">{t('noSnapshot')}</p>
                )}
            </div>

            <div className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('smoke')}</h4>
                <AppSmokeResults smoke={status.smoke} isolationEnforced={snapshot?.isolationEnforced ?? null} />
            </div>

            {snapshot && (
                <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('jobs')}</h4>
                    <AppJobsList
                        workId={workId}
                        jobs={jobs}
                        canEdit={canEdit && deployed}
                        requests={status.requests}
                        deploying={deploying}
                        onLogs={(name) => setLogsTarget({ kind: 'job', name })}
                        onRan={() => void onReload?.()}
                    />
                </div>
            )}

            {cron.length > 0 && (
                <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('cron')}</h4>
                    <AppCronList cron={cron} />
                </div>
            )}

            {canEdit && logsTarget && (
                <AppLogsDrawer
                    key={`${logsTarget.kind}:${logsTarget.name}`}
                    workId={workId}
                    open
                    onOpenChange={(open) => {
                        if (!open) setLogsTarget(null);
                    }}
                    components={components.map((component) => component.name)}
                    jobs={jobs.map((job) => job.name)}
                    initialTarget={logsTarget}
                />
            )}
        </section>
    );
}

function requestLabel(
    request: AppStatusRequestView,
    t: ReturnType<typeof useTranslations<'dashboard.workDetail.appDeploy.live'>>,
): string {
    const leaf = (REQUEST_LEAF as Readonly<Record<string, RequestLeaf>>)[request.op];
    if (leaf === 'job') return t('requests.job', { name: request.jobName ?? '' });
    if (leaf === 'refresh') return t('requests.refresh');
    if (leaf === 'smoke') return t('requests.smoke');
    return request.op;
}
