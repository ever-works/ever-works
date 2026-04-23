'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
    const handledVerificationUriRef = useRef<string | null>(
        initialStatus?.prompt?.verificationUri ?? null,
    );

    useEffect(() => {
        setStatus(initialStatus ?? null);
        handledVerificationUriRef.current = initialStatus?.prompt?.verificationUri ?? null;
    }, [initialStatus]);

    const openVerificationUri = useCallback((verificationUri?: string | null) => {
        if (!verificationUri || typeof window === 'undefined') {
            return;
        }

        if (handledVerificationUriRef.current === verificationUri) {
            return;
        }

        // Browsers can return null for noopener/noreferrer popups even when the tab opens.
        // Treat the URL as handled once we attempt to open it so polling does not reopen it.
        handledVerificationUriRef.current = verificationUri;
        window.open(verificationUri, '_blank', 'noopener,noreferrer');
    }, []);

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
    }, [loadErrorMessage, openVerificationUri, pluginId]);

    const start = useCallback(async () => {
        setIsStarting(true);
        setError(null);
        handledVerificationUriRef.current = null;

        try {
            const result = await startPluginDeviceAuth(pluginId);
            if (!result.success || !result.data) {
                setError(result.error || startErrorMessage);
                return null;
            }

            onActivate?.();
            setStatus(result.data);

            openVerificationUri(result.data.prompt?.verificationUri);

            return result.data;
        } finally {
            setIsStarting(false);
        }
    }, [onActivate, openVerificationUri, pluginId, startErrorMessage]);

    useEffect(() => {
        if (!status?.pending) {
            return;
        }

        const timer = window.setInterval(() => {
            void refresh();
        }, 2000);

        return () => window.clearInterval(timer);
    }, [refresh, status?.pending]);

    useEffect(() => {
        if (!status?.pending) {
            return;
        }

        openVerificationUri(status.prompt?.verificationUri);
    }, [openVerificationUri, status?.pending, status?.prompt?.verificationUri]);

    return {
        status,
        error,
        isLoading,
        isStarting,
        refresh,
        start,
    };
}
