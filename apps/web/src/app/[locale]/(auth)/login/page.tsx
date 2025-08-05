'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { login as loginAction } from '@/app/actions/auth';
import { SocialLoginButtons } from '@/components/auth/social-login';

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
            try {
                await loginAction(formData.email, formData.password);
            } catch (err) {
                console.error(err);
                setError(t('errors.invalidCredentials'));
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

                <div>
                    <label htmlFor="email" className="block text-sm font-medium text-text mb-2">
                        {t('form.email.label')}
                    </label>
                    <input
                        id="email"
                        type="email"
                        required
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder={t('form.email.placeholder')}
                    />
                </div>

                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label htmlFor="password" className="block text-sm font-medium text-text">
                            {t('form.password.label')}
                        </label>
                        <Link
                            href="/forgot-password"
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            {t('form.forgotPassword')}
                        </Link>
                    </div>
                    <input
                        id="password"
                        type="password"
                        required
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder={t('form.password.placeholder')}
                    />
                </div>

                <div className="flex items-center">
                    <input
                        id="remember"
                        type="checkbox"
                        className="w-4 h-4 bg-surface-secondary border-border rounded text-primary focus:ring-primary"
                    />
                    <label htmlFor="remember" className="ml-2 text-sm text-text-secondary">
                        {t('form.rememberMe')}
                    </label>
                </div>

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
                        href="/register"
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        {t('signUp.link')}
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
