import type { GeneratorFormSchema } from './capabilities/form-schema-provider.interface.js';
import type { ProviderSelectionState } from './provider-categories.js';
import { getIndividualProviderCategories, resolveEffectiveDefault } from './provider-categories.js';

/**
 * Build the final providers object by resolving explicit selections against schema defaults.
 */
export function buildSelectedProviders(
	selections: Partial<ProviderSelectionState>,
	schema: GeneratorFormSchema
): Record<string, string> | undefined {
	const result: Record<string, string> = {};

	if (selections.pipeline) {
		result.pipeline = selections.pipeline;
	} else {
		const pipelineOptions = schema.providers.pipeline ?? [];
		const def = resolveEffectiveDefault(pipelineOptions);
		if (def) result.pipeline = def.id;
	}

	for (const { uiKey } of getIndividualProviderCategories()) {
		const key = uiKey as keyof ProviderSelectionState;
		const explicit = selections[key];
		if (explicit) {
			result[uiKey] = explicit;
		} else {
			const options = schema.providers[uiKey as keyof typeof schema.providers];
			const def = resolveEffectiveDefault(options);
			if (def) result[uiKey] = def.id;
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Find providers that are selected (explicitly or by default) but not configured.
 */
export function findUnconfiguredProviders(
	selections: Partial<ProviderSelectionState>,
	schema: GeneratorFormSchema
): string[] {
	if (selections.pipeline) {
		const pp = schema.providers.pipeline?.find((p) => p.id === selections.pipeline);
		return pp && !pp.configured ? [pp.name] : [];
	}

	const unconfigured: string[] = [];
	for (const { uiKey } of getIndividualProviderCategories()) {
		const options = schema.providers[uiKey as keyof typeof schema.providers];
		if (options.length === 0) continue;

		const key = uiKey as keyof ProviderSelectionState;
		const explicit = selections[key];
		if (explicit) {
			const p = options.find((o) => o.id === explicit);
			if (p && !p.configured) unconfigured.push(p.name);
		} else {
			const def = resolveEffectiveDefault(options);
			if (def && !def.configured) unconfigured.push(def.name);
		}
	}
	return unconfigured;
}
