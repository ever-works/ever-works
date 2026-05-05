# Task Breakdown: Kubernetes Deployment Plugin

> Ordered, granular tasks derived from [`./plan.md`](./plan.md). Each task is small enough
> to land in a single PR and ships with tests per Constitution Principle VI.

**Feature ID**: `k8s-deployment`
**Plan**: `./plan.md`
**Spec**: `./spec.md`
**Status**: `Done`
**Last updated**: 2026-05-05

---

## How to use

- Tasks are sequential by default. Tasks marked `(parallel)` can run alongside their predecessor.
- Each task has explicit file paths so an implementer can pick it up cold.
- Test paths follow the existing `__tests__` convention used by `packages/plugins/vercel/`.
- The phase numbering matches `plan.md` §10 phased rollout: each phase is one PR.

---

## Phase 1 — Plugin scaffold + works-config field (PR #1)

> Goal: a discoverable but inert plugin **and** a provider-agnostic `deployProvider` field in
> `works.yml`. The latter is independent of k8s and benefits Vercel immediately.
> Visibility = `'hidden'` until Phase 2 lands.

- [ ] **T1**. Create plugin package skeleton at `packages/plugins/k8s/`:
    - `package.json` mirroring `packages/plugins/vercel/package.json`:
        - `name: '@ever-works/k8s-plugin'`
        - `dependencies: { '@kubernetes/client-node': '^1.0.0', 'js-yaml': '^4.1.0' }`
        - `devDependencies: { '@types/js-yaml': '^4.0.9', /* same as vercel */ }`
        - `everworks.plugin: { id: 'k8s', name: 'Kubernetes', category: 'deployment', capabilities: ['deployment'], builtIn: true, systemPlugin: true, autoEnable: true, visibility: 'hidden', description: 'Deploy works to a Kubernetes cluster' }`
    - `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — copy from vercel.
    - `README.md` — short developer note linking to this spec.

- [ ] **T2** (parallel with T1). Add stub source files:
    - `src/index.ts` — `export { KubernetesPlugin, KubernetesPlugin as default } from './k8s.plugin.js'; export * from './types.js';`
    - `src/types.ts` — `KubernetesSettings`, `RegistryConfig`, `IngressClassDescriptor`, `KubernetesClusterInfo` (per `plan.md` §3 DTOs).
    - `src/k8s.plugin.ts` — `KubernetesPlugin` class with `id/name/category/capabilities/configurationMode/settingsSchema/getManifest()` populated; all `IDeploymentPlugin` methods throw `new Error('Kubernetes plugin: not yet implemented (Phase 2+)')`.
    - `src/errors.ts` — `K8sPluginError` class only (no scrubber yet).

- [ ] **T3**. Run `pnpm install` from repo root to register the new workspace package.
- [ ] **T4**. Confirm plugin discovery:
    - Boot the API locally: `pnpm dev:api`.
    - `curl http://localhost:3100/api/plugins?category=deployment` returns both `vercel` and `k8s` entries.
    - **Test**: `packages/plugins/k8s/src/__tests__/discovery.spec.ts` — instantiates the plugin, asserts manifest matches the snapshot.

- [ ] **T5** (parallel with T4). Plugin metadata test at
      `packages/plugins/k8s/src/__tests__/k8s.plugin.metadata.spec.ts`:
    - `id === 'k8s'`, `name === 'Kubernetes'`, `category === 'deployment'`, `capabilities` contains `'deployment'`.
    - `configurationMode === 'user-required'`.
    - Manifest does NOT include `defaultForCapabilities` (Vercel keeps that role).
    - Settings schema has `kubeconfig` as `x-secret: true`, `x-scope: 'user'`, `x-widget: 'textarea'`.
    - Settings schema has `registry` as a discriminated `oneOf` with three branches; default `{ kind: 'github' }`.
    - Required fields are `['kubeconfig']`.

- [ ] **T6**. Update `docs/plugin-system/built-in-plugins.md` to add the Kubernetes row under **Deployment**. Increment any plugin count in the same doc per Constitution Principle VIII.

### Works-config field (provider-agnostic)

