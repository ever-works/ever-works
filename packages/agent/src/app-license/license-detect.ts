/**
 * APW-03 T41 — repository licence detection (plan §2.6), read-only.
 *
 * One pass over a Work Repository at one ref:
 *
 *  1. the provider-detected SPDX (`getRepository().licenseSpdx`, through
 *     {@link detectedLicenseSpdx}: `null` from the provider means NOASSERTION);
 *  2. ONE recursive tree listing (`getRepositoryTree`, ≤ {@link LICENSE_TREE_MAX_ENTRIES});
 *     a provider without it, or a truncated listing, sets `scanIncomplete` and the scan
 *     continues root-only — never "nothing there";
 *  3. **mixed** (ACC-03-32): a directory segment in {@link LICENSE_MIXED_DIR_NAMES} at
 *     depth ≤ {@link LICENSE_MIXED_MAX_DEPTH}, or a nested LICENSE / COPYING file whose
 *     identified licence differs from the root's;
 *  4. at most {@link LICENSE_MAX_FILE_READS} file reads in total — root licence texts
 *     (identified by `SPDX-License-Identifier`, then a registry alias or licence name in
 *     the first 2 KiB), the four root package manifests' `license` fields, and nested
 *     licence files — to fill a missing SPDX and to decide "differs".
 *
 * Evidence is capped at {@link LICENSE_EVIDENCE_MAX} paths per list. Nothing here writes:
 * the only facade members it can reach are the three reads in {@link LicenseDetectGit}.
 *
 * Not here yet: the word-bigram Dice match against bundled SPDX reference texts (plan
 * §2.6 `texts/<spdx>.txt`); a root licence text the registry cannot name by alias stays
 * unidentified, and the provider's own detection is the first source anyway.
 */
import {
    LICENSE_EVIDENCE_MAX,
    LICENSE_MAX_FILE_READS,
    LICENSE_MIXED_DIR_NAMES,
    LICENSE_MIXED_MAX_DEPTH,
    LICENSE_TREE_MAX_ENTRIES,
    type LicenseClass,
} from '@ever-works/contracts';
import type { GitFacadeOptions, GitFacadeService } from '../facades/git.facade';
import { detectedLicenseSpdx, SPDX_NOASSERTION } from './license-classify';
import { licenseHeadOf, scanLicenseHeaderText } from './license-headers';
import { LICENSE_REGISTRY_SNAPSHOT } from './license-registry.snapshot';
import { parseSpdxExpression, type SpdxExpressionNode } from './spdx-expression';

/** Registry aliases (`The MIT License` → `mit`), lower-cased, for comparing licence ids. */
const ALIAS_TO_SPDX = new Map(
    LICENSE_REGISTRY_SNAPSHOT.aliases.map((alias) => [
        alias.match.toLowerCase(),
        alias.spdx.toLowerCase(),
    ]),
);

function normalizeLicenseId(id: string): string {
    return ALIAS_TO_SPDX.get(id.toLowerCase()) ?? id.toLowerCase();
}

/**
 * The licence ids an expression names — parsed, so an exception after `WITH` is not
 * counted as a licence, and aliases are normalised to their SPDX id.
 */
export function licenseIdSet(expression: string): Set<string> {
    const exactAlias = ALIAS_TO_SPDX.get(expression.trim().toLowerCase());
    if (exactAlias) {
        return new Set([exactAlias]);
    }
    const tree = parseSpdxExpression(expression);
    if (!tree) {
        return new Set([normalizeLicenseId(expression.trim())]);
    }
    const ids = new Set<string>();
    const visit = (node: SpdxExpressionNode): void => {
        if (node.type === 'license') {
            ids.add(normalizeLicenseId(node.id));
            return;
        }
        visit(node.left);
        visit(node.right);
    };
    visit(tree);
    return ids;
}

function isSubsetOf(inner: Set<string>, outer: Set<string>): boolean {
    for (const id of inner) {
        if (!outer.has(id)) return false;
    }
    return true;
}

/** The facade reads detection may make — and nothing that writes. */
export type LicenseDetectGit = Pick<
    GitFacadeService,
    'getRepository' | 'getRepositoryTree' | 'getFileContent'
>;

export interface LicenseDetectInput {
    git: LicenseDetectGit;
    owner: string;
    repo: string;
    /** The branch, tag or commit to scan. */
    ref: string;
    options: GitFacadeOptions;
}

