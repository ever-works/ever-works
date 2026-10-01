'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cancelEverIdSignUp, confirmEverIdSignUp } from '@/app/actions/ever-id';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';
import { COMPANY_OWNER_WEBSITE, ROUTES } from '@/lib/constants';

interface EverIdCreateAccountClientProps {
    /** The Ever ID identity from the pending cookie; `null` when it expired or is missing. */
    identity: { name: string | null; email: string } | null;
    /**
     * The documents a new account must accept, resolved on the server from the
     * published corpus. Empty means they could not be loaded, and creating is
     * blocked — the same rule as the register page.
     */
    termsDocuments: TermsAcceptanceDocument[];
}

/**
 * The create-account screen (S2, spec §6.2): the identity from Ever ID read-only,
 * the consent checkbox over the published terms, and Cancel / Create account.
 * Cancel creates nothing. An expired or used pending value — on arrival or on
 * submit — becomes "That took too long. Start again." with a way back to sign-in.
 */
export function EverIdCreateAccountClient({
    identity,
    termsDocuments,
}: EverIdCreateAccountClientProps) {
    const t = useTranslations('auth.everId');
    const router = useRouter();
    const checkboxId = useId();
    const [accepted, setAccepted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expired, setExpired] = useState(identity === null);
    const [isCreating, startCreate] = useTransition();
    const [isCancelling, startCancel] = useTransition();
    const [isRetrying, startRetry] = useTransition();

    const termsUnavailable = termsDocuments.length === 0;
    const busy = isCreating || isCancelling;

    if (expired || !identity) {
        return (
            <AuthLayout title={t('createAccount.title')} subtitle="">
                <ThemeToggle variant="fixed" />
                <div className="space-y-4">
                    <p
                        role="alert"
                        data-testid="ever-id-create-account-expired"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
                    >
                        {t('pendingExpired')}
                    </p>
                    <Button href={ROUTES.AUTH_LOGIN} fullWidth>
                        {t('accountExists.goToSignIn')}
                    </Button>
                </div>
            </AuthLayout>
        );
    }

    /**
     * Where to READ what is being accepted — resolved from the very documents
     * whose acceptance is recorded, exactly as the register page does.
     */
    const legalHref = (kind: 'tos' | 'privacy') => {
        const doc = termsDocuments.find((d) => d.documentId.startsWith(`${kind}:`));
        return new URL(doc?.url || `/${kind}`, COMPANY_OWNER_WEBSITE).toString();
    };

    const create = () => {
        if (busy) return;
        setError(null);

        if (!accepted || termsUnavailable) {
            setError(t('consentRequired'));
            return;
        }

        startCreate(async () => {
            // Success signs the new account in and navigates away.
            const result = await confirmEverIdSignUp(
                termsDocuments.map(({ documentId, version, sha256, locale }) => ({
                    documentId,
                    version,
                    sha256,
                    locale,
                })),
            );
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
            await cancelEverIdSignUp();
        });
    };

    const signedInAs = identity.name
        ? t('createAccount.signedInAs', { name: identity.name, email: identity.email })
        : t('createAccount.signedInAsEmail', { email: identity.email });

    return (
        <AuthLayout title={t('createAccount.title')} subtitle={signedInAs}>
            <ThemeToggle variant="fixed" />
            <form
                data-testid="ever-id-create-account-form"
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    create();
                }}
            >
                {error ? (
                    <div
                        role="alert"
                        data-testid="ever-id-create-account-error"
                        className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm"
                    >
                        {error}
                    </div>
                ) : null}

                {termsUnavailable ? (
                    <div
                        role="alert"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm space-y-3"
                    >
                        <div>
                            <p className="font-medium text-text dark:text-text-dark">
                                {t('termsUnavailable.title')}
                            </p>
                            <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                                {t('termsUnavailable.message')}
                            </p>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => startRetry(() => router.refresh())}
                            loading={isRetrying}
                            disabled={isRetrying}
                        >
                            {t('termsUnavailable.retry')}
                        </Button>
                    </div>
                ) : null}

                <div className="flex items-center">
                    <input
                        id={checkboxId}
                        type="checkbox"
                        data-testid="ever-id-create-account-terms"
                        checked={accepted}
                        onChange={(event) => {
                            setAccepted(event.target.checked);
                            setError(null);
                        }}
                        onKeyDown={(event) => {
                            // Enter on the checkbox must not submit (spec §6.7).
                            if (event.key === 'Enter') event.preventDefault();
                        }}
                        disabled={busy || termsUnavailable}
                        className="w-4 h-4 mt-0.5 bg-surface-secondary dark:bg-surface-secondary-dark border-border dark:border-border-dark rounded text-primary focus:ring-primary"
                    />
                    <label
                        htmlFor={checkboxId}
                        className="ml-2 text-xs text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t.rich('termsCheckbox', {
                            terms: (chunks) => (
                                <a
                                    href={legalHref('tos')}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:text-primary-hover"
                                >
                                    {chunks}
                                </a>
                            ),
                            privacy: (chunks) => (
                                <a
                                    href={legalHref('privacy')}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:text-primary-hover"
                                >
                                    {chunks}
                                </a>
                            ),
                        })}
                    </label>
                </div>

                <div className="flex gap-3">
                    <Button
                        type="button"
                        variant="secondary"
                        data-testid="ever-id-create-account-cancel"
                        onClick={cancel}
                        disabled={busy}
                        loading={isCancelling}
                        className="flex-1"
                    >
                        {t('createAccount.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        data-testid="ever-id-create-account-submit"
                        disabled={busy || termsUnavailable}
                        loading={isCreating}
                        className="flex-1 bg-primary hover:bg-primary-hover"
                    >
                        {t('createAccount.submit')}
                    </Button>
                </div>
            </form>
        </AuthLayout>
    );
}
