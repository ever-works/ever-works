# @ever-works/k8s-plugin

Kubernetes deployment plugin for Ever Works. Deploy a generated work to any Kubernetes cluster you control as an alternative to the default Vercel provider.

- **User-facing docs**: [`docs/features/k8s-deployment.md`](../../../docs/features/k8s-deployment.md)
- **Spec / plan / tasks**: [`docs/specs/features/k8s-deployment/`](../../../docs/specs/features/k8s-deployment/)
- **Sibling plugin**: [`packages/plugins/vercel/`](../vercel/)

## What it does

- Discoverable in `/api/plugins?category=deployment` once the package is installed.
- User pastes a kubeconfig in `/en/settings/plugins/deployment` → plugin reads cluster info and detects ingress controllers.
- A work with `deployProvider: 'k8s'` deploys via this plugin instead of Vercel.
- Server-side apply (SSA) of `Deployment`, `Service`, optional `Ingress`, optional `imagePullSecret` — all labelled `ever-works.io/managed=true` and tagged with field manager `ever-works-k8s-plugin`.
- Pluggable container registry: GHCR (default, mirrors website-repo visibility), Docker Hub, generic OCI.
- Pluggable ingress controller: ingress-nginx, Traefik, plus a generic fallback.
- Custom domain support via Ingress patches and DNS verification.
- Credential scrubbing on every error path: kubeconfig YAML, PEM blocks, bearer tokens, runtime registry passwords are redacted before any user-visible message.

## Architecture

```
src/
├── index.ts                       # Public exports
├── types.ts                       # KubernetesSettings, RegistryConfig, IngressClassDescriptor, …
├── errors.ts                      # K8sPluginError + scrubError() credential scrubber
├── kubeconfig.parser.ts           # Pure YAML parsing + validation, no I/O
├── k8s-api.service.ts             # Wraps @kubernetes/client-node; mockable via KubernetesClientFactory
├── manifest.renderer.ts           # Pure functions: Deployment / Service / Ingress / Secret
├── status.mapper.ts               # Deployment rollout state → DeploymentStatus
├── domain.handler.ts              # Ingress patches + DNS verification
├── k8s.plugin.ts                  # Main KubernetesPlugin class (IDeploymentPlugin)
├── registries/                    # RegistryProvider strategies
│   ├── provider.ts                # interface
│   ├── provider.registry.ts       # registry of providers, register()
│   ├── github.provider.ts         # GHCR (default; resolves visibility from website repo)
│   ├── dockerhub.provider.ts
│   └── generic.provider.ts
└── ingress/                       # IngressStrategy strategies
    ├── strategy.ts                # interface
    ├── strategy.registry.ts       # registry of strategies, register()
    ├── nginx.strategy.ts          # k8s.io/ingress-nginx
    ├── traefik.strategy.ts        # traefik.io/ingress-controller
    └── generic.strategy.ts        # fallback for unknown controllers
```

## Extending

The plugin is built around two strategy registries; new kinds plug in without touching the deploy code.

### Add a registry kind (ECR / GCR / ACR / Quay / …)

```ts
import { RegistryProvider, defaultRegistryProviderRegistry } from '@ever-works/k8s-plugin';

class EcrRegistryProvider implements RegistryProvider {
	readonly kind = 'ecr' as const;
	imageBase(config, ctx) {
		return `…`;
	}
	resolveVisibility() {
		return 'private';
	}
	workflowLogin() {
		return { registry: '…', username: '…', passwordEnv: '…' };
	}
	pullSecretCredentials() {
		return null; /* or {server,username,password} */
	}
}

defaultRegistryProviderRegistry.register(new EcrRegistryProvider());
```

Add the new `kind` to the `RegistryConfig` discriminated union in `src/types.ts` and add a `oneOf` branch to `REGISTRY_SCHEMA` in `src/k8s.plugin.ts`.

### Add an ingress controller strategy (HAProxy / Gloo / Envoy Gateway / …)

```ts
import { IngressStrategy, defaultIngressStrategyRegistry } from '@ever-works/k8s-plugin';

class HaProxyIngressStrategy implements IngressStrategy {
	readonly controller = 'haproxy.org/ingress-controller';
	annotations(input) {
		return {
			/* HAProxy-specific annotations */
		};
	}
	tls(input) {
		return [
			/* TLS entries */
		];
	}
}

defaultIngressStrategyRegistry.register(new HaProxyIngressStrategy());
```

Strategies are looked up by their `controller` string (matches `IngressClass.spec.controller`). When `validateConnection()` lists the cluster's `IngressClass` resources, each one is marked with `hasStrategy: true/false` so the UI can flag unknown controllers.

## Development

From the package directory:

```bash
pnpm test               # run the Vitest suite (124 tests, no real cluster)
pnpm test:watch         # watch mode
pnpm test:coverage      # v8 coverage report
pnpm type-check         # tsc --noEmit
pnpm build              # tsc --noEmit + tsup (CJS + ESM + DTS)
```

From the repo root:

```bash
pnpm --filter @ever-works/k8s-plugin test
pnpm --filter @ever-works/k8s-plugin build
```

All cluster I/O is mocked via the `KubernetesClientFactory` injection point on `KubernetesApiService` — see `src/__tests__/k8s-api.service.spec.ts` for the pattern. No live cluster is required to run the suite.

## Manual smoke test

Spin up a kind cluster locally and verify against it:

```bash
# 1. Create a kind cluster with ingress-nginx
kind create cluster --name ever-works-test
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# 2. Get a kubeconfig
kind get kubeconfig --name ever-works-test > /tmp/kubeconfig

# 3. Paste /tmp/kubeconfig into /en/settings/plugins/deployment in your local Ever Works UI
# 4. Save & verify — you should see "kind-ever-works-test (vX.Y.Z)" with nginx detected
```

## Constraints (v1)

- One cluster per user (plugin-settings store is `x-scope: 'user'`, mirroring Vercel).
- No cloud-provider registries (ECR/GCR/ACR) — extension points exist; not shipped.
- No HAProxy / Gloo / Envoy Gateway ingress strategies — fallback to generic; extension points exist.
- No Helm/Kustomize input — manifests are rendered as typed JS objects.
- No GitOps mode (Argo CD / Flux) — imperative SSA only.
- The deploy workflow YAML and Dockerfile live in the website-template repos (separate PRs to `ever-works/directory-web-template` and `ever-works/directory-web-minimal-template`).
