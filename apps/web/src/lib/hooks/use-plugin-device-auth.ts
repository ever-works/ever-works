'use client';

import { useCallback, useEffect, useState } from 'react';
import { getPluginDeviceAuthStatus, startPluginDeviceAuth } from '@/app/actions/plugins';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

interface UsePluginDeviceAuthOptions {
    pluginId: string;
    initialStatus?: PluginDeviceAuthStatus | null;
    loadErrorMessage: string;
    startErrorMessage: string;
    onActivate?: () => void;
}

export function usePluginDeviceAuth({
    pluginId,
    initialStatus = null,
    loadErrorMessage,
    startErrorMessage,
    onActivate,
}: UsePluginDeviceAuthOptions) {
    const [status, setStatus] = useState<PluginDeviceAuthStatus | null>(initialStatus);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isStarting, setIsStarting] = useState(false);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const result = await getPluginDeviceAuthStatus(pluginId);
            if (!result.success || !result.data) {
                setError(result.error || loadErrorMessage);
                return null;
            }

            setStatus(result.data);
            return result.data;
        } finally {
            setIsLoading(false);
        }
    }, [loadErrorMessage, pluginId]);

    const start = useCallback(async () => {
        setIsStarting(true);
        setError(null);

        try {
            const result = await startPluginDeviceAuth(pluginId);
            if (!result.success || !result.data) {
                setError(result.error || startErrorMessage);
                return null;
            }

            onActivate?.();
            setStatus(result.data);

            const verificationUri = result.data.prompt?.verificationUri;
            if (verificationUri) {
                window.open(verificationUri, '_blank', 'noopener,noreferrer');
            }

            return result.data;
        } finally {
            setIsStarting(false);
        }
    }, [onActivate, pluginId, startErrorMessage]);

    useEffect(() => {
        if (!status?.pending) {
            return;
        }

        const timer = window.setInterval(() => {
            void refresh();
        }, 2000);

        return () => window.clearInterval(timer);
    }, [refresh, status?.pending]);

    return {
        status,
        error,
        isLoading,
        isStarting,
        refresh,
        start,
    };
}
