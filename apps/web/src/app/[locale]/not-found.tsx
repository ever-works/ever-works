'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export default function NotFound() {
    const t = useTranslations('errors.notFound');
    const router = useRouter();

    // Ensure dark mode is applied — the layout's inline script may not
    // run on not-found render paths in some Next.js scenarios.
    useEffect(() => {
        const theme = localStorage.getItem('theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (theme === 'dark' || (!theme && prefersDark)) {
            document.documentElement.classList.add('dark');
        }
    }, []);

    return (
        <div className="flex min-h-screen items-center justify-center bg-background dark:bg-background-dark px-4">
            <div className="text-center max-w-lg animate-fade-in">
                {/* Decorative 404 */}
                <div className="relative mb-8">
                    <p className="text-[10rem] leading-none font-bold text-border dark:text-border-dark select-none">
                        404
                    </p>
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
                            <svg
                                className="w-10 h-10 text-primary"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                                />
                            </svg>
                        </div>
                    </div>
                </div>

                <h1 className="text-2xl font-semibold text-text dark:text-text-dark mb-3">
                    {t('title')}
                </h1>
                <p className="text-text-muted dark:text-text-muted-dark mb-8 leading-relaxed">
                    {t('description')}
                </p>
                <div className="flex items-center justify-center gap-3">
                    <Link
                        href={ROUTES.DASHBOARD}
                        className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg font-medium transition-colors bg-primary text-white hover:bg-primary-hover"
                    >
                        {t('backHome')}
                    </Link>
                    <button
                        onClick={() => router.back()}
                        className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg font-medium transition-colors border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                    >
                        {t('goBack')}
                    </button>
                </div>
            </div>
        </div>
    );
}
