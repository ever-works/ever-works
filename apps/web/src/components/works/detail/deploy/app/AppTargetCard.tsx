'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Info, PlugZap, XCircle } from 'lucide-react';
import { APP_DEPLOY_TARGET_CHOICES, type AppDeployTargetChoice } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { saveAppTargetAction } from '@/app/actions/dashboard/app-runtime';
import { APP_RUNTIME_ROUTE_UNAVAILABLE, type AppTargetView } from '@/lib/api/app-runtime.types';

/** i18n leaf per target (`dashboard.workDetail.appDeploy.target.<leaf>`). */
export const APP_TARGET_LEAF: Record<
    AppDeployTargetChoice,
    'none' | 'yourCluster' | 'everWorksApps'
> = {
    none: 'none',
    'your-cluster': 'yourCluster',
    'ever-works-apps': 'everWorksApps',
};

export interface AppTargetCardProps {
    workId: string;
    target: AppTargetView;
    /** Whether the member may change anything (edit access). */
    canEdit: boolean;
    /**
     * Whether Ever Works Apps can be picked for this App Work. It is closed
     * today (APW-10 `AppsTierPolicy` unwritten), so the default is `false` and
     * the option renders disabled with its reason (ACC-06-38).
     */
    managedAvailable?: boolean;
    onConnectCluster: () => void;
    onSaved: (target: AppTargetView) => void;
}

/**
 * APW-06 T37 (spec §6.1, S1; Resolution R-12) — where the app runs.
 *
 * Three targets, one line each: **None — don't deploy yet** (the default —
 * Builds still run), **Your cluster** with **Connect your cluster** as the
 * primary action, and **Ever Works Apps**, which is offered only when it is
 * open for this App Work and otherwise disabled with a one-line reason. A
 * radio group, so `↑`/`↓` move between the targets and a disabled one is
 * skipped but still announced with its reason.
 */
export function AppTargetCard({
    workId,
    target,
    canEdit,
    managedAvailable = false,
    onConnectCluster,
    onSaved,
}: AppTargetCardProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.target');
    const groupName = useId();
    const [selected, setSelected] = useState<AppDeployTargetChoice>(target.target);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const managedReason =
        target.eligibility?.managed && target.eligibility.managed.eligible === false
            ? t('everWorksApps.ineligible')
            : t('everWorksApps.unavailable');

    const isDisabled = (choice: AppDeployTargetChoice) =>
        !canEdit || (choice === 'ever-works-apps' && !managedAvailable);

    const save = async () => {
        if (saving || selected === target.target) return;
        setSaving(true);
        setError(null);
        try {
            const result = await saveAppTargetAction(workId, { target: selected });
            if (!result.success || !result.data) {
                setError(
                    result.code === APP_RUNTIME_ROUTE_UNAVAILABLE
                        ? t('routeUnavailable')
                        : t('saveFailed', { reason: result.error ?? '' }),
                );
                return;
            }
            toast.success(t('saved'));
            onSaved(result.data);
        } finally {
            setSaving(false);
        }
    };

    const clusterLine = (() => {
        const check = target.clusterCheck;
        if (!check) return { ok: null, text: t('notChecked') };
        if (!check.ok || check.error) return { ok: false, text: t('checkFailed') };
        return {
            ok: true,
            text: check.serverVersion
                ? t('connected', { version: check.serverVersion })
                : t('connectedNoVersion'),
        };
    })();

    return (
        <section
            className="rounded-lg border border-card-border dark:border-border-secondary-dark bg-card dark:bg-transparent p-4 space-y-4"
            data-testid="app-target-card"
        >
            <fieldset>
                <legend className="mb-3 text-sm font-semibold text-text dark:text-text-dark">
                    {t('heading')}
                </legend>
                <div className="space-y-2">
                    {APP_DEPLOY_TARGET_CHOICES.map((choice) => {
                        const leaf = APP_TARGET_LEAF[choice];
                        const disabled = isDisabled(choice);
                        const inputId = `${groupName}-${choice}`;
                        const reasonId = `${inputId}-reason`;
                        const showReason = choice === 'ever-works-apps' && !managedAvailable;
                        return (
                            <div
                                key={choice}
                                className={cn(
                                    'flex flex-wrap items-start gap-3 rounded-md border p-3',
                                    selected === choice
                                        ? 'border-primary dark:border-gray-300'
                                        : 'border-border dark:border-border-dark',
                                    disabled && 'opacity-70',
                                )}
                                data-testid={`app-target-option-${choice}`}
                            >
                                <input
                                    id={inputId}
                                    type="radio"
                                    name={groupName}
                                    value={choice}
                                    checked={selected === choice}
                                    disabled={disabled}
                                    onChange={() => setSelected(choice)}
                                    aria-describedby={showReason ? reasonId : undefined}
                                    className="mt-1"
                                    data-testid={`app-target-${choice}`}
                                />
                                <label htmlFor={inputId} className="flex-1 min-w-48 text-sm">
                                    <span className="font-medium text-text dark:text-text-dark">
                                        {t(`${leaf}.label`)}
                                    </span>
                                    {target.target === choice && (
                                        <span className="ml-2 text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('current')}
                                        </span>
                                    )}
                                    <span className="block text-text-secondary dark:text-text-secondary-dark">
                                        {t(`${leaf}.description`)}
                                    </span>
                                    {showReason && (
                                        <span
                                            id={reasonId}
                                            className="block text-xs text-text-muted dark:text-text-muted-dark"
                                            data-testid="app-target-managed-reason"
                                        >
                                            {managedReason}
                                        </span>
                                    )}
                                </label>
                                {choice === 'your-cluster' && (
                                    <div className="flex flex-col items-end gap-1">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant={target.clusterCheck ? 'secondary' : 'primary'}
                                            onClick={onConnectCluster}
                                            disabled={!canEdit}
                                            className="gap-1.5"
                                            data-testid="app-target-connect"
                                        >
                                            <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
                                            {target.clusterCheck ? t('reconnect') : t('connect')}
                                        </Button>
                                        <span
                                            className="flex items-center gap-1 text-xs text-text-secondary dark:text-text-secondary-dark"
                                            data-testid="app-target-cluster-line"
                                        >
                                            {clusterLine.ok === true && (
                                                <CheckCircle2
                                                    className="h-3.5 w-3.5 text-success"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            {clusterLine.ok === false && (
                                                <XCircle
                                                    className="h-3.5 w-3.5 text-danger"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            {clusterLine.text}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </fieldset>

            {!target.routeAvailable && (
                <p
                    className="flex items-start gap-2 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="app-target-route-unavailable"
                >
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t('routeUnavailable')}
                </p>
            )}

            {selected !== target.target && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('changeNote')}
                    </p>
                    <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={save}
                        loading={saving}
                        disabled={saving || !canEdit || !target.routeAvailable}
                        data-testid="app-target-save"
                    >
                        {saving ? t('saving') : t('save')}
                    </Button>
                </div>
            )}

            {error && (
                <p className="text-sm text-danger" role="alert" data-testid="app-target-error">
                    {error}
                </p>
            )}
        </section>
    );
}
