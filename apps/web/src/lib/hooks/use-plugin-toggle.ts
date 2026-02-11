'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enablePlugin, disablePlugin } from '@/app/actions/plugins';

interface UsePluginToggleOptions {
    pluginId: string;
    enabled: boolean;
    visibility: string;
}

export function usePluginToggle({ pluginId, enabled, visibility }: UsePluginToggleOptions) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [optimisticEnabled, setOptimisticEnabled] = useState(enabled);
    const [showDisableWarning, setShowDisableWarning] = useState(false);
    const [showEnablePanel, setShowEnablePanel] = useState(false);
    const [autoEnableForDirs, setAutoEnableForDirs] = useState(false);

    const supportsDirectoryScope = visibility !== 'user-only' && visibility !== 'hidden';

    const handleToggle = () => {
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
                    const result = await enablePlugin(pluginId, {
                        autoEnableForDirectories: autoEnableForDirs,
                    });
                    if (result.success) {
                        router.refresh();
                    } else {
                        throw new Error(result.error);
                    }
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
                const result = await disablePlugin(pluginId);
                if (result.success) {
                    router.refresh();
                } else {
                    throw new Error(result.error);
                }
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
