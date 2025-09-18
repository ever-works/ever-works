'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createDirectoryWithAI } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

interface DirectoryAICreatorProps {
    user: AuthUser;
}

export function DirectoryAICreator({ user }: DirectoryAICreatorProps) {
    const [prompt, setPrompt] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.ai');

    const handleGenerate = async () => {
        if (!prompt.trim()) {
            toast.error(t('errors.promptRequired'));
            return;
        }

        startTransition(async () => {
            const result = await createDirectoryWithAI(prompt, directoryName);

            if (result.success) {
                toast.success(result.message || t('success.started'));
                if (result.isGenerating) {
                    toast.info(t('success.generating'));
                }

                if (result.directory) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directory.id));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitHub) {
                toast.error('Please connect your GitHub account first');
                router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
            } else {
                toast.error(result.error || 'Failed to create directory');
            }
        });
    };

    const examplePrompts = [
        t('examplePrompts.0'),
        t('examplePrompts.1'),
        t('examplePrompts.2'),
        t('examplePrompts.3'),
    ];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                    {t('formTitle')}
                </h1>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {t('formSubtitle')}
                </p>
            </div>

            <div
                className={cn(
                    'p-6 rounded-lg',
                    'bg-card dark:bg-card-dark',
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                <div className="space-y-6">
                    {/* Directory Name */}
                    <div>
                        <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                            {t('directoryNameLabel')}
                        </label>
                        <input
                            type="text"
                            value={directoryName}
                            onChange={(e) => setDirectoryName(e.target.value)}
                            placeholder={t('directoryNamePlaceholder')}
                            className={cn(
                                'w-full px-4 py-2 rounded-lg',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder-text-muted dark:placeholder-text-muted-dark',
                                'focus:outline-none focus:border-primary',
                            )}
                        />
                        {/* <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                            {t('directoryNameHelp')}
                        </p> */}
                    </div>

                    {/* AI Prompt */}
                    <div>
                        <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                            {t('promptLabel')}
                        </label>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder={t('promptPlaceholder')}
                            rows={6}
                            className={cn(
                                'w-full px-4 py-3 rounded-lg resize-none',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder-text-muted dark:placeholder-text-muted-dark',
                                'focus:outline-none focus:border-primary',
                            )}
                        />
                    </div>

                    {/* Example Prompts */}
                    <div>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-3">
                            {t('inspirationText')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {examplePrompts.map((example, index) => (
                                <button
                                    key={index}
                                    onClick={() => setPrompt(example)}
                                    className={cn(
                                        'px-3 py-1.5 rounded-full text-sm',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text-secondary dark:text-text-secondary-dark',
                                        'hover:border-primary hover:text-primary',
                                        'transition-colors',
                                    )}
                                >
                                    {example}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* AI Features Info */}
                    <div className={cn('p-4 rounded-lg', 'bg-primary/5 border border-primary/20')}>
                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-2">
                            {t('featuresTitle')}
                        </h4>
                        <ul className="space-y-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                            <li className="flex items-start gap-2">
                                <svg
                                    className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
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
                                <span>{t('features.0')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <svg
                                    className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
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
                                <span>{t('features.1')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <svg
                                    className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
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
                                <span>{t('features.2')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <svg
                                    className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
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
                                <span>{t('features.3')}</span>
                            </li>
                        </ul>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3">
                        <button
                            onClick={handleGenerate}
                            disabled={isPending || !prompt.trim()}
                            className={cn(
                                'flex-1 py-3 rounded-lg font-medium transition-colors',
                                'bg-primary hover:bg-primary-hover text-white',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'flex items-center justify-center gap-2',
                            )}
                        >
                            {isPending ? (
                                <>
                                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    {t('generatingButton')}
                                </>
                            ) : (
                                <>
                                    <svg
                                        className="w-5 h-5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                                        />
                                    </svg>
                                    {t('generateButton')}
                                </>
                            )}
                        </button>
                        <button
                            onClick={() => router.back()}
                            disabled={isPending}
                            className={cn(
                                'px-6 py-3 rounded-lg font-medium transition-colors',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {t('cancelButton')}
                        </button>
                    </div>
                </div>
            </div>

            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    <strong>{t('noteTitle')}</strong> {t('noteText')}
                </p>
            </div>
        </div>
    );
}
