import { Test, TestingModule } from '@nestjs/testing';
import { PluginVersionCheckerService } from '../services/plugin-version-checker.service';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginManifest } from '@ever-works/plugin';

describe('PluginVersionCheckerService', () => {
    let service: PluginVersionCheckerService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginVersionCheckerService,
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        platformVersion: '1.5.0',
                    },
                },
            ],
        }).compile();

        service = module.get<PluginVersionCheckerService>(PluginVersionCheckerService);
    });

    describe('checkPlatformCompatibility', () => {
        it('should pass for plugin with no version requirements', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
            };

            const result = service.checkPlatformCompatibility(manifest);
            expect(result.valid).toBe(true);
        });

        it('should pass for plugin with satisfied minPlatformVersion', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                minPlatformVersion: '1.0.0',
            };

            const result = service.checkPlatformCompatibility(manifest);
            expect(result.valid).toBe(true);
        });

        it('should fail for plugin with unsatisfied minPlatformVersion', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                minPlatformVersion: '2.0.0',
            };

            const result = service.checkPlatformCompatibility(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'minPlatformVersion')).toBe(true);
        });

        it('should pass with warning for plugin above maxPlatformVersion', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                maxPlatformVersion: '1.0.0',
            };

            const result = service.checkPlatformCompatibility(manifest);
            expect(result.valid).toBe(true);
            expect(result.warnings?.some((w) => w.path === 'maxPlatformVersion')).toBe(true);
        });

        it('should warn about deprecated plugins', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                deprecated: true,
                deprecationMessage: 'Use another plugin',
            };

            const result = service.checkPlatformCompatibility(manifest);
            expect(result.valid).toBe(true);
            expect(result.warnings?.some((w) => w.path === 'deprecated')).toBe(true);
        });
    });

    describe('checkDependencies', () => {
        it('should pass for plugin with no dependencies', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
            };

            const result = service.checkDependencies(manifest, new Map());
            expect(result.valid).toBe(true);
            expect(result.dependenciesSatisfied).toBe(true);
        });

        it('should pass for plugin with satisfied dependencies', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                dependencies: {
                    'dep-plugin': '^1.0.0',
                },
            };

            const loadedPlugins = new Map([['dep-plugin', { version: '1.2.0' }]]);

            const result = service.checkDependencies(manifest, loadedPlugins);
            expect(result.valid).toBe(true);
            expect(result.dependenciesSatisfied).toBe(true);
        });

        it('should fail for missing dependency', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                dependencies: {
                    'missing-plugin': '^1.0.0',
                },
            };

            const result = service.checkDependencies(manifest, new Map());
            expect(result.valid).toBe(false);
            expect(result.dependenciesSatisfied).toBe(false);
            expect(result.missingDependencies).toContain('missing-plugin');
        });

        it('should fail for version conflict', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                dependencies: {
                    'dep-plugin': '^2.0.0',
                },
            };

            const loadedPlugins = new Map([['dep-plugin', { version: '1.0.0' }]]);

            const result = service.checkDependencies(manifest, loadedPlugins);
            expect(result.valid).toBe(false);
            expect(result.dependenciesSatisfied).toBe(false);
            expect(result.versionConflicts).toHaveLength(1);
            expect(result.versionConflicts?.[0].pluginId).toBe('dep-plugin');
        });
    });

    describe('check', () => {
        it('should perform full validation', () => {
            const manifest: PluginManifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'Test',
                category: 'utility',
                capabilities: [],
                minPlatformVersion: '1.0.0',
                dependencies: {
                    'dep-plugin': '^1.0.0',
                },
            };

            const loadedPlugins = new Map([['dep-plugin', { version: '1.5.0' }]]);

            const result = service.check(manifest, loadedPlugins);
            expect(result.valid).toBe(true);
            expect(result.compatible).toBe(true);
            expect(result.dependenciesSatisfied).toBe(true);
        });
    });

    describe('utility methods', () => {
        it('getPlatformVersion should return configured version', () => {
            expect(service.getPlatformVersion()).toBe('1.5.0');
        });

        it('satisfies should check version ranges', () => {
            expect(service.satisfies('1.0.0', '^1.0.0')).toBe(true);
            expect(service.satisfies('2.0.0', '^1.0.0')).toBe(false);
            expect(service.satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
        });

        it('compare should compare versions', () => {
            expect(service.compare('1.0.0', '2.0.0')).toBe(-1);
            expect(service.compare('2.0.0', '1.0.0')).toBe(1);
            expect(service.compare('1.0.0', '1.0.0')).toBe(0);
        });

        it('isNewer should check if version is newer', () => {
            expect(service.isNewer('2.0.0', '1.0.0')).toBe(true);
            expect(service.isNewer('1.0.0', '2.0.0')).toBe(false);
        });
    });
});
