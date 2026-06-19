/**
 * EW-683 / EW-685 — the `*_DISPATCHER` symbols re-exported below ARE
 * the seam that makes the job runtime pluggable. The API depends only
 * on these symbols; today `TriggerService` (`packages/tasks/src/trigger/trigger.service.ts`)
 * implements every one of them. EW-686 P1 will refactor `TriggerService`
 * to implement the `IJobRuntimeProvider` contract
 * (`packages/plugin/src/contracts/capabilities/job-runtime.interface.ts`,
 * shipped EW-685 P0) and a binding factory at
 * `packages/agent/src/tasks/job-runtime.providers.ts` will bind whichever
 * provider is active (env: `EVER_WORKS_JOB_RUNTIME`) to all of these symbols.
 * Call sites do not change. See `docs/specs/architecture/job-runtime-providers.md`
 * §2 (seam) and §3 (contract) for the full picture.
 */
export * from './work-generation.types';
export * from './work-generation-dispatcher';
export * from './work-import.types';
export * from './work-import-dispatcher';
export * from './template-customization.types';
export * from './template-customization-dispatcher';
export * from './webhook-delivery.types';
export * from './webhook-delivery-dispatcher';
export * from './kb-mirror-document.types';
export * from './kb-mirror-document-dispatcher';
export * from './kb-backfill-skeleton.types';
export * from './kb-backfill-skeleton-dispatcher';
export * from './kb-embed-document.types';
export * from './kb-embed-document-dispatcher';
export * from './kb-org-overlay-fanout.types';
export * from './kb-org-overlay-fanout-dispatcher';
export * from './kb-normalize-media.types';
export * from './kb-normalize-media-dispatcher';
export * from './kb-transcribe.types';
export * from './kb-transcribe-dispatcher';
export * from './kb-reembed-work.types';
export * from './kb-reembed-work-dispatcher';
// Tenant-scoped job-runtime overlay (EW-742 P1) — credential versioning
// for graceful drain on rotation. See ADR-017 §3 + spec.md FR-5.
export * from './credential-version.service';
// Tenant-scoped job-runtime overlay (EW-742 P3.1 / T21) — in-process
// LRU+TTL cache for resolved credential snapshots, keyed by
// `(tenantId, providerId, credentialVersion)`. Standalone class — the
// P3 resolver (#1380 follow-up) and P4 worker host wire it in
// separately. See the class JSDoc for the no-promotion-on-read
// rationale (graceful drain per ADR-017 §3 / Q4).
export * from './tenant-credential.cache';

// EW-685 P0 T4 — job-runtime binding factory + registry token.
//
// The DI token + the default in-memory registry surface through the
// barrel so DI modules (e.g. `TenantJobRuntimeModule` for EW-742 P3 /
// EW-747) can bind `{ provide: JOB_RUNTIME_PROVIDER_REGISTRY, useClass:
// InMemoryJobRuntimeProviderRegistry }` without reaching into
// `./job-runtime.providers` directly. `buildJobRuntimeProviders()` stays
// behind the file boundary because it's a one-shot module-wiring helper,
// not a DI consumer entry point.
export {
    InMemoryJobRuntimeProviderRegistry,
    JOB_RUNTIME_PROVIDER_REGISTRY,
} from './job-runtime.providers';
export type { JobRuntimeProviderRegistry } from './job-runtime.providers';

// EW-742 P3 / EW-747 (T20 + T23) — tenant-aware job-runtime resolver.
// Wraps the EW-685 binding factory registry so callers can resolve the
// active provider for a specific tenant; non-overridden tenants pass
// through to `registry.getActive()`. See the file header on the
// resolver for the P3 stopgap behaviour and the P3.1 / T21 / T22
// deferral notes.
export { TenantAwareRuntimeResolver } from './tenant-aware-runtime.resolver';

// EW-742 P3.1 / T22 — enqueue-site credentialVersion capture helper.
// Standalone @Injectable() that returns the `(providerId,
// credentialVersion)` tuple a dispatcher should stamp onto a run
// record so the worker host can resolve the same snapshot via
// `CredentialVersionService.resolveSnapshot`. Per-dispatcher wiring
// lands incrementally on top — see the file header for the
// deliberate-seam rationale.
export { RuntimeBindingStamperService } from './runtime-binding-stamper.service';

// EW-742 P3.2 — SecretStoreResolver contract + default in-process
// implementation. The resolver wires it into the byo/override branch
// to construct TenantCredentialSnapshot before calling
// provider.bindToTenant(). Default impl only supports `inline:` scheme
// — production deployments swap the SECRET_STORE_RESOLVER binding to
// a scheme-specific implementation (vault:, k8s:, op:, etc.).
export { SECRET_STORE_RESOLVER } from './secret-store-resolver.interface';
export type { SecretStoreResolver } from './secret-store-resolver.interface';
export { InProcessSecretStoreResolver } from './in-process-secret-store-resolver.service';

// EW-742 P3.2 — Vault SecretStoreResolver now lives at
// @ever-works/secret-store-vault-plugin (packages/plugins/secret-store-vault/).
// Operators using Vault override the SECRET_STORE_RESOLVER DI binding to
// the plugin's exported VaultSecretStorePlugin class.

// EW-742 P3.2 — K8s SecretStoreResolver now lives at
// @ever-works/secret-store-k8s-plugin (packages/plugins/secret-store-k8s/).
// Operators using Kubernetes Secrets override the SECRET_STORE_RESOLVER
// DI binding to the plugin's exported K8sSecretStorePlugin class.

// EW-742 P3.2 — Infisical SecretStoreResolver now lives at
// @ever-works/secret-store-infisical-plugin
// (packages/plugins/secret-store-infisical/).

// EW-742 P3.2 follow-up — DopplerSecretStoreResolver. HTTP against
// Doppler REST API (`/v3/configs/config/secrets`); freemium SaaS
// secrets-management platform. Opt-in via DI binding override.
export { DopplerSecretStoreResolver } from './doppler-secret-store-resolver.service';
