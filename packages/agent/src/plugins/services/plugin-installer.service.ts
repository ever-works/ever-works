import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PluginRepository } from '../repositories/plugin.repository';
import { PluginAllowlistRepository } from '../repositories/plugin-allowlist.repository';
import type { PluginInstallState } from '../entities/plugin.entity';

/**
 * EW-693 T27 — the completion marker in a versioned store directory. Written
 * by the installer after a verified extract, before the directory is renamed
 * into place; it records the integrity the copy was verified against. A tree
 * without it (e.g. one a pre-T27 in-place extract left) is fetched again.
 */
export const INSTALL_MARKER_FILE = '.ew-install.json';

/** The boot warmup's default per-plugin bound (`PLUGIN_WARMUP_TIMEOUT_MS`). */
export const DEFAULT_WARMUP_TIMEOUT_MS = 60_000;

/**
 * A plain npm package name: an optional `@scope/`, then ONE path segment that
 * does not start with `.` — no `/`, `\` or `..` beyond the scope separator.
 * Upper case is admitted for legacy names.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/**
 * An exact semver version (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build.7`) — never a
 * range, a tag, or a path: identifiers are non-empty, so `..` cannot occur.
 */
const EXACT_SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;

/** The content of {@link INSTALL_MARKER_FILE}. */
interface InstallMarker {
    name: string;
    version: string;
    integrity: string | null;
    installedAt: string;
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') throw new Error(`${file} is not a JSON object`);
    return parsed as Record<string, unknown>;
}

/**
 * EW-693 — Dynamic plugin installer.
 *
 * Resolves, verifies, downloads, and places a distributable plugin
 * into the per-replica install dir so the existing loader can
 * dynamic-`import()` it. Wraps the official `pacote` SDK (used by npm
 * itself) so we inherit:
 *
 * - Registry auth header handling (no hand-rolled npmrc parsing).
 * - Tarball integrity verification (sha512) BEFORE extract (FR-10).
 * - Scoped-registry routing (`@ever-works:registry`) for the
 *   github-packages fallback.
 *
 * In `bundled` mode the installer is INERT — `install()` short-circuits
 * with a clear error so accidental calls in bundled-mode tests don't
 * make a real network round-trip.
 *
 * Allow-list (FR-11): first-party `@ever-works/*` is implicitly allowed.
 * Everything else MUST match an enabled `plugin_allowlist` row by
 * package name; the version must satisfy `versionRange`; refuse with
 * HTTP 409 BEFORE any network fetch.
 *
 * Per-id concurrency (FR-13): `ensurePluginAvailable` dedupes in-flight
 * installs through a `Map<pluginId, Promise>` so two concurrent enables
 * of the same plugin don't double-fetch.
 *
 * ## The shared row vs. this node's store (EW-693 T27)
 *
 * The `plugins` row is SHARED by every API replica (and read by the
 * Trigger.dev worker over the internal API); the store under `installDir` is
 * per node. A row that says `installed` proves that SOME node installed the
 * plugin, not that this one has the files. So:
 *
 * - {@link install} — the explicit install — is the only method that writes
 *   the row's install state (`installing` → `installed` | `error`).
 * - {@link ensureLocalInstall} places the version the row PINS (exact version
 *   + integrity) into THIS node's store and never writes the row. It is what
 *   the worker uses: there `PluginRepository` is a proxy to the API, so a
 *   write would flip the platform-wide row.
 * - {@link ensurePluginAvailable} answers from this node's store when it holds
 *   the pinned version, fetches it (the same no-row-write path) when it does
 *   not, and runs a full {@link install} only for a plugin no node has
 *   installed yet.
 *
 * The store is content-addressed by `name@version`
 * (`<installDir>/.versions/<scope>__<name>/<version>`); a new version is
 * extracted into a temporary sibling, marked complete ({@link INSTALL_MARKER_FILE},
 * recording the integrity it was verified against) and renamed into place, so
 * a reader never sees a half-extracted tree, and a tree without the marker —
 * or marked for another integrity — is fetched again. The store path is built
 * from the pin, so a pin that is not a plain npm name and an exact semver
 * version is refused before anything on disk is touched. Neither method
 * registers the plugin: callers pass the answered `installPath` to
 * `PluginLoaderService.registerFromPath`.
 */
@Injectable()
export class PluginInstallerService {
    private readonly logger = new Logger(PluginInstallerService.name);
    private readonly installDir: string;
    private readonly registryUrl: string;
    private readonly registryGithubUrl: string;
    private readonly registryToken: string | undefined;
    private readonly distributionMode: 'bundled' | 'dynamic';
    /** Per-plugin bound on the boot warmup; `0` = none. See {@link warmupFromDb}. */
    private readonly warmupTimeoutMs: number;

    /**
     * Per-`pluginId` in-flight install promise. The first caller writes
     * its promise here; subsequent callers `await` the same promise
     * instead of starting a duplicate install. The entry is cleared
     * (success or failure) so a retry after a failure starts fresh.
     */
    private readonly inFlight = new Map<string, Promise<PluginInstallResult>>();

