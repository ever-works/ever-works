import type { IPlugin } from '../plugin.interface.js';
import type { FormFieldDefinition, FormFieldGroup } from '@ever-works/contracts';
import type { ValidationResult } from '../../settings/validation.types.js';
import type { PluginIcon } from '../plugin-manifest.types.js';

/**
 * Interface for plugins that provide form fields for the generator form.
 * Any plugin (pipeline, search, AI, etc.) can implement this to add fields.
 *
 * This is different from IFormFieldPlugin which provides custom field types.
 * IFormSchemaProvider provides the actual form schema/fields for configuration.
 *
 * Capability: 'form-schema-provider'
 */
export interface IFormSchemaProvider extends IPlugin {
	/**
	 * Get form fields this plugin contributes to the generator form.
	 * Called when building the dynamic generator form.
	 */
	getFormFields(): FormFieldDefinition[];

	/**
	 * Get form field groups for organizing fields in the UI.
	 * Groups allow collapsible sections and logical organization.
	 */
	getFormGroups?(): FormFieldGroup[];

	/**
	 * Validate plugin-specific form input values.
	 * Called before submitting the generation request.
	 *
	 * @param values - The form values to validate
	 * @returns Validation result with any errors
	 */
	validateFormInput(values: Record<string, unknown>): ValidationResult | Promise<ValidationResult>;

	/**
	 * Which standard ConfigDto fields this plugin handles.
	 * Used by UI to hide/disable these fields when this plugin is selected.
	 *
	 * Use ['*'] to indicate plugin handles ALL config fields (full pipeline replacement).
	 * Use specific field names like ['max_search_queries', 'max_items'] for partial handling.
	 */
	readonly handledConfigFields?: readonly string[];

	/**
	 * Transform form values before they are sent to the backend.
	 * Useful for converting UI-friendly formats to API formats.
	 *
	 * @param values - The raw form values
	 * @returns Transformed values ready for the API
	 */
	transformFormValues?(values: Record<string, unknown>): Record<string, unknown>;

	/**
	 * Get default values for all form fields.
	 * Used to initialize the form with sensible defaults.
	 */
	getDefaultValues?(): Record<string, unknown>;
}

/**
 * Type guard for form schema provider plugins
 */
export function isFormSchemaProvider(plugin: IPlugin): plugin is IFormSchemaProvider {
	return (
		plugin.capabilities.includes('form-schema-provider') &&
		typeof (plugin as IFormSchemaProvider).getFormFields === 'function' &&
		typeof (plugin as IFormSchemaProvider).validateFormInput === 'function'
	);
}

/**
 * Generator form schema returned by the API.
 * Contains all information needed to render a dynamic generator form.
 */
export interface GeneratorFormSchema {
	/**
	 * Available providers for each capability category.
	 * Allows users to select which provider to use for search, AI, etc.
	 */
	providers: {
		/** Available search providers (e.g., "tavily", "exa") */
		search: ProviderOption[];
		/** Available screenshot providers (e.g., "screenshotone") */
		screenshot: ProviderOption[];
		/** Available AI providers (e.g., "openai", "anthropic") */
		ai: ProviderOption[];
		/** Available full pipeline providers that replace the standard pipeline */
		fullPipeline: ProviderOption[];
	};

	/**
	 * Form fields contributed by the selected pipeline plugin.
	 * These fields are rendered dynamically based on plugin selection.
	 */
	pluginFields: FormFieldDefinition[];

	/**
	 * Form field groups for organizing plugin fields.
	 */
	pluginGroups?: FormFieldGroup[];

	/**
	 * Which standard config fields are handled by the selected plugin.
	 * UI should hide or disable these fields.
	 */
	handledConfigFields: readonly string[];

	/**
	 * Default values for all plugin fields.
	 */
	defaultValues?: Record<string, unknown>;
}

/**
 * Option for selecting a provider in the generator form.
 */
export interface ProviderOption {
	/** Plugin ID */
	id: string;
	/** Display name */
	name: string;
	/** Description of the provider */
	description?: string;
	/** Whether this provider is currently configured/available */
	configured: boolean;
	/** Whether this is the default/recommended provider */
	isDefault?: boolean;
	/** Icon for the provider */
	icon?: PluginIcon;
}
