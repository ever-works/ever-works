import { Injectable, Logger } from '@nestjs/common';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveRealPath } from '@ever-works/agent-plugins';
import { config } from '../config';

/**
 * Allocates the writable directory a package sees as `${PLUGIN_DATA}` (T29).
 *
 * ## Why this is not a subdirectory of the package
 *
 * Package contents are read-only and replaced WHOLESALE on update — the git
 * acquirer re-clones and renames, the npm acquirer re-extracts. Anything a
 * server had written inside the package root would vanish on the next update,
 * silently, and only for packages that happened to update. Data therefore
 * lives under a separate root that no acquirer touches.
 *
 * A second reason: the package directories are SCANNED. A writable directory
 * inside a scanned tree would be walked by the discovery pass, so a server
 * writing a file named `plugin.json` into its own data directory could
 * present itself as a second package.
 *
 * ## Isolation is per (owner, package), not per package
 *
 * Two tenants running the same package must not share a directory. The path
 * therefore includes the owner, and the owner segment comes FIRST so that a
 * per-tenant quota, backup or deletion is a single subtree operation rather
 * than a scan for matching leaves.
 */

/**
 * Path segments are derived, never interpolated raw.
 *
 * A package name is constrained by the spec (`[a-z0-9.-]`), but a user id is
 * whatever the platform issues, and `sourceRef`-derived values have been
 * attacker-influenced before. Hashing sidesteps the entire question of which
 * characters are safe in a path on which platform — and, unlike escaping, it
 * cannot be got subtly wrong.
 *
 * The readable prefix is kept so an operator listing the directory can tell
 * what they are looking at; the hash is what guarantees uniqueness and
 * containment.
 */
export function dataDirSegment(value: string): string {
    const readable = value
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/gu, '')
        .slice(0, 40);
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
    return readable ? `${readable}-${digest}` : digest;
}

export interface PackageDataDirOwner {
    /** The user the package is installed for. */
    readonly userId: string;
    /** Manifest name of the package. */
    readonly packageName: string;
}

@Injectable()
export class AgentPluginPackageDataDirService {
    private readonly logger = new Logger(AgentPluginPackageDataDirService.name);

    /**
     * The absolute path a package's `${PLUGIN_DATA}` resolves to.
     *
     * Pure: it computes a path and touches nothing. Callers that need the
     * directory to exist call {@link ensure}, which is separate so that
     * resolving a path for display or comparison never has a side effect.
     */
    pathFor(owner: PackageDataDirOwner): string {
        const root = resolve(config.agentPlugins.getDataDir());
        return join(root, dataDirSegment(owner.userId), dataDirSegment(owner.packageName));
    }

    /**
     * Create the directory if absent and return it.
     *
     * Called immediately before launch rather than at install: a directory
     * created at install would be missing on every replica that did not
     * perform that install, and on any replica whose volume was recreated.
     * Creating it at the point of use makes those cases identical to the
     * first launch.
     */
    async ensure(owner: PackageDataDirOwner): Promise<string> {
        const path = this.pathFor(owner);
        await mkdir(path, { recursive: true });

        // Re-derive the real path and verify containment AFTER creation. The
        // root may itself be a symlink (a mounted volume commonly is), and a
        // pre-existing symlinked leaf placed by anything else would otherwise
        // hand a package a writable directory outside the data root.
        const realRoot = await resolveRealPath(resolve(config.agentPlugins.getDataDir()));
        const realPath = await resolveRealPath(path);
        if (!isWithin(realRoot, realPath)) {
            throw new Error(
                `Refusing to use "${realPath}" as package data: it resolves outside the ` +
                    `configured data root "${realRoot}".`,
            );
        }

        return realPath;
    }

    /**
     * Remove a package's data.
     *
     * Called on uninstall. Failure is logged rather than thrown: the package
     * row and contents are already gone by this point, so an orphaned data
     * directory is untidy and inert, while throwing would fail an uninstall
     * that has otherwise succeeded and leave the caller unsure what happened.
     */
    async remove(owner: PackageDataDirOwner): Promise<void> {
        const path = this.pathFor(owner);
        await rm(path, { recursive: true, force: true }).catch((err: unknown) => {
            this.logger.warn(
                `Could not remove package data at ${path}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        });
    }
}

/**
 * True when `candidate` is `root` or sits beneath it.
 *
 * Uses `path.relative` rather than a string prefix. Two reasons, and the
 * second was found by a test rather than by reasoning:
 *
 * 1. A prefix test says `/data/acme-2` is inside `/data/acme`, which is the
 *    classic way a containment check passes while being wrong.
 * 2. Appending the platform separator does not fix that portably. On Windows
 *    `sep` is a backslash while a path may legitimately use forward slashes,
 *    so `/data/acme` + `\` never prefixes `/data/acme/x` and the check
 *    rejects a directory that IS contained. `relative` normalises both sides
 *    and is separator-agnostic.
 *
 * A contained path yields a relative path that is neither absolute nor
 * starting with `..`; an empty result means the two are the same directory.
 */
export function isWithin(root: string, candidate: string): boolean {
    if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
    const rel = relative(root, candidate);
    if (rel === '') return true;
    return !rel.startsWith('..') && !isAbsolute(rel);
}
