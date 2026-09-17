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
