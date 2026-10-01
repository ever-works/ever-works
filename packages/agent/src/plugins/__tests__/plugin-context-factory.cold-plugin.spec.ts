import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Cache } from 'cache-manager';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';
import type { PluginSettingsService } from '../services/plugin-settings.service';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import { createRegistry, registerColdPlugin, requiredSecretSchema } from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const ENV_KEY = 'COLD_CONTEXT_FIXTURE_API_KEY';

/**
 * `context.envVars` only lets a plugin read the env vars its OWN settings
 * schema declares (`x-envVar`). The allow-list must come from the plugin
 * class's schema — a context built while the registry still held the plugin
 * as a cold lazy proxy (schema `{}`) must not lock the plugin out of its own
 * declared variables once it runs.
 */
describe('PluginContextFactoryService — context built for a cold lazy plugin', () => {
    afterEach(() => {
        delete process.env[ENV_KEY];
        delete process.env.COLD_CONTEXT_UNDECLARED;
    });

    function buildFactory() {
        const registry = createRegistry();
        const factory = new PluginContextFactoryService(
            { platformVersion: '1.0.0', environment: 'test' },
            registry,
            {} as PluginSettingsService,
            new CustomCapabilityRegistryService(),
            new EventEmitter2(),
            { get: jest.fn(), set: jest.fn(), del: jest.fn() } as unknown as Cache,
        );
        return { registry, factory };
    }

    it('lets the plugin read its declared x-envVar once it has materialised', async () => {
        process.env[ENV_KEY] = 'declared-value';
        process.env.COLD_CONTEXT_UNDECLARED = 'must-stay-hidden';
        const { registry, factory } = buildFactory();
        const cold = registerColdPlugin(registry, {
            id: 'cold-context-env',
            settingsSchema: requiredSecretSchema(ENV_KEY),
        });

        const context = factory.createContext('cold-context-env');
        await cold.proxy.__materialize();

        expect(context.envVars.get(ENV_KEY)).toBe('declared-value');
        expect(context.envVars.has(ENV_KEY)).toBe(true);
        // Still fail-closed for everything the schema does not declare.
        expect(context.envVars.get('COLD_CONTEXT_UNDECLARED')).toBeUndefined();
    });
});
