import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import type { SandboxSessionInput, SandboxSessionResult } from '@ever-works/plugin';
import { PluginManifestValidatorService } from '../services/plugin-manifest-validator.service';
import { PluginExecutionRouterService } from '../services/plugin-execution-router.service';
import {
    SANDBOX_SESSION_OPERATION,
    ManagedAgentSandboxRunnerService,
} from '../services/managed-agent-sandbox-runner.service';
import { FacadePluginAvailabilityService } from '../services/facade-plugin-availability.service';
import { PluginRegistryService, type RegisteredPlugin } from '../services/plugin-registry.service';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import { PluginsModule } from '../plugins.module';
import { JOB_RUNTIME_PROVIDER_REGISTRY } from '../../tasks/job-runtime.providers';
import { TenantAwareRuntimeResolver } from '../../tasks/tenant-aware-runtime.resolver';

/**
 * T26 (owner decision 2026-09-25) — the execution router's first LONG-RUNNING
 * caller: `claude-managed-agent.runSandboxSession`, run through
 * `ManagedAgentSandboxRunnerService`.
 *
 * Pinned:
 * 1. The REAL `claude-managed-agent` package.json declares `runSandboxSession`
 *    as a long-running operation, validates, and routes to the job runtime.
 * 2. With `sandboxSessionsViaJobRuntime` unset or false (the default) the
 *    runner runs the session IN THIS PROCESS, through the plugin, handing it
 *    the caller's signal — and never touches the job runtime.
 * 3. With it on, the runner starts, polls, waits for and cancels the session
 *    through the router's job-runtime path, with the Work's tenant — and
 *    never runs it in this process. A signal that is already aborted starts
 *    nothing, on `run()` and `start()` alike.
 * 4. Constitution Principle II: the runner names NO plugin id. The caller
 *    passes the pipeline plugin it selected by `enforcesRuntimeNetworking`
 *    plus a declared `runSandboxSession` (APW-04 T48); only specs name
 *    `claude-managed-agent`.
 */

/** The plugin a caller selected — only specs name it (Principle II). */
const PLUGIN_ID = 'claude-managed-agent';

const MANIFEST_PATH = path.resolve(
    __dirname,
    '../../../../plugins/claude-managed-agent/package.json',
);

const RUNNER_SOURCE = path.resolve(
    __dirname,
    '../services/managed-agent-sandbox-runner.service.ts',
);

function realManifest() {
    const pkg = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
    return new PluginManifestValidatorService().validateAndExtract(pkg);
}

const INPUT: SandboxSessionInput = {
    userId: 'user-1',
    workId: 'work-1',
    system: 'You provision apps.',
    prompt: '<brief>make it run</brief>',
    runtimeEnvironment: {
        networkingMode: 'limited',
        allowedHosts: ['registry.npmjs.org'],
    } as never,
    timeoutMs: 60_000,
};

const RESULT: SandboxSessionResult = {
    status: 'completed',
    finalText: '```provision-output\n{}\n```',
    sessionId: 'sess_1',
};

type Read = { status: string; output?: unknown; error?: { message: string } | null };

function makeRuntime(reads: Read[] = [], runId: string | null = 'run_s1') {
    const queue = [...reads];
    const provider = {
        runtimeId: 'trigger',
        dispatchers: { dispatchPluginOperation: jest.fn(async () => runId) },
        getRunResult: jest.fn(async () => queue.shift() ?? { status: 'running' }),
        cancel: jest.fn(async () => true),
    };
    return { provider, registry: { getActive: jest.fn(() => provider) } };
}

function makePlugin() {
    return {
        runSandboxSession: jest.fn(async (_input: unknown, _signal?: AbortSignal) => RESULT),
    };
}

/** A registry holding `plugin` as `id`, with the real manifest's operations. */
function makeRegistry(plugin: object | null, id: string = PLUGIN_ID) {
    const manifest = { ...realManifest().manifest, id };
    return {
        get: jest.fn((asked: string) =>
            plugin && asked === id
                ? ({ manifest, plugin, state: 'loaded' } as unknown as RegisteredPlugin)
                : undefined,
        ),
    } as unknown as PluginRegistryService;
}

