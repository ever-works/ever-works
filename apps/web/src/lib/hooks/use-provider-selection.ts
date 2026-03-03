'use client';

import { useState, useCallback } from 'react';
import type {
    GeneratorFormSchema,
    ProviderSelectionState,
    SelectableProviderCategory,
} from '@/lib/api/types-only';
import {
    buildSelectedProviders as buildProviders,
    findUnconfiguredProviders,
} from '@ever-works/plugin';

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

    const buildSelectedProviders = useCallback(
        (formSchema?: GeneratorFormSchema | null) => {
            if (!formSchema) return undefined;
            return buildProviders(providers, formSchema);
        },
        [providers],
    );

    const getUnconfiguredProviders = useCallback(
        (formSchema: GeneratorFormSchema | null): string[] => {
            if (!formSchema) return [];
            return findUnconfiguredProviders(providers, formSchema);
        },
        [providers],
    );

    /**
     * Sync the pipeline selection to the server-resolved pipeline ID.
     * Trusts `resolvedPipelineId` from the backend; skips if a pipeline is already selected.
     * Returns the resolved pipeline ID, or `null` if none was resolved.
     */
    const syncResolvedPipeline = useCallback(
        (formSchema: GeneratorFormSchema): string | null => {
            if (providers.pipeline) return null;

            const resolvedId = formSchema.resolvedPipelineId;
            if (resolvedId) {
                handleProviderChange('pipeline', resolvedId);
                return resolvedId;
            }
            return null;
        },
        [providers.pipeline, handleProviderChange],
    );

    return {
        providers,
        handleProviderChange,
        buildSelectedProviders,
        getUnconfiguredProviders,
        syncResolvedPipeline,
    };
}
