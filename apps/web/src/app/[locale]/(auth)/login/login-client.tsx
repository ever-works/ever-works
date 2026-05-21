'use client';

import { useState, useTransition, useEffect } from 'react';
import { Link } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { login as loginAction, issueMagicLink } from '@/app/actions/auth';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';
import { ThemeToggle } from '@/components/theme-toggle';
import { OAuthProvider } from '@/lib/api/enums';

interface LoginClientProps {
    availableSocialProviders: OAuthProvider[];
    magicLinkEnabled: boolean;
}

type LoginTab = 'password' | 'magic-link';

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

function MagicLinkSuccessMessage({ email, onResend }: { email: string; onResend: () => void }) {
    const t = useTranslations('auth.login.magicLink.success');

    return (
        <div
            data-testid="magic-link-success"
            className="bg-success/10 border border-success/20 px-4 py-3 rounded-lg space-y-2"
        >
            <p className="text-sm font-medium text-text dark:text-text-dark">{t('title')}</p>
            <p className="text-xs text-text-secondary/70 dark:text-text-secondary-dark/70">
                {t('message', { email })}
            </p>
            <button
                type="button"
                onClick={onResend}
                className="text-xs text-primary hover:text-primary-hover transition-colors"
            >
                {t('resend')}
            </button>
        </div>
    );
}

export function LoginClient({ availableSocialProviders, magicLinkEnabled }: LoginClientProps) {
    const searchParams = useSearchParams();
    const t = useTranslations('auth.login');
    const [isPending, startTransition] = useTransition();

    const isPasswordReset = searchParams.get('reset') === 'true';
    const redirectUrl = searchParams.get(REDIRECT_SEARCH_PARAM);
    const initialTab: LoginTab =
        magicLinkEnabled && searchParams.get('tab') === 'magic-link' ? 'magic-link' : 'password';

    const [tab, setTab] = useState<LoginTab>(initialTab);
    const [formData, setFormData] = useState({
        email: '',
        password: '',
    });
    const [magicLinkEmail, setMagicLinkEmail] = useState('');
    const [magicLinkSentTo, setMagicLinkSentTo] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [showResetSuccess, setShowResetSuccess] = useState(isPasswordReset);

    useEffect(() => {
        if (isPasswordReset) {
            const TIMEOUT = 10 * 1000;
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
            if (response && !response.success) {
                setError(response.error || t('errors.invalidCredentials'));
            }
        });
    };

    const handleMagicLinkSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        setError('');
        setShowResetSuccess(false);
        setMagicLinkSentTo(null);

        startTransition(async () => {
            const response = await issueMagicLink(magicLinkEmail);
            if (response.success) {
                setMagicLinkSentTo(magicLinkEmail);
            } else {
                setError(response.error || t('magicLink.errors.failed'));
            }
        });
    };

    const switchTab = (next: LoginTab) => {
        if (next === tab) return;
        setTab(next);
        setError('');
        setMagicLinkSentTo(null);
    };

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <ThemeToggle variant="fixed" />

            {magicLinkEnabled && (
                <div
                    role="tablist"
                    aria-label={t('title')}
                    className="grid grid-cols-2 mb-4 p-1 bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg"
                >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'password'}
                        data-testid="login-tab-password"
                        onClick={() => switchTab('password')}
                        className={`text-sm font-medium px-3 py-2 rounded-md transition-colors ${
                            tab === 'password'
                                ? 'bg-background dark:bg-background-dark text-text dark:text-text-dark shadow-sm'
                                : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark'
                        }`}
                    >
                        {t('tabs.password')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'magic-link'}
                        data-testid="login-tab-magic-link"
                        onClick={() => switchTab('magic-link')}
                        className={`text-sm font-medium px-3 py-2 rounded-md transition-colors ${
                            tab === 'magic-link'
                                ? 'bg-background dark:bg-background-dark text-text dark:text-text-dark shadow-sm'
                                : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark'
                        }`}
                    >
                        {t('tabs.magicLink')}
                    </button>
                </div>
            )}

            {tab === 'password' ? (
                <form method="post" onSubmit={handleSubmit} className="space-y-4">
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

                    <Button
                        type="submit"
                        disabled={isPending}
                        loading={isPending}
                        fullWidth
                        className="bg-primary hover:bg-primary-hover"
                    >
                        {isPending ? t('form.submitting') : t('form.submit')}
                    </Button>

                    {availableSocialProviders.length > 0 && (
                        <>
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

                            <SocialLoginButtons providers={availableSocialProviders} />
                        </>
                    )}

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
            ) : (
                <form
                    method="post"
                    onSubmit={handleMagicLinkSubmit}
                    data-testid="magic-link-form"
                    className="space-y-4"
                >
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('magicLink.subtitle')}
                    </p>

                    {magicLinkSentTo ? (
                        <MagicLinkSuccessMessage
                            email={magicLinkSentTo}
                            onResend={() => setMagicLinkSentTo(null)}
                        />
                    ) : (
                        <>
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
                                value={magicLinkEmail}
                                onChange={(e) => setMagicLinkEmail(e.target.value)}
                                required
                                disabled={isPending}
                                data-testid="magic-link-email"
                                className="text-sm shadow-sm"
                            />

                            <Button
                                type="submit"
                                disabled={isPending}
                                loading={isPending}
                                fullWidth
                                data-testid="magic-link-submit"
                                className="bg-primary hover:bg-primary-hover"
                            >
                                {isPending
                                    ? t('magicLink.form.submitting')
                                    : t('magicLink.form.submit')}
                            </Button>
                        </>
                    )}

                    {availableSocialProviders.length > 0 && (
                        <>
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

                            <SocialLoginButtons providers={availableSocialProviders} />
                        </>
                    )}

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
            )}
        </AuthLayout>
    );
}
