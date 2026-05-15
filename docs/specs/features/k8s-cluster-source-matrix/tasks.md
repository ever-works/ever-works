# Implementation Tasks: Kubernetes Cluster-Source Matrix (EW-616)

> Backlog of discrete, completable units of work that implement [`./plan.md`](./plan.md).

**Status**: `Done`
**Last updated**: 2026-05-14

---

## Closed

### Code

- ✅ **T-1.** Add `ClusterSource` type + `clusterSource?` field to `KubernetesSettings`. — PR #753.
- ✅ **T-2.** Add `clusterSource` enum + `allOf`/`if`/`then` conditional `required` + `x-showIf` on `kubeconfig`/`kubeContext` to the plugin schema. — PRs #753 (schema), #766 (`x-showIf`).
- ✅ **T-3.** `coerceSettings` accepts `clusterSource` only when it's a valid enum value. — PR #753.
- ✅ **T-4.** `validateConnection` short-circuits for platform-managed sources. — PR #753.
- ✅ **T-5.** `getDeploymentSecrets` emits `K8S_CLUSTER_SOURCE`. — PR #753.
- ✅ **T-6.** New `cluster-source-matrix.ts` with `validateClusterSourceForOwner`, `resolveKubeconfigForClusterSource`, `allowedClusterSourcesFor`, `isEverWorksSharedOrg`, `isAdminOnlyOrg`. — PR #753.
- ✅ **T-7.** `DeployService.resolveDeployToken` calls validator + resolver, throws `BadRequestException` on policy violation, `InternalServerErrorException` on missing platform env var. — PRs #753 + #753's review-fix commit.
- ✅ **T-8.** `DeployFacadeService.getTokenFromSettings` emits `PLATFORM_MANAGED_KUBECONFIG_SENTINEL` for k8s + platform-managed sources. — PR #753 review-fix commit.
- ✅ **T-9.** `DeployService.resolveDeployToken` defensively strips the sentinel before validator/resolver. — PR #753 review-fix commit.

### Tests

- ✅ **T-10.** `cluster-source-matrix.spec.ts` — 19 tests: all 9 matrix cells, case-insensitivity, env-var substitution, missing-env failures. — PR #753.
- ✅ **T-11.** Update `deploy.service.spec.ts` — 6 new EW-616 integration tests covering back-compat fall-through, env substitution, validation failures, sentinel-isolation, Vercel pass-through. — PR #753 + review-fix commit.
- ✅ **T-12.** Update `deploy.facade.spec.ts` — 5 sentinel tests. — PR #753 review-fix commit.
- ✅ **T-13.** Update `k8s.plugin.spec.ts` — 3 schema tests: dropdown enum, conditional `required`, `x-showIf` shape. — PRs #753 + #766.
- ✅ **T-14.** Update `facades.module.spec.ts` regression-guard symbol list to include `PLATFORM_MANAGED_KUBECONFIG_SENTINEL`. — PR #753 final commit.

### Infrastructure

- ✅ **T-15.** Push two base64-encoded kubeconfig secrets to `ever-works/ever-works` GitHub repo: `EVER_WORKS_K8S_WORKS_KUBECONFIG_B64`, `EVER_WORKS_K8S_GAUZY_KUBECONFIG_B64`. — Manual ops, recorded in PR #765 description.
- ✅ **T-16.** Wire the two secrets into `deploy-do-{dev,stage,prod}.yml` workflow `env:` blocks. — PR #765.
- ✅ **T-17.** Add `Secret` resource (`ever-works-platform-kubeconfigs[-{dev,stage}]`) to each `.deploy/k8s/k8s-manifest.*.yaml` with `data:` keys + `valueFrom.secretKeyRef` on the API container. — PR #765.

### Release

- ✅ **T-18.** Merge PR #753 to develop; cascade develop→stage (#762) → main (#763) for round-1 (matrix-only).
- ✅ **T-19.** Merge PR #751 (EW-615 secrets) to develop.
- ✅ **T-20.** Merge PR #765 (platform manifests + workflows) to develop.
- ✅ **T-21.** Merge PR #766 (UI `x-showIf`) to develop.
- ✅ **T-22.** Cascade develop→stage (#767) → main (#768) for round-2 (#751 + #765 + #766 bundled).
- ✅ **T-23.** Verify prod deploy: both API pods on `k8s-gauzy` have both env vars mounted via `secretKeyRef`; `ever-works-platform-kubeconfigs` Secret exists with 2021-byte decoded values for both keys.

### Documentation

- ✅ **T-24.** Spec, plan, and tasks docs under `docs/specs/features/k8s-cluster-source-matrix/`. — This PR.
- ✅ **T-25.** Update Workspace runbook `EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md` with: closed gotchas (EW-615/616 follow-up tickets), new behaviour (clusterSource dropdown, matrix enforcement, env-var routing, sentinel), new failure modes. — Companion PR on `ever-works/workspace`.

---

## Out of scope / follow-up tickets

- **T-26.** Replace long-lived platform kubeconfigs with rotated, short-lived service-account tokens. New ticket.
- **T-27.** Per-Work UI filtering: call `allowedClusterSourcesFor(websiteOwner)` to filter the dropdown options when the form is rendered in a Work-scoped context. New ticket.
- **T-28.** RBAC scoping: the platform kubeconfigs are currently full cluster-admin. Scope them to the `ever-works` namespace only. New ticket.
- **T-29.** GHCR auto-link reliability: pin the `org.opencontainers.image.source` label workaround so future template changes don't break auto-link. Workaround documented in the runbook.
