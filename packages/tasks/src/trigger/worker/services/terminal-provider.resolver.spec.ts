import { describe, expect, it, vi } from 'vitest';
import type { FacadeOptions } from '@ever-works/plugin';
import { resolveTerminalSessionSpawner } from './terminal-provider.resolver';
import type { TerminalSessionSpawner } from './terminal-session-host';

const FACADE_OPTIONS = {
    userId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
    workId: 'work-1',
} as FacadeOptions;

function bundled(): TerminalSessionSpawner {
    return {
        providerName: 'pty-local',
        spawn: vi.fn(async () => ({ runId: 'r1', isPty: true }) as never),
    };
}

describe('resolveTerminalSessionSpawner (the facade seam, made load-bearing)', () => {
    it('spawns THROUGH the facade when it resolves a provider', async () => {
        const handle = { runId: 'r1', isPty: true };
        const facade = {
            resolveProvider: vi.fn(async () => ({ id: 'pty-ssh', providerName: 'pty-ssh' })),
            spawn: vi.fn(async () => handle as never),
        };

        const resolution = await resolveTerminalSessionSpawner({
            facade: facade as never,
            facadeOptions: FACADE_OPTIONS,
            bundledFallback: bundled,
        });

        expect(resolution.source).toBe('facade');
        // Provider identity comes from the RESOLVED provider — this is
        // what the lifecycle beat reports and what makes a swap visible.
        expect(resolution.spawner.providerName).toBe('pty-ssh');

        const transport = { publish: vi.fn(), inbound: vi.fn(), close: vi.fn() };
        const input = { runId: 'r1', command: ['/bin/bash'], cwd: '/w', env: {} };
        await expect(resolution.spawner.spawn(input, transport as never)).resolves.toBe(handle);

        // The facade (not the plugin) is what spawns: it injects the
        // scope's resolved settings and owns the error contract.
        expect(facade.spawn).toHaveBeenCalledWith(input, transport, FACADE_OPTIONS);
        expect(facade.resolveProvider).toHaveBeenCalledWith(FACADE_OPTIONS);
    });

    it('falls back to the bundled floor when no provider is enabled for the scope', async () => {
        const facade = {
            resolveProvider: vi.fn(async () => null),
            spawn: vi.fn(),
        };

        const resolution = await resolveTerminalSessionSpawner({
            facade: facade as never,
            facadeOptions: FACADE_OPTIONS,
            bundledFallback: bundled,
        });

        expect(resolution.source).toBe('bundled');
        expect(resolution.spawner.providerName).toBe('pty-local');
        expect(resolution.degradedReason).toContain('no enabled terminal-stream provider');
        expect(facade.spawn).not.toHaveBeenCalled();
    });

    it('falls back (never throws) when resolution itself explodes', async () => {
        const facade = {
            resolveProvider: vi.fn(async () => {
                throw new Error('registry down');
            }),
            spawn: vi.fn(),
        };

        const resolution = await resolveTerminalSessionSpawner({
            facade: facade as never,
            facadeOptions: FACADE_OPTIONS,
            bundledFallback: bundled,
        });

        expect(resolution.source).toBe('bundled');
        expect(resolution.degradedReason).toContain('registry down');
    });

    it('falls back when no facade is bound in this worker context at all', async () => {
        const resolution = await resolveTerminalSessionSpawner({
            facade: null,
            facadeOptions: FACADE_OPTIONS,
            bundledFallback: bundled,
        });

        expect(resolution.source).toBe('bundled');
        expect(resolution.degradedReason).toContain('no terminal-stream facade');
    });

    it('honours the provider override the API-side facade already resolved', async () => {
        const facade = {
            resolveProvider: vi.fn(async () => ({ id: 'k8s-exec', providerName: 'k8s-exec' })),
            spawn: vi.fn(),
        };
        const withOverride = { ...FACADE_OPTIONS, providerOverride: 'k8s-exec' } as FacadeOptions;

        const resolution = await resolveTerminalSessionSpawner({
            facade: facade as never,
            facadeOptions: withOverride,
            bundledFallback: bundled,
        });

        expect(facade.resolveProvider).toHaveBeenCalledWith(
            expect.objectContaining({ providerOverride: 'k8s-exec' }),
        );
        expect(resolution.spawner.providerName).toBe('k8s-exec');
    });
});
