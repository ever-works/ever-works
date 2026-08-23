'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { OrganizationResponse } from '@ever-works/contracts/api';
import { UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS } from '@ever-works/contracts/api';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { browserApiFetch } from '@/lib/api/browser-api';

type UpgradeChoice = 'upgrade' | 'empty';

export interface UpgradeOrCreateDialogProps {
    open: boolean;
    organization: OrganizationResponse;
    /**
     * Fired when the dialog finishes (either branch completes, or the
     * user cancels). `didUpgrade=true` means the upgrade API call ran
     * and succeeded — the caller may want to refresh data tied to the
     * promoted Tenant. Async callers are awaited; rejection leaves this
     * dialog open and surfaces the error so completion can be retried.
     */
    onClose: (didUpgrade: boolean) => void | Promise<void>;
}

/**
 * EW-661 (Tenants & Organizations Phase 9) — second half of the
 * create-Org flow from spec §5.2 step 2. Only renders for the user's
 * FIRST Organization.
 *
 * Two radio choices:
 *
 *  - **Upgrade** (default, focused) → calls
 *    `POST /api/organizations/:id/upgrade-from-account`, which sets
 *    `organizationId = newOrg.id` on the user's existing Tier A + Tier
 *    C rows. After it resolves we navigate the parent (via `onClose`)
 *    to the new Org's dashboard.
 *  - **Empty** → no API call. The new Org is already empty; the user's
 *    existing rows stay in the bare-Tenant scope. We just close + let
 *    the parent navigate.
 *
 * Handles 409 `UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS` gracefully —
 * shouldn't happen here (this is first-Org only) but if a race lets it
 * through we surface a generic "not available" message rather than
 * silently failing.
 */
export function UpgradeOrCreateDialog({ open, organization, onClose }: UpgradeOrCreateDialogProps) {
    const t = useTranslations('organizations.upgrade');
    const [choice, setChoice] = useState<UpgradeChoice>('upgrade');
    const [error, setError] = useState<string | null>(null);
    const [upgradeCompleted, setUpgradeCompleted] = useState(false);
    const [pending, startTransition] = useTransition();
    const upgradeRadioRef = useRef<HTMLInputElement>(null);

    // Focus the default (Upgrade) radio on open. Use a microtask so the
    // ref is populated after the dialog mounts. Reset on close so a
    // re-open is clean.
    useEffect(() => {
        if (open) {
            setChoice('upgrade');
            setError(null);
            setUpgradeCompleted(false);
            const id = window.setTimeout(() => {
                upgradeRadioRef.current?.focus();
            }, 0);
            return () => window.clearTimeout(id);
        }
    }, [open]);

    const handleConfirm = () => {
        setError(null);
        if (choice === 'empty' && !upgradeCompleted) {
            // No upgrade API call — the parent still persists active scope
            // before it closes and navigates.
            startTransition(async () => {
                try {
                    await onClose(false);
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('errors.generic'));
                }
            });
            return;
        }

        startTransition(async () => {
            try {
                if (!upgradeCompleted) {
                    const res = await browserApiFetch(
                        `/api/organizations/${encodeURIComponent(organization.id)}/upgrade-from-account`,
                        {
                            method: 'POST',
                            credentials: 'include',
                            cache: 'no-store',
                            headers: { 'Content-Type': 'application/json' },
                        },
                    );
                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}));
                        const code = (body as { code?: string; message?: string }).code;
                        if (
                            res.status === 409 ||
                            code === UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS
                        ) {
                            setError(t('errors.notAvailable'));
                        } else {
                            setError(
                                (body as { message?: string; error?: string }).message ??
                                    (body as { error?: string }).error ??
                                    t('errors.generic'),
                            );
                        }
                        return;
                    }
                    setUpgradeCompleted(true);
                }
                await onClose(true);
            } catch (err) {
                setError(err instanceof Error ? err.message : t('errors.generic'));
            }
        });
    };

    const handleCancel = () => {
        if (pending) return;
        setError(null);
        startTransition(async () => {
            try {
                await onClose(upgradeCompleted);
            } catch (err) {
                setError(err instanceof Error ? err.message : t('errors.generic'));
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && handleCancel()}>
            <DialogContent className="max-w-md">
                <DialogClose onClose={handleCancel} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <ChoiceRow
                        id="upgrade-or-create-upgrade"
                        radioRef={upgradeRadioRef}
                        checked={choice === 'upgrade'}
                        onChange={() => setChoice('upgrade')}
                        label={t('upgradeOption')}
                        help={t('upgradeHelp')}
                        disabled={pending || upgradeCompleted}
                    />
                    <ChoiceRow
                        id="upgrade-or-create-empty"
                        checked={choice === 'empty'}
                        onChange={() => setChoice('empty')}
                        label={t('emptyOption')}
                        help={t('emptyHelp')}
                        disabled={pending || upgradeCompleted}
                    />
                </div>

                {error && (
                    <p className="mt-3 text-sm text-danger" role="alert">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={handleCancel} disabled={pending}>
                        {t('cancel')}
                    </Button>
                    <Button onClick={handleConfirm} loading={pending} disabled={pending}>
                        {t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ChoiceRow({
    id,
    radioRef,
    checked,
    onChange,
    label,
    help,
    disabled,
}: {
    id: string;
    radioRef?: React.RefObject<HTMLInputElement | null>;
    checked: boolean;
    onChange: () => void;
    label: string;
    help: string;
    disabled?: boolean;
}) {
    return (
        <label
            htmlFor={id}
            className={`block rounded-lg border p-3 transition-colors cursor-pointer ${
                checked
                    ? 'border-primary bg-primary/5'
                    : 'border-border/60 dark:border-border-dark/60 hover:border-border dark:hover:border-border-dark'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
            <div className="flex items-start gap-3">
                <input
                    ref={radioRef}
                    id={id}
                    type="radio"
                    name="upgrade-or-create-choice"
                    checked={checked}
                    onChange={onChange}
                    disabled={disabled}
                    className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text dark:text-text-dark">{label}</div>
                    <div className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {help}
                    </div>
                </div>
            </div>
        </label>
    );
}