/** A ModuleRef double that behaves like Nest's: an absent token THROWS. */
function fakeModuleRef(bound: Map<unknown, unknown>) {
    return {
        get: jest.fn((token: unknown) => {
            if (bound.has(token)) return bound.get(token);
            throw new UnknownElementException(String(token));
        }),
    };
}

function setup(
    options: Partial<PluginsModuleOptions>,
    {
        runtime = makeRuntime(),
        plugin = makePlugin(),
        registeredAs = PLUGIN_ID,
        tenantView,
    }: {
        runtime?: ReturnType<typeof makeRuntime> | null;
        plugin?: ReturnType<typeof makePlugin> | null;
        /** The id the plugin is registered under in this process. */
        registeredAs?: string;
        tenantView?: ReturnType<typeof makeRuntime>['provider'];
    } = {},
) {
    const bound = new Map<unknown, unknown>();
    const resolver = { resolve: jest.fn(async () => tenantView ?? runtime?.provider ?? null) };
    if (tenantView) bound.set(TenantAwareRuntimeResolver, resolver);
    const router = new PluginExecutionRouterService(
        { distributionMode: 'bundled' },
        makeRegistry(plugin, registeredAs),
        undefined,
        (runtime?.registry ?? null) as never,
        fakeModuleRef(bound) as never,
    );
    const runner = new ManagedAgentSandboxRunnerService(options as PluginsModuleOptions, router);
    return { runner, router, runtime, plugin, resolver };
}

describe('the claude-managed-agent manifest (T26)', () => {
    it('declares runSandboxSession as a long-running operation — and only it — and validates', () => {
        const { manifest, validation } = realManifest();

        expect(validation.valid).toBe(true);
        expect(manifest?.id).toBe(PLUGIN_ID);
        expect(manifest?.operations).toEqual([
            { name: SANDBOX_SESSION_OPERATION, executionProfile: 'long-running' },
        ]);
    });

    it('routes runSandboxSession to the job runtime on that real manifest, even in bundled mode', () => {
        const { router } = setup({});

        expect(router.route(PLUGIN_ID, SANDBOX_SESSION_OPERATION)).toEqual({
            location: 'job-runtime',
            reason: 'manifest:operations[runSandboxSession].executionProfile=long-running',
        });
    });
});

