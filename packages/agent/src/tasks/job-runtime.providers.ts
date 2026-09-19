import type { Provider } from '@nestjs/common';
import type { IJobRuntimeProvider } from '@ever-works/plugin';
import { APP_BUILD_PREPARE_DISPATCHER } from './app-build-prepare-dispatcher';
import { APP_BUILD_WATCH_DISPATCHER } from './app-build-watch-dispatcher';
import { APP_DEPENDENCY_PROVISION_DISPATCHER } from './app-dependency-provision-dispatcher';
import { APP_SPEC_EVALUATE_DISPATCHER } from './app-spec-evaluate-dispatcher';
import { KB_BACKFILL_SKELETON_DISPATCHER } from './kb-backfill-skeleton-dispatcher';
import { KB_EMBED_DOCUMENT_DISPATCHER } from './kb-embed-document-dispatcher';
import { KB_MIRROR_DOCUMENT_DISPATCHER } from './kb-mirror-document-dispatcher';
import { KB_NORMALIZE_MEDIA_DISPATCHER } from './kb-normalize-media-dispatcher';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from './kb-org-overlay-fanout-dispatcher';
import { KB_REEMBED_WORK_DISPATCHER } from './kb-reembed-work-dispatcher';
import { KB_TRANSCRIBE_DISPATCHER } from './kb-transcribe-dispatcher';
import { MEMORY_FACT_EMBED_DISPATCHER } from './memory-fact-embed-dispatcher';
import { ROSTER_PROVISION_DISPATCHER } from './roster-provision-dispatcher';
import { TEMPLATE_CUSTOMIZATION_DISPATCHER } from './template-customization-dispatcher';
import { WEBHOOK_DELIVERY_DISPATCHER } from './webhook-delivery-dispatcher';
import { WORK_GENERATION_DISPATCHER } from './work-generation-dispatcher';
import { WORK_IMPORT_DISPATCHER } from './work-import-dispatcher';
import { WORKSPACE_BACKUP_DISPATCHER } from './workspace-backup-dispatcher';

/**
 * EW-685 P0 T4 — binding factory for the `*_DISPATCHER` symbols.
 *
 * Goal: a single declarative place that maps every dispatcher symbol
 * exported from `@ever-works/agent/tasks` onto the active
 * {@link IJobRuntimeProvider} (selected by `EVER_WORKS_JOB_RUNTIME` per
 * [`docs/specs/architecture/job-runtime-providers.md`](../../../../docs/specs/architecture/job-runtime-providers.md)
 * §4). The factory consumes the contract shipped EW-685 P0 (T1+T2) and
 * the config selector shipped EW-685 P0 T3 (`config.jobRuntime.getActiveProviderId()`),
 * and binds each symbol to a factory that returns the active provider's
 * `dispatchers` view — preserving the existing `string | null` enqueue
 * semantic when no provider is registered (the call site's in-process
 * dev fallback still kicks in on `null`).
 *
 * ## EW-685 T4 full cutover — fully wired
 *
 * Every `*_DISPATCHER` symbol in `@ever-works/agent/tasks` is now bound
 * through this factory in `packages/tasks/src/trigger/trigger.module.ts`
 * (no `symbols:` filter — every entry of {@link DISPATCHER_SYMBOLS} flows
 * through the registry, counted rather than numbered).
 * The previous 8-vs-3 split (with `KB_NORMALIZE_MEDIA_DISPATCHER` /
 * `KB_TRANSCRIBE_DISPATCHER` / `KB_REEMBED_WORK_DISPATCHER` still bound
 * as custom adapters in `apps/api/src/works/works.module.ts`) was
 * retired when matching `TriggerService.dispatchXxx` methods landed —
 * see the trio of impls on `TriggerService`.
 *
 * @see {@link IJobRuntimeProvider}
 * @see {@link JOB_RUNTIME_PROVIDER_REGISTRY}
 */

/**
 * DI token for the in-memory {@link JobRuntimeProviderRegistry}. Process-local
 * `Symbol(...)` — matches the convention every other runtime symbol in this
 * package uses (`Symbol.for(...)` would registry-share across worker
 * processes and silently collide on dynamic plugin reloads).
 *
 * The registry token is what {@link buildJobRuntimeProviders}'s factory
 * functions inject — wired in `packages/tasks/src/trigger/trigger.module.ts`
 * post-EW-685 T4 full cutover. Centralising the lookup behind a token
 * (rather than a module-level singleton) keeps the EW-742 P3
 * tenant-aware resolver swap surgical — the resolver replaces the
 * registry implementation, factory call sites stay identical.
 */
