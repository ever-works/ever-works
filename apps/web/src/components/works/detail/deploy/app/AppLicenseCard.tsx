'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAppLicenseAction } from '@/app/actions/dashboard/app-license';
import {
    APP_LICENSE_ROUTE_UNAVAILABLE,
    type WorkAppLicenseView,
} from '@/lib/api/app-license.types';
import { cn } from '@/lib/utils/cn';
import { AppLicenseAttestationDialog } from './AppLicenseAttestationDialog';

type CardState =
    | { kind: 'loading' }
    | { kind: 'ready'; license: WorkAppLicenseView }
    | { kind: 'unavailable' }
    | { kind: 'error' };

export interface AppLicenseCardProps {
    workId: string;
    /** First paint from the server, or `null` when it could not be read there. */
    initialLicense?: WorkAppLicenseView | null;
}

/**
 * The licence card on an App Work's Deploy tab (APW-03 spec §6.3, APW-06 T37):
 * the classification, whether the owner still has to confirm the terms, and the
 * way to do it. Your-cluster deploys of an amber / red / unknown licence are
 * refused `license_attestation_missing` until the owner confirms (ACC-06-39).
 */
export function AppLicenseCard({ workId, initialLicense = null }: AppLicenseCardProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.license');
    const [state, setState] = useState<CardState>(
        initialLicense ? { kind: 'ready', license: initialLicense } : { kind: 'loading' },
    );
    const [dialogOpen, setDialogOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const result = await getAppLicenseAction(workId);
            if (result.success && result.data) setState({ kind: 'ready', license: result.data });
            else if (result.code === APP_LICENSE_ROUTE_UNAVAILABLE)
                setState({ kind: 'unavailable' });
            else setState({ kind: 'error' });
        } catch {
            setState({ kind: 'error' });
        }
    }, [workId]);

    useEffect(() => {
        if (!initialLicense) void load();
    }, [initialLicense, load]);

    if (state.kind === 'loading') {
        return (
            <section
                className="rounded-lg border border-card-border p-4 text-sm text-text-secondary"
                data-testid="app-license-card"
            >
                {t('loading')}
            </section>
        );
    }
    if (state.kind !== 'ready') {
        return (
            <section
                className="rounded-lg border border-card-border p-4 text-sm text-text-secondary"
                data-testid="app-license-card"
            >
                {state.kind === 'unavailable' ? t('unavailable') : t('error')}
            </section>
        );
    }

    const license = state.license;
    const classLeaf = license.class ?? 'unclassified';
    const attestation = license.attestation;

    return (
        <section
            data-testid="app-license-card"
            data-required={license.attestationRequired ? 'true' : 'false'}
            className={cn(
                'rounded-lg border p-4 space-y-2',
                license.attestationRequired
                    ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/10'
                    : 'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="flex items-start gap-2">
                {license.attestationRequired ? (
                    <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-600" aria-hidden="true" />
                ) : (
                    <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-600" aria-hidden="true" />
                )}
                <div className="space-y-1">
                    <h3
                        className="text-sm font-semibold text-text dark:text-text-dark"
                        data-testid="app-license-headline"
                    >
                        {license.spdx
                            ? t('headline', {
                                  spdx: license.spdx,
                                  classLabel: t(`classes.${classLeaf}`),
                              })
                            : t('headlineUnknown')}
                    </h3>
                    {license.mixed && <p className="text-xs text-text-secondary">{t('mixed')}</p>}
                    {license.scanIncomplete && (
                        <p className="text-xs text-text-secondary">{t('incomplete')}</p>
                    )}
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {license.attestationRequired
                            ? t('yourClusterAfterConfirm')
                            : t('yourClusterAllowed')}
                    </p>
                    {attestation && !license.attestationRequired && (
                        <p
                            className="text-xs text-text-secondary"
                            data-testid="app-license-confirmed"
                        >
                            {t('confirmed', {
                                date: new Date(attestation.attestedAt).toLocaleDateString(),
                            })}
                        </p>
                    )}
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('disclaimer')}
                    </p>
                </div>
            </div>

            {license.attestationRequired &&
                (license.isOwner ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => setDialogOpen(true)}
                        data-testid="app-license-review"
                    >
                        {t('review')}
                    </Button>
                ) : (
                    <p className="text-sm text-text-secondary" data-testid="app-license-owner-only">
                        {t('refusals.ownerOnly')}
                    </p>
                ))}

            {dialogOpen && (
                <AppLicenseAttestationDialog
                    open={dialogOpen}
                    onOpenChange={setDialogOpen}
                    workId={workId}
                    license={license}
                    onAttested={() => void load()}
                    onLicenseChanged={() => void load()}
                />
            )}
        </section>
    );
}
