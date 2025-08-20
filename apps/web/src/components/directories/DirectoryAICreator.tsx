'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createDirectoryWithAI } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';

interface DirectoryAICreatorProps {
    user: AuthUser;
}

export function DirectoryAICreator({ user }: DirectoryAICreatorProps) {
    const [prompt, setPrompt] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleGenerate = async () => {
        if (!prompt.trim()) {
            toast.error('Please describe what kind of directory you want to create');
            return;
        }

        startTransition(async () => {
            const result = await createDirectoryWithAI(prompt, directoryName || undefined);

            if (result.success) {
                toast.success(result.message || 'Directory creation started!');
                if (result.isGenerating) {
                    toast.info('AI is generating content. This may take a few minutes...');
                }
                router.push(ROUTES.DASHBOARD_DIRECTORIES);
            } else if (result.requiresGitHub) {
                toast.error('Please connect your GitHub account first');
                router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
            } else {
                toast.error(result.error || 'Failed to create directory');
            }
        });
    };

    const examplePrompts = [
        'Create a directory of the best AI tools for developers',
        'Build a curated list of open-source React components',
        'Generate a directory of productivity apps for remote teams',
        'Make a collection of sustainable fashion brands',
    ];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                    Create Directory with AI
                </h1>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    Describe your directory idea and let AI handle the setup and initial content
                    generation
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
                    {/* Directory Name (Optional) */}
                    <div>
                        <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                            Directory Name (Optional)
                        </label>
                        <input
                            type="text"
                            value={directoryName}
                            onChange={(e) => setDirectoryName(e.target.value)}
                            placeholder="e.g., Awesome AI Tools"
                            className={cn(
                                'w-full px-4 py-2 rounded-lg',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder-text-muted dark:placeholder-text-muted-dark',
                                'focus:outline-none focus:border-primary',
                            )}
                        />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                            AI will suggest a name if you leave this empty
                        </p>
                    </div>

                    {/* AI Prompt */}
                    <div>
                        <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                            Describe Your Directory *
                        </label>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="Describe what kind of directory you want to create, what items it should contain, and any specific requirements..."
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
                            Need inspiration? Try one of these:
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
                            What AI will do for you:
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
                                <span>Generate an appropriate name and description</span>
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
                                <span>Create initial categories and structure</span>
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
                                <span>Find and add relevant items automatically</span>
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
                                <span>Set up GitHub repository with proper documentation</span>
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
                                    Generating Directory...
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
                                    Generate with AI
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
                            Cancel
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
                    <strong>Note:</strong> AI generation typically takes 2-5 minutes depending on
                    the complexity of your request. You'll be notified when your directory is ready.
                </p>
            </div>
        </div>
    );
}
