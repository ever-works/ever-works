import { Test, TestingModule } from '@nestjs/testing';
import { PluginManifestValidatorService } from '../services/plugin-manifest-validator.service';

describe('PluginManifestValidatorService', () => {
    let service: PluginManifestValidatorService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [PluginManifestValidatorService],
        }).compile();

        service = module.get<PluginManifestValidatorService>(PluginManifestValidatorService);
    });

    describe('validate', () => {
        it('should validate a valid manifest', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
                capabilities: ['test'],
                description: 'A test plugin',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        it('should reject manifest without required fields', () => {
            const manifest = {
                name: 'Test Plugin',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors?.some((e) => e.path === 'id')).toBe(true);
            expect(result.errors?.some((e) => e.path === 'version')).toBe(true);
            expect(result.errors?.some((e) => e.path === 'category')).toBe(true);
        });

        it('should reject invalid plugin ID format', () => {
            const manifest = {
                id: 'Invalid_Plugin_ID',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'id')).toBe(true);
        });

        it('should reject short plugin ID', () => {
            const manifest = {
                id: 'ab',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('at least 3 characters'))).toBe(
                true,
            );
        });

        it('should reject invalid version format', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: 'not-semver',
                category: 'utility',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'version')).toBe(true);
        });

        it('should reject invalid category', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'invalid-category',
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'category')).toBe(true);
        });

        it('should validate all valid categories', () => {
            const categories = [
                'git-provider',
                'deployment',
                'screenshot',
                'search',
                'content-extractor',
                'data-source',
                'ai-provider',
                'pipeline',
                'form',
                'integration',
                'utility',
                'theme',
            ];

            for (const category of categories) {
                const manifest = {
                    id: 'test-plugin',
                    name: 'Test Plugin',
                    version: '1.0.0',
                    category,
                };

                const result = service.validate(manifest);
                expect(result.valid).toBe(true);
            }
        });

        it('should warn about deprecated plugins without deprecation message', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
                deprecated: true,
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(true);
            expect(result.warnings).toBeDefined();
            expect(result.warnings?.some((w) => w.path === 'deprecationMessage')).toBe(true);
        });

        it('should validate capabilities array', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
                capabilities: [123, 'valid'],
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path.includes('capabilities'))).toBe(true);
        });

        it('should validate dependencies format', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
                dependencies: {
                    'another-plugin': '^1.0.0',
                },
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(true);
        });

        it('should reject non-string dependency versions', () => {
            const manifest = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                category: 'utility',
                dependencies: {
                    'another-plugin': 123,
                },
            };

            const result = service.validate(manifest);
            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path.includes('dependencies'))).toBe(true);
        });
    });

    describe('extractManifest', () => {
        it('should extract manifest from package.json', () => {
            const packageJson = {
                name: 'my-package',
                version: '2.0.0',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        name: 'My Plugin',
                        version: '1.0.0',
                        category: 'utility',
                        capabilities: ['test'],
                    },
                },
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeDefined();
            expect(manifest?.id).toBe('my-plugin');
            expect(manifest?.name).toBe('My Plugin');
            expect(manifest?.version).toBe('1.0.0');
            expect(manifest?.category).toBe('utility');
        });

        it('should return null if no everworks.plugin field', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeNull();
        });

        it('should merge with package.json fields', () => {
            const packageJson = {
                name: 'my-package',
                version: '2.0.0',
                description: 'Package description',
                license: 'MIT',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeDefined();
            expect(manifest?.name).toBe('my-package');
            expect(manifest?.version).toBe('2.0.0');
            expect(manifest?.description).toBe('Package description');
            expect(manifest?.license).toBe('MIT');
        });

        it('should not produce undefined keys when neither source has optional fields', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson) as unknown as Record<
                string,
                unknown
            >;
            expect(manifest).toBeDefined();

            // homepage and license should not exist as keys at all
            expect('homepage' in manifest).toBe(false);
            expect('license' in manifest).toBe(false);
        });

        it('should include homepage from plugin section when present', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                        homepage: 'https://example.com/plugin',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeDefined();
            expect((manifest as any).homepage).toBe('https://example.com/plugin');
        });

        it('should fall back to top-level homepage when plugin section lacks it', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
                homepage: 'https://example.com/top-level',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeDefined();
            expect((manifest as any).homepage).toBe('https://example.com/top-level');
        });

        it('should prefer plugin section homepage over top-level package.json', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
                homepage: 'https://example.com/top-level',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                        homepage: 'https://example.com/plugin',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson);
            expect(manifest).toBeDefined();
            expect((manifest as any).homepage).toBe('https://example.com/plugin');
        });

        it('should not produce undefined keys for any fallback field', () => {
            // Minimal package.json with no optional fields at either level
            const packageJson = {
                everworks: {
                    plugin: {
                        id: 'minimal-plugin',
                        category: 'utility',
                    },
                },
            };

            const manifest = service.extractManifest(packageJson) as unknown as Record<
                string,
                unknown
            >;
            expect(manifest).toBeDefined();

            // None of these should be explicit undefined keys
            for (const key of ['name', 'version', 'description', 'homepage', 'license']) {
                if (key in manifest) {
                    expect(manifest[key]).not.toBeUndefined();
                }
            }
        });

        it('should preserve extra plugin fields from the spread', () => {
            const packageJson = {
                name: 'my-package',
                version: '1.0.0',
                everworks: {
                    plugin: {
                        id: 'my-plugin',
                        category: 'utility',
                        customField: 'custom-value',
                        icon: { type: 'emoji', value: '🔌' },
                    },
                },
            };

            const manifest = service.extractManifest(packageJson) as unknown as Record<
                string,
                unknown
            >;
            expect(manifest).toBeDefined();
            expect(manifest.customField).toBe('custom-value');
            expect(manifest.icon).toEqual({ type: 'emoji', value: '🔌' });
        });
    });

    describe('validateAndExtract', () => {
        it('should validate and extract valid manifest', () => {
            const packageJson = {
                everworks: {
                    plugin: {
                        id: 'test-plugin',
                        name: 'Test Plugin',
                        version: '1.0.0',
                        category: 'utility',
                    },
                },
            };

            const { manifest, validation } = service.validateAndExtract(packageJson);
            expect(validation.valid).toBe(true);
            expect(manifest).toBeDefined();
            expect(manifest?.id).toBe('test-plugin');
        });

        it('should return null manifest for invalid package', () => {
            const packageJson = {
                name: 'not-a-plugin',
            };

            const { manifest, validation } = service.validateAndExtract(packageJson);
            expect(validation.valid).toBe(false);
            expect(manifest).toBeNull();
        });
    });
});
