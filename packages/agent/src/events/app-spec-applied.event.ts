import { BaseEvent } from './base';

/**
 * APW-03 (App spec, Apps catalog and license gate) — the canonical
 * `app.spec.applied` event.
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md:101-103`
 * fixes the class, its `EVENT_NAME` and this exact payload;
 * `CONTRACTS.md:327` is the normative cross-epic contract row:
 *
 * > In-process events `AppSpecAppliedEvent` (`app.spec.applied`: `{ workId,
 * > commitSha, previousCommitSha, specHash, addedDependencies, changedEnvNames,
 * > changedBlocks }`) … | APW-03 | APW-05, 06, 07, 08
 *
 * ## Who emits it, and exactly once per transition
 *
 * `AppSpecService.evaluate` (plan §2.3:168-198) is the only emitter, and it
 * emits **only** when the effective spec hash changes (FR-21: "The 'spec
 * applied' event MUST fire only when the effective spec hash changes;
 * re-evaluating the same content MUST emit nothing"). One transition is one
 * event: a re-evaluation of identical content, a coalesced trigger, a job that
 * lost the `evaluatedSeq` race and an invalid or unreadable head all emit
 * nothing.
 *
 * ## Who consumes it
 *
 * | Consumer | What it reads | Source |
 * | -------- | ------------- | ------ |
 * | APW-05 `AppBuildsListener` | `changedBlocks` (does it include `build`/`checks`?) and `changedEnvNames` (a build-phase entry?) | APW-05 plan §7.6 (`plan.md:1487-1489`) |
 * | APW-06 App renderer | the deploy branch's spec, read back through `getEffectiveSpec` | APW-06 plan §5.6 |
 * | APW-07 `AppEnvListener` | `workId` — generation then dependency reconcile | `packages/agent/src/app-env/app-env.listener.ts` |
 * | APW-08 `AppChangeGuard` / evolve loop | the applied commit, to switch checks on for `app` only | APW-08 plan §2.4 |
 *
 * 🛑 **APW-07 T15's swap (two lines, both additive).** Its
 * `packages/agent/src/app-env/app-env.listener.ts` carries a documented
 * PROVISIONAL stand-in while this file did not exist:
 * `APP_ENV_SPEC_APPLIED_EVENT = 'app.spec.applied'` (`:110`) and the narrow
 * `AppEnvListenerSpecAppliedEvent` interface (`:122-130`). With this file
 * landed, `@OnEvent(APP_ENV_SPEC_APPLIED_EVENT)` becomes
 * `@OnEvent(AppSpecAppliedEvent.EVENT_NAME)` and the parameter type becomes
 * `AppSpecAppliedEvent`; **delete nothing** — both stand-ins are re-exported by
 * that epic's barrel and a consumer may legitimately keep importing them. The
 * wire name is identical by construction (`EVENT_NAME` below is pinned to the
 * literal by `events.spec.ts` and by APW-07's own spec), so the swap changes no
 * behaviour.
 *
 * ## The field names are the contract's, not this file's
 *
 * `AppSpecAppliedPayload` spells every field exactly as `CONTRACTS.md:327` and
 * `tasks.md:102` do, in the same order, because APW-05, 06, 07 and 08 destructure
 * them by name. Adding a field is additive; renaming or removing one is a
 * cross-epic break.
 */
export interface AppSpecAppliedPayload {
    /** The App Work whose effective App spec changed. */
    readonly workId: string;
    /** The commit the effective spec was read at — the head of the tracked branch. */
    readonly commitSha: string;
    /**
     * The commit the **previous** effective spec was read at, or `null` when this
     * is the first effective spec the App Work ever had.
     */
    readonly previousCommitSha: string | null;
    /** APW-03's canonical hash of the effective `spec` block (FR-23). */
    readonly specHash: string;
    /**
     * The dependency **kinds** (`postgres` · `redis` · `objectStorage` · `smtp`)
     * this effective spec declares and the previous one did not — what APW-07
     * provisioned nothing for yet.
     */
    readonly addedDependencies: readonly string[];
    /**
     * The `env[].name` of every entry added, changed or removed between the
     * previous effective spec and this one. Names only, never values (R8, FR-6).
     */
    readonly changedEnvNames: readonly string[];
    /**
     * The top-level `spec` keys whose value changed (for example `build`,
     * `components`, `env`, `checks`) — what APW-05 grades a rebuild on.
     */
    readonly changedBlocks: readonly string[];
}

export class AppSpecAppliedEvent extends BaseEvent {
    /**
     * `'app.spec.applied'` — the one wire name every listener subscribes to.
     * Pinned by `events.spec.ts` and by APW-07 T15's spec
     * (`app-env/__tests__/app-env.listener.spec.ts:516`), so a typo cannot
     * silently disconnect the two halves.
     */
    static EVENT_NAME = 'app.spec.applied';

    readonly workId: string;
    readonly commitSha: string;
    readonly previousCommitSha: string | null;
    readonly specHash: string;
    readonly addedDependencies: readonly string[];
    readonly changedEnvNames: readonly string[];
    readonly changedBlocks: readonly string[];

    constructor(payload: AppSpecAppliedPayload) {
        super();
        this.workId = payload?.workId ?? '';
        this.commitSha = payload?.commitSha ?? '';
        this.previousCommitSha = payload?.previousCommitSha ?? null;
        this.specHash = payload?.specHash ?? '';
        this.addedDependencies = payload?.addedDependencies ?? [];
        this.changedEnvNames = payload?.changedEnvNames ?? [];
        this.changedBlocks = payload?.changedBlocks ?? [];
    }

    /**
     * The payload as a plain object — for a log line, a job payload or a test
     * that asserts the exact field set. Names, ids, codes and hashes only: no
     * value of any `env` entry ever reaches this payload (R8).
     */
    toPayload(): AppSpecAppliedPayload {
        return {
            workId: this.workId,
            commitSha: this.commitSha,
            previousCommitSha: this.previousCommitSha,
            specHash: this.specHash,
            addedDependencies: this.addedDependencies,
            changedEnvNames: this.changedEnvNames,
            changedBlocks: this.changedBlocks,
        };
    }
}
