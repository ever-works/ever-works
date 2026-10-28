'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { ROUTES } from '@/lib/constants';
import { accountDeletionClient } from '@/lib/account-deletion-client';

/**
 * Step 1 of the email-link deletion: ask for the address. The answer is the
 * same whether or not an account exists — the page never says which.
 */
export function DeleteAccountRequestForm() {
    const t = useTranslations('auth.deleteAccount.request');
    const [isPending, startTransition] = useTransition();
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [sentTo, setSentTo] = useState<string | null>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        startTransition(async () => {
            const response = await accountDeletionClient.request(email, t('errors.failed'));
            if (!response.success) {
                setError(response.error);
                return;
            }
            setSentTo(email.trim());
        });
    };

    if (sentTo) {
        return (
            <AuthLayout title={t('successTitle')} subtitle={t('successSubtitle')}>
                <ThemeToggle variant="fixed" />
                <div className="space-y-6" data-testid="delete-account-request-sent">
                    <div className="bg-success/10 border border-success/20 rounded-lg p-5 space-y-2">
                        <p className="text-sm text-text dark:text-text-dark">{t('successMessage', { email: sentTo })}</p>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">{t('successExpiry')}</p>
                    </div>
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">{t('checkSpam')}</p>
                    <div className="text-center">
                        {/* A full page load on purpose: these pages stay out of client-side analytics. */}
                        <a href={ROUTES.AUTH_LOGIN} className="text-sm text-primary hover:text-primary-hover font-medium">
                            {t('backToLogin')}
                        </a>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <ThemeToggle variant="fixed" />
            <form onSubmit={handleSubmit} className="space-y-6" data-testid="delete-account-request-form">
                {error && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm" role="alert">
                        {error}
                    </div>
                )}

                <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p className="font-medium text-text dark:text-text-dark">{t('whatHappensTitle')}</p>
                    <ul className="list-disc pl-5 space-y-1">
                        <li>{t('whatHappens.0')}</li>
                        <li>{t('whatHappens.1')}</li>
                        <li>{t('whatHappens.2')}</li>
                    </ul>
                </div>

                <Input
                    type="email"
                    label={t('form.email.label')}
                    name="email"
                    autoComplete="email"
                    placeholder={t('form.email.placeholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isPending}
                />

                <Button type="submit" variant="danger" disabled={isPending || !email} loading={isPending} fullWidth>
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

                <div className="text-center space-y-2">
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">{t('signedInHint')}</p>
                    <a href={ROUTES.AUTH_LOGIN} className="text-sm text-primary hover:text-primary-hover transition-colors">
                        {t('backToLogin')}
                    </a>
                </div>
            </form>
        </AuthLayout>
    );
}
