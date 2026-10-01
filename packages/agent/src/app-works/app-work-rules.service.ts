import { Injectable, Optional } from '@nestjs/common';
import type { AppSpec, AppSpecCheck } from '@ever-works/contracts';

import { AppSpecService, isUsableAppSpecStatus } from '../app-spec/app-spec.service';

/**
 * APW-08 T10 — the rules one evolve run is governed by, read ONCE and frozen.
 *
 * Every other half of the loop asks this service rather than the spec: the
 * dispatch brief (what an agent is told it may not touch), the Fleet admission
 * (which commands may run), and the change guard (what the pull request is
 * refused for). Reading the spec separately in three places is how they would
 * come to disagree — and the disagreement that matters is the one where the
 * brief tells an agent a path is editable and the guard then refuses the branch
 * it spent an hour producing.
 *
 * ## Read at the BASE commit, never at the branch
 *
 * `resolve(work, baseSha)` reads the spec at the Task's base commit. That is the
 * whole security property of this file: the rules an agent is judged by are the
 * ones that were in the repository **before** it was let near it. Reading the
 * head would let a run edit `.works/works.yml` to remove a protected path and
 * then be judged by its own edit — which is precisely the change APW-03's
 * `diffGuardedSpecBlocks` exists to catch, and it cannot catch it if the rules
 * moved underneath it.
 *
 * `baseSha` is therefore required and is never defaulted to the head.
 *
 * ## Frozen, because "per run" is a guarantee and not a hope
 *
 * The returned object and every array in it are frozen. A run's rules are
 * decided once; a consumer that could push onto `protectedPaths` would change
 * what a sibling consumer sees, and the resulting refusal would be impossible
 * to reproduce from the spec alone.
 *
 * ## The caps are this file's, not the spec's
 *
 * The App spec allows more than a run brief can carry: up to 10 instruction
 * files and (schema §17) more checks than a CI matrix wants. The caps here —
 * {@link MAX_CHECKS} and {@link MAX_INSTRUCTION_FILES} — are the RUN's budget,
 * and they truncate rather than refuse: a spec with 30 checks is not invalid,
 * it just cannot have all 30 run on every Task. Truncation is from the front,
 * so the order the member wrote is the order that survives.
 *
 * `sizeGuidance` is `agents.maxPullRequestChangedLines`, defaulted to
 * {@link DEFAULT_SIZE_GUIDANCE} and clamped to the spec's own 50..5000. Clamped
 * rather than refused because it is GUIDANCE — it shapes the brief and, past
 * 3x, a refusal; a nonsensical value should not stop a member's Task from
 * running.
 *
 * ## An unreadable spec is a refusal, and says which branch
 *
 * `invalid`, `missing` and `unreadable` all throw {@link AppSpecUnreadableError}
 * naming the branch, because a run with no rules is a run with no protected
 * paths — the one failure mode this whole epic exists to prevent. The message
 * names the branch and not the commit: a member can check out a branch.
 */

/** How many `spec.checks[]` entries one run carries (plan §9.1). */
export const MAX_CHECKS = 20;

/** How many `agents.instructionFiles` one run brief carries (plan §9.1). */
export const MAX_INSTRUCTION_FILES = 5;

/** `agents.maxPullRequestChangedLines` when the spec names none. */
export const DEFAULT_SIZE_GUIDANCE = 500;

/** The spec's own bounds on `maxPullRequestChangedLines`. */
export const MIN_SIZE_GUIDANCE = 50;
export const MAX_SIZE_GUIDANCE = 5000;

/** The rules one run is governed by. Frozen; see the class docstring. */
export interface AppWorkRules {
    /**
     * The branch that is built and deployed, and therefore the branch a Task
     * cuts from and targets.
     *
     * `null` when the spec names none — *"the Work Repository's default when
     * absent"*. It is carried as `null` rather than resolved here because this
     * service does not talk to a git provider, and a caller that already knows
     * the default must not be handed a guess instead.
     */
    readonly sourceBranch: string | null;
    readonly checks: readonly AppSpecCheck[];
    readonly protectedPaths: readonly string[];
    readonly humanMergePaths: readonly string[];
    readonly instructionFiles: readonly string[];
    readonly sizeGuidance: number;
}

/**
 * The spec at the base commit could not be read, or is not valid.
 *
 * Thrown rather than answered, because every caller's correct response is the
 * same — do not run — and a `null` return would let one of them carry on with
 * no protected paths at all.
 */
