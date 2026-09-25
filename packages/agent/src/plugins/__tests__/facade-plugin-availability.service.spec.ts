import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FacadePluginAvailabilityService } from '../services/facade-plugin-availability.service';
import { PluginRegistryService, type RegisteredPlugin } from '../services/plugin-registry.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginInstallerService, type PacoteLike } from '../services/plugin-installer.service';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginManifestValidatorService } from '../services/plugin-manifest-validator.service';
import { PluginVersionCheckerService } from '../services/plugin-version-checker.service';
import { PluginClassValidatorService } from '../services/plugin-class-validator.service';
import { PluginRepository } from '../repositories/plugin.repository';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';

/**
 * FR-15 / T26 (owner decision 2026-09-25) — a facade that resolves a plugin
 * this process has not registered may first ask the installer for it.
 *
 * Pinned:
 * 1. OFF unless BOTH `distributionMode: 'dynamic'` and `facadeInstallOnUse:
 *    true`; bundled mode never installs (FR-22).
 * 2. Only a plugin the platform already installed — a `registry`-sourced row
 *    in state `installed` — is installed on use. An id a request made up never
 *    reaches the installer (no first-ever install from a facade call, FR-21).
 * 3. `ensureLocalInstall` runs (T27: the pinned version, into THIS replica's
 *    store, never writing the shared row), `registerFromPath` registers the
 *    directory it answers, then the registry is read AGAIN; that entry is the
 *    answer.
 * 4. It never throws; a failure is logged and answered as "absent", and the
 *    plugin is not asked for again for 60 s. The miss list is bounded: ids a
 *    request makes up cannot grow it without limit.
 * 5. With the REAL installer, loader and registry, a plugin another replica
 *    installed is fetched here and registered — and a row whose pin carries no
 *    integrity is refused before any fetch. (Before T27 this block pinned the
 *    switch as inert: the shared row was trusted and nothing was registered.)
 */
