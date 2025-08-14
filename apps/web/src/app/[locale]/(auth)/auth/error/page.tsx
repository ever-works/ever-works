'use client';

import { useTranslations } from 'next-intl';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';

function AuthErrorContent() {
    const t = useTranslations('auth.error');
    const searchParams = useSearchParams();
    const errorType = searchParams.get('error');

    const getErrorMessage = () => {
        switch (errorType) {
            case 'oauth_missing_code':
                return t('oauth.missingCode');
            case 'oauth_invalid_state':
                return t('oauth.invalidState');
            case 'oauth_unsupported_provider':
                return t('oauth.unsupportedProvider');
            case 'oauth_callback':
                return t('oauth.callbackFailed');
            case 'invalid_credentials':
                return t('invalidCredentials');
            case 'email_not_verified':
                return t('emailNotVerified');
            case 'account_locked':
                return t('accountLocked');
            case 'session_expired':
                return t('sessionExpired');
            case 'network_error':
                return t('networkError');
            case 'reset_password_missing_token':
                return t('resetPassword.missingToken');
            case 'reset_password_invalid_token':
                return t('resetPassword.invalidToken');
            case 'reset_password_expired_token':
                return t('resetPassword.expiredToken');
            case 'reset_password_failed':
                return t('resetPassword.failed');
            case 'verify_email_missing_token':
                return t('verifyEmail.missingToken');
            case 'verify_email_invalid_token':
                return t('verifyEmail.invalidToken');
            case 'verify_email_expired_token':
                return t('verifyEmail.expiredToken');
            case 'verify_email_failed':
                return t('verifyEmail.failed');
            case 'authorize_invalid_redirect_url':
                return t('authorize.invalidRedirectUrl');
            default:
                return t('generic');
        }
    };

    const getErrorIcon = () => {
        switch (errorType) {
            case 'oauth_missing_code':
            case 'oauth_invalid_state':
            case 'oauth_unsupported_provider':
            case 'oauth_callback':
                return (
                    <svg
                        className="w-12 h-12 text-warning"
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
                );
            case 'account_locked':
                return (
                    <svg
                        className="w-12 h-12 text-danger"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                        />
                    </svg>
                );
            case 'network_error':
                return (
                    <svg
                        className="w-12 h-12 text-danger"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
                        />
                    </svg>
                );
            case 'reset_password_missing_token':
            case 'reset_password_invalid_token':
            case 'reset_password_expired_token':
            case 'reset_password_failed':
                return (
                    <svg
                        className="w-12 h-12 text-warning"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H7v4H3v-4l4.257-4.257A6 6 0 1121 9z"
                        />
                    </svg>
                );
            case 'verify_email_missing_token':
            case 'verify_email_invalid_token':
            case 'verify_email_expired_token':
            case 'verify_email_failed':
                return (
                    <svg
                        className="w-12 h-12 text-warning"
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
                );
            case 'authorize_invalid_redirect_url':
                return (
                    <svg
                        className="w-12 h-12 text-warning"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                    </svg>
                );
            default:
                return (
                    <svg
                        className="w-12 h-12 text-danger"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                );
        }
    };

    const getActionButtons = () => {
        const buttons = [];

        if (errorType === 'email_not_verified') {
            buttons.push(
                <Link
                    key="resend"
                    href="/"
                    className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors animate-fade-in"
                >
                    {t('actions.resendVerification')}
                </Link>,
            );
        }

        if (errorType === 'account_locked') {
            buttons.push(
                <Link
                    key="support"
                    href="/support"
                    className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors animate-fade-in"
                >
                    {t('actions.contactSupport')}
                </Link>,
            );
        }

        if (errorType?.startsWith('reset_password_')) {
            buttons.push(
                <Link
                    key="forgot"
                    href={ROUTES.AUTH_FORGOT_PASSWORD}
                    className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors animate-fade-in"
                >
                    {t('actions.requestNewReset')}
                </Link>,
            );
        }

        if (errorType?.startsWith('verify_email_')) {
            buttons.push(
                <Link
                    key="resend-verification"
                    href="/"
                    className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors animate-fade-in"
                >
                    {t('actions.resendVerification')}
                </Link>,
            );
        }

        buttons.push(
            <Link
                key="login"
                href={ROUTES.AUTH_LOGIN}
                className={cn(
                    'px-6 py-3 bg-surface-secondary dark:bg-surface-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                    'text-text dark:text-text-dark border border-border dark:border-border-dark rounded-lg font-medium transition-colors animate-fade-in',
                )}
            >
                {t('actions.backToLogin')}
            </Link>,
        );

        if (errorType?.startsWith('oauth_')) {
            buttons.push(
                <Link
                    key="register"
                    href={ROUTES.AUTH_REGISTER}
                    className={cn(
                        'px-6 py-3 bg-surface-secondary dark:bg-surface-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                        'text-text dark:text-text-dark border border-border dark:border-border-dark rounded-lg font-medium transition-colors animate-fade-in',
                    )}
                >
                    {t('actions.tryRegister')}
                </Link>,
            );
        }

        return buttons;
    };

    return (
        <AuthLayout title={t('title')} subtitle={t('subtitle')}>
            <div className="text-center space-y-6 animate-slide-up">
                <div className="inline-flex items-center justify-center w-20 h-20 bg-danger/10 rounded-full mb-4">
                    {getErrorIcon()}
                </div>

                <div className="bg-danger/10 border border-danger/20 rounded-lg p-6">
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {errorType ? t('errorOccurred') : t('somethingWentWrong')}
                    </h2>
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {getErrorMessage()}
                    </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
                    {getActionButtons()}
                </div>

                {/* FOR NOW HIDE */}
                <div className="pt-8 border-t border-border dark:border-border-dark hidden">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                        {t('helpText')}
                    </p>
                    <div className="flex justify-center gap-6">
                        <Link
                            href="/help"
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            {t('links.help')}
                        </Link>
                        <Link
                            href="/status"
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            {t('links.systemStatus')}
                        </Link>
                    </div>
                </div>
            </div>
        </AuthLayout>
    );
}

export default function AuthErrorPage() {
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
            <AuthErrorContent />
        </Suspense>
    );
}
