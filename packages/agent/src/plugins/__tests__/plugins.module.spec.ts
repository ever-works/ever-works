import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CacheModule } from '@nestjs/cache-manager';
import { Repository } from 'typeorm';
import { PluginsModule, PLUGIN_ENTITIES } from '../plugins.module';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import { PluginEntity } from '../entities/plugin.entity';
import { UserPluginEntity } from '../entities/user-plugin.entity';
import { DirectoryPluginEntity } from '../entities/directory-plugin.entity';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginSettingsService } from '../services/plugin-settings.service';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import { PluginBootstrapService } from '../services/plugin-bootstrap.service';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';

describe('PluginsModule', () => {
    describe('forRoot', () => {
        let module: TestingModule;

        beforeEach(async () => {
            module = await Test.createTestingModule({
                imports: [
                    TypeOrmModule.forRoot({
                        type: 'better-sqlite3',
                        database: ':memory:',
                        entities: PLUGIN_ENTITIES,
                        synchronize: true,
                    }),
                    EventEmitterModule.forRoot(),
                    CacheModule.register({ isGlobal: true }),
                    PluginsModule.forRoot({
                        platformVersion: '1.0.0',
                        autoLoadBuiltIn: false,
                        autoEnableOnLoad: false,
                        environment: 'test',
                    }),
                ],
            }).compile();
        });

        afterEach(async () => {
            if (module) {
                await module.close();
            }
        });

        it('should provide options', () => {
            const options = module.get<PluginsModuleOptions>(PLUGINS_MODULE_OPTIONS);
            expect(options).toBeDefined();
            expect(options.platformVersion).toBe('1.0.0');
            expect(options.environment).toBe('test');
        });

        it('should provide PluginRegistryService', () => {
            const service = module.get<PluginRegistryService>(PluginRegistryService);
            expect(service).toBeDefined();
        });

        it('should provide PluginLoaderService', () => {
            const service = module.get<PluginLoaderService>(PluginLoaderService);
            expect(service).toBeDefined();
        });

        it('should provide PluginLifecycleManagerService', () => {
            const service = module.get<PluginLifecycleManagerService>(
                PluginLifecycleManagerService,
            );
            expect(service).toBeDefined();
        });

        it('should provide PluginSettingsService', () => {
            const service = module.get<PluginSettingsService>(PluginSettingsService);
            expect(service).toBeDefined();
        });

        it('should provide PluginContextFactoryService', () => {
            const service = module.get<PluginContextFactoryService>(PluginContextFactoryService);
            expect(service).toBeDefined();
        });

        it('should provide CustomCapabilityRegistryService', () => {
            const service = module.get<CustomCapabilityRegistryService>(
                CustomCapabilityRegistryService,
            );
            expect(service).toBeDefined();
        });

        it('should provide PluginBootstrapService', () => {
            const service = module.get<PluginBootstrapService>(PluginBootstrapService);
            expect(service).toBeDefined();
        });

        it('should register plugin entities', () => {
            const pluginRepo = module.get<Repository<PluginEntity>>(
                getRepositoryToken(PluginEntity),
            );
            const userPluginRepo = module.get<Repository<UserPluginEntity>>(
                getRepositoryToken(UserPluginEntity),
            );
            const directoryPluginRepo = module.get<Repository<DirectoryPluginEntity>>(
                getRepositoryToken(DirectoryPluginEntity),
            );

            expect(pluginRepo).toBeDefined();
            expect(userPluginRepo).toBeDefined();
            expect(directoryPluginRepo).toBeDefined();
        });
    });

    describe('forRootAsync', () => {
        it('should support useFactory', async () => {
            const module = await Test.createTestingModule({
                imports: [
                    TypeOrmModule.forRoot({
                        type: 'better-sqlite3',
                        database: ':memory:',
                        entities: PLUGIN_ENTITIES,
                        synchronize: true,
                    }),
                    EventEmitterModule.forRoot(),
                    CacheModule.register({ isGlobal: true }),
                    PluginsModule.forRootAsync({
                        useFactory: () => ({
                            platformVersion: '2.0.0',
                            autoLoadBuiltIn: false,
                            environment: 'test',
                        }),
                    }),
                ],
            }).compile();

            const options = module.get<PluginsModuleOptions>(PLUGINS_MODULE_OPTIONS);
            expect(options.platformVersion).toBe('2.0.0');

            await module.close();
        });

        it('should support async useFactory', async () => {
            const module = await Test.createTestingModule({
                imports: [
                    TypeOrmModule.forRoot({
                        type: 'better-sqlite3',
                        database: ':memory:',
                        entities: PLUGIN_ENTITIES,
                        synchronize: true,
                    }),
                    EventEmitterModule.forRoot(),
                    CacheModule.register({ isGlobal: true }),
                    PluginsModule.forRootAsync({
                        useFactory: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 10));
                            return {
                                platformVersion: '3.0.0',
                                autoLoadBuiltIn: false,
                                environment: 'test',
                            };
                        },
                    }),
                ],
            }).compile();

            const options = module.get<PluginsModuleOptions>(PLUGINS_MODULE_OPTIONS);
            expect(options.platformVersion).toBe('3.0.0');

            await module.close();
        });
    });

    describe('default options', () => {
        it('should apply default options when not specified', async () => {
            const module = await Test.createTestingModule({
                imports: [
                    TypeOrmModule.forRoot({
                        type: 'better-sqlite3',
                        database: ':memory:',
                        entities: PLUGIN_ENTITIES,
                        synchronize: true,
                    }),
                    EventEmitterModule.forRoot(),
                    CacheModule.register({ isGlobal: true }),
                    PluginsModule.forRoot({
                        autoLoadBuiltIn: false, // Prevent actual loading during test
                    }),
                ],
            }).compile();

            const options = module.get<PluginsModuleOptions>(PLUGINS_MODULE_OPTIONS);

            expect(options.autoLoadBuiltIn).toBe(false);
            expect(options.autoEnableOnLoad).toBe(false);
            expect(options.environment).toBe('development');
            expect(options.encryptSecrets).toBe(true);
            expect(options.maxConcurrentLoads).toBe(5);
            expect(options.loadTimeout).toBe(30000);

            await module.close();
        });
    });
});
