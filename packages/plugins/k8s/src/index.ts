export { KubernetesPlugin, KubernetesPlugin as default } from './k8s.plugin.js';
export { KubernetesApiService, defaultClientFactory } from './k8s-api.service.js';
export type { KubernetesClientFactory, KubernetesApiClientLike } from './k8s-api.service.js';
export {
	K8sPluginError,
	scrubError,
	scrubString,
	buildSecretPattern,
	type K8sPluginErrorCode,
	type ScrubbedError
} from './errors.js';
export { parseKubeconfig, type ParsedKubeconfig } from './kubeconfig.parser.js';
export {
	buildDeployment,
	buildService,
	buildIngress,
	buildImagePullSecret,
	pullSecretNameFor,
	FIELD_MANAGER
} from './manifest.renderer.js';
export { mapDeploymentToStatus, isRolloutComplete, type DeploymentStatusInput } from './status.mapper.js';
export { defaultRegistryProviderRegistry, RegistryProviderRegistry } from './registries/provider.registry.js';
export { GitHubRegistryProvider } from './registries/github.provider.js';
export { DockerHubRegistryProvider } from './registries/dockerhub.provider.js';
export { GenericRegistryProvider } from './registries/generic.provider.js';
export type { RegistryProvider } from './registries/provider.js';
export { defaultIngressStrategyRegistry, IngressStrategyRegistry } from './ingress/strategy.registry.js';
export { NginxIngressStrategy } from './ingress/nginx.strategy.js';
export { TraefikIngressStrategy } from './ingress/traefik.strategy.js';
export { GenericIngressStrategy } from './ingress/generic.strategy.js';
export type { IngressStrategy, IngressStrategyInputs, IngressTlsEntry } from './ingress/strategy.js';
export {
	appendHostToIngress,
	removeHostFromIngress,
	verifyDomainResolution,
	buildDnsGuidance,
	defaultDnsResolver,
	toAddDomainResult,
	type DnsResolver
} from './domain.handler.js';
export * from './types.js';
// App renderer (APW-06 plan §4.1 names/labels and §4.4 security context) — pure functions with no
// cluster access, exported for APW-10's in-zone controller and for the rest of `src/app/`.
export * from './app/app-names.js';
export * from './app/app-security.js';
// App manifest renderer (APW-06 T6, plan §4.2–§4.7/§4.11/§4.12) and its network policies (T7,
// plan §4.10) — the pure library R-5 asks for: `AppRenderInput` in, cluster objects out, no I/O.
export * from './app/app-network-policy.renderer.js';
export * from './app/app-manifest.renderer.js';
// App jobs, CronJobs and the runner (APW-06 T8, plan §4.8/§4.9) with the runner script they mount
// and the rollout predicate/classifier of §5.4 (T9) — pure functions over `AppRenderInput` and over
// observed cluster state, no I/O and no clock of their own.
export * from './app/app-runner.script.js';
export * from './app/app-jobs.renderer.js';
export * from './app/app-rollout.js';
// The kubeconfig guard (APW-06 T11, plan §6.1) — the one way a customer-supplied
// kubeconfig may be loaded: the unsupported user/cluster fields refused, the
// server required to be a public https address, and the validated IP pinned so
// the name cannot be re-resolved between the check and the call. Exported so
// APW-07 and APW-10 reach it through the package root rather than a deep import.
export * from './app/app-kubeconfig.guard.js';
// The deployer (APW-06 T12, plan §5.5–§5.7) — the phase machine and the rollback,
// applying what the renderers above produce. Its `deployApp` is
// `IDeploymentPlugin.deployApp`'s exact signature, and `AppDeployerApi` is the
// five-method port over `KubernetesApiService` that keeps it unit-testable.
export * from './app/app-deployer.js';
// The status reader (APW-06 T13, plan §4.12/§9.3/§9.10) — the live read behind
// `IDeploymentPlugin.getAppStatus`: components, jobs, CronJobs, the smoke report
// and the isolation probe, with `AppStatusApi` as its port over
// `KubernetesApiService`.
export * from './app/app-status.reader.js';
// The lifecycle (APW-06 T13, plan §5.4/§4.6/§4.8/§6.4) — `AppLifecycle`'s
// pause/resume, logs, manual job, namespace preparation, host publication and
// destroy, with `AppLifecycleApi` as its port. `APP_LIFECYCLE_CODES` names the
// refusals it raises through `K8sPluginError`.
export * from './app/app-lifecycle.js';
// The cluster check (APW-06 T13, plan §6.3) — `AppClusterChecker`'s
// fail-closed `SelfSubjectAccessReview` sweep over `APP_REQUIRED_PERMISSIONS`,
// the ingress controller address of GAP-09 and the credential fingerprint, none
// of which ever carries the credential itself.
export * from './app/app-cluster-check.js';
// One name is shared by two App modules — `componentSelector` — and TypeScript
// drops an ambiguous star-export from the package root entirely (TS2308) rather
// than picking one. The two are not the same function: `app-names.ts` (T6) builds
// the `{ 'ever-works.io/component': name }` LABEL MAP, while the status reader (T13)
// builds the `'ever-works.io/component=name'` SELECTOR STRING. Both are wanted, so
// both are re-exported explicitly: the incumbent keeps its published name, and the
// T13 spelling is ALSO reachable as `componentLabelSelector`. Nothing inside either
// module is renamed or removed.
export { componentSelector } from './app/app-names.js';
export { componentSelector as componentLabelSelector } from './app/app-status.reader.js';
