'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Info } from 'lucide-react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
    checkAppTargetAction,
    getAppTargetAction,
    saveAppTargetAction,
} from '@/app/actions/dashboard/app-runtime';
import {
    APP_RUNTIME_ROUTE_UNAVAILABLE,
    APP_TARGET_TLS_MODES,
    clusterCheckAllowsSave,
    type AppClusterCheckView,
    type AppTargetTlsMode,
    type AppTargetView,
} from '@/lib/api/app-runtime.types';
import { ClusterCheckResult } from './ClusterCheckResult';

/** How often the dialog re-reads the target while the worker checks the cluster. */
export const CLUSTER_CHECK_POLL_INTERVAL_MS = 2_000;
/** 15 polls × 2 s = the 30 s the check is allowed (S2, `APP_CLUSTER_CHECK_TIMEOUT_S`). */
export const CLUSTER_CHECK_POLL_MAX = 15;

const TLS_LEAF = {
    'cert-manager': 'certManager',
    external: 'external',
    edge: 'edge',
    none: 'none',
} as const satisfies Record<AppTargetTlsMode, string>;

export interface ConnectClusterDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workId: string;
    /** The target as last read — its `clusterCheck` seeds the result panel. */
    target: AppTargetView;
    /** Called with the saved target after **Save** succeeds. */
    onSaved: (target: AppTargetView) => void;
    pollIntervalMs?: number;
    pollMax?: number;
}

/**
 * APW-06 T37 (spec §6.2, S2) — **Connect your cluster**.
 *
 * The kubeconfig is sent exactly once, through `checkAppTargetAction` →
 * `POST /api/works/:id/app-target/check`, and is cleared from this dialog the
 * moment the API accepts it. **Save** writes only the target and its settings
 * (`saveAppTargetAction` → `PUT app-target`) — never the kubeconfig, and never
 * through the generic work-plugin-settings action, whose connection validation
 * would dial the pasted cluster from the API process (APW06-G01, ACC-06-56).
 *
 * The check runs on the isolated worker; the dialog re-reads the target until
 * `clusterCheckedAt` moves, for at most 30 seconds. **Save** stays disabled
 * until a check passed with every required permission present (ACC-06-05).
 * `Esc` closes the dialog and returns focus to the opener (Headless UI).
 */
