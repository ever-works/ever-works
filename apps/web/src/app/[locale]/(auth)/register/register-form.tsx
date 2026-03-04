'use client';

import { useState, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { register as registerAction } from '@/app/actions/auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { ThemeToggle } from '@/components/theme-toggle';

export default function RegisterForm() {
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

        startTransition(async () => {
            const response = await registerAction(formData.name, formData.email, formData.password);

            if (!response.success) {
                setError(response.error || t('errors.generic'));
                return;
            }
        });
    };

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <ThemeToggle />
            <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">
                        {error}
                    </div>
                )}

                <Input
                    type="text"
                    label={t('form.name.label')}
                    name="name"
                    placeholder={t('form.name.placeholder')}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                    disabled={isPending}
                    className="text-sm shadow-sm"
                />

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

                <Input
                    type="password"
                    name="password"
                    label={t('form.password.label')}
                    placeholder={t('form.password.placeholder')}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    helperText={t('form.password.hint')}
                    required
                    disabled={isPending}
                    className="text-sm shadow-sm"
                />

                <Input
                    type="password"
                    name="confirmPassword"
                    label={t('form.confirmPassword.label')}
                    placeholder={t('form.confirmPassword.placeholder')}
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    required
                    disabled={isPending}
                    className="text-sm shadow-sm"
                />

                <div className="flex items-center mb-6">
                    <input
                        id="terms"
                        type="checkbox"
                        required
                        className="w-4 h-4 mt-0.5 bg-surface-secondary dark:bg-surface-secondary-dark border-border dark:border-border-dark rounded text-primary focus:ring-primary"
                    />

                    <label
                        htmlFor="terms"
                        className="ml-2 text-xs text-text-secondary dark:text-text-secondary-dark"
                    >
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

                <Button type="submit" disabled={isPending} loading={isPending} fullWidth>
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border dark:border-border-dark" />
                    </div>

                    <div className="relative flex justify-center text-sm">
                        <span className="bg-background dark:bg-background-dark px-2 text-text-muted dark:text-text-muted-dark">
                            {t('socialSignUp.divider')}
                        </span>
                    </div>
                </div>

                <SocialLoginButtons />

                <p className="text-center text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('signIn.text')}{' '}
                    <Link
                        href={ROUTES.AUTH_LOGIN}
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        {t('signIn.link')}
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
