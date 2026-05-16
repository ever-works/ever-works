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
        committerName?: string | null;
        committerEmail?: string | null;
        /** EW-602: per-user opt-out for budget alert emails. Defaults to true server-side. */
        emailBudgetAlerts?: boolean;
    };
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [isResending, startResendTransition] = useTransition();
    const [username, setUsername] = useState(user.username);
    const [committerName, setCommitterName] = useState(user.committerName || '');
    const [committerEmail, setCommitterEmail] = useState(user.committerEmail || '');
    const [emailBudgetAlerts, setEmailBudgetAlerts] = useState(user.emailBudgetAlerts ?? true);
    const t = useTranslations('dashboard.settings.profile');

    const handleResendVerification = () => {
        startResendTransition(() => {
            void (async () => {
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
            })();
        });
    };

    const handleSaveProfile = () => {
        if (!username.trim()) {
            toast.error(t('messages.usernameRequired'));
            return;
        }

        startTransition(() => {
            void (async () => {
                try {
                    const result = await updateProfile({
                        username: username.trim(),
                        committerName: committerName.trim() || null,
                        committerEmail: committerEmail.trim() || null,
                        emailBudgetAlerts,
                    });

                    if (result.success) {
                        toast.success(t('messages.success'));
                    } else {
                        toast.error(result.error || t('messages.error'));
                    }
                } catch (error) {
                    toast.error(t('messages.unexpectedError'));
                }
            })();
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

                {/* Git Committer Fields */}
                <div className="border-t border-border dark:border-border-dark pt-4">
                    <p className="text-sm font-medium text-text dark:text-text-dark mb-1">
                        {t('committer.title')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                        {t('committer.description', {
                            defaultName: user.username,
                            defaultEmail: user.email,
                        })}
                    </p>
                    <div className="space-y-3">
                        <Input
                            label={t('committer.nameLabel')}
                            type="text"
                            value={committerName}
                            onChange={(e) => setCommitterName(e.target.value)}
                            placeholder={user.username}
                        />
                        <Input
                            label={t('committer.emailLabel')}
                            type="email"
                            value={committerEmail}
                            onChange={(e) => setCommitterEmail(e.target.value)}
                            placeholder={user.email}
                        />
                    </div>
                </div>

                {/* EW-602: per-user opt-out for budget alert emails */}
                <div className="border-t border-border dark:border-border-dark pt-4">
                    <p className="text-sm font-medium text-text dark:text-text-dark mb-1">
                        {t('budgetAlerts.title')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                        {t('budgetAlerts.description')}
                    </p>
                    <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark cursor-pointer">
                        <input
                            type="checkbox"
                            checked={emailBudgetAlerts}
                            onChange={(e) => setEmailBudgetAlerts(e.target.checked)}
                        />
                        {t('budgetAlerts.toggleLabel')}
                    </label>
                </div>

                {/* Save Button */}
                <div className="flex justify-end">
                    <Button onClick={handleSaveProfile} loading={isPending} className="text-sm">
                        {t('actions.save')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
