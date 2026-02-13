'use client';

import { useState, useCallback } from 'react';
import type {
    GeneratorFormSchema,
    ProviderSelectionState,
    SelectableProviderCategory,
} from '@/lib/api/types-only';
import { getIndividualProviderCategories, resolveEffectiveDefault } from '@ever-works/plugin';

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
            const result: Record<string, string> = {};

            if (providers.pipeline) {
                result.pipeline = providers.pipeline;
            } else if (formSchema) {
                const effectiveDefault = formSchema.providers.pipeline
                    ? resolveEffectiveDefault(formSchema.providers.pipeline)
                    : null;
                if (effectiveDefault) {
                    result.pipeline = effectiveDefault.id;
                }
            }

            for (const { uiKey } of getIndividualProviderCategories()) {
                const stateKey = uiKey as keyof ProviderSelectionState;
                const explicit = providers[stateKey];
                if (explicit) {
                    result[uiKey] = explicit;
                } else if (formSchema) {
                    const options =
                        formSchema.providers[uiKey as keyof GeneratorFormSchema['providers']];
                    const effectiveDefault = resolveEffectiveDefault(options);
                    if (effectiveDefault) {
                        result[uiKey] = effectiveDefault.id;
                    }
                }
            }

            return Object.keys(result).length > 0 ? result : undefined;
        },
        [providers],
    );

    const getUnconfiguredProviders = useCallback(
        (formSchema: GeneratorFormSchema | null): string[] => {
            if (!formSchema) return [];

            if (providers.pipeline) {
                const pp = formSchema.providers.pipeline?.find((p) => p.id === providers.pipeline);
                return pp && !pp.configured ? [pp.name] : [];
            }

            const unconfigured: string[] = [];

            for (const { uiKey } of getIndividualProviderCategories()) {
                const options =
                    formSchema.providers[uiKey as keyof GeneratorFormSchema['providers']];
                if (options.length === 0) continue;

                const stateKey = uiKey as keyof ProviderSelectionState;
                const explicit = providers[stateKey];
                if (explicit) {
                    const p = options.find((o) => o.id === explicit);
                    if (p && !p.configured) unconfigured.push(p.name);
                } else {
                    const effectiveDefault = resolveEffectiveDefault(options);
                    if (effectiveDefault && !effectiveDefault.configured) {
                        unconfigured.push(effectiveDefault.name);
                    }
                }
            }

            return unconfigured;
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
