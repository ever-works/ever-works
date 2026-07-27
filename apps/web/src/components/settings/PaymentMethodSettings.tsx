'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Check, CreditCard, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    removePaymentMethodAction,
    setDefaultPaymentMethodAction,
    startPaymentMethodSetupAction,
} from '@/app/actions/dashboard/billing';
import {
    canManagePaymentMethods,
    canRemovePaymentMethod,
    formatCardExpiry,
    formatPaymentMethod,
    type PaymentMethodListPage,
    type PaymentMethodRow,
} from '@/lib/api/billing.shared';

interface PaymentMethodSettingsProps {
    paymentsEnabled: boolean;
    /** Null ⇒ the list call failed; render the error state. */
    initialMethods: PaymentMethodListPage | null;
    /** Drives the "cannot remove your last card" affordance. */
    onPaidPlan: boolean;
}

/**
 * Manage stored payment methods (billing PRD §3.3, audit B10 + B25).
 *
 * ## There is no card form here — on purpose
 *
 * "Add a payment method" is a BUTTON THAT NAVIGATES, not a form. It asks
 * our API for a provider-hosted setup session and sends the browser to
 * the payment provider's own page, where the card is entered and
 * tokenized. This component never renders an input for a card number,
 * expiry or CVC, and no action it calls accepts one. What comes back is
 * brand / last four / expiry plus an opaque handle.
 *
 * ## Removing the last card
 *
 * On a paid plan the last remaining card cannot be removed — the button
 * is disabled with an explanation rather than clicked into a 409. The
 * API enforces the same rule regardless of what this component renders.
 */
export function PaymentMethodSettings({
    paymentsEnabled,
    initialMethods,
    onPaidPlan,
}: PaymentMethodSettingsProps) {
    const t = useTranslations('dashboard.settings.billing.paymentMethod');
    const router = useRouter();

    const methods = initialMethods?.methods ?? [];
    const manageEnabled = canManagePaymentMethods(initialMethods, paymentsEnabled);
    const removable = canRemovePaymentMethod(methods, onPaidPlan);

    const [pendingId, setPendingId] = useState<string | null>(null);
    const [addPending, setAddPending] = useState(false);

    const handleAdd = useCallback(async () => {
        setAddPending(true);
        try {
            // The URL points at the PROVIDER'S hosted card element.
            const result = await startPaymentMethodSetupAction();
            if (result.success && result.url) {
                window.location.assign(result.url);
                return;
            }
            toast.error(result.error ?? t('addError'));
        } finally {
            setAddPending(false);
        }
    }, [t]);

    const handleSetDefault = useCallback(
        async (method: PaymentMethodRow) => {
            setPendingId(method.id);
            try {
                const result = await setDefaultPaymentMethodAction(method.id);
                if (result.success) {
                    toast.success(t('defaultUpdated'));
                    router.refresh();
                } else {
                    toast.error(result.error ?? t('defaultError'));
                }
            } finally {
                setPendingId(null);
            }
        },
        [router, t],
    );

    const handleRemove = useCallback(
        async (method: PaymentMethodRow) => {
            setPendingId(method.id);
            try {
                const result = await removePaymentMethodAction(method.id);
                if (result.success) {
                    toast.success(t('removed'));
                    router.refresh();
                } else {
                    toast.error(result.error ?? t('removeError'));
                }
            } finally {
                setPendingId(null);
            }
        },
        [router, t],
    );

    return (
        <div className="space-y-6" data-testid="payment-method-settings">
            <div>
                <Link
                    href={ROUTES.DASHBOARD_SETTINGS_BILLING}
                    data-testid="payment-method-back"
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    {t('backToBilling')}
                </Link>
                <h2 className="mt-2 text-xl font-semibold text-text dark:text-text-dark">
                    {t('manageTitle')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    {t('manageSubtitle')}
                </p>
            </div>

            {!initialMethods ? (
                <div
                    data-testid="payment-method-load-error"
                    className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                    {t('loadError')}
                </div>
            ) : null}

            {!manageEnabled ? (
                <div
                    data-testid="payment-method-coming-soon"
                    className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4"
                >
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('comingSoon')}
                    </p>
                </div>
            ) : (
                <>
                    <div className="rounded-lg border border-border dark:border-border-dark p-5 space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <div className="rounded-md w-8 h-8 flex items-center justify-center bg-surface dark:bg-white/6">
                                    <CreditCard className="w-4.5 h-4.5" strokeWidth={1.3} />
                                </div>
                                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                                    {t('storedTitle')}
                                </h3>
                            </div>
                            {/* Not a form: this NAVIGATES to the provider. */}
                            <Button
                                className="text-xs"
                                data-testid="payment-method-add"
                                disabled={addPending}
                                onClick={() => void handleAdd()}
                            >
                                <Plus className="w-3.5 h-3.5" />
                                {addPending ? t('redirecting') : t('add')}
                            </Button>
                        </div>

                        {methods.length === 0 ? (
                            <p
                                data-testid="payment-method-empty"
                                className="text-sm text-text-muted dark:text-text-muted-dark"
                            >
                                {t('empty')}
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {methods.map((method) => {
                                    const expiry = formatCardExpiry(method);
                                    const busy = pendingId === method.id;
                                    const mayRemove = removable && !busy;
                                    return (
                                        <li
                                            key={method.id}
                                            data-testid="payment-method-row"
                                            className={cn(
                                                'flex flex-wrap items-center justify-between gap-3 rounded-md border p-3',
                                                method.isDefault
                                                    ? 'border-primary/60 bg-primary/5'
                                                    : 'border-border dark:border-border-dark',
                                            )}
                                        >
                                            <div>
                                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                                    {formatPaymentMethod(method) ?? t('card')}
                                                </p>
                                                {expiry ? (
                                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('expires', { expiry })}
                                                    </p>
                                                ) : null}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {method.isDefault ? (
                                                    <span
                                                        data-testid="payment-method-default-badge"
                                                        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                                                    >
                                                        <Check className="w-3 h-3" />
                                                        {t('default')}
                                                    </span>
                                                ) : (
                                                    <Button
                                                        variant="secondary"
                                                        className="text-xs"
                                                        data-testid="payment-method-set-default"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void handleSetDefault(method)
                                                        }
                                                    >
                                                        {t('makeDefault')}
                                                    </Button>
                                                )}
                                                <Button
                                                    variant="secondary"
                                                    className="text-xs"
                                                    data-testid="payment-method-remove"
                                                    disabled={!mayRemove}
                                                    title={
                                                        removable ? undefined : t('lastOnPaidPlan')
                                                    }
                                                    onClick={() => void handleRemove(method)}
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                    {t('remove')}
                                                </Button>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {!removable && methods.length > 0 ? (
                            <p
                                data-testid="payment-method-last-notice"
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                            >
                                {t('lastOnPaidPlan')}
                            </p>
                        ) : null}
                    </div>

                    <div className="flex items-start gap-2 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4">
                        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-text-muted dark:text-text-muted-dark" />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('hostedNotice')}
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}
