import type { FacadeOptions, ITerminalStreamFacade } from '@ever-works/plugin';
import type { TerminalSessionSpawner } from './terminal-session-host.js';

/**
 * Streaming-terminal — the provider seam, made load-bearing.
 *
 * `TerminalStreamFacadeService` existed with the full capability
 * resolution matrix behind it (provider override → work default → user
 * default → first enabled, plus the 4-level settings hierarchy) and NO
 * non-test caller: the session task constructed one hardcoded provider,
 * so "a different terminal provider can be swapped in" was a claim the
 * code did not honour. This resolver is the consumer that makes it
 * true — the live session path asks the facade WHICH provider applies
 * and then spawns THROUGH it.
 *
 * Degradation is deliberate and quiet-but-reported: an install whose
 * registry has no enabled `terminal-stream` plugin (or whose plugin
 * hydration failed) still gets a working terminal from the bundled
 * floor. Losing the seam must never mean losing the session.
 */
export type TerminalProviderSource = 'facade' | 'bundled';

export interface TerminalProviderResolution {
    spawner: TerminalSessionSpawner;
    source: TerminalProviderSource;
    /** Why the bundled floor was used (empty for `source: 'facade'`). */
    degradedReason?: string;
}

export interface ResolveTerminalSessionSpawnerInput {
    /** Absent when the worker context has no facade bound at all. */
    facade?: ITerminalStreamFacade | null;
    facadeOptions: FacadeOptions;
    /** The in-bundle provider used when the facade resolves nothing. */
    bundledFallback: () => TerminalSessionSpawner;
}

export async function resolveTerminalSessionSpawner(
    input: ResolveTerminalSessionSpawnerInput,
): Promise<TerminalProviderResolution> {
    const { facade, facadeOptions, bundledFallback } = input;

    if (!facade || typeof facade.resolveProvider !== 'function') {
        return {
            spawner: bundledFallback(),
            source: 'bundled',
            degradedReason: 'no terminal-stream facade bound in this worker context',
        };
    }

    let provider: { id?: string; providerName?: string } | null = null;
    try {
        provider = await facade.resolveProvider(facadeOptions);
    } catch (error) {
        return {
            spawner: bundledFallback(),
            source: 'bundled',
            degradedReason: `terminal-stream provider resolution failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }

    if (!provider) {
        return {
            spawner: bundledFallback(),
            source: 'bundled',
            degradedReason: 'no enabled terminal-stream provider for this scope',
        };
    }

    const providerName = provider.providerName ?? provider.id ?? 'terminal-stream';
    return {
        source: 'facade',
        spawner: {
            providerName,
            // Spawn through the FACADE, not the resolved plugin: the
            // facade is what injects the scope's resolved settings and
            // what passes `TerminalNotProvisionedError` through
            // un-wrapped (the UI's cannot-connect signal).
            spawn: (spawnInput, transport) => facade.spawn(spawnInput, transport, facadeOptions),
        },
    };
}
