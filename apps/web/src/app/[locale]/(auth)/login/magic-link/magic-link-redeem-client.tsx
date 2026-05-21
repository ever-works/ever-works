'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { redeemMagicLink } from '@/app/actions/auth';
import { REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';

type RedeemState =
    | { status: 'loading' }
    | { status: 'missing-token' }
    | { status: 'error'; message: string };

export function MagicLinkRedeemClient() {
    const searchParams = useSearchParams();
    const t = useTranslations('auth.login.magicLink.redeem');
    const [, startTransition] = useTransition();

    const token = searchParams.get('token');
    const redirectUrl = searchParams.get(REDIRECT_SEARCH_PARAM);

    const [state, setState] = useState<RedeemState>(() =>
        token ? { status: 'loading' } : { status: 'missing-token' },
    );
    // Magic-link tokens are single-use; guard against React StrictMode's
    // double-mount in dev (and any future remounts) consuming the token
    // twice and showing an "invalid link" error after a successful redeem.
    const redeemedTokens = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!token) return;
        if (redeemedTokens.current.has(token)) return;
        redeemedTokens.current.add(token);

        startTransition(async () => {
            const response = await redeemMagicLink(token, redirectUrl);
            // On success the server action calls `redirect()`, so this
            // component is replaced before we get a return value back.
            // If we do get a response, it's an error envelope.
            if (response && !response.success) {
                setState({ status: 'error', message: response.error || t('errorBody') });
            }
        });
    }, [token, redirectUrl, t]);

    const resendHref =
        ROUTES.AUTH_LOGIN +
        '?tab=magic-link' +
        (redirectUrl ? `&${REDIRECT_SEARCH_PARAM}=${encodeURIComponent(redirectUrl)}` : '');

    return (
        <AuthLayout title={t('title')} subtitle={t('loading')}>
            <ThemeToggle variant="fixed" />

            {state.status === 'loading' && (
                <div
                    data-testid="magic-link-loading"
                    className="flex items-center justify-center py-8"
                >
                    <div className="animate-pulse text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('loading')}
                    </div>
                </div>
            )}

            {state.status !== 'loading' && (
                <div data-testid="magic-link-error" className="space-y-4">
                    <div className="bg-danger/10 border border-danger/20 px-4 py-3 rounded-lg space-y-2">
                        <p className="text-sm font-medium text-danger">{t('errorTitle')}</p>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {state.status === 'missing-token' ? t('missingToken') : state.message}
                        </p>
                    </div>

                    <Link href={resendHref} className="block">
                        <Button
                            type="button"
                            fullWidth
                            data-testid="magic-link-request-new"
                            className="bg-primary hover:bg-primary-hover"
                        >
                            {t('requestNewLink')}
                        </Button>
                    </Link>
                </div>
            )}
        </AuthLayout>
    );
}
