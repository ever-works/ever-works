import { minimatch } from 'minimatch';
import type { AppSpec } from '@ever-works/contracts';
import { canonicalAppSpecJson } from './app-spec-hash';

/**
 * APW-03 T12 — the guarded App spec blocks (FR-26, ACC-03-15).
 *
 * Spec FR-26:
 *
 * > A Task pull request that changes `source`, `blueprint`, `license`,
 * > `display.protectedPaths`, `upstreamPullRequests` or `provisioning` MUST be
 * > reported to the quality gate as needing a person.
 *
 * T12's task line (`tasks.md:286-290`) fixes the second half of the rule, which
 * is what makes the guard usable rather than obstructive:
 *
 * > `diffGuardedSpecBlocks` reports **removals** from `display.protectedPaths`
 * > and `agents.requireHumanMergePaths` (additions stay allowed) over `source`,
 * > `blueprint`, `license`, both path lists, `upstreamPullRequests` and
 * > `provisioning`; `isProtectedPath` uses **`minimatch` with `{ dot: true }`**
 * > — the matcher APW-08 plan §4 uses — added to `packages/agent/package.json`
 * > at the version the lockfile resolves, so both epics match globs identically.
 *
 * Two rules fall out of that sentence and both are load-bearing:
 *
 *   1. **A member may always tighten.** Adding a path to `protectedPaths` or to
 *      `requireHumanMergePaths`, or changing a block *towards* more protection,
 *      is not a change that needs a person — only taking protection away is.
 *      A guard that refused additions would make the list unmaintainable by
 *      agents, which is the opposite of what D13 wants.
 *   2. **One matcher.** APW-08 (`AppChangeGuard`) refuses a Task pull request
 *      that touches a protected path, and this module answers whether a path is
 *      protected. If the two matched globs differently — one `dot: true`, one
 *      not — a Task could be admitted by one and refused by the other. Both use
 *      `minimatch` at the version the lockfile resolves, and this module is the
 *      only place that calls it for the App spec.
 *
 * ## What `minimatch` with `dot: true` actually buys
 *
 * Without `dot: true`, `*` and `**` do not match a path segment that starts
 * with a dot, so the single most important protected path in this programme —
 * `**&#47;.works/works.yml`, the App spec itself — would not match
 * `**&#47;*` and neither would `.github/workflows/ci.yml`. APW-08 plan §4
 * (`plan.md:437`) names `{ dot: true }` for exactly that reason, and the two
 * epics therefore share the option, not just the library.
 */

/**
 * The blocks a Task pull request may not change without a person — FR-26's list,
 * spelled exactly as the spec spells it.
 *
 * `display.protectedPaths` and `agents.requireHumanMergePaths` are the two
 * **path lists**; the other five are whole blocks. `display.name` is
 * deliberately not a member: renaming a Work is a Work edit, not a change to
 * what may be deployed, and T12's list names `display.protectedPaths` and not
 * `display`.
 */
export const GUARDED_SPEC_BLOCKS = [
    'source',
    'blueprint',
    'license',
    'display.protectedPaths',
    'agents.requireHumanMergePaths',
    'upstreamPullRequests',
    'provisioning',
] as const;

/** One member of {@link GUARDED_SPEC_BLOCKS}. */
export type GuardedSpecBlock = (typeof GUARDED_SPEC_BLOCKS)[number];

/**
 * The blocks whose change **by itself** needs a person — the refusal half of
 * FR-26, and precisely what APW-08 refuses on
 * (`APW-08-evolve-loop/plan.md:442-443`: "refuse on `source`, `license`,
 * `blueprint`, and on removals from `display.protectedPaths` /
 * `agents.requireHumanMergePaths`").
 *
 * The other four members of {@link GUARDED_SPEC_BLOCKS} are reported as changed —
 * they are recorded in `changedBlocks`, and APW-05/06/08 react to them — but they
 * need a person only in the one case {@link PATH_LIST_BLOCKS} describes (a
 * **removal**), or not at all: an agent switching upstream pull requests off, or
 * re-provisioning on, is a change the gate sees and the member can revert, not one
 * that must stop the pull request.
 */