export const JOB_RUNTIME_PROVIDER_REGISTRY = Symbol('JOB_RUNTIME_PROVIDER_REGISTRY');

/**
 * Contract the binding factory consumes when resolving the active
 * provider at request time.
 *
 * Sized minimally on purpose — `register` + `getActive` cover every
 * call site in P0. The EW-742 P3 tenant-aware resolver (`getActive(tenantId?)`)
 * extends this interface in a backwards-compatible way; existing P0
 * factories that call `getActive()` with no args still resolve to the
 * global default.
 *
 * Single-active-runtime semantic (per EW-683 §4): `register()` overwrites
 * any previously registered provider. Multi-runtime fan-out is explicitly
 * out of scope until the tenant overlay lands.
 */
export interface JobRuntimeProviderRegistry {
    /**
     * Register the active job-runtime provider. Last call wins — single
     * active runtime per deployment per EW-683 §4. Idempotent for the
     * same provider instance.
     */
    register(provider: IJobRuntimeProvider): void;

    /**
     * Returns the currently-registered active provider, or `null` when
     * nothing has been registered yet (e.g. local dev with Trigger.dev
     * disabled). The factory functions in {@link buildJobRuntimeProviders}
     * translate `null` into a `null`-returning dispatcher view to preserve
     * the existing `string | null` enqueue semantic.
     */
    getActive(): IJobRuntimeProvider | null;
}

/**
 * Default in-memory {@link JobRuntimeProviderRegistry} implementation.
 *
 * Plain instantiable class — NOT a singleton at the class level. The
 * single-active-runtime invariant (EW-683 §4) is enforced at the DI
 * layer: the future `TasksModule` wiring registers exactly one
 * instance as a NestJS provider, and call sites resolve through DI.
 * Tests freely create fresh `new InMemoryJobRuntimeProviderRegistry()`
 * instances for isolation; nothing in the class itself guards against
 * multiple constructions.
 *
 * Kept as a plain class (not a `@Injectable()` service) so the binding
 * factory in P0 — declared but not yet wired — doesn't drag the NestJS
 * runtime into `@ever-works/agent/tasks` ahead of need.
 */
export class InMemoryJobRuntimeProviderRegistry implements JobRuntimeProviderRegistry {
    private active: IJobRuntimeProvider | null = null;

    register(provider: IJobRuntimeProvider): void {
        // Last call wins — single active runtime per EW-683 §4. The
        // tenant-aware overlay (EW-742 P3 / EW-747) replaces this whole
        // class with a `(tenantId, jobName) -> provider` resolver; the
        // single-active-runtime invariant only applies to the P0 default.
        this.active = provider;
    }

    getActive(): IJobRuntimeProvider | null {
        return this.active;
    }
}

/**
 * The full set of `*_DISPATCHER` symbols re-exported from
 * `@ever-works/agent/tasks` that {@link buildJobRuntimeProviders} binds.
 *
 * Listed explicitly (rather than reflected from the barrel) so a future
 * dispatcher addition is a deliberate two-line edit here + in
 * `_tasks-symbols.ts` — same pattern the barrel symbol-count test in
 * `tasks.spec.ts` enforces. The pin list keeps `buildJobRuntimeProviders()`
 * honest: missing a symbol here means that symbol won't get rebound when
 * the cutover flips, which is exactly the kind of silent drift the
 * EW-683 §3 conformance suite (P6 / EW-750) will eventually backstop.
 *
 * **Exported on purpose (APW-07 T17).** `__tests__/job-runtime.providers.spec.ts`
 * pins the provider arity against THIS list rather than against a magic number —
 * `expect(providers).toHaveLength(DISPATCHER_SYMBOLS.length)` — so a merge
 * that adds a dispatcher on one branch and a provider count on another cannot
 * produce a green suite over a stale count. The explicit expected-set assertion
 * next to it stays as the deliberate cross-check.
 */
export const DISPATCHER_SYMBOLS: readonly symbol[] = [
    // APW-05 T18 — the two Build dispatchers. Bound like every other dispatcher;
    // `null` (no runtime registered) is what `AppBuildsService` reads as "run the
    // prepare / watch runner in process" per plan §7.1:1321-1331 and APW05-G20.
    APP_BUILD_PREPARE_DISPATCHER,
    APP_BUILD_WATCH_DISPATCHER,
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    // APW-03 T13 — evaluates one App Work's App spec. Bound like every other
    // dispatcher; `null` (no runtime) makes the CALLER run the handler
    // in-process, which is the plan §6.1:661-662 rule for this job id alone.
    APP_SPEC_EVALUATE_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
    KB_REEMBED_WORK_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    // AW-07 — embeds one memory fact. Routed through the registry like every
    // other dispatcher so whichever job-runtime provider is active (and the
    // tenant overlay in front of it) runs `memory-fact-embed`; `null` when no
    // provider is registered leaves the fact for the nightly sweep.
    MEMORY_FACT_EMBED_DISPATCHER,
    ROSTER_PROVISION_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    WORKSPACE_BACKUP_DISPATCHER,
] as const;

