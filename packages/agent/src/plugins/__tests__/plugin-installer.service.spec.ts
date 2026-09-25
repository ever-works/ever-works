import { HttpException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    PluginInstallerService,
    PluginInstallRefusedError,
    type PacoteLike,
    type PacoteManifest,
    type PacoteOptions,
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
            // Pre-create the deferred so `manifest()` returns the same
            // pending promise regardless of when it's called. The test
            // body trips the gate by resolving the deferred — order-
            // independent vs. when install() actually awaits manifest().
            let resolveManifest!: (v: PacoteManifest) => void;
            const manifestPromise = new Promise<PacoteManifest>((r) => {
                resolveManifest = r;
            });
            let manifestCalls = 0;
            const pacote: PacoteLike = {
                async manifest() {
                    manifestCalls += 1;
                    return manifestPromise;
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
            resolveManifest({ version: '1.2.0', _integrity: 'sha512-x' });

            const [ra, rb] = await Promise.all([a, b]);
            expect(ra).toBe(rb);
            // Dedup invariant: only one install() should have reached
            // pacote.manifest() despite the two concurrent ensure calls.
            expect(manifestCalls).toBe(1);
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
            // pinned by its row, so nothing is RESOLVED (no pacote.manifest
            // call). This replica's store is empty, so the pinned version is
            // fetched into it — warming the store is what the warmup is for
            // (T27: the row alone is not proof the files are on this node).
            expect(result.attempted).toBe(1);
            expect(result.succeeded).toBe(1);
            expect(pacote.manifestCalls).toEqual([]);
            expect(pacote.extractCalls.map((call) => call.spec)).toEqual([
                '@ever-works/notion-extractor-plugin@1.2.0',
            ]);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        // The API awaits the warmup before it serves (ApiModule
        // onApplicationBootstrap), and a registry fetch has no overall
        // deadline of its own: one hanging fetch must not hold the boot.
        it('gives up on a fetch that outlasts warmupTimeoutMs, so a hanging registry does not hold the boot', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': {
                    pluginId: 'notion-extractor',
                    installState: 'installed',
                    source: 'registry',
                    installedVersion: '1.2.0',
                    registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
                    integrity: 'sha512-x',
                },
            });
            const pacote = makePinnedPacote({ gate: new Promise<void>(() => undefined) });
            const installer = makeInstaller({
                pluginRepo,
                pacote,
                options: { warmupTimeoutMs: 50 },
            });

            const result = await installer.warmupFromDb();

            expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
            expect(pacote.extractCalls).toHaveLength(1);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        }, 3_000);
    });

    /**
     * A pacote double for PINNED installs: `manifest` must never be needed
     * (the row already pins the exact version and integrity), and `extract`
     * writes a package.json that names the package and version — what a real
     * tarball carries — optionally leaving a partial tree and then failing.
     */
    function makePinnedPacote(
        behaviour: { fail?: Error; gate?: Promise<void> } = {},
    ): PacoteLike & {
        manifestCalls: string[];
        extractCalls: { spec: string; dest: string; opts?: PacoteOptions }[];
    } {
        const manifestCalls: string[] = [];
        const extractCalls: { spec: string; dest: string; opts?: PacoteOptions }[] = [];
        return {
            manifestCalls,
            extractCalls,
            async manifest(spec: string) {
                manifestCalls.push(spec);
                throw new Error(`a pinned install must not resolve ${spec}`);
            },
            async extract(spec: string, dest: string, opts?: PacoteOptions) {
                extractCalls.push({ spec, dest, opts });
                if (behaviour.gate) await behaviour.gate;
                const at = spec.lastIndexOf('@');
                await fs.mkdir(dest, { recursive: true });
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({ name: spec.slice(0, at), version: spec.slice(at + 1) }),
                );
                if (behaviour.fail) throw behaviour.fail;
                return undefined;
            },
        };
    }

    /** The row the API writes after a successful install: pinned, with integrity. */
    const PINNED_ROW: Partial<PluginEntity> = {
        pluginId: 'notion-extractor',
        source: 'registry',
        installState: 'installed',
        registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
        installedVersion: '1.2.0',
        integrity: 'sha512-pinned',
    };

    const versionedDirOf = (dir: string, safeName: string, version: string) =>
        path.join(dir, '.versions', safeName, version);

    /**
     * The completion marker the installer writes into a versioned directory
     * once a fetch is complete, recording the integrity it verified. The name
     * is pinned here on purpose: it is on-disk state that outlives a release.
     */
    const INSTALL_MARKER = '.ew-install.json';

    /**
     * A copy of `name@version` in the store. By default it is a COMPLETE copy,
     * as the installer leaves one: package.json plus the completion marker for
     * `integrity` ('sha512-pinned', the pin in {@link PINNED_ROW}).
     * `marker: false` models a tree with no marker — e.g. a partial extract
     * left by the pre-T27 installer, which extracted in place (pacote empties
     * the directory, then streams entries into it; package.json comes first in
     * an npm tarball).
     */
    async function writeLocalCopy(
        dir: string,
        name: string,
        version: string,
        copy: { marker?: boolean; integrity?: string | null } = {},
    ): Promise<void> {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
        if (copy.marker === false) return;
        await fs.writeFile(
            path.join(dir, INSTALL_MARKER),
            JSON.stringify({
                name,
                version,
                integrity: copy.integrity === undefined ? 'sha512-pinned' : copy.integrity,
            }),
        );
    }

    async function readMarker(dir: string): Promise<Record<string, unknown>> {
        return JSON.parse(await fs.readFile(path.join(dir, INSTALL_MARKER), 'utf-8'));
    }

    /**
     * EW-693 T27 — the worker-side (and any replica-local) install.
     *
     * The worker is a separate machine with its own store. It must install the
     * version the API PINNED (FR-10), into its own store, refuse before any
     * download what the allowlist refuses (FR-11), and NEVER write the shared
     * row: in the worker `PluginRepository` is a proxy to the API, so a
     * failure here would flip the platform-wide row to `error`.
     */
    describe('ensureLocalInstall (T27 — the pinned version, into this store, no shared-row writes)', () => {
        it('fetches the pinned version once — with its integrity — into the versioned store, and never writes the row', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.ensureLocalInstall('notion-extractor');

            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            expect(pacote.extractCalls).toHaveLength(1);
            expect(pacote.extractCalls[0].spec).toBe('@ever-works/notion-extractor-plugin@1.2.0');
            expect(pacote.extractCalls[0].opts).toMatchObject({
                integrity: 'sha512-pinned',
                registry: 'https://registry.example/',
            });
            expect(pacote.extractCalls[0].dest.startsWith(path.join(installDir, '.versions'))).toBe(
                true,
            );
            expect(pacote.manifestCalls).toEqual([]);
            expect(result).toEqual({
                pluginId: 'notion-extractor',
                packageName: '@ever-works/notion-extractor-plugin',
                version: '1.2.0',
                integrity: 'sha512-pinned',
                installPath: versioned,
                registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
            });
            await expect(
                fs.readFile(path.join(versioned, 'package.json'), 'utf-8'),
            ).resolves.toContain('"version":"1.2.0"');
            // The copy is marked complete, with the integrity that was verified.
            await expect(readMarker(versioned)).resolves.toMatchObject({
                name: '@ever-works/notion-extractor-plugin',
                version: '1.2.0',
                integrity: 'sha512-pinned',
            });
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it('answers from the store with no network call when this machine already has the pinned version', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            await writeLocalCopy(versioned, '@ever-works/notion-extractor-plugin', '1.2.0');
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.ensureLocalInstall('notion-extractor');

            expect(result.installPath).toBe(versioned);
            expect(pacote.extractCalls).toEqual([]);
            expect(pacote.manifestCalls).toEqual([]);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it('replaces a stale tree whose package.json does not match the pin', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            // e.g. a partial extract from an interrupted pre-T27 install.
            await writeLocalCopy(versioned, '@ever-works/notion-extractor-plugin', '0.0.0-partial');
            const installer = makeInstaller({ pluginRepo, pacote });

            await installer.ensureLocalInstall('notion-extractor');

            expect(pacote.extractCalls).toHaveLength(1);
            await expect(
                fs.readFile(path.join(versioned, 'package.json'), 'utf-8'),
            ).resolves.toContain('"version":"1.2.0"');
        });

        // A matching package.json is not proof of a complete tree: the pre-T27
        // installer extracted in place, and package.json is the first entry of
        // an npm tarball, so an interrupted extract leaves exactly this.
        it('fetches once over a tree whose package.json matches but that carries no completion marker', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            await writeLocalCopy(versioned, '@ever-works/notion-extractor-plugin', '1.2.0', {
                marker: false,
            });
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.ensureLocalInstall('notion-extractor');

            expect(result.installPath).toBe(versioned);
            expect(pacote.extractCalls).toHaveLength(1);
            await expect(readMarker(versioned)).resolves.toMatchObject({
                integrity: 'sha512-pinned',
            });
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();

            // Now complete: a second installer (a later run) answers it locally.
            const again = makePinnedPacote();
            await makeInstaller({ pluginRepo, pacote: again }).ensureLocalInstall(
                'notion-extractor',
            );
            expect(again.extractCalls).toEqual([]);
        });

        // A private registry can re-publish a version: the pin's integrity
        // changes, the name and version do not.
        it('fetches once when the complete copy was verified against a different integrity', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            await writeLocalCopy(versioned, '@ever-works/notion-extractor-plugin', '1.2.0', {
                integrity: 'sha512-before-republish',
            });
            const installer = makeInstaller({ pluginRepo, pacote });

            await installer.ensureLocalInstall('notion-extractor');

            expect(pacote.extractCalls).toHaveLength(1);
            expect(pacote.extractCalls[0].opts).toMatchObject({ integrity: 'sha512-pinned' });
            await expect(readMarker(versioned)).resolves.toMatchObject({
                integrity: 'sha512-pinned',
            });
        });

        it.each<[string, Partial<PluginEntity> | null]>([
            ['no row at all', null],
            ['a row not yet installed', { ...PINNED_ROW, installState: 'available' }],
            ['a row still installing', { ...PINNED_ROW, installState: 'installing' }],
            ['a row in error', { ...PINNED_ROW, installState: 'error' }],
            ['a bundled row', { ...PINNED_ROW, source: 'bundled' }],
            ['a row with no integrity (FR-10)', { ...PINNED_ROW, integrity: null }],
            ['a row with no registry spec', { ...PINNED_ROW, registrySpec: null }],
            ['a row with no installed version', { ...PINNED_ROW, installedVersion: null }],
        ])(
            'refuses %s — before any network call, and without writing the row',
            async (_label, row) => {
                const pluginRepo = makePluginRepo(row ? { 'notion-extractor': row } : {});
                const pacote = makePinnedPacote();
                const installer = makeInstaller({ pluginRepo, pacote });

                const attempt = installer.ensureLocalInstall('notion-extractor');

                await expect(attempt).rejects.toBeInstanceOf(PluginInstallRefusedError);
                await expect(attempt).rejects.toMatchObject({ status: 409 });
                expect(pacote.extractCalls).toEqual([]);
                expect(pacote.manifestCalls).toEqual([]);
                expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
            },
        );

        it('refuses a non-first-party package when no allowlist repository is bound — before any network call (FR-11)', async () => {
            const pluginRepo = makePluginRepo({
                'cool-plugin': {
                    ...PINNED_ROW,
                    pluginId: 'cool-plugin',
                    registrySpec: '@some-vendor/cool-plugin@2.1.3',
                    installedVersion: '2.1.3',
                },
            });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, allowlistRepo: null });

            await expect(installer.ensureLocalInstall('cool-plugin')).rejects.toBeInstanceOf(
                PluginInstallRefusedError,
            );
            expect(pacote.extractCalls).toEqual([]);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it('installs an allowlisted third-party package from the registry its allowlist row names', async () => {
            const pluginRepo = makePluginRepo({
                'cool-plugin': {
                    ...PINNED_ROW,
                    pluginId: 'cool-plugin',
                    registrySpec: '@some-vendor/cool-plugin@2.1.3',
                    installedVersion: '2.1.3',
                },
            });
            const allowlist = makeAllowlistRepo([
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '^2.0.0',
                    enabled: true,
                    source: 'github-packages',
                },
            ]);
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, allowlistRepo: allowlist });

            const result = await installer.ensureLocalInstall('cool-plugin');

            expect(result.installPath).toBe(
                versionedDirOf(installDir, '@some-vendor__cool-plugin', '2.1.3'),
            );
            expect(pacote.extractCalls).toHaveLength(1);
            expect(pacote.extractCalls[0].opts).toMatchObject({
                registry: 'https://npm.pkg.github.example/',
                integrity: 'sha512-pinned',
            });
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it.each<[string, Partial<PluginAllowlistEntity>]>([
            [
                'a disabled allowlist row',
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '*',
                    enabled: false,
                    source: 'npm',
                },
            ],
            [
                'a pin outside the allowlist range',
                {
                    packageName: '@some-vendor/cool-plugin',
                    versionRange: '^1.0.0',
                    enabled: true,
                    source: 'npm',
                },
            ],
        ])('refuses a third-party package for %s — before any network call', async (_l, row) => {
            const pluginRepo = makePluginRepo({
                'cool-plugin': {
                    ...PINNED_ROW,
                    pluginId: 'cool-plugin',
                    registrySpec: '@some-vendor/cool-plugin@2.1.3',
                    installedVersion: '2.1.3',
                },
            });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({
                pluginRepo,
                pacote,
                allowlistRepo: makeAllowlistRepo([row]),
            });

            await expect(installer.ensureLocalInstall('cool-plugin')).rejects.toBeInstanceOf(
                PluginInstallRefusedError,
            );
            expect(pacote.extractCalls).toEqual([]);
        });

        it('rejects when the fetch fails — writes no row, and leaves no temporary directory behind', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote({ fail: new Error('EINTEGRITY: sha512 mismatch') });
            const installer = makeInstaller({ pluginRepo, pacote });

            const attempt = installer.ensureLocalInstall('notion-extractor');

            await expect(attempt).rejects.toThrow('EINTEGRITY');
            await expect(attempt).rejects.not.toBeInstanceOf(PluginInstallRefusedError);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
            const parent = path.join(
                installDir,
                '.versions',
                '@ever-works__notion-extractor-plugin',
            );
            const left = await fs.readdir(parent).catch(() => [] as string[]);
            expect(left).toEqual([]);
        });

        it('dedupes two concurrent calls into ONE fetch', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            let open!: () => void;
            const gate = new Promise<void>((resolve) => {
                open = resolve;
            });
            const pacote = makePinnedPacote({ gate });
            const installer = makeInstaller({ pluginRepo, pacote });

            const a = installer.ensureLocalInstall('notion-extractor');
            const b = installer.ensureLocalInstall('notion-extractor');
            open();
            const [ra, rb] = await Promise.all([a, b]);

            expect(ra).toBe(rb);
            expect(pacote.extractCalls).toHaveLength(1);
        });

        it('refuses in bundled mode without reading the row', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({
                options: { distributionMode: 'bundled' },
                pluginRepo,
                pacote,
            });

            await expect(installer.ensureLocalInstall('notion-extractor')).rejects.toBeInstanceOf(
                PluginInstallRefusedError,
            );
            expect(pluginRepo.findByPluginId).not.toHaveBeenCalled();
            expect(pacote.extractCalls).toEqual([]);
        });
    });

    /**
     * EW-693 FR-13 — "replica B lazily installs". The shared row saying
     * `installed` is proof that SOME replica installed the plugin, not that
     * this one has the files: each replica has its own store (an `emptyDir`).
     * Before T27, `ensurePluginAvailable` answered from the row alone and
     * fetched nothing, returning a path that did not exist here.
     */
    describe('ensurePluginAvailable on a replica that did not run the install (FR-13)', () => {
        it('fetches the pinned version into THIS store, writes no row, and answers a path that exists here', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            // A second installer instance: the one on the replica that did NOT
            // run the install. Its store is empty.
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.ensurePluginAvailable('notion-extractor');

            expect(pacote.extractCalls).toHaveLength(1);
            expect(pacote.extractCalls[0].spec).toBe('@ever-works/notion-extractor-plugin@1.2.0');
            expect(pacote.extractCalls[0].opts).toMatchObject({ integrity: 'sha512-pinned' });
            expect(pacote.manifestCalls).toEqual([]);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                pluginId: 'notion-extractor',
                version: '1.2.0',
                registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
            });
            await expect(
                fs.readFile(path.join(result!.installPath, 'package.json'), 'utf-8'),
            ).resolves.toContain('"version":"1.2.0"');
        });

        it('makes no network call when this replica already holds the pinned version', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': PINNED_ROW });
            const pacote = makePinnedPacote();
            await writeLocalCopy(
                versionedDirOf(installDir, '@ever-works__notion-extractor-plugin', '1.2.0'),
                '@ever-works/notion-extractor-plugin',
                '1.2.0',
            );
            const installer = makeInstaller({ pluginRepo, pacote });

            const result = await installer.ensurePluginAvailable('notion-extractor');

            expect(pacote.extractCalls).toEqual([]);
            expect(pacote.manifestCalls).toEqual([]);
            await expect(
                fs.readFile(path.join(result!.installPath, 'package.json'), 'utf-8'),
            ).resolves.toContain('"version":"1.2.0"');
        });

        it('refuses to fetch a pinned row that carries no integrity (FR-10) — and writes no row', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': { ...PINNED_ROW, integrity: null },
            });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote });

            await expect(installer.ensurePluginAvailable('notion-extractor')).rejects.toMatchObject(
                { status: 409 },
            );
            expect(pacote.extractCalls).toEqual([]);
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });
    });

    describe('install() over an incomplete tree', () => {
        // Before T27, `install()` always extracted, so retrying an install that
        // was interrupted mid-extract repaired the tree. Placing files through
        // the store's fast path must not turn that retry into "installed" over
        // a broken tree.
        it('extracts again over a matching package.json with no completion marker, and records the install', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': { pluginId: 'notion-extractor', installState: 'installing' },
            });
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '1.2.0',
                    _integrity: 'sha512-pinned',
                },
            });
            const versioned = versionedDirOf(
                installDir,
                '@ever-works__notion-extractor-plugin',
                '1.2.0',
            );
            await writeLocalCopy(versioned, '@ever-works/notion-extractor-plugin', '1.2.0', {
                marker: false,
            });
            const installer = makeInstaller({ pluginRepo, pacote });

            await installer.install({ pluginId: 'notion-extractor', version: '1.2.0' });

            expect(pacote.extractCalls.map((call) => call.spec)).toEqual([
                '@ever-works/notion-extractor-plugin@1.2.0',
            ]);
            await expect(readMarker(versioned)).resolves.toMatchObject({
                integrity: 'sha512-pinned',
            });
            expect(pluginRepo.updateInstallState).toHaveBeenLastCalledWith(
                'notion-extractor',
                'installed',
                expect.objectContaining({ installedVersion: '1.2.0', integrity: 'sha512-pinned' }),
            );
        });
    });

    /**
     * The versioned store path is built from row data — `registrySpec` and
     * `installedVersion`, which reach the worker over the internal API — and
     * the fetch REPLACES a stale tree at that path (a recursive delete). A pin
     * that is not a plain npm name and an exact version must be refused before
     * anything on disk is touched, however it got into the row.
     *
     * The store sits in a sandbox (`<tmp>/store`), next to a `victim`
     * directory, so a path that escapes the store lands somewhere the test can
     * see — and delete safely.
     */
    describe('a pin that would reach outside the store', () => {
        let store: string;
        let victim: string;

        beforeEach(async () => {
            store = path.join(installDir, 'store');
            victim = path.join(installDir, 'victim');
            await fs.mkdir(victim, { recursive: true });
            await fs.writeFile(path.join(victim, 'keep.txt'), 'not the store');
        });

        const victimIntact = async () =>
            expect(fs.readFile(path.join(victim, 'keep.txt'), 'utf-8')).resolves.toBe(
                'not the store',
            );

        // `<store>/.versions/@ever-works__notion-extractor-plugin/../../../victim`
        // is `<tmp>/victim`.
        const TRAVERSING_VERSION: Partial<PluginEntity> = {
            ...PINNED_ROW,
            registrySpec: '@ever-works/notion-extractor-plugin@../../../victim',
            installedVersion: '../../../victim',
        };

        it('ensureLocalInstall refuses an installed version that is a path, before any fetch or delete', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': TRAVERSING_VERSION });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, options: { installDir: store } });

            await expect(installer.ensureLocalInstall('notion-extractor')).rejects.toBeInstanceOf(
                PluginInstallRefusedError,
            );
            expect(pacote.extractCalls).toEqual([]);
            await victimIntact();
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it('ensureLocalInstall refuses a package name that is a path, before any fetch', async () => {
            // Starts with `@ever-works/`, so the first-party allowlist rule
            // admits it; the store path would be `<tmp>/victim/1.0.0`.
            const pluginRepo = makePluginRepo({
                'notion-extractor': {
                    ...PINNED_ROW,
                    registrySpec: '@ever-works/../../../../victim@1.0.0',
                    installedVersion: '1.0.0',
                },
            });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, options: { installDir: store } });

            await expect(installer.ensureLocalInstall('notion-extractor')).rejects.toBeInstanceOf(
                PluginInstallRefusedError,
            );
            expect(pacote.extractCalls).toEqual([]);
            await expect(fs.readdir(victim)).resolves.toEqual(['keep.txt']);
        });

        it.each(['1.2', 'v1.2.0', '^1.2.0', 'latest', '1.2.0/..', 'file:../victim'])(
            'ensureLocalInstall refuses the version %p — only an exact semver version is fetched',
            async (version) => {
                const pluginRepo = makePluginRepo({
                    'notion-extractor': {
                        ...PINNED_ROW,
                        registrySpec: `@ever-works/notion-extractor-plugin@${version}`,
                        installedVersion: version,
                    },
                });
                const pacote = makePinnedPacote();
                const installer = makeInstaller({
                    pluginRepo,
                    pacote,
                    options: { installDir: store },
                });

                await expect(
                    installer.ensureLocalInstall('notion-extractor'),
                ).rejects.toBeInstanceOf(PluginInstallRefusedError);
                expect(pacote.extractCalls).toEqual([]);
            },
        );

        it('ensurePluginAvailable refuses the same pin without touching the disk', async () => {
            const pluginRepo = makePluginRepo({ 'notion-extractor': TRAVERSING_VERSION });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, options: { installDir: store } });

            await expect(installer.ensurePluginAvailable('notion-extractor')).rejects.toMatchObject(
                { status: 409 },
            );
            expect(pacote.extractCalls).toEqual([]);
            await victimIntact();
            expect(pluginRepo.updateInstallState).not.toHaveBeenCalled();
        });

        it('install() refuses a version the registry answers as a path, before any extract or delete', async () => {
            const pluginRepo = makePluginRepo();
            const pacote = makePacoteStub({
                '@ever-works/notion-extractor-plugin': {
                    version: '../../../victim',
                    _integrity: 'sha512-x',
                },
            });
            const installer = makeInstaller({ pluginRepo, pacote, options: { installDir: store } });

            await expect(
                installer.install({ pluginId: 'notion-extractor', version: '1.2.0' }),
            ).rejects.toMatchObject({ status: 409 });
            expect(pacote.extractCalls).toEqual([]);
            await victimIntact();
        });

        it('still installs an exact pre-release version', async () => {
            const pluginRepo = makePluginRepo({
                'notion-extractor': {
                    ...PINNED_ROW,
                    registrySpec: '@ever-works/notion-extractor-plugin@1.3.0-rc.1+build.7',
                    installedVersion: '1.3.0-rc.1+build.7',
                },
            });
            const pacote = makePinnedPacote();
            const installer = makeInstaller({ pluginRepo, pacote, options: { installDir: store } });

            const result = await installer.ensureLocalInstall('notion-extractor');

            expect(result.installPath).toBe(
                versionedDirOf(store, '@ever-works__notion-extractor-plugin', '1.3.0-rc.1+build.7'),
            );
            expect(pacote.extractCalls).toHaveLength(1);
        });
    });
});
