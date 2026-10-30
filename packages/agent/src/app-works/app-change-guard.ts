import { Injectable, Logger } from '@nestjs/common';
import { minimatch } from 'minimatch';
import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffFile, GitDiffResult } from '@ever-works/plugin';

import {
    diffGuardedSpecBlocks,
    isProtectedPath,
    isRequireHumanMergePath,
    loosenedSpecSwitches,
} from '../app-spec/app-spec-guarded-blocks';
// A value import from the ring-free port (it has no runtime imports of its own).
import {
    APP_WORK_DIFF_MAX_FILES,
    APP_WORK_SPEC_PATH,
    appWorkDiffFileListIncomplete,
} from '../tasks-domain/app-work-change-gate.port';
import { TASK_ORIGIN_APP_PROVISIONING } from '../entities/task-origin';
import {
    appProvisioningOutputGuardEnforced,
    provisioningPathViolations,
    provisioningSecretFindings,
    provisioningSizeViolation,
    provisioningSpecViolations,
    APP_PROVISIONING_MAX_FILES,
    APP_PROVISIONING_MAX_LINES,
} from './app-provisioning-output.guard';
import { clampFileGuidance, type AppWorkRules } from './app-work-rules.service';

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
 * 1. **Too big to read.** `totalFiles >= {@link MAX_FILES}`, or a file list
 *    shorter than `totalFiles` (`appWorkDiffFileListIncomplete`). A diff whose
 *    file list the provider would not give us whole is a diff we cannot police:
 *    the protected path could be in the part that was dropped. This refuses
 *    FIRST, because every rule below reads the file list.
 *    **Never on `truncated` alone (APW08-G06, FR-21).** `capDiffFiles` also
 *    sets it when it drops PATCH TEXT past the byte budget, which hides no
 *    path: a five-file dependency update with a large lockfile patch lists all
 *    five, and refusing it as "too many files" refused exactly the change
 *    FR-25 and FR-51 must let through. The change gate asks for no patch text
 *    at all (`APP_WORK_COMPARE_DIFF_OPTIONS`, `maxBytes: 0`).
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
 *    stay allowed — a member may always tighten. Since works-security
 *    (2026-10-18) also any `upstreamSync` change and switching ON
 *    `upstreamPullRequests.enabled` / `provisioning.autoReprovision`
 *    (`loosenedSpecSwitches`), which is what the evolve brief promises.
 *
 * An ALLOWED verdict additionally names the changed paths matching
 * `agents.requireHumanMergePaths` (`humanMergePaths`): such a change may
 * become a pull request, but the merge gate asks a person to merge it.
 * 5. **Size**, past {@link REFUSAL_MULTIPLE}× the guidance. Under it, a note;
 *    over it, a refusal. Two guidances, judged the same way (APW08-G22):
 *    changed LINES against `agents.maxPullRequestChangedLines`
 *    (`sizeGuidance`, lockfiles excluded) and changed FILES against
 *    `agents.maxPullRequestChangedFiles` (`fileGuidance`, default 50). The file
 *    guidance is what the App sets for itself; rule 1's 300-file ceiling is the
 *    platform's and stays, whatever the App sets.
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
 *
 * ## …and a provisioning Task is held to MORE, not less (APW-04 T10/T57)
 *
 * Since the lane-A2 overnight build (2026-10-27) a Task whose server-written
 * origin is `app-provisioning` also meets rule **3b** right after the workflow
 * rule: it may write only `.works/works.yml` and `.works/overlay/**` (FR-28), at
 * most 12 files / 3,000 lines (FR-29), and no credential-shaped literal; and its
 * rule-4 exemption no longer covers the owner-owned switches (FR-30 —
 * `app-provisioning-output.guard.ts`). Rules 2 and 3 still answer first, with
 * their own codes. Off only with `APP_PROVISIONING_OUTPUT_GUARD_ENFORCED=false`.
 */

/**
 * The file cap: a diff this big cannot be policed, so it is refused. The port's
 * literal (`APP_WORK_DIFF_MAX_FILES`), so the change gate's request, this rule
 * and the finalize path's workflow floor name one number.
 */
