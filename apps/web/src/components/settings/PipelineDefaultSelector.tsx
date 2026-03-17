'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { UserPlugin } from '@/lib/api/plugins';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { setGlobalPipelineDefault } from '@/app/actions/plugins';
import { toast } from 'sonner';
import { Shuffle, Lock } from 'lucide-react';

interface PipelineDefaultSelectorProps {
    plugins: UserPlugin[];
}

export function PipelineDefaultSelector({ plugins }: PipelineDefaultSelectorProps) {
    const t = useTranslations('dashboard.settings.plugins.pipelineDefault');
    const [isPending, startTransition] = useTransition();

    // Determine current state from plugin metadata
    const currentDefault = plugins.find((p) => p.metadata?.isGlobalPipelineDefault === true);
    const currentEnforce = currentDefault?.metadata?.globalPipelineDefaultEnforce === true;

    const [selectedId, setSelectedId] = useState<string | null>(currentDefault?.pluginId ?? null);
    const [enforce, setEnforce] = useState<boolean>(currentEnforce);

    const handleSelect = (pluginId: string | null) => {
        const newEnforce = pluginId === null ? false : enforce;
        setSelectedId(pluginId);
        if (pluginId === null) setEnforce(false);
        save(pluginId, newEnforce);
    };

    const handleEnforceToggle = (value: boolean) => {
        setEnforce(value);
        save(selectedId, value);
    };

    const save = (pluginId: string | null, enforceValue: boolean) => {
        startTransition(async () => {
            const result = await setGlobalPipelineDefault(pluginId, enforceValue);
            if (!result.success) {
                toast.error(result.error ?? t('saveFailed'));
            }
        });
    };

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark/30 overflow-hidden">
            <div className="px-5 py-4 border-b border-border dark:border-border-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                    {t('description')}
                </p>
            </div>

            <div className="p-4 space-y-2">
                {/* Auto option */}
                <label
                    className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                        selectedId === null
                            ? 'border-primary bg-primary/5 dark:bg-primary/10'
                            : 'border-transparent hover:bg-surface dark:hover:bg-surface-dark'
                    }`}
                >
                    <input
                        type="radio"
                        name="pipeline-default"
                        checked={selectedId === null}
                        onChange={() => handleSelect(null)}
                        disabled={isPending}
                        className="accent-primary"
                    />
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center shrink-0">
                            <Shuffle className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('autoLabel')}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('autoDescription')}
                            </p>
                        </div>
                    </div>
                </label>

                {/* Pipeline options */}
                {plugins.map((plugin) => (
                    <label
                        key={plugin.pluginId}
                        className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                            selectedId === plugin.pluginId
                                ? 'border-primary bg-primary/5 dark:bg-primary/10'
                                : 'border-transparent hover:bg-surface dark:hover:bg-surface-dark'
                        }`}
                    >
                        <input
                            type="radio"
                            name="pipeline-default"
                            checked={selectedId === plugin.pluginId}
                            onChange={() => handleSelect(plugin.pluginId)}
                            disabled={isPending}
                            className="accent-primary"
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                            <PluginIcon
                                icon={plugin.icon}
                                name={plugin.name}
                                size={32}
                                className="rounded-lg shrink-0"
                            />
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {plugin.name}
                                </p>
                                {plugin.description && (
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark line-clamp-1">
                                        {plugin.description}
                                    </p>
                                )}
                            </div>
                        </div>
                    </label>
                ))}
            </div>

            {/* Enforce toggle — only shown when a pipeline is selected */}
            {selectedId !== null && (
                <div className="px-5 py-4 border-t border-border dark:border-border-dark bg-surface/50 dark:bg-surface-dark/30">
                    <label className="flex items-start gap-3 cursor-pointer">
                        <div className="relative mt-0.5">
                            <input
                                type="checkbox"
                                checked={enforce}
                                onChange={(e) => handleEnforceToggle(e.target.checked)}
                                disabled={isPending}
                                className="peer sr-only"
                            />
                            <div className="w-9 h-5 bg-border dark:bg-border-dark rounded-full peer-checked:bg-primary transition-colors" />
                            <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                        </div>
                        <div>
                            <div className="flex items-center gap-1.5">
                                <Lock className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {t('enforceLabel')}
                                </p>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                {t('enforceDescription')}
                            </p>
                        </div>
                    </label>
                </div>
            )}
        </div>
    );
}
