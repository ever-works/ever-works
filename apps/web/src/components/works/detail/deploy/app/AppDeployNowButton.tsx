'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Rocket, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requestAppDeployAction } from '@/app/actions/dashboard/app-runtime';
import {
    appPreconditionLeaf,
    isAppOwnerRequired,
    type AppDeployNotice,
} from '@/lib/api/app-runtime.types';

/** The managed-tier refusals whose API message names the reason (lane aw-safety). */
const MANAGED_REFUSAL_CODES = new Set(['quota_exceeded', 'managed_ineligible']);

export interface AppDeployNowButtonProps {
    workId: string;
    /** A specific Build to deploy; omitted = the latest deployable Build. */
    buildId?: string;
    disabled?: boolean;
    /** Called with the Deployment id once the API accepted the request. */
    onRequested?: (deploymentId: string | null) => void;
}

type Outcome =
    | { kind: 'preconditions'; unmet: AppDeployNotice[] }
    | { kind: 'inProgress'; id: string }
    | { kind: 'message'; text: string }
    | null;

/**
 * APW-06 T37 — **Deploy now** (`POST /api/works/:id/deploy`).
 *
 * Single-flight: a second press while a request is in the air is ignored, so
 * one click is one Deployment request (the API dedupes as well). Every answer
 * the controller gives is rendered rather than collapsed into a toast:
 *
 *  - `202` → a success toast naming the Deployment (or "Queued" when it waits
 *    behind a running one);
 *  - `409 APP_DEPLOY_IN_PROGRESS` → the running Deployment's id;
 *  - `422 APP_DEPLOY_PRECONDITIONS` → **Fix these before deploying:** with one
 *    row per unmet code (ACC-06-19), in our copy when we know the code and in
 *    the API's words when we do not;
 *  - `422 worker_not_isolated` → why nothing can deploy on this instance yet;
 *  - `403 ownerRequired` (works-security) → "Only the Work owner can do this." — this button never
 *    sends `confirmClusterChange`, so the refusal means another member saved the cluster
 *    connection and the owner's own Deploy has to confirm it, which the line says too. Any other
 *    `403` (the owner's API key) is shown in the API's words.
 */
export function AppDeployNowButton({
    workId,
    buildId,
    disabled,
    onRequested,
}: AppDeployNowButtonProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.deployNow');
    const tPre = useTranslations('dashboard.workDetail.appDeploy.preconditions');
    const tApp = useTranslations('dashboard.workDetail.appDeploy');
    const inFlight = useRef(false);
    const [pending, setPending] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [warnings, setWarnings] = useState<AppDeployNotice[]>([]);

    const describe = (notice: AppDeployNotice) => {
        const leaf = appPreconditionLeaf(notice.code);
        // Lane aw-safety (2026-10-26): the managed tier's two refusals carry the API's precise
        // reason (the cap and the counted Apps; the unverified email; the paid plan), which the
        // generic leaf cannot say — so it follows the leaf.
        if (leaf && MANAGED_REFUSAL_CODES.has(notice.code) && notice.message) {
            return `${tPre(leaf)} ${notice.message}`;
        }
        return leaf ? tPre(leaf) : notice.message || notice.code;
    };

    const deploy = async () => {
        if (inFlight.current || disabled) return;
        inFlight.current = true;
        setPending(true);
        setOutcome(null);
        try {
            const result = await requestAppDeployAction(workId, buildId ? { buildId } : {});
            const data = result.data;
            setWarnings([...(data?.warnings ?? []), ...(data?.advisory ?? [])]);

            if (result.success && data) {
                const id = data.deploymentId ?? data.queuedDeploymentId ?? null;
                if (data.deduplicated) toast.success(t('deduplicated'));
                else if (data.queuedDeploymentId && !data.deploymentId) toast.success(t('queued'));
                else
                    toast.success(
                        id ? `${t('started')} ${t('deploymentId', { id })}` : t('started'),
                    );
                onRequested?.(id);
                return;
            }

            const code = result.code ?? data?.code ?? null;
            if (isAppOwnerRequired({ code })) {
                setOutcome({
                    kind: 'message',
                    text: `${tApp('ownerRequired')} ${tApp('ownerConfirmCluster')}`,
                });
                return;
            }
            if (result.httpStatus === 409 || code === 'APP_DEPLOY_IN_PROGRESS') {
                setOutcome({ kind: 'inProgress', id: data?.runningDeploymentId ?? '' });
                return;
            }
            if (code === 'worker_not_isolated') {
                setOutcome({ kind: 'message', text: t('workerNotIsolated') });
                return;
            }
            if (code === 'notAnAppWork') {
                setOutcome({ kind: 'message', text: t('notAppWork') });
                return;
            }
            const unmet = data?.unmet?.length ? data.unmet : (result.unmet ?? []);
            if (unmet.length > 0) {
                setOutcome({ kind: 'preconditions', unmet });
                return;
            }
            setOutcome({
                kind: 'message',
                text: t('failed', { reason: result.error ?? code ?? '' }),
            });
        } catch {
            // A rejection at the server-action boundary is still a failure the
            // member is told about.
            setOutcome({ kind: 'message', text: t('failed', { reason: '' }) });
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    return (
        <div className="space-y-3" data-testid="app-deploy-now">
            <Button
                type="button"
                variant="primary"
                onClick={deploy}
                disabled={disabled || pending}
                loading={pending}
                className="gap-1.5"
                data-testid="app-deploy-now-button"
            >
                <Rocket className="h-4 w-4" aria-hidden="true" />
                {pending ? t('deploying') : t('button')}
            </Button>

            {outcome?.kind === 'preconditions' && (
                <div
                    role="alert"
                    className="rounded-md border border-danger/40 p-3 text-sm"
                    data-testid="app-deploy-preconditions"
                >
                    <p className="font-medium text-text dark:text-text-dark">
                        {t('preconditionsHeader')}
                    </p>
                    <ul className="mt-2 space-y-1">
                        {outcome.unmet.map((entry, index) => (
                            <li
                                key={`${entry.code}-${index}`}
                                className="flex items-start gap-2 text-danger"
                                data-testid="app-deploy-precondition"
                                data-code={entry.code}
                            >
                                <XCircle
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                />
                                {describe(entry)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {outcome?.kind === 'inProgress' && (
                <p
                    role="alert"
                    className="text-sm text-danger"
                    data-testid="app-deploy-in-progress"
                >
                    {t('inProgress', { id: outcome.id })}
                </p>
            )}
            {outcome?.kind === 'message' && (
                <p role="alert" className="text-sm text-danger" data-testid="app-deploy-message">
                    {outcome.text}
                </p>
            )}
            {warnings.length > 0 && (
                <div className="text-sm" data-testid="app-deploy-warnings">
                    <p className="font-medium text-text dark:text-text-dark">
                        {t('warningsHeader')}
                    </p>
                    <ul className="mt-1 space-y-1">
                        {warnings.map((entry, index) => (
                            <li
                                key={`${entry.code}-${index}`}
                                className="flex items-start gap-2 text-warning"
                            >
                                <AlertTriangle
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                />
                                {describe(entry)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
