import type { Provider } from '@nestjs/common';
import type { IJobRuntimeProvider } from '@ever-works/plugin';
import { KB_BACKFILL_SKELETON_DISPATCHER } from './kb-backfill-skeleton-dispatcher';
import { KB_EMBED_DOCUMENT_DISPATCHER } from './kb-embed-document-dispatcher';
import { KB_MIRROR_DOCUMENT_DISPATCHER } from './kb-mirror-document-dispatcher';
import { KB_NORMALIZE_MEDIA_DISPATCHER } from './kb-normalize-media-dispatcher';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from './kb-org-overlay-fanout-dispatcher';
import { KB_REEMBED_WORK_DISPATCHER } from './kb-reembed-work-dispatcher';
import { KB_TRANSCRIBE_DISPATCHER } from './kb-transcribe-dispatcher';
import { TEMPLATE_CUSTOMIZATION_DISPATCHER } from './template-customization-dispatcher';
import { WEBHOOK_DELIVERY_DISPATCHER } from './webhook-delivery-dispatcher';
import { WORK_GENERATION_DISPATCHER } from './work-generation-dispatcher';
import { WORK_IMPORT_DISPATCHER } from './work-import-dispatcher';

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
 * ## Critical constraint — declared but NOT wired in this PR
 *
 * Today the `*_DISPATCHER` symbols are bound directly to `TriggerService`
 * inside `packages/tasks/src/trigger/trigger.module.ts` (via
 * `{ provide: <SYMBOL>, useExisting: TriggerService }`). **Those bindings
 * stay untouched.** This file exports `buildJobRuntimeProviders()` and
 * the in-memory `JOB_RUNTIME_PROVIDER_REGISTRY` registry, but no NestJS
 * module imports the result yet — the factory is a callable seam that:
 *
 *   - tests can exercise end-to-end (see `__tests__/job-runtime.providers.spec.ts`);
 *   - the EW-742 P3 / EW-747 tenant-aware resolver can extend
 *     (`getActive(tenantId?)`) without churning call sites;
 *   - a follow-up PR can wire into `TasksModule` to flip the cutover
 *     once the team is comfortable.
 *
 * ## TODO (follow-up cutover PR)
 *
 * Wire `buildJobRuntimeProviders()` into `TasksModule` (or the equivalent
 * provider-bootstrap module) + remove the direct `useExisting:
 * TriggerService` bindings in `packages/tasks/src/trigger/trigger.module.ts`
 * to complete the cutover. Today the factory is callable from tests + the
 * future tenant-aware resolver (EW-742 P3 / EW-747) but doesn't replace
 * the existing direct bindings yet.
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
 * The registry token is what a follow-up `TasksModule` wiring will inject
 * into the factory functions returned by {@link buildJobRuntimeProviders}.
 * Centralising the lookup behind a token (rather than a module-level
 * singleton) keeps the EW-742 P3 tenant-aware resolver swap surgical —
 * the resolver replaces the registry implementation, factory call sites
 * stay identical.
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
 * Module-local mutable singleton because the binding factory in P0 is
 * declared but not wired into a NestJS module — tests instantiate this
 * class directly and the future `TasksModule` wiring will provide a
 * DI-managed instance. Keeping the implementation a plain class (not a
 * `@Injectable()` service) avoids importing the NestJS runtime into
 * `@ever-works/agent/tasks` ahead of need.
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
 */
const DISPATCHER_SYMBOLS: readonly symbol[] = [
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
    KB_REEMBED_WORK_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
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
 * Provider arity is pinned at 11 — one per entry in {@link DISPATCHER_SYMBOLS}
 * — and verified by `__tests__/job-runtime.providers.spec.ts`.
 *
 * @returns A frozen NestJS `Provider[]` ready to be spread into a module's
 *   `providers` array. Currently no module imports it; see the file
 *   header "Critical constraint — declared but NOT wired in this PR".
 */
export function buildJobRuntimeProviders(): Provider[] {
    return DISPATCHER_SYMBOLS.map((token) => ({
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
