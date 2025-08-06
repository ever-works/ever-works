'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { login as loginAction } from '@/app/actions/auth';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { Input } from '@/components/ui/input';
import { ROUTES } from '@/lib/constants';

export default function LoginPage() {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('auth.login');

    const [formData, setFormData] = useState({
        email: '',
        password: '',
    });
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        setError('');

        startTransition(async () => {
            const response = await loginAction(formData.email, formData.password);
            if (!response.success) {
                setError(response.error || t('errors.invalidCredentials'));
                return;
            }
        });
    };

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
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    required
                    disabled={isPending}
                />

                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-medium text-text">
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

                <button
                    type="submit"
                    disabled={isPending}
                    className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isPending ? t('form.submitting') : t('form.submit')}
                </button>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="bg-background px-2 text-text-muted">
                            {t('socialLogin.divider')}
                        </span>
                    </div>
                </div>

                <SocialLoginButtons />

                <p className="text-center text-sm text-text-secondary">
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
