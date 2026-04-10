import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginClient } from './login-client';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';
import { getConfiguredAuthProviders } from '@/lib/auth/providers';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('signIn') };
}

export default async function LoginPage() {
    const locale = await getLocale();
    const availableSocialProviders = await getConfiguredAuthProviders();
    const user = await getAuthFromCookie();
    if (user) {
        return redirect({ locale, href: ROUTES.DASHBOARD });
    }

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
            <LoginClient availableSocialProviders={availableSocialProviders} />
        </Suspense>
    );
}
