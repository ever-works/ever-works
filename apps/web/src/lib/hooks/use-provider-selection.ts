'use client';

import { useState, useCallback } from 'react';
import type { ProviderSelectionState, SelectableProviderCategory } from '@/lib/api/types-only';

export function useProviderSelection(initial?: Partial<ProviderSelectionState>) {
    const [providers, setProviders] = useState<ProviderSelectionState>({
        search: initial?.search || null,
        screenshot: initial?.screenshot || null,
        ai: initial?.ai || null,
        contentExtractor: initial?.contentExtractor || null,
        pipeline: initial?.pipeline || null,
    });

    const handleProviderChange = useCallback(
        (category: SelectableProviderCategory, value: string | null) => {
            setProviders((prev) => ({ ...prev, [category]: value }));
        },
        [],
    );

    const isFullPipeline = providers.pipeline !== null;

    const buildSelectedProviders = useCallback(() => {
        const result: Record<string, string> = {};
        if (providers.search) result.search = providers.search;
        if (providers.screenshot) result.screenshot = providers.screenshot;
        if (providers.ai) result.ai = providers.ai;
        if (providers.contentExtractor) result.contentExtractor = providers.contentExtractor;
        if (providers.pipeline) result.pipeline = providers.pipeline;
        return Object.keys(result).length > 0 ? result : undefined;
    }, [providers]);

    return {
        providers,
        handleProviderChange,
        isFullPipeline,
        buildSelectedProviders,
    };
}
