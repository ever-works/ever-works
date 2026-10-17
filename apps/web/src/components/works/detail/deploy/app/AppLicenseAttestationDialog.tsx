'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { attestAppLicenseAction } from '@/app/actions/dashboard/app-license';
import {
    attestRefusalOf,
    type AppLicenseAttestRefusal,
    type WorkAppLicenseView,
} from '@/lib/api/app-license.types';

export interface AppLicenseAttestationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workId: string;
    license: WorkAppLicenseView;
    /** Called after a recorded attestation, or when the API says none is needed any more. */
    onAttested: () => void;
    /** Called on `409 licenseChanged`, so the card re-reads the classification. */
    onLicenseChanged: () => void;
}

/**
 * APW-03 spec §6.3 — "Confirm the license terms" (R-3, APW-06 T37, ACC-06-39).
 *
 * Shows the registry's attestation text for the CURRENT classification as a
 * quotation; **Confirm** stays disabled until the box is ticked. It sends the
 * classification the owner reviewed (`{ spdx, class }`) so the API refuses
 * `409 licenseChanged` if it moved underneath them; the API records `textId`,
 * `textSha256` and the licence commit itself. A non-owner never gets the button
 * — the card shows the owner-only line instead — and a `403` from the API shows
 * the same line here.
 */
export function AppLicenseAttestationDialog({
    open,
    onOpenChange,
    workId,
    license,
    onAttested,
    onLicenseChanged,
}: AppLicenseAttestationDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.license');
    const checkboxId = useId();
    const [confirmed, setConfirmed] = useState(false);
    const [pending, setPending] = useState(false);
    const [refusal, setRefusal] = useState<AppLicenseAttestRefusal | 'failed' | null>(null);

    const spdx = license.spdx ?? t('unknownSpdx');

    const submit = async () => {
        if (!confirmed || pending) return;
        setPending(true);
        setRefusal(null);
        try {
            const result = await attestAppLicenseAction(workId, {
                spdx: license.spdx,
                class: license.class,
            });
            if (result.success) {
                onAttested();
                onOpenChange(false);
                return;
            }
            const code = attestRefusalOf(result);
            if (code === 'attestationNotRequired') {
                // Nothing left to confirm: someone (or a re-classification) settled it.
                onAttested();
                onOpenChange(false);
                return;
            }
            if (code === 'licenseChanged') onLicenseChanged();
            setRefusal(code ?? 'failed');
        } catch {
            setRefusal('failed');
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-license-attest-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('dialogTitle')}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('dialogBody', { spdx })}
                        </DialogDescription>
                    </DialogHeader>

                    {license.attestationText ? (
                        <blockquote
                            className="border-l-4 border-amber-400 pl-3 text-sm italic text-text dark:text-text-dark"
                            data-testid="app-license-attest-text"
                            data-text-id={license.attestationText.textId}
                        >
                            {license.attestationText.text}
                        </blockquote>
                    ) : (
                        <p className="text-sm text-text-secondary">{t('noText')}</p>
                    )}

                    <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
                        <input
                            id={checkboxId}
                            type="checkbox"
                            checked={confirmed}
                            onChange={(event) => setConfirmed(event.target.checked)}
                            disabled={pending}
                            data-testid="app-license-attest-checkbox"
                            className="mt-1"
                        />
                        <span>{t('checkbox')}</span>
                    </label>

                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('footer')}
                    </p>

                    {refusal && (
                        <p
                            role="alert"
                            className="text-sm text-red-600 dark:text-red-400"
                            data-testid="app-license-attest-error"
                        >
                            {t(`refusals.${refusal}`)}
                        </p>
                    )}

                    <DialogFooter className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            onClick={submit}
                            disabled={!confirmed || pending || !license.attestationText}
                            loading={pending}
                            data-testid="app-license-attest-confirm"
                        >
                            {t('confirm')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
