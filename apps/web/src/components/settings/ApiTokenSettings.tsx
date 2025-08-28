'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { updateVercelToken, removeVercelToken } from '@/app/actions/settings';
import { toast } from 'sonner';

interface ApiTokenSettingsProps {
    user: {
        id: string;
        email: string;
    };
}

export function ApiTokenSettings({ user }: ApiTokenSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [vercelToken, setVercelToken] = useState('');
    const [hasVercelToken, setHasVercelToken] = useState(false);
    const [showToken, setShowToken] = useState(false);

    const handleSaveVercelToken = () => {
        if (!vercelToken.trim()) {
            toast.error('Please enter a valid Vercel token');
            return;
        }

        startTransition(async () => {
            try {
                const result = await updateVercelToken(vercelToken.trim());

                if (result.success) {
                    toast.success('Vercel token saved successfully');
                    setHasVercelToken(true);
                    setVercelToken('');
                    setShowToken(false);
                } else {
                    toast.error(result.error || 'Failed to save Vercel token');
                }
            } catch (error) {
                toast.error('An unexpected error occurred');
            }
        });
    };

    const handleRemoveVercelToken = () => {
        startTransition(async () => {
            try {
                const result = await removeVercelToken();

                if (result.success) {
                    toast.success('Vercel token removed successfully');
                    setHasVercelToken(false);
                } else {
                    toast.error(result.error || 'Failed to remove Vercel token');
                }
            } catch (error) {
                toast.error('An unexpected error occurred');
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    API & Tokens
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Manage your API keys and third-party integrations
                </p>
            </div>

            {/* Vercel Integration */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-text dark:text-text-dark">
                            Vercel Integration
                        </h3>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            Connect your Vercel account to deploy directories as websites
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                'px-2 py-1 rounded text-xs font-medium',
                                hasVercelToken
                                    ? 'bg-success/10 text-success'
                                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {hasVercelToken ? 'Connected' : 'Not Connected'}
                        </span>
                    </div>
                </div>

                {hasVercelToken ? (
                    <div className="p-4 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                        <p className="text-sm text-text dark:text-text-dark mb-3">
                            Your Vercel account is connected. You can now deploy directories to Vercel.
                        </p>
                        <button
                            onClick={handleRemoveVercelToken}
                            disabled={isPending}
                            className={cn(
                                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                'bg-danger/10 text-danger hover:bg-danger/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {isPending ? 'Removing...' : 'Disconnect Vercel'}
                        </button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                Vercel API Token
                            </label>
                            <div className="relative">
                                <input
                                    type={showToken ? 'text' : 'password'}
                                    value={vercelToken}
                                    onChange={(e) => setVercelToken(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-2 pr-24 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text dark:text-text-dark',
                                        'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                        'font-mono',
                                    )}
                                    placeholder="vc_..."
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowToken(!showToken)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    {showToken ? 'Hide' : 'Show'}
                                </button>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2">
                                You can get your API token from{' '}
                                <a
                                    href="https://vercel.com/account/tokens"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary dark:text-primary-dark hover:underline"
                                >
                                    Vercel Dashboard
                                </a>
                            </p>
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={handleSaveVercelToken}
                                disabled={isPending || !vercelToken}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-primary dark:bg-primary-dark text-white',
                                    'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {isPending ? 'Saving...' : 'Save Token'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* API Keys Section */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    API Keys
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Generate and manage API keys for programmatic access
                </p>
                <button
                    disabled
                    className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text-muted dark:text-text-muted-dark',
                        'cursor-not-allowed opacity-50',
                    )}
                >
                    Generate API Key (Coming Soon)
                </button>
            </div>

            {/* Webhooks */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    Webhooks
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Configure webhooks to receive real-time updates
                </p>
                <button
                    disabled
                    className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text-muted dark:text-text-muted-dark',
                        'cursor-not-allowed opacity-50',
                    )}
                >
                    Configure Webhooks (Coming Soon)
                </button>
            </div>
        </div>
    );
}