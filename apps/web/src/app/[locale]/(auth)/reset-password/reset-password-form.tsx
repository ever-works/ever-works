'use client';

import { useState, useTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { resetPassword as resetPasswordAction } from '@/app/actions/auth';

function ResetPasswordContent() {
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
    // EW-082: when the submit failed because the LINK is dead (expired, or
    // already used) rather than because the request hiccuped, "try again"
    // cannot work — only a fresh link can. Track that so the form can offer the
    // one action that helps, instead of leaving the user to re-press a button
    // that will fail identically forever.
    const [linkIsDead, setLinkIsDead] = useState(false);
    const [success] = useState(false);

    // If no token, show error message instead of redirecting
    if (!token) {
        return (
            <AuthLayout title={t('title')} subtitle={t('errors.noToken')}>
                <div className="space-y-6">
                    <div className="bg-danger/10 border border-danger/20 rounded-lg p-6">
                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-danger/20 rounded-lg flex items-center justify-center shrink-0">
                                <svg
                                    className="w-5 h-5 text-danger"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text dark:text-text-dark mb-1">
                                    {t('errors.invalidLink')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('errors.missingTokenMessage')}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="text-center space-y-4">
                        <Button href={ROUTES.AUTH_FORGOT_PASSWORD} size="lg">
                            {t('errors.requestNewLink')}
                        </Button>

                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            <Link
                                href={ROUTES.AUTH_LOGIN}
                                className="text-primary hover:text-primary-hover transition-colors"
                            >
                                {t('backToLogin')}
                            </Link>
                        </p>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors({});
        setLinkIsDead(false);

        // Validate passwords match
        if (formData.password !== formData.confirmPassword) {
            setErrors({ confirmPassword: t('form.confirmPassword.errors.noMatch') });
            return;
        }

        // Length was never checked here — only the match was — so a password
        // shorter than the API's @MinLength(8) sailed through to the server and
        // came back as the generic `errors.failed`, while the hint beside the
        // field still said 6 was fine. Someone resetting a password they have
        // already lost had no way to read their way out of that. The message
        // key existed all along and was simply never used.
        if (formData.password.length < 8) {
            setErrors({ password: t('form.password.errors.minLength') });
            return;
        }

        startTransition(() => {
            void (async () => {
                const response = await resetPasswordAction(token!, formData.password);
                if (!response.success) {
                    // EW-082: `response.error` is now the specific string for
                    // whichever failure actually happened — expired link, a
                    // no-longer-valid link, throttled, or a server-side problem
                    // — instead of one "Failed to reset password" for all four.
                    // See `classifyResetPasswordError`.
                    setErrors({ general: response.error || t('errors.failed') });
                    setLinkIsDead(Boolean(response.linkIsDead));
                    return;
                }
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
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text dark:text-text-dark mb-1">
                                    {t('success.title')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('success.message')}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="text-center">
                        <Button href={ROUTES.AUTH_LOGIN + '?reset=true'} size="lg">
                            {t('success.loginButton')}
                        </Button>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <form onSubmit={handleSubmit} className="space-y-6">
                {errors.general && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm space-y-3">
                        <p>{errors.general}</p>

                        {/* EW-082: a dead link cannot be retried into working.
                            Surface the only action that resolves it, right
                            where the failure is reported — the message above
                            tells the user to request a new link, so make that
                            clickable instead of making them go find the page. */}
                        {linkIsDead && (
                            <Button href={ROUTES.AUTH_FORGOT_PASSWORD} size="sm">
                                {t('errors.requestNewLink')}
                            </Button>
                        )}
                    </div>
                )}

                <Input
                    type="password"
                    label={t('form.password.label')}
                    name="password"
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
                    name="confirmPassword"
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

                <Button
                    type="submit"
                    disabled={isPending || !formData.password || !formData.confirmPassword}
                    loading={isPending}
                    fullWidth
                >
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

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

export default function ResetPasswordForm() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-background dark:bg-background-dark flex items-center justify-center">
                    <div className="animate-pulse">
                        <div className="w-12 h-12 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full"></div>
                    </div>
                </div>
            }
        >
            <ResetPasswordContent />
        </Suspense>
    );
}
