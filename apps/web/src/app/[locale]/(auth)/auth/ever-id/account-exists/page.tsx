import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { readEverIdPending } from '@/lib/auth/ever-id-cookies';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('auth.everId.accountExists');
    return { title: t('title') };
}

/**
 * APW-12 (Ever ID) — "You already have an Ever Works account" (S3, spec §6.2,
 * T25).
 *
 * An unconnected Ever ID whose verified address an existing account already uses
 * creates nothing and signs nobody in; this page says so and points to the two
 * ways back in. The address is read from the encrypted pending cookie the
 * callback set — never from the address bar — and no account identifier is shown
 * (ACC-12-15). Without a live pending value it says "That took too long. Start
 * again." and keeps both ways back.
 */
export default async function EverIdAccountExistsPage() {
    const t = await getTranslations('auth.everId');
    const pending = await readEverIdPending('emailInUse');

    return (
        <AuthLayout
            title={t('accountExists.title')}
            subtitle={pending ? t('accountExists.body', { email: pending.email }) : ''}
        >
            <ThemeToggle variant="fixed" />
            <div className="space-y-4">
                {pending ? null : (
                    <p
                        role="alert"
                        data-testid="ever-id-account-exists-expired"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm text-text dark:text-text-dark"
                    >
                        {t('pendingExpired')}
                    </p>
                )}
                <div className="flex flex-col gap-3 sm:flex-row">
                    <Button href={ROUTES.AUTH_FORGOT_PASSWORD} variant="secondary" fullWidth>
                        {t('accountExists.forgotPassword')}
                    </Button>
                    <Button href={ROUTES.AUTH_LOGIN} fullWidth>
                        {t('accountExists.goToSignIn')}
                    </Button>
                </div>
            </div>
        </AuthLayout>
    );
}
