'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/theme-toggle';
import { ROUTES } from '@/lib/constants';
import { accountDeletionClient } from '@/lib/account-deletion-client';
import type { AccountDeletionPreview } from '@/lib/api/account-deletion';
import { AccountDeletionSummary } from '@/components/settings/AccountDeletionSummary';

type State =
    | { status: 'loading' }
    | { status: 'invalid'; message: string }
    | { status: 'ready'; preview: AccountDeletionPreview }
    | { status: 'deleted' };

/** The word typed to confirm. Kept literal in every language, like a slug. */
const CONFIRM_WORD = 'DELETE';

/** Read `token` from `#token=…` (or `#/route?token=…`), then wipe the fragment. */
function takeTokenFromFragment(): string | null {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
    const token = new URLSearchParams(query).get('token');
    // Remove the token from the address bar and the session-history entry
    // before anything else on the page can read or report the URL.
    //
    // 🛑 `null`, not `window.history.state`: Next.js patches replaceState and
    // only re-syncs its router's own URL when the state is NOT its internal
    // one (`__NA`). Passing the current state through made the router keep
    // the old URL — fragment included — and put `#token=…` back in the
    // address bar after the next server action.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return token && token.length <= 256 ? token : null;
}

/**
 * Step 2 of the email-link deletion. Verify (read-only) → show what goes →
 * typed confirmation → the single-use confirm. No session is created at any
 * point; the token lives only in memory.
 */
export function DeleteAccountConfirmClient() {
    const t = useTranslations('auth.deleteAccount.confirm');
    const [state, setState] = useState<State>({ status: 'loading' });
    const [typed, setTyped] = useState('');
    const [error, setError] = useState('');
    const [isPending, startTransition] = useTransition();
    const tokenRef = useRef<string | null>(null);
    const started = useRef(false);

    useEffect(() => {
        const load = (token: string | null) => {
            tokenRef.current = token;
            setTyped('');
            setError('');
            if (!token) {
                setState({ status: 'invalid', message: t('errors.missingToken') });
                return;
            }
            setState({ status: 'loading' });
            void accountDeletionClient.verify(token, t('errors.failed')).then((result) => {
                // A newer link may have arrived meanwhile; only the current one may set the state.
                if (tokenRef.current !== token) return;
                setState(
                    result.success
                        ? { status: 'ready', preview: result.data }
                        : { status: 'invalid', message: result.error },
                );
            });
        };

        // A second link opened in the same tab is a fragment-only navigation:
        // no reload, no remount. Pick its token up the same way.
        const onHashChange = () => {
            const token = takeTokenFromFragment();
            if (token) load(token);
        };
        window.addEventListener('hashchange', onHashChange);

        if (!started.current) {
            // React StrictMode runs mount effects twice in dev; read the fragment once.
            started.current = true;
            load(takeTokenFromFragment());
        }
        return () => window.removeEventListener('hashchange', onHashChange);
    }, [t]);

    const handleDelete = () => {
        const token = tokenRef.current;
        if (!token || typed.trim() !== CONFIRM_WORD) return;
        setError('');
        startTransition(async () => {
            const result = await accountDeletionClient.confirm(token, t('errors.failed'));
            if (result.success) {
                tokenRef.current = null;
                setState({ status: 'deleted' });
                return;
            }
            if (result.gone) {
                setState({ status: 'invalid', message: result.error });
                return;
            }
            setError(result.error);
        });
    };

    if (state.status === 'loading') {
        return (
            <AuthLayout title={t('title')} subtitle={t('loading')}>
                <ThemeToggle variant="fixed" />
                <div
                    className="flex justify-center py-8"
                    data-testid="delete-account-confirm-loading"
                >
                    <div className="animate-pulse text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('loading')}
                    </div>
                </div>
            </AuthLayout>
        );
    }

    if (state.status === 'invalid') {
        return (
            <AuthLayout title={t('invalidTitle')} subtitle={t('invalidSubtitle')}>
                <ThemeToggle variant="fixed" />
                <div className="space-y-4" data-testid="delete-account-confirm-invalid">
                    <div className="bg-danger/10 border border-danger/20 px-4 py-3 rounded-lg text-sm text-text-secondary dark:text-text-secondary-dark">
                        {state.message}
                    </div>
                    <a href={ROUTES.DELETE_ACCOUNT} className="block">
                        <Button type="button" fullWidth>
                            {t('requestNewLink')}
                        </Button>
                    </a>
                </div>
            </AuthLayout>
        );
    }

    if (state.status === 'deleted') {
        return (
            <AuthLayout title={t('deletedTitle')} subtitle={t('deletedSubtitle')}>
                <ThemeToggle variant="fixed" />
                <div className="space-y-4" data-testid="delete-account-confirm-deleted">
                    <div className="bg-success/10 border border-success/20 rounded-lg p-5 text-sm text-text dark:text-text-dark space-y-2">
                        <p>{t('deletedMessage')}</p>
                        <p className="text-text-secondary dark:text-text-secondary-dark">
                            {t('deletedKept')}
                        </p>
                    </div>
                    <a
                        href={ROUTES.AUTH_REGISTER}
                        className="text-sm text-primary hover:text-primary-hover font-medium"
                    >
                        {t('goodbyeLink')}
                    </a>
                </div>
            </AuthLayout>
        );
    }

    const { preview } = state;
    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle', { email: preview.email ?? '' })}>
            <ThemeToggle variant="fixed" />
            <div className="space-y-5" data-testid="delete-account-confirm-ready">
                <AccountDeletionSummary preview={preview} />

                {preview.expiresAt && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('expiresAt', { time: new Date(preview.expiresAt).toLocaleTimeString() })}
                    </p>
                )}

                {error && (
                    <div
                        className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm"
                        role="alert"
                    >
                        {error}
                    </div>
                )}

                <Input
                    type="text"
                    name="confirm"
                    autoComplete="off"
                    label={t('typeToConfirm', { word: CONFIRM_WORD })}
                    placeholder={CONFIRM_WORD}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    disabled={isPending}
                    data-testid="delete-account-confirm-input"
                />

                <Button
                    type="button"
                    variant="danger"
                    fullWidth
                    loading={isPending}
                    disabled={isPending || typed.trim() !== CONFIRM_WORD}
                    onClick={handleDelete}
                    data-testid="delete-account-confirm-button"
                >
                    {isPending ? t('deleting') : t('confirmButton')}
                </Button>

                <div className="text-center">
                    <a
                        href={ROUTES.AUTH_LOGIN}
                        className="text-sm text-primary hover:text-primary-hover"
                    >
                        {t('keepAccount')}
                    </a>
                </div>
            </div>
        </AuthLayout>
    );
}
