'use client';

import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { ROUTES } from '@/lib/constants';

interface AuthLayoutProps {
    children: React.ReactNode;
    title: string;
    subtitle: string;
}

export function AuthLayout({ children, title, subtitle }: AuthLayoutProps) {
    const t = useTranslations('layout.auth');
    return (
        <div className="min-h-screen bg-background dark:bg-background-dark flex">
            {/* Left side - Form */}
            <div className="flex-1 flex items-center justify-center px-8 py-12">
                <div className="w-full max-w-md">
                    <div className="mb-8 mt-5">
                        <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                            {title}
                        </h1>
                        <p className="text-text-secondary dark:text-text-secondary-dark">
                            {subtitle}
                        </p>
                    </div>

                    {children}
                </div>
            </div>

            {/* Right side - Feature showcase */}
            <div className="hidden lg:flex flex-1 bg-surface dark:bg-surface-dark items-center justify-center px-8 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent" />

                <div className="relative z-10 max-w-lg -mt-24">
                    <div className="mb-8">
                        <div className="w-16 h-16 bg-primary/20 rounded-lg flex items-center justify-center mb-6">
                            <svg
                                className="w-8 h-8 text-primary"
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
                        </div>
                        <h2 className="text-2xl font-bold text-text dark:text-text-dark mb-4">
                            {t('feature.title')}
                        </h2>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-8">
                            {t('feature.subtitle')}
                        </p>
                    </div>

                    <div className="space-y-4">
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
                                    {t('feature.benefits.ai.title')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('feature.benefits.ai.description')}
                                </p>
                            </div>
                        </div>

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
                                    {t('feature.benefits.templates.title')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('feature.benefits.templates.description')}
                                </p>
                            </div>
                        </div>

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
                                    {t('feature.benefits.management.title')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('feature.benefits.management.description')}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