export function ConnectClusterDialog({
    open,
    onOpenChange,
    workId,
    target,
    onSaved,
    pollIntervalMs = CLUSTER_CHECK_POLL_INTERVAL_MS,
    pollMax = CLUSTER_CHECK_POLL_MAX,
}: ConnectClusterDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.connect');
    const ids = useId();

    const [kubeconfig, setKubeconfig] = useState('');
    const [kubeContext, setKubeContext] = useState('');
    const [kubeconfigSent, setKubeconfigSent] = useState(Boolean(target.clusterCheck));
    const [checking, setChecking] = useState(false);
    const [saving, setSaving] = useState(false);
    const [check, setCheck] = useState<AppClusterCheckView | null>(target.clusterCheck);
    const [namespace, setNamespace] = useState<string | null>(target.namespace);
    const [notice, setNotice] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(!target.routeAvailable);

    const [ingressClass, setIngressClass] = useState(target.settings?.ingressClass ?? '');
    const [tls, setTls] = useState<AppTargetTlsMode>(target.settings?.tls ?? 'cert-manager');
    const [issuer, setIssuer] = useState(target.settings?.issuer ?? '');
    const [networkIsolation, setNetworkIsolation] = useState(
        target.settings?.networkIsolation ?? true,
    );

    // A poll that outlives the dialog must not write state. The Deploy page
    // mounts this dialog only while it is open, so unmount is "closed".
    const alive = useRef(true);
    // The newest check this dialog has seen. A second **Check again** (or a
    // newly pasted kubeconfig) must wait for ITS result, not re-adopt the first
    // one, so the baseline advances every time a check is adopted.
    const lastCheckedAt = useRef<string | null>(target.clusterCheckedAt);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const adoptCheck = (next: AppTargetView) => {
        setCheck(next.clusterCheck);
        setNamespace(next.namespace);
        const classes = next.clusterCheck?.ingressClasses ?? [];
        if (!ingressClass && classes.length > 0) {
            setIngressClass((classes.find((c) => c.isDefault) ?? classes[0]).name);
        }
        const issuers = next.clusterCheck?.clusterIssuers ?? [];
        if (!issuer && issuers.length > 0) setIssuer(issuers[0]);
    };

    const runCheck = async () => {
        if (checking) return;
        const pasted = kubeconfig.trim();
        if (!pasted && !kubeconfigSent) {
            setNotice(t('kubeconfigRequired'));
            return;
        }
        setNotice(null);
        setChecking(true);
        const previousCheckedAt = lastCheckedAt.current;
        try {
            const sent = await checkAppTargetAction(workId, {
                ...(pasted ? { kubeconfig: pasted } : {}),
                ...(kubeContext.trim() ? { kubeContext: kubeContext.trim() } : {}),
            });
            if (!sent.success) {
                if (sent.code === APP_RUNTIME_ROUTE_UNAVAILABLE) setUnavailable(true);
                else if (sent.code === 'kubeconfig_too_large') setNotice(t('kubeconfigTooLarge'));
                else setNotice(t('checkFailed', { reason: sent.error ?? '' }));
                return;
            }
            // The credential now lives server-side only — drop it from the page.
            setKubeconfig('');
            setKubeconfigSent(true);

            for (let attempt = 0; attempt < pollMax; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
                if (!alive.current) return;
                const read = await getAppTargetAction(workId);
                if (!alive.current) return;
                if (
                    read.success &&
                    read.data?.clusterCheckedAt &&
                    read.data.clusterCheckedAt !== previousCheckedAt
                ) {
                    lastCheckedAt.current = read.data.clusterCheckedAt;
                    adoptCheck(read.data);
                    return;
                }
            }
            setNotice(t('checkTimedOut'));
        } finally {
            if (alive.current) setChecking(false);
        }
    };

    const canSave = !unavailable && !saving && !checking && clusterCheckAllowsSave(check);

    const save = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            const result = await saveAppTargetAction(workId, {
                target: 'your-cluster',
                settings: {
                    ...(ingressClass ? { ingressClass } : {}),
                    tls,
                    ...(tls === 'cert-manager' && issuer ? { issuer } : {}),
                    networkIsolation,
                },
            });
            if (!result.success || !result.data) {
                if (result.code === APP_RUNTIME_ROUTE_UNAVAILABLE) setUnavailable(true);
                else setNotice(t('saveFailed', { reason: result.error ?? '' }));
                return;
            }
            toast.success(t('saved'));
            onSaved(result.data);
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const ingressClasses = check?.ingressClasses ?? [];
    const issuers = check?.clusterIssuers ?? [];
    const isolationWarningId = `${ids}-isolation-warning`;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={() => onOpenChange(false)} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                <div className="space-y-4" data-testid="connect-cluster-dialog">
                    {unavailable && (
                        <p
                            className="flex items-start gap-2 rounded-md border border-border dark:border-border-dark p-3 text-sm"
                            role="status"
                            data-testid="connect-cluster-unavailable"
                        >
                            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            {t('unavailable')}
                        </p>
                    )}

                    <Textarea
                        label={t('kubeconfigLabel')}
                        name="kubeconfig"
                        value={kubeconfig}
                        onChange={(event) => setKubeconfig(event.target.value)}
                        placeholder={t('kubeconfigPlaceholder')}
                        helperText={kubeconfigSent ? t('kubeconfigStored') : t('kubeconfigHelp')}
                        rows={6}
                        spellCheck={false}
                        autoComplete="off"
                        disabled={unavailable}
                        variant="form"
                        data-testid="connect-cluster-kubeconfig"
                    />
                    <Input
                        label={t('contextLabel')}
                        name="kubeContext"
                        value={kubeContext}
                        onChange={(event) => setKubeContext(event.target.value)}
                        helperText={t('contextHelp')}
                        autoComplete="off"
                        disabled={unavailable}
                        variant="form"
                    />

                    <div>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={runCheck}
                            disabled={unavailable || checking}
                            loading={checking}
                            data-testid="connect-cluster-check"
                        >
                            {checking
                                ? t('checking')
                                : kubeconfigSent && !kubeconfig.trim()
                                  ? t('checkAgain')
                                  : t('check')}
                        </Button>
                    </div>

                    {notice && (
                        <p
                            className="text-sm text-danger"
                            role="alert"
                            data-testid="connect-cluster-notice"
                        >
                            {notice}
                        </p>
                    )}

                    {check && <ClusterCheckResult check={check} />}

                    {check && check.ok && (
                        <div className="grid gap-4 sm:grid-cols-2">
                            <label className="block text-sm">
                                <span className="mb-1 block font-medium text-text dark:text-text-dark">
                                    {t('ingressClass')}
                                </span>
                                <select
                                    className="h-9 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2"
                                    value={ingressClass}
                                    onChange={(event) => setIngressClass(event.target.value)}
                                >
                                    {ingressClasses.length === 0 && (
                                        <option value="">{t('ingressNone')}</option>
                                    )}
                                    {ingressClasses.map((entry) => (
                                        <option key={entry.name} value={entry.name}>
                                            {entry.isDefault
                                                ? t('ingressDefault', { name: entry.name })
                                                : entry.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="block text-sm">
                                <span className="mb-1 block font-medium text-text dark:text-text-dark">
                                    {t('tls')}
                                </span>
                                <select
                                    className="h-9 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2"
                                    value={tls}
                                    onChange={(event) =>
                                        setTls(event.target.value as AppTargetTlsMode)
                                    }
                                >
                                    {APP_TARGET_TLS_MODES.map((mode) => (
                                        <option key={mode} value={mode}>
                                            {t(`tlsModes.${TLS_LEAF[mode]}`)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {tls === 'cert-manager' && issuers.length > 0 && (
                                <label className="block text-sm">
                                    <span className="mb-1 block font-medium text-text dark:text-text-dark">
                                        {t('issuer')}
                                    </span>
                                    <select
                                        className="h-9 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2"
                                        value={issuer}
                                        onChange={(event) => setIssuer(event.target.value)}
                                    >
                                        {issuers.map((name) => (
                                            <option key={name} value={name}>
                                                {name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <div className="text-sm">
                                <span className="mb-1 block font-medium text-text dark:text-text-dark">
                                    {t('namespace')}
                                </span>
                                <span className="text-text-secondary dark:text-text-secondary-dark">
                                    {namespace ?? t('namespaceAuto')}
                                </span>
                            </div>
                            <fieldset className="text-sm sm:col-span-2">
                                <legend className="mb-1 font-medium text-text dark:text-text-dark">
                                    {t('isolation')}
                                </legend>
                                <div className="flex gap-4">
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name={`${ids}-isolation`}
                                            checked={networkIsolation}
                                            onChange={() => setNetworkIsolation(true)}
                                        />
                                        {t('isolationOn')}
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name={`${ids}-isolation`}
                                            checked={!networkIsolation}
                                            onChange={() => setNetworkIsolation(false)}
                                            aria-describedby={
                                                networkIsolation ? undefined : isolationWarningId
                                            }
                                            data-testid="connect-cluster-isolation-off"
                                        />
                                        {t('isolationOff')}
                                    </label>
                                </div>
                                {!networkIsolation && (
                                    <p
                                        id={isolationWarningId}
                                        className="mt-2 flex items-start gap-2 text-warning"
                                        data-testid="connect-cluster-isolation-warning"
                                    >
                                        <AlertTriangle
                                            className="mt-0.5 h-4 w-4 shrink-0"
                                            aria-hidden="true"
                                        />
                                        {t('isolationOffWarning')}
                                    </p>
                                )}
                            </fieldset>
                        </div>
                    )}

                    {!canSave && !unavailable && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('saveBlocked')}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        onClick={save}
                        disabled={!canSave}
                        loading={saving}
                        data-testid="connect-cluster-save"
                    >
                        {saving ? t('saving') : t('save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
