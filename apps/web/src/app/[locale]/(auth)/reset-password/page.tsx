'use client';

import { useState, useTransition, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { authAPI } from '@/lib/api/auth';
import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export default function ResetPasswordPage() {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('auth.resetPassword');
    const searchParams = useSearchParams();
    const token = searchParams.get('token');

    const [formData, setFormData] = useState({
        password: '',
        confirmPassword: '',
    });
    const [errors, setErrors] = useState<{
        password?: string;
        confirmPassword?: string;
        general?: string;
    }>({});
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (!token) {
            redirect({
                locale: 'en',
                href: ROUTES.AUTH_ERROR + '?error=reset_password_missing_token',
            });
        }
    }, [token]);

    const validatePassword = (password: string) => {
        if (password.length < 6) {
            return t('form.password.errors.minLength');
        }
        if (!/[a-z]/.test(password)) {
            return t('form.password.errors.lowercase');
        }
        if (!/(\d|\W)/.test(password)) {
            return t('form.password.errors.numberOrSpecial');
        }
        if (/^[.\n]/.test(password)) {
            return t('form.password.errors.cannotStartWith');
        }
        return '';
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors({});

        // Validate passwords
        const passwordError = validatePassword(formData.password);
        if (passwordError) {
            setErrors({ password: passwordError });
            return;
        }

        if (formData.password !== formData.confirmPassword) {
            setErrors({ confirmPassword: t('form.confirmPassword.errors.noMatch') });
            return;
        }

        startTransition(async () => {
            try {
                await authAPI.resetPassword({
                    token: token!,
                    newPassword: formData.password,
                });
                setSuccess(true);
            } catch (err) {
                console.error(err);
                setErrors({ general: t('errors.failed') });
            }
        });
    };

    if (success) {
        return (
            <AuthLayout title={t('successTitle')} subtitle={t('successSubtitle')}>
                <div className="space-y-6">
                    <div className="bg-success/10 border border-success/20 rounded-lg p-6">
                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-success/20 rounded-lg flex items-center justify-center flex-shrink-0">
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
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text mb-1">{t('success.title')}</h3>
                                <p className="text-sm text-text-secondary">
                                    {t('success.message')}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="text-center">
                        <Link
                            href={ROUTES.AUTH_LOGIN}
                            className="inline-block px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors"
                        >
                            {t('success.loginButton')}
                        </Link>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <form onSubmit={handleSubmit} className="space-y-6">
                {errors.general && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">
                        {errors.general}
                    </div>
                )}

                <Input
                    type="password"
                    label={t('form.password.label')}
                    placeholder={t('form.password.placeholder')}
                    value={formData.password}
                    onChange={(e) => {
                        setFormData({ ...formData, password: e.target.value });
                        setErrors({ ...errors, password: undefined });
                    }}
                    error={errors.password}
                    helperText={t('form.password.helperText')}
                    required
                    disabled={isPending}
                />

                <Input
                    type="password"
                    label={t('form.confirmPassword.label')}
                    placeholder={t('form.confirmPassword.placeholder')}
                    value={formData.confirmPassword}
                    onChange={(e) => {
                        setFormData({ ...formData, confirmPassword: e.target.value });
                        setErrors({ ...errors, confirmPassword: undefined });
                    }}
                    error={errors.confirmPassword}
                    required
                    disabled={isPending}
                />

                <button
                    type="submit"
                    disabled={isPending || !formData.password || !formData.confirmPassword}
                    className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isPending ? t('form.submitting') : t('form.submit')}
                </button>

                <div className="text-center">
                    <Link
                        href={ROUTES.AUTH_LOGIN}
                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                    >
                        {t('backToLogin')}
                    </Link>
                </div>
            </form>
        </AuthLayout>
    );
}
