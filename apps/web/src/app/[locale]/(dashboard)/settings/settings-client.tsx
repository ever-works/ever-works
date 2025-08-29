'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ProfileSettings } from '@/components/settings/ProfileSettings';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { ApiTokenSettings } from '@/components/settings/ApiTokenSettings';
import { OAuthConnections } from '@/components/settings/OAuthConnections';
import { NotificationSettings } from '@/components/settings/NotificationSettings';
import { DangerZone } from '@/components/settings/DangerZone';
import { User, Lock, Key, Link2, Bell, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface SettingsClientProps {
    user: {
        id: string;
        username: string;
        email: string;
    };
    githubConnected: boolean;
    githubScopes: string[];
}


export function SettingsClient({
    user,
    githubConnected,
    githubScopes,
}: SettingsClientProps) {
    const [activeTab, setActiveTab] = useState('profile');
    const t = useTranslations('dashboard.settings');

    const tabs = [
        { id: 'profile', label: t('tabs.profile'), icon: User },
        { id: 'security', label: t('tabs.security'), icon: Lock },
        { id: 'api-tokens', label: t('tabs.apiTokens'), icon: Key },
        { id: 'oauth', label: t('tabs.oauth'), icon: Link2 },
        { id: 'notifications', label: t('tabs.notifications'), icon: Bell },
        { id: 'danger', label: t('tabs.dangerZone'), icon: AlertTriangle },
    ];

    return (
        <div className="max-w-7xl mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">
                    {t('subtitle')}
                </p>
            </div>

            <div className="flex flex-col lg:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="lg:w-64">
                    <nav className="space-y-1">
                        {tabs.map((tab) => {
                            const Icon = tab.icon;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={cn(
                                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
                                        activeTab === tab.id
                                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                                            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                                    )}
                                >
                                    <Icon className="w-5 h-5" />
                                    <span>{tab.label}</span>
                                </button>
                            );
                        })}
                    </nav>
                </div>

                {/* Content Area */}
                <div className="flex-1 bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark">
                    <div className="p-6">
                        {activeTab === 'profile' && <ProfileSettings user={user} />}
                        {activeTab === 'security' && <SecuritySettings user={user} />}
                        {activeTab === 'api-tokens' && <ApiTokenSettings user={user} />}
                        {activeTab === 'oauth' && (
                            <OAuthConnections
                                user={user}
                                githubConnected={githubConnected}
                                googleConnected={false}
                                githubScopes={githubScopes}
                                googleScopes={[]}
                            />
                        )}
                        {activeTab === 'notifications' && <NotificationSettings user={user} />}
                        {activeTab === 'danger' && <DangerZone user={user} />}
                    </div>
                </div>
            </div>
        </div>
    );
}