    /**
     * Per-`pluginId` in-flight {@link ensureLocalInstall}. Separate from
     * {@link inFlight}: that map's promises may run a row-writing
     * {@link install}, and a local install must never share one.
     */
    private readonly localInFlight = new Map<string, Promise<PluginInstallResult>>();

    constructor(
        @Inject(PLUGINS_MODULE_OPTIONS)
        options: PluginsModuleOptions,
        private readonly pluginRepository: PluginRepository,
        @Optional()
        private readonly allowlistRepository: PluginAllowlistRepository | null,
        /**
         * Indirection seam for tests. Production code leaves this null;
         * the service lazy-imports `pacote` on first install. Tests
         * inject a stub via {@link setPacoteForTests} to avoid hitting
         * a real registry.
         */
        @Optional()
        @Inject('PLUGIN_INSTALLER_PACOTE')
        private pacote: PacoteLike | null = null,
    ) {
        this.distributionMode = options.distributionMode ?? 'bundled';
        this.installDir = options.installDir ?? '/app/plugins';
        this.registryUrl = options.registryUrl ?? 'https://registry.npmjs.org';
        this.registryGithubUrl = options.registryGithubUrl ?? 'https://npm.pkg.github.com';
        this.registryToken = options.registryToken;
        const warmupTimeoutMs = options.warmupTimeoutMs;
        this.warmupTimeoutMs =
            typeof warmupTimeoutMs === 'number' &&
            Number.isFinite(warmupTimeoutMs) &&
            warmupTimeoutMs >= 0
                ? warmupTimeoutMs
                : DEFAULT_WARMUP_TIMEOUT_MS;
    }

    /**
     * Test-only: inject a mock pacote-like object. Production code does
     * not call this — the service lazy-imports the real `pacote` module
     * on first use.
     */
    setPacoteForTests(impl: PacoteLike | null): void {
        this.pacote = impl;
    }

    getInstallDir(): string {
        return this.installDir;
    }

    getDistributionMode(): 'bundled' | 'dynamic' {
        return this.distributionMode;
    }

    /**
     * EW-693 / FR-13a — Boot reconcile warmup.
     *
     * In `dynamic` mode, on every node boot, pre-install the DB-recorded
     * `installed` distributable plugin set so the first request after
     * boot doesn't pay the install cost. Failures are logged but
     * non-fatal — lazy install-on-use (FR-13) is the correctness
     * mechanism; warmup is optimisation only.
     *
     * The API awaits this before it serves, and a registry fetch has no
     * overall deadline of its own, so each plugin is given at most
     * `warmupTimeoutMs` (`PLUGIN_WARMUP_TIMEOUT_MS`, default 60 s; `0` = no
     * bound). A plugin that runs past it counts as failed; its fetch carries
     * on in the background, and the first use waits for that same fetch. The
     * warmup places files only — it does not register the plugins.
     *
     * In `bundled` mode this is a no-op.
     */
    async warmupFromDb(): Promise<{ attempted: number; succeeded: number; failed: number }> {
        if (this.distributionMode !== 'dynamic') {
            return { attempted: 0, succeeded: 0, failed: 0 };
        }

        const installed = await this.pluginRepository.findByInstallState('installed');
        const distributable = installed.filter((p) => p.source === 'registry');

        if (distributable.length === 0) {
            return { attempted: 0, succeeded: 0, failed: 0 };
        }

        this.logger.log(
            `EW-693 boot warmup: pre-installing ${distributable.length} dynamic plugin(s) from DB`,
        );

        const results = await Promise.allSettled(
            distributable.map((p) =>
                this.withinWarmupDeadline(this.ensurePluginAvailable(p.pluginId)),
            ),
        );
        const succeeded = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.length - succeeded;

        for (const [i, r] of results.entries()) {
            if (r.status === 'rejected') {
                this.logger.warn(
                    `EW-693 warmup failed for ${distributable[i].pluginId}: ${
                        r.reason instanceof Error ? r.reason.message : String(r.reason)
                    }`,
                );
            }
        }

        return { attempted: distributable.length, succeeded, failed };
    }

