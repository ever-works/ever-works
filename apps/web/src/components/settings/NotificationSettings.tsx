'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { updateNotificationPreferences } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface NotificationSettingsProps {
    user: {
        id: string;
        email: string;
    };
}

export function NotificationSettings({ user }: NotificationSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const t = useTranslations('dashboard.notifications');

    // Email notifications
    const [emailUpdates, setEmailUpdates] = useState(true);
    const [emailNewItems, setEmailNewItems] = useState(false);
    const [emailWeeklyDigest, setEmailWeeklyDigest] = useState(true);
    const [emailMarketing, setEmailMarketing] = useState(false);

    // In-app notifications
    const [appNewItems, setAppNewItems] = useState(true);
    const [appComments, setAppComments] = useState(true);
    const [appMentions, setAppMentions] = useState(true);
    const [appSystemUpdates, setAppSystemUpdates] = useState(true);

    const handleSavePreferences = () => {
        startTransition(async () => {
            try {
                const result = await updateNotificationPreferences({
                    email: {
                        updates: emailUpdates,
                        newItems: emailNewItems,
                        weeklyDigest: emailWeeklyDigest,
                        marketing: emailMarketing,
                    },
                    app: {
                        newItems: appNewItems,
                        comments: appComments,
                        mentions: appMentions,
                        systemUpdates: appSystemUpdates,
                    },
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

            {/* Email Notifications */}
            <div className="space-y-4">
                <h3 className="text-lg font-medium text-text dark:text-text-dark">
                    {t('email.title')}
                </h3>

                <div className="space-y-3">
                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('email.directoryUpdates.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('email.directoryUpdates.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={emailUpdates}
                            onChange={(e) => setEmailUpdates(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('email.newItems.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('email.newItems.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={emailNewItems}
                            onChange={(e) => setEmailNewItems(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('email.weeklyDigest.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('email.weeklyDigest.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={emailWeeklyDigest}
                            onChange={(e) => setEmailWeeklyDigest(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('email.marketing.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('email.marketing.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={emailMarketing}
                            onChange={(e) => setEmailMarketing(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>
                </div>
            </div>

            {/* In-App Notifications */}
            <div className="space-y-4 pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark">
                    {t('app.title')}
                </h3>

                <div className="space-y-3">
                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('app.newItems.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('app.newItems.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={appNewItems}
                            onChange={(e) => setAppNewItems(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('app.comments.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('app.comments.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={appComments}
                            onChange={(e) => setAppComments(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('app.mentions.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('app.mentions.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={appMentions}
                            onChange={(e) => setAppMentions(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>

                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('app.systemUpdates.label')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('app.systemUpdates.description')}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            checked={appSystemUpdates}
                            onChange={(e) => setAppSystemUpdates(e.target.checked)}
                            className="w-4 h-4"
                        />
                    </label>
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-6">
                <button
                    onClick={handleSavePreferences}
                    disabled={isPending}
                    className={cn(
                        'px-6 py-2 rounded-lg font-medium transition-colors',
                        'bg-primary dark:bg-primary-dark text-white',
                        'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    {isPending ? t('actions.saving') : t('actions.save')}
                </button>
            </div>
        </div>
    );
}
