import { EventEmitter2 } from '@nestjs/event-emitter';
import type { JsonSchema } from '@ever-works/plugin';
import { PluginPlatformSettingsService } from '../plugin-platform-settings.service';
import { PluginSettingsService } from '../plugin-settings.service';
import { SettingsSchemaValidatorService } from '../settings-schema-validator.service';
import type { PluginRegistryService } from '../plugin-registry.service';
import type { PluginRepository } from '../../repositories/plugin.repository';
import type { UserPluginRepository } from '../../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../../repositories/work-plugin.repository';

/**
 * The settings level of values Ever Platform handed a connected installation
 * (for the Ever ID sign-in plugin: issuer, client id, client secret):
 *
 * - below every value an operator set (admin settings, then the environment),
 *   above the plugin's default, reported as `platform`;
 * - held to the property schema like an env value (an off-pattern value is
 *   ignored); a secret is not judged;
 * - with no source registered — or a failing one — nothing changes.
 */
const ENV = { url: 'EW_PLATFORM_SPEC_ISSUER_URL', client: 'EW_PLATFORM_SPEC_CLIENT_ID' };
const PLUGIN = 'platform-level-plugin';

const SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
        issuerUrl: { type: 'string', pattern: '^https://', 'x-envVar': ENV.url },
        clientId: { type: 'string', 'x-envVar': ENV.client },
        clientSecret: { type: 'string', 'x-secret': true },
        displayName: { type: 'string', default: 'Ever ID' },
    },
} as JsonSchema;

function build(
    platform: PluginPlatformSettingsService | undefined,
    admin: Record<string, unknown> = {},
) {
    const registry = {
        get: jest.fn(() => ({ plugin: { id: PLUGIN, settingsSchema: SCHEMA }, state: 'loaded' })),
    } as unknown as PluginRegistryService;
    const pluginRepository = {
        findByPluginId: jest.fn(async () => ({ settings: admin, secretSettings: {} })),
    } as unknown as PluginRepository;
    const userPluginRepository = {
        findByUserAndPlugin: jest.fn(async () => null),
    } as unknown as UserPluginRepository;
    const workPluginRepository = {
        findByWorkAndPlugin: jest.fn(async () => null),
    } as unknown as WorkPluginRepository;
    return new PluginSettingsService(
        registry,
        pluginRepository,
        userPluginRepository,
        workPluginRepository,
        new EventEmitter2(),
        new SettingsSchemaValidatorService(),
        undefined,
        platform,
    );
}

describe('PluginSettingsService — values Ever Platform handed the installation', () => {
    afterEach(() => {
        for (const name of Object.values(ENV)) delete process.env[name];
    });

    const handedOver = {
        issuerUrl: 'https://id.example.test',
        clientId: 'inst-01K6A7S2ABCDEFGHJKMNPQRSTV',
        clientSecret: 'ics_secret',
    };

    it('fills what no operator set, as `platform`', async () => {
        const platform = new PluginPlatformSettingsService();
        platform.register(PLUGIN, async () => handedOver);
        const resolved = await build(platform).getResolvedSettings(PLUGIN, {
            includeSecrets: true,
        });

        expect(resolved.issuerUrl).toMatchObject({
            source: 'platform',
            value: handedOver.issuerUrl,
        });
        expect(resolved.clientId).toMatchObject({ source: 'platform', value: handedOver.clientId });
        expect(resolved.clientSecret).toMatchObject({ source: 'platform', value: 'ics_secret' });
        expect(resolved.displayName).toMatchObject({ source: 'default', value: 'Ever ID' });
    });

    it('the environment and admin settings win over it', async () => {
        process.env[ENV.client] = 'hand-made-client';
        const platform = new PluginPlatformSettingsService();
        platform.register(PLUGIN, async () => ({
            ...handedOver,
            displayName: 'From the platform',
        }));
        const resolved = await build(platform, { displayName: 'Ours' }).getResolvedSettings(PLUGIN);

        expect(resolved.clientId).toMatchObject({ source: 'env', value: 'hand-made-client' });
        expect(resolved.displayName).toMatchObject({ source: 'admin', value: 'Ours' });
    });

    it('an off-pattern value is ignored, like an env value', async () => {
        const platform = new PluginPlatformSettingsService();
        platform.register(PLUGIN, async () => ({ issuerUrl: 'http://plain.example.test' }));
        const resolved = await build(platform).getResolvedSettings(PLUGIN);
        expect(resolved.issuerUrl).toMatchObject({ source: 'default', value: undefined });
    });

    it('no source, a removed source or a failing source changes nothing', async () => {
        expect((await build(undefined).getResolvedSettings(PLUGIN)).clientId.source).toBe(
            'default',
        );

        const platform = new PluginPlatformSettingsService();
        const unregister = platform.register(PLUGIN, async () => handedOver);
        unregister();
        expect((await build(platform).getResolvedSettings(PLUGIN)).clientId.source).toBe('default');

        platform.register(PLUGIN, async () => {
            throw new Error('unreadable');
        });
        expect((await build(platform).getResolvedSettings(PLUGIN)).clientId.source).toBe('default');
    });
});
