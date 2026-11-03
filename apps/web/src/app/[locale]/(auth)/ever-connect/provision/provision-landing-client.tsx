'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    continueProvisionWithEverId,
    receiveProvisionIntent,
    type ProvisionFailure,
} from '@/app/actions/ever-connect-provision';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { everConnectProvisionFailureKey, readProvisionFragment } from './provision-fragment';

type Landing =
    | { state: 'checking' }
    | { state: 'failed'; failure: ProvisionFailure | 'incomplete' }
    | { state: 'ready'; name: string; handle: string; signedIn: boolean };

/**
 * Reads the request from the fragment, removes it from the address bar and the
 * history at once, and sends it to the server, which verifies it. Nothing is
 * created here: the next step signs the person in and asks them to confirm.
 */
export function ProvisionLandingClient() {
    const t = useTranslations('everConnect.provision');
    const router = useRouter();
    const [landing, setLanding] = useState<Landing>({ state: 'checking' });
    const [signInFailed, setSignInFailed] = useState<string | null>(null);
    const [isContinuing, startContinue] = useTransition();
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        const intent = readProvisionFragment(window.location.hash);
        window.history.replaceState(null, '', window.location.pathname);
        if (!intent) {
            setLanding({ state: 'failed', failure: 'incomplete' });
            return;
        }
        void receiveProvisionIntent(intent).then(
            (result) => {
                setLanding(
                    result.success
                        ? {
                              state: 'ready',
                              name: result.display.displayName,
                              handle: result.display.handle,
                              signedIn: result.signedIn,
                          }
                        : { state: 'failed', failure: result.failure },
                );
            },
            () => setLanding({ state: 'failed', failure: 'unreachable' }),
        );
    }, []);

    if (landing.state === 'failed') {
        return (
            <AuthLayout title={t('title')} subtitle="">
                <ThemeToggle variant="fixed" />
                <div className="space-y-4" data-testid="ever-connect-provision-failed">
                    <p
                        role="alert"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
                    >
                        {t(everConnectProvisionFailureKey(landing.failure))}
                    </p>
                    {landing.failure === 'unavailable' ? (
                        // The ordinary way: Works' own form, nothing read from the request.
                        <Button href={ROUTES.EVER_CONNECT_PROVISION_FALLBACK} fullWidth>
                            {t('createHere')}
                        </Button>
                    ) : null}
                </div>
            </AuthLayout>
        );
    }

    if (landing.state === 'checking') {
        return (
            <AuthLayout title={t('title')} subtitle="">
                <ThemeToggle variant="fixed" />
                <p role="status" data-testid="ever-connect-provision-checking">
                    {t('checking')}
                </p>
            </AuthLayout>
        );
    }

    const proceed = () => {
        if (isContinuing) return;
        setSignInFailed(null);
        if (landing.signedIn) {
            router.push(ROUTES.EVER_CONNECT_PROVISION_CONFIRM);
            return;
        }
        startContinue(async () => {
            // Success navigates away to Ever ID.
            const result = await continueProvisionWithEverId();
            if (result && !result.success) setSignInFailed(result.error);
        });
    };

    return (
        <AuthLayout
            title={t('title')}
            subtitle={t('forHandle', { name: landing.name, handle: landing.handle })}
        >
            <ThemeToggle variant="fixed" />
            <div className="space-y-4" data-testid="ever-connect-provision-ready">
                {signInFailed ? (
                    <p
                        role="alert"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
                    >
                        {signInFailed}
                    </p>
                ) : null}
                <p className="text-sm text-text dark:text-text-dark">{t('body')}</p>
                <Button onClick={proceed} disabled={isContinuing} fullWidth>
                    {landing.signedIn ? t('continue') : t('continueEverId')}
                </Button>
            </div>
        </AuthLayout>
    );
}
