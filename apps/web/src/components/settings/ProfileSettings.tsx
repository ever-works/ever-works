'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updateProfile, resendVerificationEmail } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';

interface ProfileSettingsProps {
    user: {
        id: string;
        username: string;
        email: string;
        emailVerified?: boolean;
    };
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [isResending, startResendTransition] = useTransition();
    const [username, setUsername] = useState(user.username);
    const t = useTranslations('dashboard.settings.profile');

    const handleResendVerification = () => {
        startResendTransition(async () => {
            try {
                const result = await resendVerificationEmail();
                if (result.success) {
                    toast.success(t('emailVerification.sent'));
                } else {
                    toast.error(result.error || t('emailVerification.sendFailed'));
                }
            } catch (error) {
                toast.error(t('emailVerification.sendFailed'));
            }
        });
    };

    const handleSaveProfile = () => {
        if (!username.trim()) {
            toast.error(t('messages.usernameRequired'));
            return;
        }

        startTransition(async () => {
            try {
                const result = await updateProfile({
                    username: username.trim(),
                });

                if (result.success) {
                    toast.success(t('messages.success'));
                } else {
                    toast.error(result.error || t('messages.error'));
                }
            } catch (error) {
                toast.error(t('messages.unexpectedError'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {!user.emailVerified && (
                <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
                    <Mail className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('emailVerification.title')}
                        </p>
                        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                            {t('emailVerification.description')}
                        </p>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleResendVerification}
                        loading={isResending}
                    >
                        {t('emailVerification.resend')}
                    </Button>
                </div>
            )}

            <div className="space-y-4">
                {/* Username Field */}
                <Input
                    label={t('fields.name')}
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('placeholders.name')}
                />

                {/* Email Field (Read-only) */}
                <Input
                    label={t('fields.email')}
                    type="email"
                    value={user.email}
                    disabled
                    helperText={t('fields.emailHelperText')}
                />

                {/* Save Button */}
                <div className="flex justify-end">
                    <Button onClick={handleSaveProfile} loading={isPending}>
                        {t('actions.save')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
