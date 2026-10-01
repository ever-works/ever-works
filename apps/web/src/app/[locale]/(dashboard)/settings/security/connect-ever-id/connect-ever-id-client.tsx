'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Diamond } from 'lucide-react';
import { cancelEverIdConnect, confirmEverIdConnect } from '@/app/actions/ever-id';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';

interface ConnectEverIdClientProps {
    /** The Ever ID address, from the pending cookie; `null` when it expired. */
    everIdEmail: string | null;
    /** The signed-in account's address, from the same pending value. */
    accountEmail: string | null;
}

/** E-mail addresses compare case-insensitively (the local part rarely matters here). */
function sameAddress(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The connect confirmation (spec §6.4): both addresses, the "different
 * addresses" warning when they differ (FR-25), and Cancel / Connect. `Enter`
 * connects; the warning and every error are announced (FR-52). A conflict is
 * described without ever naming the other account (S12).
 */
export function ConnectEverIdClient({ everIdEmail, accountEmail }: ConnectEverIdClientProps) {
    const t = useTranslations('dashboard.settings.security.connectedIdentities');
    const tEverId = useTranslations('auth.everId');
    const headingId = useId();
    const [error, setError] = useState<string | null>(null);
    const [expired, setExpired] = useState(!everIdEmail || !accountEmail);
    const [isConfirming, startConfirm] = useTransition();
    const [isCancelling, startCancel] = useTransition();
    const busy = isConfirming || isCancelling;

    if (expired || !everIdEmail || !accountEmail) {
        return (
            <section aria-labelledby={headingId} className="max-w-xl space-y-4">
                <h2 id={headingId} className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('confirmTitle')}
                </h2>
                <p
                    role="alert"
                    data-testid="ever-id-connect-expired"
                    className="rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-text dark:text-text-dark"
                >
                    {tEverId('pendingExpired')}
                </p>
                <Button href={ROUTES.DASHBOARD_SETTINGS_SECURITY} variant="secondary" size="sm">
                    {t('backToSecurity')}
                </Button>
            </section>
        );
    }

    const emailsDiffer = !sameAddress(everIdEmail, accountEmail);

    const confirm = () => {
        if (busy) return;
        setError(null);
        startConfirm(async () => {
            // Success redirects back to Settings with the "connected" toast.
            const result = await confirmEverIdConnect();
            if (result && !result.success) {
                if (result.code === 'pending_expired') {
                    setExpired(true);
                    return;
                }
                setError(result.error);
            }
        });
    };

    const cancel = () => {
        if (busy) return;
        startCancel(async () => {
            await cancelEverIdConnect();
        });
    };

    return (
        <section aria-labelledby={headingId} className="max-w-xl">
            <form
                data-testid="ever-id-connect-confirm-form"
                className="space-y-5"
                onSubmit={(event) => {
                    event.preventDefault();
                    confirm();
                }}
            >
                <h2 id={headingId} className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('confirmTitle')}
                </h2>

                <dl className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                        <dt className="flex items-center gap-2 font-medium text-text dark:text-text-dark">
                            <Diamond className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {t('everIdLabel')}
                        </dt>
                        <dd
                            data-testid="ever-id-connect-ever-id-email"
                            className="break-all text-text dark:text-text-dark"
                        >
                            {everIdEmail}
                        </dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                        <dt className="font-medium text-text dark:text-text-dark">
                            {t('everWorksLabel')}
                        </dt>
                        <dd
                            data-testid="ever-id-connect-account-email"
                            className="break-all text-text dark:text-text-dark"
                        >
                            {accountEmail}
                        </dd>
                    </div>
                </dl>

                {emailsDiffer ? (
                    <div
                        role="alert"
                        data-testid="ever-id-emails-differ"
                        className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-text dark:text-text-dark"
                    >
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                        <p>{t('emailsDiffer')}</p>
                    </div>
                ) : null}

                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('confirmBody')}
                </p>

                {error ? (
                    <p
                        role="alert"
                        data-testid="ever-id-connect-confirm-error"
                        className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                    >
                        {error}
                    </p>
                ) : null}

                <div className="flex justify-end gap-3">
                    <Button
                        type="button"
                        variant="ghost"
                        data-testid="ever-id-connect-cancel"
                        onClick={cancel}
                        disabled={busy}
                        loading={isCancelling}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        data-testid="ever-id-connect-submit"
                        disabled={busy}
                        loading={isConfirming}
                    >
                        {t('confirm')}
                    </Button>
                </div>
            </form>
        </section>
    );
}