- [ ] **T6a**. Add `deployProvider?: string` to the `WorksConfig` interface/parser at
      `packages/agent/src/works-config/services/works-config.service.ts`.
    - **Test**: `packages/agent/src/works-config/__tests__/works-config.service.spec.ts` — `parses a config with deployProvider: vercel` and `parses a config with deployProvider: k8s` and `rejects an empty deployProvider string`.
- [ ] **T6b**. Wire the field through `WorksConfigImportApplierService` (find by grepping for the existing applier; resolve the deploy facade and validate the value against `getAvailableProviders()`).
    - On valid id → call `WorkLifecycleService.update({ deployProvider })` (lifecycle service already validates against the same list — see `apps/api/.../work-lifecycle.service.ts:184`).
    - On unknown id → emit `import_error` activity-log event with the id and the list of available providers; do NOT touch the work.
    - **Test**: `__tests__/works-config-import-applier.service.spec.ts` — three cases: valid `vercel`, valid `k8s` (with the deploy facade stub returning both), unknown id.
- [ ] **T6c**. Mirror the field in `packages/agent/src/works-config/works-config-data.ts` so projection back to YAML round-trips.
    - **Test**: round-trip `parse → project → parse` preserves `deployProvider`.
- [ ] **T6d** (parallel with T6a). Document the new field in `docs/features/works-config.md` (or its successor) with examples for `vercel` and `k8s`.
- [ ] **T6e**. Activity-log event `deploy_provider_conflict` when `work.deployProvider !== worksConfig.deployProvider` at sync time; data repo wins per FR-18.
    - **Test**: assert the event is emitted with both values.

**Phase 1 DoD**: API boots; plugin appears in `/api/plugins` list; calling any deploy method throws `Not yet implemented`; a `works.yml` with `deployProvider: vercel` already round-trips and applies (no k8s code path involved). Tests T4–T5, T6a–T6c, T6e green. UI shows nothing yet (visibility hidden).

---

## Phase 2 — Settings, connection validation, registry & ingress strategies (PR #2)

> Goal: user can paste a kubeconfig, hit save, see "Connected to cluster X (v1.30.4); detected ingress controllers: nginx, traefik".
> Registry strategy registry shipped (github default, dockerhub, generic).
> Plugin flips to `visibility: 'user-only'` at the end of this phase.

- [ ] **T7**. `kubeconfig.parser.ts`:
    - `parseKubeconfig(yaml: string): { config, currentContext, server, clusterCa, fingerprint }` using `js-yaml.load` with safe schema.
    - Throws `K8sPluginError('INVALID_YAML' | 'MISSING_CONTEXT' | 'MISSING_CLUSTER' | 'MISSING_USER', message)`.
    - Detects `users[].user.exec` and returns a `requiresExecPlugin: true` flag (warn-only).
    - **Test**: `__tests__/kubeconfig.parser.spec.ts`:
        - Valid kubeconfig with `current-context: foo` → returns the expected server URL.
        - Invalid YAML → throws `INVALID_YAML`.
        - Empty contexts → throws `MISSING_CONTEXT`.
        - kubeconfig with `exec` provider → returns `requiresExecPlugin: true`.
        - Fixtures live under `__tests__/fixtures/kubeconfigs/`.

- [ ] **T8**. `errors.ts` scrubber:
    - `scrubError(unknown): { code, message }` with regex passes for kubeconfig YAML, bearer tokens, PEM blocks, registry passwords (passed in via factory).
    - **Test**: `__tests__/errors.spec.ts` — assert each kind of secret is replaced with `[REDACTED]`.

- [ ] **T9**. `k8s-api.service.ts`:
    - `createKubeConfig(yaml): KubeConfig` (loads via `client-node`).
    - `getServerVersion(yaml): Promise<{ version, platform }>` (uses `VersionApi`).
    - `listIngressClasses(yaml): Promise<IngressClassDescriptor[]>` (uses `NetworkingV1Api.listIngressClass()`).
    - `getClusterIdentity(yaml): { name, server, fingerprint }`.
    - All methods catch and run errors through `scrubError`.
    - **Test**: `__tests__/k8s-api.service.spec.ts` — mock `@kubernetes/client-node` (Vitest `vi.mock`), assert success path returns the mapped shape and failure path throws scrubbed errors.

