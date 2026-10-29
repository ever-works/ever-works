import { EventEmitter2 } from '@nestjs/event-emitter';
import type { JsonSchema } from '@ever-works/plugin';
import { PluginSettingsService } from '../plugin-settings.service';
import { SettingsSchemaValidatorService } from '../settings-schema-validator.service';
import type { PluginRegistryService } from '../plugin-registry.service';
import type { PluginRepository } from '../../repositories/plugin.repository';
import type { UserPluginRepository } from '../../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../../repositories/work-plugin.repository';

/**
 * C-14 (Gauzy Ever Works #34) — env-bound plugin settings are held to their own property schema.
 * They used to reach the plugin unvalidated: `EVER_ID_ALLOWED_ISSUERS` had no item limit and
 * `issuerUrl`'s pattern never ran. An invalid value is ignored and the setting falls back to
 * its default; secrets (BYOK fallbacks) are not judged.
 */
const ENV = {
    issuers: 'EW_C14_SPEC_ALLOWED_ISSUERS',
    url: 'EW_C14_SPEC_ISSUER_URL',
    key: 'EW_C14_SPEC_API_KEY',
};

const SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
        allowedIssuers: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 2,
            default: [],
            'x-envVar': ENV.issuers,
        },
        issuerUrl: {
            type: 'string',
            pattern: '^https://',
            default: 'https://id.example.test',
            'x-envVar': ENV.url,
        },
        apiKey: {
            type: 'string',
            pattern: '^sk-',
            'x-envVar': ENV.key,
            'x-secret': true,
        },
    },
} as JsonSchema;

function build(validator: SettingsSchemaValidatorService | undefined) {
    const registry = {
        get: jest.fn(() => ({
            plugin: { id: 'c14-plugin', settingsSchema: SCHEMA },
            state: 'loaded',
        })),
    } as unknown as PluginRegistryService;
    const pluginRepository = {
        findByPluginId: jest.fn(async () => null),
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
        validator,
    );
}

describe('PluginSettingsService — env-bound values are schema-validated (C-14)', () => {
    afterEach(() => {
        for (const name of Object.values(ENV)) delete process.env[name];
    });

    it('uses an env value that matches its property schema', async () => {
        process.env[ENV.issuers] = JSON.stringify(['https://a.test', 'https://b.test']);
        process.env[ENV.url] = 'https://issuer.test';
        const resolved = await build(new SettingsSchemaValidatorService()).getResolvedSettings(
            'c14-plugin',
        );

        expect(resolved.allowedIssuers).toMatchObject({
            source: 'env',
            value: ['https://a.test', 'https://b.test'],
        });
        expect(resolved.issuerUrl).toMatchObject({ source: 'env', value: 'https://issuer.test' });
    });

    it('ignores an env value over the item limit or off-pattern, falling back to the default', async () => {
        process.env[ENV.issuers] = JSON.stringify([
            'https://a.test',
            'https://b.test',
            'https://c.test',
        ]);
        process.env[ENV.url] = 'http://plain-http.test';
        const resolved = await build(new SettingsSchemaValidatorService()).getResolvedSettings(
            'c14-plugin',
        );

        expect(resolved.allowedIssuers).toMatchObject({ source: 'default', value: [] });
        expect(resolved.issuerUrl).toMatchObject({
            source: 'default',
            value: 'https://id.example.test',
        });
    });

    it('does not judge a secret env fallback, so a strict pattern cannot silently drop a BYOK key', async () => {
        process.env[ENV.key] = 'not-an-sk-key';
        const resolved = await build(new SettingsSchemaValidatorService()).getResolvedSettings(
            'c14-plugin',
            {
                includeSecrets: true,
            },
        );

        expect(resolved.apiKey).toMatchObject({ source: 'env', value: 'not-an-sk-key' });
    });

    it('keeps the old behaviour when no validator is wired (direct construction)', async () => {
        process.env[ENV.url] = 'http://plain-http.test';
        const resolved = await build(undefined).getResolvedSettings('c14-plugin');

        expect(resolved.issuerUrl).toMatchObject({
            source: 'env',
            value: 'http://plain-http.test',
        });
    });
});
