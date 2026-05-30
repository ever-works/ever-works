import { Injectable, Inject, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import pickBy from 'lodash/pickBy';
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
import type { OnFirstMaterialize, OnMaterializeError } from './lazy-plugin-proxy';

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
 * Dependency node for topological sorting
 */
interface DependencyNode {
    id: string;
    plugin: DiscoveredPlugin | PluginModule;
    builtIn: boolean;
    dependencies: string[];
    visited: boolean;
    visiting: boolean;
}

/**
 * Service for discovering and loading plugins.
 * Scans file system paths and loads plugin modules.
 */
@Injectable()
export class PluginLoaderService {
    private readonly logger = new Logger(PluginLoaderService.name);
    private readonly pluginPaths: string[];
    /**
     * Hook invoked the first time a lazily-registered plugin materializes.
     * Wired by PluginBootstrapService so the lifecycle manager can fire its
     * onLoad bookkeeping (event emit, state history, error capture) on the
     * first real use rather than at boot.
     */
    private onFirstMaterialize?: OnFirstMaterialize;
    /**
     * Hook invoked when a lazily-registered plugin's loader throws. Wired by
     * PluginBootstrapService to mark the plugin's state as `'error'` so
     * readiness filters stop returning the broken stub.
     */
    private onMaterializeError?: OnMaterializeError;

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

    setOnFirstMaterialize(hook: OnFirstMaterialize): void {
        this.onFirstMaterialize = hook;
    }

    setOnMaterializeError(hook: OnMaterializeError): void {
        this.onMaterializeError = hook;
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
                    const plugins = await this.scanWork(resolvedPath);
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
     * Scan a work for plugins
     */
    private async scanWork(dirPath: string): Promise<DiscoveredPlugin[]> {
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
            this.logger.error(`Error scanning work ${dirPath}:`, error);
        }

        return discovered;
    }

    /**
     * Try to load a plugin manifest from a package work
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
        let { manifest, path: pluginPath } = discovered;
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

            // Merge runtime manifest from plugin class (provides readme, icon overrides, etc.)
            // Runtime manifest fills in fields not defined in package.json
            if (typeof plugin.getManifest === 'function') {
                const runtimeManifest = plugin.getManifest();
                // Only keep defined values from package.json manifest to avoid
                // overriding runtime values (e.g. homepage, icon) with undefined
                const definedManifest = pickBy(
                    manifest as unknown as Record<string, unknown>,
                    (v) => v !== undefined,
                );
                manifest = { ...runtimeManifest, ...definedManifest } as typeof manifest;
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

                // Merge with runtime manifest if available (same as external plugins)
                if (typeof plugin.getManifest === 'function') {
                    const runtimeManifest = plugin.getManifest();
                    const definedManifest: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(manifest)) {
                        if (value !== undefined) {
                            definedManifest[key] = value;
                        }
                    }
                    manifest = { ...runtimeManifest, ...definedManifest } as typeof manifest;
                }
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
     * Discover and lazily register all plugins with dependency resolution.
     *
     * Manifest-only stubs are registered up-front (cheap fs reads only) so
     * capability / category queries work immediately. The actual `import()`
     * of each plugin's entry module is deferred until first use via the
     * lazy proxy; the lifecycle `onLoad` hook fires at first materialization
     * rather than at boot. Cuts API boot RSS for installs where most
     * plugins (39 on develop) are never exercised in a given session.
     */
    async discoverAndLoadAll(opts?: { lazy?: boolean }): Promise<{
        discovered: number;
        loaded: number;
        failed: number;
        results: LoadResult[];
    }> {
        const lazy = opts?.lazy ?? true;
        const discovered = await this.discover();
        const results: LoadResult[] = [];
        let loaded = 0;
        let failed = 0;

        // Build unified list of all plugins (built-in + discovered)
        const allPlugins: Array<{
            id: string;
            plugin: DiscoveredPlugin | PluginModule;
            builtIn: boolean;
        }> = [];

        // Add built-in plugins — instantiating just to read the manifest id;
        // they stay eagerly loaded because they're already bundled and have
        // no separate entry-point import to defer.
        if (this.options.builtInPlugins) {
            for (const pluginModule of this.options.builtInPlugins) {
                const plugin =
                    typeof pluginModule.plugin === 'function'
                        ? new (pluginModule.plugin as new () => IPlugin)()
                        : pluginModule.plugin;
                allPlugins.push({
                    id: plugin.id,
                    plugin: pluginModule,
                    builtIn: true,
                });
            }
        }

        // Add discovered plugins
        for (const discoveredPlugin of discovered) {
            allPlugins.push({
                id: discoveredPlugin.manifest.id,
                plugin: discoveredPlugin,
                builtIn: false,
            });
        }

        // Build dependency graph and perform topological sort
        const sortedPlugins = this.topologicalSort(allPlugins);

        // Register plugins in dependency order. Built-ins always use the
        // eager path (they're pre-constructed instances bundled with the
        // app — there's no entry-point import to defer). Filesystem-
        // discovered plugins use the lazy proxy unless the caller
        // explicitly asks for eager loading (PLUGIN_LAZY_LOAD=false kill
        // switch from bootstrap).
        for (const pluginInfo of sortedPlugins) {
            let result: LoadResult;
            if (pluginInfo.builtIn) {
                result = await this.loadBuiltIn(pluginInfo.plugin as PluginModule);
            } else if (lazy) {
                result = await this.registerLazy(pluginInfo.plugin as DiscoveredPlugin);
            } else {
                result = await this.load(pluginInfo.plugin as DiscoveredPlugin);
            }
            results.push(result);
            if (result.success) {
                loaded++;
            } else {
                failed++;
                this.logger.warn(
                    `Failed to ${lazy ? 'register' : 'load'} plugin "${result.pluginId || 'unknown'}": ${result.error || 'unknown error'}`,
                );
            }
        }

        this.logger.log(
            lazy
                ? `Plugin registration complete: ${loaded} registered, ${failed} failed out of ${allPlugins.length} total (discovered plugins materialize on first use)`
                : `Plugin loading complete: ${loaded} loaded, ${failed} failed out of ${allPlugins.length} total`,
        );

        return {
            discovered: discovered.length,
            loaded,
            failed,
            results,
        };
    }

    /**
     * Merge the runtime manifest from the plugin class with the package.json
     * manifest stored in the registry + DB. Mirrors the eager `load()` path's
     * inline merge at lines 237–246; runs at first materialization for lazy
     * plugins so fields like icon, homepage, readme don't go missing in the
     * admin UI for the lifetime of the install.
     */
    private async enrichManifestAfterMaterialize(
        pluginId: string,
        real: IPlugin,
        discovered: DiscoveredPlugin,
    ): Promise<void> {
        if (typeof real.getManifest !== 'function') return;
        try {
            const runtimeManifest = real.getManifest();
            const definedManifest = pickBy(
                discovered.manifest as unknown as Record<string, unknown>,
                (v) => v !== undefined,
            );
            const merged = { ...runtimeManifest, ...definedManifest } as typeof discovered.manifest;

            this.registry.updateRegisteredManifest(pluginId, merged);
            await this.pluginRepository.upsert({
                pluginId: merged.id,
                name: merged.name,
                version: merged.version,
                description: merged.description,
                category: merged.category,
                capabilities: [...merged.capabilities],
                manifest: merged as unknown as Record<string, unknown>,
                builtIn: discovered.builtIn,
                installPath: discovered.path,
                state: 'loaded',
            });
        } catch (error) {
            this.logger.warn(
                `Failed to enrich manifest for plugin ${pluginId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Register a discovered plugin as a lazy stub. The plugin's entry module
     * is not imported here — that happens on first method call via the proxy.
     */
    async registerLazy(discovered: DiscoveredPlugin): Promise<LoadResult> {
        const { manifest, path: pluginPath } = discovered;
        const warnings: string[] = [];

        try {
            if (this.registry.has(manifest.id)) {
                return {
                    success: false,
                    pluginId: manifest.id,
                    error: `Plugin "${manifest.id}" is already loaded`,
                };
            }

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

            // Capture hooks by value so unit tests can swap them.
            const userOnFirstMaterialize = this.onFirstMaterialize;
            const userOnMaterializeError = this.onMaterializeError;

            const loader = () => this.loadPluginModule(pluginPath, manifest);

            // Wrap onFirstMaterialize to fold the runtime manifest from the
            // plugin class (icon, homepage, readme, runtime overrides) into
            // both the in-memory registry entry and the DB row. The eager
            // load() path used to do this inline before the upsert; for lazy
            // loading we have to defer it to first materialization so we don't
            // lose those fields for the lifetime of the install.
            const onFirstMaterialize = async (id: string, real: IPlugin) => {
                await this.enrichManifestAfterMaterialize(id, real, discovered);
                if (userOnFirstMaterialize) {
                    await userOnFirstMaterialize(id, real);
                }
            };

            this.registry.registerLazy(manifest, loader, {
                builtIn: discovered.builtIn,
                installPath: pluginPath,
                onFirstMaterialize,
                onMaterializeError: userOnMaterializeError,
            });

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

            this.logger.debug(`Registered lazy plugin: ${manifest.id} v${manifest.version}`);

            return {
                success: true,
                pluginId: manifest.id,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to register plugin ${manifest.id}:`, error);
            return {
                success: false,
                pluginId: manifest.id,
                error: message,
            };
        }
    }

    /**
     * Perform topological sort on plugins based on dependencies
     */
    private topologicalSort(
        plugins: Array<{ id: string; plugin: DiscoveredPlugin | PluginModule; builtIn: boolean }>,
    ): Array<{ id: string; plugin: DiscoveredPlugin | PluginModule; builtIn: boolean }> {
        const nodes = new Map<string, DependencyNode>();

        // Build nodes
        for (const plugin of plugins) {
            const dependencies = this.extractDependencies(plugin.plugin, plugin.builtIn);
            nodes.set(plugin.id, {
                id: plugin.id,
                plugin: plugin.plugin,
                builtIn: plugin.builtIn,
                dependencies,
                visited: false,
                visiting: false,
            });
        }

        const sorted: Array<{
            id: string;
            plugin: DiscoveredPlugin | PluginModule;
            builtIn: boolean;
        }> = [];
        const visited = new Set<string>();

        // DFS with cycle detection
        const visit = (nodeId: string, stack: string[] = []): void => {
            const node = nodes.get(nodeId);
            if (!node || visited.has(nodeId)) return;

            if (stack.includes(nodeId)) {
                const cycle = stack.slice(stack.indexOf(nodeId)).concat(nodeId);
                throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
            }

            stack.push(nodeId);

            // Visit dependencies first
            for (const depId of node.dependencies) {
                if (!nodes.has(depId)) {
                    throw new Error(`Plugin "${nodeId}" depends on unknown plugin "${depId}"`);
                }
                visit(depId, stack);
            }

            stack.pop();
            visited.add(nodeId);
            sorted.push({
                id: node.id,
                plugin: node.plugin,
                builtIn: node.builtIn,
            });
        };

        // Visit all nodes
        for (const [id] of nodes) {
            visit(id);
        }

        return sorted;
    }

    /**
     * Extract dependencies from a plugin manifest
     */
    private extractDependencies(
        plugin: DiscoveredPlugin | PluginModule,
        builtIn: boolean,
    ): string[] {
        if (builtIn) {
            const manifest = (plugin as PluginModule).manifest;
            return manifest?.dependencies ? Object.keys(manifest.dependencies) : [];
        } else {
            const manifest = (plugin as DiscoveredPlugin).manifest;
            return manifest.dependencies ? Object.keys(manifest.dependencies) : [];
        }
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
