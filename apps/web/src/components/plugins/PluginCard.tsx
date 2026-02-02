'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Settings, Power, PowerOff, ExternalLink } from 'lucide-react';
import { enablePlugin, disablePlugin } from '@/app/actions/plugins';
import { PluginIcon } from './PluginIcon';

interface PluginCardProps {
    plugin: UserPlugin;
}

export function PluginCard({ plugin }: PluginCardProps) {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [optimisticEnabled, setOptimisticEnabled] = useState(plugin.enabled);

    const handleToggle = async () => {
        const newState = !optimisticEnabled;
        setOptimisticEnabled(newState);

        startTransition(async () => {
            try {
                if (newState) {
                    await enablePlugin(plugin.pluginId);
                } else {
                    await disablePlugin(plugin.pluginId);
                }
                router.refresh();
            } catch (error) {
                // Revert on error
                setOptimisticEnabled(!newState);
            }
        });
    };

    const categoryLabels: Record<string, string> = {
        git: t('categories.git'),
        deployment: t('categories.deployment'),
        screenshot: t('categories.screenshot'),
        search: t('categories.search'),
        content: t('categories.content'),
        'data-source': t('categories.dataSource'),
        ai: t('categories.ai'),
        pipeline: t('categories.pipeline'),
    };

    return (
        <div
            className={cn(
                'bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-4',
                'transition-all hover:shadow-md',
                optimisticEnabled && 'ring-2 ring-primary/20',
            )}
        >
            <div className="flex items-start gap-3">
                <PluginIcon icon={plugin.icon} name={plugin.name} size={40} />

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text dark:text-text-dark truncate">
                            {plugin.name}
                        </h3>
                        {plugin.systemPlugin && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                {t('system')}
                            </span>
                        )}
                        {plugin.builtIn && !plugin.systemPlugin && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                                {t('builtIn')}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-0.5">
                        v{plugin.version}
                    </p>
                </div>

                {!plugin.systemPlugin && (
                    <Button
                        variant={optimisticEnabled ? 'ghost' : 'primary'}
                        size="sm"
                        onClick={handleToggle}
                        disabled={isPending}
                        loading={isPending}
                        className={cn(
                            optimisticEnabled && 'text-danger hover:text-danger hover:bg-danger/10',
                        )}
                    >
                        {optimisticEnabled ? (
                            <>
                                <PowerOff className="w-4 h-4" />
                                <span className="sr-only md:not-sr-only md:ml-1">
                                    {t('disable')}
                                </span>
                            </>
                        ) : (
                            <>
                                <Power className="w-4 h-4" />
                                <span className="sr-only md:not-sr-only md:ml-1">
                                    {t('enable')}
                                </span>
                            </>
                        )}
                    </Button>
                )}
            </div>

            {plugin.description && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-3 line-clamp-2">
                    {plugin.description}
                </p>
            )}

            <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                    {categoryLabels[plugin.category] || plugin.category}
                </span>
                {plugin.capabilities.slice(0, 2).map((cap) => (
                    <span
                        key={cap}
                        className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark"
                    >
                        {cap}
                    </span>
                ))}
                {plugin.capabilities.length > 2 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                        +{plugin.capabilities.length - 2}
                    </span>
                )}
            </div>

            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border dark:border-border-dark">
                <Link
                    href={ROUTES.DASHBOARD_PLUGIN_DETAIL(plugin.pluginId)}
                    className="text-sm text-primary hover:text-primary-hover flex items-center gap-1"
                >
                    <Settings className="w-4 h-4" />
                    {t('settings')}
                </Link>

                {plugin.homepage && (
                    <a
                        href={plugin.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark flex items-center gap-1 ml-auto"
                    >
                        <ExternalLink className="w-4 h-4" />
                        {t('docs')}
                    </a>
                )}
            </div>
        </div>
    );
}
