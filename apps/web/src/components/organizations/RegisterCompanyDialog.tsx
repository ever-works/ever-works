'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { OrganizationResponse } from '@ever-works/contracts/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { UpgradeOrCreateDialog } from './UpgradeOrCreateDialog';

const MAX_NAME_LENGTH = 200;

export interface RegisterCompanyDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * EW-662 (Tenants & Organizations Phase 10) — Register-Company flow
 * ([spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)).
 *
 * Opened from the Company chip on `+ New`. Captures the user-visible
 * Company fields (name + optional countryCode) and submits to
 * `POST /api/organizations/register-company`. The server hard-codes
 * `registrationProvider = 'manual'` + `registrationStatus =
 * 'registered'` for v1 — the Stripe Atlas integration is deferred.
 *
 * Post-submit behavior mirrors the Phase 9 CreateOrganizationModal:
 *  - First Org (`organizations.length === 0` pre-submit) → hands off
 *    to `<UpgradeOrCreateDialog>` so the user can choose Upgrade vs
 *    Empty.
 *  - 2nd+ Org → close + navigate to `/${org.slug}/dashboard`.
 *
 * The full Stripe Atlas form (paperwork inputs, jurisdiction picker,
 * etc.) is intentionally out of scope here — the chip's value in v1
 * is that it gets the user to a registered Org in one form, with the
 * registration metadata preserved so we can re-key into a real
 * provider in a future phase without schema churn.
 */
export function RegisterCompanyDialog({ open, onOpenChange }: RegisterCompanyDialogProps) {
    const t = useTranslations('organizations.registerCompany');
    const router = useRouter();
    const { organizations, mutate } = useOrganizations();

    const [name, setName] = useState('');
    const [countryCode, setCountryCode] = useState('');
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [createdOrg, setCreatedOrg] = useState<OrganizationResponse | null>(null);
    const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
    /**
     * Captures whether THIS submission is the user's first Org. Read
     * once at submit-time so post-mutate `organizations.length` (=1
     * after a successful create) can't flip the branch decision
     * mid-flight.
     */
    const wasFirstOrgRef = useRef(false);

    useEffect(() => {
        if (!open) {
            setName('');
            setCountryCode('');
            setSubmitError(null);
            setCreatedOrg(null);
            setShowUpgradeDialog(false);
        }
    }, [open]);

    const handleSubmit = useCallback(() => {
        const trimmedName = name.trim();
        if (trimmedName.length === 0) {
            setSubmitError(t('errors.nameRequired'));
            return;
        }
        if (trimmedName.length > MAX_NAME_LENGTH) {
            setSubmitError(t('errors.nameTooLong'));
            return;
        }
        const cc = countryCode.trim();
        if (cc.length > 0 && !/^[A-Za-z]{2}$/.test(cc)) {
            setSubmitError(t('errors.countryCodeInvalid'));
            return;
        }
        setSubmitError(null);
        wasFirstOrgRef.current = organizations.length === 0;

        startTransition(() => {
            void (async () => {
                try {
                    const res = await fetch('/api/organizations/register-company', {
                        method: 'POST',
                        credentials: 'include',
                        cache: 'no-store',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: trimmedName,
                            ...(cc.length > 0 ? { countryCode: cc.toUpperCase() } : {}),
                        }),
                    });
                    if (!res.ok) {
                        const body = await res
                            .json()
                            .catch(() => ({ error: 'Failed to register company' }));
                        setSubmitError(
                            (body as { message?: string; error?: string }).message ??
                                (body as { error?: string }).error ??
                                t('errors.generic'),
                        );
                        return;
                    }
                    const org = (await res.json()) as OrganizationResponse;
                    // Refresh the org list (best-effort — the POST already
                    // succeeded; a transient GET failure must not surface
                    // as a register error, otherwise the user retries +
                    // we end up with duplicate Orgs).
                    try {
                        await mutate();
                    } catch {
                        // Swallow.
                    }
                    if (wasFirstOrgRef.current) {
                        setCreatedOrg(org);
                        setShowUpgradeDialog(true);
                    } else {
                        onOpenChange(false);
                        router.push(`/${org.slug}/dashboard`);
                    }
                } catch (err) {
                    setSubmitError(err instanceof Error ? err.message : t('errors.generic'));
                }
            })();
        });
    }, [name, countryCode, organizations.length, mutate, onOpenChange, router, t]);

    const handleUpgradeDialogClose = useCallback(
        (didUpgrade: boolean) => {
            setShowUpgradeDialog(false);
            const target = createdOrg;
            setCreatedOrg(null);
            onOpenChange(false);
            if (target) {
                router.push(`/${target.slug}/dashboard`);
                if (didUpgrade) void mutate();
            }
        },
        [createdOrg, mutate, onOpenChange, router],
    );

    const showCreatePanel = !showUpgradeDialog;

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                {showCreatePanel && (
                    <DialogContent className="max-w-md">
                        <DialogClose onClose={() => onOpenChange(false)} />
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {t('title')}
                            </DialogTitle>
                            <DialogDescription>{t('description')}</DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4">
                            <Input
                                label={t('nameLabel')}
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('namePlaceholder')}
                                maxLength={MAX_NAME_LENGTH}
                                autoFocus
                                disabled={pending}
                                data-testid="register-company-name"
                            />
                            <Input
                                label={t('countryCodeLabel')}
                                type="text"
                                value={countryCode}
                                onChange={(e) => setCountryCode(e.target.value)}
                                placeholder={t('countryCodePlaceholder')}
                                maxLength={2}
                                disabled={pending}
                                data-testid="register-company-country"
                            />
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('helpProviderManual')}
                            </p>
                            {submitError && (
                                <p className="text-sm text-danger" role="alert">
                                    {submitError}
                                </p>
                            )}
                        </div>

                        <DialogFooter>
                            <Button
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                                disabled={pending}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                onClick={handleSubmit}
                                loading={pending}
                                disabled={pending || name.trim().length === 0}
                                data-testid="register-company-submit"
                            >
                                {t('submit')}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                )}
            </Dialog>

            {createdOrg && (
                <UpgradeOrCreateDialog
                    open={showUpgradeDialog}
                    organization={createdOrg}
                    onClose={handleUpgradeDialogClose}
                />
            )}
        </>
    );
}
