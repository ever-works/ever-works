import { Injectable, Logger } from '@nestjs/common';
import type {
    IPlugin,
    PluginContext,
    PluginManifest,
    PluginSettings,
    ValidationResult,
    ValidationError,
} from '@ever-works/plugin';

/**
 * Type guard to check if an object implements IPlugin
 */
function isIPlugin(obj: unknown): obj is IPlugin {
    if (!obj || typeof obj !== 'object') {
        return false;
    }

    const plugin = obj as Record<string, unknown>;

    // Check required properties
    if (typeof plugin.id !== 'string') return false;
    if (typeof plugin.name !== 'string') return false;
    if (typeof plugin.version !== 'string') return false;
    if (typeof plugin.category !== 'string') return false;
    if (!Array.isArray(plugin.capabilities)) return false;

    // Check required methods
    if (typeof plugin.onLoad !== 'function') return false;
    if (typeof plugin.onEnable !== 'function') return false;
    if (typeof plugin.onDisable !== 'function') return false;
    if (typeof plugin.onUnload !== 'function') return false;
    if (typeof plugin.validateSettings !== 'function') return false;

    return true;
}

/**
 * Type guard for plugin classes (constructors)
 */
function isPluginClass(obj: unknown): obj is new () => IPlugin {
    if (typeof obj !== 'function') {
        return false;
    }

    // Check if it's a class by looking for prototype
    if (!obj.prototype) {
        return false;
    }

    // Check if prototype has required methods
    const proto = obj.prototype;
    return (
        typeof proto.onLoad === 'function' &&
        typeof proto.onEnable === 'function' &&
        typeof proto.onDisable === 'function' &&
        typeof proto.onUnload === 'function'
    );
}

/**
 * Known capability interfaces and their required methods/properties
 */
const CAPABILITY_REQUIREMENTS: Record<string, string[]> = {
    'git-provider': ['getRepositories', 'getRepository', 'createRepository', 'getFile', 'getFiles'],
    oauth: ['getAuthorizationUrl', 'exchangeCodeForToken', 'getAuthenticatedUser'],
    deployment: ['deploy', 'getDeploymentStatus', 'getDeployments'],
    screenshot: ['takeScreenshot'],
    search: ['search'],
    'content-extractor': ['extract', 'supports'],
    'data-source': ['fetch', 'validate'],
    'ai-provider': [
        'createChatCompletion',
        'listModels',
        'getModel',
        'isAvailable',
        'getCapabilities',
    ],
    'pipeline-step': ['execute', 'getMetadata'],
    'full-pipeline': ['execute', 'getSteps'],
    'form-field': ['render', 'validate', 'getFieldType'],
    'sub-provider': ['getSubProviders', 'getSubProvider'],
    'config-aware': ['onConfigChange'],
};

/**
 * Service for validating plugin classes.
 * Ensures plugin classes implement IPlugin and declared capability interfaces.
 */
@Injectable()
export class PluginClassValidatorService {
    private readonly logger = new Logger(PluginClassValidatorService.name);

    /**
     * Validate that an object or class implements IPlugin
     */
    validatePlugin(pluginOrClass: unknown): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        // Check if it's a class or instance
        let plugin: unknown;
        let isClass = false;

        if (isPluginClass(pluginOrClass)) {
            isClass = true;
            try {
                // We can't instantiate without constructor args, so check prototype
                plugin = pluginOrClass.prototype;
            } catch {
                errors.push({
                    path: 'constructor',
                    message: 'Failed to access plugin class prototype',
                });
                return { valid: false, errors };
            }
        } else {
            plugin = pluginOrClass;
        }

        if (!plugin || typeof plugin !== 'object') {
            errors.push({
                path: '',
                message: 'Plugin must be an object or class',
                actual: typeof plugin,
            });
            return { valid: false, errors };
        }

        const p = plugin as Record<string, unknown>;

        // For instances, check required properties
        if (!isClass) {
            this.checkRequiredProperty(p, 'id', 'string', errors);
            this.checkRequiredProperty(p, 'name', 'string', errors);
            this.checkRequiredProperty(p, 'version', 'string', errors);
            this.checkRequiredProperty(p, 'category', 'string', errors);

            if (!Array.isArray(p.capabilities)) {
                errors.push({
                    path: 'capabilities',
                    message: 'Plugin must have capabilities array',
                    expected: 'string[]',
                    actual: typeof p.capabilities,
                });
            }
        }

        // Check required methods
        this.checkRequiredMethod(p, 'onLoad', errors);
        this.checkRequiredMethod(p, 'onEnable', errors);
        this.checkRequiredMethod(p, 'onDisable', errors);
        this.checkRequiredMethod(p, 'onUnload', errors);
        this.checkRequiredMethod(p, 'validateSettings', errors);

        // Check optional methods
        if (p.healthCheck !== undefined && typeof p.healthCheck !== 'function') {
            warnings.push({
                path: 'healthCheck',
                message: 'healthCheck should be a function if defined',
                actual: typeof p.healthCheck,
                expected: 'function',
            });
        }