### Registry strategies (provider-pluggable)

- [ ] **T9a**. `registries/provider.ts` — `RegistryProvider` interface (per `plan.md` §5).
- [ ] **T9b**. `registries/provider.registry.ts` — keyed by `RegistryConfig['kind']`; exposes `register(kind, provider)` for extension.
    - **Test**: `__tests__/registries/provider.registry.spec.ts` — registers a fake kind, resolves it back; throws on unknown kind.
- [ ] **T9c**. `registries/github.provider.ts`:
    - `imageBase({ kind: 'github', owner })` → `ghcr.io/<owner>` (owner falls back to `ctx.githubOwner`).
    - `workflowLogin` → `docker login ghcr.io -u $GITHUB_ACTOR --password-stdin` using `GITHUB_TOKEN`.
    - `resolveVisibility(config, ctx)` → if `config.visibility === 'auto'` (default) call `ctx.githubService.getRepository(owner, websiteRepo, token)` (signature already exists at [`packages/plugins/github/src/github.plugin.ts:116`](../../../../packages/plugins/github/src/github.plugin.ts)) and return `'public'` or `'private'` based on `isPrivate`. If `'public'` or `'private'` is set explicitly, return it as-is.
    - `pullSecret(config, ctx)` → returns `null` when resolved visibility is `'public'`. Otherwise uses a stored GitHub token (read via `PluginContext.getService('github')`) scoped for `read:packages`; if unavailable, returns an error and the deploy fails fast with a clear message.
    - **Test**: `__tests__/registries/github.provider.spec.ts` — assertions on the returned image base, login step, and pull-secret payload, plus visibility-resolution matrix:
        - `visibility: 'auto'` × public website repo → no pull secret.
        - `visibility: 'auto'` × private website repo → pull secret with `read:packages` token.
        - `visibility: 'public'` × private website repo → no pull secret (explicit override wins).
        - `visibility: 'private'` × public website repo → pull secret (explicit override wins).
- [ ] **T9d**. `registries/dockerhub.provider.ts`.
    - **Test**: `__tests__/registries/dockerhub.provider.spec.ts`.
- [ ] **T9e**. `registries/generic.provider.ts`.
    - **Test**: `__tests__/registries/generic.provider.spec.ts`.

### Ingress strategies (controller-pluggable)

- [ ] **T9f**. `ingress/strategy.ts` — `IngressStrategy` interface; `ingress/strategy.registry.ts` — keyed by `controller` string; `selectStrategy(controller)` falls back to generic if no match.
    - **Test**: `__tests__/ingress/strategy.registry.spec.ts` — registry lookup, fallback path, custom registration.
- [ ] **T9g**. `ingress/nginx.strategy.ts` — annotations `nginx.ingress.kubernetes.io/proxy-body-size`, `…/ssl-redirect`, etc. as appropriate.
    - **Test**: `__tests__/ingress/nginx.strategy.spec.ts` — snapshot of generated annotations + TLS section.
- [ ] **T9h**. `ingress/traefik.strategy.ts` — annotations `traefik.ingress.kubernetes.io/router.tls`, `…/router.entrypoints`, etc.
    - **Test**: `__tests__/ingress/traefik.strategy.spec.ts`.
- [ ] **T9i**. `ingress/generic.strategy.ts` — no annotations, plain Ingress.
    - **Test**: `__tests__/ingress/generic.strategy.spec.ts`.

### Plugin wiring

- [ ] **T10**. Implement `KubernetesPlugin.validateConnection()`:
    - Returns `{ success: true, message, details: { clusterName, serverUrl, serverVersion, ingressClasses, registryGithubReady } }` on success.
    - Returns `{ success: false, message: '<scrubbed>' }` on failure.
    - When `settings.registry?.kind === 'github'` and the GitHub plugin is missing/unauthenticated → success can be `false` with a "connect GitHub first" message and a `setupLink` to the GitHub plugin's settings.
    - **Test**: `__tests__/k8s.plugin.validate.spec.ts` — five cases: empty kubeconfig, invalid YAML, valid kubeconfig but GHCR + no GitHub, valid kubeconfig with GHCR + connected GitHub, valid kubeconfig with non-GitHub registry kind.

