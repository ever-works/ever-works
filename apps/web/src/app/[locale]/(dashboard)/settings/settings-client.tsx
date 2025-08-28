'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ProfileSettings } from '@/components/settings/ProfileSettings';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { ApiTokenSettings } from '@/components/settings/ApiTokenSettings';
import { OAuthConnections } from '@/components/settings/OAuthConnections';
import { NotificationSettings } from '@/components/settings/NotificationSettings';
import { DangerZone } from '@/components/settings/DangerZone';

interface SettingsClientProps {
    user: {
        id: string;
        username: string;
        email: string;
    };
    githubConnected: boolean;
    githubScopes: string[];
}

const tabs = [
    { id: 'profile', label: 'Profile', icon: '👤' },
    { id: 'security', label: 'Security', icon: '🔒' },
    { id: 'api-tokens', label: 'API & Tokens', icon: '🔑' },
    { id: 'oauth', label: 'Connected Accounts', icon: '🔗' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'danger', label: 'Danger Zone', icon: '⚠️' },
];

export function SettingsClient({
    user,
    githubConnected,
    githubScopes,
}: SettingsClientProps) {
    const [activeTab, setActiveTab] = useState('profile');

    return (
        <div className="max-w-7xl mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">Settings</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">
                    Manage your account settings and preferences
                </p>
            </div>

            <div className="flex flex-col lg:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="lg:w-64">
                    <nav className="space-y-1">
                        {tabs.map((tab) => (
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
                                <span className="text-xl">{tab.icon}</span>
                                <span>{tab.label}</span>
                            </button>
                        ))}
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