'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updatePassword } from '@/app/actions/settings';
import { toast } from 'sonner';

interface SecuritySettingsProps {
    user: {
        id: string;
        email: string;
    };
}

export function SecuritySettings({ user }: SecuritySettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPasswords, setShowPasswords] = useState(false);

    const handleUpdatePassword = () => {
        // Validation
        if (!currentPassword || !newPassword || !confirmPassword) {
            toast.error('Please fill in all password fields');
            return;
        }

        if (newPassword.length < 8) {
            toast.error('New password must be at least 8 characters');
            return;
        }

        if (newPassword !== confirmPassword) {
            toast.error('New passwords do not match');
            return;
        }

        if (currentPassword === newPassword) {
            toast.error('New password must be different from current password');
            return;
        }

        startTransition(async () => {
            try {
                const result = await updatePassword({
                    currentPassword,
                    newPassword,
                });

                if (result.success) {
                    toast.success('Password updated successfully');
                    // Clear form
                    setCurrentPassword('');
                    setNewPassword('');
                    setConfirmPassword('');
                } else {
                    toast.error(result.error || 'Failed to update password');
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
                    Security Settings
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Manage your account security and authentication
                </p>
            </div>

            {/* Password Change Section */}
            <div className="space-y-4">
                <h3 className="text-lg font-medium text-text dark:text-text-dark">
                    Change Password
                </h3>

                <Input
                    label="Current Password"
                    type={showPasswords ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                />

                <Input
                    label="New Password"
                    type={showPasswords ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password (min 8 characters)"
                />

                <Input
                    label="Confirm New Password"
                    type={showPasswords ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                />

                <div className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        id="show-passwords"
                        checked={showPasswords}
                        onChange={(e) => setShowPasswords(e.target.checked)}
                        className="w-4 h-4"
                    />
                    <label
                        htmlFor="show-passwords"
                        className="text-sm text-text-muted dark:text-text-muted-dark"
                    >
                        Show passwords
                    </label>
                </div>

                <div className="flex justify-end">
                    <Button
                        onClick={handleUpdatePassword}
                        loading={isPending}
                    >
                        Update Password
                    </Button>
                </div>
            </div>

            {/* Two-Factor Authentication */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    Two-Factor Authentication
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Add an extra layer of security to your account
                </p>
                <Button
                    variant="secondary"
                    disabled
                >
                    Coming Soon
                </Button>
            </div>

            {/* Active Sessions */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    Active Sessions
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    Manage your active sessions across devices
                </p>
                <Button
                    variant="secondary"
                    disabled
                >
                    View Sessions (Coming Soon)
                </Button>
            </div>
        </div>
    );
}