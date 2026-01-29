'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getStepProgress, getStepText } from '@/lib/utils/generator-steps';

interface GenerationProgressProps {
    directory: Directory;
}

export function GenerationProgress({ directory }: GenerationProgressProps) {
    const t = useTranslations('dashboard.directoryDetail.progress');
    const [dots, setDots] = useState('');

    useEffect(() => {
        const interval = setInterval(() => {
            setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
        }, 500);

        return () => clearInterval(interval);
    }, []);

    // Get current step and progress (supports both dynamic and legacy)
    const generateStatus = directory.generateStatus;
    const progressPercentage = getStepProgress(generateStatus);
    const stepText = getStepText(generateStatus, t('steps.processing'));

    return (
        <div className="max-w-2xl mx-auto py-12">
            <div
                className={cn(
                    'rounded-lg border',
                    'bg-card dark:bg-card-dark',
                    'border-card-border dark:border-card-border-dark',
                    'overflow-hidden',
                )}
            >
                {/* Header Section */}
                <div className="p-8 pb-6 text-center">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 dark:bg-primary/20 mb-4">
                        <svg
                            className="animate-spin h-8 w-8 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                        >
                            <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                            />
                            <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                        </svg>
                    </div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                        {dots}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {stepText}
                    </p>
                </div>

                {/* Progress Section */}
                <div className="px-8 pb-8">
                    {/* Progress Bar Container */}
                    <div className="mb-6">
                        <div className="flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark mb-2">
                            <span className="font-medium">{t('progress')}</span>
                            <span className="font-medium">{progressPercentage}%</span>
                        </div>
                        <div className="relative">
                            <div className="w-full h-2 bg-surface-tertiary dark:bg-surface-tertiary-dark rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
                                    style={{ width: `${progressPercentage}%` }}
                                >
                                    <div className="h-full bg-gradient-to-r from-primary via-primary to-primary/80 animate-gradient" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Info Note */}
                    <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg p-4">
                        <div className="flex items-start gap-3">
                            <svg
                                className="w-5 h-5 text-text-muted dark:text-text-muted-dark mt-0.5 shrink-0"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                            </svg>
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {t('closeNote')}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
