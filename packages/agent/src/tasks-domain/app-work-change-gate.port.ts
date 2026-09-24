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
 * The pre-write question (FR-8): may these paths be written at all?
 *
 * Asked by the `commitToRepo` agent tool BEFORE it writes, so a refusal leaves
 * nothing behind. It answers only the rules a path list can answer —
 * protected paths and `.github/workflows/**` — because there is no diff yet.
 * The workflow rule matters most here: a pushed branch whose workflow file was
 * changed can RUN that changed workflow on push, so refusing only at the pull
 * request would be too late for it.
 */
export interface AppWorkChangePathsInput {
    readonly work: Work;
    readonly owner: string;
    readonly repo: string;
    readonly gitOptions: { userId: string; providerId: string; workId: string };
    /** The Work's base branch; the rules commit is ITS tip, read by the gate. */
    readonly baseRef: string;
    readonly paths: readonly string[];
}

export interface AppWorkChangeGate {
    /** Never rejects. An internal failure is a refusal with a message saying so. */
    evaluate(input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict>;
    /** Never rejects. The pre-write half — see {@link AppWorkChangePathsInput}. */
    checkPaths(input: AppWorkChangePathsInput): Promise<AppWorkChangeGateVerdict>;
}