export interface LicenseDetection {
    /** The repository's SPDX expression, `NOASSERTION` for an unnameable file, `null` for none. */
    spdx: string | null;
    mixed: boolean;
    /** The tree listing was unavailable or truncated: the scan ran root-only or partly. */
    scanIncomplete: boolean;
    evidence: { files: string[]; mixedPaths: string[] };
    /** File reads made (≤ {@link LICENSE_MAX_FILE_READS}). */
    fileReads: number;
}

/** Root licence files (`LICENSE`, `LICENCE.md`, `COPYING`, `UNLICENSE`, …). */
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.-][^/]*)?$/i;

/** The four root manifests whose `license` field is read (plan §2.6), in read order. */
const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'composer.json'] as const;

const MIXED_DIRS = new Set<string>(LICENSE_MIXED_DIR_NAMES.map((name) => name.toLowerCase()));

/** ACC-03-32 — a mixed repository is at least amber. Pure. */
export function applyMixed(licenseClass: LicenseClass, mixed: boolean): LicenseClass {
    return mixed && licenseClass === 'green' ? 'amber' : licenseClass;
}

/**
 * The mixed-licence directories of a tree listing (pure, exported for the spec): every
 * directory whose last segment is a mixed name at depth ≤ {@link LICENSE_MIXED_MAX_DEPTH}
 * (depth = number of path segments), de-duplicated, in listing order.
 */
export function mixedDirectories(
    entries: ReadonlyArray<{ path: string; type: 'blob' | 'tree' }>,
): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const segments = entry.path.split('/').filter((segment) => segment !== '');
        // A blob's last segment is a file name, not a directory.
        const directories = entry.type === 'tree' ? segments.length : segments.length - 1;
        const limit = Math.min(directories, LICENSE_MIXED_MAX_DEPTH);
        for (let depth = 1; depth <= limit; depth += 1) {
            if (MIXED_DIRS.has(segments[depth - 1].toLowerCase())) {
                const path = segments.slice(0, depth).join('/');
                if (!seen.has(path)) {
                    seen.add(path);
                    found.push(path);
                }
            }
        }
    }
    return found;
}

/** Identify a licence text by its header tag, then a registry alias or licence name. */
export function identifyLicenseText(text: string): string | null {
    const head = licenseHeadOf(text);
    if (head.trim() === '') {
        return null;
    }
    const tagged = scanLicenseHeaderText(head);
    if (tagged.length > 0) {
        return tagged[0];
    }
    const lower = head.toLowerCase();
    // Longest match first, so "GNU Affero General Public License v3.0" beats "MIT License"
    // were both ever present in one head.
    const names: Array<{ match: string; spdx: string }> = [
        ...LICENSE_REGISTRY_SNAPSHOT.aliases.map((alias) => ({
            match: alias.match,
            spdx: alias.spdx,
        })),
        ...LICENSE_REGISTRY_SNAPSHOT.licenses.map((license) => ({
            match: license.name,
            spdx: license.spdx,
        })),
    ].sort((left, right) => right.match.length - left.match.length);
    for (const name of names) {
        if (name.match.length >= 6 && lower.includes(name.match.toLowerCase())) {
            return name.spdx;
        }
    }
    return null;
}

/** A manifest's declared licence expression, or `null`. Pure. */
export function manifestLicense(fileName: string, text: string): string | null {
    if (typeof text !== 'string' || text.trim() === '') {
        return null;
    }
    const keep = (value: unknown): string | null => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (trimmed === '' || /^(UNLICENSED|SEE LICEN[CS]E)/i.test(trimmed)) return null;
        return parseSpdxExpression(trimmed) !== null || /^LicenseRef-/.test(trimmed)
            ? trimmed
            : null;
    };

    if (fileName === 'package.json' || fileName === 'composer.json') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return null;
        }
        const license = (parsed as { license?: unknown } | null)?.license;
        if (Array.isArray(license)) {
            const parts = license.map(keep).filter((part): part is string => part !== null);
            return parts.length > 0 ? parts.join(' OR ') : null;
        }
        if (license && typeof license === 'object') {
            return keep((license as { type?: unknown }).type);
        }
        return keep(license);
    }

    // TOML: the `license` key of `[package]` (Cargo) or `[project]` (pyproject), as a
    // string or `{ text = "…" }`. A deliberately small reader — no TOML dependency.
    const section = fileName === 'Cargo.toml' ? 'package' : 'project';
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            inSection = header[1].trim() === section;
            continue;
        }
        if (!inSection) continue;
        const plain = /^license\s*=\s*["']([^"']+)["']/.exec(line);
        if (plain) return keep(plain[1]);
        const table = /^license\s*=\s*\{[^}]*\btext\s*=\s*["']([^"']+)["']/.exec(line);
        if (table) return keep(table[1]);
    }
    return null;
}

