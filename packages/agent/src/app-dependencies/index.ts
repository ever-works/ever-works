/**
 * APW-07 (App env & dependencies) — the dependency service's public surface.
 *
 * APW-06 consumes this barrel, not the file paths: its Deploy preflight calls
 * `ensureReadyForDeploy`, its `PUT app-target` and the App-spec listener call
 * `reconcile`, its Remove op calls `onAppRemoved`, its `delete-app-work` op calls
 * `onAppWorkDeleting`, its delete dialog calls `list` and its verification op
 * calls `provisionEphemeral` (plan §4.8:558-562, §5:822-835).
 *
 * The four provisional tokens are exported on purpose — their owners bind them
 * (`{ provide: APP_DEPENDENCY_SPEC_SOURCE, useExisting: … }`, and the same for
 * the dispatcher, the cipher and the cluster access), so a consumer needs the
 * token from the owner of the seam, not a fresh `Symbol` of the same name.
 */

export {
    AppDependenciesService,
    AppDependencyRefusalError,
    APP_DEPENDENCY_CLUSTER_ACCESS,
    APP_DEPENDENCY_CONFIG_CIPHER,
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    APP_DEPENDENCY_SPEC_SOURCE,
    isUniqueViolation,
    type AppDependencyAttemptResult,
    type AppDependencyClusterAccess,
    type AppDependencyClusterAccessResult,
    type AppDependencyConfigCipher,
    type AppDependencyDeletionReport,
    type AppDependencyFacadeOptions,
    type AppDependencyListEntry,
    type AppDependencyNotReady,
    type AppDependencyProvisionDispatcher,
    type AppDependencyProvisionPayload,
    type AppDependencyReadiness,
    type AppDependencyReconcileResult,
    type AppDependencyRefusalCode,
    type AppDependencySpecEntry,
    type AppDependencySpecSnapshot,
    type AppDependencySpecSource,
    type AppEphemeralProvisionOptions,
    type AppEphemeralProvisionResult,
    type AppRuntimeTargetUnavailable,
    type IAppDependencyProvider,
    type WorkAppDependencyMetadata,
} from './app-dependencies.service';

export { AppDependenciesModule } from './app-dependencies.module';

// APW-07 T17 — the `app-dependency-provision` runner. Exported from this barrel
// (rather than reached by path) because `packages/tasks`'s task on APW-06's
// `app-cluster-io` queue resolves it by class through Nest DI, and a task may
// only import what the package's `exports` map publishes.
export {
    AppDependencyProvisionRunner,
    APP_DEPENDENCY_PROVISION_LEASE_MS,
    APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS,
    type AppDependencyProvisionKindResult,
    type AppDependencyProvisionRunResult,
} from './app-dependency-provision.runner';
