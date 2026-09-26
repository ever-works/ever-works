import type { Work } from '../entities/work.entity';

/**
 * APW-08 T17 — the one seam the shared finalize path uses to ask "may this App
 * Work branch become a pull request?".
 *
 * ## Why a port and not three injected classes
 *
 * `TaskWorkspaceService` is the finalize tail for EVERY Work kind. It first took
 * `AppWorkRulesService`, `AppChangeGuard` and `AppSpecService` directly, and
 * the value imports that needed closed a six-module require ring through
 * `app-spec.service.ts` → `app-upstream-state.service.ts` → `tasks.service.ts`
 * → `task-extra-repos.ts` → back to `task-workspace.service.ts` — the exact
 * hazard `task-extra-repos.ts` documents. It was silent only because today's
 * entry orders close the ring on a lazily-read value; any eager capture inside
 * it would break Task finalize for every kind, not just App.
 *
 * This file imports nothing at runtime — the `Work` import is type-only and is
 * erased — so depending on it cannot put the finalize path back in a ring. The
 * implementation (`app-works/app-work-change-gate.service.ts`) holds all of the
 * App-specific reads, and `TasksDomainModule` binds it.
 *
 * ## There is no `baseSha` in the input, on purpose
 *
 * The rules are read at a BASE commit — the security property the whole guard
 * rests on: the rules an agent is judged by are ones it did not write. The
 * first wiring took that commit from the caller, and on the fleet path the
 * caller's value is `result.git.baseSha` — reported by the fleet node, i.e. by
 * the machine the agent ran on. A run could name a commit whose spec it had
 * loosened and be judged by that.
 *
 * So the gate resolves the commit itself, server-side, as the tip of `baseRef`
 * at the moment of judging, and the input has no field through which anyone
 * could supply a different one.
 */
export const APP_WORK_CHANGE_GATE = Symbol('APP_WORK_CHANGE_GATE');

/**
 * The one path an App Work's spec lives at. Declared HERE, in the ring-free
 * port, so the finalize path can name the file it must read before a push
 * without importing `app-works/` (the require ring above); the guard's
 * `APP_SPEC_PATH` is this value, so the two can never name different files.
 */
export const APP_WORK_SPEC_PATH = '.works/works.yml';

/** What the finalize path hands the gate. Every value is one it resolved itself. */
export interface AppWorkChangeGateInput {
    readonly work: Work;
    /** The Task's labels; only APW-04's `app-provision` exemption reads them. */
    readonly taskLabels: readonly string[];
    readonly owner: string;
    readonly repo: string;
    readonly gitOptions: { userId: string; providerId: string; workId: string };
    /** The branch the pull request targets; the rules commit is ITS tip. */
    readonly baseRef: string;
    /** The pushed branch the pull request would be opened from. */
    readonly branch: string;
}

/**
 * The gate's answer. A refusal is a value, never a throw — its caller has a
 * Task to transition and a message to post, not a stack trace to surface.
 */
export type AppWorkChangeGateVerdict =
    | { readonly allowed: true; readonly note: string | null }
    | { readonly allowed: false; readonly message: string; readonly paths: readonly string[] };

/**
 * The pre-write question (FR-8): may these paths be written, with this content?
 *
 * Two callers ask it, both BEFORE the change can leave the runtime, so a
 * refusal leaves nothing behind on the remote:
 *
 *   - the `commitToRepo` agent tool, before it writes;
 *   - `TaskWorkspaceService.finalizeRun` on the cloud path, about the commit the
 *     run just made locally and before that commit is pushed (APW-08 T17). It
 *     reads the paths and the committed `.works/works.yml` through the workspace
 *     provider's `branchChanges`, and then publishes exactly the judged commit.
 *     `evaluate` still runs after that push, for the size rule and the
 *     provider's own diff.
 *
 * It is the same guard as {@link AppWorkChangeGate.evaluate},
 * over the paths the call writes instead of a provider diff: protected paths,
 * `.github/workflows/**`, the file-count cap, and — when `.works/works.yml` is
 * one of the paths — the guarded spec blocks, read from `contents`.
 *
 * The spec rule is the one that matters most on this path. `commitToRepo` is how
 * follow-up commits reach an OPEN pull request, and the first version of this
 * question checked paths only, so an agent could loosen `display.protectedPaths`
 * in a commit onto a PR that had already been judged. The workflow rule matters
 * for a different reason: a pushed branch whose workflow file changed can RUN
 * that workflow on push, so refusing only at the pull request would be too late.
 *
 * Only the size rule is not answered here — there is no diff to count — and it
 * is judged when a pull request is opened.
 */
export interface AppWorkChangePathsInput {
    readonly work: Work;
    readonly owner: string;
    readonly repo: string;
    readonly gitOptions: { userId: string; providerId: string; workId: string };
    /** The Work's base branch; the rules commit is ITS tip, read by the gate. */
    readonly baseRef: string;
    /** Normalised, repository-relative paths — the exact strings that will be written and staged. */
    readonly paths: readonly string[];
    /**
     * The new content of each path, by path. Required for `.works/works.yml`
     * when it is in `paths`: without it the guarded blocks cannot be judged, and
     * the gate refuses rather than skipping the rule.
     */
    readonly contents?: Readonly<Record<string, string>>;
    /**
     * The Task's labels, for APW-04's `app-provision` exemption — so the
     * pre-push verdict on the cloud path equals `evaluate`'s for every rule the
     * two share. Absent (the `commitToRepo` tool) is no labels.
     */
    readonly taskLabels?: readonly string[];
}

export interface AppWorkChangeGate {
    /** Never rejects. An internal failure is a refusal with a message saying so. */
    evaluate(input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict>;
    /** Never rejects. The pre-write half — see {@link AppWorkChangePathsInput}. */
    checkPaths(input: AppWorkChangePathsInput): Promise<AppWorkChangeGateVerdict>;
}