export const MAX_FILES = APP_WORK_DIFF_MAX_FILES;

/** Always protected, whatever the spec says. See the class docstring. */
export const ALWAYS_PROTECTED: readonly string[] = Object.freeze(['.github/workflows/**']);

/**
 * The App spec file, whose guarded blocks rule 4 reads. The port's literal, so
 * the cloud path's pre-push read (which may not import this file) and the guard
 * always name the same file.
 */
export const APP_SPEC_PATH = APP_WORK_SPEC_PATH;

/** Over this multiple of the size guidance, a note becomes a refusal. */
export const REFUSAL_MULTIPLE = 3;

/**
 * Works-security (2026-10-18) — rule 4 also refuses the spec changes that loosen
 * what reaches the running App unattended (`loosenedSpecSwitches`: any
 * `upstreamSync` change, switching on `upstreamPullRequests.enabled` or
 * `provisioning.autoReprovision`). On unless the operator sets this to `false`.
 */
export const APP_CHANGE_GUARD_SPEC_SWITCHES_ENV =
    'APP_CHANGE_GUARD_SPEC_SWITCHES_ENFORCED' as const;

/** Default-safe: only an explicit `false` turns the extra rule-4 refusals off. */
export function appChangeGuardSpecSwitchesEnforced(): boolean {
    return (process.env[APP_CHANGE_GUARD_SPEC_SWITCHES_ENV] ?? '').trim().toLowerCase() !== 'false';
}

// `APP_HUMAN_MERGE_PATHS_ENFORCED` / `appHumanMergePathsEnforced` live in the
// ring-free port (`app-work-change-gate.port.ts`): the merge gate in
// `tasks-domain/` reads them and may not import this file.
export {
    APP_HUMAN_MERGE_PATHS_ENV,
    appHumanMergePathsEnforced,
} from '../tasks-domain/app-work-change-gate.port';

