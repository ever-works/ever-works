import { HttpException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    PluginInstallerService,
    type PacoteLike,
    type PacoteManifest,
} from '../services/plugin-installer.service';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { PluginAllowlistRepository } from '../repositories/plugin-allowlist.repository';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import type { PluginEntity } from '../entities/plugin.entity';
import type { PluginAllowlistEntity } from '../entities/plugin-allowlist.entity';

/**
 * EW-693 / T16-T20 — PluginInstallerService.
 *
 * Pinned behaviours (all surface through HttpException with the
 * documented status codes):
 *
 * - bundled mode is INERT: install() refuses with 409, ensure()
 *   returns null without touching the registry or filesystem (FR-22).
 * - allowlist FIRST: refusal happens BEFORE any pacote.manifest() call
 *   (FR-11). First-party @ever-works/* implicitly allowed.
 * - integrity gate: caller-supplied integrity that mismatches the
 *   registry-resolved integrity throws 424 BEFORE extract (FR-10).
 * - per-id concurrency: two concurrent ensurePluginAvailable() calls
 *   for the same id share the in-flight Promise (FR-13).
 * - core uninstall refusal: systemPlugin/bundled rows can't be
 *   uninstalled (T20).
 */
describe('PluginInstallerService (EW-693)', () => {
    let installDir: string;

    beforeEach(async () => {
        installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew693-installer-'));
    });

    afterEach(async () => {
        await fs.rm(installDir, { recursive: true, force: true }).catch(() => {});
    });

    function makePluginRepo(rows: Record<string, Partial<PluginEntity>> = {}) {
        const state: Record<string, Partial<PluginEntity>> = { ...rows };
        const repo: Partial<PluginRepository> = {
            findByPluginId: jest.fn(async (id: string) => (state[id] as PluginEntity) ?? null),
            updateInstallState: jest.fn(async (id, installState, details) => {
                const next = {
                    ...(state[id] || { pluginId: id }),
                    installState,
                    ...(details || {}),
                };
                state[id] = next;
                return next as PluginEntity;
            }),
            findByInstallState: jest.fn(
                async (s) =>
                    Object.values(state).filter((r) => r.installState === s) as PluginEntity[],
            ),
        };
        return repo as PluginRepository & { _state: typeof state };
    }

    function makeAllowlistRepo(entries: Partial<PluginAllowlistEntity>[] = []) {
        const repo: Partial<PluginAllowlistRepository> = {
            findByPackageName: jest.fn(
                async (name) =>
                    (entries.find((e) => e.packageName === name) as PluginAllowlistEntity) ?? null,
            ),
        };
        return repo as PluginAllowlistRepository;
    }

    function makePacoteStub(manifestById: Record<string, PacoteManifest> = {}): PacoteLike & {
        manifestCalls: string[];
        extractCalls: { spec: string; dest: string }[];
    } {
        const manifestCalls: string[] = [];
        const extractCalls: { spec: string; dest: string }[] = [];
        return {
            manifestCalls,
            extractCalls,
            async manifest(spec: string) {
                manifestCalls.push(spec);
                const key = spec.split('@').slice(0, -1).join('@') || spec;
                const m = manifestById[key];
                if (!m) throw new Error(`pacote stub: no manifest for ${spec}`);
                return m;
            },
            async extract(spec: string, dest: string) {
                extractCalls.push({ spec, dest });
                await fs.mkdir(dest, { recursive: true });
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({ name: spec.split('@').slice(0, -1).join('@') }),
                );
                return undefined;
            },
        };
    }

    function makeInstaller(
        overrides: {
            options?: Partial<PluginsModuleOptions>;
            pluginRepo?: PluginRepository;
            allowlistRepo?: PluginAllowlistRepository | null;
            pacote?: PacoteLike | null;
        } = {},
    ) {
        const opts: PluginsModuleOptions = {
            distributionMode: 'dynamic',
            installDir,
            registryUrl: 'https://registry.example/',
            registryGithubUrl: 'https://npm.pkg.github.example/',
            ...overrides.options,
        };
        const installer = new PluginInstallerService(
            opts,
            overrides.pluginRepo ?? makePluginRepo(),
            overrides.allowlistRepo === undefined ? null : overrides.allowlistRepo,
            overrides.pacote ?? null,
        );
        if (overrides.pacote !== undefined) installer.setPacoteForTests(overrides.pacote);
        return installer;
    }

    describe('bundled mode (FR-22 — no behaviour change)', () => {
        it('install() refuses with 409 in bundled mode', async () => {
            const installer = makeInstaller({ options: { distributionMode: 'bundled' } });
            await expect(
                installer.install({ pluginId: 'notion-extractor' }),
            ).rejects.toBeInstanceOf(HttpException);
        });

        it('ensurePluginAvailable() returns null in bundled mode (no IO)', async () => {
            const pluginRepo = makePluginRepo();
            const installer = makeInstaller({
                options: { distributionMode: 'bundled' },
                pluginRepo,
            });
            await expect(installer.ensurePluginAvailable('notion-extractor')).resolves.toBeNull();
            expect(pluginRepo.findByPluginId).not.toHaveBeenCalled();
        });

        it('warmupFromDb() is a no-op in bundled mode', async () => {
            const installer = makeInstaller({ options: { distributionMode: 'bundled' } });
            await expect(installer.warmupFromDb()).resolves.toEqual({
                attempted: 0,
                succeeded: 0,
                failed: 0,
            });
        });
    });

    describe('allowlist (FR-11)', () => {
        it('implicitly allows first-party @ever-works/* without consulting the allowlist repo', async () => {
            const allowlist = makeAllowlistRepo([]);
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '1.2.0',
                    _integrity: 'sha512-abc',
                },
            });
            const installer = makeInstaller({ allowlistRepo: allowlist, pacote });

            await installer.install({ pluginId: 'notion-extractor' });

            expect(allowlist.findByPackageName).not.toHaveBeenCalled();
        });

        it('refuses non-first-party package before any pacote call when allowlist row is absent', async () => {
            const allowlist = makeAllowlistRepo([]);
            const pacote = makePacoteStub();
            const installer = makeInstaller({ allowlistRepo: allowlist, pacote });

            await expect(
                installer.install({
                    pluginId: 'cool-plugin',
                    packageName: '@some-vendor/cool-plugin',
                }),
            ).rejects.toMatchObject({ status: 409 });
            expect(pacote.manifestCalls).toEqual([]);
        });

        it('refuses disabled allowlist row (disabled = treat as absent)', async () => {
            const allowlist = makeAllowlistRepo([
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '*',
                    enabled: false,
                    source: 'npm',
                },
            ]);
            const pacote = makePacoteStub();
            const installer = makeInstaller({ allowlistRepo: allowlist, pacote });

            await expect(
                installer.install({
                    pluginId: 'cool-plugin',
                    packageName: '@some-vendor/cool-plugin',
                }),
            ).rejects.toMatchObject({ status: 409 });
            expect(pacote.manifestCalls).toEqual([]);
        });

        it('permits non-first-party package when enabled allowlist row matches', async () => {
            const allowlist = makeAllowlistRepo([
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '^2.0.0',
                    enabled: true,
                    source: 'npm',
                },
            ]);
            const pacote = makePacoteStub({
                '@some-vendor/cool-plugin': { version: '2.1.3', _integrity: 'sha512-z' },
            });
            const installer = makeInstaller({ allowlistRepo: allowlist, pacote });

            await expect(
                installer.install({
                    pluginId: 'cool-plugin',
                    packageName: '@some-vendor/cool-plugin',
                }),
            ).resolves.toMatchObject({ version: '2.1.3' });
        });

        it('refuses when resolved version violates allowlist versionRange', async () => {
            const allowlist = makeAllowlistRepo([
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '^1.0.0',
                    enabled: true,
                    source: 'npm',
                },
            ]);
            const pacote = makePacoteStub({
                '@some-vendor/cool-plugin': { version: '2.1.3', _integrity: 'sha512-z' },
            });
            const installer = makeInstaller({ allowlistRepo: allowlist, pacote });

            await expect(
                installer.install({
                    pluginId: 'cool-plugin',
                    packageName: '@some-vendor/cool-plugin',
                }),
            ).rejects.toMatchObject({ status: 409 });
        });
    });

    describe('integrity (FR-10)', () => {
        it('refuses with 424 when caller-supplied integrity does not match registry', async () => {
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '1.2.0',
                    _integrity: 'sha512-registry',
                },
            });
            const installer = makeInstaller({ pacote });

            await expect(
                installer.install({
                    pluginId: 'notion-extractor',
                    integrity: 'sha512-caller-expected-but-different',
                }),
            ).rejects.toMatchObject({ status: 424 });
        });

        it('accepts and persists matching integrity', async () => {
            const pluginRepo = makePluginRepo();
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '1.2.0',
                    _integrity: 'sha512-match',
                },
            });
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.install({
                pluginId: 'notion-extractor',
                integrity: 'sha512-match',
            });

            expect(result.integrity).toBe('sha512-match');
            expect(pluginRepo.updateInstallState).toHaveBeenCalledWith(
                'notion-extractor',
                'installed',
                expect.objectContaining({
                    installedVersion: '1.2.0',
                    integrity: 'sha512-match',
                    registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
                }),
            );
        });
    });

    describe('concurrency (FR-13)', () => {
        it('dedupes concurrent ensurePluginAvailable() calls via the in-flight map', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': { pluginId: 'notion-extractor', installState: 'available' },
            });
            let manifestResolve: ((v: PacoteManifest) => void) | null = null;
            const pacote: PacoteLike = {
                async manifest() {
                    return new Promise<PacoteManifest>((resolve) => {
                        manifestResolve = resolve;
                    });
                },
                async extract(_spec, dest) {
                    await fs.mkdir(dest, { recursive: true });
                    return undefined;
                },
            };
            const installer = makeInstaller({ pluginRepo, pacote });

            const a = installer.ensurePluginAvailable('notion-extractor');
            const b = installer.ensurePluginAvailable('notion-extractor');

            // Trip the gate.
            manifestResolve?.({ version: '1.2.0', _integrity: 'sha512-x' });

            const [ra, rb] = await Promise.all([a, b]);
            expect(ra).toBe(rb);
        });
    });

    describe('uninstall (T20)', () => {
        it('refuses with 409 when the plugin is systemPlugin', async () => {
            const pluginRepo = makePluginRepo({
                'local-fs': {
                    pluginId: 'local-fs',
                    installState: 'installed',
                    source: 'bundled',
                    manifest: { systemPlugin: true } as never,
                },
            });
            const installer = makeInstaller({ pluginRepo });

            await expect(installer.uninstall('local-fs')).rejects.toMatchObject({ status: 409 });
        });

        it('refuses with 409 when the plugin is bundled (source==="bundled")', async () => {
            const pluginRepo = makePluginRepo({
                tavily: {
                    pluginId: 'tavily',
                    installState: 'installed',
                    source: 'bundled',
                    manifest: {} as never,
                },
            });
            const installer = makeInstaller({ pluginRepo });

            await expect(installer.uninstall('tavily')).rejects.toMatchObject({ status: 409 });
        });

        it('marks installState=available and removes the symlink for a distributable plugin', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': {
                    pluginId: 'notion-extractor',
                    installState: 'installed',
                    source: 'registry',
                    registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
                    manifest: { systemPlugin: false } as never,
                },
            });
            const linkParent = path.join(installDir, 'node_modules', '@ever-works');
            await fs.mkdir(linkParent, { recursive: true });
            await fs.writeFile(path.join(linkParent, 'notion-extractor-plugin'), 'stub');

            const installer = makeInstaller({ pluginRepo });

            await installer.uninstall('notion-extractor');

            expect(pluginRepo.updateInstallState).toHaveBeenCalledWith(
                'notion-extractor',
                'available',
                expect.objectContaining({ installError: null }),
            );
            await expect(
                fs.stat(path.join(linkParent, 'notion-extractor-plugin')),
            ).rejects.toBeDefined();
        });
    });

    describe('warmup (FR-13a)', () => {
        it('attempts to install every installed/registry plugin in the DB', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': {
                    pluginId: 'notion-extractor',
                    installState: 'installed',
                    source: 'registry',
                    installedVersion: '1.2.0',
                    registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
                    integrity: 'sha512-x',
                },
                'pdf-extractor': {
                    pluginId: 'pdf-extractor',
                    installState: 'installed',
                    source: 'bundled', // bundled — NOT warmed up
                },
            });
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '1.2.0',
                    _integrity: 'sha512-x',
                },
            });
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.warmupFromDb();
            // pdf-extractor (bundled) is skipped; notion-extractor is
            // already cached via fast-path so no pacote.manifest call.
            expect(result.attempted).toBe(1);
            expect(result.succeeded).toBe(1);
            expect(pacote.manifestCalls).toEqual([]);
        });
    });
});
