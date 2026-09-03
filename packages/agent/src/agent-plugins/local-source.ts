/**
 * The local-directory package source (US-1).
 *
 * A self-hosted operator points `AGENT_PLUGINS_DIR` at a folder; every
 * immediate child of it that carries a `plugin.json` is an available Agent
 * Plugins package. Packages are registered **in place** — nothing is copied,
 * because the operator already controls these bytes.
 *
 * This module is deliberately free of NestJS, TypeORM and configuration: it
 * takes directory paths and returns what it found. Policy — which sources an
 * operator has enabled, what gets persisted, who may see it — belongs to the
 * service above it, and keeping that out means this can be unit-tested against
 * a real directory tree without a container.
 *
 * The scan is discovery only. It never installs, never writes, and never
 * executes anything: it reads each candidate through the conformance library
 * and reports what that library says.
 */

import { readdir } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import {
    loadPluginPackage,
    MANIFEST_FILENAME,
    summarizeLoad,
    type Finding,
    type LoadPluginPackageOptions,
    type PackageLoadSummary,
    type SpecVersion,
} from '@ever-works/agent-plugins';

/** One package found on disk, whether or not it turned out to be valid. */
export interface LocalPackageCandidate {
    /** The directory name under the scanned root, which is how an operator refers to it. */
    readonly dirName: string;
    /** Absolute, filesystem-resolved package root. */
    readonly path: string;
    /** True when the package loaded; false when its manifest was fatally invalid. */
    readonly ok: boolean;
    /** Manifest name, when the package loaded. Absent otherwise — a rejected package has no identity. */
    readonly name?: string;
    readonly version?: string;
    readonly specVersion?: SpecVersion;
    readonly skillNames: readonly string[];
    readonly mcpServerNames: readonly string[];
    readonly findings: readonly Finding[];
    readonly summary: PackageLoadSummary;
}

/** Result of scanning one configured source directory. */
export interface LocalSourceScan {
    /** The directory that was scanned, as configured. */
    readonly root: string;
    /**
     * True when the directory does not exist or could not be listed.
     *
     * Deliberately NOT an error: an operator who has not created the packages
     * directory yet has zero packages, not a broken deployment. The feature is
     * off by default and must never be able to stop the API from booting.
     */
    readonly unavailable: boolean;
    /** Why it was unavailable, for a log line. Absent when the scan succeeded. */
    readonly unavailableReason?: string;
    readonly candidates: readonly LocalPackageCandidate[];
}

export interface ScanLocalPackagesOptions {
    /** Passed through to the conformance library — component types and transports this client supports. */
    readonly load?: LoadPluginPackageOptions;
    /**
     * Cap on how many child directories are examined, newest-agnostic and
     * purely defensive: a mis-set `AGENT_PLUGINS_DIR` pointing at, say, a home
     * directory should not turn a boot into a filesystem walk of thousands of
     * entries. Exceeding it is reported, never silent.
     */
    readonly maxEntries?: number;
}

/** Default ceiling on child directories examined in one scan. */
export const DEFAULT_MAX_LOCAL_ENTRIES = 200;

/**
 * Scans one directory for Agent Plugins packages.
 *
 * Every immediate child directory is a candidate; a child without a
 * `plugin.json` is not a package and is skipped silently, because an operator
 * may legitimately keep other things alongside. A child WITH a manifest that
 * fails to load is reported with its findings, because that is a package the
 * operator meant to work.
 */
export async function scanLocalPackages(
    root: string,
    options?: ScanLocalPackagesOptions,
): Promise<LocalSourceScan> {
    if (!isAbsolute(root)) {
        return {
            root,
            unavailable: true,
            unavailableReason: 'the configured packages directory must be an absolute path',
            candidates: [],
        };
    }

    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return {
            root,
            unavailable: true,
            unavailableReason:
                code === 'ENOENT'
                    ? 'the configured packages directory does not exist'
                    : `the configured packages directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
            candidates: [],
        };
    }

    const limit = options?.maxEntries ?? DEFAULT_MAX_LOCAL_ENTRIES;
    const directories = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    const examined = directories.slice(0, limit);

    const candidates: LocalPackageCandidate[] = [];
    for (const entry of examined) {
        const candidatePath = join(root, entry.name);

        // A directory with no manifest is not a package at all. Reading the
        // listing is cheaper than a full load and keeps unrelated folders out
        // of the findings an operator has to read.
        let childNames: string[];
        try {
            childNames = await readdir(candidatePath);
        } catch {
            continue;
        }
        if (!childNames.includes(MANIFEST_FILENAME)) {
            continue;
        }

        const result = await loadPluginPackage(candidatePath, options?.load);
        const summary = summarizeLoad(result);

        candidates.push(
            result.ok
                ? {
                      dirName: entry.name,
                      path: result.root,
                      ok: true,
                      name: result.manifest.name,
                      ...(result.manifest.version === undefined
                          ? {}
                          : { version: result.manifest.version }),
                      specVersion: result.specVersion,
                      skillNames: result.skills.map((skill) => skill.name),
                      mcpServerNames: result.mcpServers.map((server) => server.name),
                      findings: result.findings,
                      summary,
                  }
                : {
                      dirName: entry.name,
                      path: result.root,
                      ok: false,
                      skillNames: [],
                      mcpServerNames: [],
                      findings: result.findings,
                      summary,
                  },
        );
    }

    // Stable ordering so a catalog built from this does not reshuffle between
    // boots on filesystems with different directory iteration order.
    candidates.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

    return directories.length > limit
        ? {
              root,
              unavailable: false,
              unavailableReason: `the directory holds ${directories.length} entries; only the first ${limit} were examined`,
              candidates,
          }
        : { root, unavailable: false, candidates };
}

/**
 * Scans several configured directories in order.
 *
 * When two directories offer a package with the same manifest `name`, the
 * FIRST one wins and the later one is reported as shadowed. First-wins matches
 * how the skills catalog already resolves duplicate slugs, so an operator who
 * learns the rule once knows it everywhere.
 */
export async function scanLocalSources(
    roots: readonly string[],
    options?: ScanLocalPackagesOptions,
): Promise<{ scans: readonly LocalSourceScan[]; shadowed: readonly LocalPackageCandidate[] }> {
    const scans: LocalSourceScan[] = [];
    const seen = new Set<string>();
    const shadowed: LocalPackageCandidate[] = [];

    for (const root of roots) {
        const scan = await scanLocalPackages(root, options);
        const kept: LocalPackageCandidate[] = [];
        for (const candidate of scan.candidates) {
            if (candidate.ok && candidate.name !== undefined) {
                if (seen.has(candidate.name)) {
                    shadowed.push(candidate);
                    continue;
                }
                seen.add(candidate.name);
            }
            kept.push(candidate);
        }
        scans.push({ ...scan, candidates: kept });
    }

    return { scans, shadowed };
}

/**
 * Splits a configured directory list into paths.
 *
 * Separators are a comma, a semicolon, and the platform's own path delimiter.
 * Note what is NOT a separator on Windows: a bare colon. `delimiter` is `;`
 * there precisely because `C:\packages` contains one, and splitting on `:`
 * unconditionally would turn a single Windows path into two broken ones.
 */
export function parsePackageDirs(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    const separators = new Set([',', ';', delimiter]);
    const parts: string[] = [];
    let current = '';
    for (const char of value) {
        if (separators.has(char)) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
