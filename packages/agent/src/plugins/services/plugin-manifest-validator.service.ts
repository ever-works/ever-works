import { Injectable, Logger } from '@nestjs/common';
import type {
    PluginManifest,
    PluginCategory,
    ValidationResult,
    ValidationError,
} from '@ever-works/plugin';
import { PLUGIN_CATEGORIES, isPluginCategory } from '@ever-works/plugin';

/**
 * Plugin ID pattern: lowercase letters, numbers, and hyphens
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Semver pattern for version validation
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

/**
 * Service for validating plugin manifests.
 * Validates the `everworks.plugin` field in package.json files.
 */
@Injectable()
export class PluginManifestValidatorService {
    private readonly logger = new Logger(PluginManifestValidatorService.name);

    /**
     * Validate a plugin manifest
     */
    validate(manifest: unknown): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        if (!manifest || typeof manifest !== 'object') {
            return {
                valid: false,
                errors: [{ path: '', message: 'Manifest must be an object' }],
            };
        }

        const m = manifest as Record<string, unknown>;

        // Required fields
        this.validateRequired(m, 'id', errors);
        this.validateRequired(m, 'name', errors);
        this.validateRequired(m, 'version', errors);
        this.validateRequired(m, 'category', errors);

        // Validate ID format
        if (typeof m.id === 'string') {
            if (!PLUGIN_ID_PATTERN.test(m.id)) {
                errors.push({
                    path: 'id',
                    message:
                        'Plugin ID must start with a letter, contain only lowercase letters, numbers, and hyphens, and end with a letter or number',
                    actual: m.id,
                });
            }
            if (m.id.length < 3) {
                errors.push({
                    path: 'id',
                    message: 'Plugin ID must be at least 3 characters long',
                    actual: m.id,
                });
            }
            if (m.id.length > 64) {
                errors.push({
                    path: 'id',
                    message: 'Plugin ID must not exceed 64 characters',
                    actual: m.id,
                });
            }
        }

        // Validate version format
        if (typeof m.version === 'string') {
            if (!SEMVER_PATTERN.test(m.version)) {
                errors.push({
                    path: 'version',
                    message: 'Version must be valid semver (e.g., 1.0.0)',
                    actual: m.version,
                });
            }
        }

        // Validate category
        if (typeof m.category === 'string') {
            if (!isPluginCategory(m.category)) {
                errors.push({
                    path: 'category',
                    message: `Invalid category. Must be one of: ${PLUGIN_CATEGORIES.join(', ')}`,
                    actual: m.category,
                    expected: PLUGIN_CATEGORIES.join(' | '),
                });
            }
        }

        // Validate capabilities
        if (m.capabilities !== undefined) {
            if (!Array.isArray(m.capabilities)) {
                errors.push({
                    path: 'capabilities',
                    message: 'Capabilities must be an array of strings',
                    actual: typeof m.capabilities,
                    expected: 'string[]',
                });
            } else {
                m.capabilities.forEach((cap, index) => {
                    if (typeof cap !== 'string') {
                        errors.push({
                            path: `capabilities[${index}]`,
                            message: 'Each capability must be a string',
                            actual: typeof cap,
                            expected: 'string',
                        });
                    }
                });
            }
        }

        // Validate optional string fields
        this.validateOptionalString(m, 'description', warnings);
        this.validateOptionalString(m, 'readme', warnings);
        this.validateOptionalString(m, 'homepage', warnings);
        this.validateOptionalString(m, 'license', warnings);

        // Validate minPlatformVersion and maxPlatformVersion
        if (m.minPlatformVersion !== undefined) {
            if (
                typeof m.minPlatformVersion !== 'string' ||
                !SEMVER_PATTERN.test(m.minPlatformVersion)
            ) {
                errors.push({
                    path: 'minPlatformVersion',
                    message: 'minPlatformVersion must be valid semver',
                    actual: m.minPlatformVersion,
                });
            }
        }
        if (m.maxPlatformVersion !== undefined) {
            if (
                typeof m.maxPlatformVersion !== 'string' ||
                !SEMVER_PATTERN.test(m.maxPlatformVersion)
            ) {
                errors.push({
                    path: 'maxPlatformVersion',
                    message: 'maxPlatformVersion must be valid semver',
                    actual: m.maxPlatformVersion,
                });
            }
        }

