import { Logger } from '@nestjs/common';
import { ContentExtractorFacadeService } from '../content-extractor.facade';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * Extractor selection skips an extractor whose required settings are not
 * configured. The required list comes from the plugin class's settings
 * schema — for an extractor the registry still holds as a COLD lazy proxy,
 * the proxy's `{}` must not make it look configured.
 */
describe('ContentExtractorFacadeService — cold lazy extractor', () => {
    function build(settings: Record<string, unknown>) {
        const registry = createRegistry();
        const extract = jest.fn().mockResolvedValue({
            success: true,
            url: 'https://example.com/page',
            content: 'extracted text',
        });
        const cold = registerColdPlugin(registry, {
            id: 'cold-extractor',
            category: 'content-extractor',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            members: {
                providerName: 'Cold Extractor',
                canExtract: async () => true,
                extract,
                // The facade calls `getPricing?.()` after a successful extract.
                getPricing: async () => ({ costPerCallCents: 0, currency: 'USD' }),
            },
        });
        const settingsService = {
            getSettings: jest.fn().mockResolvedValue(settings),
        } as unknown as PluginSettingsService;
        const facade = new ContentExtractorFacadeService(registry, settingsService);
        return { facade, extract, cold };
    }

    it('does not pick a cold extractor whose required API key is not configured', async () => {
        const { facade, extract } = build({});

        const result = await facade.extractContentWithDiagnostics(
            'https://example.com/page',
            undefined,
            { userId: 'user-1' },
        );

        expect(result.content).toBeNull();
        expect(extract).not.toHaveBeenCalled();
    });

    it('picks the cold extractor once its required API key is configured', async () => {
        const { facade, extract } = build({ apiKey: 'sk-extract' });

        const result = await facade.extractContentWithDiagnostics(
            'https://example.com/page',
            undefined,
            { userId: 'user-1' },
        );

        expect(extract).toHaveBeenCalledTimes(1);
        expect(result.content?.rawContent).toBe('extracted text');
    });
});

/**
 * Supplementary extractors (pdf-extractor, officecli-extractor) intercept the
 * URLs they recognise ahead of the user's chosen provider. Both set
 * `supplementary` only in their class's getManifest(), which a cold lazy
 * proxy's registry entry does not carry until the plugin loads.
 */
describe('ContentExtractorFacadeService — cold supplementary extractor', () => {
    function extractor(id: string, content: string, runtimeManifest?: Record<string, unknown>) {
        return {
            id,
            category: 'content-extractor',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest,
            members: {
                providerName: id,
                canExtract: async () => true,
                extract: jest.fn().mockResolvedValue({ success: true, url: 'u', content }),
                getPricing: async () => ({ costPerCallCents: 0, currency: 'USD' }),
            },
        };
    }

    it("intercepts its URL ahead of the user's chosen provider while cold", async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, extractor('cold-general', 'from the chosen provider'));
        registerColdPlugin(
            registry,
            extractor('cold-pdf', 'from the supplementary extractor', { supplementary: true }),
        );
        const settingsService = {
            getSettings: jest.fn().mockResolvedValue({ apiKey: 'sk-extract' }),
        } as unknown as PluginSettingsService;
        const facade = new ContentExtractorFacadeService(registry, settingsService);

        const result = await facade.extractContentWithDiagnostics(
            'https://example.com/report.pdf',
            undefined,
            { userId: 'user-1', providerOverride: 'cold-general' },
        );

        expect(result.content?.rawContent).toBe('from the supplementary extractor');
    });
});
