'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updateProfile } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface ProfileSettingsProps {
    user: {
        id: string;
        username: string;
        email: string;
    };
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [username, setUsername] = useState(user.username);
    const t = useTranslations('dashboard.settings.profile');

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

            <div className="space-y-4">
                {/* Username Field */}
                <Input
                    label={t('fields.username')}
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('placeholders.username')}
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
