import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * EW-693 / T27 — **`run-plugin-operation`**, the long-running plugin call, until
 * now without a spec.
 *
 * The task promises its router a DETERMINISTIC `{ ok, error }` envelope and never
 * a throw (its own header; AW-24's held-action task copies that contract from
 * it). Both service lookups were written as "absent → optional":
 *
 *     const installer = appContext.get(PluginInstallerService, { strict: false });
 *     if (installer) { ... }                     // install is optional
 *     const registered = registry?.get(pluginId); // → PLUGIN_NOT_REGISTERED
 *
 * but Nest's `get(Token, { strict: false })` THROWS `UnknownElementException` for
 * an absent provider — it never answers `undefined`. And the task's outer `try`
 * has only a `finally`, so that throw was not turned into an error envelope at
 * all: it escaped `run`, into Trigger.dev's retry path. The cases that model
 * Nest's real behaviour are in "an absent service"; they fail against the lookup
 * as it was and pass with `getOptionalProvider`.
 */

const { contextHolder, createApplicationContextMock, recorded } = vi.hoisted(() => ({
    contextHolder: { current: undefined as unknown },
    createApplicationContextMock: vi.fn(),
    recorded: [] as Array<Record<string, any>>,
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return params;
    },
}));

// The ROOT `@nestjs/core` only: the task boots its own context through
// `NestFactory`. `UnknownElementException` is imported from its deep path below,
// which this does not mock — the same class `getOptionalProvider` checks for.
vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

// Token classes only: the lookup compares tokens, and the real plugins barrel
// has nothing this spec needs.
vi.mock('@ever-works/agent/plugins', () => ({
    PluginInstallerService: class PluginInstallerService {},
    PluginRegistryService: class PluginRegistryService {},
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: class TriggerInternalModule {},
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: vi.fn(() => ({})),
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { PluginInstallerService, PluginRegistryService } from '@ever-works/agent/plugins';
import { runPluginOperationTask } from '../tasks/trigger/run-plugin-operation.task';

const registered = recorded.find((entry) => entry.id === 'run-plugin-operation') as Record<
    string,
    any
>;
const run = (payload: Record<string, unknown>) => registered.run(payload);

const PLUGIN_ID = 'acme-generator';

interface Harness {
    installer: { ensurePluginAvailable: ReturnType<typeof vi.fn> } | 'absent';
    registry: { get: ReturnType<typeof vi.fn> } | 'absent';
    close: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
}

/**
 * A worker context whose `get` behaves the way Nest's does: it answers the
 * bound service, and THROWS `UnknownElementException` for one that is absent.
 */
function harness(
    over: { installer?: 'absent'; registry?: 'absent'; plugin?: 'unregistered' } = {},
): Harness {
    const generate = vi.fn(async (args?: Record<string, unknown>) => ({ generated: true, args }));
    const h: Harness = {
        installer: over.installer ?? { ensurePluginAvailable: vi.fn(async () => undefined) },
        registry: over.registry ?? {
            get: vi.fn((id: string) =>
                over.plugin === 'unregistered' || id !== PLUGIN_ID
                    ? undefined
                    : { plugin: { generate } },
            ),
        },
        close: vi.fn(async () => undefined),
        generate,
    };
    contextHolder.current = {
        useLogger: vi.fn(),
        close: h.close,
        get: vi.fn((token: unknown) => {
            const bound =
                token === PluginInstallerService
                    ? h.installer
                    : token === PluginRegistryService
                      ? h.registry
                      : 'absent';
            if (bound === 'absent') {
                throw new UnknownElementException(
                    String((token as { name?: string })?.name ?? token),
                );
            }
            return bound;
        }),
    };
    return h;
}

describe('run-plugin-operation (EW-693 T27)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createApplicationContextMock.mockImplementation(async () => contextHolder.current);
    });

    it('registers its id and the long-running budget', () => {
        expect(registered).toBeDefined();
        expect(runPluginOperationTask).toBe(registered);
        expect(registered.maxDuration).toBe(3600);
    });

    describe('with both services bound', () => {
        it('installs the plugin, then runs the operation with the payload’s args', async () => {
            const h = harness();

            const outcome = await run({
                pluginId: PLUGIN_ID,
                operation: 'generate',
                args: { n: 1 },
            });

            expect(outcome).toEqual({ ok: true, result: { generated: true, args: { n: 1 } } });
            expect(
                (h.installer as { ensurePluginAvailable: ReturnType<typeof vi.fn> })
                    .ensurePluginAvailable,
            ).toHaveBeenCalledWith(PLUGIN_ID);
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('answers WORKER_INSTALL_FAILED when the install throws, and runs nothing', async () => {
            const h = harness();
            (
                h.installer as { ensurePluginAvailable: ReturnType<typeof vi.fn> }
            ).ensurePluginAvailable.mockRejectedValue(new Error('integrity mismatch'));

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: false,
                error: { message: 'integrity mismatch', code: 'WORKER_INSTALL_FAILED' },
            });
            expect(h.generate).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('answers PLUGIN_NOT_REGISTERED when the registry does not know the plugin', async () => {
            harness({ plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
        });

        it('answers OPERATION_NOT_FOUND for an operation the plugin does not implement', async () => {
            harness();

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'teleport' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'OPERATION_NOT_FOUND' },
            });
        });

        it('answers WORKER_PLUGIN_THREW when the operation throws', async () => {
            const h = harness();
            h.generate.mockRejectedValue(new Error('upstream 500'));

            await expect(run({ pluginId: PLUGIN_ID, operation: 'generate' })).resolves.toEqual({
                ok: false,
                error: { message: 'upstream 500', code: 'WORKER_PLUGIN_THREW' },
            });
        });
    });

    /**
     * Nest's real behaviour for an absent provider: `get` THROWS. These are the
     * cases that matter — each promised a named answer, and each used to escape
     * `run` as an `UnknownElementException` instead.
     */
    describe('an absent service — Nest THROWS for it', () => {
        it('no installer: install is skipped and the operation still reaches the registry and runs', async () => {
            const h = harness({ installer: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate', args: { n: 2 } }),
            ).resolves.toEqual({
                ok: true,
                result: { generated: true, args: { n: 2 } },
            });
            expect(h.generate).toHaveBeenCalledTimes(1);
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('no installer, plugin not registered: the registry check answers PLUGIN_NOT_REGISTERED', async () => {
            harness({ installer: 'absent', plugin: 'unregistered' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
        });

        it('no registry: PLUGIN_NOT_REGISTERED, as an envelope — not a throw', async () => {
            const h = harness({ registry: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
            expect(h.generate).not.toHaveBeenCalled();
            expect(h.close).toHaveBeenCalledTimes(1);
        });

        it('neither service: PLUGIN_NOT_REGISTERED, as an envelope — not a throw', async () => {
            harness({ installer: 'absent', registry: 'absent' });

            await expect(
                run({ pluginId: PLUGIN_ID, operation: 'generate' }),
            ).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
        });
    });
});