- [ ] **T11**. Implement `KubernetesPlugin.validateToken(token)`:
    - For this plugin, `token` IS the kubeconfig. Returns `true` if `validateConnection` would succeed.

- [ ] **T12**. Flip plugin `visibility: 'user-only'` in `package.json` and `getManifest()`.
- [ ] **T13**. Manual QA against:
    - kind cluster (`kind create cluster`) — happy path.
    - Cluster with expired client cert — error path.
    - Cluster with both nginx and Traefik installed — both controllers appear in `validateConnection.details.ingressClasses`.
- [ ] **T14**. Update spec acceptance criteria "Configure & verify", "Configure & reject", "Ingress detection" to `[x]` after manual QA passes.

**Phase 2 DoD**: visiting `/en/settings/plugins/deployment` shows Kubernetes; pasting a valid kubeconfig saves and shows cluster info + detected ingress controllers; invalid input is rejected gracefully; the registry-form discriminator switches sub-form when the user changes "GitHub" to "Docker Hub". Tests T7–T11 + T9a–T9i green.

---

## Phase 3 — Deploy & status (PR #3)

> Goal: a work with `deployProvider = 'k8s'` deploys end-to-end and reaches `ready`.

- [ ] **T15**. `manifest.renderer.ts` — pure functions:
    - `buildDeployment({ workId, namespace, image, replicas, labels })`
    - `buildService({ workId, namespace, labels })` (port 3000 / containerPort 3000)
    - `buildIngress({ workId, namespace, host, ingressClass?, tlsIssuer? })` — only if `host` provided
    - `buildImagePullSecret({ namespace, registry, username, password })`
    - All return typed `V1Deployment`/`V1Service`/`V1Ingress`/`V1Secret` objects.
    - Labels: `ever-works.io/managed=true`, `ever-works.io/work-id=<id>`, `app.kubernetes.io/name=<work-slug>`.
    - **Test**: `__tests__/manifest.renderer.spec.ts` — snapshot every output for representative inputs; assert label correctness.

- [ ] **T16**. `status.mapper.ts`:
    - `mapDeploymentToStatus(deployment: V1Deployment): DeploymentResult['status']`
    - Mapping table: `Available=True` → `'ready'`; `Progressing=True` (no `Available`) → `'deploying'`; `Available=False, ReplicaFailure=True` → `'error'`; pending pods only → `'building'`.
    - **Test**: `__tests__/status.mapper.spec.ts` — fixture-driven; one fixture per state.

- [ ] **T17**. Add server-side apply helpers to `k8s-api.service.ts`:
    - `apply(kubeconfig, manifest, fieldManager)` using `KubeConfig.makeApiClient(CustomObjectsApi)` PATCH with `application/apply-patch+yaml`.
    - `getDeployment(kubeconfig, namespace, name): Promise<V1Deployment | null>`.
    - `waitForRollout(kubeconfig, namespace, name, timeoutMs): Promise<void>` (polls every 2s).
    - **Test**: integration-style with mocked `@kubernetes/client-node` — assert the right HTTP method/headers/body for SSA.

- [ ] **T18**. Implement `KubernetesPlugin.deploy(config, kubeconfig)`:
    - Resolve registry strategy via `RegistryProviderRegistry.resolve(settings.registry?.kind ?? 'github')` and compute image tag = `${strategy.imageBase(...)}/${slug}:${shortSha}` (sha provided in `config.options.gitSha`).
    - Resolve ingress strategy via `IngressStrategyRegistry.selectStrategy(controllerForClass(settings.ingressClass))`.
    - Order: ensure namespace label → ensure imagePullSecret (from registry strategy, may be null) → SSA Deployment → SSA Service → (if host) SSA Ingress (annotations from ingress strategy).
    - Return `{ id: '<namespace>/<work-id>', status: 'deploying', createdAt }`.
    - On any step failure after Deployment is created, `kubectl rollout undo` is NOT performed (let user keep the rollout history); just return `error`.
    - Activity-log emit: `deployment_started`, `deployment_applied`, `deployment_succeeded` / `deployment_failed`. Each event carries `registryKind` and `ingressController`.
    - **Test**: `__tests__/k8s.plugin.deploy.spec.ts` — happy path with each registry kind × each ingress strategy (matrix), image push failure (no Deployment created), apply failure mid-way (Deployment created, Service fails) — assert correct activity-log calls.

