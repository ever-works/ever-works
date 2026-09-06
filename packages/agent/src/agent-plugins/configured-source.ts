import { config } from '../config';
import {
    parsePackageDirs,
    scanLocalSources,
    type LocalPackageCandidate,
    type LocalSourceScan,
    type ScanLocalPackagesOptions,
} from './local-source';

/**
 * The configured local source — where the feature flag is actually read.
 *
 * Kept as a separate file from `local-source.ts` on purpose. That module is
 * pure: give it directories, it tells you what is in them, and it can be
 * tested against real trees with no environment at all. This one is the thin
 * layer that decides WHICH directories, by consulting configuration — so the
 * policy is in one small, obvious place instead of threaded through the
 * scanner.
 *
 * It also ensures `FEATURE_AGENT_PLUGINS` ships with a reader. The repository
 * already carries one flag that is defined, documented, unit-tested, and read
 * by nothing; a flag with no reader is a dead feature that looks shipped.
 */

/** What a configured scan found, plus why it found nothing when it did. */
export interface ConfiguredScanResult {
    /**
     * False when `FEATURE_AGENT_PLUGINS` is off. Distinguished from "on but
     * empty" so an operator who turns the flag on and sees nothing can tell
     * which of the two they are looking at.
     */
    readonly enabled: boolean;
    /** Directories that were consulted, after parsing the configured value. */
    readonly roots: readonly string[];
    readonly scans: readonly LocalSourceScan[];
    /** Packages skipped because an earlier directory already defined that name. */
    readonly shadowed: readonly LocalPackageCandidate[];
}

/** The directories configured for local packages, in precedence order. */
export function configuredPackageDirs(): string[] {
    return parsePackageDirs(config.agentPlugins.getPackageDirs());
}

/**
 * Scans every configured directory, or returns an empty, disabled result when
 * the feature is off.
 *
 * Returning a shaped result rather than throwing or returning `null` matters
 * for the caller this exists for: the skills catalog runs on every request,
 * and "the feature is off" must be as cheap and as ordinary as "there are no
 * packages".
 */
export async function scanConfiguredPackages(
    options?: ScanLocalPackagesOptions,
): Promise<ConfiguredScanResult> {
    if (!config.agentPlugins.isEnabled()) {
        return { enabled: false, roots: [], scans: [], shadowed: [] };
    }

    const roots = configuredPackageDirs();
    if (roots.length === 0) {
        return { enabled: true, roots: [], scans: [], shadowed: [] };
    }

    const { scans, shadowed } = await scanLocalSources(roots, options);
    return { enabled: true, roots, scans, shadowed };
}

/** Every package that loaded successfully, flattened across configured directories. */
export function loadedPackages(result: ConfiguredScanResult): LocalPackageCandidate[] {
    return result.scans.flatMap((scan) => scan.candidates.filter((candidate) => candidate.ok));
}

/**
 * Every package that was found but rejected.
 *
 * Worth surfacing separately: these are packages an operator deliberately put
 * in the directory, so their absence from the catalog needs an explanation
 * rather than silence.
 */
export function rejectedPackages(result: ConfiguredScanResult): LocalPackageCandidate[] {
    return result.scans.flatMap((scan) => scan.candidates.filter((candidate) => !candidate.ok));
}
