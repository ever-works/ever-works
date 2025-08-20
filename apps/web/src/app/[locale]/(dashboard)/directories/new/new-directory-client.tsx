'use client';

import { useState } from 'react';
import { AuthUser } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { DirectoryAICreator } from '@/components/directories/DirectoryAICreator';
import { DirectoryManualForm } from '@/components/directories/DirectoryManualForm';
import { GitHubConnectionAlert } from './github-connection-alert';
import { GitHubStatusSidebar } from './github-status-sidebar';

interface NewDirectoryClientProps {
    user: AuthUser;
    githubConnected: boolean;
}

export default function NewDirectoryClient({
    user,
    githubConnected: initialGithubConnected,
}: NewDirectoryClientProps) {
    const [creationMode, setCreationMode] = useState<'ai' | 'manual' | null>(null);
    const [githubConnected] = useState(initialGithubConnected);
    const router = useRouter();

    if (creationMode === null) {
        return (
            <div className="max-w-5xl mx-auto px-4 py-8">
                {/* GitHub Connection Alert */}
                <GitHubConnectionAlert githubConnected={githubConnected} />

                <div className="mb-8">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors mb-4"
                    >
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
                                d="M10 19l-7-7m0 0l7-7m-7 7h18"
                            />
                        </svg>
                        Back
                    </button>
                    <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                        Create New Directory
                    </h1>
                    <p className="text-text-secondary dark:text-text-secondary-dark mt-2">
                        Choose how you'd like to create your directory
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                    {/* AI Creation Card */}
                    <button
                        onClick={() => setCreationMode('ai')}
                        className={cn(
                            'p-6 rounded-lg border-2 text-left transition-all',
                            'bg-card dark:bg-card-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg',
                            'group',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-primary/10 group-hover:bg-primary/20 transition-colors',
                                )}
                            >
                                <svg
                                    className="w-6 h-6 text-primary"
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
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            Create with AI
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            Describe your directory idea in natural language and let AI handle the
                            setup
                        </p>
                        <div className="flex items-center gap-2 text-primary font-medium">
                            <span>Get started</span>
                            <svg
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 5l7 7-7 7"
                                />
                            </svg>
                        </div>
                    </button>

                    {/* Manual Creation Card */}
                    <button
                        onClick={() => setCreationMode('manual')}
                        className={cn(
                            'p-6 rounded-lg border-2 text-left transition-all',
                            'bg-card dark:bg-card-dark',
                            'border-card-border dark:border-card-border-dark',
                            'hover:border-primary hover:shadow-lg',
                            'group',
                        )}
                    >
                        <div className="mb-4">
                            <div
                                className={cn(
                                    'w-12 h-12 rounded-lg flex items-center justify-center',
                                    'bg-success/10 group-hover:bg-success/20 transition-colors',
                                )}
                            >
                                <svg
                                    className="w-6 h-6 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                    />
                                </svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                            Create Manually
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            Configure your directory with full control over every setting and option
                        </p>
                        <div className="flex items-center gap-2 text-success font-medium">
                            <span>Configure now</span>
                            <svg
                                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 5l7 7-7 7"
                                />
                            </svg>
                        </div>
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-6 max-w-7xl mx-auto px-4 py-8">
            {/* Main Content */}
            <div className="flex-1">
                <div className="mb-8">
                    <button
                        onClick={() => setCreationMode(null)}
                        className="flex items-center gap-2 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors mb-4"
                    >
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
                                d="M10 19l-7-7m0 0l7-7m-7 7h18"
                            />
                        </svg>
                        Back to options
                    </button>
                </div>

                {creationMode === 'ai' ? (
                    <DirectoryAICreator user={user} />
                ) : (
                    <DirectoryManualForm user={user} />
                )}
            </div>

            {/* GitHub Status Sidebar */}
            <GitHubStatusSidebar user={user} githubConnected={githubConnected} />
        </div>
    );
}
