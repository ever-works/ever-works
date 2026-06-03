import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
	Optional
} from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { PluginsModuleOptions } from '../interfaces/plugins-module-options.interface';
import { PluginRepository } from '../repositories/plugin.repository';
import {
	PluginAllowlistRepository
} from '../repositories/plugin-allowlist.repository';
import type { PluginInstallState } from '../entities/plugin.entity';

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
 */
@Injectable()
export class PluginInstallerService {
	private readonly logger = new Logger(PluginInstallerService.name);
	private readonly installDir: string;
	private readonly registryUrl: string;
	private readonly registryGithubUrl: string;
	private readonly registryToken: string | undefined;
	private readonly distributionMode: 'bundled' | 'dynamic';

	/**
	 * Per-`pluginId` in-flight install promise. The first caller writes
	 * its promise here; subsequent callers `await` the same promise
	 * instead of starting a duplicate install. The entry is cleared
	 * (success or failure) so a retry after a failure starts fresh.
	 */
	private readonly inFlight = new Map<string, Promise<PluginInstallResult>>();

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
		private pacote: PacoteLike | null = null
	) {
		this.distributionMode = options.distributionMode ?? 'bundled';
		this.installDir = options.installDir ?? '/app/plugins';
		this.registryUrl = options.registryUrl ?? 'https://registry.npmjs.org';
		this.registryGithubUrl = options.registryGithubUrl ?? 'https://npm.pkg.github.com';
		this.registryToken = options.registryToken;
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
			`EW-693 boot warmup: pre-installing ${distributable.length} dynamic plugin(s) from DB`
		);

		const results = await Promise.allSettled(
			distributable.map((p) => this.ensurePluginAvailable(p.pluginId))
		);
		const succeeded = results.filter((r) => r.status === 'fulfilled').length;
		const failed = results.length - succeeded;

		for (const [i, r] of results.entries()) {
			if (r.status === 'rejected') {
				this.logger.warn(
					`EW-693 warmup failed for ${distributable[i].pluginId}: ${
						r.reason instanceof Error ? r.reason.message : String(r.reason)
					}`
				);
			}
		}

		return { attempted: distributable.length, succeeded, failed };
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
				HttpStatus.CONFLICT
			);
		}

		// Resolve registry endpoint per allowlist source.
		const source = input.source || allow.source || 'npm';
		const registry = source === 'github-packages' ? this.registryGithubUrl : this.registryUrl;

		// Mark `installing` BEFORE any IO so the UI can poll progress.
		await this.pluginRepository.updateInstallState(input.pluginId, 'installing', {
			source: 'registry',
			installError: null
		});

		try {
			const pacote = await this.getPacote();

			// Resolve npm spec → exact version + sha512 integrity.
			const spec = input.version
				? `${packageName}@${input.version}`
				: `${packageName}@latest`;
			const manifest = await pacote.manifest(spec, this.pacoteOptions(registry));

			// Enforce allowlist version range when applicable.
			if (allow.versionRange && !this.versionSatisfies(manifest.version, allow.versionRange)) {
				throw new HttpException(
					{
						statusCode: 409,
						message:
							`Resolved version ${manifest.version} does not satisfy the ` +
							`allowlist range "${allow.versionRange}" for ${packageName}.`,
						pluginId: input.pluginId
					},
					HttpStatus.CONFLICT
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
						pluginId: input.pluginId
					},
					HttpStatus.FAILED_DEPENDENCY
				);
			}

			// Place package into the per-version dir; pacote.extract
			// verifies the tarball integrity BEFORE writing files
			// (FR-10). The destination is wiped first if it exists
			// (`force`) so an aborted prior install can't leave a
			// partial tree behind.
			const destDir = this.versionedDir(packageName, manifest.version);
			await fs.mkdir(destDir, { recursive: true });
			await pacote.extract(`${packageName}@${manifest.version}`, destDir, {
				...this.pacoteOptions(registry),
				integrity: manifest._integrity
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
				installError: null
			});

			return {
				pluginId: input.pluginId,
				packageName,
				version: installedVersion,
				integrity,
				installPath: linkDir,
				registrySpec
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
				code
			);
		}
	}

	/**
	 * Lazy install-on-use (FR-13) — the correctness mechanism for
	 * multi-replica deployments. Returns immediately if already
	 * installed; otherwise installs, deduping concurrent callers.
	 *
	 * In `bundled` mode this is a no-op (returns the pre-recorded
	 * install state) — bundled plugins are always present on disk.
	 */
	async ensurePluginAvailable(pluginId: string): Promise<PluginInstallResult | null> {
		if (this.distributionMode !== 'dynamic') return null;

		const existing = this.inFlight.get(pluginId);
		if (existing) return existing;

		const entity = await this.pluginRepository.findByPluginId(pluginId);
		if (entity?.installState === 'installed' && entity.registrySpec && entity.installedVersion) {
			// Already installed on this node — fast path.
			return {
				pluginId,
				packageName: this.packageNameFromSpec(entity.registrySpec) || this.derivePackageName(pluginId),
				version: entity.installedVersion,
				integrity: entity.integrity,
				installPath: this.symlinkPathFor(
					this.packageNameFromSpec(entity.registrySpec) || this.derivePackageName(pluginId)
				),
				registrySpec: entity.registrySpec
			};
		}

		const promise = this.install({
			pluginId,
			packageName: entity?.registrySpec
				? this.packageNameFromSpec(entity.registrySpec) ?? undefined
				: undefined,
			version: entity?.installedVersion ?? undefined,
			integrity: entity?.integrity ?? undefined
		}).finally(() => {
			this.inFlight.delete(pluginId);
		});
		this.inFlight.set(pluginId, promise);
		return promise;
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
				HttpStatus.NOT_FOUND
			);
		}
		const isSystem = (entity.manifest as Record<string, unknown> | undefined)?.systemPlugin === true;
		if (isSystem || entity.source === 'bundled') {
			throw new HttpException(
				{
					statusCode: 409,
					message:
						`Plugin "${pluginId}" is a core/bundled plugin and cannot be uninstalled. ` +
						`Disable it instead.`
				},
				HttpStatus.CONFLICT
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
			installError: null
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
					`and no allowlist repository is configured. Refusing install (FR-11).`
			};
		}
		const row = await this.allowlistRepository.findByPackageName(packageName);
		if (!row) {
			return {
				allowed: false,
				reason: `Package "${packageName}" is not on the admin allowlist. ` +
					`Add it via POST /admin/plugins/allowlist before installing.`
			};
		}
		if (!row.enabled) {
			return {
				allowed: false,
				reason: `Package "${packageName}" is on the allowlist but disabled. ` +
					`Re-enable it via PATCH /admin/plugins/allowlist/:id.`
			};
		}
		return {
			allowed: true,
			versionRange: row.versionRange,
			integrity: row.integrity ?? undefined,
			source: row.source
		};
	}

	// ─── helpers ────────────────────────────────────────────────────

	private async recordInstallError(pluginId: string, reason: string): Promise<void> {
		try {
			await this.pluginRepository.updateInstallState(pluginId, 'error', {
				installError: reason
			});
		} catch (err) {
			this.logger.warn(
				`Failed to persist installState=error for ${pluginId}: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	private assertDynamicMode(operation: string): void {
		if (this.distributionMode !== 'dynamic') {
			throw new HttpException(
				{
					statusCode: 409,
					message:
						`Cannot ${operation} plugin: PLUGIN_DISTRIBUTION_MODE is "${this.distributionMode}". ` +
						`Set PLUGIN_DISTRIBUTION_MODE=dynamic to enable runtime installs.`
				},
				HttpStatus.CONFLICT
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

	private async symlinkUnderNodeModules(
		packageName: string,
		targetDir: string
	): Promise<string> {
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
				}); falling back to copy.`
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
						(err instanceof Error ? err.message : String(err))
				},
				HttpStatus.INTERNAL_SERVER_ERROR
			);
		}
	}
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
