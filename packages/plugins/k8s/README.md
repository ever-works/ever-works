# @ever-works/k8s-plugin

Kubernetes deployment plugin for Ever Works. Deploy a generated work to any Kubernetes cluster you control as an alternative to the default Vercel provider.

- **Specs**: `docs/specs/features/k8s-deployment/`
- **User-facing docs**: `docs/features/k8s-deployment.md`
- **Sibling plugin**: `packages/plugins/vercel/`

## Architecture

- `kubeconfig.parser.ts` — pure YAML parsing + validation, no I/O
- `k8s-api.service.ts` — wraps `@kubernetes/client-node`; mockable via `KubernetesClientFactory`
- `registries/` — `RegistryProvider` strategies (github / dockerhub / generic)
- `ingress/` — `IngressStrategy` strategies (nginx / traefik / generic fallback)
- `manifest.renderer.ts` — pure functions: Deployment / Service / Ingress / image-pull Secret
- `status.mapper.ts` — Deployment rollout state → `DeploymentStatus`
- `domain.handler.ts` — Ingress patches and DNS verification
- `errors.ts` — `K8sPluginError` + credential scrubber
- `k8s.plugin.ts` — main `KubernetesPlugin` class implementing `IDeploymentPlugin`

## Extending

- **New registry kind** (ECR, GCR, ACR, Quay, …): implement `RegistryProvider`, then `registries.register(new MyProvider())`.
- **New ingress controller** (HAProxy, Gloo, Envoy Gateway, …): implement `IngressStrategy`, then `ingressStrategies.register(new MyStrategy())`.

## Testing

```bash
pnpm --filter @ever-works/k8s-plugin test
pnpm --filter @ever-works/k8s-plugin test:coverage
```

The Vitest suite mocks `@kubernetes/client-node` via the `KubernetesClientFactory` injection point — no real cluster needed.
