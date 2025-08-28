'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { updateNotificationPreferences } from '@/app/actions/settings';
import { toast } from 'sonner';

interface NotificationSettingsProps {
    user: {
        id: string;
        email: string;
    };
}

export function NotificationSettings({ user }: NotificationSettingsProps) {
    const [isPending, startTransition] = useTransition();
    
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
                    toast.success('Notification preferences updated');
                } else {
                    toast.error(result.error || 'Failed to update preferences');
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
                    Notification Preferences
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Choose how you want to be notified about important updates
                </p>
            </div>

            {/* Email Notifications */}
            <div className="space-y-4">
                <h3 className="text-lg font-medium text-text dark:text-text-dark">
                    Email Notifications
                </h3>
                
                <div className="space-y-3">
                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                Directory Updates
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Get notified about important updates to your directories
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
                                New Items
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Get notified when new items are added to your directories
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
                                Weekly Digest
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Receive a weekly summary of your directory activity
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
                                Marketing & Promotions
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Receive updates about new features and offers
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
                    In-App Notifications
                </h3>
                
                <div className="space-y-3">
                    <label className="flex items-center justify-between cursor-pointer">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                New Items
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Show notifications for new directory items
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
                                Comments
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Get notified about comments on your directories
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
                                Mentions
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Get notified when someone mentions you
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
                                System Updates
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Important system notifications and maintenance alerts
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
                    {isPending ? 'Saving...' : 'Save Preferences'}
                </button>
            </div>
        </div>
    );
}