describe('ManagedAgentSandboxRunnerService (T26)', () => {
    describe('Principle II — the caller names the plugin; the runner names none', () => {
        it('the runner’s source holds no plugin id', () => {
            const source = fs.readFileSync(RUNNER_SOURCE, 'utf8');

            expect(source).not.toMatch(/claude-managed-agent/);
        });

        it('in-process, run() calls the plugin the caller passed', async () => {
            const { runner, plugin } = setup({}, { registeredAs: 'another-sandbox-pipeline' });

            await expect(runner.run('another-sandbox-pipeline', INPUT)).resolves.toEqual({
                ok: true,
                location: 'in-process',
                result: RESULT,
            });
            expect(plugin!.runSandboxSession).toHaveBeenCalledTimes(1);
            await expect(runner.run(PLUGIN_ID, INPUT)).resolves.toMatchObject({
                ok: false,
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
        });

        it('on the job runtime, start() dispatches the plugin the caller passed', async () => {
            const { runner, runtime } = setup({ sandboxSessionsViaJobRuntime: true });

            await expect(runner.start('another-sandbox-pipeline', INPUT)).resolves.toEqual({
                ok: true,
                location: 'job-runtime',
                runId: 'run_s1',
            });
            expect(runtime!.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                pluginId: 'another-sandbox-pipeline',
                operation: SANDBOX_SESSION_OPERATION,
                args: INPUT,
            });
        });
    });

    describe('the default: in this process, through the plugin', () => {
        it.each([
            ['unset', {}],
            ['false', { sandboxSessionsViaJobRuntime: false }],
        ] as const)(
            'with the switch %s, run() calls the plugin here with the caller’s signal and never touches the job runtime',
            async (_label, options) => {
                const { runner, runtime, plugin } = setup(options);
                const controller = new AbortController();

                expect(runner.location()).toBe('in-process');
                await expect(
                    runner.run(PLUGIN_ID, INPUT, {
                        tenantId: 'tenant-1',
                        signal: controller.signal,
                    }),
                ).resolves.toEqual({ ok: true, location: 'in-process', result: RESULT });
                expect(plugin!.runSandboxSession).toHaveBeenCalledTimes(1);
                expect(plugin!.runSandboxSession).toHaveBeenCalledWith(INPUT, controller.signal);
                expect(
                    runtime!.provider.dispatchers.dispatchPluginOperation,
                ).not.toHaveBeenCalled();
                expect(runtime!.provider.getRunResult).not.toHaveBeenCalled();
            },
        );

        it('start() runs the session to completion here — there is no run to poll', async () => {
            const { runner, runtime, plugin } = setup({});

            await expect(runner.start(PLUGIN_ID, INPUT, { tenantId: 'tenant-1' })).resolves.toEqual(
                {
                    ok: true,
                    location: 'in-process',
                    result: RESULT,
                },
            );
            expect(plugin!.runSandboxSession).toHaveBeenCalledTimes(1);
            expect(runtime!.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
        });

        it('answers the router’s PLUGIN_NOT_REGISTERED when the plugin is not in this process', async () => {
            const { runner } = setup({}, { plugin: null });

            await expect(runner.run(PLUGIN_ID, INPUT)).resolves.toMatchObject({
                ok: false,
                location: 'in-process',
                error: { code: 'PLUGIN_NOT_REGISTERED' },
            });
        });
    });

    describe('sandboxSessionsViaJobRuntime: true — through the job runtime', () => {
        const ON = { sandboxSessionsViaJobRuntime: true } as const;
        const fast = { pollIntervalMs: 1, timeoutMs: 5_000 };

        it('start() dispatches runSandboxSession with the Work’s tenant and never runs it here', async () => {
            const view = makeRuntime().provider;
            const { runner, runtime, plugin, resolver } = setup(ON, { tenantView: view });

            expect(runner.location()).toBe('job-runtime');
            await expect(runner.start(PLUGIN_ID, INPUT, { tenantId: 'tenant-1' })).resolves.toEqual(
                {
                    ok: true,
                    location: 'job-runtime',
                    runId: 'run_s1',
                },
            );
            expect(resolver.resolve).toHaveBeenCalledWith('tenant-1');
            expect(view.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                pluginId: PLUGIN_ID,
                operation: SANDBOX_SESSION_OPERATION,
                args: INPUT,
                tenantId: 'tenant-1',
            });
            expect(runtime!.provider.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            expect(plugin!.runSandboxSession).not.toHaveBeenCalled();
            expect(view.getRunResult).not.toHaveBeenCalled();
        });

        it('without a tenant, start() uses the platform runtime', async () => {
            const { runner, runtime } = setup(ON);

            await expect(runner.start(PLUGIN_ID, INPUT)).resolves.toEqual({
                ok: true,
                location: 'job-runtime',
                runId: 'run_s1',
            });
            expect(runtime!.provider.dispatchers.dispatchPluginOperation).toHaveBeenCalledWith({
                pluginId: PLUGIN_ID,
                operation: SANDBOX_SESSION_OPERATION,
                args: INPUT,
            });
        });

        it('poll() reads the run through the tenant’s view: pending, then the session’s result', async () => {
            const view = makeRuntime([
                { status: 'queued' },
                { status: 'completed', output: { ok: true, result: RESULT } },
            ]).provider;
            const { runner, resolver } = setup(ON, { tenantView: view });

            await expect(runner.poll('run_s1', { tenantId: 'tenant-1' })).resolves.toEqual({
                done: false,
                runId: 'run_s1',
                status: 'queued',
            });
            await expect(runner.poll('run_s1', { tenantId: 'tenant-1' })).resolves.toEqual({
                done: true,
                runId: 'run_s1',
                result: { ok: true, location: 'job-runtime', runId: 'run_s1', result: RESULT },
            });
            expect(resolver.resolve).toHaveBeenCalledWith('tenant-1');
            expect(view.getRunResult).toHaveBeenCalledTimes(2);
        });

        it('cancel() cancels the run through the tenant’s view', async () => {
            const view = makeRuntime().provider;
            const { runner, runtime } = setup(ON, { tenantView: view });

            await expect(runner.cancel('run_s1', { tenantId: 'tenant-1' })).resolves.toEqual({
                ok: true,
                runId: 'run_s1',
                cancelled: true,
            });
            expect(view.cancel).toHaveBeenCalledWith('run_s1');
            expect(runtime!.provider.cancel).not.toHaveBeenCalled();
        });

        it('poll() and cancel() still reach the job runtime with the switch OFF — a run started before a restart stays readable', async () => {
            const runtime = makeRuntime([
                { status: 'completed', output: { ok: true, result: RESULT } },
            ]);
            const { runner } = setup({}, { runtime });

            await expect(runner.poll('run_s1')).resolves.toMatchObject({ done: true });
            await expect(runner.cancel('run_s1')).resolves.toEqual({
                ok: true,
                runId: 'run_s1',
                cancelled: true,
            });
            expect(runtime.provider.cancel).toHaveBeenCalledWith('run_s1');
        });

        it('run() waits for the session’s result through the job runtime', async () => {
            const view = makeRuntime([
                { status: 'running' },
                { status: 'completed', output: { ok: true, result: RESULT } },
            ]).provider;
            const { runner, plugin } = setup(ON, { tenantView: view });

            await expect(
                runner.run(PLUGIN_ID, INPUT, { tenantId: 'tenant-1', ...fast }),
            ).resolves.toEqual({
                ok: true,
                location: 'job-runtime',
                runId: 'run_s1',
                result: RESULT,
            });
            expect(plugin!.runSandboxSession).not.toHaveBeenCalled();
            expect(view.cancel).not.toHaveBeenCalled();
        });

        it('run(): an abort stops the wait AND cancels the run — the counterpart of the in-process signal', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });
            const controller = new AbortController();
            view.getRunResult.mockImplementation(async () => {
                controller.abort();
                return { status: 'running' };
            });

            await expect(
                runner.run(PLUGIN_ID, INPUT, {
                    tenantId: 'tenant-1',
                    signal: controller.signal,
                    ...fast,
                }),
            ).resolves.toMatchObject({
                ok: false,
                location: 'job-runtime',
                runId: 'run_s1',
                error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
            });
            expect(view.cancel).toHaveBeenCalledTimes(1);
            expect(view.cancel).toHaveBeenCalledWith('run_s1');
        });

        it('run(): a signal that is already aborted starts nothing', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });
            const controller = new AbortController();
            controller.abort();

            await expect(
                runner.run(PLUGIN_ID, INPUT, {
                    tenantId: 'tenant-1',
                    signal: controller.signal,
                    ...fast,
                }),
            ).resolves.toMatchObject({
                ok: false,
                location: 'job-runtime',
                error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
            });
            expect(view.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            expect(view.cancel).not.toHaveBeenCalled();
        });

        it('start(): a signal that is already aborted starts nothing — the same answer as run()', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });
            const controller = new AbortController();
            controller.abort();

            const answer = await runner.start(PLUGIN_ID, INPUT, {
                tenantId: 'tenant-1',
                signal: controller.signal,
            });

            expect(answer).toMatchObject({
                ok: false,
                location: 'job-runtime',
                error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
            });
            expect(answer).not.toHaveProperty('runId');
            expect(view.dispatchers.dispatchPluginOperation).not.toHaveBeenCalled();
            expect(view.cancel).not.toHaveBeenCalled();
        });

        it('start(): a signal aborted while the run is being started cancels that run', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });
            const controller = new AbortController();
            view.dispatchers.dispatchPluginOperation.mockImplementation(async () => {
                controller.abort();
                return 'run_s1';
            });

            await expect(
                runner.start(PLUGIN_ID, INPUT, { tenantId: 'tenant-1', signal: controller.signal }),
            ).resolves.toMatchObject({
                ok: false,
                location: 'job-runtime',
                runId: 'run_s1',
                error: { code: 'JOB_RUNTIME_WAIT_ABORTED' },
            });
            expect(view.cancel).toHaveBeenCalledTimes(1);
            expect(view.cancel).toHaveBeenCalledWith('run_s1');
        });

        it('start(): a signal that is not aborted leaves the started run alone', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });

            await expect(
                runner.start(PLUGIN_ID, INPUT, {
                    tenantId: 'tenant-1',
                    signal: new AbortController().signal,
                }),
            ).resolves.toEqual({ ok: true, location: 'job-runtime', runId: 'run_s1' });
            expect(view.cancel).not.toHaveBeenCalled();
        });

        it('a deadline that passes does NOT cancel the run — the caller keeps its run id', async () => {
            const view = makeRuntime().provider;
            const { runner } = setup(ON, { tenantView: view });

            await expect(
                runner.run(PLUGIN_ID, INPUT, {
                    tenantId: 'tenant-1',
                    pollIntervalMs: 1,
                    timeoutMs: 0,
                }),
            ).resolves.toMatchObject({
                ok: false,
                runId: 'run_s1',
                error: { code: 'JOB_RUNTIME_WAIT_TIMEOUT' },
            });
            expect(view.cancel).not.toHaveBeenCalled();
        });

        it('with no job runtime, answers JOB_RUNTIME_UNAVAILABLE and never falls back in-process', async () => {
            const { runner, plugin } = setup(ON, { runtime: null });

            await expect(runner.start(PLUGIN_ID, INPUT)).resolves.toMatchObject({
                ok: false,
                error: { code: 'JOB_RUNTIME_UNAVAILABLE' },
            });
            await expect(runner.run(PLUGIN_ID, INPUT, fast)).resolves.toMatchObject({
                ok: false,
                error: { code: 'JOB_RUNTIME_UNAVAILABLE' },
            });
            expect(plugin!.runSandboxSession).not.toHaveBeenCalled();
        });
    });

    describe('Nest wiring', () => {
        it('resolves from PLUGINS_MODULE_OPTIONS and the router', async () => {
            const runtime = makeRuntime();
            const moduleRef = await Test.createTestingModule({
                providers: [
                    ManagedAgentSandboxRunnerService,
                    PluginExecutionRouterService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: { sandboxSessionsViaJobRuntime: true },
                    },
                    { provide: PluginRegistryService, useValue: makeRegistry(makePlugin()) },
                    { provide: JOB_RUNTIME_PROVIDER_REGISTRY, useValue: runtime.registry },
                ],
            }).compile();

            const runner = moduleRef.get(ManagedAgentSandboxRunnerService);
            expect(runner.location()).toBe('job-runtime');
            await expect(runner.start(PLUGIN_ID, INPUT)).resolves.toEqual({
                ok: true,
                location: 'job-runtime',
                runId: 'run_s1',
            });
            await moduleRef.close();
        });

        it('PluginsModule provides and exports the runner and the facade install-on-use service', () => {
            for (const dynamicModule of [
                PluginsModule.forRoot({}),
                PluginsModule.forRootAsync({ useFactory: () => ({}) }),
            ]) {
                expect(dynamicModule.providers).toEqual(
                    expect.arrayContaining([
                        ManagedAgentSandboxRunnerService,
                        FacadePluginAvailabilityService,
                    ]),
                );
                expect(dynamicModule.exports).toEqual(
                    expect.arrayContaining([
                        ManagedAgentSandboxRunnerService,
                        FacadePluginAvailabilityService,
                    ]),
                );
            }
        });
    });
});
