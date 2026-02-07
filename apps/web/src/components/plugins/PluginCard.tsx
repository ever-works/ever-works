'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Settings, Power, PowerOff, ExternalLink, AlertTriangle } from 'lucide-react';
import { enablePlugin, disablePlugin } from '@/app/actions/plugins';
import { PluginIcon } from './PluginIcon';
import { getCategoryLabel, getCapabilityLabel } from '@/lib/utils/plugin-category-icons';

interface PluginCardProps {
    plugin: UserPlugin;
}

export function PluginCard({ plugin }: PluginCardProps) {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [optimisticEnabled, setOptimisticEnabled] = useState(plugin.enabled);
    const [showDisableWarning, setShowDisableWarning] = useState(false);
    const [showEnablePanel, setShowEnablePanel] = useState(false);
    const [autoEnableForDirs, setAutoEnableForDirs] = useState(false);

    const supportsDirectoryScope =
        plugin.visibility !== 'user-only' && plugin.visibility !== 'hidden';

    const handleToggle = async () => {
        // Enable flow: show panel with auto-enable checkbox if plugin supports directory scope
        if (!optimisticEnabled) {
            if (supportsDirectoryScope && !showEnablePanel) {
                setShowEnablePanel(true);
                return;
            }
            setShowEnablePanel(false);
            setOptimisticEnabled(true);

            startTransition(async () => {
                try {
                    await enablePlugin(plugin.pluginId, {
                        autoEnableForDirectories: autoEnableForDirs,
                    });
                    router.refresh();
                } catch (error) {
                    setOptimisticEnabled(false);
                }
            });
            return;
        }

        // Disable flow: show cascade warning first
        if (!showDisableWarning) {
            setShowDisableWarning(true);
            return;
        }

        setShowDisableWarning(false);
        setOptimisticEnabled(false);

        startTransition(async () => {
            try {
                await disablePlugin(plugin.pluginId);
                router.refresh();
            } catch (error) {
                setOptimisticEnabled(true);
            }
        });
    };

    const handleCancelEnable = () => {
        setShowEnablePanel(false);
        setAutoEnableForDirs(false);
    };

    const handleCancelDisable = () => {
        setShowDisableWarning(false);
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
                            <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                {t('system')}
                            </span>
                        )}
                        {plugin.builtIn && !plugin.systemPlugin && (
                            <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
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
                    {getCategoryLabel(plugin.category)}
                </span>
                {plugin.capabilities
                    .filter((cap) => cap !== plugin.category)
                    .slice(0, 2)
                    .map((cap) => (
                        <span
                            key={cap}
                            className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark"
                        >
                            {getCapabilityLabel(cap)}
                        </span>
                    ))}
                {plugin.capabilities.filter((cap) => cap !== plugin.category).length > 2 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                        +{plugin.capabilities.filter((cap) => cap !== plugin.category).length - 2}
                    </span>
                )}
            </div>

            {showDisableWarning && (
                <div className="mt-3 p-3 rounded-lg bg-warning/10 border border-warning/30">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                        <div className="flex-1">
                            <p className="text-sm text-warning">{t('disableWarning')}</p>
                            <div className="flex gap-2 mt-2">
                                <Button size="sm" variant="ghost" onClick={handleCancelDisable}>
                                    {t('cancel')}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={handleToggle}
                                    disabled={isPending}
                                    loading={isPending}
                                    className="text-danger hover:text-danger hover:bg-danger/10"
                                >
                                    {t('confirmDisable')}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showEnablePanel && (
                <div className="mt-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                    <label className="flex items-start gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoEnableForDirs}
                            onChange={(e) => setAutoEnableForDirs(e.target.checked)}
                            className="mt-0.5 rounded border-border dark:border-border-dark"
                        />
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('autoEnableForDirectories')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                {t('autoEnableForDirectoriesDescription')}
                            </p>
                        </div>
                    </label>
                    <div className="flex gap-2 mt-2">
                        <Button size="sm" variant="ghost" onClick={handleCancelEnable}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={handleToggle}
                            disabled={isPending}
                            loading={isPending}
                        >
                            {t('enable')}
                        </Button>
                    </div>
                </div>
            )}

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
