'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { connectGitHub } from '@/app/actions/dashboard/oauth';
import { disconnectGitHub } from '@/app/actions/settings';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { GitHubIcon } from '@/components/icons/GitHubIcon';

interface OAuthConnectionsProps {
    user: {
        id: string;
        email: string;
    };
    githubConnected: boolean;
    googleConnected: boolean;
    githubScopes: string[];
    googleScopes: string[];
}

export function OAuthConnections({ githubConnected, githubScopes }: OAuthConnectionsProps) {
    const [isPending, startTransition] = useTransition();

    const handleGitHubConnect = () => {
        startTransition(async () => {
            const result = await connectGitHub(ROUTES.DASHBOARD_SETTINGS);

            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect GitHub');
            }
        });
    };

    const handleGitHubDisconnect = () => {
        if (!confirm('Are you sure you want to disconnect your GitHub account?')) {
            return;
        }

        startTransition(async () => {
            const result = await disconnectGitHub();

            if (result.success) {
                toast.success('GitHub account disconnected');
            } else {
                toast.error(result.error || 'Failed to disconnect GitHub');
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    Connected Accounts
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Connect your external accounts for enhanced functionality
                </p>
            </div>

            {/* GitHub Connection */}
            <div className="p-4 rounded-lg border border-border dark:border-border-dark">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center">
                            <GitHubIcon className="w-6 h-6 dark:text-white text-black" />
                        </div>

                        <div>
                            <h3 className="font-medium text-text dark:text-text-dark">GitHub</h3>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {githubConnected
                                    ? 'Create and manage directories with GitHub repositories'
                                    : 'Connect to create directories from repositories'}
                            </p>
                            {githubConnected && githubScopes.length > 0 && (
                                <div className="mt-2">
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        Scopes: {githubScopes.join(', ')}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                    <div>
                        {githubConnected ? (
                            <Button
                                onClick={handleGitHubDisconnect}
                                variant="danger"
                                size="sm"
                                loading={isPending}
                            >
                                Disconnect
                            </Button>
                        ) : (
                            <Button
                                onClick={handleGitHubConnect}
                                variant="primary"
                                size="sm"
                                loading={isPending}
                            >
                                Connect
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
