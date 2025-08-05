'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { register as registerAction } from '@/app/actions/auth';

export default function RegisterPage() {
    const t = useTranslations('auth.register');
    const [isPending, startTransition] = useTransition();

    const [formData, setFormData] = useState({
        name: '',
        email: '',
        password: '',
        confirmPassword: '',
    });

    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        // Validation
        if (formData.password !== formData.confirmPassword) {
            setError(t('errors.passwordsDoNotMatch'));
            return;
        }

        if (formData.password.length < 8) {
            setError(t('errors.passwordTooShort'));
            return;
        }

        try {
            startTransition(async () => {
                try {
                    await registerAction(formData.name, formData.email, formData.password);
                } catch (err) {
                    console.error(err);
                    setError(t('errors.generic'));
                }
            });
        } catch (err) {
            setError(t('errors.generic'));
        }
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
                    <label htmlFor="name" className="block text-sm font-medium text-text mb-2">
                        {t('form.name.label')}
                    </label>
                    <input
                        id="name"
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder={t('form.name.placeholder')}
                    />
                </div>

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
                    <label htmlFor="password" className="block text-sm font-medium text-text mb-2">
                        {t('form.password.label')}
                    </label>
                    <input
                        id="password"
                        type="password"
                        required
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder={t('form.password.placeholder')}
                    />
                    <p className="mt-1 text-xs text-text-muted">{t('form.password.hint')}</p>
                </div>

                <div>
                    <label
                        htmlFor="confirmPassword"
                        className="block text-sm font-medium text-text mb-2"
                    >
                        {t('form.confirmPassword.label')}
                    </label>
                    <input
                        id="confirmPassword"
                        type="password"
                        required
                        value={formData.confirmPassword}
                        onChange={(e) =>
                            setFormData({ ...formData, confirmPassword: e.target.value })
                        }
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder={t('form.confirmPassword.placeholder')}
                    />
                </div>

                <div className="flex items-start">
                    <input
                        id="terms"
                        type="checkbox"
                        required
                        className="w-4 h-4 mt-0.5 bg-surface-secondary border-border rounded text-primary focus:ring-primary"
                    />

                    <label htmlFor="terms" className="ml-2 text-sm text-text-secondary">
                        {t('form.terms.text')}{' '}
                        <Link href="/terms" className="text-primary hover:text-primary-hover">
                            {t('form.terms.termsLink')}
                        </Link>{' '}
                        {t('form.terms.and')}{' '}
                        <Link href="/privacy" className="text-primary hover:text-primary-hover">
                            {t('form.terms.privacyLink')}
                        </Link>
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
                            {t('socialSignUp.divider')}
                        </span>
                    </div>
                </div>

                <SocialLoginButtons />

                <p className="text-center text-sm text-text-secondary">
                    {t('signIn.text')}{' '}
                    <Link
                        href="/login"
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        {t('signIn.link')}
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
