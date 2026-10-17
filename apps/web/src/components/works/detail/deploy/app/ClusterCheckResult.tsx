'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { AppClusterCheckView } from '@/lib/api/app-runtime.types';

/**
 * APW-06 T37 (spec §6.2, S2) — what one cluster check found: the cluster's
 * version, every missing required permission by name, and the optional ones
 * as warnings. Secret-free by construction — the check carries capability and
 * object names only.
 *
 * States are text plus an icon, never colour alone (spec §6.7 keyboard note).
 */
export function ClusterCheckResult({ check }: { check: AppClusterCheckView }) {
    const t = useTranslations('dashboard.workDetail.appDeploy.check');

    const errorLine = (() => {
        if (!check.error) return null;
        if (check.error.code === 'KUBECONFIG_UNSUPPORTED') {
            return t('kubeconfigRefused', { reason: check.error.message });
        }
        if (check.error.code === 'CLUSTER_ADDRESS_NOT_PUBLIC') return t('notPublic');
        return check.error.message || t('failed');
    })();

    const passed = check.ok && !check.error;

    return (
        <div
            className="space-y-2 rounded-md border border-border dark:border-border-dark p-3 text-sm"
            data-testid="cluster-check-result"
            role="status"
        >
            <p
                className={cn(
                    'flex items-center gap-2 font-medium',
                    passed ? 'text-success' : 'text-danger',
                )}
            >
                {passed ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                    <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                    {passed ? t('ok') : t('failed')}
                    {check.serverVersion
                        ? ` · ${t('version', { version: check.serverVersion })}`
                        : ''}
                </span>
            </p>
            {errorLine && (
                <p className="text-danger" data-testid="cluster-check-error">
                    {errorLine}
                </p>
            )}

            <div>
                <p className="font-medium text-text dark:text-text-dark">{t('permissions')}</p>
                {check.missingPermissions.length === 0 && check.optionalMissing.length === 0 ? (
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {t('allPermissions')}
                    </p>
                ) : (
                    <ul className="mt-1 space-y-1">
                        {check.missingPermissions.map((permission) => (
                            <li
                                key={`missing-${permission.verb}-${permission.resource}`}
                                className="flex items-center gap-2 text-danger"
                                data-testid="cluster-check-missing"
                            >
                                <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {t('missing', {
                                    verb: permission.verb,
                                    resource: permission.resource,
                                })}
                            </li>
                        ))}
                        {check.optionalMissing.map((permission) => (
                            <li
                                key={`optional-${permission.verb}-${permission.resource}`}
                                className="flex items-center gap-2 text-warning"
                            >
                                <AlertTriangle
                                    className="h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                />
                                {t('optionalMissing', {
                                    verb: permission.verb,
                                    resource: permission.resource,
                                })}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
