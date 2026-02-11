/**
 * Form field types supported by the plugin system
 */
export type FormFieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'boolean'
	| 'select'
	| 'multiselect'
	| 'date'
	| 'datetime'
	| 'url'
	| 'email'
	| 'password'
	| 'file'
	| 'image'
	| 'color'
	| 'json'
	| 'markdown'
	| 'code'
	| 'rich-text'
	| 'tags'
	| 'rating'
	| 'range'
	| 'hidden';

/**
 * Option for select/multiselect fields
 */
export interface FormFieldOption {
	readonly label: string;
	readonly value: string | number | boolean;
	readonly description?: string;
	readonly disabled?: boolean;
}

/**
 * Validation rule for a form field
 */
export interface FormFieldValidation {
	/** Required field */
	readonly required?: boolean;
	/** Minimum value (number) or length (string) */
	readonly min?: number;
	/** Maximum value (number) or length (string) */
	readonly max?: number;
	/** Regular expression pattern for validation */
	readonly pattern?: string;
	/** Custom error message */
	readonly message?: string;
}

/**
 * Conditional visibility/requirement based on other field values
 */
export interface FormFieldCondition {
	/** Field name to check */
	readonly field: string;
	/** Operator for comparison */
	readonly operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains';
	/** Value to compare against */
	readonly value: unknown;
}

/**
 * Definition for a form field
 */
export interface FormFieldDefinition {
	/** Unique identifier for the field */
	readonly name: string;
	/** Field type */
	readonly type: FormFieldType;
	/** Display label */
	readonly label: string;
	/** Help text or description */
	readonly description?: string;
	/** Placeholder text */
	readonly placeholder?: string;
	/** Default value */
	readonly defaultValue?: unknown;
	/** Options for select/multiselect fields */
	readonly options?: readonly FormFieldOption[];
	/** Validation rules */
	readonly validation?: FormFieldValidation;
	/** Conditional visibility */
	readonly showIf?: FormFieldCondition | readonly FormFieldCondition[];
	/** Conditional requirement */
	readonly requiredIf?: FormFieldCondition | readonly FormFieldCondition[];
	/** Whether the field is disabled */
	readonly disabled?: boolean;
	/** Whether the field is read-only */
	readonly readOnly?: boolean;
	/** Group/section for organizing fields */
	readonly group?: string;
	/** Display order within group */
	readonly order?: number;
	/** Additional field-specific configuration */
	readonly config?: Record<string, unknown>;
}

/**
 * Group of related form fields
 */
export interface FormFieldGroup {
	/** Unique identifier for the group */
	readonly name: string;
	/** Display title */
	readonly title: string;
	/** Group description */
	readonly description?: string;
	/** Display order */
	readonly order?: number;
	/** Whether the group is collapsible */
	readonly collapsible?: boolean;
	/** Whether the group starts collapsed */
	readonly collapsed?: boolean;
}

/**
 * Complete form schema with fields and groups
 */
export interface FormSchema {
	/** Form fields */
	readonly fields: readonly FormFieldDefinition[];
	/** Field groups */
	readonly groups?: readonly FormFieldGroup[];
	/** Form-level validation */
	readonly validation?: Record<string, unknown>;
}
