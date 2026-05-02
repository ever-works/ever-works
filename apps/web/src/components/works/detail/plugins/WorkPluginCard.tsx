'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { WorkPlugin } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Power, PowerOff, Settings, Shield } from 'lucide-react';
import { enableWorkPlugin, disableWorkPlugin } from '@/app/actions/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import {
    getCategoryLabel,
    getCapabilityLabel,
    HIDDEN_CAPABILITIES,
} from '@/lib/utils/plugin-category-icons';
import { WorkPluginSettingsModal } from './WorkPluginSettingsModal';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface WorkPluginCardProps {
    workId: string;
    plugin: WorkPlugin;
}

export function WorkPluginCard({ workId, plugin }: WorkPluginCardProps) {
    const t = useTranslations('dashboard.workPlugins');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showModal, setShowModal] = useState(false);
    const [toggleError, setToggleError] = useState<string | null>(null);

    const canEnable = plugin.installed && plugin.enabled;
    const isEnabled = plugin.workEnabled;

    const hasWorkSettings = useMemo(() => {
        if (!plugin.settingsSchema?.properties) return false;
        return Object.values(plugin.settingsSchema.properties).some((prop) => {
            if (prop.hidden) return false;
            const scope = prop.scope || 'global';
            return scope === 'global' || scope === 'work';
        });
    }, [plugin.settingsSchema]);

    const isClickable = isEnabled && hasWorkSettings;

    const handleToggle = async () => {
        if (!canEnable && !isEnabled) return;

        setToggleError(null);
        startTransition(async () => {
            try {
                const result = isEnabled
                    ? await disableWorkPlugin(workId, plugin.pluginId)
                    : await enableWorkPlugin(workId, plugin.pluginId);

                if (result.success) {
                    router.refresh();
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : t('toggleError');
                setToggleError(message);
            }
        });
    };

    const handleCardClick = () => {
        if (isClickable) setShowModal(true);
    };

    const visibleCaps = plugin.capabilities.filter(
        (cap) => cap !== plugin.category && !HIDDEN_CAPABILITIES.has(cap),
    );

    return (
        <>
            <div
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                onClick={handleCardClick}
                onKeyDown={
                    isClickable
                        ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setShowModal(true);
                              }
                          }
                        : undefined
                }
                className={cn(
                    'rounded-lg border p-4',
                    'bg-surface dark:bg-surface-dark',
                    'border-card-border dark:border-border-secondary-dark',
                    'transition-all flex flex-col h-full',
                    isEnabled && 'ring-1 ring-primary/20',
                    !canEnable && !isEnabled && 'opacity-60',
                    isClickable && 'cursor-pointer hover:border-primary/40',
                )}
            >
                {/* Header */}
                <div className="flex items-center gap-3 mb-3">
                    <PluginIcon icon={plugin.icon} name={plugin.name} size={36} />
                    <div className="min-w-0">
                        <h3 className="font-medium text-sm leading-snug text-text dark:text-text-dark">
                            {plugin.name}
                        </h3>
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark mt-0.5">
                            v{plugin.version}
                            {isEnabled && (
                                <span className="ml-1 text-success">&middot; {t('active')}</span>
                            )}
                        </p>
                    </div>
                </div>

                {/* Warnings */}
                {!canEnable && !isEnabled && !plugin.systemPlugin && (
                    <p className="text-xs text-warning mb-2">
                        {plugin.installed ? t('disabledByUser') : t('enableAtUserLevelFirst')}
                    </p>
                )}

                {toggleError && (
                    <div className="text-xs text-danger mb-2">
                        <p>{toggleError}</p>
                        {toggleError.includes('User-level required settings') && (
                            <Link
                                href={ROUTES.DASHBOARD_PLUGIN_DETAIL(plugin.pluginId)}
                                className="text-primary hover:text-primary-hover underline"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {t('goToPluginSettings')}
                            </Link>
                        )}
                    </div>
                )}

                {/* Description */}
                {plugin.description && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark leading-relaxed line-clamp-2 mb-3">
                        {plugin.description}
                    </p>
                )}

                {/* Tags */}
                <div className="flex flex-wrap gap-1 mb-auto">
                    <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                        {getCategoryLabel(plugin.category)}
                    </span>
                    {visibleCaps.slice(0, 2).map((cap) => (
                        <span
                            key={cap}
                            className={cn(
                                'text-[11px] px-1.5 py-0.5 rounded-md',
                                plugin.activeCapabilities?.includes(cap)
                                    ? 'bg-primary/15 text-primary'
                                    : 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {getCapabilityLabel(cap)}
                            {plugin.activeCapabilities?.includes(cap) && ' \u2713'}
                        </span>
                    ))}
                    {visibleCaps.length > 2 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-surface-tertiary dark:bg-surface-tertiary-dark text-text-muted dark:text-text-muted-dark">
                            +{visibleCaps.length - 2}
                        </span>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center gap-2 pt-3 mt-3 border-t border-border dark:border-border-dark">
                    {isClickable && (
                        <span className="text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1">
                            <Settings className="w-3 h-3" />
                            {t('clickToConfigure')}
                        </span>
                    )}

                    {plugin.systemPlugin ? (
                        <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary flex items-center gap-1">
                            <Shield className="w-3 h-3" />
                            {t('system')}
                        </span>
                    ) : (
                        <Button
                            variant={isEnabled ? 'ghost' : 'primary'}
                            size="sm"
                            onClick={(e) => {
                                e.stopPropagation();
                                handleToggle();
                            }}
                            disabled={isPending || (!canEnable && !isEnabled)}
                            loading={isPending}
                            className={cn(
                                'ml-auto shrink-0 px-2.5 py-1 text-xs rounded-md gap-1',
                                isEnabled && 'text-danger hover:text-danger hover:bg-danger/10',
                            )}
                            title={
                                !canEnable && !isEnabled
                                    ? t('enableAtUserLevelFirst')
                                    : isEnabled
                                      ? t('disableForWork')
                                      : t('enableForWork')
                            }
                        >
                            {isEnabled ? (
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

            {isClickable && (
                <WorkPluginSettingsModal
                    open={showModal}
                    onOpenChange={setShowModal}
                    workId={workId}
                    plugin={plugin}
                />
            )}
        </>
    );
}
