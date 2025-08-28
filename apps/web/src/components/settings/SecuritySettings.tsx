'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updatePassword } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

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
    const t = useTranslations('dashboard.settings.security');

    const handleUpdatePassword = () => {
        // Validation
        if (!currentPassword || !newPassword || !confirmPassword) {
            toast.error(t('changePassword.messages.fillAllFields'));
            return;
        }

        if (newPassword.length < 8) {
            toast.error(t('changePassword.messages.minLength'));
            return;
        }

        if (newPassword !== confirmPassword) {
            toast.error(t('changePassword.messages.mismatch'));
            return;
        }

        if (currentPassword === newPassword) {
            toast.error(t('changePassword.messages.sameAsCurrent'));
            return;
        }

        startTransition(async () => {
            try {
                const result = await updatePassword({
                    currentPassword,
                    newPassword,
                });

                if (result.success) {
                    toast.success(t('changePassword.messages.success'));
                    // Clear form
                    setCurrentPassword('');
                    setNewPassword('');
                    setConfirmPassword('');
                } else {
                    toast.error(result.error || t('changePassword.messages.error'));
                }
            } catch (error) {
                toast.error(t('changePassword.messages.unexpectedError'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    {t('subtitle')}
                </p>
            </div>

            {/* Password Change Section */}
            <div className="space-y-4">
                <h3 className="text-lg font-medium text-text dark:text-text-dark">
                    {t('changePassword.title')}
                </h3>

                <Input
                    label={t('changePassword.currentPassword')}
                    type={showPasswords ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder={t('changePassword.placeholders.current')}
                />

                <Input
                    label={t('changePassword.newPassword')}
                    type={showPasswords ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('changePassword.placeholders.new')}
                />

                <Input
                    label={t('changePassword.confirmPassword')}
                    type={showPasswords ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('changePassword.placeholders.confirm')}
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
                        {t('changePassword.showPasswords')}
                    </label>
                </div>

                <div className="flex justify-end">
                    <Button
                        onClick={handleUpdatePassword}
                        loading={isPending}
                    >
                        {t('changePassword.actions.update')}
                    </Button>
                </div>
            </div>

            {/* Two-Factor Authentication */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('twoFactor.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('twoFactor.subtitle')}
                </p>
                <Button
                    variant="secondary"
                    disabled
                >
                    {t('twoFactor.action')}
                </Button>
            </div>

            {/* Active Sessions */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('sessions.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('sessions.subtitle')}
                </p>
                <Button
                    variant="secondary"
                    disabled
                >
                    {t('sessions.action')}
                </Button>
            </div>
        </div>
    );
}