'use client';

import { useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { connectGitHub } from '@/app/actions/dashboard';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';

export function GitHubConnectCard() {
    const [isPending, startTransition] = useTransition();

    const handleConnect = async () => {
        startTransition(async () => {
            const result = await connectGitHub(ROUTES.DASHBOARD_DIRECTORIES_NEW);
            
            if (result.success && result.url) {
                // Store a flag to check on return
                sessionStorage.setItem('github_connect_redirect', window.location.pathname);
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect GitHub');
            }
        });
    };

    return (
        <div className={cn(
            "max-w-2xl mx-auto",
            "bg-card dark:bg-card-dark",
            "border border-card-border dark:border-card-border-dark",
            "rounded-lg p-8"
        )}>
            <div className="text-center">
                <div className={cn(
                    "w-20 h-20 mx-auto mb-6 rounded-full",
                    "bg-surface dark:bg-surface-dark",
                    "flex items-center justify-center"
                )}>
                    <svg className="w-10 h-10 text-text dark:text-text-dark" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                </div>

                <h2 className="text-2xl font-bold text-text dark:text-text-dark mb-3">
                    Connect Your GitHub Account
                </h2>
                
                <p className="text-text-secondary dark:text-text-secondary-dark mb-8 max-w-md mx-auto">
                    To create and manage directories, we need access to your GitHub account. 
                    Your directories will be stored as GitHub repositories.
                </p>

                <div className="space-y-4 mb-8">
                    <div className="flex items-start gap-3 text-left max-w-md mx-auto">
                        <div className="w-5 h-5 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <svg className="w-3 h-3 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <div>
                            <p className="text-sm text-text dark:text-text-dark font-medium">Repository Management</p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">Create and manage repositories for your directories</p>
                        </div>
                    </div>

                    <div className="flex items-start gap-3 text-left max-w-md mx-auto">
                        <div className="w-5 h-5 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <svg className="w-3 h-3 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <div>
                            <p className="text-sm text-text dark:text-text-dark font-medium">Version Control</p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">Track changes and collaborate with others</p>
                        </div>
                    </div>

                    <div className="flex items-start gap-3 text-left max-w-md mx-auto">
                        <div className="w-5 h-5 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <svg className="w-3 h-3 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <div>
                            <p className="text-sm text-text dark:text-text-dark font-medium">Secure Storage</p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">Your data is securely stored in your GitHub account</p>
                        </div>
                    </div>
                </div>

                <button
                    onClick={handleConnect}
                    disabled={isPending}
                    className={cn(
                        "px-6 py-3 rounded-lg font-medium transition-all",
                        "bg-black dark:bg-white",
                        "text-white dark:text-black",
                        "hover:bg-gray-800 dark:hover:bg-gray-200",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "flex items-center gap-3 mx-auto"
                    )}
                >
                    {isPending ? (
                        <>
                            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Connecting...
                        </>
                    ) : (
                        <>
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                            </svg>
                            Connect with GitHub
                        </>
                    )}
                </button>

                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-4">
                    We only request necessary permissions. You can disconnect at any time.
                </p>
            </div>
        </div>
    );
}