export const HUMAN_REQUIRED_SPEC_BLOCKS: readonly GuardedSpecBlock[] = [
    'source',
    'blueprint',
    'license',
];

/**
 * The two **path lists** — the blocks where the direction of the change is what
 * matters (FR-26, T12: "reports **removals** … (additions stay allowed)").
 *
 * Removing an entry takes protection away and always needs a person; adding one
 * tightens the list and never does. This constant is what makes that distinction
 * explicit rather than a property of a `length` comparison buried in the diff.
 */
export const PATH_LIST_BLOCKS: readonly GuardedSpecBlock[] = [
    'display.protectedPaths',
    'agents.requireHumanMergePaths',
];

/** What changed between two versions of an App spec, in the guard's terms. */
export interface GuardedSpecBlocksDiff {
    /**
     * Every guarded block whose value differs, in {@link GUARDED_SPEC_BLOCKS}
     * order (stable, so two runs of the same diff print the same list).
     */
    readonly changedBlocks: readonly GuardedSpecBlock[];
    /** Paths that were in `display.protectedPaths` and are no longer. */
    readonly removedProtectedPaths: readonly string[];
    /** Paths that were in `agents.requireHumanMergePaths` and are no longer. */
    readonly removedRequireHumanMergePaths: readonly string[];
    /**
     * `true` when a person must decide: a change to a
     * {@link HUMAN_REQUIRED_SPEC_BLOCKS} member, or **any** removal from either
     * {@link PATH_LIST_BLOCKS} list. An **addition** to a path list is reported in
     * `changedBlocks` and is not a human-required change — a member or an agent
     * tightening the guard must never need approval (FR-26, T12). This is FR-26's
     * answer, computed once here so APW-08's gate and APW-03's own reporting cannot
     * disagree about it.
     */
    readonly requiresHumanReview: boolean;
    /** `true` when no guarded block differs at all (the common case). */
    readonly unchanged: boolean;
}

/**
 * Diff the guarded blocks of two App specs.
 *
 * Either side may be `null`/absent — a Work whose previous effective spec never
 * existed (the first application) passes `before = null`, and every guarded
 * block is then reported changed, which is honest: there was nothing to protect
 * and now there is.
 *
 * The comparison is the canonical JSON of each block ({@link canonicalAppSpecJson}),
 * which is the same definition of "the same content" the spec hash uses (FR-23)
 * — so a reformatted file, or one whose keys were reordered, reports no change,
 * while a one-character edit to a licence class reports one.
 */
export function diffGuardedSpecBlocks(
    before: AppSpec | null | undefined,
    after: AppSpec | null | undefined,
): GuardedSpecBlocksDiff {
    const previous = (before ?? null) as AppSpec | null;
    const next = (after ?? null) as AppSpec | null;

    const changedBlocks: GuardedSpecBlock[] = [];
    const removedProtectedPaths = removedEntries(
        protectedPathsOf(previous),
        protectedPathsOf(next),
    );
    const removedRequireHumanMergePaths = removedEntries(
        requireHumanMergePathsOf(previous),
        requireHumanMergePathsOf(next),
    );

    for (const block of GUARDED_SPEC_BLOCKS) {
        if (!blockChanged(block, previous, next)) {
            continue;
        }
        changedBlocks.push(block);
    }

    const requiresHumanReview =
        removedProtectedPaths.length > 0 ||
        removedRequireHumanMergePaths.length > 0 ||
        changedBlocks.some((block) => HUMAN_REQUIRED_SPEC_BLOCKS.includes(block));
    return {
        changedBlocks,
        removedProtectedPaths,
        removedRequireHumanMergePaths,
        requiresHumanReview,
        unchanged: changedBlocks.length === 0,
    };
}

/**
 * Is `path` matched by one of the spec's `display.protectedPaths` globs?
 *
 * `spec.display.protectedPaths` is APW-08's D13 list — "agents may not change
 * matching files" (`app-spec.types.ts:409-421`) — so this predicate is what
 * APW-08's `AppChangeGuard` asks per changed file. A spec with no `display`, no
 * `protectedPaths`, or a non-string entry protects nothing by that entry: the
 * answer is `false`, never a throw, because the caller is a gate that must
 * answer for every path in a 300-file diff.
 *
 * Matching is `minimatch(path, pattern, { dot: true })` — pattern second, path
 * first, the library's own argument order. See the module docstring for what
 * `dot: true` buys.
 */
