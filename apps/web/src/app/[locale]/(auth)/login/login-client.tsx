'use client';

import { useState, useTransition, useEffect } from 'react';
import { Link } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { login as loginAction } from '@/app/actions/auth';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';
import { ThemeToggle } from '@/components/theme-toggle';

function PasswordResetSuccessMessage() {
    const t = useTranslations('auth.login');

    return (
        <div className="bg-success/10 border border-success/20 px-4 py-3 rounded-lg">
            <div className="flex items-start gap-3">
                <div className="w-5 h-5 bg-success/20 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                    <svg
                        className="w-3 h-3 text-success"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                        />
                    </svg>
                </div>
                <div className="flex-1">
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('passwordReset.success')}
                    </p>
                    <p className="text-xs text-text-secondary/70 dark:text-text-secondary-dark/70 mt-1">
                        {t('passwordReset.canLogin')}
                    </p>
                </div>
            </div>
        </div>
    );
}

export function LoginClient() {
    const searchParams = useSearchParams();
    const t = useTranslations('auth.login');
    const [isPending, startTransition] = useTransition();

    const isPasswordReset = searchParams.get('reset') === 'true';
    const redirectUrl = searchParams.get(REDIRECT_SEARCH_PARAM);

    const [formData, setFormData] = useState({
        email: '',
        password: '',
    });
    const [error, setError] = useState('');
    const [showResetSuccess, setShowResetSuccess] = useState(isPasswordReset);

    useEffect(() => {
        if (isPasswordReset) {
            const TIMEOUT = 10 * 1000;

            // Hide the success message after 10 seconds
            const timer = setTimeout(() => {
                setShowResetSuccess(false);
            }, TIMEOUT);

            return () => clearTimeout(timer);
        }
    }, [isPasswordReset]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        setError('');
        setShowResetSuccess(false);

        startTransition(async () => {
            const response = await loginAction(formData.email, formData.password, redirectUrl);
            if (!response.success) {
                setError(response.error || t('errors.invalidCredentials'));
                return;
            }
        });
    };

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <ThemeToggle variant="fixed" />
            <form onSubmit={handleSubmit} className="space-y-4">
                {showResetSuccess && <PasswordResetSuccessMessage />}

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
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    required
                    disabled={isPending}
                    className="text-sm shadow-sm"
                />

                <div className="mb-6">
                    <div className="flex items-center justify-between mb-2">
                        <label className="block text-xs font-medium text-text dark:text-text-dark">
                            {t('form.password.label')}
                        </label>
                        <Link
                            href={ROUTES.AUTH_FORGOT_PASSWORD}
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            {t('form.forgotPassword')}
                        </Link>
                    </div>
                    <Input
                        type="password"
                        name="password"
                        placeholder={t('form.password.placeholder')}
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        required
                        disabled={isPending}
                        className="text-sm shadow-sm"
                    />
                </div>

                {/* <div className="flex items-center">
                    <input
                        id="remember"
                        type="checkbox"
                        className="w-4 h-4 bg-surface-secondary border-border rounded text-primary focus:ring-primary"
                    />
                    <label htmlFor="remember" className="ml-2 text-sm text-text-secondary">
                        {t('form.rememberMe')}
                    </label>
                </div> */}

                <Button
                    type="submit"
                    disabled={isPending}
                    loading={isPending}
                    fullWidth
                    className="bg-primary-hover hover:bg-primary"
                >
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border dark:border-border-dark" />
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="bg-background dark:bg-background-dark px-2 text-text-muted dark:text-text-muted-dark">
                            {t('socialLogin.divider')}
                        </span>
                    </div>
                </div>

                <SocialLoginButtons />

                <p className="text-center text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('signUp.text')}{' '}
                    <Link
                        href={ROUTES.AUTH_REGISTER}
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        {t('signUp.link')}
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