- [ ] **T19**. Implement `KubernetesPlugin.getDeploymentStatus(deploymentId, kubeconfig)`:
    - Parse `<namespace>/<work-id>`; fetch Deployment; map via `status.mapper`.
    - Return `{ id, status, url, createdAt, completedAt? }`. URL = `https://<ingressHost>` if Ingress exists, else `<service-cluster-ip>:3000` placeholder.
    - **Test**: per fixture, asserts the expected status.

- [ ] **T20**. Implement `KubernetesPlugin.listProjects(kubeconfig)`:
    - List Deployments cluster-wide labelled `ever-works.io/managed=true`; group by `ever-works.io/work-id`.
    - Return `DeploymentProject[]`.
    - **Test**: mocked listing returns 3 deployments → 3 projects.

- [ ] **T21**. Implement `KubernetesPlugin.lookupExistingDeployment(projectName, kubeconfig)`:
    - Find Deployment by label `app.kubernetes.io/name=<projectName>`.
    - Return `{ found, website?, deploymentState?, projectId? }`.
    - **Test**: covers found and not-found.

- [ ] **T22**. Implement `KubernetesPlugin.getTeams(kubeconfig)` returning `[]` (k8s has no teams concept). Test.
- [ ] **T23**. Add `deploy_k8s.yaml` workflow + `Dockerfile` + `k8s/manifests/` placeholder to **`directory-web-template`** repo:
    - This is a separate repo (`ever-works/directory-web-template`); coordinate the PR.
    - Workflow: `docker/build-push-action@v6` → `azure/setup-kubectl@v4` → `kubectl apply -k k8s/`.
    - Inputs: `environment`, `image_tag`, `namespace`, `ingress_host?`, `registry_kind`.
    - Secrets read: `KUBECONFIG`; **registry-kind-conditional** secrets — `GITHUB_TOKEN` (auto, for GHCR), or `REGISTRY_USERNAME` + `REGISTRY_PASSWORD` (for dockerhub/generic), or `REGISTRY_SERVER` (generic only).
    - The workflow's `docker login` step is generated from the registry strategy's `workflowLogin()` output (T9c–T9e); same for the cluster pull-secret apply step.
- [ ] **T24** (parallel with T23). Same for `directory-web-minimal-template`.

### Capability contract extension (provider-agnostic)

- [ ] **T24a**. Extend `IDeploymentPlugin` at
      `packages/plugin/src/contracts/capabilities/deployment.interface.ts` with two OPTIONAL methods:
    - `getWorkflowFilenames?(): string[]` — workflow files to dispatch, in priority order.
    - `getDeploymentSecrets?(settings: Record<string, unknown>): Promise<Record<string, string>>` — extra secrets to push to the website repo before dispatch.
    - Both default to existing behaviour when unimplemented.
    - **Test**: `packages/plugin/src/contracts/__tests__/deployment.interface.spec.ts` — type-level test that an existing plugin without these methods still satisfies the interface.

- [ ] **T24b**. Implement both methods on the **Vercel** plugin to preserve today's behaviour exactly:
    - `getWorkflowFilenames()` → `['deploy_vercel.yaml', 'deploy_prod.yaml']`.
    - `getDeploymentSecrets()` → `{}` (Vercel needs no extras beyond what `setRequiredSecrets` already pushes).
    - **Test**: `packages/plugins/vercel/src/__tests__/vercel.plugin.deployment-secrets.spec.ts`.

