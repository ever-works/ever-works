'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { enablePlugin, disablePlugin } from '@/app/actions/plugins';

interface UsePluginToggleOptions {
    pluginId: string;
    enabled: boolean;
    visibility: string;
}

export function usePluginToggle({ pluginId, enabled, visibility }: UsePluginToggleOptions) {
    const router = useRouter();
    const t = useTranslations('dashboard.plugins');
    const [isPending, startTransition] = useTransition();
    const [optimisticEnabled, setOptimisticEnabled] = useState(enabled);
    const [showDisableWarning, setShowDisableWarning] = useState(false);
    const [showEnablePanel, setShowEnablePanel] = useState(false);
    const [autoEnableForDirs, setAutoEnableForDirs] = useState(true);

    const supportsWorkScope = visibility !== 'user-only' && visibility !== 'hidden';

    const handleToggle = () => {
        // Enable flow: show panel with auto-enable checkbox if plugin supports work scope
        if (!optimisticEnabled) {
            if (supportsWorkScope && !showEnablePanel) {
                setShowEnablePanel(true);
                return;
            }
            setShowEnablePanel(false);
            setOptimisticEnabled(true);

            startTransition(async () => {
                try {
                    const result = await enablePlugin(pluginId, {
                        autoEnableForWorks: autoEnableForDirs,
                    });
                    if (result.success) {
                        router.refresh();
                    } else {
                        throw new Error(result.error);
                    }
                } catch (error) {
                    // A failed enable used to roll the switch back with NO message —
                    // to the user, indistinguishable from the switch never moving.
                    setOptimisticEnabled(false);
                    toast.error(
                        error instanceof Error && error.message ? error.message : t('enableFailed'),
                    );
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
                const result = await disablePlugin(pluginId);
                if (result.success) {
                    router.refresh();
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                // Same silent rollback on the disable path.
                setOptimisticEnabled(true);
                toast.error(
                    error instanceof Error && error.message ? error.message : t('disableFailed'),
                );
            }
        });
    };

    const handleCancelEnable = () => {
        setShowEnablePanel(false);
        // Cancelling is declining THIS enable, not unsetting the default for
        // every future one: this used to set false and nothing ever reset it,
        // so one dismissed dialog silently flipped every later enable to
        // works-disabled for the rest of the session. Restore the default.
        setAutoEnableForDirs(true);
    };

    const handleCancelDisable = () => {
        setShowDisableWarning(false);
    };

    return {
        isPending,
        optimisticEnabled,
        showDisableWarning,
        showEnablePanel,
        autoEnableForDirs,
        setAutoEnableForDirs,
        handleToggle,
        handleCancelEnable,
        handleCancelDisable,
    };
}
