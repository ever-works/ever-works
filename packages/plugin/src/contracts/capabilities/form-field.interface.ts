import type { IPlugin } from '../plugin.interface.js';
import type { FormFieldDefinition, FormSchema, FormFieldType } from '@ever-works/contracts';
import type { ValidationResult } from '../../settings/validation.types.js';

/**
 * Form field render context
 */
export interface FormFieldRenderContext {
	/** Field definition */
	readonly field: FormFieldDefinition;
	/** Current value */
	readonly value: unknown;
	/** Whether field is disabled */
	readonly disabled: boolean;
	/** Whether field is read-only */
	readonly readOnly: boolean;
	/** Validation errors */
	readonly errors?: readonly string[];
	/** Form values (for conditional logic) */
	readonly formValues: Record<string, unknown>;
}

/**
 * Form field component props (framework-agnostic)
 */
export interface FormFieldComponentProps {
	/** Field definition */
	readonly field: FormFieldDefinition;
	/** Current value */
	readonly value: unknown;
	/** Change handler */
	readonly onChange: (value: unknown) => void;
	/** Blur handler */
	readonly onBlur?: () => void;
	/** Whether field is disabled */
	readonly disabled?: boolean;
	/** Whether field is read-only */
	readonly readOnly?: boolean;
	/** Validation errors */
	readonly errors?: readonly string[];
	/** Additional className */
	readonly className?: string;
}

/**
 * Form field registration
 */
export interface FormFieldRegistration {
	/** Field type identifier */
	readonly type: string;
	/** Display name */
	readonly displayName: string;
	/** Field description */
	readonly description?: string;
	/** Icon identifier */
	readonly icon?: string;
	/** Default configuration */
	readonly defaultConfig?: Partial<FormFieldDefinition>;
	/** Whether field supports options (for select-like fields) */
	readonly supportsOptions?: boolean;
	/** Whether field supports validation rules */
	readonly supportsValidation?: boolean;
}

/**
 * Form field plugin interface
 * Capability: 'form-field'
 */
export interface IFormFieldPlugin extends IPlugin {
	/** Field type this plugin provides */
	readonly fieldType: string;

	/**
	 * Get field registration information
	 */
	getRegistration(): FormFieldRegistration;

	/**
	 * Validate field value
	 */
	validate(value: unknown, field: FormFieldDefinition): Promise<ValidationResult>;

	/**
	 * Transform value before saving
	 */
	transformValue?(value: unknown, field: FormFieldDefinition): unknown;

	/**
	 * Parse value from storage
	 */
	parseValue?(value: unknown, field: FormFieldDefinition): unknown;

	/**
	 * Get default value for this field type
	 */
	getDefaultValue?(field: FormFieldDefinition): unknown;

	/**
	 * Check if value is empty
	 */
	isEmpty?(value: unknown): boolean;

	/**
	 * Compare two values for equality
	 */
	isEqual?(value1: unknown, value2: unknown): boolean;

	/**
	 * Get component render specification (for frontend)
	 * Returns a specification that frontends can use to render the field
	 */
	getComponentSpec?(): FormFieldComponentSpec;
}

/**
 * Form field component specification
 */
export interface FormFieldComponentSpec {
	/** Component type (e.g., 'input', 'select', 'custom') */
	readonly component: string;
	/** Component props schema */
	readonly propsSchema?: Record<string, unknown>;
	/** CSS class names */
	readonly classNames?: Record<string, string>;
	/** HTML attributes */
	readonly htmlAttributes?: Record<string, unknown>;
}

/**
 * Type guard for form field plugins
 */
export function isFormFieldPlugin(plugin: IPlugin): plugin is IFormFieldPlugin {
	return plugin.capabilities.includes('form-field');
}
