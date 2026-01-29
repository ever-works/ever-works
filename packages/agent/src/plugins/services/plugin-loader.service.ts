import { Injectable, Inject, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService, RegisteredPlugin } from './plugin-registry.service';
import { PluginManifestValidatorService } from './plugin-manifest-validator.service';
import { PluginVersionCheckerService } from './plugin-version-checker.service';
import { PluginClassValidatorService } from './plugin-class-validator.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { PLUGINS_MODULE_OPTIONS, DEFAULT_PLUGIN_PATHS } from '../plugins.constants';
import type {
    PluginsModuleOptions,
    PluginModule,
} from '../interfaces/plugins-module-options.interface';

/**
 * Result of plugin discovery
 */
export interface DiscoveredPlugin {
    /**
     * Path to the plugin package
     */
    path: string;

    /**
     * Parsed package.json
     */
    packageJson: Record<string, unknown>;

    /**
     * Extracted and validated manifest
     */
    manifest: PluginManifest;

    /**
     * Whether this is a built-in plugin
     */
    builtIn: boolean;
}

/**
 * Result of plugin loading
 */
export interface LoadResult {
    success: boolean;
    pluginId?: string;
    error?: string;
    warnings?: string[];
}

/**
 * Service for discovering and loading plugins.
 * Scans file system paths and loads plugin modules.
 */