export function isProtectedPath(spec: AppSpec | null | undefined, path: string): boolean {
    return matchesAny(protectedPathsOf(spec ?? null), path);
}

/**
 * Is `path` matched by one of the spec's `agents.requireHumanMergePaths` globs —
 * "paths whose changes **only a person may merge**, whatever the merge policy
 * says" (`app-spec.types.ts:865-884`)?
 *
 * Additive companion to {@link isProtectedPath}: APW-08's merge-policy half asks
 * it, and T12's "both path lists" is why the two share this module, this matcher
 * and this `{ dot: true }` option rather than each epic calling `minimatch` on
 * its own.
 */
export function isRequireHumanMergePath(spec: AppSpec | null | undefined, path: string): boolean {
    return matchesAny(requireHumanMergePathsOf(spec ?? null), path);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The declared `display.protectedPaths`, defensively — a non-array reads as none. */
function protectedPathsOf(spec: AppSpec | null | undefined): readonly string[] {
    const list = (spec as AppSpec | null | undefined)?.display?.protectedPaths;
    return Array.isArray(list) ? (list as readonly string[]) : [];
}

/** The declared `agents.requireHumanMergePaths`, defensively. */
function requireHumanMergePathsOf(spec: AppSpec | null | undefined): readonly string[] {
    const list = (spec as AppSpec | null | undefined)?.agents?.requireHumanMergePaths;
    return Array.isArray(list) ? (list as readonly string[]) : [];
}

/** Did one guarded block differ? */
function blockChanged(
    block: GuardedSpecBlock,
    before: AppSpec | null,
    after: AppSpec | null,
): boolean {
    switch (block) {
        case 'display.protectedPaths':
            return !sameStrings(protectedPathsOf(before), protectedPathsOf(after));
        case 'agents.requireHumanMergePaths':
            return !sameStrings(requireHumanMergePathsOf(before), requireHumanMergePathsOf(after));
        case 'source':
            return !sameJson(before?.source, after?.source);
        case 'blueprint':
            return !sameJson(before?.blueprint, after?.blueprint);
        case 'license':
            return !sameJson(before?.license, after?.license);
        case 'upstreamPullRequests':
            return !sameJson(before?.upstreamPullRequests, after?.upstreamPullRequests);
        case 'provisioning':
            return !sameJson(before?.provisioning, after?.provisioning);
        default:
            // Unreachable for the declared union; a future member must state its
            // own comparison rather than silently reading as "unchanged".
            return true;
    }
}

/**
 * The entries of `before` that `after` no longer declares, in `before` order,
 * without duplicates — a set difference, never a symmetric one: an **addition**
 * is not a removal and must not appear here.
 */
function removedEntries(before: readonly string[], after: readonly string[]): readonly string[] {
    const present = new Set(after.filter((entry) => typeof entry === 'string'));
    const seen = new Set<string>();
    const removed: string[] = [];
    for (const entry of before) {
        if (typeof entry !== 'string' || present.has(entry) || seen.has(entry)) {
            continue;
        }
        seen.add(entry);
        removed.push(entry);
    }
    return removed;
}

/** Are two string lists the same list, in the same order? */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((entry, index) => entry === right[index]);
}

/**
 * Are two optional blocks the same content? `undefined` and an explicit `null`
 * are the same absence — the canonical JSON of both is `undefined`, which is why
 * the comparison goes through {@link canonicalAppSpecJson} rather than `===`.
 */
function sameJson(left: unknown, right: unknown): boolean {
    return canonicalAppSpecJson(left) === canonicalAppSpecJson(right);
}

/** Does any pattern match this path? Non-string patterns and empty paths never match. */
function matchesAny(patterns: readonly string[], path: string): boolean {
    if (typeof path !== 'string' || path.length === 0) {
        return false;
    }
    return patterns.some(
        (pattern) =>
            typeof pattern === 'string' &&
            pattern.length > 0 &&
            minimatch(path, pattern, { dot: true }),
    );
}
