import { Injectable, Logger } from '@nestjs/common';
import { minimatch } from 'minimatch';
import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import { diffGuardedSpecBlocks, isProtectedPath } from '../app-spec/app-spec-guarded-blocks';
import type { AppWorkRules } from './app-work-rules.service';

/**
 * APW-08 T17 — what an evolve run's branch is refused for.
 *
 * The change guard is the last thing between an agent's branch and a pull
 * request, and it runs on the DIFF rather than on what the agent said it did.
 * An agent that reports "I only touched `src/`" and an agent that is wrong
 * about that are the same input here.
 *
 * ## The rules, in the order they refuse
 *
 * 1. **Too big to read.** `truncated`, or `totalFiles >= {@link MAX_FILES}`.
 *    A diff the provider would not show us whole is a diff we cannot police:
 *    the protected path could be in the part that was dropped. This refuses
 *    FIRST, because every rule below reads the file list.
 * 2. **Protected paths**, matched against BOTH `path` and `previousPath`. A
 *    rename is a change to the old path as well as the new one — moving a
 *    workflow file out of its active location is invisible in the new path's
 *    hunks alone.
 * 3. **`.github/workflows/**`**, always, whatever the spec says. The workflow
 *    file is what RUNS the checks; an agent that may edit it may switch them
 *    off and pass every gate afterwards.
 * 4. **Guarded App spec blocks**, when `.works/works.yml` is in the diff:
 *    `source`, `license` and `blueprint` changes, and **removals** from
 *    `display.protectedPaths` / `agents.requireHumanMergePaths`. Additions
 *    stay allowed — a member may always tighten.
 * 5. **Size**, past {@link REFUSAL_MULTIPLE}× the guidance. Under it, a note;
 *    over it, a refusal.
 *
 * ## Why protected paths go through APW-03 and workflows do not
 *
 * `isProtectedPath` is APW-03's, so the spec's globs match identically in both
 * epics — one matcher, one `{ dot: true }`, one answer. `.github/workflows/**`
 * is NOT in the spec: it is this guard's own floor, so it is matched here with
 * the same library and the same option rather than being written into every
 * member's spec where they could then remove it.
 *
 * ## The size rule ignores lockfiles
 *
 * A dependency bump is thousands of lines no human wrote and no reviewer reads.
 * Counting them would make the guidance meaningless for exactly the change that
 * most needs to be small elsewhere in the diff.
 *
 * ## The APW-04 exemption is narrow ON PURPOSE
 *
 * A Task labelled `app-provision` is the platform provisioning the Work, and it
 * legitimately writes `source` and `blueprint` into the spec. The exemption
 * covers **rule 4 only**. A provisioning Task has no more business editing a
 * protected path or a workflow than any other, and the size rule still applies.
 */

/** The file cap: a diff bigger than this cannot be policed, so it is refused. */
export const MAX_FILES = 300;

/** Always protected, whatever the spec says. See the class docstring. */
export const ALWAYS_PROTECTED: readonly string[] = Object.freeze(['.github/workflows/**']);

/** The App spec file, whose guarded blocks rule 4 reads. */
export const APP_SPEC_PATH = '.works/works.yml';

/** Over this multiple of the size guidance, a note becomes a refusal. */
export const REFUSAL_MULTIPLE = 3;

/** The label that exempts a Task from rule 4, and from nothing else. */
export const PROVISION_LABEL = 'app-provision';

/**
 * Names that are lockfiles for the size rule.
 *
 * Matched on the basename, so a lockfile in any directory of a monorepo counts.
 */
const LOCKFILES: readonly string[] = Object.freeze([
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'npm-shrinkwrap.json',
    'bun.lockb',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
    'go.sum',
    'uv.lock',
    'Pipfile.lock',
]);

/** Why a change was refused. One code per rule, so copy and telemetry key off it. */
export type AppChangeRefusalCode =
    | 'diffTooLarge'
    | 'protectedPath'
    | 'workflowPath'
    | 'guardedSpecBlock'
    | 'tooManyLines';

/** What the guard decided. */
export interface AppChangeVerdict {
    readonly allowed: boolean;
    readonly code: AppChangeRefusalCode | null;
    /** One sentence for the member. Never a patch, never a value. */
    readonly message: string | null;
    /** The offending paths, for the ones that have any. Bounded. */
    readonly paths: readonly string[];
    /** Σ(additions + deletions) over non-lockfile files. */
    readonly changedLines: number;
    /** Set when the change is allowed but larger than the guidance. */
    readonly note: string | null;
}

