'use client';

import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { User, Lock, Key, Link2, Bell, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const t = useTranslations('dashboard.settings');

    const baseSettingsPath = pathname.split('/')[1];

    const tabs = [
        { id: 'profile', label: t('tabs.profile'), icon: User, href: `/${baseSettingsPath}` },
        {
            id: 'security',
            label: t('tabs.security'),
            icon: Lock,
            href: `/${baseSettingsPath}/security`,
        },
        {
            id: 'api-tokens',
            label: t('tabs.apiTokens'),
            icon: Key,
            href: `/${baseSettingsPath}/api-tokens`,
        },
        { id: 'oauth', label: t('tabs.oauth'), icon: Link2, href: `/${baseSettingsPath}/oauth` },
        {
            id: 'notifications',
            label: t('tabs.notifications'),
            icon: Bell,
            href: `/${baseSettingsPath}/notifications`,
        },
        {
            id: 'danger',
            label: t('tabs.dangerZone'),
            icon: AlertTriangle,
            href: `/${baseSettingsPath}/danger`,
        },
    ];

    const isActive = (href: string) => {
        if (href === baseSettingsPath) {
            return pathname === baseSettingsPath;
        }
        return pathname === href;
    };

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">{t('subtitle')}</p>
            </div>

            <div className="flex flex-col lg:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="lg:w-64">
                    <nav className="space-y-1">
                        {tabs.map((tab) => {
                            const Icon = tab.icon;
                            return (
                                <Link
                                    key={tab.id}
                                    href={tab.href}
                                    className={cn(
                                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
                                        isActive(tab.href)
                                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                                            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                                    )}
                                >
                                    <Icon className="w-5 h-5" />
                                    <span>{tab.label}</span>
                                </Link>
                            );
                        })}
                    </nav>
                </div>

                {/* Content Area */}
                <div className="flex-1 bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark">
                    <div className="p-6">{children}</div>
                </div>
            </div>
        </div>
    );
}