function cap(paths: string[]): string[] {
    return paths.slice(0, LICENSE_EVIDENCE_MAX);
}

function isLicenseFile(path: string): boolean {
    const name = path.split('/').pop() ?? '';
    return LICENSE_FILE.test(name);
}

/** One detection pass. Never throws for a provider failure: it answers what it could read. */
export async function detectRepositoryLicense(
    input: LicenseDetectInput,
): Promise<LicenseDetection> {
    const { git, owner, repo, ref, options } = input;
    let fileReads = 0;

    const read = async (path: string): Promise<string | null> => {
        if (fileReads >= LICENSE_MAX_FILE_READS) {
            return null;
        }
        fileReads += 1;
        try {
            const file = await git.getFileContent(owner, repo, path, options, ref);
            return typeof file?.content === 'string' ? file.content : null;
        } catch {
            return null;
        }
    };

    // 1. The provider's own detection.
    let providerSpdx: string | null = null;
    try {
        const repository = (await git.getRepository(owner, repo, options)) as {
            licenseSpdx?: string | null;
        } | null;
        providerSpdx = repository ? detectedLicenseSpdx(repository.licenseSpdx) : null;
    } catch {
        providerSpdx = null;
    }

    // 2. One tree listing.
    let entries: Array<{ path: string; type: 'blob' | 'tree' }> | null = null;
    let scanIncomplete = false;
    try {
        const tree =
            typeof git.getRepositoryTree === 'function'
                ? await git.getRepositoryTree(
                      owner,
                      repo,
                      ref,
                      { recursive: true, maxEntries: LICENSE_TREE_MAX_ENTRIES },
                      options,
                  )
                : null;
        if (tree) {
            entries = tree.entries;
            scanIncomplete = tree.truncated === true;
        } else {
            scanIncomplete = true;
        }
    } catch {
        scanIncomplete = true;
    }

    const blobs = (entries ?? []).filter((entry) => entry.type === 'blob');
    const rootLicenseFiles = blobs
        .filter((entry) => !entry.path.includes('/') && isLicenseFile(entry.path))
        .map((entry) => entry.path);
    const nestedLicenseFiles = blobs
        .filter((entry) => entry.path.includes('/') && isLicenseFile(entry.path))
        .map((entry) => entry.path);
    const rootFiles = new Set(
        blobs.filter((entry) => !entry.path.includes('/')).map((e) => e.path),
    );

    // 3. The root licence: provider first, then the root texts, then the manifests.
    let spdx: string | null =
        providerSpdx && providerSpdx !== SPDX_NOASSERTION ? providerSpdx : null;
    if (!spdx) {
        // Without a listing, the conventional name is tried once.
        const candidates = entries === null ? ['LICENSE'] : rootLicenseFiles;
        for (const path of candidates) {
            const text = await read(path);
            const identified = text ? identifyLicenseText(text) : null;
            if (identified) {
                spdx = identified;
                break;
            }
        }
    }
    if (!spdx) {
        for (const manifest of MANIFESTS) {
            if (entries !== null && !rootFiles.has(manifest)) continue;
            const text = await read(manifest);
            const declared = text ? manifestLicense(manifest, text) : null;
            if (declared) {
                spdx = declared;
                break;
            }
        }
    }
    if (!spdx && providerSpdx === SPDX_NOASSERTION) {
        spdx = SPDX_NOASSERTION;
    }

    // 4. Mixed: the directory names, then nested licence files that name another licence.
    const mixedPaths = entries ? mixedDirectories(entries) : [];
    const differing: string[] = [];
    let nestedRead = 0;
    for (const path of nestedLicenseFiles) {
        if (fileReads >= LICENSE_MAX_FILE_READS) break;
        nestedRead += 1;
        const text = await read(path);
        if (text === null) {
            // A listed nested licence we could not read is not evidence of "same licence".
            scanIncomplete = true;
            continue;
        }
        const identified = identifyLicenseText(text);
        if (identified && spdx && !isSubsetOf(licenseIdSet(identified), licenseIdSet(spdx))) {
            differing.push(path);
        }
    }
    if (nestedRead < nestedLicenseFiles.length) {
        // The read budget ran out before every nested licence file was read.
        scanIncomplete = true;
    }

    const allMixed = [...mixedPaths, ...differing];
    return {
        spdx,
        mixed: allMixed.length > 0,
        scanIncomplete,
        evidence: {
            files: cap([...rootLicenseFiles, ...differing]),
            mixedPaths: cap(allMixed),
        },
        fileReads,
    };
}