export class AppSpecUnreadableError extends Error {
    constructor(
        readonly workId: string,
        readonly branch: string,
        readonly status: string,
    ) {
        super(
            `The App spec on "${branch}" could not be read (${status}), so this Work's rules are ` +
                'unknown and no change may be made to it. Fix `.works/works.yml` on that branch and try again.',
        );
        this.name = 'AppSpecUnreadableError';
    }
}

/** What this service reads of a Work — its id, and the branch to name in a refusal. */
export interface AppWorkRulesWork {
    readonly id: string;
    readonly taskIsolationBaseBranch?: string | null;
}

@Injectable()
export class AppWorkRulesService {
    constructor(
        // APW-03's service BY CLASS, which is what T10 specifies, and not
        // through `APP_ENV_SPEC_SOURCE`: that token's bound adapter is
        // `read(workId)` with no commit argument, so it can answer the effective
        // spec and never the spec AT A COMMIT. Injecting it here would have been
        // a seam that cannot do this job.
        //
        // `@Optional()` so an installation without APW-03 fails at the refusal
        // below — with a message about the SPEC — rather than at boot with one
        // about dependency injection.
        @Optional() private readonly specs?: AppSpecService,
    ) {}

    /**
     * The rules for one run, read at `baseSha`.
     *
     * @throws {AppSpecUnreadableError} when the spec at that commit is absent,
     * unreadable or invalid.
     */
    async resolve(work: AppWorkRulesWork, baseSha: string): Promise<AppWorkRules> {
        const branch = work.taskIsolationBaseBranch?.trim() || 'the base branch';

        if (!this.specs) {
            throw new AppSpecUnreadableError(work.id, branch, 'no App spec source');
        }
        if (!baseSha || !baseSha.trim()) {
            // Never defaulted to the head — see the class docstring. A caller
            // with no base commit has not isolated the Task yet.
            throw new AppSpecUnreadableError(work.id, branch, 'no base commit');
        }

        const read = await this.specs.getEffectiveSpec(work.id, baseSha.trim());
        if (!read || !isUsableAppSpecStatus(read.status) || !read.spec) {
            throw new AppSpecUnreadableError(work.id, branch, read?.status ?? 'no state');
        }

        return freezeRules(read.spec);
    }
}

/** The spec's rule blocks, capped, defaulted and frozen. */
function freezeRules(spec: AppSpec): AppWorkRules {
    const agents = spec.agents ?? {};

    return Object.freeze({
        sourceBranch: nonEmpty(spec.source?.branch),
        checks: Object.freeze((spec.checks ?? []).slice(0, MAX_CHECKS)),
        protectedPaths: Object.freeze([...(spec.display?.protectedPaths ?? [])]),
        humanMergePaths: Object.freeze([...(agents.requireHumanMergePaths ?? [])]),
        instructionFiles: Object.freeze(
            (agents.instructionFiles ?? []).slice(0, MAX_INSTRUCTION_FILES),
        ),
        sizeGuidance: clampGuidance(agents.maxPullRequestChangedLines),
    });
}

/** A trimmed non-empty string, or `null`. */
function nonEmpty(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : null;
}

/**
 * `maxPullRequestChangedLines`, defaulted and clamped.
 *
 * Anything that is not a finite number is the DEFAULT, not a clamp: clamping
 * `NaN` lands on whichever bound the comparison falls through to, and that is
 * not a number anyone chose.
 *
 * The coercion is deliberate rather than a bare `Number(value)`, which this
 * file got wrong first: **`Number(null)` is `0`**, and `Number('')` is too, so
 * an absent value would have clamped to the 50-line MINIMUM and refused a
 * member's pull request at a tenth of the intended size. `null` reaching here
 * is ordinary — it is what a YAML key written with no value parses to.
 *
 * A numeric string is accepted because YAML quoting is a thing members do, and
 * APW-03's validator is what catches a genuinely wrong type long before here.
 */
function clampGuidance(value: unknown): number {
    const size =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim().length > 0
              ? Number(value.trim())
              : Number.NaN;
    if (!Number.isFinite(size)) return DEFAULT_SIZE_GUIDANCE;
    return Math.min(MAX_SIZE_GUIDANCE, Math.max(MIN_SIZE_GUIDANCE, Math.floor(size)));
}