/** What `evaluate` is asked about. */
export interface AppChangeGuardInput {
    readonly rules: AppWorkRules;
    readonly diff: GitDiffResult;
    /** The spec at the BASE commit — rule 4's `before`. */
    readonly baseSpec?: AppSpec | null;
    /**
     * The spec on the branch — rule 4's `after`.
     *
     * `undefined` means "not read"; `null` means "read and it did not parse",
     * which is itself a refusal. The two are different answers and the caller
     * must not collapse them.
     */
    readonly headSpec?: AppSpec | null;
    /** The Task's labels; only `app-provision` is read. */
    readonly labels?: readonly string[];
}

/** How many offending paths a refusal names before it stops listing. */
const MAX_LISTED_PATHS = 10;

@Injectable()
export class AppChangeGuard {
    private readonly logger = new Logger(AppChangeGuard.name);

    /**
     * The verdict for one branch.
     *
     * Never throws for a diff it dislikes — a refusal is a value, because the
     * caller has to turn it into a Task transition and a chat message rather
     * than a stack trace.
     */
    evaluate(input: AppChangeGuardInput): AppChangeVerdict {
        const { rules, diff } = input;

        // ---- 1 · too big to read -------------------------------------------
        if (diff.truncated || diff.totalFiles >= MAX_FILES) {
            return refusal(
                'diffTooLarge',
                `This change touches ${diff.totalFiles} files, which is too many to check against ` +
                    `this Work's protected paths. Split it into smaller pull requests.`,
                [],
                changedLines(diff.files),
            );
        }

        // ---- 2 and 3 · the path rules ---------------------------------------
        const protectedHits = this.pathHits(diff.files, (path) => matchesProtected(rules, path));
        if (protectedHits.length > 0) {
            return refusal(
                'protectedPath',
                'This change edits paths this Work protects, which an agent may not change.',
                protectedHits,
                changedLines(diff.files),
            );
        }

        const workflowHits = this.pathHits(diff.files, matchesWorkflow);
        if (workflowHits.length > 0) {
            return refusal(
                'workflowPath',
                'This change edits the repository workflow files, which run this Work’s checks. ' +
                    'Only a person may change them.',
                workflowHits,
                changedLines(diff.files),
            );
        }

        // ---- 4 · the guarded spec blocks ------------------------------------
        const specVerdict = this.specVerdict(input);
        if (specVerdict) return specVerdict;

        // ---- 5 · size ---------------------------------------------------------
        const lines = changedLines(diff.files);
        const ceiling = rules.sizeGuidance * REFUSAL_MULTIPLE;
        if (lines > ceiling) {
            return refusal(
                'tooManyLines',
                `This change is ${lines} lines, more than ${REFUSAL_MULTIPLE}× this Work’s ` +
                    `guidance of ${rules.sizeGuidance}. Split it into smaller pull requests.`,
                [],
                lines,
            );
        }

        return {
            allowed: true,
            code: null,
            message: null,
            paths: [],
            changedLines: lines,
            note:
                lines > rules.sizeGuidance
                    ? `This change is ${lines} lines, over this Work’s guidance of ` +
                      `${rules.sizeGuidance}. It was allowed, but a smaller change is easier to review.`
                    : null,
        };
    }

    /**
     * The path half, for a caller that has file paths and no diff — the commit
     * tool (FR-8), which must refuse BEFORE it writes rather than after.
     *
     * Deliberately not the whole guard: a commit tool has no base/head pair to
     * compare, so rules 1, 4 and 5 have nothing to read. Rules 2 and 3 are
     * exactly the ones that can be answered from a path list, and they are the
     * ones that matter before a write.
     */
    assertPathsAllowed(rules: AppWorkRules, paths: readonly string[]): void {
        const offending = paths.filter(
            (path) => matchesProtected(rules, path) || matchesWorkflow(path),
        );
        if (offending.length === 0) return;

        throw new AppChangeRefusedError(
            offending.some(matchesWorkflow) ? 'workflowPath' : 'protectedPath',
            `This Work protects ${listPaths(offending)}, so an agent may not write ` +
                `${offending.length === 1 ? 'it' : 'them'}.`,
            offending.slice(0, MAX_LISTED_PATHS),
        );
    }

