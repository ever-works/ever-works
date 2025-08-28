'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { deleteAccount } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

interface DangerZoneProps {
    user: {
        id: string;
        email: string;
    };
}

export function DangerZone({ user }: DangerZoneProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [confirmEmail, setConfirmEmail] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const handleDeleteAccount = () => {
        if (confirmEmail !== user.email) {
            toast.error('Please enter your email correctly to confirm');
            return;
        }

        startTransition(async () => {
            try {
                const result = await deleteAccount();

                if (result.success) {
                    toast.success('Account deleted successfully');
                    router.push(ROUTES.AUTH_REGISTER);
                } else {
                    toast.error(result.error || 'Failed to delete account');
                }
            } catch (error) {
                toast.error('An unexpected error occurred');
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-danger mb-4">Danger Zone</h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Irreversible and destructive actions
                </p>
            </div>

            {/* Export Data */}
            <div className="p-4 rounded-lg border border-danger/20 bg-danger/5">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    Export Your Data
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Download all your directories, items, and settings
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
                    Export Data (Coming Soon)
                </button>
            </div>

            {/* Delete Account */}
            <div className="p-4 rounded-lg border border-danger/20 bg-danger/5">
                <h3 className="text-lg font-medium text-danger mb-2">Delete Account</h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Permanently delete your account and all associated data. This action cannot be
                    undone.
                </p>

                {!showDeleteConfirm ? (
                    <button
                        onClick={() => setShowDeleteConfirm(true)}
                        className={cn(
                            'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                            'bg-danger text-white hover:bg-danger/90',
                        )}
                    >
                        Delete My Account
                    </button>
                ) : (
                    <div className="space-y-4">
                        <div className="p-3 rounded bg-danger/10 border border-danger/30">
                            <p className="text-sm text-danger font-medium mb-2">
                                ⚠️ This will permanently delete:
                            </p>
                            <ul className="text-sm text-text-muted dark:text-text-muted-dark space-y-1 ml-5 list-disc">
                                <li>Your account and profile</li>
                                <li>All your directories</li>
                                <li>All directory items and data</li>
                                <li>API keys and integrations</li>
                                <li>All associated websites</li>
                            </ul>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                Type your email <span className="font-mono">{user.email}</span> to
                                confirm
                            </label>
                            <input
                                type="email"
                                value={confirmEmail}
                                onChange={(e) => setConfirmEmail(e.target.value)}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-danger',
                                    'text-text dark:text-text-dark',
                                    'focus:outline-none focus:ring-2 focus:ring-danger',
                                    'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                )}
                                placeholder="Enter your email"
                            />
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={handleDeleteAccount}
                                disabled={isPending || confirmEmail !== user.email}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-danger text-white',
                                    confirmEmail === user.email
                                        ? 'hover:bg-danger/90'
                                        : 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                {isPending ? 'Deleting...' : 'Yes, Delete My Account'}
                            </button>
                            <button
                                onClick={() => {
                                    setShowDeleteConfirm(false);
                                    setConfirmEmail('');
                                }}
                                disabled={isPending}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                                    'text-text dark:text-text-dark',
                                    'hover:bg-surface dark:hover:bg-surface-dark',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