- [ ] **T24c**. Implement both methods on the **Kubernetes** plugin:
    - `getWorkflowFilenames()` → `['deploy_k8s.yaml']`.
    - `getDeploymentSecrets(settings)` → registry-kind-conditional + ingress vars:
        - `github` → `{ K8S_REGISTRY_KIND: 'github', K8S_REGISTRY_OWNER: <owner> }` (the workflow's auto-injected `GITHUB_TOKEN` handles auth).
        - `dockerhub` → `{ K8S_REGISTRY_KIND: 'dockerhub', REGISTRY_USERNAME, REGISTRY_PASSWORD }`.
        - `generic` → `{ K8S_REGISTRY_KIND: 'generic', REGISTRY_SERVER, REGISTRY_USERNAME, REGISTRY_PASSWORD }`.
        - Always: `K8S_NAMESPACE`, `K8S_INGRESS_CLASS?`, `K8S_INGRESS_HOST?`, `K8S_TLS_ISSUER?`, `K8S_REPLICAS?`.
    - **Test**: `__tests__/k8s.plugin.deployment-secrets.spec.ts` covering each registry kind and asserting no kubeconfig substring appears in any returned secret value.

- [ ] **T25**. Update `apps/api/src/plugins-capabilities/deploy/deploy.service.ts`:
    - Replace the hardcoded `workflowFilesToTry` (line 249) with `plugin.getWorkflowFilenames?.() ?? ['deploy_prod.yaml']`. The plugin reference comes from the existing `DeployFacadeService.resolvePluginAndTokenWithWork` call.
    - In `setRequiredSecrets` (line 204), after the existing block, call `plugin.getDeploymentSecrets?.(settings) ?? {}` and push each `[key, value]` via `setSecret`.
    - Confirm `setSecret(ctx, '<PROVIDER>_TOKEN', deployToken)` (line 217) already covers k8s — it pushes `K8S_TOKEN = kubeconfig`. No change needed there.
    - **Test**: `apps/api/test/deploy.service.spec.ts` — Vercel and Kubernetes flows both go through the same code path; no `if (provider === 'k8s')` branches; assert the dispatch payload for each registry kind, and confirm no kubeconfig contents appear in any GHA secret value (string-search for `apiVersion: v1\nkind: Config`).
- [ ] **T26**. e2e test against `kind` in CI:
    - GitHub Actions matrix job creates a kind cluster, deploys a fixture work via the platform API, polls `getDeploymentStatus` until `ready`, asserts the pod responds 200 on the service.
    - Matrix dimensions: `registry: [github (via local registry stub), generic]` × `ingress: [nginx, traefik]`.
    - Located under `apps/api/test/deploy-k8s.e2e-spec.ts` plus a `.github/workflows/e2e-k8s.yaml` runner.

**Phase 3 DoD**: end-to-end deploy of a fixture work to kind succeeds in CI for the `github`/`nginx` matrix cell at minimum; redeploy is a rolling update; failure paths surface scrubbed errors. Tests T15–T22, T25, T26 green.

---

## Phase 4 — Custom domains (PR #4)

> Goal: domain CRUD via the existing Settings → Domains UI works on k8s-deployed works.

- [ ] **T27**. `domain.handler.ts`:
    - `addDomainToIngress(api, namespace, workId, domain, tlsIssuer?)` — read Ingress, append a rule, append a `tls.hosts` entry, SSA back.
    - `removeDomainFromIngress(api, namespace, workId, domain)`.
    - `verifyDomainResolution(domain, expectedTarget)` — DNS lookup; checks CNAME or A points to the cluster's ingress LB.
    - **Test**: `__tests__/domain.handler.spec.ts` — covers add to fresh ingress, add as additional host, remove leaves last host intact, verify success/failure.

- [ ] **T28**. Implement `KubernetesPlugin.addDomain/removeDomain/verifyDomain` wiring T27 outputs into `AddDomainResult` / `DeploymentDomain` shapes.
    - `verification`: `{ type: 'CNAME', name: '<domain>', value: '<ingressLbHost>' }` for subdomains; `A` record for apex.
- [ ] **T29**. Implement `KubernetesPlugin.getDomains(projectId, kubeconfig)` reading the Ingress hosts.
- [ ] **T30**. e2e test in CI extending T26 cluster: add a domain, assert Ingress rule appears, remove it, assert removal.
- [ ] **T31**. Update spec acceptance criterion "Custom domains" + "Provider switch" to `[x]`.

**Phase 4 DoD**: Settings → Domains UI works for k8s works; switching a work from Vercel to k8s preserves domain rows.

---

## Phase 5 — Workflow YAML in templates (PR #5 in template repos)

> Goal: the template repos ship the deploy workflow + Dockerfile + manifests.

- [ ] **T32**. PR to `ever-works/directory-web-template`:
    - `.github/workflows/deploy_k8s.yaml`
    - `Dockerfile` (multi-stage Next.js build → distroless runtime)
    - `k8s/kustomization.yaml`, `k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/ingress.yaml.tpl`
- [ ] **T33**. Same PR to `ever-works/directory-web-minimal-template`.
- [ ] **T34**. Smoke test the resulting workflow against a kind cluster reachable from the runner (use an `actions/setup-kind` step).

---

## Phase 6 — Docs & default-on (PR #6)

- [x] **T35**. User-facing doc at `docs/features/k8s-deployment.md` (shipped together with the spec/plan in this same PR); cross-linked from `apps/docs/sidebarsPlatform.ts`. (No separate `docs/features/index.md` exists; the sidebar is the index.)
- [x] **T36**. K8s row added to `docs/plugin-system/built-in-plugins.md` (covered by T6 in Phase 1).
- [ ] **T37**. Update spec status to `Implemented`; mark plan and tasks `Done`. _(Pending Phase 5 template-repo PRs landing.)_
- [ ] **T38**. Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from repo root and confirm green.
- [ ] **T39**. Cut a release note to `apps/docs/changelog/` (or wherever existing release notes live).

---

## Phase 7 — Tests coverage matrix

> Each functional requirement in `spec.md` §3 must map to at least one passing test.
> Tick when the test exists and is in CI.

| FR                                      | Test file(s)                                                                                                        | Description                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| FR-1 (plugin discovery)                 | `discovery.spec.ts`, `k8s.plugin.metadata.spec.ts`                                                                  | Plugin appears in `/api/plugins`, has correct metadata.                                    |
| FR-2 (settings schema)                  | `k8s.plugin.metadata.spec.ts`                                                                                       | Required fields, secret + scope + widget hints.                                            |
| FR-3 (validate on save)                 | `k8s.plugin.validate.spec.ts`                                                                                       | Save flow rejects unreachable cluster.                                                     |
| FR-4 (auto UI discovery)                | Playwright e2e under `apps/web/e2e/plugins-deployment.spec.ts`                                                      | Both Vercel and Kubernetes cards render on `/en/settings/plugins/deployment`.              |
| FR-5 (end-to-end deploy)                | `deploy-k8s.e2e-spec.ts`                                                                                            | Kind cluster, fixture work, deploys to ready.                                              |
| FR-6 (image build & apply order)        | `k8s.plugin.deploy.spec.ts`                                                                                         | Manifest application order asserted via mock.                                              |
| FR-7 (rolling update)                   | `deploy-k8s.e2e-spec.ts` (rollback test)                                                                            | Second deploy preserves rollout history.                                                   |
| FR-8 (domain CRUD)                      | `domain.handler.spec.ts`, `deploy-k8s.e2e-spec.ts`                                                                  | Ingress patches; DNS guidance returned.                                                    |
| FR-9 (status mapping)                   | `status.mapper.spec.ts`                                                                                             | Each rollout state mapped correctly.                                                       |
| FR-10 (secret hygiene)                  | `errors.spec.ts`, `k8s.plugin.deploy.spec.ts`                                                                       | scrubError covers each leak; deploy errors never include kubeconfig substring.             |
| FR-11 (not default)                     | `k8s.plugin.metadata.spec.ts`                                                                                       | Manifest excludes `defaultForCapabilities`.                                                |
| FR-12 (cluster info on success)         | `k8s.plugin.validate.spec.ts`                                                                                       | Details object includes name, server URL, version.                                         |
| FR-13 (registry abstraction)            | `registries/*.spec.ts`, `provider.registry.spec.ts`                                                                 | Each kind builds the right image base, login, pull secret.                                 |
| FR-14 (GHCR via GitHub plugin)          | `registries/github.provider.spec.ts`, `k8s.plugin.validate.spec.ts`                                                 | Uses GitHub plugin context; "connect GitHub first" path.                                   |
| FR-15 (ingress detection)               | `k8s-api.service.spec.ts`, `k8s.plugin.validate.spec.ts`                                                            | `listIngressClasses` populates `details.ingressClasses` with `hasStrategy`.                |
| FR-16 (ingress strategies)              | `ingress/*.spec.ts`, `strategy.registry.spec.ts`                                                                    | Snapshot annotations per controller; generic fallback.                                     |
| FR-17 (works-config field)              | `works-config.service.spec.ts`, `works-config-import-applier.service.spec.ts`                                       | Parses `deployProvider`; applies it via lifecycle service; rejects unknown ids.            |
| FR-18 (data-repo wins)                  | `works-config-sync.listener.spec.ts` (or applier spec)                                                              | Conflict event emitted; data repo value applied.                                           |
| FR-19 (provider-agnostic plumbing)      | works-config tests, `deploy.service.spec.ts`                                                                        | Vercel and k8s both pass through the same code path with no plugin-specific branches.      |
| FR-20 (visibility mirrors website repo) | `registries/github.provider.spec.ts`, `deploy-k8s.e2e-spec.ts`                                                      | `auto` resolves to public/private based on `isPrivate`; both branches covered.             |
| FR-21 (pull secret iff private)         | `registries/github.provider.spec.ts`, `manifest.renderer.spec.ts`                                                   | Public → Deployment has no `imagePullSecrets`; private → Deployment references the secret. |
| FR-22 (settings persistence)            | `k8s.plugin.metadata.spec.ts`, manual: `GET /api/plugins/k8s/settings` returns no secrets                           | Settings live in `plugin_settings` (no new table).                                         |
| FR-23 (one cluster per user)            | `k8s.plugin.deploy.spec.ts`                                                                                         | Two works, same user, both use the same kubeconfig from plugin settings.                   |
| FR-24 (no caching in v1)                | `k8s-api.service.spec.ts`                                                                                           | `listIngressClasses` is called on every `validateConnection` invocation.                   |
| Capability contract additive            | `deployment.interface.spec.ts`, `vercel.plugin.deployment-secrets.spec.ts`, `k8s.plugin.deployment-secrets.spec.ts` | Existing plugins without the new optional methods still type-check and run.                |

### Test infrastructure

- **Unit**: Vitest in `packages/plugins/k8s/`; `@kubernetes/client-node` mocked with `vi.mock`.
- **Integration**: a `kind` cluster spun up in a GitHub Actions job (`engineerd/setup-kind`); image registry = local `registry:2` container reachable from the kind node.
- **e2e API**: NestJS Supertest; uses the same kind cluster; covers `POST /api/deploy/works/:id` for a `deployProvider = 'k8s'` work.
- **Web e2e**: Playwright spec under `apps/web/e2e/`; loads `/en/settings/plugins/deployment` against a seeded user with both Vercel and k8s plugins discoverable.
- **Coverage target**: ≥ 90% line coverage in `packages/plugins/k8s/`; reported via `pnpm --filter @ever-works/k8s-plugin test:coverage`.

---

## Definition of Done

- [ ] All checkboxes above ticked.
- [ ] All Phase 7 tests green in CI on Linux + Windows runners.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm type-check` green.
- [ ] `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- [ ] Constitution gates in [`./spec.md`](./spec.md) §9 all confirmed satisfied.
- [ ] Spec status flipped to `Implemented`; this file's status flipped to `Done`.
- [ ] User-facing doc linked from sidebar.
- [ ] At least one real-cluster smoke test logged in the PR (e.g. screenshot of a deployed fixture work on kind, k3d, or EKS).