    /** Paths matching `predicate`, counting a rename's OLD path as well as its new one. */
    private pathHits(
        files: readonly GitDiffFile[],
        predicate: (path: string) => boolean,
    ): string[] {
        const hits: string[] = [];
        for (const file of files) {
            if (predicate(file.path)) hits.push(file.path);
            // A rename is a change to the old path too: moving a protected file
            // out of the way is invisible in the new path alone.
            else if (file.previousPath && predicate(file.previousPath))
                hits.push(file.previousPath);
        }
        return hits.slice(0, MAX_LISTED_PATHS);
    }

    /** Rule 4, or `null` when it does not apply or does not refuse. */
    private specVerdict(input: AppChangeGuardInput): AppChangeVerdict | null {
        const { diff } = input;
        const touchesSpec = diff.files.some(
            (file) => file.path === APP_SPEC_PATH || file.previousPath === APP_SPEC_PATH,
        );
        if (!touchesSpec) return null;

        if ((input.labels ?? []).includes(PROVISION_LABEL)) {
            // APW-04 provisioning legitimately writes `source` and `blueprint`.
            // The exemption is this rule and nothing else.
            this.logger.log(
                `App change guard: skipping the guarded-spec-block rule for an "${PROVISION_LABEL}" Task.`,
            );
            return null;
        }

        if (input.headSpec === null) {
            // Read, and it did not parse. A spec we cannot validate is one we
            // cannot compare, and a branch that leaves the Work unable to
            // describe itself must not become a pull request.
            return refusal(
                'guardedSpecBlock',
                'This change leaves `.works/works.yml` invalid, so the Work could no longer be built ' +
                    'or deployed from it.',
                [APP_SPEC_PATH],
                changedLines(diff.files),
            );
        }
        if (input.headSpec === undefined) return null;

        const blocks = diffGuardedSpecBlocks(input.baseSpec ?? null, input.headSpec);
        if (!blocks.requiresHumanReview) return null;

        const reasons: string[] = [];
        if (blocks.changedBlocks.length > 0)
            reasons.push(`changes ${blocks.changedBlocks.join(', ')}`);
        if (blocks.removedProtectedPaths.length > 0) {
            reasons.push(`removes protected paths (${listPaths(blocks.removedProtectedPaths)})`);
        }
        if (blocks.removedRequireHumanMergePaths.length > 0) {
            reasons.push(
                `removes human-merge paths (${listPaths(blocks.removedRequireHumanMergePaths)})`,
            );
        }

        return refusal(
            'guardedSpecBlock',
            `This change ${reasons.join(' and ')} in \`${APP_SPEC_PATH}\`. Only a person may make ` +
                'that change.',
            [APP_SPEC_PATH],
            changedLines(diff.files),
        );
    }
}

/**
 * Thrown by {@link AppChangeGuard.assertPathsAllowed}.
 *
 * A throw rather than a verdict because its caller is a TOOL: the agent asked
 * to write files, and the answer has to stop the write rather than be reported
 * alongside it.
 */
export class AppChangeRefusedError extends Error {
    constructor(
        readonly code: AppChangeRefusalCode,
        message: string,
        readonly paths: readonly string[],
    ) {
        super(message);
        this.name = 'AppChangeRefusedError';
    }
}

/** The spec's protected globs, through APW-03's matcher so both epics agree. */
function matchesProtected(rules: AppWorkRules, path: string): boolean {
    // A synthetic spec carrying this run's frozen list: `isProtectedPath` takes
    // a spec, and the rules were resolved from one. Passing the list through
    // APW-03's own matcher is the point — one `{ dot: true }`, one answer.
    return isProtectedPath({ display: { protectedPaths: rules.protectedPaths } } as AppSpec, path);
}

/** This guard's own floor, matched with the same library and option. */
function matchesWorkflow(path: string): boolean {
    return ALWAYS_PROTECTED.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/** Σ(additions + deletions), lockfiles excluded. */
function changedLines(files: readonly GitDiffFile[]): number {
    return files
        .filter((file) => !isLockfile(file.path))
        .reduce((total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0), 0);
}

/** Basename match, so a lockfile anywhere in a monorepo counts. */
function isLockfile(path: string): boolean {
    const base = path.split('/').pop() ?? path;
    return LOCKFILES.includes(base);
}

/** A bounded, readable path list for a message. */
function listPaths(paths: readonly string[]): string {
    const shown = paths.slice(0, MAX_LISTED_PATHS).map((path) => `\`${path}\``);
    const rest = paths.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

function refusal(
    code: AppChangeRefusalCode,
    message: string,
    paths: readonly string[],
    lines: number,
): AppChangeVerdict {
    return {
        allowed: false,
        code,
        message,
        paths: Object.freeze([...paths]),
        changedLines: lines,
        note: null,
    };
}