        if (p.getManifest !== undefined && typeof p.getManifest !== 'function') {
            warnings.push({
                path: 'getManifest',
                message: 'getManifest should be a function if defined',
                actual: typeof p.getManifest,
                expected: 'function',
            });
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Validate that a plugin implements the interfaces required by its capabilities
     */
    validateCapabilities(plugin: IPlugin): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        const p = plugin as unknown as Record<string, unknown>;

        for (const capability of plugin.capabilities) {
            const requirements = CAPABILITY_REQUIREMENTS[capability];

            if (!requirements) {
                // Unknown capability - this is fine, just a warning
                warnings.push({
                    path: `capabilities.${capability}`,
                    message: `Unknown capability "${capability}". No validation rules available.`,
                });
                continue;
            }

            // Check if plugin implements required methods for this capability
            for (const method of requirements) {
                if (typeof p[method] !== 'function') {
                    errors.push({
                        path: `capabilities.${capability}.${method}`,
                        message: `Plugin declares "${capability}" capability but does not implement required method "${method}"`,
                        expected: 'function',
                        actual: typeof p[method],
                    });
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Validate plugin against its manifest
     */
    validateAgainstManifest(plugin: IPlugin, manifest: PluginManifest): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        // Check ID matches
        if (plugin.id !== manifest.id) {
            errors.push({
                path: 'id',
                message: `Plugin ID "${plugin.id}" does not match manifest ID "${manifest.id}"`,
                expected: manifest.id,
                actual: plugin.id,
            });
        }

        // Check version matches
        if (plugin.version !== manifest.version) {
            warnings.push({
                path: 'version',
                message: `Plugin version "${plugin.version}" does not match manifest version "${manifest.version}"`,
                expected: manifest.version,
                actual: plugin.version,
            });
        }

        // Check category matches
        if (plugin.category !== manifest.category) {
            errors.push({
                path: 'category',
                message: `Plugin category "${plugin.category}" does not match manifest category "${manifest.category}"`,
                expected: manifest.category,
                actual: plugin.category,
            });
        }

        // Check capabilities match
        const pluginCaps = new Set(plugin.capabilities);
        const manifestCaps = new Set(manifest.capabilities);

        for (const cap of manifestCaps) {
            if (!pluginCaps.has(cap)) {
                errors.push({
                    path: `capabilities`,
                    message: `Plugin does not implement capability "${cap}" declared in manifest`,
                    expected: cap,
                });
            }
        }

        for (const cap of pluginCaps) {
            if (!manifestCaps.has(cap)) {
                warnings.push({
                    path: `capabilities`,
                    message: `Plugin implements capability "${cap}" not declared in manifest`,
                    actual: cap,
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Perform full validation of a plugin
     */
    validate(plugin: unknown, manifest?: PluginManifest): ValidationResult {
        // First validate basic IPlugin implementation
        const pluginResult = this.validatePlugin(plugin);
        if (!pluginResult.valid) {
            return pluginResult;
        }

        const validPlugin = plugin as IPlugin;
        const allErrors: ValidationError[] = [...(pluginResult.errors || [])];
        const allWarnings: ValidationError[] = [...(pluginResult.warnings || [])];

        // Validate capability implementations
        const capabilityResult = this.validateCapabilities(validPlugin);
        allErrors.push(...(capabilityResult.errors || []));
        allWarnings.push(...(capabilityResult.warnings || []));

        // Validate against manifest if provided
        if (manifest) {
            const manifestResult = this.validateAgainstManifest(validPlugin, manifest);
            allErrors.push(...(manifestResult.errors || []));
            allWarnings.push(...(manifestResult.warnings || []));
        }

        return {
            valid: allErrors.length === 0,
            errors: allErrors.length > 0 ? allErrors : undefined,
            warnings: allWarnings.length > 0 ? allWarnings : undefined,
        };
    }

    /**
     * Type guard check - returns true if object is a valid IPlugin
     */
    isPlugin(obj: unknown): obj is IPlugin {
        return isIPlugin(obj);
    }

    /**
     * Type guard check - returns true if object is a plugin class
     */
    isPluginClass(obj: unknown): obj is new () => IPlugin {
        return isPluginClass(obj);
    }

    private checkRequiredProperty(
        obj: Record<string, unknown>,
        name: string,
        expectedType: string,
        errors: ValidationError[],
    ): void {
        if (obj[name] === undefined) {
            errors.push({
                path: name,
                message: `Plugin must have "${name}" property`,
                expected: expectedType,
            });
        } else if (typeof obj[name] !== expectedType) {
            errors.push({
                path: name,
                message: `Plugin "${name}" must be a ${expectedType}`,
                expected: expectedType,
                actual: typeof obj[name],
            });
        }
    }

    private checkRequiredMethod(
        obj: Record<string, unknown>,
        name: string,
        errors: ValidationError[],
    ): void {
        if (typeof obj[name] !== 'function') {
            errors.push({
                path: name,
                message: `Plugin must implement "${name}" method`,
                expected: 'function',
                actual: typeof obj[name],
            });
        }
    }
}
