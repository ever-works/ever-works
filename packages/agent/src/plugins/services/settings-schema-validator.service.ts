import { Injectable, Logger } from '@nestjs/common';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema } from '@ever-works/plugin';

/**
 * Result of a settings validation
 */
export interface SettingsValidationResult {
    /** Whether the settings are valid */
    valid: boolean;
    /** Validation errors if any */
    errors: string[];
}

/**
 * Scope for settings validation
 */
export type SettingsScope = 'global' | 'user' | 'work';

/**
 * Service for validating plugin settings against their JSON Schema definitions.
 * Uses Ajv for schema validation and supports scope-based filtering.
 */
@Injectable()
export class SettingsSchemaValidatorService {
    private readonly logger = new Logger(SettingsSchemaValidatorService.name);
    private readonly ajv: Ajv;
    private readonly schemaCache = new Map<string, ValidateFunction>();

    constructor() {
        this.ajv = new Ajv({
            allErrors: true,
            strict: false,
            useDefaults: false,
            coerceTypes: false,
        });
        addFormats(this.ajv);
    }

    /**
     * Validate settings against a plugin's JSON schema.
     *
     * @param settings - The settings to validate
     * @param schema - The plugin's settings schema
     * @param scope - The scope to validate for (filters schema properties by x-scope)
     * @returns Validation result with errors if invalid
     */
    validateSettings(
        settings: Record<string, unknown>,
        schema: JsonSchema | undefined,
        scope: SettingsScope,
    ): SettingsValidationResult {
        if (!schema) {
            // No schema means all settings are valid
            return { valid: true, errors: [] };
        }

        // Filter schema to only include properties for this scope
        const scopedSchema = this.filterSchemaByScope(schema, scope);

        // Build the filtered settings object
        const scopedSettings = this.filterSettingsByScope(settings, schema, scope);

        // Get or create the validator
        const validate = this.getValidator(scopedSchema, scope);

        const valid = validate(scopedSettings);

        if (!valid && validate.errors) {
            const errors = this.formatErrors(validate.errors);
            this.logger.debug(`Settings validation failed: ${errors.join(', ')}`);
            return { valid: false, errors };
        }

        return { valid: true, errors: [] };
    }

    /**
     * Validate that all required fields are present in the settings.
     *
     * @param settings - The settings to validate
     * @param schema - The plugin's settings schema
     * @param scope - The scope to validate for
     * @returns Validation result with missing required fields
     */
    validateRequiredFields(
        settings: Record<string, unknown>,
        schema: JsonSchema | undefined,
        scope: SettingsScope,
    ): SettingsValidationResult {
        if (!schema?.properties) return { valid: true, errors: [] };
        if (!schema.required?.length && !schema['x-requiredGroups']?.length) {
            return { valid: true, errors: [] };
        }

        const missingFields: string[] = [];

        for (const requiredField of schema.required ?? []) {
            const propSchema = schema.properties[requiredField];
            if (!propSchema) continue;

            // Check if this field is for the given scope
            const fieldScope = (propSchema['x-scope'] as SettingsScope) || 'global';
            if (!this.isScopeApplicable(fieldScope, scope)) continue;

            // Check if the field is present and not empty
            const value = settings[requiredField];
            if (value === undefined || value === null || value === '') {
                missingFields.push(requiredField);
            }
        }

        if (missingFields.length > 0) {
            return {
                valid: false,
                errors: [`Missing required fields: ${missingFields.join(', ')}`],
            };
        }

        const groupErrors = this.validateRequiredGroups(settings, schema, scope);
        if (groupErrors.length > 0) {
            return { valid: false, errors: groupErrors };
        }

        return { valid: true, errors: [] };
    }

    /**
     * Validate both schema and required fields.
     *
     * @param settings - The settings to validate
     * @param schema - The plugin's settings schema
     * @param scope - The scope to validate for
     * @returns Combined validation result
     */
    validate(
        settings: Record<string, unknown>,
        schema: JsonSchema | undefined,
        scope: SettingsScope,
    ): SettingsValidationResult {
        // First validate required fields
        const requiredResult = this.validateRequiredFields(settings, schema, scope);
        if (!requiredResult.valid) {
            return requiredResult;
        }

        // Then validate schema
        return this.validateSettings(settings, schema, scope);
    }

    clearCache(): void {
        this.schemaCache.clear();
    }

