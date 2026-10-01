import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginClient } from './login-client';
import { getAuthFromCookie, wasSignedOutByEverId } from '@/lib/auth';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';
import { getAuthProvidersConfig } from '@/lib/auth/providers';
import { hasEverIdSignOutMarker } from '@/lib/auth/ever-id-signed-out';
import { EVER_ID_ANONYMOUS_DISTINCT_ID, isEverIdOffered } from '@/lib/feature-flags/ever-id';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('signIn') };
}

export default async function LoginPage() {
    const locale = await getLocale();
    const { socialProviders, magicLinkEnabled, everId } = await getAuthProvidersConfig();
    const user = await getAuthFromCookie();
    if (user) {
        return redirect({ locale, href: ROUTES.DASHBOARD });
    }

    // APW-12 (Ever ID) — the button needs the administrator's switch AND the
    // `ever-id` flag (evaluated for the signed-out visitor only when the switch
    // is on, so nothing is asked of the flag service while Ever ID is off).
    const everIdEnabled = await isEverIdOffered(everId, EVER_ID_ANONYMOUS_DISTINCT_ID);
    // S6 — the session the visitor arrived with was ended by an Ever ID sign-out
    // notice: either the check above just asked the API about the stale cookie,
    // or an earlier action already removed it and left the marker.
    const signedOutByEverId = wasSignedOutByEverId() || (await hasEverIdSignOutMarker());

    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-background dark:bg-background-dark flex items-center justify-center">
                    <div className="animate-pulse">
                        <div className="w-12 h-12 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full"></div>
                    </div>
                </div>
            }
        >
            <LoginClient
                availableSocialProviders={socialProviders}
                magicLinkEnabled={magicLinkEnabled}
                everIdEnabled={everIdEnabled}
                signedOutByEverId={signedOutByEverId}
            />
        </Suspense>
    );
}