    /**
     * `work`, or a rejection once `warmupTimeoutMs` has passed. The work is not
     * cancelled — `Promise.race` keeps handling its outcome — so a fetch that
     * finishes late still lands in the store (and in-flight callers share it).
     */
    private async withinWarmupDeadline<T>(work: Promise<T>): Promise<T> {
        if (this.warmupTimeoutMs <= 0) return work;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `timed out after ${this.warmupTimeoutMs} ms (PLUGIN_WARMUP_TIMEOUT_MS); ` +
                                'the fetch continues in the background and the first use waits for it',
                        ),
                    ),
                this.warmupTimeoutMs,
            );
            timer.unref?.();
        });
        try {
            return await Promise.race([work, deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Resolve, allowlist-check, fetch, integrity-verify, and place a
     * distributable plugin. Idempotent — a second call with the same
     * `pluginId` + `version` returns the cached install result.
     *
     * @param input.pluginId         Plugin id (matches `everworks.plugin.id`).
     * @param input.packageName      Optional override. Defaults to
     *                               `@ever-works/<pluginId>-plugin`.
     * @param input.version          Optional version. Defaults to `latest`.
     * @param input.integrity        Optional sha512. If set, must match.
     * @param input.source           Registry to use: 'npm' (default) or
     *                               'github-packages'.
     */
    async install(input: PluginInstallInput): Promise<PluginInstallResult> {
        this.assertDynamicMode('install');
        const packageName = input.packageName || this.derivePackageName(input.pluginId);

        // Allowlist check FIRST — refuse BEFORE any network fetch (FR-11).
        const allow = await this.checkAllowlist(packageName);
        if (!allow.allowed) {
            await this.recordInstallError(input.pluginId, allow.reason);
            throw new HttpException(
                { statusCode: 409, message: allow.reason, pluginId: input.pluginId },
                HttpStatus.CONFLICT,
            );
        }

        // Resolve registry endpoint per allowlist source.
        const source = input.source || allow.source || 'npm';
        const registry = source === 'github-packages' ? this.registryGithubUrl : this.registryUrl;

        // Mark `installing` BEFORE any IO so the UI can poll progress.
        await this.pluginRepository.updateInstallState(input.pluginId, 'installing', {
            source: 'registry',
            installError: null,
        });

        try {
            const pacote = await this.getPacote();

            // Resolve npm spec → exact version + sha512 integrity.
            const spec = input.version
                ? `${packageName}@${input.version}`
                : `${packageName}@latest`;
            const manifest = await pacote.manifest(spec, this.pacoteOptions(registry));

            // Enforce allowlist version range when applicable.
            if (
                allow.versionRange &&
                !this.versionSatisfies(manifest.version, allow.versionRange)
            ) {
                throw new HttpException(
                    {
                        statusCode: 409,
                        message:
                            `Resolved version ${manifest.version} does not satisfy the ` +
                            `allowlist range "${allow.versionRange}" for ${packageName}.`,
                        pluginId: input.pluginId,
                    },
                    HttpStatus.CONFLICT,
                );
            }

            // Enforce optional caller-provided integrity (FR-10).
            if (input.integrity && manifest._integrity !== input.integrity) {
                throw new HttpException(
                    {
                        statusCode: 424,
                        message:
                            `Integrity mismatch for ${packageName}@${manifest.version}: ` +
                            `expected ${input.integrity}, registry returned ${manifest._integrity}.`,
                        pluginId: input.pluginId,
                    },
                    HttpStatus.FAILED_DEPENDENCY,
                );
            }

            // Place package into the per-version dir; pacote.extract
            // verifies the tarball integrity (FR-10). It extracts into a
            // temporary sibling that is marked complete and renamed into
            // place, so an aborted install can't leave a partial tree
            // behind — and a tree an older in-place extract left is
            // fetched again (T27 — `fetchPinned`).
            const destDir = await this.fetchPinned({
                pluginId: input.pluginId,
                packageName,
                version: manifest.version,
                integrity: manifest._integrity,
                registry,
            });

            // Symlink under node_modules so the existing loader's
            // `loadPluginModule(path)` can `await import()` it without
            // further wiring.
            const linkDir = await this.symlinkUnderNodeModules(packageName, destDir);

            const installedVersion = manifest.version;
            const integrity = manifest._integrity ?? null;
            const registrySpec = `${packageName}@${installedVersion}`;

            await this.pluginRepository.updateInstallState(input.pluginId, 'installed', {
                source: 'registry',
                registrySpec,
                installedVersion,
                integrity,
                installError: null,
            });

            return {
                pluginId: input.pluginId,
                packageName,
                version: installedVersion,
                integrity,
                installPath: linkDir,
                registrySpec,
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await this.recordInstallError(input.pluginId, reason);
            if (err instanceof HttpException) throw err;
            // Surface registry-level failures as 502/504 so the API
            // maps them to a meaningful client error (FR-13 docstring).
            const code = /timeout|ETIMEDOUT/i.test(reason)
                ? HttpStatus.GATEWAY_TIMEOUT
                : HttpStatus.BAD_GATEWAY;
            throw new HttpException(
                { statusCode: code, message: reason, pluginId: input.pluginId },
                code,
            );
        }
    }

    /**
     * Lazy install-on-use (FR-13) — the correctness mechanism for
     * multi-replica deployments. Deduplicates concurrent callers.
     *
     * - A plugin some node already installed (the shared row is `installed`
     *   with a pin): answered from THIS node's store when it holds a complete
     *   copy of the pinned version (marked complete, for the row's integrity
     *   when it has one) — no network call; otherwise the pinned version is
     *   fetched into it (allowlist first, integrity required), WITHOUT writing
     *   the shared row. A pin that is not a plain npm name and an exact
     *   version is refused (409) before the disk is touched. Before T27 the
     *   row alone was taken as proof that the files were here, so a replica
     *   that did not run the install fetched nothing and answered a path that
     *   did not exist.
     * - Any other plugin: a full {@link install}, which records the row.
     *
     * Answers the `node_modules` link to the package (created on this node if
     * missing). It does not register the plugin — pass `installPath` to
     * `PluginLoaderService.registerFromPath`.
     *
     * In `bundled` mode this is a no-op (answers `null`) — bundled plugins
     * are always present on disk.
     */
    async ensurePluginAvailable(pluginId: string): Promise<PluginInstallResult | null> {
        if (this.distributionMode !== 'dynamic') return null;

        const existing = this.inFlight.get(pluginId);
        if (existing) return existing;

        // FR-13 dedup: register the in-flight promise BEFORE any await so
        // concurrent callers see the entry on their synchronous lookup.
        // Otherwise both callers race past `findByPluginId` and each call
        // install() — the second `pacote.manifest()` clobbers the first's
        // resolver and one of the promises never settles.
        const promise = (async (): Promise<PluginInstallResult | null> => {
            const entity = await this.pluginRepository.findByPluginId(pluginId);
            if (
                entity?.installState === 'installed' &&
                entity.registrySpec &&
                entity.installedVersion
            ) {
                // Installed by SOME node. Make sure THIS node has the files.
                const packageName =
                    this.packageNameFromSpec(entity.registrySpec) ||
                    this.derivePackageName(pluginId);
                // The store path is built from the pin: refuse one that is
                // not a plain name and exact version before touching the disk.
                this.assertSafePin(pluginId, packageName, entity.installedVersion);
                const versioned = this.versionedDir(packageName, entity.installedVersion);
                const local = (await this.hasLocalCopy(
                    versioned,
                    packageName,
                    entity.installedVersion,
                    entity.integrity,
                ))
                    ? {
                          pluginId,
                          packageName,
                          version: entity.installedVersion,
                          integrity: entity.integrity,
                          installPath: versioned,
                          registrySpec: entity.registrySpec,
                      }
                    : await this.installPinnedLocally(pluginId, entity);
                return {
                    ...local,
                    installPath: await this.ensureNodeModulesLink(
                        local.packageName,
                        local.installPath,
                    ),
                };
            }

            return this.install({
                pluginId,
                packageName: entity?.registrySpec
                    ? (this.packageNameFromSpec(entity.registrySpec) ?? undefined)
                    : undefined,
                version: entity?.installedVersion ?? undefined,
                integrity: entity?.integrity ?? undefined,
            });
        })().finally(() => {
            this.inFlight.delete(pluginId);
        });
        this.inFlight.set(pluginId, promise);
        return promise;
    }

    /**
     * EW-693 T27 — place the version the platform PINNED into THIS node's
     * store, and never write the shared row. For the Trigger.dev worker (a
     * separate machine with its own store) and any node that must not own the
     * row's install state.
     *
     * Reads the row and refuses — with {@link PluginInstallRefusedError},
     * before any network call — unless it is a `registry`-sourced plugin in
     * state `installed` whose `registrySpec`, `installedVersion` and
     * `integrity` are all set (FR-10: exact version AND integrity). Then the
     * allowlist (FR-11: first-party `@ever-works/*`, or an enabled allowlist
     * row whose range admits the pinned version). Then the local store answers
     * — a complete copy marked for the pinned integrity, no network call — or
     * the pinned version is fetched into it with its integrity verified by
     * pacote. Concurrent calls for one plugin share one fetch.
     *
     * Answers the versioned directory itself (not the `node_modules` link):
     * pass it to `PluginLoaderService.registerFromPath`. A failure is logged
     * and tagged in Sentry, never recorded on the row.
     *
     * @throws PluginInstallRefusedError in `bundled` mode, for a row that is
     *   not installed and pinned, for a pin that is not a plain npm package
     *   name and an exact semver version, and for a package the allowlist
     *   refuses.
     */
    async ensureLocalInstall(pluginId: string): Promise<PluginInstallResult> {
        if (this.distributionMode !== 'dynamic') {
            throw new PluginInstallRefusedError(
                pluginId,
                `Cannot install plugin "${pluginId}" at runtime: PLUGIN_DISTRIBUTION_MODE is ` +
                    `"${this.distributionMode}". Set PLUGIN_DISTRIBUTION_MODE=dynamic to enable ` +
                    `runtime installs.`,
            );
        }

        const existing = this.localInFlight.get(pluginId);
        if (existing) return existing;

        // Registered BEFORE any await, as in `ensurePluginAvailable`.
        const promise = (async (): Promise<PluginInstallResult> => {
            const entity = await this.pluginRepository.findByPluginId(pluginId);
            return this.installPinnedLocally(pluginId, entity);
        })().finally(() => {
            this.localInFlight.delete(pluginId);
        });
        this.localInFlight.set(pluginId, promise);
        return promise;
    }

    /**
     * The pin check, the allowlist and the fetch shared by
     * {@link ensureLocalInstall} and {@link ensurePluginAvailable}'s
     * replica-local path. Writes no row.
     */
    private async installPinnedLocally(
        pluginId: string,
        entity: Awaited<ReturnType<PluginRepository['findByPluginId']>>,
    ): Promise<PluginInstallResult> {
        if (
            !entity ||
            entity.source !== 'registry' ||
            entity.installState !== 'installed' ||
            !entity.registrySpec ||
            !entity.installedVersion ||
            !entity.integrity
        ) {
            throw new PluginInstallRefusedError(
                pluginId,
                `Cannot install plugin "${pluginId}" on this node: ${describeMissingPin(entity)}. ` +
                    `Only a plugin the platform installed with a pinned version and integrity ` +
                    `can be installed on another node.`,
            );
        }

        const packageName =
            this.packageNameFromSpec(entity.registrySpec) || this.derivePackageName(pluginId);
        const version = entity.installedVersion;
        this.assertSafePin(pluginId, packageName, version);

        // Allowlist FIRST — refuse BEFORE any network fetch (FR-11).
        const allow = await this.checkAllowlist(packageName);
        if (!allow.allowed) {
            throw new PluginInstallRefusedError(
                pluginId,
                allow.reason ?? `Package "${packageName}" is not allowed.`,
            );
        }
        if (allow.versionRange && !this.versionSatisfies(version, allow.versionRange)) {
            throw new PluginInstallRefusedError(
                pluginId,
                `Pinned version ${version} does not satisfy the allowlist range ` +
                    `"${allow.versionRange}" for ${packageName}.`,
            );
        }
        const registry =
            allow.source === 'github-packages' ? this.registryGithubUrl : this.registryUrl;

        try {
            const installPath = await this.fetchPinned({
                pluginId,
                packageName,
                version,
                integrity: entity.integrity,
                registry,
            });
            return {
                pluginId,
                packageName,
                version,
                integrity: entity.integrity,
                installPath,
                registrySpec: entity.registrySpec,
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `EW-693 local install of ${pluginId} (${packageName}@${version}) failed: ${reason}`,
            );
            this.tagSentryError(pluginId, reason);
            throw err;
        }
    }

    /**
     * Uninstall a distributable plugin (T20). Refuses core /
     * `systemPlugin` plugins with HTTP 409. Default retention =
     * keep installed files on disk; only the symlink under
     * node_modules is removed and the DB row is marked
     * `installState='available'`. A subsequent ensure call re-creates
     * the link without re-downloading.
     */
    async uninstall(pluginId: string): Promise<void> {
        const entity = await this.pluginRepository.findByPluginId(pluginId);
        if (!entity) {
            throw new HttpException(
                { statusCode: 404, message: `Plugin "${pluginId}" not found` },
                HttpStatus.NOT_FOUND,
            );
        }
        const isSystem =
            (entity.manifest as Record<string, unknown> | undefined)?.systemPlugin === true;
        if (isSystem || entity.source === 'bundled') {
            throw new HttpException(
                {
                    statusCode: 409,
                    message:
                        `Plugin "${pluginId}" is a core/bundled plugin and cannot be uninstalled. ` +
                        `Disable it instead.`,
                },
                HttpStatus.CONFLICT,
            );
        }

        const packageName =
            (entity.registrySpec && this.packageNameFromSpec(entity.registrySpec)) ||
            this.derivePackageName(pluginId);
        const linkDir = this.symlinkPathFor(packageName);
        try {
            await fs.rm(linkDir, { force: true, recursive: false });
        } catch {
            // Already gone — fine.
        }

        await this.pluginRepository.updateInstallState(pluginId, 'available', {
            installError: null,
        });
    }

    // ─── allowlist ───────────────────────────────────────────────────

    /**
     * EW-693 / FR-11 — allow-list check.
     *
     * First-party `@ever-works/*` is implicitly permitted (no row
     * required). Everything else must match an enabled
     * `plugin_allowlist` row by `packageName`; a disabled row is
     * treated as absent.
     */
    private async checkAllowlist(packageName: string): Promise<AllowlistDecision> {
        if (packageName.startsWith('@ever-works/')) {
            return { allowed: true, source: 'npm' };
        }
        if (!this.allowlistRepository) {
            return {
                allowed: false,
                reason:
                    `Package "${packageName}" is not first-party (@ever-works/*) ` +
                    `and no allowlist repository is configured. Refusing install (FR-11).`,
            };
        }
        const row = await this.allowlistRepository.findByPackageName(packageName);
        if (!row) {
            return {
                allowed: false,
                reason:
                    `Package "${packageName}" is not on the admin allowlist. ` +
                    `Add it via POST /admin/plugins/allowlist before installing.`,
            };
        }
        if (!row.enabled) {
            return {
                allowed: false,
                reason:
                    `Package "${packageName}" is on the allowlist but disabled. ` +
                    `Re-enable it via PATCH /admin/plugins/allowlist/:id.`,
            };
        }
        return {
            allowed: true,
            versionRange: row.versionRange,
            integrity: row.integrity ?? undefined,
            source: row.source,
        };
    }

    // ─── helpers ────────────────────────────────────────────────────

    private async recordInstallError(pluginId: string, reason: string): Promise<void> {
        try {
            await this.pluginRepository.updateInstallState(pluginId, 'error', {
                installError: reason,
            });
        } catch (err) {
            this.logger.warn(
                `Failed to persist installState=error for ${pluginId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
        // EW-693 / T37 — tag Sentry with the install context so the error
        // shows up filterable by plugin_id + distribution_mode in the
        // dashboard. Lazy-imported so packages/agent builds without
        // @sentry/node resolved (bundled-mode-only deployments).
        this.tagSentryError(pluginId, reason);
    }

    /**
     * EW-693 / T37 — best-effort Sentry tag pass. Lazy-imports
     * `@sentry/node`; silently no-ops when the SDK isn't installed or
     * isn't initialised. Tags `plugin_id`, `plugin_source` (always
     * `registry` for installer errors), and `distribution_mode` so the
     * EW-693 install errors are filterable in the Sentry UI.
     */
    private tagSentryError(pluginId: string, reason: string): void {
        void (async () => {
            try {
                // String indirection — keeps TS from resolving '@sentry/node'
                // at type-check time so packages/agent builds without the
                // SDK in node_modules (bundled-only deployments).
                const sentryModuleId = '@sentry/node';
                const sentry = (await import(sentryModuleId).catch(() => null)) as {
                    withScope: (
                        cb: (scope: {
                            setTag: (k: string, v: string) => void;
                            setLevel: (level: string) => void;
                        }) => void,
                    ) => void;
                    captureException: (err: unknown) => string;
                } | null;
                if (!sentry?.withScope) return;
                sentry.withScope((scope) => {
                    scope.setTag('plugin_id', pluginId);
                    scope.setTag('plugin_source', 'registry');
                    scope.setTag('distribution_mode', this.distributionMode);
                    scope.setLevel('error');
                    sentry.captureException(new Error(`plugin.install.failed: ${reason}`));
                });
            } catch {
                // Best-effort — never surface Sentry errors back to the
                // caller.
            }
        })();
    }

    private assertDynamicMode(operation: string): void {
        if (this.distributionMode !== 'dynamic') {
            throw new HttpException(
                {
                    statusCode: 409,
                    message:
                        `Cannot ${operation} plugin: PLUGIN_DISTRIBUTION_MODE is "${this.distributionMode}". ` +
                        `Set PLUGIN_DISTRIBUTION_MODE=dynamic to enable runtime installs.`,
                },
                HttpStatus.CONFLICT,
            );
        }
    }

    private derivePackageName(pluginId: string): string {
        return `@ever-works/${pluginId}-plugin`;
    }

    private packageNameFromSpec(spec: string): string | null {
        // Matches `@scope/name@version` or `name@version`. Returns the
        // name (with scope if present). Versions like `@1.2.3` won't
        // confuse us because the scope/name portion is always before
        // the LAST `@`.
        const at = spec.lastIndexOf('@');
        if (at <= 0) return null;
        return spec.slice(0, at);
    }

    private versionedDir(packageName: string, version: string): string {
        // Encode scope so '@' doesn't escape the dir.
        const safe = packageName.replace('/', '__');
        return path.join(this.installDir, '.versions', safe, version);
    }

    private symlinkPathFor(packageName: string): string {
        // Mirror the npm node_modules layout so Node module resolution
        // picks the package up via standard import().
        return path.join(this.installDir, 'node_modules', packageName);
    }

    /**
     * EW-693 T27 — place `packageName@version` in this node's store and answer
     * its versioned directory.
     *
     * - The pin is checked first: a plain npm package name and an exact semver
     *   version, whose versioned directory lies inside `<installDir>/.versions`
     *   — otherwise {@link PluginInstallRefusedError}, before anything on disk
     *   is touched (the path comes from row data, and a stale tree there is
     *   deleted below).
     * - A COMPLETE local copy — package.json naming this package and version,
     *   plus the {@link INSTALL_MARKER_FILE} this method writes, recording
     *   `integrity` when one is pinned — is answered as is: no network call.
     * - Otherwise pacote extracts the exact version (verifying `integrity`
     *   when given) into a temporary sibling; the marker is written into it,
     *   and it is renamed into place, so the tree and its marker appear
     *   together. Whatever sits at the destination without a matching marker
     *   is replaced: a partial extract left by the pre-T27 installer (it
     *   extracted in place, and package.json is the first entry of an npm
     *   tarball), or a copy verified against another integrity (a re-published
     *   version). A complete copy another process placed first is kept. The
     *   temporary directory is always removed.
     */
    private async fetchPinned(pin: {
        pluginId: string;
        packageName: string;
        version: string;
        integrity?: string | null;
        registry: string;
    }): Promise<string> {
        this.assertSafePin(pin.pluginId, pin.packageName, pin.version);
        const destDir = this.versionedDir(pin.packageName, pin.version);
        const store = path.resolve(this.installDir, '.versions');
        if (!path.resolve(destDir).startsWith(store + path.sep)) {
            throw new PluginInstallRefusedError(
                pin.pluginId,
                `Refusing to place ${pin.packageName}@${pin.version} outside the plugin store ` +
                    `(${store}).`,
            );
        }
        if (await this.hasLocalCopy(destDir, pin.packageName, pin.version, pin.integrity)) {
            return destDir;
        }

        const pacote = await this.getPacote();
        await fs.mkdir(path.dirname(destDir), { recursive: true });
        const tmpDir = `${destDir}.tmp-${randomUUID()}`;
        try {
            await fs.mkdir(tmpDir, { recursive: true });
            const opts: PacoteOptions = { ...this.pacoteOptions(pin.registry) };
            if (pin.integrity) opts.integrity = pin.integrity;
            await pacote.extract(`${pin.packageName}@${pin.version}`, tmpDir, opts);
            const marker: InstallMarker = {
                name: pin.packageName,
                version: pin.version,
                integrity: pin.integrity ?? null,
                installedAt: new Date().toISOString(),
            };
            await fs.writeFile(path.join(tmpDir, INSTALL_MARKER_FILE), JSON.stringify(marker));
            try {
                await fs.rename(tmpDir, destDir);
            } catch (err) {
                // Another process placed a complete copy first: use it.
                if (await this.hasLocalCopy(destDir, pin.packageName, pin.version, pin.integrity)) {
                    return destDir;
                }
                const occupied = await fs.stat(destDir).then(
                    () => true,
                    () => false,
                );
                if (!occupied) throw err;
                // An incomplete or superseded tree: replace it.
                await fs.rm(destDir, { recursive: true, force: true });
                await fs.rename(tmpDir, destDir);
            }
            return destDir;
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /**
     * Whether `dir` holds a COMPLETE copy of `packageName@version`: its
     * package.json names them, and the {@link INSTALL_MARKER_FILE} written by
     * {@link fetchPinned} names them too and — when `integrity` is known —
     * records that same integrity. A tree with no marker is not proof of
     * anything (see {@link fetchPinned}).
     */
    private async hasLocalCopy(
        dir: string,
        packageName: string,
        version: string,
        integrity?: string | null,
    ): Promise<boolean> {
        try {
            const [pkg, marker] = await Promise.all([
                readJsonFile(path.join(dir, 'package.json')),
                readJsonFile(path.join(dir, INSTALL_MARKER_FILE)),
            ]);
            if (pkg.name !== packageName || pkg.version !== version) return false;
            if (marker.name !== packageName || marker.version !== version) return false;
            return !integrity || marker.integrity === integrity;
        } catch {
            return false;
        }
    }

    /**
     * Refuse a pin whose package name or version could turn the store path
     * (`<installDir>/.versions/<name>/<version>`) or the `node_modules` link
     * into a path outside the store, or make pacote fetch something other than
     * one registry version (a range, a tag, a `file:` or git spec).
     */
    private assertSafePin(pluginId: string, packageName: string, version: string): void {
        if (!NPM_PACKAGE_NAME.test(packageName)) {
            throw new PluginInstallRefusedError(
                pluginId,
                `Refusing to install plugin "${pluginId}": "${packageName}" is not a valid npm ` +
                    `package name.`,
            );
        }
        if (!EXACT_SEMVER.test(version)) {
            throw new PluginInstallRefusedError(
                pluginId,
                `Refusing to install plugin "${pluginId}": "${version}" is not an exact version ` +
                    `of ${packageName} (FR-10 pins one).`,
            );
        }
    }

    /**
     * The `node_modules/<pkg>` link to `targetDir`, created (or re-pointed)
     * only when it does not already resolve there — so a warm call touches
     * nothing on disk.
     */
    private async ensureNodeModulesLink(packageName: string, targetDir: string): Promise<string> {
        const linkDir = this.symlinkPathFor(packageName);
        try {
            const [linked, target] = await Promise.all([
                fs.realpath(linkDir),
                fs.realpath(targetDir),
            ]);
            if (linked === target) return linkDir;
        } catch {
            // Missing or dangling — (re)create it below.
        }
        return this.symlinkUnderNodeModules(packageName, targetDir);
    }

    private async symlinkUnderNodeModules(packageName: string, targetDir: string): Promise<string> {
        const linkDir = this.symlinkPathFor(packageName);
        const parent = path.dirname(linkDir);
        await fs.mkdir(parent, { recursive: true });
        // Replace any existing entry — could be a stale link to a prior version.
        try {
            await fs.rm(linkDir, { force: true, recursive: true });
        } catch {
            // nothing to remove
        }
        try {
            await fs.symlink(targetDir, linkDir, 'junction');
        } catch (err) {
            // Some FS combos (e.g. tmpfs on macOS test runners) reject
            // symlink — fall back to copying. Slower but correct.
            this.logger.warn(
                `symlink ${linkDir} → ${targetDir} failed (${
                    err instanceof Error ? err.message : String(err)
                }); falling back to copy.`,
            );
            await fs.cp(targetDir, linkDir, { recursive: true });
        }
        return linkDir;
    }

    private versionSatisfies(version: string, range: string): boolean {
        // Lightweight semver check used in tests + the cold path. The
        // authoritative resolution already happened in
        // `pacote.manifest`; this is a belt-and-braces guard against an
        // allowlist row pinning a tighter range than the spec.
        if (range === version) return true;
        if (range === '*' || range === '') return true;
        if (range.startsWith('^')) {
            // Major-compat. Only enforce the same major.
            const want = range.slice(1).split('.')[0];
            const got = version.split('.')[0];
            return want === got;
        }
        if (range.startsWith('~')) {
            // Patch-compat. Same major.minor.
            const [wm, wn] = range.slice(1).split('.');
            const [gm, gn] = version.split('.');
            return wm === gm && wn === gn;
        }
        // Naive >= comparison fallback.
        if (range.startsWith('>=')) {
            return this.compareSemver(version, range.slice(2).trim()) >= 0;
        }
        return false;
    }

    private compareSemver(a: string, b: string): number {
        const pa = a.split('.').map((n) => parseInt(n, 10));
        const pb = b.split('.').map((n) => parseInt(n, 10));
        for (let i = 0; i < 3; i++) {
            const av = pa[i] ?? 0;
            const bv = pb[i] ?? 0;
            if (av > bv) return 1;
            if (av < bv) return -1;
        }
        return 0;
    }

    private pacoteOptions(registry: string): PacoteOptions {
        const opts: PacoteOptions = { registry };
        if (this.registryToken) {
            opts['//registry.npmjs.org/:_authToken'] = this.registryToken;
            opts['//npm.pkg.github.com/:_authToken'] = this.registryToken;
            opts.token = this.registryToken;
        }
        // `@ever-works:registry` routes scoped requests through the
        // configured primary, even when registry differs.
        opts['@ever-works:registry'] = registry;
        return opts;
    }

    private async getPacote(): Promise<PacoteLike> {
        if (this.pacote) return this.pacote;
        // Dynamic import so packages/agent can build without pacote
        // resolved in environments that never enable dynamic mode
        // (e.g. unit-test contexts that mock the installer entirely).
        try {
            const mod: { default?: PacoteLike } & PacoteLike = await import('pacote');
            const impl = (mod.default ?? mod) as PacoteLike;
            this.pacote = impl;
            return impl;
        } catch (err) {
            throw new HttpException(
                {
                    statusCode: 500,
                    message:
                        `PLUGIN_DISTRIBUTION_MODE=dynamic requires the 'pacote' package. ` +
                        `Add it as a dependency or use bundled mode. Underlying error: ` +
                        (err instanceof Error ? err.message : String(err)),
                },
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}

/**
 * EW-693 T27 — an install the installer REFUSED, before any download: bundled
 * mode, a plugin whose record does not pin an exact version and integrity
 * (FR-10), a pin that is not a plain npm name and an exact semver version (its
 * store path could leave the store), or a package the allowlist does not admit
 * (FR-11). A 409, so the
 * API answers it as a conflict; the worker task answers it as
 * `WORKER_INSTALL_REFUSED` rather than `WORKER_INSTALL_FAILED` (a fetch or
 * placement that failed).
 */
export class PluginInstallRefusedError extends HttpException {
    constructor(
        readonly pluginId: string,
        reason: string,
    ) {
        super({ statusCode: HttpStatus.CONFLICT, message: reason, pluginId }, HttpStatus.CONFLICT);
    }
}

/** Why a plugin row does not carry the pin a runtime install needs. */
function describeMissingPin(
    entity: {
        source?: string;
        installState?: string;
        registrySpec?: string | null;
        installedVersion?: string | null;
        integrity?: string | null;
    } | null,
): string {
    if (!entity) return 'the platform has no record of it';
    if (entity.source !== 'registry') {
        return `it is a "${entity.source}" plugin, not one installed from a registry`;
    }
    if (entity.installState !== 'installed') {
        return `its install state is "${entity.installState}", not "installed"`;
    }
    if (!entity.registrySpec || !entity.installedVersion) return 'its record pins no exact version';
    return 'its record pins no integrity (FR-10)';
}

/**
 * Subset of the pacote API the installer actually uses. Lets tests
 * inject a stub without pulling pacote's types in.
 */
export interface PacoteLike {
    manifest(spec: string, opts?: PacoteOptions): Promise<PacoteManifest>;
    extract(spec: string, dest: string, opts?: PacoteOptions): Promise<unknown>;
}

export interface PacoteOptions {
    registry?: string;
    token?: string;
    integrity?: string;
    // Allow npm-style auth keys.
    [key: string]: unknown;
}

export interface PacoteManifest {
    version: string;
    _integrity?: string;
    _resolved?: string;
    [key: string]: unknown;
}

export interface PluginInstallInput {
    pluginId: string;
    packageName?: string;
    version?: string;
    integrity?: string;
    source?: 'npm' | 'github-packages';
}

export interface PluginInstallResult {
    pluginId: string;
    packageName: string;
    version: string;
    integrity: string | null | undefined;
    installPath: string;
    registrySpec: string;
}

interface AllowlistDecision {
    allowed: boolean;
    reason?: string;
    versionRange?: string;
    integrity?: string;
    source?: 'npm' | 'github-packages';
}

// Re-export the install-state type for external consumers (e.g.
// plugin-operations) that route through this service.
export type { PluginInstallState };
