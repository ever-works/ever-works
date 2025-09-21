'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

interface GenerationProgressProps {
    directory: Directory;
}

export function GenerationProgress({ directory }: GenerationProgressProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.progress');
    const [dots, setDots] = useState('');

    useEffect(() => {
        const interval = setInterval(() => {
            setDots(prev => prev.length >= 3 ? '' : prev + '.');
        }, 500);
        return () => clearInterval(interval);
    }, []);

    // Auto-refresh page every 5 seconds to check status
    useEffect(() => {
        const interval = setInterval(() => {
            router.refresh();
        }, 5000);
        return () => clearInterval(interval);
    }, [router]);

    const steps = [
        { id: 'init', label: t('steps.init') },
        { id: 'fetch', label: t('steps.fetch') },
        { id: 'process', label: t('steps.process') },
        { id: 'generate', label: t('steps.generate') },
        { id: 'save', label: t('steps.save') },
        { id: 'complete', label: t('steps.complete') },
    ];

    const currentStepIndex = steps.findIndex(s =>
        directory.generateStatus?.step?.toLowerCase().includes(s.id)
    );

    return (
        <div className="max-w-3xl mx-auto py-8">
            <div className={cn(
                'rounded-lg border p-8',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}>
                <div className="text-center mb-8">
                    <div className="w-20 h-20 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mx-auto mb-4">
                        <svg className="animate-spin h-10 w-10 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-text dark:text-text-dark mb-2">
                        {t('title')}{dots}
                    </h2>
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {directory.generateStatus?.step || t('processingRequest')}
                    </p>
                </div>

                {/* Progress Steps */}
                <div className="space-y-3 mb-8">
                    {steps.map((step, index) => {
                        const isActive = index === currentStepIndex;
                        const isComplete = currentStepIndex > index;

                        return (
                            <div key={step.id} className="flex items-center gap-3">
                                <div className={cn(
                                    'w-8 h-8 rounded-full flex items-center justify-center',
                                    isComplete && 'bg-green-100 dark:bg-green-900',
                                    isActive && 'bg-blue-100 dark:bg-blue-900',
                                    !isComplete && !isActive && 'bg-gray-100 dark:bg-gray-800',
                                )}>
                                    {isComplete ? (
                                        <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                    ) : isActive ? (
                                        <div className="w-2 h-2 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" />
                                    ) : (
                                        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full" />
                                    )}
                                </div>
                                <span className={cn(
                                    'text-sm font-medium',
                                    isComplete && 'text-green-600 dark:text-green-400',
                                    isActive && 'text-blue-600 dark:text-blue-400',
                                    !isComplete && !isActive && 'text-gray-400 dark:text-gray-600',
                                )}>
                                    {step.label}
                                </span>
                            </div>
                        );
                    })}
                </div>

                {/* Progress Bar */}
                <div className="mb-6">
                    <div className="flex items-center justify-between text-sm text-text-muted dark:text-text-muted-dark mb-2">
                        <span>{t('progress')}</span>
                        <span>{Math.round((currentStepIndex + 1) / steps.length * 100)}%</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                            className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                            style={{ width: `${((currentStepIndex + 1) / steps.length) * 100}%` }}
                        />
                    </div>
                </div>

                <div className="text-center">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('closeNote')}
                    </p>
                </div>
            </div>
        </div>
    );
}