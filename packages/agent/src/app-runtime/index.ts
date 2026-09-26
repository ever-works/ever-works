/**
 * Public API of the App runtime ports (APW-06 `plan.md` §9.6, §9.8:1510–1538).
 *
 * Imported as `@ever-works/agent/app-runtime`:
 *
 * - `./ports` — the port interfaces, their DI tokens and the typed refusal error.
 * - `./default-ports` — the fail-closed defaults the platform binds until APW-05, APW-07 and APW-10
 *   replace them.
 * - `./app-runtime-deletion.service` — `AppRuntimeDeletionService` (T58, plan §9.7), which is what
 *   APW-01's `APP_WORK_DELETION_PORT` is bound to, plus the `delete-app-work` op handler T70's
 *   router routes to. It carries its own clearly-marked provisional seam block for the three
 *   collaborators whose owner tasks have not landed yet (APW-01 T39's port and its
 *   `completeAppWorkDeletion`, APW-07 T16's `AppDependenciesService`), so the swap is an import.
 * - `./app-verification-target.service` — `AppVerificationTargetService` (T60, plan §4.12,
 *   Resolution R-10) and its `verification-deploy` / `verification-status` / `verification-destroy`
 *   op handlers for T70's router, plus the §4.12 namespace derivation both `verification-deploy`
 *   and `verification-destroy` agree on. Its provisional block declares APW-06 T20's facade, APW-06
 *   T22's render-input builder and APW-07 T16's `provisionEphemeral`, and **reuses**
 *   `APP_DEPENDENCIES_SERVICE`, `APP_RUNTIME_ENV_SOURCE` and `APP_VERIFICATION_SINK` rather than
 *   declaring parallel tokens (R-26; a second `Symbol` of the same name is a different token).
 * - `./worker-context` — `markAppClusterWorkerContext()` / `isAppClusterWorkerContext()` and the
 *   `APP_CLUSTER_IO_IN_API` refusal (T20, plan §6.2). A **process-level flag, not an env var**.
 *   Exported here because the one caller that arms it is T71's bootstrap provider in
 *   `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts`: a cross-package
 *   import can only reach the built `@ever-works/agent/app-runtime` subpath, so the marker has to
 *   be on this barrel.
 * - `./app-license-gate` and `./app-deploy-preconditions.service` — `AppLicenseGate` (plan §5.2)
 *   and `AppDeployPreconditionsService` (plan §5.1, T21), plus the provisional seams each declares
 *   (`APP_LICENSE_SERVICE`; `APP_DEPLOY_SPEC_SOURCE`, `APP_DEPLOY_BUILD_SOURCE`,
 *   `APP_DEPLOY_HOST_SOURCE`, `APP_DEPLOY_DISPATCHER_AVAILABILITY`, and the runtime-state and
 *   dependency *views* that reuse the tokens other files already own). Exported for the same
 *   cross-package reason as the marker above: the `app-deploy` task in `packages/tasks` re-runs the
 *   precondition pass (§5.6 step 1) and the API's deploy route answers from it (§2.2 step 2), and
 *   both can only reach this folder through the subpath barrel.
 * - `./app-render-input.builder` — `AppRenderInputBuilder` (plan §5.6 step 2, §5.8; T22): the one
 *   place an `AppRenderInput` is assembled, plus the §3 resolution helpers it publishes
 *   (`componentInputs`, `jobInputs`, `cronInputs`, `smokeInputs`, `internalUrlsFor`,
 *   `primaryComponentName`, `declaredDependencyKinds`, `deploymentShortFor`, `urlForHost`,
 *   `pinnedReference`, `workSlugFromNamespace`) and its provisional host seam. It implements T60's
 *   `AppVerificationSpecSource` (§4.12's spec side, `readVerificationSpec`), which is why the
 *   `verification-deploy` handler can bind `APP_VERIFICATION_SPEC_SOURCE` with
 *   `useExisting: AppRenderInputBuilder`. Exported here because T25's orchestrator lives in
 *   `packages/tasks` and can only reach this folder through the subpath barrel.
 * - `./app-public-smoke.service` — `AppPublicSmokeService` (T23, plan §5.5, FR-36/FR-37): the
 *   platform's half of the smoke run behind `AppDeployHooks.verifyPublic`, with the four
 *   classifications, the 600 s / 180 s windows, the 10 s retry, the 1 MiB cap and the
 *   `≤ 200`-character excerpt, plus the pure helpers T25 and §9.3's health poll read
 *   (`publicSmokeWindowSeconds`, `smokeChecksFor`, `classifyPublicSmokeError`, `excerpt`,
 *   `readCapped`). Exported for the same cross-package reason as the entries above.
 * - `./app-deploy-request.service` — `AppDeployRequestService` (T24, plan §2.2, §5.8): the request
 *   path — the isolated-worker gate, T21's preconditions, the `build_not_applicable` validation, the
 *   atomic lock claim, the latest-wins queue and the 2 s-budgeted dispatch — plus its `requestDeploy`
 *   wrapper for APW-01's `APP_DEPLOY_ROUTE_PORT` (T34 binds it with `useExisting`) and the
 *   provisional seams it declares (the `APP_DEPLOY_DISPATCHER` token T31 will bind, the
 *   `work_deployments` store T16 will provide, and the runtime-state *view* that reuses
 *   `WORK_APP_RUNTIME_STATES`). The API's route and `DeployService` both live outside this package,
 *   which is why it has to be on the barrel.
 * - `./app-hosts.service` — `AppHostsService` (T26, plan §8.1/§8.2/§8.4/§4.11) and the pure
 *   `appUrlScheme` / `appHostUrl` / `sameHost` helpers. It implements T22's `resolveHosts` view on
 *   T21's existing `APP_DEPLOY_HOST_SOURCE` token — which is what removes T22's `hosts_incomplete`
 *   warning — and APW-11's `APP_PUBLISHED_HOSTS`; both bindings are `useExisting`, so the one class
 *   answers every host question. It also **re-exports** `APP_CLUSTER_OP_DISPATCHER` (T58's token)
 *   rather than declaring a second one for §8.2's `ingress-reconcile` op.
 * - `./app-domains.service` — `AppDomainsService` (T26, plan §8.4), `verifyDomainResolution` and
 *   `buildDnsGuidance` — the App branch `DeployFacadeService`'s four domain methods delegate to.
 * - `./app-deploy.orchestrator` — `AppDeployOrchestrator` (T25, plan §5.6 steps 1–10): the one class
 *   that calls `deployApp`, with its outcome→state table (`mapOutcome`, `terminalEventName`,
 *   `isTerminalState`, `cancelReasonOf`) and its provisional seams (`APP_DEPLOY_TARGET_RESOLVER`
 *   bound to T20's facade, `APP_IMAGE_REFERENCE_RESOLVER` for T72, `APP_UPSTREAM_STATE_READER` /
 *   `APP_COMMIT_ANCESTRY` for APW-02, `APP_RUNTIME_NOTIFICATIONS` for T29's producers). It lives
 *   here because the `app-deploy` task in `packages/tasks` — the only caller — can reach this folder
 *   through the subpath barrel alone, and the API must never construct a working one.
 * - `./app-cluster-op.router` — `AppClusterOpRouter` (T70, plan §9.10): `handle(payload)` routes an
 *   `app-cluster-op` payload by `op`, `register(op, handler)` is the extension point T48/T58/T60/T69
 *   use, and the classifier maps §9.2's fifteen ids onto the four services that own them. It is on
 *   the barrel because `app-cluster-op.task.ts` in `packages/tasks` resolves it from the worker
 *   context by class token — a cross-package resolution that can only reach the built subpath.
 * - `./app-lifecycle-ops.service` — `AppLifecycleOpsService` (T70, plan §9.10): the nine handlers
 *   (`status-refresh`, `logs`, `pause`, `resume`, `remove`, `cancel-deploy`, `job-run`,
 *   `cluster-check`, `ingress-reconcile`), the `app-op:` / `app-logs:` cache keys and their
 *   300 000 ms TTL, and the provisional seams each handler refuses by name through.
 * - `./app-smoke.service` — `AppSmokeService` (T70, plan §5.7): the on-demand smoke run behind
 *   `app-smoke` — in-cluster through `runAppJob` with `runner: 'smoke'`, public through T23's
 *   `AppPublicSmokeService`, `smokeResult` on the Deployment, `app.smoke.*` and **no rollback**.
 * - `./app-health.service` — `AppHealthService` (T27, plan §9.3, FR-47): the every-minute sweep
 *   behind `app-health-poll` — §9.3's selection and 500-row cap, five polls per cluster, a 20 s
 *   budget per poll, FR-47's verdicts and streak rules, the `app.health.*` events, and the
 *   notification producers T29 owns. It is on the barrel because `app-health-poll.task.ts` in
 *   `packages/tasks` resolves it from the worker context by class token.
 */

