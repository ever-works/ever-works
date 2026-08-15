'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Mic, Shuffle } from 'lucide-react';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { setGlobalVoiceDefault } from '@/app/actions/plugins';
import type { UserPlugin, VoiceProvider } from '@/lib/api/plugins';

/**
 * Which provider transcribes voice dictation, chosen once for the account.
 *
 * This used to be a dropdown in the chat composer, sitting a few pixels from
 * the chat PROVIDER chip — two identical-looking brand chips meaning entirely
 * different things, so picking "Mistral" for dictation read as "Mistral is
 * answering my questions". Swapping speech vendors is a rare decision, so it
 * belongs here with the other set-once provider settings, and the composer is
 * left with one unambiguous mic.
 *
 * Only providers that actually implement `transcribe()` are offered: speech-
 * to-text is optional on the AI-provider interface, so most AI plugins cannot
 * do it and listing them would promise something the mic then fails to deliver.
 */

interface VoiceProviderDefaultSelectorProps {
    /** Voice-capable plugins for this account (empty renders the empty state). */
    voiceProviders: VoiceProvider[];
    /** The account's saved pick, or `null` for automatic selection. */
    selectedDefault: string | null;
    /** Category plugins, used only to borrow each provider's brand mark. */
    plugins: UserPlugin[];
}

export function VoiceProviderDefaultSelector({
    voiceProviders,
    selectedDefault,
    plugins,
}: VoiceProviderDefaultSelectorProps) {
    const t = useTranslations('dashboard.settings.plugins.voiceDefault');
    const [isPending, startTransition] = useTransition();
    const [selectedId, setSelectedId] = useState<string | null>(selectedDefault);

    const iconFor = (providerId: string) => plugins.find((p) => p.pluginId === providerId)?.icon;

    const handleSelect = (pluginId: string | null) => {
        if (pluginId === selectedId) return;
        const previous = selectedId;
        setSelectedId(pluginId);
        startTransition(async () => {
            const result = await setGlobalVoiceDefault(pluginId);
            if (!result.success) {
                setSelectedId(previous);
                toast.error(result.error ?? t('saveFailed'));
            }
        });
    };

    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark/30 overflow-hidden">
            <div className="px-5 py-4 border-b border-border dark:border-border-dark">
                <div className="flex items-center gap-2">
                    <Mic
                        className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark"
                        aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                    {t('description')}
                </p>
            </div>

            {voiceProviders.length === 0 ? (
                // Not an error — a deployment can legitimately run only AI
                // providers that have no speech-to-text route. Say so plainly
                // instead of showing an empty radio group.
                <p className="px-5 py-4 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('noProviders')}
                </p>
            ) : (
                <div className="p-4 space-y-2">
                    <label
                        className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                            selectedId === null
                                ? 'border-primary/60 dark:border-white/15 bg-primary/5 dark:bg-white/4'
                                : 'border-transparent hover:bg-surface dark:hover:bg-surface-dark'
                        }`}
                    >
                        <input
                            type="radio"
                            name="voice-default"
                            checked={selectedId === null}
                            onChange={() => handleSelect(null)}
                            disabled={isPending}
                            className="accent-primary"
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                            <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center shrink-0">
                                <Shuffle
                                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                    aria-hidden="true"
                                />
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

                    {voiceProviders.map((provider) => (
                        <label
                            key={provider.id}
                            className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                                selectedId === provider.id
                                    ? 'border-primary/60 dark:border-white/15 bg-primary/5 dark:bg-white/4'
                                    : 'border-transparent hover:bg-surface dark:hover:bg-surface-dark'
                            }`}
                        >
                            <input
                                type="radio"
                                name="voice-default"
                                checked={selectedId === provider.id}
                                onChange={() => handleSelect(provider.id)}
                                disabled={isPending}
                                className="accent-primary"
                            />
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                <PluginIcon
                                    icon={iconFor(provider.id)}
                                    name={provider.name}
                                    size={32}
                                    className="rounded-lg shrink-0"
                                />
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {provider.name}
                                    </p>
                                    {/* Only meaningful while nothing is pinned —
                                        once the user picks explicitly, "this is
                                        what Auto would resolve to" is noise. */}
                                    {selectedId === null && provider.isActive && (
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('currentlyActive')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}