@Injectable()
export class PluginLoaderService {
    private readonly logger = new Logger(PluginLoaderService.name);
    private readonly pluginPaths: string[];

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        private readonly options: PluginsModuleOptions,
        private readonly registry: PluginRegistryService,
        private readonly manifestValidator: PluginManifestValidatorService,
        private readonly versionChecker: PluginVersionCheckerService,
        private readonly classValidator: PluginClassValidatorService,
        private readonly pluginRepository: PluginRepository,
    ) {
        this.pluginPaths = options.pluginPaths || DEFAULT_PLUGIN_PATHS;
    }

    /**
     * Discover plugins in configured paths
     */
    async discover(): Promise<DiscoveredPlugin[]> {
        const discovered: DiscoveredPlugin[] = [];

        for (const pluginPath of this.pluginPaths) {
            try {
                const resolvedPath = path.isAbsolute(pluginPath)
                    ? pluginPath
                    : path.resolve(process.cwd(), pluginPath);

                const exists = await this.pathExists(resolvedPath);
                if (!exists) {
                    this.logger.debug(`Plugin path does not exist: ${resolvedPath}`);
                    continue;
                }

                const stats = await fs.stat(resolvedPath);
                if (stats.isDirectory()) {
                    const plugins = await this.scanDirectory(resolvedPath);
                    discovered.push(...plugins);
                }
            } catch (error) {
                this.logger.error(`Error scanning plugin path ${pluginPath}:`, error);
            }
        }

        this.logger.log(`Discovered ${discovered.length} plugins`);
        return discovered;
    }

    /**
     * Scan a directory for plugins
     */
    private async scanDirectory(dirPath: string): Promise<DiscoveredPlugin[]> {
        const discovered: DiscoveredPlugin[] = [];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const packagePath = path.join(dirPath, entry.name);
                const plugin = await this.tryLoadPluginManifest(packagePath);
                if (plugin) {
                    discovered.push(plugin);
                }
            }
        } catch (error) {
            this.logger.error(`Error scanning directory ${dirPath}:`, error);
        }

        return discovered;
    }

    /**
     * Try to load a plugin manifest from a package directory
     */
    private async tryLoadPluginManifest(packagePath: string): Promise<DiscoveredPlugin | null> {
        const packageJsonPath = path.join(packagePath, 'package.json');

        try {
            const content = await fs.readFile(packageJsonPath, 'utf-8');
            const packageJson = JSON.parse(content) as Record<string, unknown>;

            const { manifest, validation } = this.manifestValidator.validateAndExtract(packageJson);

            if (!validation.valid || !manifest) {
                // Not a plugin or invalid manifest
                return null;
            }

            // Log any validation warnings
            if (validation.warnings) {
                for (const warning of validation.warnings) {
                    this.logger.warn(`Plugin ${manifest.id}: ${warning.path}: ${warning.message}`);
                }
            }

            return {
                path: packagePath,
                packageJson,
                manifest,
                builtIn: manifest.builtIn || false,
            };
        } catch {
            // Not a valid package or no package.json
            return null;
        }
    }

    /**
     * Load a discovered plugin
     */
    async load(discovered: DiscoveredPlugin): Promise<LoadResult> {
        const { manifest, path: pluginPath } = discovered;
        const warnings: string[] = [];

        try {
            // Check if already registered
            if (this.registry.has(manifest.id)) {
                return {
                    success: false,
                    pluginId: manifest.id,
                    error: `Plugin "${manifest.id}" is already loaded`,
                };
            }

            // Check version compatibility
            const versionResult = this.versionChecker.check(
                manifest,
                this.registry.getVersionsMap(),
            );

            if (!versionResult.valid) {
                return {
                    success: false,
                    pluginId: manifest.id,
                    error: `Version check failed: ${versionResult.errors?.map((e) => e.message).join(', ')}`,
                };
            }

            if (versionResult.warnings) {
                warnings.push(...versionResult.warnings.map((w) => w.message));
            }

            // Load the plugin module
            const plugin = await this.loadPluginModule(pluginPath, manifest);
            if (!plugin) {
                return {
                    success: false,
                    pluginId: manifest.id,
                    error: 'Failed to load plugin module',
                };
            }

            // Validate the plugin class
            const classValidation = this.classValidator.validate(plugin, manifest);
            if (!classValidation.valid) {
                return {
                    success: false,
                    pluginId: manifest.id,
                    error: `Plugin validation failed: ${classValidation.errors?.map((e) => e.message).join(', ')}`,
                };
            }

            if (classValidation.warnings) {
                warnings.push(...classValidation.warnings.map((w) => w.message));
            }

            // Register the plugin
            this.registry.register(plugin, manifest, {
                builtIn: discovered.builtIn,
                installPath: pluginPath,
                state: 'loaded',
            });

            // Persist to database
            await this.pluginRepository.upsert({
                pluginId: manifest.id,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                category: manifest.category,
                capabilities: [...manifest.capabilities],
                manifest: manifest as unknown as Record<string, unknown>,
                builtIn: discovered.builtIn,
                installPath: pluginPath,
                state: 'loaded',
            });

            this.logger.log(`Loaded plugin: ${manifest.id} v${manifest.version}`);

            return {
                success: true,
                pluginId: manifest.id,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to load plugin ${manifest.id}:`, error);
            return {
                success: false,
                pluginId: manifest.id,
                error: message,
            };
        }
    }

    /**
     * Load a plugin module from disk
     */
    private async loadPluginModule(
        pluginPath: string,
        manifest: PluginManifest,
    ): Promise<IPlugin | null> {
        try {
            // Try to load from main entry point
            const packageJsonPath = path.join(pluginPath, 'package.json');
            const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<
                string,
                unknown
            >;

            const mainEntry =
                (packageJson.main as string) || (packageJson.module as string) || 'index.js';
            const entryPath = path.join(pluginPath, mainEntry);

            // Dynamic import
            const module = await import(entryPath);

            // Look for default export or named export matching plugin ID
            let PluginClass = module.default;
            if (!PluginClass && module[this.toPascalCase(manifest.id)]) {
                PluginClass = module[this.toPascalCase(manifest.id)];
            }

            // Try to find any exported class that looks like a plugin
            if (!PluginClass) {
                for (const key of Object.keys(module)) {
                    if (this.classValidator.isPluginClass(module[key])) {
                        PluginClass = module[key];
                        break;
                    }
                }
            }

            if (!PluginClass) {
                this.logger.error(`No plugin class found in ${entryPath}`);
                return null;
            }

            // Instantiate the plugin
            if (this.classValidator.isPluginClass(PluginClass)) {
                return new PluginClass();
            } else if (this.classValidator.isPlugin(PluginClass)) {
                // Already an instance
                return PluginClass;
            }

            this.logger.error(`Exported value is not a valid plugin: ${entryPath}`);
            return null;
        } catch (error) {
            this.logger.error(`Failed to load plugin module from ${pluginPath}:`, error);
            return null;
        }
    }

    /**
     * Load a built-in plugin module
     */
    async loadBuiltIn(pluginModule: PluginModule): Promise<LoadResult> {
        const warnings: string[] = [];

        try {
            // Get the plugin instance
            let plugin: IPlugin;
            if (typeof pluginModule.plugin === 'function') {
                // It's a class, instantiate it
                plugin = new (pluginModule.plugin as new () => IPlugin)();
            } else {
                plugin = pluginModule.plugin;
            }

            // Get or create manifest
            let manifest: PluginManifest;
            if (pluginModule.manifest) {
                const validation = this.manifestValidator.validate(pluginModule.manifest);
                if (!validation.valid) {
                    return {
                        success: false,
                        pluginId: plugin.id,
                        error: `Invalid manifest: ${validation.errors?.map((e) => e.message).join(', ')}`,
                    };
                }
                manifest = pluginModule.manifest as unknown as PluginManifest;
            } else if (typeof plugin.getManifest === 'function') {
                manifest = plugin.getManifest();
            } else {
                // Create manifest from plugin properties
                manifest = {
                    id: plugin.id,
                    name: plugin.name,
                    version: plugin.version,
                    category: plugin.category,
                    capabilities: plugin.capabilities,
                    description: '',
                    builtIn: true,
                } as PluginManifest;
            }

            // Check if already registered
            if (this.registry.has(plugin.id)) {
                return {
                    success: false,
                    pluginId: plugin.id,
                    error: `Plugin "${plugin.id}" is already loaded`,
                };
            }

            // Validate the plugin
            const classValidation = this.classValidator.validate(plugin, manifest);
            if (!classValidation.valid) {
                return {
                    success: false,
                    pluginId: plugin.id,
                    error: `Plugin validation failed: ${classValidation.errors?.map((e) => e.message).join(', ')}`,
                };
            }

            if (classValidation.warnings) {
                warnings.push(...classValidation.warnings.map((w) => w.message));
            }

            // Register the plugin
            this.registry.register(plugin, manifest, {
                builtIn: true,
                state: 'loaded',
            });

            // Persist to database
            await this.pluginRepository.upsert({
                pluginId: manifest.id,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                category: manifest.category,
                capabilities: [...manifest.capabilities],
                manifest: manifest as unknown as Record<string, unknown>,
                builtIn: true,
                state: 'loaded',
            });

            this.logger.log(`Loaded built-in plugin: ${manifest.id} v${manifest.version}`);

            return {
                success: true,
                pluginId: manifest.id,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error('Failed to load built-in plugin:', error);
            return {
                success: false,
                error: message,
            };
        }
    }

    /**
     * Load all built-in plugins
     */
    async loadAllBuiltIn(): Promise<LoadResult[]> {
        const results: LoadResult[] = [];
        const builtInPlugins = this.options.builtInPlugins || [];

        for (const pluginModule of builtInPlugins) {
            const result = await this.loadBuiltIn(pluginModule);
            results.push(result);
        }

        return results;
    }

    /**
     * Discover and load all plugins
     */
    async discoverAndLoadAll(): Promise<{
        discovered: number;
        loaded: number;
        failed: number;
        results: LoadResult[];
    }> {
        const discovered = await this.discover();
        const results: LoadResult[] = [];
        let loaded = 0;
        let failed = 0;

        // Load built-in plugins first
        if (this.options.autoLoadBuiltIn !== false) {
            const builtInResults = await this.loadAllBuiltIn();
            for (const result of builtInResults) {
                results.push(result);
                if (result.success) {
                    loaded++;
                } else {
                    failed++;
                }
            }
        }

        // Load discovered plugins
        for (const plugin of discovered) {
            const result = await this.load(plugin);
            results.push(result);
            if (result.success) {
                loaded++;
            } else {
                failed++;
            }
        }

        this.logger.log(
            `Plugin loading complete: ${loaded} loaded, ${failed} failed out of ${discovered.length + (this.options.builtInPlugins?.length || 0)} total`,
        );

        return {
            discovered: discovered.length,
            loaded,
            failed,
            results,
        };
    }

    /**
     * Unload a plugin
     */
    async unload(pluginId: string): Promise<boolean> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return false;
        }

        // Unregister from registry
        this.registry.unregister(pluginId);

        // Update database state
        await this.pluginRepository.updateState(pluginId, 'unloaded');

        this.logger.log(`Unloaded plugin: ${pluginId}`);
        return true;
    }

    /**
     * Reload a plugin
     */
    async reload(pluginId: string): Promise<LoadResult> {
        const registered = this.registry.get(pluginId);
        if (!registered) {
            return {
                success: false,
                pluginId,
                error: 'Plugin not found',
            };
        }

        // Unload first
        await this.unload(pluginId);

        // Reload from disk if external plugin
        if (registered.installPath) {
            const discovered = await this.tryLoadPluginManifest(registered.installPath);
            if (!discovered) {
                return {
                    success: false,
                    pluginId,
                    error: 'Plugin manifest no longer valid',
                };
            }
            return this.load(discovered);
        }

        // For built-in plugins, we can't reload (they need to be re-registered)
        return {
            success: false,
            pluginId,
            error: 'Built-in plugins cannot be reloaded',
        };
    }

    /**
     * Check if a path exists
     */
    private async pathExists(p: string): Promise<boolean> {
        try {
            await fs.access(p);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Convert kebab-case to PascalCase
     */
    private toPascalCase(str: string): string {
        return str
            .split('-')
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
    }
}