    private validateRequiredGroups(
        settings: Record<string, unknown>,
        schema: JsonSchema,
        scope: SettingsScope,
    ): string[] {
        const errors: string[] = [];
        for (const group of schema['x-requiredGroups'] ?? []) {
            const scopedFields = group.fields.filter((field) => {
                const propSchema = schema.properties?.[field];
                if (!propSchema) return false;
                const fieldScope = (propSchema['x-scope'] as SettingsScope) || 'global';
                // At work scope, include user-scoped fields because merged
                // settings contain inherited user values that can satisfy the group.
                if (scope === 'work' && fieldScope === 'user') return true;
                return this.isScopeApplicable(fieldScope, scope);
            });

            if (scopedFields.length === 0) continue;

            const hasAny = scopedFields.some((field) => {
                const value = settings[field];
                return value !== undefined && value !== null && value !== '';
            });

            if (!hasAny) {
                errors.push(
                    group.message || `At least one of [${scopedFields.join(', ')}] is required`,
                );
            }
        }
        return errors;
    }

    private filterSchemaByScope(schema: JsonSchema, scope: SettingsScope): JsonSchema {
        if (!schema.properties) {
            return schema;
        }

        const filteredProperties: Record<string, JsonSchema> = {};
        const filteredRequired: string[] = [];

        for (const [key, propSchema] of Object.entries(schema.properties)) {
            const propScope = (propSchema['x-scope'] as SettingsScope) || 'global';

            // Include property if scope matches or is applicable
            if (this.isScopeApplicable(propScope, scope)) {
                filteredProperties[key] = propSchema;

                // Include in required if it was originally required
                if (schema.required?.includes(key)) {
                    filteredRequired.push(key);
                }
            }
        }

        return {
            ...schema,
            properties: filteredProperties,
            required: filteredRequired.length > 0 ? filteredRequired : undefined,
        };
    }

    /**
     * Filter settings to only include properties for a given scope.
     */
    private filterSettingsByScope(
        settings: Record<string, unknown>,
        schema: JsonSchema,
        scope: SettingsScope,
    ): Record<string, unknown> {
        if (!schema.properties) {
            return settings;
        }

        const filteredSettings: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(settings)) {
            const propSchema = schema.properties[key];
            if (!propSchema) {
                // Unknown property - include it for now, schema validation will handle
                filteredSettings[key] = value;
                continue;
            }

            const propScope = (propSchema['x-scope'] as SettingsScope) || 'global';
            if (this.isScopeApplicable(propScope, scope)) {
                filteredSettings[key] = value;
            }
        }

        return filteredSettings;
    }

    /**
     * Check if a property's scope is applicable to the validation scope.
     *
     * Each scope only validates its own fields plus global fields:
     * - global fields are applicable at all scopes
     * - user fields are applicable only at user scope
     * - work fields are applicable only at work scope
     */
    private isScopeApplicable(
        propertyScope: SettingsScope,
        validationScope: SettingsScope,
    ): boolean {
        return propertyScope === 'global' || propertyScope === validationScope;
    }

    /**
     * Get or create a validator for a schema.
     */
    private getValidator(schema: JsonSchema, scope: SettingsScope): ValidateFunction {
        // Create a cache key from the schema
        const cacheKey = JSON.stringify({ schema, scope });

        let validate = this.schemaCache.get(cacheKey);
        if (!validate) {
            validate = this.ajv.compile(schema);
            this.schemaCache.set(cacheKey, validate);
        }

        return validate;
    }

    /**
     * Format Ajv errors into human-readable strings.
     */
    private formatErrors(errors: ErrorObject[]): string[] {
        return errors.map((error) => {
            const path = error.instancePath || '/';
            const message = error.message || 'validation failed';

            switch (error.keyword) {
                case 'type':
                    return `${path}: ${message} (expected ${error.params.type})`;
                case 'enum':
                    return `${path}: ${message}. Allowed values: ${(error.params.allowedValues as unknown[]).join(', ')}`;
                case 'required':
                    return `Missing required field: ${error.params.missingProperty}`;
                case 'minLength':
                    return `${path}: ${message} (minimum ${error.params.limit} characters)`;
                case 'maxLength':
                    return `${path}: ${message} (maximum ${error.params.limit} characters)`;
                case 'minimum':
                    return `${path}: ${message} (minimum value ${error.params.limit})`;
                case 'maximum':
                    return `${path}: ${message} (maximum value ${error.params.limit})`;
                case 'pattern':
                    return `${path}: ${message}`;
                case 'format':
                    return `${path}: ${message} (invalid ${error.params.format} format)`;
                default:
                    return `${path}: ${message}`;
            }
        });
    }
}
