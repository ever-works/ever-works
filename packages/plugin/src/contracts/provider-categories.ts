import type { ProviderOption } from './capabilities/form-schema-provider.interface.js';

/**
 * Definition of a provider category that can be selected in the generator form.
 */
export interface ProviderCategoryDefinition {
	/** The capability name used in the plugin system (e.g., 'ai-provider') */
	readonly capability: string;
	/** The key used in UI forms and DTOs (e.g., 'ai') */
	readonly uiKey: string;
	/** Whether this provider can be selected in the generator form */
	readonly selectableInForm: boolean;
}

/**
 * All selectable provider categories.
 *
 * Keys are used for programmatic access, while `capability` and `uiKey`
 * provide the mapping between backend capabilities and frontend forms.
 */
export const SELECTABLE_PROVIDER_CATEGORIES = {
	search: { capability: 'search', uiKey: 'search', selectableInForm: true },
	screenshot: { capability: 'screenshot', uiKey: 'screenshot', selectableInForm: true },
	ai: { capability: 'ai-provider', uiKey: 'ai', selectableInForm: true },
	contentExtractor: {
		capability: 'content-extractor',
		uiKey: 'contentExtractor',
		selectableInForm: true
	},
	pipeline: { capability: 'pipeline', uiKey: 'pipeline', selectableInForm: true }
} as const satisfies Record<string, ProviderCategoryDefinition>;

/**
 * Type representing the keys of selectable provider categories.
 */
export type ProviderCategoryKey = keyof typeof SELECTABLE_PROVIDER_CATEGORIES;

/**
 * Type representing the UI keys used in forms and DTOs.
 * Derived from SELECTABLE_PROVIDER_CATEGORIES to ensure consistency.
 */
export type ProviderUIKey = (typeof SELECTABLE_PROVIDER_CATEGORIES)[ProviderCategoryKey]['uiKey'];

/**
 * Get the capability name from a UI key.
 */
export function getCapabilityFromUIKey(uiKey: string): string {
	const entry = Object.values(SELECTABLE_PROVIDER_CATEGORIES).find((c) => c.uiKey === uiKey);
	if (!entry) {
		throw new Error(`Unknown provider UI key: ${uiKey}`);
	}
	return entry.capability;
}

/**
 * Get the UI key from a capability name.
 */
export function getUIKeyFromCapability(capability: string): string {
	const entry = Object.values(SELECTABLE_PROVIDER_CATEGORIES).find((c) => c.capability === capability);
	if (!entry) {
		throw new Error(`Unknown provider capability: ${capability}`);
	}
	return entry.uiKey;
}

/**
 * Get all selectable provider categories as an array.
 */
export function getSelectableCategories(): ProviderCategoryDefinition[] {
	return Object.values(SELECTABLE_PROVIDER_CATEGORIES).filter((c) => c.selectableInForm);
}

/**
 * Providers object in GeneratorFormSchema (derived from SELECTABLE_PROVIDER_CATEGORIES).
 */
export type FormSchemaProvidersType = {
	[K in ProviderCategoryKey as (typeof SELECTABLE_PROVIDER_CATEGORIES)[K]['uiKey']]: ProviderOption[];
};

/**
 * Provider selection state for the generator form.
 */
export type ProviderSelectionState = {
	[K in ProviderCategoryKey as (typeof SELECTABLE_PROVIDER_CATEGORIES)[K]['uiKey']]: string | null;
};

/**
 * Keys for provider change handlers.
 */
export type SelectableProviderCategory = keyof ProviderSelectionState;

/**
 * Keys of individual (non-pipeline) provider categories.
 */
export type IndividualCategoryKey = Exclude<ProviderCategoryKey, 'pipeline'>;

export interface IndividualProviderCategory {
	readonly categoryKey: IndividualCategoryKey;
	readonly uiKey: string;
	readonly capability: string;
}

/**
 * Individual provider categories (excluding pipeline).
 * Derives from SELECTABLE_PROVIDER_CATEGORIES so new categories are picked up automatically.
 */
export function getIndividualProviderCategories(): IndividualProviderCategory[] {
	return (Object.entries(SELECTABLE_PROVIDER_CATEGORIES) as [ProviderCategoryKey, ProviderCategoryDefinition][])
		.filter(([key]) => key !== 'pipeline')
		.map(([key, def]) => ({
			categoryKey: key as IndividualCategoryKey,
			uiKey: def.uiKey,
			capability: def.capability
		}));
}

/**
 * Resolve the effective default provider from a list of options.
 * Priority: (1) isDefault && configured, (2) isDefault (even if unconfigured).
 */
export function resolveEffectiveDefault(options: ProviderOption[]): ProviderOption | null {
	return options.find((o) => o.isDefault && o.configured) || options.find((o) => o.isDefault) || null;
}
