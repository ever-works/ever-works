'use client';

import { useState, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { requestVerificationEmail } from '@/app/actions/auth';

/**
 * EW-070 — signed-out verification resend.
 *
 * Deliberately shaped like forgot-password, for the same reason: the API
 * answers with ONE body whether the address is unknown, already verified, or
 * genuinely mailed. So this renders ONE success branch and the copy hedges
 * exactly as far as the server does. Rendering two branches — or wording this
 * as a flat "Email sent" — would either leak account existence or repeat the
 * EW-071 defect of claiming something the server never promised.
 */
export default function ResendVerificationForm() {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('auth.resendVerification');
    const [email, setEmail] = useState('');
    const [submittedEmail, setSubmittedEmail] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        startTransition(() => {
            void (async () => {
                const response = await requestVerificationEmail(email);
                if (!response.success) {
                    setError(response.error || t('errors.failed'));
                    return;
                }

                // Pin the address that was actually submitted so the
                // confirmation cannot drift if the field is edited afterwards.
                setSubmittedEmail(email);
                setSuccess(true);
            })();
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
                                    {t('success.message', { email: submittedEmail })}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="text-center space-y-2">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('success.checkSpam')}
                        </p>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('success.linkExpiry')}
                        </p>
                        <div className="pt-2">
                            <Link
                                href={ROUTES.AUTH_LOGIN}
                                className="text-primary hover:text-primary-hover font-medium transition-colors"
                            >
                                {t('backToLogin')}
                            </Link>
                        </div>
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
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('alreadyVerified')}{' '}
                        <Link
                            href={ROUTES.AUTH_LOGIN}
                            className="text-primary hover:text-primary-hover font-medium transition-colors"
                        >
                            {t('backToLogin')}
                        </Link>
                    </p>

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