describe('FacadePluginAvailabilityService (FR-15 / T26)', () => {
    const ON: PluginsModuleOptions = { distributionMode: 'dynamic', facadeInstallOnUse: true };
    const INSTALLED_ROW = {
        pluginId: 'notion-extractor',
        source: 'registry',
        installState: 'installed',
        registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
        installedVersion: '1.2.0',
    };

    /** The service's private miss list — asserted on for the bound only. */
    function missesOf(service: FacadePluginAvailabilityService): Map<string, number> {
        return (service as unknown as { misses: Map<string, number> }).misses;
    }

    function entry(id: string): RegisteredPlugin {
        return {
            plugin: { id } as never,
            manifest: { id, capabilities: ['content-extractor'] } as never,
            state: 'loaded',
        } as unknown as RegisteredPlugin;
    }

    function makeWorld(
        options: PluginsModuleOptions,
        {
            row = INSTALLED_ROW as Record<string, unknown> | null,
            registers = true,
            installer = true,
        }: { row?: Record<string, unknown> | null; registers?: boolean; installer?: boolean } = {},
    ) {
        const registered = new Map<string, RegisteredPlugin>();
        const registry = {
            get: jest.fn((id: string) => registered.get(id)),
        } as unknown as PluginRegistryService & { get: jest.Mock };
        // T27: the install step is `ensureLocalInstall` (the pinned version,
        // into THIS replica's store, no shared-row write), then
        // `registerFromPath` on the directory it answers. The real pair is
        // exercised end to end in "with the real installer and loader" below.
        const ensureLocalInstall = jest.fn(async (id: string) => ({
            pluginId: id,
            installPath: `/store/.versions/${id}/1.2.0`,
        }));
        const installerDouble = installer
            ? ({ ensureLocalInstall } as unknown as PluginInstallerService)
            : undefined;
        const registerFromPath = jest.fn(
            async (_installPath: string, { expectedId }: { expectedId: string }) => {
                if (!registers) return { success: false, error: 'not a plugin package' };
                registered.set(expectedId, entry(expectedId));
                return { success: true, pluginId: expectedId };
            },
        );
        const loaderDouble = { registerFromPath } as unknown as PluginLoaderService;
        const repository = {
            findByPluginId: jest.fn(async (id: string) =>
                row && row.pluginId === id ? row : null,
            ),
        } as unknown as PluginRepository & { findByPluginId: jest.Mock };
        const service = new FacadePluginAvailabilityService(
            options,
            registry,
            repository,
            installerDouble,
            loaderDouble,
        );
        return { service, registry, registered, ensureLocalInstall, registerFromPath, repository };
    }

    afterEach(() => jest.restoreAllMocks());

    it('is OFF by default — even in dynamic mode — and never installs', async () => {
        const world = makeWorld({ distributionMode: 'dynamic' });

        expect(world.service.isEnabled()).toBe(false);
        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(world.ensureLocalInstall).not.toHaveBeenCalled();
        expect(world.repository.findByPluginId).not.toHaveBeenCalled();
    });

    it('never installs in bundled mode, even with the switch on (FR-22)', async () => {
        const world = makeWorld({ distributionMode: 'bundled', facadeInstallOnUse: true });

        expect(world.service.isEnabled()).toBe(false);
        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(world.ensureLocalInstall).not.toHaveBeenCalled();
    });

    it('is off with no installer bound', async () => {
        const world = makeWorld(ON, { installer: false });

        expect(world.service.isEnabled()).toBe(false);
        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
    });

    it('answers a plugin already registered here without touching the installer', async () => {
        const world = makeWorld(ON);
        world.registered.set('tavily', entry('tavily'));

        await expect(world.service.ensureRegistered('tavily')).resolves.toBe(
            world.registered.get('tavily'),
        );
        expect(world.ensureLocalInstall).not.toHaveBeenCalled();
        expect(world.repository.findByPluginId).not.toHaveBeenCalled();
    });

    it('dynamic + on: ensures a plugin the platform installed, then answers the registry’s NEW entry', async () => {
        const world = makeWorld(ON);

        expect(world.service.isEnabled()).toBe(true);
        const answer = await world.service.ensureRegistered('notion-extractor');

        expect(world.ensureLocalInstall).toHaveBeenCalledWith('notion-extractor');
        // The directory the install step answered is what gets registered.
        expect(world.registerFromPath).toHaveBeenCalledWith(
            '/store/.versions/notion-extractor/1.2.0',
            { expectedId: 'notion-extractor' },
        );
        expect(answer).toBe(world.registered.get('notion-extractor'));
        expect(world.registry.get.mock.invocationCallOrder[1]).toBeGreaterThan(
            world.ensureLocalInstall.mock.invocationCallOrder[0],
        );
    });

    it.each([
        ['no row at all (an id a request made up)', null],
        ['a bundled row', { ...INSTALLED_ROW, source: 'bundled' }],
        ['a row not yet installed anywhere', { ...INSTALLED_ROW, installState: 'available' }],
        ['a row whose install failed', { ...INSTALLED_ROW, installState: 'error' }],
        // Without a pin the installer would run a full install() — `@latest`,
        // writing the shared row — from a facade call.
        ['an installed row with no pinned spec', { ...INSTALLED_ROW, registrySpec: null }],
        ['an installed row with no installed version', { ...INSTALLED_ROW, installedVersion: '' }],
    ])('never reaches the installer for %s', async (_label, row) => {
        const world = makeWorld(ON, { row });

        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(world.ensureLocalInstall).not.toHaveBeenCalled();
    });

    it('an install that throws is logged and answered as absent — never thrown', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const world = makeWorld(ON);
        world.ensureLocalInstall.mockRejectedValueOnce(new Error('registry down'));

        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry down'));
    });

    it('a plugin still absent after the install step is answered as absent', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const world = makeWorld(ON, { registers: false });

        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(world.ensureLocalInstall).toHaveBeenCalledTimes(1);
        expect(world.registerFromPath).toHaveBeenCalledTimes(1);
    });

    it('a row lookup that throws is answered as absent, and the installer is not reached', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const world = makeWorld(ON);
        world.repository.findByPluginId.mockRejectedValueOnce(new Error('db down'));

        await expect(world.service.ensureRegistered('notion-extractor')).resolves.toBeUndefined();
        expect(world.ensureLocalInstall).not.toHaveBeenCalled();
    });

    describe('with fake timers', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('does not ask again for 60 s after a miss, then does', async () => {
            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const world = makeWorld(ON);
            world.ensureLocalInstall.mockRejectedValueOnce(new Error('registry down'));

            await world.service.ensureRegistered('notion-extractor');
            await jest.advanceTimersByTimeAsync(59_000);
            await expect(
                world.service.ensureRegistered('notion-extractor'),
            ).resolves.toBeUndefined();
            expect(world.ensureLocalInstall).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(1_000);
            const answer = await world.service.ensureRegistered('notion-extractor');
            expect(answer).toBeDefined();
            expect(answer).toBe(world.registered.get('notion-extractor'));
            expect(world.ensureLocalInstall).toHaveBeenCalledTimes(2);
        });

        it('drops expired misses when it records a new one', async () => {
            const world = makeWorld(ON, { row: null });
            for (let i = 0; i < 10; i++) await world.service.ensureRegistered(`made-up-${i}`);
            expect(missesOf(world.service).size).toBe(10);

            await jest.advanceTimersByTimeAsync(60_000);
            await world.service.ensureRegistered('made-up-late');

            expect([...missesOf(world.service).keys()]).toEqual(['made-up-late']);
        });
    });

    describe('the miss list is bounded', () => {
        it('keeps at most 1,000 misses however many distinct unknown ids are asked for', async () => {
            const world = makeWorld(ON, { row: null });

            for (let i = 0; i < 5_000; i++) {
                await world.service.ensureRegistered(`made-up-${i}`);
            }

            expect(missesOf(world.service).size).toBeLessThanOrEqual(1_000);
            // The newest miss is still backed off…
            world.repository.findByPluginId.mockClear();
            await world.service.ensureRegistered('made-up-4999');
            expect(world.repository.findByPluginId).not.toHaveBeenCalled();
            // …and the oldest was evicted, so it is looked up again.
            await world.service.ensureRegistered('made-up-0');
            expect(world.repository.findByPluginId).toHaveBeenCalledWith('made-up-0');
        });
    });

    /**
     * T27 — the switch is no longer inert. Before, this block pinned the
     * defect as a characterization: `ensurePluginAvailable` trusted the shared
     * row (nothing was fetched on this replica, and the path it answered did
     * not exist here) and nothing registered the plugin, so the facade always
     * answered absent. The service now calls `ensureLocalInstall` and
     * `registerFromPath`; the no-fetch / no-row-write half of the old pin
     * survives as the refusal case below.
     */
    describe('with the real installer, loader and registry (T27)', () => {
        const PINNED_ROW = { ...INSTALLED_ROW, integrity: 'sha512-pinned' };
        let installDir: string;
        beforeEach(() => {
            installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-facade-install-on-use-'));
        });
        afterEach(() => fs.rmSync(installDir, { recursive: true, force: true }));

        /** A pacote double whose tarball is a (not-yet-loaded) plugin package. */
        function pacoteWithPlugin(): PacoteLike & { manifest: jest.Mock; extract: jest.Mock } {
            return {
                manifest: jest.fn(async () => {
                    throw new Error('a pinned install must not resolve anything');
                }),
                extract: jest.fn(async (_spec: string, dest: string) => {
                    fs.mkdirSync(dest, { recursive: true });
                    fs.writeFileSync(
                        path.join(dest, 'package.json'),
                        JSON.stringify({
                            name: '@ever-works/notion-extractor-plugin',
                            version: '1.2.0',
                            main: './index.js',
                            everworks: {
                                plugin: {
                                    id: 'notion-extractor',
                                    name: 'Notion Extractor',
                                    version: '1.2.0',
                                    category: 'utility',
                                    capabilities: [],
                                    description: 'A runtime-installed fixture.',
                                },
                            },
                        }),
                    );
                    fs.writeFileSync(
                        path.join(dest, 'index.js'),
                        'module.exports = class F { async onLoad() {} async onUnload() {} };\n',
                    );
                    return undefined;
                }),
            };
        }

        async function makeRealWorld(row: Record<string, unknown>) {
            const pacote = pacoteWithPlugin();
            const repository = {
                findByPluginId: jest.fn(async () => row),
                updateInstallState: jest.fn(async () => undefined),
                upsert: jest.fn(async () => ({})),
                updateState: jest.fn(async () => ({})),
            };
            const options: PluginsModuleOptions = {
                ...ON,
                installDir,
                pluginPaths: [],
                builtInPlugins: [],
                platformVersion: '1.0.0',
            };
            const moduleRef = await Test.createTestingModule({
                providers: [
                    FacadePluginAvailabilityService,
                    PluginInstallerService,
                    PluginLoaderService,
                    PluginRegistryService,
                    PluginManifestValidatorService,
                    PluginVersionCheckerService,
                    PluginClassValidatorService,
                    { provide: EventEmitter2, useValue: new EventEmitter2() },
                    { provide: PLUGINS_MODULE_OPTIONS, useValue: options },
                    { provide: 'PLUGIN_INSTALLER_PACOTE', useValue: pacote },
                    { provide: PluginRepository, useValue: repository },
                ],
            }).compile();
            return {
                pacote,
                repository,
                service: moduleRef.get(FacadePluginAvailabilityService),
                registry: moduleRef.get(PluginRegistryService),
            };
        }

        it('fetches the pinned version on this replica, registers it and answers it — writing no row', async () => {
            const world = await makeRealWorld(PINNED_ROW);

            const answer = await world.service.ensureRegistered('notion-extractor');

            expect(answer).toBeDefined();
            expect(answer).toBe(world.registry.get('notion-extractor'));
            expect(world.pacote.manifest).not.toHaveBeenCalled();
            expect(world.pacote.extract).toHaveBeenCalledTimes(1);
            expect(world.pacote.extract.mock.calls[0][0]).toBe(
                '@ever-works/notion-extractor-plugin@1.2.0',
            );
            expect(world.repository.updateInstallState).not.toHaveBeenCalled();
            expect(fs.existsSync(path.join(answer!.installPath!, 'package.json'))).toBe(true);
        });

        it('refuses a pinned row that carries no integrity — fetches nothing, writes no row, answers absent', async () => {
            const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const world = await makeRealWorld(INSTALLED_ROW);

            await expect(
                world.service.ensureRegistered('notion-extractor'),
            ).resolves.toBeUndefined();

            expect(world.pacote.manifest).not.toHaveBeenCalled();
            expect(world.pacote.extract).not.toHaveBeenCalled();
            expect(world.repository.updateInstallState).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('integrity'));
            expect(world.registry.get('notion-extractor')).toBeUndefined();
        });
    });

    describe('Nest wiring', () => {
        it('reads the switch from PLUGINS_MODULE_OPTIONS, and boots without an installer', async () => {
            const moduleRef = await Test.createTestingModule({
                providers: [
                    FacadePluginAvailabilityService,
                    { provide: PLUGINS_MODULE_OPTIONS, useValue: ON },
                    { provide: PluginRegistryService, useValue: { get: jest.fn() } },
                    { provide: PluginRepository, useValue: { findByPluginId: jest.fn() } },
                ],
            }).compile();

            expect(moduleRef.get(FacadePluginAvailabilityService).isEnabled()).toBe(false);
            await moduleRef.close();
        });

        it('is enabled with the installer bound', async () => {
            const moduleRef = await Test.createTestingModule({
                providers: [
                    FacadePluginAvailabilityService,
                    { provide: PLUGINS_MODULE_OPTIONS, useValue: ON },
                    { provide: PluginRegistryService, useValue: { get: jest.fn() } },
                    { provide: PluginRepository, useValue: { findByPluginId: jest.fn() } },
                    {
                        provide: PluginInstallerService,
                        useValue: { ensureLocalInstall: jest.fn() },
                    },
                ],
            }).compile();

            expect(moduleRef.get(FacadePluginAvailabilityService).isEnabled()).toBe(true);
            await moduleRef.close();
        });
    });
});
