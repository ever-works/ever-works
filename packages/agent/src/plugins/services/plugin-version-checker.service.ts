import { Injectable, Inject, Logger } from '@nestjs/common';
import * as semver from 'semver';
import type { PluginManifest, ValidationResult, ValidationError } from '@ever-works/plugin';
import { PLUGINS_MODULE_OPTIONS, DEFAULT_PLATFORM_VERSION } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';

/**
 * Result of version compatibility check
 */
export interface VersionCheckResult extends ValidationResult {
    /**
     * Whether the plugin is compatible with the platform
     */
    compatible: boolean;

    /**
     * Whether all plugin dependencies are satisfied
     */
    dependenciesSatisfied: boolean;

    /**
     * Missing plugin dependencies
     */
    missingDependencies?: string[];

    /**
     * Dependencies with version conflicts
     */
    versionConflicts?: Array<{
        pluginId: string;
        required: string;
        installed: string;
    }>;
}

/**
 * Service for checking plugin version compatibility.
 * Validates minPlatformVersion/maxPlatformVersion and plugin dependencies.
 */
@Injectable()
export class PluginVersionCheckerService {
    private readonly logger = new Logger(PluginVersionCheckerService.name);
    private readonly platformVersion: string;

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        private readonly options: PluginsModuleOptions,
    ) {
        this.platformVersion = options.platformVersion || DEFAULT_PLATFORM_VERSION;
    }

    /**
     * Check platform version compatibility
     */
    checkPlatformCompatibility(manifest: PluginManifest): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        // Check minimum platform version
        if (manifest.minPlatformVersion) {
            if (!semver.valid(manifest.minPlatformVersion)) {
                errors.push({
                    path: 'minPlatformVersion',
                    message: `Invalid semver: ${manifest.minPlatformVersion}`,
                    actual: manifest.minPlatformVersion,
                });
            } else if (semver.lt(this.platformVersion, manifest.minPlatformVersion)) {
                errors.push({
                    path: 'minPlatformVersion',
                    message: `Plugin requires platform version >= ${manifest.minPlatformVersion}, but current version is ${this.platformVersion}`,
                    expected: `>= ${manifest.minPlatformVersion}`,
                    actual: this.platformVersion,
                });
            }
        }

        // Check maximum platform version
        if (manifest.maxPlatformVersion) {
            if (!semver.valid(manifest.maxPlatformVersion)) {
                errors.push({
                    path: 'maxPlatformVersion',
                    message: `Invalid semver: ${manifest.maxPlatformVersion}`,
                    actual: manifest.maxPlatformVersion,
                });
            } else if (semver.gt(this.platformVersion, manifest.maxPlatformVersion)) {
                warnings.push({
                    path: 'maxPlatformVersion',
                    message: `Plugin was designed for platform version <= ${manifest.maxPlatformVersion}, but current version is ${this.platformVersion}. Some features may not work correctly.`,
                    expected: `<= ${manifest.maxPlatformVersion}`,
                    actual: this.platformVersion,
                });
            }
        }

        // Warn about deprecated plugins
        if (manifest.deprecated) {
            warnings.push({
                path: 'deprecated',
                message:
                    manifest.deprecationMessage ||
                    'This plugin is deprecated and may be removed in a future version',
            });
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Check plugin dependencies against loaded plugins
     */
    checkDependencies(
        manifest: PluginManifest,
        loadedPlugins: Map<string, { version: string }>,
    ): VersionCheckResult {
        const errors: ValidationError[] = [];
        const missingDependencies: string[] = [];
        const versionConflicts: Array<{
            pluginId: string;
            required: string;
            installed: string;
        }> = [];

        if (!manifest.dependencies) {
            return {
                valid: true,
                compatible: true,
                dependenciesSatisfied: true,
            };
        }

        for (const [depId, versionRange] of Object.entries(manifest.dependencies)) {
            const installedPlugin = loadedPlugins.get(depId);

            if (!installedPlugin) {
                missingDependencies.push(depId);
                errors.push({
                    path: `dependencies.${depId}`,
                    message: `Required plugin "${depId}" is not installed`,
                    expected: versionRange,
                });
                continue;
            }

            // Check version compatibility
            if (!semver.satisfies(installedPlugin.version, versionRange)) {
                versionConflicts.push({
                    pluginId: depId,
                    required: versionRange,
                    installed: installedPlugin.version,
                });
                errors.push({
                    path: `dependencies.${depId}`,
                    message: `Plugin "${depId}" version ${installedPlugin.version} does not satisfy required version ${versionRange}`,
                    expected: versionRange,
                    actual: installedPlugin.version,
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            compatible: true,
            dependenciesSatisfied:
                missingDependencies.length === 0 && versionConflicts.length === 0,
            missingDependencies: missingDependencies.length > 0 ? missingDependencies : undefined,
            versionConflicts: versionConflicts.length > 0 ? versionConflicts : undefined,
        };
    }

    /**
     * Perform full version check (platform compatibility + dependencies)
     */
    check(
        manifest: PluginManifest,
        loadedPlugins: Map<string, { version: string }>,
    ): VersionCheckResult {
        const platformResult = this.checkPlatformCompatibility(manifest);
        const dependencyResult = this.checkDependencies(manifest, loadedPlugins);

        const errors = [...(platformResult.errors || []), ...(dependencyResult.errors || [])];
        const warnings = [...(platformResult.warnings || []), ...(dependencyResult.warnings || [])];

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
            compatible: platformResult.valid,
            dependenciesSatisfied: dependencyResult.dependenciesSatisfied,
            missingDependencies: dependencyResult.missingDependencies,
            versionConflicts: dependencyResult.versionConflicts,
        };
    }

    /**
     * Get the current platform version
     */
    getPlatformVersion(): string {
        return this.platformVersion;
    }

    /**
     * Check if a version satisfies a range
     */
    satisfies(version: string, range: string): boolean {
        return semver.satisfies(version, range);
    }

    /**
     * Compare two versions
     * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
     */
    compare(v1: string, v2: string): -1 | 0 | 1 {
        return semver.compare(v1, v2);
    }

    /**
     * Check if v1 is greater than v2
     */
    isNewer(v1: string, v2: string): boolean {
        return semver.gt(v1, v2);
    }
}
