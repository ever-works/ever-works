'use client';

import { useTranslations } from 'next-intl';
import { UserPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Settings, Power, PowerOff, ExternalLink } from 'lucide-react';
import { PluginIcon } from './PluginIcon';
import { PluginEnablePanel } from './PluginEnablePanel';
import { PluginDisableWarning } from './PluginDisableWarning';
import {
    getCategoryLabel,
    getCapabilityLabel,
    HIDDEN_CAPABILITIES,
} from '@/lib/utils/plugin-category-icons';
import { usePluginToggle } from '@/lib/hooks/use-plugin-toggle';

interface PluginCardProps {
    plugin: UserPlugin;
}

export function PluginCard({ plugin }: PluginCardProps) {
    const t = useTranslations('dashboard.plugins');

    const {
        isPending,
        optimisticEnabled,
        showDisableWarning,
        showEnablePanel,
        autoEnableForDirs,
        setAutoEnableForDirs,
        handleToggle,
        handleCancelEnable,
        handleCancelDisable,
    } = usePluginToggle({
        pluginId: plugin.pluginId,
        enabled: plugin.enabled,
        visibility: plugin.visibility,
    });

    return (
        <>
            <div
                className={cn(
                    'bg-surface dark:bg-surface-dark rounded-lg border border-border dark:border-border-dark p-4',
                    'transition-all hover:shadow-md',
                    'flex flex-col h-full',
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
                                optimisticEnabled &&
                                    'text-danger hover:text-danger hover:bg-danger/10',
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

                <div className="flex flex-wrap gap-1.5 my-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                        {getCategoryLabel(plugin.category)}
                    </span>
                    {(() => {
                        const visible = plugin.capabilities.filter(
                            (cap) => cap !== plugin.category && !HIDDEN_CAPABILITIES.has(cap),
                        );
                        return (
                            <>
                                {visible.slice(0, 2).map((cap) => (
                                    <span
                                        key={cap}
                                        className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark"
                                    >
                                        {getCapabilityLabel(cap)}
                                    </span>
                                ))}
                                {visible.length > 2 && (
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                                        +{visible.length - 2}
                                    </span>
                                )}
                            </>
                        );
                    })()}
                </div>

                <div className="flex items-center gap-2 mt-auto pt-3 border-t border-border dark:border-border-dark">
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

            <PluginDisableWarning
                open={showDisableWarning}
                onCancel={handleCancelDisable}
                onConfirm={handleToggle}
                isPending={isPending}
            />

            <PluginEnablePanel
                open={showEnablePanel}
                autoEnableForDirs={autoEnableForDirs}
                onAutoEnableChange={setAutoEnableForDirs}
                onCancel={handleCancelEnable}
                onConfirm={handleToggle}
                isPending={isPending}
            />
        </>
    );
}
