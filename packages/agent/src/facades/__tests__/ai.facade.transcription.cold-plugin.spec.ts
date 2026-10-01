import { Logger } from '@nestjs/common';
import { AiFacadeService } from '../ai.facade';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { PluginUsageService } from '../../usage/plugin-usage.service';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import {
    createRegistry,
    registerColdPlugin,
    type ColdPluginSpec,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * PLG-3 — `transcribe()` is an OPTIONAL member of `IAiProviderPlugin`; only
 * openai implements it. The registry holds every disk-discovered AI provider
 * as a lazy proxy, and a COLD proxy answers `typeof proxy.transcribe ===
 * 'function'` for every provider (its `get` trap answers a forwarding wrapper
 * for any member). Probed that way, step 3 of the transcription selection
 * picked the first cold non-active provider (anthropic registers before
 * openai), whose `transcribe` then failed; the provider listing offered every
 * cold AI provider as a voice provider.
 */

const TRANSCRIPT = { text: 'hello world', model: 'whisper-1', durationSeconds: 12 };

function aiProvider(
    id: string,
    extra: Partial<ColdPluginSpec> & { transcribe?: jest.Mock } = {},
): ColdPluginSpec {
    const { transcribe, ...spec } = extra;
    return {
        id,
        category: 'ai-provider',
        capabilities: ['ai-provider'],
        settingsSchema: { type: 'object', properties: {} } as never,
        builtIn: true,
        ...spec,
        members: {
            providerName: id,
            isAvailable: async () => true,
            ...(transcribe ? { transcribe } : {}),
            ...(spec.members ?? {}),
        },
    };
}

/**
 * A default user's registry: openrouter is the scope-active provider
 * (`autoEnable` + `systemPlugin`, no transcribe); anthropic (no transcribe)
 * registers before openai (transcribe). Nothing is pinned.
 */
function setup() {
    const registry = createRegistry();
    const transcribe = jest.fn().mockResolvedValue(TRANSCRIPT);
    const anthropic = registerColdPlugin(registry, aiProvider('anthropic'));
    const openai = registerColdPlugin(registry, aiProvider('openai', { transcribe }));
    registerColdPlugin(
        registry,
        aiProvider('openrouter', { manifest: { autoEnable: true, systemPlugin: true } }),
    );
    const facade = facadeFor(registry);
    return { registry, facade, transcribe, anthropic, openai };
}

function facadeFor(registry: PluginRegistryService): AiFacadeService {
    const settings = {
        getSettings: jest.fn().mockResolvedValue({}),
        getResolvedSettings: jest.fn().mockResolvedValue({}),
    };
    return new AiFacadeService(
        registry,
        settings as unknown as PluginSettingsService,
        {
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        } as unknown as WorkPluginRepository,
        { record: jest.fn().mockResolvedValue(null) } as unknown as PluginUsageService,
    );
}

describe('AiFacadeService — transcription over cold lazy AI providers', () => {
    it('falls back to the provider that REALLY implements transcribe, not the first cold one', async () => {
        const { facade, transcribe } = setup();

        await expect(
            facade.transcribe(
                { file: new Uint8Array([1, 2, 3]), filename: 'clip.mp3' },
                { userId: 'user-1' },
            ),
        ).resolves.toEqual(TRANSCRIPT);
        expect(transcribe).toHaveBeenCalledTimes(1);
    });

    it('skips a candidate whose first load fails and still finds the transcriber', async () => {
        const registry = createRegistry();
        const transcribe = jest.fn().mockResolvedValue(TRANSCRIPT);
        registerColdPlugin(registry, aiProvider('anthropic', { onLoadFails: true }));
        registerColdPlugin(registry, aiProvider('openai', { transcribe }));
        registerColdPlugin(
            registry,
            aiProvider('openrouter', { manifest: { autoEnable: true, systemPlugin: true } }),
        );

        await expect(
            facadeFor(registry).transcribe(
                { file: new Uint8Array([1]), filename: 'clip.mp3' },
                { userId: 'user-1' },
            ),
        ).resolves.toEqual(TRANSCRIPT);
        expect(transcribe).toHaveBeenCalledTimes(1);
    });

    it('still answers TranscriptionNotConfiguredError when no loaded provider implements transcribe', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, aiProvider('anthropic'));
        registerColdPlugin(registry, aiProvider('google'));
        registerColdPlugin(
            registry,
            aiProvider('openrouter', { manifest: { autoEnable: true, systemPlugin: true } }),
        );

        await expect(
            facadeFor(registry).transcribe(
                { file: new Uint8Array([1]), filename: 'clip.mp3' },
                { userId: 'user-1' },
            ),
        ).rejects.toMatchObject({ name: 'TranscriptionNotConfiguredError' });
    });

    it('lists only the providers that really implement transcribe', async () => {
        const { facade } = setup();

        const providers = await facade.listTranscriptionProviders({ userId: 'user-1' });

        expect(providers).toEqual([{ id: 'openai', name: 'Plugin openai', isActive: false }]);
    });

    it('marks the scope-active provider when it transcribes', async () => {
        const registry = createRegistry();
        const transcribe = jest.fn().mockResolvedValue(TRANSCRIPT);
        registerColdPlugin(registry, aiProvider('anthropic'));
        registerColdPlugin(
            registry,
            aiProvider('openai', { transcribe, manifest: { autoEnable: true } }),
        );

        const providers = await facadeFor(registry).listTranscriptionProviders({
            userId: 'user-1',
        });

        expect(providers).toEqual([{ id: 'openai', name: 'Plugin openai', isActive: true }]);
    });

    it('leaves a cold, unused non-builtIn provider cold (and unlisted) — a listing does not import it', async () => {
        const registry = createRegistry();
        const transcribe = jest.fn().mockResolvedValue(TRANSCRIPT);
        registerColdPlugin(registry, aiProvider('openai', { transcribe }));
        const thirdParty = registerColdPlugin(
            registry,
            aiProvider('third-party-stt', { transcribe, builtIn: false }),
        );
        registerColdPlugin(
            registry,
            aiProvider('openrouter', { manifest: { autoEnable: true, systemPlugin: true } }),
        );

        const providers = await facadeFor(registry).listTranscriptionProviders({
            userId: 'user-1',
        });

        expect(providers.map((p) => p.id)).toEqual(['openai']);
        expect(thirdParty.loads()).toBe(0);
    });
});
