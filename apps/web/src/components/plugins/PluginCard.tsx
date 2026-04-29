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
    const isSelected = optimisticEnabled || plugin.systemPlugin;

    const visibleCaps = plugin.capabilities.filter(
        (cap) => cap !== plugin.category && !HIDDEN_CAPABILITIES.has(cap),
    );

    return (
        <>
            <div
                className={cn(
                    'rounded-lg border p-4',
                    'bg-surface dark:bg-surface-dark',
                    'border-border dark:border-border-dark',
                    'transition-all hover:shadow-md',
                    'flex flex-col h-full',
                    isSelected && 'ring-1 ring-primary/20 dark:bg-[#111]',
                )}
            >
                {/* Header: icon + meta */}
                <div className="flex items-center gap-3 mb-3">
                    <PluginIcon icon={plugin.icon} name={plugin.name} size={36} />
                    <div className="min-w-0">
                        <h3 className="font-medium text-sm leading-snug text-text dark:text-text-dark">
                            {plugin.name}
                        </h3>
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark mt-0.5">
                            v{plugin.version}
                            {plugin.systemPlugin && (
                                <span className="ml-1 text-primary">&middot; {t('system')}</span>
                            )}
                            {plugin.builtIn && !plugin.systemPlugin && (
                                <span className="ml-1">&middot; {t('builtIn')}</span>
                            )}
                        </p>
                    </div>
                </div>

                {/* Description */}
                {plugin.description && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark leading-relaxed line-clamp-2 mb-3">
                        {plugin.description}
                    </p>
                )}

                {/* Capability tags */}
                <div className="flex flex-wrap gap-1 mb-auto">
                    <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                        {getCategoryLabel(plugin.category)}
                    </span>
                    {visibleCaps.slice(0, 2).map((cap) => (
                        <span
                            key={cap}
                            className="text-[11px] px-1.5 py-0.5 rounded-md bg-surface-tertiary dark:bg-white/6 text-text-muted dark:text-text-muted-dark"
                        >
                            {getCapabilityLabel(cap)}
                        </span>
                    ))}
                    {visibleCaps.length > 2 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-surface-tertiary dark:bg-white/4 text-text-muted dark:text-text-muted-dark">
                            +{visibleCaps.length - 2}
                        </span>
                    )}
                </div>

                {/* Footer: settings + toggle */}
                <div className="flex items-center gap-2 pt-3 mt-3 border-t border-border dark:border-border-dark">
                    <Link
                        href={ROUTES.DASHBOARD_PLUGIN_DETAIL(plugin.pluginId)}
                        className="text-xs text-primary hover:text-primary-hover flex items-center gap-1"
                    >
                        <Settings className="w-3 h-3" />
                        {t('settings')}
                    </Link>

                    {plugin.homepage && (
                        <a
                            href={plugin.homepage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark flex items-center gap-1"
                        >
                            <ExternalLink className="w-3 h-3" />
                            {t('docs')}
                        </a>
                    )}

                    {!plugin.systemPlugin && (
                        <Button
                            variant={optimisticEnabled ? 'ghost' : 'primary'}
                            size="sm"
                            onClick={handleToggle}
                            disabled={isPending}
                            loading={isPending}
                            className={cn(
                                'ml-auto shrink-0 px-2.5 py-1 text-xs rounded-md gap-1',
                                optimisticEnabled &&
                                    'text-danger hover:text-danger hover:bg-danger/10',
                            )}
                        >
                            {optimisticEnabled ? (
                                <>
                                    <PowerOff className="w-3 h-3" />
                                    {t('disable')}
                                </>
                            ) : (
                                <>
                                    <Power className="w-3 h-3" />
                                    {t('enable')}
                                </>
                            )}
                        </Button>
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
