'use client';

import { useState, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { forgotPassword as forgotPasswordAction } from '@/app/actions/auth';

export default function ForgotPasswordPage() {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('auth.forgotPassword');
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        startTransition(async () => {
            const response = await forgotPasswordAction(email);
            if (!response.success) {
                setError(response.error || t('errors.failed'));
                return;
            }

            setSuccess(true);
        });
    };

    if (success) {
        return (
            <AuthLayout title={t('successTitle')} subtitle={t('successSubtitle')}>
                <div className="space-y-6">
                    <div className="bg-success/10 border border-success/20 rounded-lg p-6">
                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-success/20 rounded-lg flex items-center justify-center shrink-0">
                                <svg
                                    className="w-5 h-5 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text dark:text-text-dark mb-1">
                                    {t('success.title')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('success.message', { email })}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="text-center">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('success.checkSpam')}
                        </p>
                        <Link
                            href={ROUTES.AUTH_LOGIN}
                            className="text-primary hover:text-primary-hover font-medium transition-colors"
                        >
                            {t('backToLogin')}
                        </Link>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <form onSubmit={handleSubmit} className="space-y-6">
                {error && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">
                        {error}
                    </div>
                )}

                <Input
                    type="email"
                    label={t('form.email.label')}
                    name="email"
                    placeholder={t('form.email.placeholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isPending}
                />

                <Button type="submit" disabled={isPending || !email} loading={isPending} fullWidth>
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

                <div className="text-center space-y-4">
                    <Link
                        href={ROUTES.AUTH_LOGIN}
                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                    >
                        {t('backToLogin')}
                    </Link>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('noAccount.text')}{' '}
                        <Link
                            href={ROUTES.AUTH_REGISTER}
                            className="text-primary hover:text-primary-hover font-medium transition-colors"
                        >
                            {t('noAccount.link')}
                        </Link>
                    </p>
                </div>
            </form>
        </AuthLayout>
    );
}
