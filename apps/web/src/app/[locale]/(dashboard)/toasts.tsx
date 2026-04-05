'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { APP_NAME } from '@/lib/constants';

export default function DashboardToasts() {
    const searchParams = useSearchParams();
    const t = useTranslations('dashboard.toasts');

    const isNewUser = searchParams.get('newUser') === 'true';
    const isVerified = searchParams.get('verified') === 'true';
    const isOAuthConnected = searchParams.get('oauth_connected') === 'true';

    useEffect(() => {
        if (isNewUser) {
            // Show welcome toast for new users
            toast.success(t('newUser.title', { companyName: APP_NAME }), {
                description: t('newUser.description'),
                duration: 6000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                    </svg>
                ),
            });

            // Show email verification reminder
            toast.info(t('emailVerification.title'), {
                description: t('emailVerification.description'),
                duration: 8000,
                // action: {
                //     label: t('emailVerification.action'),
                //     onClick: () => {
                //         window.location.href = '/resend-verification';
                //     },
                // },
            });
        }

        if (isVerified) {
            // Show email verified success toast
            toast.success(t('verified.title'), {
                description: t('verified.description'),
                duration: 5000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            });
        }

        if (isOAuthConnected) {
            toast.success(t('oauthConnected.title'), {
                description: t('oauthConnected.description'),
                duration: 5000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            });
        }

        // Clean up URL after showing toasts
        if (isNewUser || isVerified || isOAuthConnected) {
            const timer = setTimeout(() => {
                // Remove query params without page refresh
                const url = new URL(window.location.href);
                url.searchParams.delete('newUser');
                url.searchParams.delete('verified');
                url.searchParams.delete('oauth_connected');
                window.history.replaceState({}, '', url.pathname + url.search);
            }, 1000);

            return () => clearTimeout(timer);
        }
    }, [isNewUser, isVerified, isOAuthConnected, t]);

    return null; // This component doesn't render anything
}