        // Validate dependencies
        if (m.dependencies !== undefined) {
            if (typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)) {
                errors.push({
                    path: 'dependencies',
                    message: 'Dependencies must be an object mapping plugin IDs to version ranges',
                    actual: typeof m.dependencies,
                    expected: 'Record<string, string>',
                });
            } else {
                const deps = m.dependencies as Record<string, unknown>;
                for (const [key, value] of Object.entries(deps)) {
                    if (typeof value !== 'string') {
                        errors.push({
                            path: `dependencies.${key}`,
                            message: 'Dependency version must be a string',
                            actual: typeof value,
                            expected: 'string',
                        });
                    }
                }
            }
        }

        // Validate author
        if (m.author !== undefined) {
            if (typeof m.author !== 'object' || Array.isArray(m.author)) {
                errors.push({
                    path: 'author',
                    message: 'Author must be an object with name, email, and url fields',
                    actual: typeof m.author,
                });
            } else {
                const author = m.author as Record<string, unknown>;
                if (typeof author.name !== 'string') {
                    errors.push({
                        path: 'author.name',
                        message: 'Author name is required and must be a string',
                    });
                }
            }
        }

        // Validate icon
        if (m.icon !== undefined) {
            if (typeof m.icon !== 'object' || Array.isArray(m.icon)) {
                errors.push({
                    path: 'icon',
                    message: 'Icon must be an object',
                    actual: typeof m.icon,
                });
            } else {
                const icon = m.icon as Record<string, unknown>;
                const validIconTypes = ['url', 'svg', 'emoji', 'lucide', 'base64'];
                if (typeof icon.type !== 'string' || !validIconTypes.includes(icon.type)) {
                    errors.push({
                        path: 'icon.type',
                        message: `Icon type must be one of: ${validIconTypes.join(', ')}`,
                        actual: icon.type,
                    });
                }
                if (typeof icon.value !== 'string') {
                    errors.push({
                        path: 'icon.value',
                        message: 'Icon value is required',
                    });
                }
            }
        }

        // Validate deprecated flag
        if (m.deprecated !== undefined && typeof m.deprecated !== 'boolean') {
            errors.push({
                path: 'deprecated',
                message: 'Deprecated must be a boolean',
                actual: typeof m.deprecated,
                expected: 'boolean',
            });
        }

        // Add warning if deprecated without message
        if (m.deprecated === true && !m.deprecationMessage) {
            warnings.push({
                path: 'deprecationMessage',
                message: 'Deprecated plugins should include a deprecation message',
            });
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Validate required field presence and type
     */
    private validateRequired(
        obj: Record<string, unknown>,
        field: string,
        errors: ValidationError[],
    ): void {
        if (obj[field] === undefined || obj[field] === null) {
            errors.push({
                path: field,
                message: `${field} is required`,
            });
        } else if (typeof obj[field] !== 'string') {
            errors.push({
                path: field,
                message: `${field} must be a string`,
                actual: typeof obj[field],
                expected: 'string',
            });
        } else if ((obj[field] as string).trim() === '') {
            errors.push({
                path: field,
                message: `${field} must not be empty`,
            });
        }
    }

    /**
     * Validate optional string field
     */
    private validateOptionalString(
        obj: Record<string, unknown>,
        field: string,
        warnings: ValidationError[],
    ): void {
        if (obj[field] !== undefined && typeof obj[field] !== 'string') {
            warnings.push({
                path: field,
                message: `${field} should be a string`,
                actual: typeof obj[field],
                expected: 'string',
            });
        }
    }

    /**
     * Extract plugin manifest from package.json
     */
    extractManifest(packageJson: Record<string, unknown>): PluginManifest | null {
        const everworks = packageJson.everworks as Record<string, unknown> | undefined;
        if (!everworks?.plugin) {
            return null;
        }

        const plugin = everworks.plugin as Record<string, unknown>;

        // Spread all plugin fields, then apply fallbacks from top-level package.json
        // Only include fallback fields when they resolve to a defined value,
        // so that undefined keys don't override runtime getManifest() values.
        const manifest: Record<string, unknown> = {
            ...plugin,
            capabilities: (plugin.capabilities as readonly string[]) || [],
        };

        const fallbacks: Record<string, unknown> = {
            name: plugin.name || packageJson.name,
            version: plugin.version || packageJson.version,
            description: plugin.description || packageJson.description,
            homepage: plugin.homepage || packageJson.homepage,
            license: plugin.license || packageJson.license,
        };

        for (const [key, value] of Object.entries(fallbacks)) {
            if (value !== undefined) {
                manifest[key] = value;
            }
        }

        return manifest as unknown as PluginManifest;
    }

    /**
     * Validate a package.json and extract the manifest
     */
    validateAndExtract(packageJson: Record<string, unknown>): {
        manifest: PluginManifest | null;
        validation: ValidationResult;
    } {
        const manifest = this.extractManifest(packageJson);

        if (!manifest) {
            return {
                manifest: null,
                validation: {
                    valid: false,
                    errors: [
                        {
                            path: 'everworks.plugin',
                            message: 'Package does not contain an everworks.plugin field',
                        },
                    ],
                },
            };
        }

        const validation = this.validate(manifest);

        return {
            manifest: validation.valid ? manifest : null,
            validation,
        };
    }
}