export * from './ports';
export * from './default-ports';
export * from './worker-context';
export * from './app-runtime-deletion.service';
export * from './app-verification-target.service';
export * from './app-license-gate';
export * from './app-deploy-preconditions.service';
export * from './app-render-input.builder';
export * from './app-public-smoke.service';
export * from './app-deploy-request.service';
export * from './app-hosts.service';
export * from './app-domains.service';
export * from './app-deploy.orchestrator';
export * from './app-cluster-op.router';
export * from './app-lifecycle-ops.service';
export * from './app-smoke.service';
export * from './app-health.service';
// APW-06 T17 — the module that binds `WORK_APP_RUNTIME_STATES`, and §2.2's
// deploy request path, which is the first thing in this epic a route can
// actually reach.
//
// `work-app-runtime-state.port` is deliberately NOT re-exported here.
// `AppDeployQueueWrite` and `AppHealthStatePatch` are each declared twice in
// this directory — once by the port as the canonical shape, once by the
// consumer service as its own structural view — and a barrel that exports both
// is ambiguous (TS2308). The consumers' views are what every existing importer
// already uses; the port is the implementation's contract, imported by path
// where it is needed.
export * from './app-runtime-state.module';
export * from './app-deploy-request.module';
// APW-06 §5.1 — the Build source's class, by name only: the API's internal Trigger
// controller publishes it as the remote target the isolated App runtime worker's
// `APP_DEPLOY_BUILD_SOURCE` proxies. Its helpers stay file-private to this folder.
export { AppDeployBuildSourceAdapter } from './app-deploy-build.source';
