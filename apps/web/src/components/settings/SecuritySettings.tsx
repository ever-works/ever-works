'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updatePassword } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';

interface SecuritySettingsProps {
    user: {
        id: string;
        username: string;
        email: string;
    };
}

export function SecuritySettings({ user }: SecuritySettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPasswords, setShowPasswords] = useState(false);
    const t = useTranslations('dashboard.settings.security');

    const handleUpdatePassword = () => {
        // Validate all fields are filled
        if (!currentPassword || !newPassword || !confirmPassword) {
            toast.error(t('changePassword.messages.fillAllFields'));
            return;
        }

        // Validate min length
        if (newPassword.length < 8) {
            toast.error(t('changePassword.messages.minLength'));
            return;
        }

        // Validate passwords match
        if (newPassword !== confirmPassword) {
            toast.error(t('changePassword.messages.mismatch'));
            return;
        }

        // Validate new password is different from current
        if (newPassword === currentPassword) {
            toast.error(t('changePassword.messages.sameAsCurrent'));
            return;
        }

        startTransition(() => {
            void (async () => {
                try {
                    const result = await updatePassword({
                        currentPassword,
                        newPassword,
                    });

                    if (result.success) {
                        toast.success(t('changePassword.messages.success'));
                        // Clear the form
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                    } else {
                        toast.error(result.error || t('changePassword.messages.error'));
                    }
                } catch (error) {
                    toast.error(t('changePassword.messages.unexpectedError'));
                }
            })();
        });
    };

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* Change Password Section */}
            <div className="space-y-4">
                <div className="flex items-center gap-2">
                    <Lock className="w-5 h-5 text-text-muted dark:text-text-muted-dark" />
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">
                        {t('changePassword.title')}
                    </h3>
                </div>

                <div className="space-y-4 pl-7">
                    {/* Current Password */}
                    <div className="relative">
                        <Input
                            label={t('changePassword.currentPassword')}
                            type={showPasswords ? 'text' : 'password'}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder={t('changePassword.placeholders.current')}
                        />
                    </div>

                    {/* New Password */}
                    <div className="relative">
                        <Input
                            label={t('changePassword.newPassword')}
                            type={showPasswords ? 'text' : 'password'}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder={t('changePassword.placeholders.new')}
                        />
                    </div>

                    {/* Confirm Password */}
                    <div className="relative">
                        <Input
                            label={t('changePassword.confirmPassword')}
                            type={showPasswords ? 'text' : 'password'}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder={t('changePassword.placeholders.confirm')}
                        />
                    </div>

                    {/* Show Passwords Toggle */}
                    <label className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark cursor-pointer">
                        <input
                            type="checkbox"
                            checked={showPasswords}
                            onChange={(e) => setShowPasswords(e.target.checked)}
                            className="rounded border-border dark:border-border-dark"
                        />
                        {t('changePassword.showPasswords')}
                    </label>

                    {/* Update Button */}
                    <div className="flex justify-end">
                        <Button
                            onClick={handleUpdatePassword}
                            loading={isPending}
                            className="text-sm"
                        >
                            {t('changePassword.actions.update')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