/**
 * Build the NestJS providers array that binds every `*_DISPATCHER`
 * symbol to the active job-runtime provider's `dispatchers` view.
 *
 * Each returned provider:
 *   - resolves the active {@link IJobRuntimeProvider} via the registry
 *     injected through {@link JOB_RUNTIME_PROVIDER_REGISTRY};
 *   - returns `provider.dispatchers` (the `Readonly<Record<string, unknown>>`
 *     view the contract specifies — call sites cast back to their
 *     concrete dispatcher interface, same as `TriggerService` does today);
 *   - returns `null` when no provider is registered, preserving the
 *     `string | null` enqueue semantic per the contract JSDoc §3 and
 *     letting the API's existing in-process dev fallback continue to
 *     kick in unchanged.
 *
 * Provider arity is pinned by COUNTING {@link DISPATCHER_SYMBOLS} (the
 * original 11 plus AW-07's `MEMORY_FACT_EMBED_DISPATCHER`, develop's
 * `ROSTER_PROVISION_DISPATCHER`, AW-22's `WORKSPACE_BACKUP_DISPATCHER`,
 * APW-07's `APP_DEPENDENCY_PROVISION_DISPATCHER`, APW-03 T13's
 * `APP_SPEC_EVALUATE_DISPATCHER` and APW-05 T18's
 * `APP_BUILD_PREPARE_DISPATCHER` + `APP_BUILD_WATCH_DISPATCHER` — every one of
 * them is verified by `__tests__/job-runtime.providers.spec.ts`, which asserts
 * `providers.length === DISPATCHER_SYMBOLS.length`). The array holds **18**
 * entries at APW-05 T18, COUNTED off the array itself rather than added up from
 * a branch's own number — do the same after every merge.
 *
 * @param opts Optional `symbols` filter — when supplied, only those
 *   tokens are bound (the rest stay wherever the operator's module
 *   tree binds them today). The EW-685 T4 full cutover in
 *   `packages/tasks/src/trigger/trigger.module.ts` now passes no
 *   filter (every {@link DISPATCHER_SYMBOLS} entry flows through the
 *   registry) — the
 *   `symbols:` option is retained for tests and for future modules
 *   that want to bind a subset (e.g. a pull-model worker host that
 *   only owns a strict subset of the dispatcher surface).
 *
 * @returns A frozen NestJS `Provider[]` ready to be spread into a
 *   module's `providers` array. EW-685 T4 full cutover landed in
 *   `trigger.module.ts`; every `*_DISPATCHER` symbol resolves through
 *   the registry without per-dispatcher special-casing.
 */
export interface BuildJobRuntimeProvidersOptions {
    /**
     * Subset of `DISPATCHER_SYMBOLS` to bind. When omitted, every
     * entry of {@link DISPATCHER_SYMBOLS} is bound (the default
     * `trigger.module.ts` path post-EW-685 T4
     * full cutover). Used by tests and by future modules that want
     * to bind a strict subset.
     */
    readonly symbols?: readonly symbol[];
}

export function buildJobRuntimeProviders(opts: BuildJobRuntimeProvidersOptions = {}): Provider[] {
    const symbols = opts.symbols ?? DISPATCHER_SYMBOLS;
    return symbols.map((token) => ({
        provide: token,
        // Cast through `unknown` because each `*_DISPATCHER` symbol expects
        // a concrete dispatcher shape but the registry hands back the
        // contract's intentionally-untyped `JobRuntimeDispatchers`
        // (`Readonly<Record<string, unknown>>`) — the cycle-avoidance
        // rationale lives in the IJobRuntimeProvider JSDoc on
        // `dispatchers`. Each call site already casts back to its concrete
        // interface (e.g. `WorkGenerationDispatcher`), so the runtime
        // shape is enforced by usage rather than the binding edge.
        useFactory: (registry: JobRuntimeProviderRegistry): unknown => {
            const provider = registry.getActive();
            if (!provider) {
                return null;
            }
            return provider.dispatchers;
        },
        inject: [JOB_RUNTIME_PROVIDER_REGISTRY],
    }));
}