/**
 * The label APW-04 files its provisioning Tasks with — display, the board
 * filter, and the provisioner's own "is one already open?" lookup.
 *
 * It exempts NOTHING (works-security 2026-10-18). Labels are free-form and any
 * caller of `PATCH /api/tasks/:id` could add it to its own Task, so rule 4's
 * exemption reads the server-written {@link AppChangeGuardInput.taskOrigin}
 * instead, which only `AppProvisioningService.start` sets.
 */
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
    | 'tooManyLines'
    /** APW08-G22 — more changed files than 3× the App spec's `agents.maxPullRequestChangedFiles`. */
    | 'tooManyFiles'
    /** APW-04 FR-28 — a provisioning run wrote outside `.works/works.yml` / `.works/overlay/**`. */
    | 'provisioningPathNotWritable'
    /** APW-04 FR-29 — a provisioning proposal over 12 files or 3,000 lines. */
    | 'provisioningTooLarge'
    /** APW-04 T10 — a credential-shaped literal in what a provisioning run wrote. */
    | 'secretLiteral'
    /** APW-04 FR-30 / T57 — a provisioning run changed an owner-owned App spec switch. */
    | 'provisioningOwnedField';

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
    /**
     * Set when the change is allowed but larger than a guidance — the line guidance, the file
     * guidance (APW08-G22), or both, one sentence each.
     */
    readonly note: string | null;
    /**
     * Works-security (2026-10-18) — on an ALLOWED verdict only: the changed
     * paths (a rename's old path included) that match the base commit's
     * `agents.requireHumanMergePaths`. Present only when non-empty: the change
     * may become a pull request, but only a person may merge it. Bounded.
     */
    readonly humanMergePaths?: readonly string[];
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
    /**
     * The Task's server-written provenance (`Task.origin`). Only
     * `'app-provisioning'` is read: it exempts the Task from rule 4, and from
     * nothing else. Never the Task's labels (see {@link PROVISION_LABEL}).
     */
    readonly taskOrigin?: string | null;
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
        // APW08-G06 — the file LIST, never `truncated` alone (see the class
        // docstring): patch text past the byte budget hides no path.
        if (appWorkDiffFileListIncomplete(diff)) {
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

        // ---- 3b · APW-04 — what a provisioning run may write -------------------
        const provisioningVerdict = this.provisioningVerdict(input);
        if (provisioningVerdict) return provisioningVerdict;

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

        // APW08-G22 — the App spec's own file guidance, on FR-27's shape: a
        // note over it, a refusal past REFUSAL_MULTIPLE× it. Counted over every
        // changed file the provider reported (rule 1 already refused a list it
        // could not give whole), a lockfile included: unlike its lines, a
        // lockfile is still one more file a reviewer has to open.
        const fileGuidance = fileGuidanceOf(rules);
        const files = changedFileCount(diff);
        if (files > fileGuidance * REFUSAL_MULTIPLE) {
            return refusal(
                'tooManyFiles',
                `This change touches ${files} files, more than ${REFUSAL_MULTIPLE}× this Work’s ` +
                    `file guidance of ${fileGuidance}. Split it into smaller pull requests.`,
                [],
                lines,
            );
        }

        const notes: string[] = [];
        if (lines > rules.sizeGuidance) {
            notes.push(
                `This change is ${lines} lines, over this Work’s guidance of ` +
                    `${rules.sizeGuidance}. It was allowed, but a smaller change is easier to review.`,
            );
        }
        if (files > fileGuidance) {
            notes.push(
                `This change touches ${files} files, over this Work’s file guidance of ` +
                    `${fileGuidance}. It was allowed, but a smaller change is easier to review.`,
            );
        }
        const allowed: AppChangeVerdict = {
            allowed: true,
            code: null,
            message: null,
            paths: [],
            changedLines: lines,
            note: notes.length > 0 ? notes.join(' ') : null,
        };
        // Works-security (2026-10-18) — allowed, but only a person may MERGE a
        // change to a human-merge path. Named here (the merge gate raises the
        // approval); the key is added only when there is something to name, so
        // every other verdict keeps its exact shape.
        const humanMergeHits = this.pathHits(diff.files, (path) => matchesHumanMerge(rules, path));
        if (humanMergeHits.length > 0) {
            return { ...allowed, humanMergePaths: Object.freeze([...humanMergeHits]) };
        }
        return allowed;
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

    /**
     * Rule 3b (APW-04 T10, FR-28/FR-29) — a provisioning Task's paths, size and
     * secret literals. `null` for every other Task, and when the operator turned
     * the provisioning output guard off.
     */
    private provisioningVerdict(input: AppChangeGuardInput): AppChangeVerdict | null {
        if (input.taskOrigin !== TASK_ORIGIN_APP_PROVISIONING) return null;
        if (!appProvisioningOutputGuardEnforced()) return null;
        const { diff } = input;

        const outside = provisioningPathViolations(diff.files);
        if (outside.length > 0) {
            return refusal(
                'provisioningPathNotWritable',
                'The App Provisioner may write only `.works/works.yml` and files under ' +
                    '`.works/overlay/`, and this change writes outside them.',
                outside,
                changedLines(diff.files),
            );
        }

        const size = provisioningSizeViolation(diff.files, diff.totalFiles);
        if (size) {
            return refusal(
                'provisioningTooLarge',
                size.code === 'tooManyFiles'
                    ? `This provisioning change touches ${size.count} files; a proposal may change at most ` +
                          `${APP_PROVISIONING_MAX_FILES}.`
                    : `This provisioning change is ${size.count} lines; a proposal may change at most ` +
                          `${APP_PROVISIONING_MAX_LINES}.`,
                [],
                changedLines(diff.files),
            );
        }

        const secrets = provisioningSecretFindings({
            headSpec: input.headSpec ?? null,
            files: diff.files,
        });
        if (secrets.length > 0) {
            // The pattern names only — never the matched text.
            return refusal(
                'secretLiteral',
                `This provisioning change writes a value that looks like a credential ` +
                    `(${secrets.join(', ')}). Secrets belong in the App's environment, never in the repository.`,
                [],
                changedLines(diff.files),
            );
        }
        return null;
    }

    /**
     * Rule 4 for a provisioning Task (T57, FR-30): the exemption keeps `source` /
     * `blueprint`, never the owner-owned switches; a head spec that does not parse
     * is refused as for every other Task.
     */
    private provisioningSpecVerdict(input: AppChangeGuardInput): AppChangeVerdict | null {
        if (!appProvisioningOutputGuardEnforced()) return null;
        const { diff } = input;
        if (input.headSpec === null) {
            return refusal(
                'guardedSpecBlock',
                'This change leaves `.works/works.yml` invalid, so the Work could no longer be built ' +
                    'or deployed from it.',
                [APP_SPEC_PATH],
                changedLines(diff.files),
            );
        }
        if (input.headSpec === undefined) return null;
        const fields = provisioningSpecViolations(input.baseSpec ?? null, input.headSpec);
        if (fields.length === 0) return null;
        return refusal(
            'provisioningOwnedField',
            `The App Provisioner may not change ${fields.map((field) => `\`${field}\``).join(', ')} ` +
                'in `.works/works.yml` — those settings are the Work owner’s.',
            [APP_SPEC_PATH],
            changedLines(diff.files),
        );
    }

    /** Rule 4, or `null` when it does not apply or does not refuse. */
    private specVerdict(input: AppChangeGuardInput): AppChangeVerdict | null {
        const { diff } = input;
        const touchesSpec = diff.files.some(
            (file) => file.path === APP_SPEC_PATH || file.previousPath === APP_SPEC_PATH,
        );
        if (!touchesSpec) return null;

        if (input.taskOrigin === TASK_ORIGIN_APP_PROVISIONING) {
            // APW-04 provisioning legitimately writes `source` and `blueprint`.
            // The exemption is this rule and nothing else, and it keys off the
            // server-written origin — never a label a caller could add.
            this.logger.log(
                `App change guard: skipping the guarded-spec-block rule for an App provisioning Task.`,
            );
            // T57 / FR-30 — but not for the owner-owned switches, and not for a
            // spec the run left unparseable (`provisioningOwnedField`).
            return this.provisioningSpecVerdict(input);
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
        // Works-security (2026-10-18) — the changes FR-26 reports without a
        // person that still loosen what reaches the running App unattended
        // (`upstreamSync`, switching on upstream pull requests or automatic
        // re-provisioning). See `loosenedSpecSwitches`.
        const loosened = appChangeGuardSpecSwitchesEnforced()
            ? loosenedSpecSwitches(input.baseSpec ?? null, input.headSpec)
            : [];
        if (!blocks.requiresHumanReview && loosened.length === 0) return null;

        const reasons: string[] = [];
        if (blocks.requiresHumanReview && blocks.changedBlocks.length > 0)
            reasons.push(`changes ${blocks.changedBlocks.join(', ')}`);
        // `upstreamSync` is not one of FR-26's blocks, so it is never in
        // `changedBlocks`; it is named here and only here.
        if (loosened.includes('upstreamSync')) reasons.push('changes upstreamSync');
        const switchedOn = loosened.filter((name) => name !== 'upstreamSync');
        if (switchedOn.length > 0) reasons.push(`switches on ${switchedOn.join(', ')}`);
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

/** The spec's human-merge globs, through APW-03's matcher (same `{ dot: true }`). */
function matchesHumanMerge(rules: AppWorkRules, path: string): boolean {
    const list = Array.isArray(rules.humanMergePaths) ? rules.humanMergePaths : [];
    if (list.length === 0) return false;
    return isRequireHumanMergePath(
        { agents: { requireHumanMergePaths: list } } as unknown as AppSpec,
        path,
    );
}

/** This guard's own floor, matched with the same library and option. */
function matchesWorkflow(path: string): boolean {
    return ALWAYS_PROTECTED.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/**
 * APW08-G22 — the rules' file guidance, read through the rules service's own clamp so a rules
 * object built without the field (a fixture, the e2e seed) gets the schema default (50) rather
 * than no file guidance at all.
 */
function fileGuidanceOf(rules: AppWorkRules): number {
    return clampFileGuidance(rules.fileGuidance);
}

/** How many files the change touches: the provider's count, else the list it returned. */
function changedFileCount(diff: GitDiffResult): number {
    return typeof diff.totalFiles === 'number' && Number.isFinite(diff.totalFiles)
        ? Math.max(diff.totalFiles, diff.files.length)
        : diff.files.length;
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
