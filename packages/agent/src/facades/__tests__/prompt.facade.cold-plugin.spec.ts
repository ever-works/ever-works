import { runInThisContext } from 'node:vm';
import { Logger } from '@nestjs/common';
import { PromptFacadeService } from '../prompt.facade';
import {
    loadPluginSchema,
    type PluginRegistryService,
} from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    settle,
    type ColdPluginSpec,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * PLG-4 — `IPromptProviderPlugin.isAvailable(settings)` is SYNC. langfuse is a
 * builtIn with autoEnable, so under lazy builtIns the registry holds it as a
 * cold proxy until first use, and the facade picked it without loading it.
 * Called through a cold or settling proxy, `isAvailable` answered a Promise:
 * truthy, so the availability check was skipped — and when the plugin's import
 * fails, that Promise rejected with nobody listening (an unhandled rejection,
 * which terminates a process with no `unhandledRejection` listener).
 */

const DEFAULT = 'DEFAULT';

function promptProvider(
    id: string,
    extra: Partial<ColdPluginSpec> & { available?: boolean; template?: string } = {},
): ColdPluginSpec {
    const { available = true, template = `from ${id}`, ...spec } = extra;
    return {
        id,
        category: 'utility',
        capabilities: ['prompt-provider'],
        settingsSchema: { type: 'object', properties: {} } as never,
        builtIn: true,
        manifest: { autoEnable: true },
        ...spec,
        members: {
            isAvailable: () => available,
            getPrompt: jest.fn(async () => ({ template, version: 1 })),
            ...(spec.members ?? {}),
        },
    };
}

/** `getSettings` loads the schema first, as `PluginSettingsService.getSettings` does. */
function settingsFor(registry: PluginRegistryService): PluginSettingsService {
    return {
        getSettings: jest.fn(async (pluginId: string) => {
            const registered = registry.get(pluginId);
            if (registered) await loadPluginSchema(registered.plugin, registered);
            return {};
        }),
    } as unknown as PluginSettingsService;
}

/** Unhandled rejections on the REAL process while `run` executes (see the email spec). */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
    const realProcess = runInThisContext('process') as NodeJS.Process;
    const seen: unknown[] = [];
    const listener = (reason: unknown) => {
        seen.push(reason);
    };
    realProcess.on('unhandledRejection', listener);
    try {
        await run();
        for (let turn = 0; turn < 5; turn++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        realProcess.off('unhandledRejection', listener);
    }
    return seen;
}

const OPTIONS = { userId: 'user-1' };

describe('PromptFacadeService — a cold lazy prompt provider', () => {
    it('answers the default prompt, with no unhandled rejection, when the provider cannot be imported', async () => {
        const registry = createRegistry();
        const langfuse = registerColdPlugin(
            registry,
            promptProvider('langfuse', { failing: true }),
        );
        const facade = new PromptFacadeService(registry, settingsFor(registry));

        let prompt: string | undefined;
        const unhandled = await collectUnhandled(async () => {
            prompt = await facade.getPrompt('key', DEFAULT, OPTIONS);
        });

        expect(prompt).toBe(DEFAULT);
        expect(unhandled).toEqual([]);
        expect(langfuse.registered.state).toBe('error');
    });

    it('honours a provider that is NOT available even while its first load is still settling', async () => {
        const registry = createRegistry();
        const firstLoad = gate();
        registerColdPlugin(
            registry,
            promptProvider('langfuse', { available: false, firstLoadGate: firstLoad.promise }),
        );
        const facade = new PromptFacadeService(registry, settingsFor(registry));

        const results: string[] = [];
        const unhandled = await collectUnhandled(async () => {
            const first = facade.getPrompt('key', DEFAULT, OPTIONS).then((p) => results.push(p));
            await settle();
            // Imported, first load still settling: a second resolution.
            const second = facade.getPrompt('key', DEFAULT, OPTIONS).then((p) => results.push(p));
            await settle();
            firstLoad.release();
            await Promise.all([first, second]);
        });

        expect(results).toEqual([DEFAULT, DEFAULT]);
        expect(unhandled).toEqual([]);
    });

    it('skips a provider whose first load fails and uses the next loaded one', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, promptProvider('langfuse', { onLoadFails: true }));
        registerColdPlugin(registry, promptProvider('backup', { template: 'from backup' }));
        const facade = new PromptFacadeService(registry, settingsFor(registry));

        await expect(facade.getPrompt('key', DEFAULT, OPTIONS)).resolves.toBe('from backup');
    });

    it('resolves the prompt from a cold provider that loads and is available', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, promptProvider('langfuse'));
        const facade = new PromptFacadeService(registry, settingsFor(registry));

        await expect(facade.getPrompt('key', DEFAULT, OPTIONS)).resolves.toBe('from langfuse');
    });
});
