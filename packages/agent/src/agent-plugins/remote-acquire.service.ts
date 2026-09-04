import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadPluginPackage, type LoadPluginPackageResult } from '@ever-works/agent-plugins';
import { AgentPluginGitSource, gitPackageDir } from './git-source';
import { AgentPluginNpmSource, npmPackageDir } from './npm-source';

/**
 * Acquire a remote package, then prove it conforms before anything may use it.
 *
 * ## Why validation belongs here and not at the call site
 *
 * A tarball or a git tree is attacker-controlled content. Two properties are
 * only true AFTER the bytes land, so they cannot be checked earlier:
 *
 * - **Containment.** An archive entry or a committed symlink can point outside
 *   the package root. `loadPluginPackage` resolves every path with `realpath`
 *   segment by segment, which is the only check that survives a symlink whose
 *   target is itself a symlink. A lexical check on the archive's entry names
 *   would pass all of these.
 * - **Conformance.** Whether a `plugin.json` is fatally invalid is a fact about
 *   the fetched bytes, not about the request that fetched them.
 *
 * If validation were left to callers, the first caller to forget it would keep
 * an unvalidated tree on disk where the local-directory scanner would later
 * find and load it — laundering a rejected package into an accepted one. Doing
 * it here means a package that fails is **removed**, not merely reported.
 */

export type RemoteSourceKind = 'git' | 'npm';

export interface AcquireGitInput {
    kind: 'git';
    url: string;
    ref?: string;
}

export interface AcquireNpmInput {
    kind: 'npm';
    packageName: string;
    version?: string;
    registry?: string;
}

export type AcquireInput = AcquireGitInput | AcquireNpmInput;

export interface AcquiredPackage {
    kind: RemoteSourceKind;
    /** Directory the validated package now occupies. */
    path: string;
    /** Resolved commit for git, resolved version for npm. */
    revision: string;
    /** npm subresource integrity, when the registry supplied one. */
    integrity: string | null;
    load: LoadPluginPackageResult;
}

@Injectable()
export class AgentPluginRemoteAcquireService {
    private readonly logger = new Logger(AgentPluginRemoteAcquireService.name);

    constructor(
        private readonly gitSource: AgentPluginGitSource,
        private readonly npmSource: AgentPluginNpmSource,
    ) {}

    /**
     * Fetch into `root`, validate, and either return the validated package or
     * throw having left nothing behind.
     */
    async acquire(root: string, input: AcquireInput): Promise<AcquiredPackage> {
        const { destDir, revision, integrity } = await this.fetch(root, input);

        let load: LoadPluginPackageResult;
        try {
            load = await loadPluginPackage(destDir);
        } catch (err) {
            // A validator that throws must not leave the tree it was
            // validating on disk, or the next scan picks it up unchecked.
            await this.discard(destDir);
            const reason = err instanceof Error ? err.message : String(err);
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    message: `Fetched package could not be validated: ${reason}`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        if (!load.ok) {
            await this.discard(destDir);
            const fatal = load.findings.filter((f) => f.severity === 'fatal');
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    message:
                        `Fetched package is not a conforming Agent Plugins package and ` +
                        `was discarded.`,
                    findings: fatal.length > 0 ? fatal : load.findings,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        this.logger.log(`Acquired ${input.kind} package "${load.manifest.name}" at ${revision}`);

        return { kind: input.kind, path: destDir, revision, integrity, load };
    }

    private async fetch(
        root: string,
        input: AcquireInput,
    ): Promise<{ destDir: string; revision: string; integrity: string | null }> {
        if (input.kind === 'git') {
            // Two-step because the destination is keyed by the resolved SHA,
            // which is not known until the clone completes. The staging
            // directory is derived from the ref so two concurrent acquisitions
            // of different refs cannot collide in it.
            // A UNIQUE staging directory per operation. A deterministic one —
            // keyed on url and ref — means two concurrent installs of the
            // same source share a tree: each wipes the other's partial clone,
            // and whichever renames second finds nothing to move. `mkdtemp`
            // makes the collision impossible rather than unlikely.
            const stagingParent = gitPackageDir(root, input.url, '.staging');
            await mkdir(stagingParent, { recursive: true });
            const staging = await mkdtemp(join(stagingParent, `${stagingKey(input.ref)}-`));
            const result = await this.gitSource.acquire({
                url: input.url,
                destDir: staging,
                ...(input.ref ? { ref: input.ref } : {}),
            });
            const final = gitPackageDir(root, input.url, result.resolvedSha);
            try {
                await rm(final, { recursive: true, force: true });
                await mkdir(dirname(final), { recursive: true });
                await rename(staging, final);
            } finally {
                // If the rename never happened, the staging tree would sit in
                // the packages root where the directory scanner would find and
                // load it as if it were an installed package.
                await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            }
            return { destDir: final, revision: result.resolvedSha, integrity: null };
        }

        const dest = npmPackageDir(root, input.packageName, input.version?.trim() || 'latest');
        const result = await this.npmSource.acquire({
            packageName: input.packageName,
            destDir: dest,
            ...(input.version ? { version: input.version } : {}),
            ...(input.registry ? { registry: input.registry } : {}),
        });

        // The directory was keyed by the REQUESTED specifier, which may be a
        // dist-tag. Re-key it by the resolved version so `latest` does not
        // permanently occupy one directory whose contents silently change.
        const final = npmPackageDir(root, input.packageName, result.version);
        if (final !== dest) {
            await rm(final, { recursive: true, force: true });
            await mkdir(dirname(final), { recursive: true });
            await rename(dest, final);
        }
        return { destDir: final, revision: result.version, integrity: result.integrity };
    }

    private async discard(dir: string): Promise<void> {
        await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
            // Report loudly: a tree that failed validation and could not be
            // removed is exactly the state the scanner must not encounter.
            this.logger.error(
                `Failed to remove rejected package at ${dir}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        });
    }
}

/** Filesystem-safe staging suffix derived from a ref. */
function stagingKey(ref: string | undefined): string {
    return encodeURIComponent(ref ?? 'default');
}
