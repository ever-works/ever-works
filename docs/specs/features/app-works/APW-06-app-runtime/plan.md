# Implementation Plan: App runtime on Kubernetes

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail;
> the spec owns behaviour. **Every path below was opened in the worktree before it was written down**; paths
> marked _(new)_ do not exist yet.

**Epic ID**: `APW-06-app-runtime`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Contracts**: [`../CONTRACTS.md`](../CONTRACTS.md) — names below marked **C** are binding there.

> **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))
> binding on this plan: **R-1** shared types in `packages/contracts/src/apps/` (§5.3); **R-2** Activity `actionType`
> families `app_deploy`, `app_job`, `app_smoke`, `app_health` (§9.4); **R-3** no `licenseAttestation` here — eligibility
> is read from APW-03's `AppLicenseService.getHostingEligibility` (§5.2, §7.2); **R-5** on Ever Works Apps the platform
> renders and hands desired state to APW-10's `apps-tier` deployment plugin and never applies workloads; managed work
> calls `AppsTierPolicy` (§2.1, §5.6, §9.6); **R-10** `AppRenderInput.purpose: 'verification'` (§3, §4.12); **R-12**
> target value `none`, label "None — don't deploy yet" (§7.2, §10); **R-15** deleting an App Work (§9.7); **R-16** the
> managed subdomain on Your cluster in Wave 1 (§8.1, §8.3); **R-22** no `apps/api/test/` suites (§12); **R-24** Ever Works
> Apps requires the tier's sandboxed runtime from Wave 2 (§5.1).

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer         | File                                                                                                                                                                                                                                                                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract      | [`packages/plugin/src/contracts/capabilities/deployment.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/deployment.interface.ts)                                                                                                                                                                                                  | `IDeploymentPlugin` (`deploy`, `getDeploymentStatus`, domain ops, `getWorkflowFilenames?`, `getDeploymentSecrets?`), `DeploymentLookupContext` (work-scoped `settingsOverride`, `namespaceOverride`, `kubeContextOverride`). No App members.                                                                                                                                            |
| Plugin        | [`packages/plugins/k8s/src/k8s.plugin.ts`](../../../../../packages/plugins/k8s/src/k8s.plugin.ts)                                                                                                                                                                                                                                                          | Singleton with an **unscoped** `PluginContext` — Work settings arrive only via `settingsOverride`. `deploy()` builds `image = <registry base>/<imageName>:<gitSha truncated to 12>`, ensures the namespace, applies pull Secret → runtime-env Secret → Deployment → Service → Ingress, returns `deploying` and reports failures as `status: 'error'`. `CONTAINER_PORT = 3000` is fixed. |
| Renderer      | [`packages/plugins/k8s/src/manifest.renderer.ts`](../../../../../packages/plugins/k8s/src/manifest.renderer.ts)                                                                                                                                                                                                                                            | `buildDeployment` / `buildService` / `buildIngress` / `buildRuntimeEnvSecret` / `buildImagePullSecret`. One container `app`, selector `app.kubernetes.io/name: <slug>`, probes on `/` and `/api/health`, `FIELD_MANAGER = 'ever-works-k8s-plugin'`. Its pod and container defaults are chosen for platform-generated sites; App defaults for user-controlled code are defined in §4.4.  |
| API wrapper   | [`packages/plugins/k8s/src/k8s-api.service.ts`](../../../../../packages/plugins/k8s/src/k8s-api.service.ts)                                                                                                                                                                                                                                                | SSA through `KubernetesObjectApi.patch(..., force=true, 'application/apply-patch+yaml')` — **kind-agnostic**. Reads: namespace, Deployment, Ingress, IngressClasses, Nodes. `listManagedDeployments` selects `ever-works.io/managed=true` across all namespaces. No delete, scale, Job, CronJob, PVC, NetworkPolicy, logs, ReplicaSet or access-review calls.                           |
| Status        | [`packages/plugins/k8s/src/status.mapper.ts`](../../../../../packages/plugins/k8s/src/status.mapper.ts)                                                                                                                                                                                                                                                    | `mapDeploymentToStatus`: `Available=True → ready`. `isRolloutComplete` exists but has no production caller and is not the predicate App rollouts need (§5.4).                                                                                                                                                                                                                           |
| Kubeconfig    | [`packages/plugins/k8s/src/kubeconfig.parser.ts`](../../../../../packages/plugins/k8s/src/kubeconfig.parser.ts)                                                                                                                                                                                                                                            | Validates context/cluster/user presence, reports `requiresExecPlugin`, fingerprints `server + CA`. It checks structure; the stricter rules App Works apply to a kubeconfig pasted for user-controlled code live in the App guard (§6.1).                                                                                                                                                |
| Registries    | [`packages/plugins/k8s/src/registries/github.provider.ts`](../../../../../packages/plugins/k8s/src/registries/github.provider.ts)                                                                                                                                                                                                                          | `imageBase`, `resolveVisibility` (`auto` → mirrors the website repo), `pullSecretCredentials` (password injected by caller).                                                                                                                                                                                                                                                            |
| Ingress       | [`packages/plugins/k8s/src/ingress/strategy.ts`](../../../../../packages/plugins/k8s/src/ingress/strategy.ts), [`domain.handler.ts`](../../../../../packages/plugins/k8s/src/domain.handler.ts)                                                                                                                                                            | Strategy registry (nginx, traefik, generic) for annotations + TLS; `buildDnsGuidance` (A for two-label hosts, CNAME otherwise); `verifyDomainResolution` against the LB target.                                                                                                                                                                                                         |
| Orchestrator  | [`apps/api/src/plugins-capabilities/deploy/deploy.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.service.ts)                                                                                                                                                                                                                  | `deploy()` refuses `repo` first, then always does website-repo work (enable workflows, push Actions secrets, cron/webhook secrets), creates a `WorkDeployment`, and either calls `deployServerSideManaged` (managed clusters only) or dispatches a workflow. **Synchronous inside the HTTP request.**                                                                                   |
| Orchestrator  | same — `deployServerSideManaged`, `collectServerSideRuntimeEnv`, `resolveGhcrReadToken`, `mergeCustomDomainHosts`                                                                                                                                                                                                                                          | Image tag is the **branch alias** (`prod`/`dev`/…), `revision` only an annotation. Runtime env and the pull credential are assembled for platform-generated sites, which need platform and Git credentials. `mergeCustomDomainHosts` merges stored domain rows into the Ingress host list for those sites.                                                                              |
| Matrix        | [`packages/agent/src/facades/deployment-context.resolver.ts`](../../../../../packages/agent/src/facades/deployment-context.resolver.ts), [`apps/api/.../cluster-source-matrix.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.ts)                                                                                       | `resolveEffectiveDeploymentContext`: `custom-kubeconfig` honours the user's single plugin-level `namespace` (default `ever-works`); shared/managed sources get **one namespace per owner user** (`{base}-{userId}`); `isReservedDeployNamespace`; `validateClusterSourceForOwner` keyed on the website owner.                                                                           |
| Verifier      | [`apps/api/.../tasks/deployment-verifier.service.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/tasks/deployment-verifier.service.ts)                                                                                                                                                                                                        | In-process `setInterval` (10 s, 13 min), keyed by `work.getWebsiteRepo()`; lost on restart; terminal events `DeploymentCompletedEvent` / `DeploymentFailedEvent`.                                                                                                                                                                                                                       |
| Controller    | [`apps/api/.../deploy.controller.ts`](../../../../../apps/api/src/plugins-capabilities/deploy/deploy.controller.ts)                                                                                                                                                                                                                                        | `POST /api/deploy/works/:id` (200, synchronous), `GET /works/:id/deployments` (limit 50), `POST /works/:id/rollback` (re-deploys `branch` + `commitSha` → for the server-side path that is the same alias image), domains, `GET/PUT /works/:id/subdomain`.                                                                                                                              |
| Subdomains    | [`packages/agent/src/ever-works-providers/subdomain-allocator.service.ts`](../../../../../packages/agent/src/ever-works-providers/subdomain-allocator.service.ts)                                                                                                                                                                                          | `allocate(work, dnsOps?)`: reuse `work.managedSubdomain`, else slug → probe DB + `recordExists` → `-<4 hex>` suffixes, 5 tries; root domain from `dnsOps.rootDomain()` or `EVER_WORKS_DOMAIN`. Global unique index on the label.                                                                                                                                                        |
| DNS           | [`packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts`](../../../../../packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts), [`packages/plugin/.../dns.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/dns.interface.ts)                                                                            | `CloudflareDnsProvider(config)` implements `IDnsOperations` (`ensureRecord`, `removeRecord`, `recordExists`, `rootDomain`); `EverWorksDnsService` builds one from `CLOUDFLARE_*` + `EVER_WORKS_DOMAIN`.                                                                                                                                                                                 |
| Quota         | [`packages/agent/src/ever-works-providers/ever-works-deploy-quota.service.ts`](../../../../../packages/agent/src/ever-works-providers/ever-works-deploy-quota.service.ts)                                                                                                                                                                                  | Counter behind a DI token; fails **closed** when the feature is on and the counter is missing.                                                                                                                                                                                                                                                                                          |
| Entity        | [`packages/agent/src/entities/work-deployment.entity.ts`](../../../../../packages/agent/src/entities/work-deployment.entity.ts)                                                                                                                                                                                                                            | `state` varchar (`INITIALIZING`…`READY`/`ERROR`/`CANCELED`/`TIMEOUT`), `environment` production/preview, `prNumber`, `providerProjectId`, `providerDeploymentId`, `commitSha`, `lastError`, scope columns. `isTerminal()` hard-codes four states.                                                                                                                                       |
| Notifications | [`packages/agent/src/notifications/core-event-catalogue.ts`](../../../../../packages/agent/src/notifications/core-event-catalogue.ts), [`notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts)                                                                                                                | Snake-case event keys upserted on boot; `event-registry-coverage.spec.ts` fails on an unregistered producer key; `create(dto)` with `deduplicationKey`, `eventKey`, `isPersistent`.                                                                                                                                                                                                     |
| Activity      | [`apps/api/src/activity-log/activity-log.listener.ts`](../../../../../apps/api/src/activity-log/activity-log.listener.ts), [`packages/agent/src/events/deployment.events.ts`](../../../../../packages/agent/src/events/deployment.events.ts)                                                                                                               | `@OnEvent` → `ActivityLogService.log({ actionType: DEPLOYMENT, action, status, summary, details })`.                                                                                                                                                                                                                                                                                    |
| Jobs          | [`packages/agent/src/tasks/_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts), [`work-import-dispatcher.ts`](../../../../../packages/agent/src/tasks/work-import-dispatcher.ts), [`packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`](../../../../../packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts) | `*_DISPATCHER` symbol + interface; symbol names pinned in `TASKS_BARREL_RUNTIME_SYMBOLS`; scheduled tasks use `schedules.task` + `NestFactory.createApplicationContext(TriggerInternalModule)`.                                                                                                                                                                                         |
| Web           | [`apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx>)                                                                                                                                                                                                    | **Redirects to Overview when `!work.websiteRepositoryInitialized && !work.website`** — an App Work would never see its Deploy tab. Renders `DeployForm`, `SubdomainManagement`, `DomainManagement`, `RuntimeEnvManagement`, `DeployProgressPanel`.                                                                                                                                      |
| Web           | [`apps/web/src/lib/api/plugins-capabilities/deploy.ts`](../../../../../apps/web/src/lib/api/plugins-capabilities/deploy.ts), [`apps/web/src/app/api/works/[id]/deploy/status/route.ts`](../../../../../apps/web/src/app/api/works/[id]/deploy/status/route.ts)                                                                                             | `server-only` client; a BFF status route polled every 3 s by `DeployProgressPanel`, authenticated from the cookie.                                                                                                                                                                                                                                                                      |
| e2e           | [`packages/plugins/k8s/src/__tests__/e2e/cluster.e2e.spec.ts`](../../../../../packages/plugins/k8s/src/__tests__/e2e/cluster.e2e.spec.ts), [`vitest.e2e.config.ts`](../../../../../packages/plugins/k8s/vitest.e2e.config.ts)                                                                                                                              | kind + ingress-nginx, `KUBECONFIG_E2E_PATH`, serial, 60 s default timeouts. kind's default network plugin does **not** enforce NetworkPolicy.                                                                                                                                                                                                                                           |

### 1.2 What makes the App renderer harder than it looks

1. **Nothing in the website path is reusable end to end.** `DeployService.deploy()` performs website-repo side
   effects before it knows the provider path; App Works have no website repository. The App path must branch
   **before** line one of that work, exactly where the `repo` refusal sits, and delegate.
2. **Wrong "ready".** `Available=True` stays true while a broken new ReplicaSet crash-loops behind a healthy old
   one. The App path needs its own rollout predicate that also compares generations and updated replicas (§5.4).
3. **Image identity.** The plugin cannot address a digest (`sanitiseDockerTag` strips `@`, the tag is
   truncated to 12 chars) and the server-side path deploys a mutable alias, so today's rollback redeploys the
   same image. The App path takes a digest-pinned reference from `WorkBuild` and never builds a tag.
4. **Secrets that must not reach user code.** `collectServerSideRuntimeEnv` and `resolveGhcrReadToken` assemble
   env and pull credentials for platform-generated sites, which legitimately need platform and Git credentials.
   User-controlled code must receive neither, so neither may be called for kind `app`.
5. **Namespaces.** Custom clusters share one plugin-level namespace per user; managed clusters one per owner.
   The App path needs one per App Work, persisted, and cannot take it from plugin settings.
6. **Selectors are immutable and labels leak into old listings.** Reusing `app.kubernetes.io/name` or
   `ever-works.io/managed=true` would make App components appear in `listProjects` /
   `listManagedDeployments`. App objects use a disjoint label set (§4.1) so those return exactly what they
   return today.
7. **Who dials the cluster.** Today plugin calls run in the API process. App Works require every cluster call
   to run in an isolated worker (spec FR-5), so status reads and logs become jobs with cached results, and
   the API never holds an App Work kubeconfig in memory.
8. **The verifier is in-memory and keyed by website repo.** The App path does not use it; `app-deploy` is a
   durable job that owns its own waiting.
9. **Domains patch the live Ingress by website repo name.** `DeployFacadeService.addDomain/removeDomain` call
   the plugin with a project id derived from the website repo; App Works need an App branch that stores the
   row and reconciles published hosts through the worker.
10. **Minimum permissions on user clusters.** The documented service-account recipe binds `edit` in a single
    namespace. `edit` cannot create namespaces, `LimitRange` or `ResourceQuota`. The connection check must
    report this precisely, and the App path must support a pre-created namespace (§6.3).

### 1.3 Reused, not rebuilt

- SSA mechanics and `FIELD_MANAGER` (`k8s-api.service.ts`), the ingress strategy registry, `buildDnsGuidance`,
  `verifyDomainResolution`, `normaliseIngressHost`-equivalent validation, `hashRuntimeEnv`'s canonical form.
- `SubdomainAllocator.allocate(work, dnsOps)` with an apps-domain `IDnsOperations` (its `rootDomain()` wins).
- `CloudflareDnsProvider` constructed with apps-zone configuration, mirroring `EverWorksDnsService`.
- `validateClusterSourceForOwner` (keyed on the **Work Repository** owner) and `isReservedDeployNamespace`.
- `WorkDeployment` rows, `GET /api/deploy/works/:id/deployments`, custom-domain rows and routes.
- `NotificationService.create` + the core event catalogue; `ActivityLogService` via events.
- The quota pattern of `EverWorksDeployQuotaService` (fail closed).

---

## 2. Architecture

### 2.1 Pieces and seams

```
 apps/web ── Deploy tab (App branch), Overview health card ── server actions ──┐
                                                                                ▼
 apps/api  AppRuntimeController  (/api/works/:id/deploy | app-status | app-jobs | app-rollback |
           app-lifecycle | app-logs | app-target)   DeployService/DeployController: kind app → delegate
                │ 202 only; never dials a cluster
                ▼
 packages/agent  app-runtime/  AppDeployRequestService (preconditions, locks, queue) ── ports:
                │                AppsTierPolicy (APW-10) · AppImagePullCredentialSource (APW-05)
                │                AppRuntimeEnvSource (APW-07) · WorkAppSpecState/WorkBuild reads
                │  *_DISPATCHER
                ▼
 packages/tasks  app-deploy · app-smoke · app-cluster-op · app-health-poll · app-preview-gc
                │  queue "app-cluster-io"  — runs only on the isolated worker (§6.2)
                ▼
 AppRuntimeFacadeService ──► your-cluster:    IDeploymentPlugin (supportsApps) = packages/plugins/k8s  src/app/*
                         │                     deployApp · getAppStatus · runAppJob · scaleApp · getAppLogs ·
                         │                     checkAppCluster · destroyApp
                         └► ever-works-apps: IDeploymentPlugin (supportsApps) that also declares `apps-tier`
                                               (APW-10's plugin) — deployApp writes desired state (a `Work`
                                               resource) into the tier's control namespace; the zone renders it
                                               with this epic's pure renderer + non-overridable overlays (R-5)
```

- **Plugin-first (Constitution I–II).** Everything that speaks Kubernetes lives in the `k8s` plugin under a new
  `src/app/` folder. Core resolves the plugin through `AppRuntimeFacadeService` by capability, never by id: for
  `your-cluster` the deployment plugin with `supportsApps === true` for the Work's `deployProvider` that does **not**
  declare `apps-tier`; for `ever-works-apps` the enabled deployment plugin with `supportsApps === true` **and** the
  `apps-tier` capability, only while `AppsTierPolicy.isOpen()` (Resolution R-5 — no read of
  `EVER_WORKS_APPS_MANAGED_ENABLED` anywhere in this epic).
- **Renderer as a library (R-5).** `src/app/` renderer files are pure and exported from the `k8s` plugin package entry
  (`packages/plugins/k8s/src/index.ts` → `renderAppManifests`, `validateRenderInput`, name/label helpers) so APW-10's
  in-zone controller renders the same objects; the platform never sends rendered manifests to the tier.
- **Ports for parallel epics.** APW-06 owns three small interfaces in
  `packages/agent/src/app-runtime/ports.ts` _(new)_; APW-05, APW-07 and APW-10 implement them. Until an
  implementation is bound, the default binding refuses with a named precondition (`env_source_unavailable`,
  …) so nothing silently deploys half-configured.

### 2.2 Request flow — Deploy

1. `POST /api/works/:id/deploy { buildId?, confirmClusterChange? }` → `WorkOwnershipService.ensureCanEdit`.
2. `AppDeployRequestService.request()` evaluates preconditions that need no cluster (§5.1). Unmet → `422
{ code: 'APP_DEPLOY_PRECONDITIONS', unmet: AppPrecondition[] }`.
3. Atomic claim on `work_app_runtime_states`:
   `UPDATE … SET "deployLockId" = :id, "deployLockedAt" = now() WHERE "workId" = :w AND "deployLockId" IS NULL`.
   0 rows → manual: `409 { code: 'APP_DEPLOY_IN_PROGRESS', deploymentId }`; Build-triggered: write
   `queuedBuildId` (replacing and marking any previous queued row `SUPERSEDED`).
4. Create `WorkDeployment { state: 'INITIALIZING', provider: plugin.id, buildId, appTarget, … }`.
5. `APP_DEPLOY_DISPATCHER.dispatchAppDeploy({ workId, deploymentId, … })` → `202 { deploymentId }` (≤ 2 s).
6. Worker `app-deploy` (§5) → plugin `deployApp(input, credential, hooks)` → hooks persist phases, run public
   smoke, check cancellation → terminal state, events, notification, lock release, dequeue.

### 2.3 Request flow — status, logs, lifecycle

`GET app-status` reads `work_app_runtime_states.statusSnapshot` only. `POST app-status/refresh`,
`POST app-logs`, `POST app-lifecycle`, `POST app-jobs/:name/run`, `POST app-target/check` dispatch
`app-cluster-op` with an `op` discriminator and return `202 { requestId }`; results land in the runtime-state
row (status, lifecycle, check) or in the cache (logs, 300 s) and are polled by the web client.

---

## 3. Plugin contract additions

`packages/plugin/src/contracts/capabilities/app-deployment.types.ts` _(new)_, re-exported from the capabilities
barrel. All members are **optional** on `IDeploymentPlugin` (Constitution X — Vercel and third-party plugins
compile unchanged). Names marked **C**.

```ts
export type AppDeployTarget = 'your-cluster' | 'ever-works-apps';
export type AppDeployPhase =
	| 'prepare'
	| 'pre-deploy-jobs'
	| 'rollout'
	| 'first-deploy-jobs'
	| 'in-cluster-smoke'
	| 'publish'
	| 'public-smoke'
	| 'post-deploy-jobs'
	| 'cron'
	| 'rollback'
	| 'done';

export interface AppTargetRef {
	workId: string;
	namespace: string;
	target: AppDeployTarget;
	kubeContext?: string | null;
	clusterFingerprint?: string;
}

export interface AppRenderInput {
	ref: AppTargetRef;
	/** R-10: 'verification' = per-attempt namespace for APW-04 (§4.12); default 'deploy'. */
	purpose?: 'deploy' | 'verification';
	/** Required when purpose = 'verification'; written as the namespace's expiry annotation. */
	ttlMinutes?: number;
	workSlug: string;
	deploymentId: string;
	deploymentShort: string; // 8 hex
	specCommitSha: string;
	isFirstDeploymentOnCluster: boolean;
	skipPreDeployJobs: boolean;
	image: { reference: string /* …@sha256:<64 hex> */; pull?: { server: string; username: string; password: string } };
	components: AppComponentInput[];
	jobs: AppJobInput[];
	cron: AppCronInput[];
	smoke: AppSmokeInput[];
	env: { values: Record<string, string>; checksum: string; secretNames: string[] /* for redaction */ };
	hosts: { primary: string | null; extra: string[]; previous: string[] };
	ingress: {
		className: string | null;
		controllerNamespace: string | null;
		tls: 'cert-manager' | 'external' | 'none' | 'edge';
		issuer: string | null;
	};
	network: { isolation: boolean; extraEgress: Array<{ cidr: string; ports: number[] }>; needsHairpin: boolean };
	policy: {
		podSecurity: 'restricted' | 'baseline';
		allowRoot: boolean;
		runtimeClassName: string | null;
		quota: AppQuotaInput | null;
		limitRange: AppLimitRangeInput;
		cronMinIntervalMinutes: number;
		scaleFailedFirstDeployToZero: boolean;
		requireIsolationEnforced: boolean;
	};
	preview?: { prNumber: number };
}

export interface AppDeployHooks {
	onPhase(phase: AppDeployPhase, detail?: Record<string, unknown>): Promise<void>;
	verifyPublic(req: { urls: string[]; checks: AppSmokeInput[]; windowSeconds: number }): Promise<AppSmokeRun>;
	isCancelled(): Promise<boolean>;
}

export interface AppDeployResult {
	outcome: 'succeeded' | 'succeeded-with-warnings' | 'failed' | 'rolled-back' | 'cancelled' | 'rollback-failed';
	failure?: { phase: AppDeployPhase; code: AppFailureCode; message: string; logRef?: AppLogRef };
	warnings: Array<{ code: string; message: string }>;
	components: AppComponentStatus[];
	jobs: AppJobResult[];
	smoke: AppSmokeResult;
	ingressAddress: { ip?: string; hostname?: string } | null;
	isolationEnforced: boolean | null;
	firstDeployJobsCompleted: boolean;
}

export interface IDeploymentPluginAppMembers {
	// merged into IDeploymentPlugin
	readonly supportsApps?: boolean; // C
	deployApp?(input: AppRenderInput, credential: string, hooks: AppDeployHooks): Promise<AppDeployResult>; // C
	getAppStatus?(ref: AppTargetRef, credential: string, spec: AppStatusSpec): Promise<AppStatusSnapshot>; // C
	runAppJob?(ref: AppTargetRef, credential: string, job: AppJobRunRequest): Promise<AppJobResult>; // C
	destroyApp?(ref: AppTargetRef, credential: string, opts: { deleteVolumes: boolean }): Promise<AppDestroyResult>; // C
	scaleApp?(
		ref: AppTargetRef,
		credential: string,
		mode: 'pause' | 'resume',
		replicas: Record<string, number>
	): Promise<void>; // C (added)
	getAppLogs?(ref: AppTargetRef, credential: string, req: AppLogRequest): Promise<AppLogTail>; // C (added)
	checkAppCluster?(credential: string, req: AppClusterCheckRequest): Promise<AppClusterCheck>; // C (added)
}
```

`destroyApp` never deletes a `PersistentVolumeClaim` or anything labelled `ever-works.io/dependency` unless
`deleteVolumes: true`; dependency deprovisioning itself is APW-07's (`IAppDependencyProvider.deprovision`) and is
called by the platform **before** `destroyApp(…, { deleteVolumes: true })`. With `deleteVolumes: false` it also keeps the
`ew-default-deny` policy whenever an object labelled `ever-works.io/dependency` or a PVC remains (spec FR-50), and
returns `kept: [{ kind, name }]` in `AppDestroyResult`. For `ref` of a verification namespace (label
`ever-works.io/purpose: verification`) it deletes the whole namespace regardless of `deleteVolumes` (R-10).

**Ever Works Apps (R-5).** The same optional members are implemented for that target by APW-10's `ever-works-apps`
plugin (capabilities `apps-tier` + `deployment`): `deployApp` maps the render input to desired state and writes it
through the control-namespace credential that `AppsTierPolicy.resolveClusterCredential(workId)` returns; `destroyApp` →
`removeWork` with the same `deleteVolumes` rule. The `k8s` plugin never receives that credential and never applies
anything for `ever-works-apps`.

---

## 4. The App renderer (`packages/plugins/k8s/src/app/`)

Pure functions from `AppRenderInput` to manifests; no I/O. The existing `manifest.renderer.ts` is not edited.

### 4.1 Names and labels — `app-names.ts` _(new)_

| Object                         | Name                                                                                                 | Notes                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Namespace                      | `ew-<slug ≤ 30>-<first 8 hex of workId>`                                                             | Computed once, persisted in runtime state; preview: `<ns>-pr<number>`; verification: `<ns>-v<attempt ≤ 999>` (R-10). |
| ServiceAccount                 | `app`                                                                                                | `automountServiceAccountToken: false`.                                                                               |
| Deployment / Service / Ingress | `<component>`                                                                                        | App spec `Name` is 1–32 chars (APW-03 schema §0).                                                                    |
| Env Secret                     | `app-env-<checksum first 10 hex>`                                                                    | `immutable: true`; keys are exactly the App spec's runtime env names.                                                |
| Platform ConfigMap             | `app-platform-<checksum first 10 hex>`                                                               | `immutable: true`; the non-secret `EVER_WORKS_*` variables (§4.7).                                                   |
| Pull Secret                    | `app-pull`                                                                                           | Mutable (token rotation).                                                                                            |
| Job                            | `job-<name>-<deploymentShort>`                                                                       | ≤ 45 chars. Manual run: `run-<name>-<8 hex>`.                                                                        |
| CronJob                        | `cron-<name>`                                                                                        | ≤ 37 chars (< 52 limit).                                                                                             |
| PVC                            | `<component>-<volume>`                                                                               | Label `ever-works.io/retain: "true"`.                                                                                |
| Probe/runner ConfigMap         | `ew-runner-<hash10>`                                                                                 | Script + check list.                                                                                                 |
| NetworkPolicies                | `ew-default-deny`, `ew-allow-same-namespace`, `ew-allow-ingress`, `ew-allow-egress`, `ew-allow-deps` |                                                                                                                      |
| LimitRange / ResourceQuota     | `ew-defaults` / `ew-quota`                                                                           |                                                                                                                      |

Labels on every object: `app.kubernetes.io/managed-by: ever-works-k8s-plugin`, `app.kubernetes.io/part-of:
<slug>`, `ever-works.io/work-id: <Work uuid>`, `ever-works.io/kind: app`, and `ever-works.io/component` /
`ever-works.io/job` / `ever-works.io/cron` where relevant. **Not** `ever-works.io/managed` and **not**
`app.kubernetes.io/name` (§1.2 #6). Selectors: `{ ever-works.io/component: <name> }` — stable across slug
renames. Namespace labels add `pod-security.kubernetes.io/enforce|warn|audit` (§4.4); verification namespaces add
label `ever-works.io/purpose: verification` and annotation `ever-works.io/expires-at: <RFC 3339 UTC>`.

### 4.2 Namespace-scoped objects — `app-manifest.renderer.ts` _(new)_

Apply order in `prepare`: Namespace (or verify pre-created) → ServiceAccount → LimitRange (skip on 403 for
`your-cluster`, warning `limitrange_forbidden`) → ResourceQuota (`ever-works-apps` only; 403 is fatal) →
NetworkPolicies → pull Secret → env Secret → PVCs → Services. Namespace ownership check: an existing namespace
must carry `ever-works.io/work-id` equal to this Work, or be the owner-selected pre-created namespace with no
object labelled for another Work.

`LimitRange` defaults (both targets): default request 100m / 128Mi, default limit 1 CPU / 512Mi,
ephemeral-storage default limit 1Gi; `max` per container 8 CPU / 64Gi on `your-cluster`, 2 CPU / 4Gi on
`ever-works-apps`. `ResourceQuota` (`ever-works-apps`, from `AppsTierPolicy`, defaults): `requests.cpu: 2`,
`limits.cpu: 4`, `requests.memory: 4Gi`, `limits.memory: 6Gi`, `pods: 20`, `persistentvolumeclaims: 5`,
`requests.storage: 20Gi`, `services.loadbalancers: 0`, `services.nodeports: 0`, `count/jobs.batch: 20`,
`count/cronjobs.batch: 20`, `secrets: 30`, `configmaps: 30`.

### 4.3 Workloads

Per component a `Deployment`:

- `replicas` from spec; `revisionHistoryLimit: 5`; `progressDeadlineSeconds` = the component deadline (§5.3).
- Strategy: `Recreate` when the component has volumes; else `RollingUpdate` with `maxSurge: 0, maxUnavailable: 1`
  for 1 replica and `maxSurge: 1, maxUnavailable: 0` above (same trade-off the site renderer documents).
- `minReadySeconds: 30` for workers without probes; `0` otherwise.
- Pod template annotations: `ever-works.io/env-checksum`, `ever-works.io/build-commit`,
  `ever-works.io/deployment-id`. Env via `envFrom: [{ secretRef: { name: app-env-…, optional: false } },
{ configMapRef: { name: app-platform-…, optional: false } }]` — **not optional**: a missing Secret must fail
  loudly (`CreateContainerConfigError`), unlike the site path. No env value is ever written into a Deployment,
  Job or CronJob spec (ACCEPTANCE E2E-05).
- `enableServiceLinks: false`, `automountServiceAccountToken: false`, `serviceAccountName: app`,
  `imagePullSecrets` when `image.pull` is set, soft hostname `topologySpreadConstraints` (as today),
  `runtimeClassName` when the policy names one.
- Container `command`/`args` from spec; `ports` for web components only; `imagePullPolicy: IfNotPresent`
  (digest-pinned references make `Always` pointless).

Web components get a `ClusterIP` Service `port 80 → targetPort <spec port>`. Only `domains.primaryComponent`
gets an `Ingress`. The reference `components.<name>.internalUrl` (CONTRACTS §1, APW-13 addition) resolves to
`http://<name>.<namespace>.svc.cluster.local` — known before rendering because the namespace is fixed first — and
`build.commitSha` to the Build's 40-character commit; both are passed to `AppRuntimeEnvSource` (§9.6).

### 4.4 Security context — `app-security.ts` _(new)_

The `ever-works-apps` column is what this renderer produces when APW-10's in-zone controller calls it; the zone then
applies its own non-overridable overlays (runtime class, token, labels) — the platform applies none of it (R-5).

| Field                                 | `your-cluster`                                                                 | `ever-works-apps` (rendered in-zone)                   |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| pod `runAsNonRoot`                    | `true`; `false` when `allowRoot`                                               | `true` always                                          |
| pod `seccompProfile`                  | `RuntimeDefault`                                                               | `RuntimeDefault`                                       |
| pod `fsGroup` / `fsGroupChangePolicy` | `10001` / `OnRootMismatch` when volumes                                        | same                                                   |
| container `allowPrivilegeEscalation`  | `false`                                                                        | `false`                                                |
| container `capabilities`              | `drop: [ALL]`; `add: [NET_BIND_SERVICE]` only when `allowRoot` and port < 1024 | `drop: [ALL]`; port < 1024 refused (`privileged_port`) |
| container `readOnlyRootFilesystem`    | `!writableRootFilesystem`                                                      | `!writableRootFilesystem`                              |
| `/tmp` emptyDir (`sizeLimit: 256Mi`)  | when read-only                                                                 | when read-only                                         |
| namespace pod security                | enforce `baseline`, warn+audit `restricted`                                    | enforce `restricted`                                   |

Rollout classifier (§5.4) maps kubelet messages `container has runAsNonRoot and image will run as root` and
`image has non-numeric user` to `image_runs_as_root` / `image_user_unverifiable` within 180 s. For
`ever-works-apps` the refusal happens **before apply**: `AppImageConfigReader` _(new,
`packages/agent/src/app-runtime/app-image-config.reader.ts`)_ reads the image config's `User` from the registry in
the worker (manifest → `linux/amd64` entry of an index → config blob; pull credential from APW-05; 10 s timeout;
registry host passes the public-address guard of §6.1). Empty, `0`, `root`, `0:*` or a non-numeric user →
precondition `managed_root_forbidden` / `image_user_unverifiable`. On `your-cluster` the same read only pre-warns.

### 4.5 Probes and resources

Probe object (APW-03 §10) → `httpGet { path, port: 'http' }` or `tcpSocket { port: 'http' }` with
`periodSeconds`, `timeoutSeconds`, `initialDelaySeconds`, `failureThreshold`. Defaults applied by the renderer
only where the spec is silent: web startup `tcpSocket`, period 10 s, `failureThreshold: 60`. Liveness only when
declared. Resources: `requests.cpu = resources.cpu`, `requests.memory = resources.memory`,
`limits.memory = resources.memoryLimit`, `limits.cpu = resources.cpuLimit` when declared; on `ever-works-apps`
an absent `cpuLimit` becomes `max(1, 4 × cpu)` so the quota admits the pod.

### 4.6 Volumes

`PersistentVolumeClaim { accessModes: [ReadWriteOnce], resources.requests.storage: size, storageClassName:
<target setting or cluster default> }`, annotation `ever-works.io/backup: "true|false"`. Mounted at `path`.
SSA only ever raises `storage`; a lower value is refused before apply (`volume_shrink`). `replicas > 1` with
volumes is refused (`volume_replicas`) — see spec §9.

### 4.7 Env and pull Secrets

The env Secret holds exactly the `values` from `AppRuntimeEnvSource` (APW-07, runtime/both phases). The platform
ConfigMap holds `EVER_WORKS_APP_URL`, `EVER_WORKS_APP_HOST`, `EVER_WORKS_APP_COMMIT`, `EVER_WORKS_DEPLOYMENT_ID`
and `EVER_WORKS_SOURCE_URL` (FR-44 only) — none secret; collision with an App spec name is impossible (APW-03 R23).
`checksum` = first 16 hex of sha256 over `name=value` lines of both maps sorted by name (the `hashRuntimeEnv`
form). After a successful Deployment, env Secrets and platform ConfigMaps not referenced by the current or 2
previous ReplicaSets of any component are deleted.

### 4.8 Jobs and the runner — `app-jobs.renderer.ts`, `app-runner.script.ts` _(new)_

- `command` jobs: `Job` with the component's image, env, security context and resources;
  `backoffLimit: retries`, `activeDeadlineSeconds: timeoutSeconds`, `ttlSecondsAfterFinished: 86400`,
  `restartPolicy: Never`. The last 3 Jobs per job name are kept.
- `http` jobs, `http` cron and every smoke run use the **runner**: a `Job` on a digest-pinned public Node.js
  runtime image (`APP_RUNNER_IMAGE` constant, reviewed on bump) that executes `app-runner.script.ts` mounted
  read-only from a ConfigMap, reading the request list from a second mounted file. **Paths, bodies and
  expectations are data read with `JSON.parse`, never interpolated into a command line.** Requests use
  `redirect: 'manual'` — smoke, job and cron requests never follow redirects, so `expect.status` judges the first
  response (CONTRACTS §1). `http.authEnv` is sent as `Authorization: Bearer <value>` (`authScheme: bearer`,
  default) or `Authorization: <value>` (`authScheme: raw`, APW-13 addition), for jobs and cron alike. Bodies with
  `{{env.NAME}}` placeholders are resolved by the runner from `secretKeyRef` env vars; the resolved body is
  never logged. Output: one JSON line per request `{ name, status, latencyMs, failedExpectation?, found? }`,
  `found` truncated to 200 characters and scrubbed of every mounted secret value.
- Runner hardening: same security context as §4.4 (non-root numeric user `10001`, read-only root, no token),
  requests 50m / 64Mi, limits 500m / 128Mi, `activeDeadlineSeconds` = window + 30.

### 4.9 CronJobs

`CronJob { schedule, timeZone: 'Etc/UTC', concurrencyPolicy: Forbid|Allow (spec concurrency, default Forbid),
startingDeadlineSeconds: 300, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 3, suspend: paused }`.
`http` cron → runner job targeting `http://<component>.<ns>.svc:80<path>` with the `Authorization` header built
per `authScheme` from a `secretKeyRef` of `authEnv`. A cron whose `authEnv` value is unset or empty is a precondition failure
(`cron_auth_env_unset`), never a rendered call without a credential. On `ever-works-apps`, schedules that can
fire more often than every 5 minutes are refused (`cron_too_frequent`).

### 4.10 Network policies — `app-network-policy.renderer.ts` _(new)_

| Policy                    | Selector / rule                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ew-default-deny`         | all pods; `policyTypes: [Ingress, Egress]`, no rules.                                                                                                                                                                                                                                                                  |
| `ew-allow-same-namespace` | ingress + egress to `podSelector: {}` in the namespace.                                                                                                                                                                                                                                                                |
| `ew-allow-ingress`        | primary web component pods; from `namespaceSelector: kubernetes.io/metadata.name=<controllerNamespace>`; when unknown, from `namespaceSelector: {}` on the web port only (warning `ingress_controller_namespace_unknown`).                                                                                             |
| `ew-allow-egress`         | UDP+TCP 53 to `kube-system` pods `k8s-app=kube-dns` (fallback: any namespace, port 53); `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `127.0.0.0/8`, `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`; `::/0` except `fc00::/7`, `fe80::/10`, `::1/128`, `ff00::/8`. |
| `ew-allow-deps`           | `extraEgress` CIDRs/ports (dependencies outside the namespace, resolved by the platform at render time) and, when `needsHairpin`, the ingress address on 80/443.                                                                                                                                                       |

When `isolation: false` (your-cluster opt-out) none of the five policies is rendered, and existing policies with
these names are deleted. Enforcement probe (after rollout): the runner opens a
TCP connection to `kubernetes.default.svc:443` with a 3 s timeout; connected ⇒ `isolationEnforced: false`.

### 4.11 Ingress, TLS, published hosts

`Ingress` for the primary web component with rules for `hosts.primary ∪ hosts.extra ∪ hosts.previous` (previous
hosts kept until a `rebuild`-policy Deployment succeeds), `ingressClassName`, strategy annotations from the
existing registry, TLS block only for `tls: 'cert-manager'` (issuer annotation) — `external` and `none` render no
TLS; `edge` (managed) follows `AppsTierPolicy`. Every host passes the strict RFC-1123 check used by
`addDomain`. No `Ingress` is rendered when no class exists and no default class was detected (warning
`no_ingress_controller`, public smoke skipped).

**URL scheme per TLS mode (spec FR-41, FR-42).** `appUrlScheme(tls, hostKind)` in `app-hosts.service.ts`:
`cert-manager` → `https` for every host (TLS block lists every host, issuer annotation from `ingress.issuer`);
`external` → `https` for custom domains and `http` for the managed subdomain (its record points straight at the
ingress, so no outside terminator exists), no certificate requested; `none` → `http`, warning `tls_disabled`; `edge`
(Ever Works Apps) → `https`. `EVER_WORKS_APP_URL`, `domains.primary.url` handed to APW-07, the Deploy tab URL and the
public smoke URLs all use this one function.

**Self-address (hairpin) check (spec FR-37).** When `network.needsHairpin` is true, `app-deployer.ts` renders
`renderRunnerJob('hairpin')` after publish: a runner Job **inside the app namespace** that requests the first smoke check
against `<scheme>://<primary host><path>` resolved by cluster DNS (no `Host` override), with the egress to the ingress
address allowed by `ew-allow-deps`. Its result is `smokeResult.hairpin`; failure is warning
`hairpin_unreachable` ("Your app can't reach its own address from inside the cluster") and never a rollback. No hairpin
Job is rendered when `needsHairpin` is false or there is no primary host.

### 4.12 Verification targets — `purpose: 'verification'` (Resolution R-10)

Requested by APW-04 through `app-cluster-op` ops `verification-deploy`, `verification-status`,
`verification-destroy` (§9.2), on the isolated worker, `your-cluster` only:

- **Namespace** `<ns>-v<attempt>` — **this epic derives and owns the name**: `<ns>` is the live namespace name from
  §4.1 (`ew-<slug ≤ 30>-<first 8 hex of workId>`), so `verification-deploy` **returns** it and
  `verification-destroy` takes it back as a handle. APW-04 must **never** derive or hard-code a verification
  namespace name of its own (an earlier draft used `ewv-<work short id>-<attempt>`, which would have had APW-04
  destroying a namespace APW-06 never created). With the purpose label and expiry annotation `now + ttlMinutes` (1–240); never
  the live namespace, never recorded in `work_app_runtime_states.namespace`, never a `WorkDeployment` row.
- **Rendered**: ServiceAccount, LimitRange, the five NetworkPolicies, pull Secret, env Secret from APW-07's ephemeral mode
  (values in memory only), Deployments and Services, `pre-deploy` / `first-deploy` Jobs. **Not rendered**: Ingress,
  TLS, CronJobs, DNS records, custom domains, PVCs — every volume becomes an `emptyDir` with the declared size as
  `sizeLimit`.
- **Dependencies** come from APW-07 providers with `ephemeral: true` (no PVC, outputs never stored).
- **Smoke** runs only in-cluster with the runner (`renderRunnerJob('smoke')`, `Host: <component>.<ns>.svc`), no public
  smoke and no hairpin check; the isolation probe result is reported, never fatal.
- **Destroy** deletes the namespace (propagation `Foreground`) and waits ≤ 300 s; the expiry annotation lets APW-04's
  `app-provision-sweep` destroy leftovers. `getAppStatus` for a verification ref returns components, jobs and smoke only.

---

## 5. Deploy orchestration

### 5.1 Preconditions — `packages/agent/src/app-runtime/app-deploy-preconditions.service.ts` _(new)_

Returns `AppPrecondition[]` (`{ code, names?, message, fixUrl? }`), never throws for an unmet one.

| Code                                                                                          | Source                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `spec_invalid`                                                                                | APW-03 validator over `.works/works.yml` **at the Build's commit** (Git facade read). |
| `license_blocks_target` / `license_attestation_missing`                                       | `AppLicenseService.getHostingEligibility(workId)` (APW-03, R-3; table in §5.2).       |
| `env_required_unset`                                                                          | `AppRuntimeEnvSource.resolve(...).unsetRequired`.                                     |
| `dependency_not_ready`                                                                        | `…resolve(...).notReadyDependencies`.                                                 |
| `no_green_build` / `no_green_build_for_head` (+ `latestGreenBuildId`) / `build_image_missing` | `WorkBuild` (APW-05).                                                                 |
| `target_none` / `target_not_checked` / `cluster_changed_unconfirmed`                          | runtime state.                                                                        |
| `managed_disabled` / `managed_scope_unverified_blueprint` / `quota_exceeded`                  | `AppsTierPolicy.isOpen()` / `managedScope()`, `EverWorksAppsQuotaService`.            |
| `managed_ineligible` (+ reasons) / `managed_sandbox_unavailable`                              | `AppsTierPolicy.eligibility(userId)`; `podPolicy().runtimeClassName === null` (R-24). |
| `app_work_deleting`                                                                           | runtime state `deletionRequestedAt` set (§9.7).                                       |
| `paused` / `deploy_in_progress`                                                               | runtime state.                                                                        |
| `cron_auth_env_unset` / `job_auth_env_unset`                                                  | env source × spec.                                                                    |
| `volume_replicas` / `volume_shrink` / `privileged_port` / `cron_too_frequent`                 | render-time checks.                                                                   |
| `managed_root_forbidden` / `image_user_unverifiable` (managed only)                           | `AppImageConfigReader` in the worker (§4.4).                                          |
| `worker_not_isolated` / `env_source_unavailable` / `pull_credential_unavailable`              | platform configuration.                                                               |

### 5.2 License gate per target

The gate is **read, never stored** (Resolution R-3, CONTRACTS C3). At request time and again when work starts,
`AppLicenseService.getHostingEligibility(workId)` returns `{ none, yourCluster: 'allowed' | 'attestationRequired',
managed: 'allowed' | ManagedHostingReason, sourceOffer }`; this epic maps it:

| Eligibility field                     | Precondition                  | What APW-03 decides behind it                                                   |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `yourCluster = 'attestationRequired'` | `license_attestation_missing` | amber, red, unknown until the owner attests (re-required on license change)     |
| `managed ≠ 'allowed'` (reason)        | `license_blocks_target`       | red never; amber only with a recorded upstream agreement; P2 verified Blueprint |
| `sourceOffer`                         | — (feeds §4.7 / T30)          | `network-source-offer` obligation **and** (relation `link` **or** ahead > 0)    |

The **Attest** action in `AppLicenseAttestationDialog` calls APW-03's `POST /api/works/:id/app-license/attest`
(owner only; any other member gets `403`, rendered as "Only the App Work's owner can attest.").
`work_app_runtime_states` has no attestation column.

### 5.3 Phases and numbers — `packages/contracts/src/apps/app-runtime.ts` _(new)_

```ts
export const APP_DEPLOY_REQUEST_BUDGET_MS = 2_000;
export const APP_PREPARE_TIMEOUT_S = 120;
export const APP_JOB_TIMEOUT_DEFAULT_S = 600; // spec default; spec range 10–3600
export const APP_ROLLOUT_EXTRA_S = 120;
export const APP_ROLLOUT_MIN_S = 300;
export const APP_ROLLOUT_MAX_S = 2_400;
export const APP_ROLLOUT_POLL_S = 5;
export const APP_ROLLOUT_RESTARTS_FAIL = 3;
export const APP_ROLLOUT_STUCK_POD_S = 180; // ImagePullBackOff / CreateContainerConfigError
export const APP_WORKER_STABLE_S = 30;
export const APP_SMOKE_IN_CLUSTER_WINDOW_S = 120;
export const APP_SMOKE_RETRY_S = 10;
export const APP_SMOKE_PUBLIC_FIRST_WINDOW_S = 600;
export const APP_SMOKE_PUBLIC_WINDOW_S = 180;
export const APP_SMOKE_BODY_BYTES = 1_048_576;
export const APP_SMOKE_FOUND_CHARS = 200;
export const APP_PUBLISH_TIMEOUT_S = 60;
export const APP_DEPLOY_MAX_DURATION_S = 7_200;
export const APP_ENV_SECRETS_KEPT = 3;
export const APP_ROLLBACK_CANDIDATES = 20;
export const APP_JOB_RUNS_KEPT = 3;
export const APP_JOB_TTL_S = 86_400;
export const APP_TMP_SIZE_MI = 256;
export const APP_PAUSE_TIMEOUT_S = 120;
export const APP_REMOVE_TIMEOUT_S = 300;
export const APP_HEALTH_POLL_S = 60;
export const APP_HEALTH_BATCH = 500;
export const APP_HEALTH_POLL_TIMEOUT_S = 20;
export const APP_HEALTH_CLUSTER_CONCURRENCY = 5;
export const APP_HEALTH_FAILS_TO_NOTIFY = 5;
export const APP_HEALTH_PASSES_TO_RECOVER = 3;
export const APP_HEALTH_UNREACHABLE_POLLS = 10;
export const APP_HEALTH_NOTIFY_DEDUPE_H = 6;
export const APP_STATUS_STALE_S = 180;
export const APP_STATUS_REFRESH_MIN_S = 15;
export const APP_CERT_NOTIFY_AFTER_MIN = 30;
export const APP_LOG_LINES_DEFAULT = 200;
export const APP_LOG_LINES_MAX = 500;
export const APP_LOG_BYTES_MAX = 262_144;
export const APP_LOG_CACHE_S = 300;
export const APP_LOG_REDACT_MIN_CHARS = 8;
export const APP_CLUSTER_CHECK_TIMEOUT_S = 30;
export const APP_CLUSTER_DIAL_TIMEOUT_S = 10;
export const APP_ISOLATION_PROBE_TIMEOUT_S = 3;
export const APP_DOMAIN_RECONCILE_S = 60;
export const APP_MANAGED_MAX_PER_USER_DEFAULT = 3;
export const APP_MANAGED_CRON_MIN_INTERVAL_MIN = 5;
export const APP_SUBDOMAIN_LABEL_MIN = 3;
export const APP_PREVIEWS_MAX = 3;
export const APP_PREVIEW_CLOSE_REMOVE_MIN = 10;
export const APP_PREVIEW_IDLE_H = 72;
```

Component deadline = `clamp(startup.period × startup.failureThreshold + readiness.period ×
readiness.failureThreshold + 120, 300, 2400)` seconds (web default with the renderer's startup default:
`10×60 + 10×3 + 120 = 750`).

### 5.4 Rollout predicate and failure classifier — `app-rollout.ts` _(new)_

Component rolled out ⇔ `metadata.generation ≤ status.observedGeneration` **and** `updatedReplicas = replicas`
**and** `availableReplicas = replicas` **and** `unavailableReplicas` absent/0 **and** no ReplicaSet other than
the newest has ready pods, and — for workers without probes — each new pod has `restartCount = 0` for 30 s.
Early failure from pod status: any container `restartCount ≥ 3` since the Deployment started
(`crash_loop`, with `lastState.terminated.exitCode` and `reason`), `waiting.reason ∈ {ImagePullBackOff,
ErrImagePull, CreateContainerConfigError, CreateContainerError, InvalidImageName}` for ≥ 180 s, `OOMKilled`
counted as a restart and reported (`oom_killed`), `ProgressDeadlineExceeded` condition (`rollout_timeout`).

### 5.5 Phase machine and rollback — `app-deployer.ts` _(new)_

```
capture = read live Deployments/CronJobs/Ingress (templates, replicas, hosts)   // before any change
prepare → [pre-deploy jobs unless skip] → rollout(all components in parallel)
  → [first-deploy jobs if isFirstDeploymentOnCluster] → in-cluster smoke (runner, Host: primary)
  → isolation probe → publish(Ingress apply) → hooks.verifyPublic(public + hairpin via runner)
  → post-deploy jobs → CronJobs → GC env Secrets/old Jobs → done
any failure/cancel/deadline in rollout..publish with capture non-empty
  → rollback: re-apply captured templates (image, envFrom secret, replicas) and captured Ingress hosts,
    wait with the same deadlines → 'rolled-back' | 'rollback-failed'
capture empty (first Deployment) → 'failed'; if policy.scaleFailedFirstDeployToZero → scale to 0
```

`hooks.isCancelled()` is checked between phases and every rollout poll. Public smoke classification lives in the
platform (`AppPublicSmokeService`, redirects never followed): DNS lookup of the host ≠ ingress address → `dns_not_pointing`; TLS
handshake/name failure → `tls_not_ready`; connect timeout → `unreachable`; response mismatch while the same check
passed in-cluster → `check_failed` (health-relevant). Only in-cluster failures and publish failures roll back.

### 5.6 `app-deploy` job — `packages/agent/src/app-runtime/app-deploy.orchestrator.ts` _(new)_

1. Load Deployment + runtime state; re-run §5.1 (race); unmet → `ERROR` with `appRender.preconditions`.
2. Build `AppRenderInput` (`app-render-input.builder.ts`): spec at `build.commitSha`, env + dependency egress
   (`AppRuntimeEnvSource`), pull credential (`AppImagePullCredentialSource`), hosts (§8), ingress/TLS/network
   from target settings, policy from `AppsTierPolicy` (`ever-works-apps`) or the your-cluster defaults.
3. Resolve credential: `your-cluster` → Work-scoped `k8s` plugin settings through `DeployFacadeService.
getPluginAndTokenAndSettings`, `clusterSource` must be `custom-kubeconfig` (any other value →
   `target_not_checked`), `validateClusterSourceForOwner(dataRepoOwner, …)`, then the guard (§6.1), and the call goes
   to the `k8s` plugin; `ever-works-apps` → `AppsTierPolicy.resolveClusterCredential(workId)` (a control-namespace-only
   credential) and the call goes to the `apps-tier` deployment plugin, which writes desired state (R-5). **Never**
   `k8s-works` / `k8s-works-shared` env kubeconfigs, and never the tier credential to the `k8s` plugin (unit-tested).
4. `state = 'DEPLOYING'`, `startedAt`; call `deployApp`. Hooks write `appRender.phase`, `state = 'VERIFYING'` from
   `in-cluster-smoke`, and emit `app.deploy.started`, `app.job.*`, `app.smoke.*` events.
5. Map outcome → `state` (`READY`, `READY` + `appRender.warnings`, `ERROR`, `ROLLED_BACK`, `CANCELED`) and write
   `componentStatuses`, `jobResults` (in `appRender`), `smokeResult`, `completedAt`, `lastError` (≤ 500 chars).
6. Runtime state: `currentDeploymentId` (on READY), `firstDeployJobsCompletedAt` + `clusterFingerprint`,
   `ingressAddress`, `isolationEnforced`, `namespace`, `statusSnapshot` from `getAppStatus`.
7. Events + notifications (§9.3); release `deployLockId` with `WHERE "deployLockId" = :id`; if `queuedBuildId` →
   request a new Deployment for it.
8. Trigger.dev `maxDuration: 7200`, `retry: { maxAttempts: 1 }` (a retried apply could double-run migrations);
   `onFailure` marks the row `ERROR` (`worker_failed`) and releases the lock.

### 5.7 `app-smoke` job **C**

Re-runs the App spec smoke checks against the current live Deployment on demand (Deploy tab **Run smoke
tests**, APW-04's verification loop) using `runAppJob` with the runner plus `AppPublicSmokeService`; writes
`smokeResult` on the current Deployment and emits `app.smoke.passed|failed`. Inside `app-deploy` the same
services are called in-process so a failure can roll back within one job.

---

## 6. Cluster access

### 6.1 Kubeconfig guard — `packages/plugins/k8s/src/app/app-kubeconfig.guard.ts` _(new)_

Runs in the worker, before `KubeConfig.loadFromString`:

1. Parse with `parseKubeconfig`; refuse (`K8sPluginError('KUBECONFIG_UNSUPPORTED', reason)`) when the selected
   user has `exec`, `auth-provider`, `tokenFile`, `client-certificate`, `client-key`; the cluster has
   `certificate-authority` (file), `insecure-skip-tls-verify: true`, `proxy-url`, or lacks
   `certificate-authority-data`.
2. `server` must be `https:`; host is an IP literal or resolved (`dns.lookup(all: true)`) with 10 s timeout.
3. Every address must pass `isPublicAddress(ip, allowlist)` — IPv4 denies `0/8, 10/8, 100.64/10, 127/8, 169.254/16,
172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
240/4, 255.255.255.255/32`; IPv6 denies `::/128, ::1/128, ::ffff:0:0/96` (mapped → re-check v4), `64:ff9b::/96`
   (re-check embedded v4), `100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8`. Allow-list CIDRs from
   `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` override the deny list.
4. Rewrite the in-memory kubeconfig: `server: https://<validated ip>:<port>`, `tls-server-name: <original host>`
   — the client never re-resolves. Redirects are not followed (client-node does not follow them for API calls;
   asserted in a test with a mocked 307).
5. Same guard applies to the ingress address before it becomes a DNS record target (§8.3).

### 6.2 The isolated worker

- All App cluster I/O runs in Trigger.dev tasks on queue `app-cluster-io` (`concurrencyLimit: 20`). The API module
  imports no App cluster code path; a unit test asserts `AppRuntimeFacadeService` throws `APP_CLUSTER_IO_IN_API`
  when constructed outside the worker context.
- Production (`NODE_ENV=production`) refuses to dispatch any `app-*` cluster job unless
  `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` (**C**) — an operator attestation that the worker for this queue has
  no route to internal networks; the network design itself lives in the private operations repository.
- The existing `validateConnection` / `listClusterNodes` behaviour for non-app Works is unchanged (additive rule);
  the App path never calls them.

### 6.3 Connection check — `checkAppCluster`

`/version` (10 s) → `SelfSubjectAccessReview` for each required verb in the target namespace (or, when it does not
exist, `create namespaces` cluster-wide) → `IngressClass` list → controller namespace detection (list pods labelled
`app.kubernetes.io/name ∈ {ingress-nginx, traefik}` across namespaces; skipped on 403) → `ClusterIssuer` list
(`cert-manager.io/v1`, skipped when absent/403) → `StorageClass` list. Required: `get,list,watch,create,patch,
update,delete` on `deployments, services, ingresses, secrets, configmaps, serviceaccounts, persistentvolumeclaims,
jobs, cronjobs, networkpolicies`; `get,list` on `pods, replicasets, events`; `get` on `pods/log`. Optional:
`create namespaces`, `create,patch limitranges`. Result stored as `clusterCheck` (secret-free) with
`clusterFingerprint`. `k8s-api.service.ts` gains `applyObject`, `readObject`, `listObjects`, `deleteObject`,
`readPodLog`, `createSelfSubjectAccessReview` on the existing factory (plus `authorizationV1Api`).

---

## 7. Data model

**Workspace backup (Resolution R-25).** `WorkAppRuntimeState` exports as `data/works/app-runtime-states.jsonl` through the parent Work ids, and the new `WorkDeployment` columns ride the existing `deployments.jsonl`; nothing is redacted ([tasks](./tasks.md) T65).

### 7.1 `work_deployments` — additive columns (**C**: `buildId`, `componentStatuses`, `smokeResult`; added: `appTarget`, `appRender`)

| Column              | Type                | Meaning                                                                                                                                                                                                                      |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildId`           | uuid, null, indexed | `WorkBuild.id` deployed (no FK to keep APW-05 merge order free; validated in code).                                                                                                                                          |
| `componentStatuses` | `simple-json`, null | `[{ name, role, desired, ready, restarts, lastTerminationReason?, oomKilledAt? }]` at terminal state.                                                                                                                        |
| `smokeResult`       | `simple-json`, null | `{ inCluster: CheckResult[], public: CheckResult[], hairpin?: CheckResult, classification?, observedAt }`.                                                                                                                   |
| `appTarget`         | varchar(24), null   | `your-cluster` · `ever-works-apps`.                                                                                                                                                                                          |
| `appRender`         | `simple-json`, null | `{ phase, namespace, specCommitSha, envChecksum, jobResults[], warnings[], preconditions[], rollback?: { automatic, reason, restored, rolledBackToDeploymentId? }, cancelledBy?, supersededBy? }`. Never values or log text. |

New states: `DEPLOYING`, `VERIFYING`, `ROLLED_BACK`, `SUPERSEDED`. `isTerminal()` adds `ROLLED_BACK`,
`SUPERSEDED`. `providerProjectId` = namespace, `providerDeploymentId` = `<namespace>/<deploymentShort>`.

### 7.2 `work_app_runtime_states` _(new)_ — entity `WorkAppRuntimeState`

| Column                                                            | Type                        | Notes                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                              | uuid PK                     |                                                                                                                                                                                                                                                                                                  |
| `workId`                                                          | uuid, unique, FK CASCADE    |                                                                                                                                                                                                                                                                                                  |
| `target`                                                          | varchar(24)                 | `none` (default; label "None — don't deploy yet", R-12) · `your-cluster` · `ever-works-apps`.                                                                                                                                                                                                    |
| `targetSettings`                                                  | `simple-json`               | `{ namespaceOverride?, ingressClass?, controllerNamespace?, tls, issuer?, storageClass?, networkIsolation: true, allowRoot: false, managedSubdomain: true, primaryDomain?, autoDeploy: true, previews: false }` — `managedSubdomain` is effective only when the apps domain is configured (R-16) |
| `namespace`                                                       | varchar(63), null           | Frozen at first Deployment per `clusterFingerprint`.                                                                                                                                                                                                                                             |
| `clusterFingerprint`                                              | varchar(32), null           | From `parseKubeconfig`.                                                                                                                                                                                                                                                                          |
| `clusterCheck` / `clusterCheckedAt`                               | `simple-json` / timestamptz | Secret-free check result.                                                                                                                                                                                                                                                                        |
| `currentDeploymentId`                                             | uuid, null                  |                                                                                                                                                                                                                                                                                                  |
| `deployLockId` / `deployLockedAt`                                 | uuid / timestamptz          | Atomic claim; stale after 7 260 s (max duration + 60) → reclaimable.                                                                                                                                                                                                                             |
| `queuedBuildId` / `queuedDeploymentId`                            | uuid, null                  | Latest-wins queue of 1.                                                                                                                                                                                                                                                                          |
| `firstPublishedAt`                                                | timestamptz, null           |                                                                                                                                                                                                                                                                                                  |
| `firstDeployJobsCompletedAt`                                      | timestamptz, null           | Reset when `clusterFingerprint` changes.                                                                                                                                                                                                                                                         |
| `paused` / `pausedAt`                                             | boolean / timestamptz       |                                                                                                                                                                                                                                                                                                  |
| `removedAt`                                                       | timestamptz, null           |                                                                                                                                                                                                                                                                                                  |
| `deletionRequestedAt` / `deletionDeleteData` / `deletionAttempts` | timestamptz / boolean / int | App Work deletion in progress (§9.7); `deletionDeleteData` = the typed-confirmed "Also delete stored data".                                                                                                                                                                                      |
| `deletionRequestedByUserId`                                       | uuid                        | Who requested the deletion (Activity attribution). The fork/copy decision stays APW-01's and is carried out in its request.                                                                                                                                                                      |
| `ingressAddress`                                                  | `simple-json`, null         | `{ ip?, hostname? }`.                                                                                                                                                                                                                                                                            |
| `isolationEnforced`                                               | boolean, null               |                                                                                                                                                                                                                                                                                                  |
| `health`                                                          | varchar(16)                 | `unknown` · `healthy` · `degraded` · `down` · `unreachable`.                                                                                                                                                                                                                                     |
| `consecutiveFailures` / `consecutivePasses` / `unreachableStreak` | int                         |                                                                                                                                                                                                                                                                                                  |
| `lastHealthNotifiedAt` / `lastPolledAt` / `certInvalidSince`      | timestamptz                 |                                                                                                                                                                                                                                                                                                  |
| `statusSnapshot` / `statusObservedAt`                             | `simple-json` / timestamptz | `AppStatusSnapshot` (no log text).                                                                                                                                                                                                                                                               |
| `tenantId` / `organizationId`                                     | uuid, null                  | Scope columns, no relation decorators (entity-cycle precedent).                                                                                                                                                                                                                                  |
| `createdAt` / `updatedAt`                                         |                             |                                                                                                                                                                                                                                                                                                  |

Indexes: unique `workId`; `(target, paused, lastPolledAt)` for the poller; `(deployLockId)`; `(deletionRequestedAt)`.

`workId` keeps `ON DELETE CASCADE`: the row disappears only after §9.7 has removed the workloads and APW-01 deletes the
Work, so nothing needed for the teardown (target, namespace, fingerprint, Work-scoped kubeconfig) is gone before it runs.

### 7.3 Migrations (Constitution V; block `179206<slot>00000`)

- `apps/api/src/migrations/1792060000000-ExtendWorkDeploymentsForApps.ts` _(new)_ — five nullable columns + index on
  `buildId`. `down()` drops only them.
- `apps/api/src/migrations/1792060100000-CreateWorkAppRuntimeStates.ts` _(new)_ — table + indexes. `down()` drops the
  table.

Newest migration on `develop` when written: `1791200100000-CreateOnboardingChecklists.ts`; on `ee45946e5`
(re-verified 2026-09-17): `1791240000000-AddSafetyRailsCore.ts`, still below this epic's block; re-stamp if moved.

---

## 8. Domains and DNS

### 8.1 Hosts — `app-hosts.service.ts` _(new)_

`primary` = the verified custom domain the owner marked primary (`targetSettings.primaryDomain`), else
`<managedSubdomain>.<EVER_WORKS_APPS_DOMAIN>` when `config.everWorks.apps.getDomain()` is non-null,
`targetSettings.managedSubdomain` is true and the label is allocated (Wave 1 on `your-cluster`, R-16), else `null`.
`extra` = verified `WorkCustomDomain` rows except primary, plus the managed subdomain when it is not primary. Unverified rows are never rendered. The App path does not
call `mergeCustomDomainHosts`, which stays untouched for other kinds. `previous` = hosts published by the current
Deployment that are no longer in `primary ∪ extra` while a `rebuild`-policy Deployment is pending.

### 8.2 Primary change → `domains.onChange`

`AppHostsService.onPrimaryChanged(workId)` (called by the subdomain PUT and the "make primary"/verify/remove
domain branches): `restart` → request a Deployment of `currentDeployment.buildId` with trigger `domain-change`;
`rebuild` → APW-05 `POST builds` for the deploy-branch head with trigger `domain-change`, and mark the runtime
state so the resulting Build success auto-deploys even when `autoDeploy` is off. Non-primary add/remove →
`app-cluster-op { op: 'ingress-reconcile' }` which re-applies only the `Ingress` (≤ 60 s).

### 8.3 Managed subdomain on the apps domain (Your cluster from Wave 1 — Resolution R-16)

- **Phase.** Everything in this section except the `ever-works-apps` edge line ships in **P1**: an App Work on Your
  cluster gets `<slug>.<apps-domain>` with a DNS record to its public ingress address **and** any custom domains the
  tenant adds. `<apps-domain>` is `EVER_WORKS_APPS_DOMAIN`, which **defaults to `EVER_WORKS_DOMAIN`** — so the
  default managed address is `<slug>.ever.works` and a template install simply works (owner decision 2026-09-17,
  R-16). An operator may point `EVER_WORKS_APPS_DOMAIN` at a dedicated apex outside every platform domain; that
  configuration is kept in full, including its Public Suffix List checks (APW-10 LG-15) and the stricter validation
  below. The managed shape is disabled only when the configured apex fails that validation.
- Config `packages/agent/src/config/index.ts` gains `everWorks.apps`: `getDomain()` (`EVER_WORKS_APPS_DOMAIN` **C**,
  default `EVER_WORKS_DOMAIN`), `getMaxPerUser()` (`EVER_WORKS_APPS_MAX_PER_USER` **C**, default 3), `getDnsZoneId()`
  (`EVER_WORKS_APPS_DNS_ZONE_ID` **C**), `getDnsApiToken()` (`EVER_WORKS_APPS_DNS_API_TOKEN` **C**, secret),
  `isClusterWorkerIsolated()`, `getClusterPrivateAllowlist()`.
- Boot validation, in two branches. **Dedicated-apex branch** (operator set `EVER_WORKS_APPS_DOMAIN` explicitly): the
  apex must not equal, end with `.`+, or be a suffix of `EVER_WORKS_DOMAIN` or the host of the platform web/API URL —
  this is what keeps the cookie-isolating configuration honest. **Shared-default branch** (apex resolves to
  `EVER_WORKS_DOMAIN`): the equality check is satisfied by definition and recorded as such; the platform-domain
  safeguards of R-16 apply instead — host-only `__Host-` Secure cookies on platform routes, no platform session
  cookie on app hosts, app hosts never serving platform pages. In both branches a malformed or unusable apex makes
  the feature log an error and `getDomain()` return `null`, which disables the managed subdomain only — custom
  domains keep working.
- `AppsDomainDnsService` _(new, `packages/agent/src/ever-works-providers/apps-domain-dns.service.ts`)_ builds a
  `CloudflareDnsProvider({ apiToken, zoneId, rootDomain: appsDomain, targetHostname: '' })` — same precedent as
  `EverWorksDnsService` (a follow-up moves both behind the `dns` capability, EW-738).
- Allocation: `SubdomainAllocator.allocate(work, appsDnsOps)` at the first Deployment to `your-cluster` (the
  allocator's slug → `-<4 hex>` suffix rule gives `<slug>.<apps-domain>`); label length < 3 refused in the App branch of
  `ManagedSubdomainService`. Record: `ensureRecord({ host, type: ip ? 'A' : 'CNAME', target, proxied: false })` on
  `your-cluster` only after §6.1 validates the address; on `ever-works-apps` the tier edge owns wildcard DNS
  (`AppsTierPolicy.ingress().edgeTlsMode` — the value is a member of `ingress()`'s return, §5.1, not of the policy
  itself) and no per-app record is written. The health poll re-validates the address and
  updates or removes the record.

### 8.4 Existing routes, App branch

`DeployFacadeService.getDomains/addDomain/removeDomain/verifyDomain` and `ManagedSubdomainService` gain an early
`if (work.kind === 'app')` branch that delegates to `AppDomainsService` _(new)_: rows stored as today; verify uses
`verifyDomainResolution(domain, runtimeState.ingressAddress)`; success → `updateVerified` + reconcile/onChange;
remove → row delete + reconcile. DNS guidance uses `buildDnsGuidance(domain, ip ?? hostname)`.

---

## 9. API and background work

### 9.1 Routes — `apps/api/src/app-runtime/app-runtime.controller.ts` _(new)_, `@Controller('api/works')`

| Route                                               | Code      | Throttle       | Notes                                                                                                                                     |
| --------------------------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST :id/deploy` **C**                             | 202       | 10/min member  | Kind `app` only (others: 400 pointing to `/api/deploy/works/:id`). Body `{ buildId?, confirmClusterChange? }`.                            |
| `GET :id/app-status` **C**                          | 200       | —              | Snapshot + `stale` flag + `sourceOffer`.                                                                                                  |
| `POST :id/app-status/refresh`                       | 202       | 4/min per Work |                                                                                                                                           |
| `POST :id/app-jobs/:name/run` **C**                 | 202       | 5/min member   | `{ confirmFirstDeploy? }`; 409 when a run of `:name` is active.                                                                           |
| `POST :id/app-smoke`                                | 202       | 5/min member   | Dispatches `app-smoke`.                                                                                                                   |
| `POST :id/app-rollback`                             | 202       | 10/min member  | `{ deploymentId, runPreDeployJobs?: false }`.                                                                                             |
| `POST :id/app-lifecycle`                            | 202       | 5/min member   | `{ action: 'pause'\|'resume'\|'remove'\|'cancel-deploy', deleteData?, confirmSlug? }`; `deleteData` requires `confirmSlug === work.slug`. |
| `POST :id/app-logs` / `GET :id/app-logs/:requestId` | 202 / 200 | 10/min member  | `{ component? , job?, deploymentId?, previous?: boolean, lines ≤ 500 }`; result cached 300 s.                                             |
| `GET :id/app-target` / `PUT :id/app-target`         | 200       | 10/min member  | Target + settings + APW-03 eligibility (read, never stored — R-3); PUT re-checks quota and eligibility.                                   |
| `POST :id/app-target/check`                         | 202       | 6/min member   | Kubeconfig is saved through the existing plugin-settings API first.                                                                       |
| `GET :id/app-deletion-preview` (added, R-15)        | 200       | —              | `{ deferred, keeps: { volumes[], dependencies[] }, destroysWithData: [...] }` — names and sizes only; feeds APW-01's delete dialog.       |

`GET` routes need `ensureCanView`; all others `ensureCanEdit`; another workspace's id → 404 via the same service.
Existing routes delegate for kind `app`: `DeployService.deploy()` (before the website work, next to the `repo`
refusal) → `AppDeployRequestService.request()`; `DeployController.rollback` → app rollback; `DeployController.deploy`
returns 202-shaped `{ status: 'pending', deploymentId }` and skips `deploymentVerifier.startVerification` for kind
`app`.

### 9.2 Dispatchers and tasks

| Symbol / task id                               | File                                                                                                       | Notes                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DEPLOY_DISPATCHER` / `app-deploy` **C**   | `packages/agent/src/tasks/app-deploy-dispatcher.ts`, `packages/tasks/src/tasks/trigger/app-deploy.task.ts` | Propagates dispatch errors (the row would strand).                                                                                                                                                                                                                        |
| `APP_SMOKE_DISPATCHER` / `app-smoke` **C**     | `…/app-smoke-dispatcher.ts`, `…/app-smoke.task.ts`                                                         | `maxDuration: 900`.                                                                                                                                                                                                                                                       |
| `APP_CLUSTER_OP_DISPATCHER` / `app-cluster-op` | `…/app-cluster-op-dispatcher.ts`, `…/app-cluster-op.task.ts`                                               | ops: `status-refresh`, `logs`, `pause`, `resume`, `remove`, `cancel-deploy`, `job-run`, `cluster-check`, `ingress-reconcile`, `dns-reconcile`, `delete-app-work` (R-15), `verification-deploy`, `verification-status`, `verification-destroy` (R-10); `maxDuration: 900`. |
| `app-health-poll` (scheduled)                  | `…/app-health-poll.task.ts`                                                                                | `cron: '* * * * *'`; self-guarded by `DistributedTaskLockService`.                                                                                                                                                                                                        |
| `app-preview-gc` (scheduled, P3)               | `…/app-preview-gc.task.ts`                                                                                 | `cron: '*/5 * * * *'`.                                                                                                                                                                                                                                                    |

All run on queue `app-cluster-io`. Symbols added to `TASKS_BARREL_RUNTIME_SYMBOLS` alphabetically.

### 9.3 Health poll — `app-health.service.ts` _(new)_

Select `target ≠ 'none' AND paused = false AND removedAt IS NULL AND currentDeploymentId IS NOT NULL` ordered by
`lastPolledAt NULLS FIRST`, `LIMIT 500`; group by `clusterFingerprint`, 5 concurrent per cluster, 20 s per poll.
Each poll: `getAppStatus` + first `GET` smoke check over the public URL (runner not used; platform HTTP with the
public-smoke classifier). Verdict: `down` if primary web ready = 0; `degraded` if any web component ready <
desired or `check_failed`; `unreachable` on credential/connection errors; else `healthy`. Streak rules and
notifications per spec FR-47, dedupe key `app-health:<workId>`, ≤ 1 per 6 h. **The public ingress address is
re-validated on EVERY poll, not every tenth** — spec §4.6 requires it ("re-checked on every health poll (updated
if it changes, withdrawn if it stops being public)"), and it is the guarantee that stops a DNS record pointing at
an address that has since become private; an earlier draft deferred it to every 10th poll, which left up to ten
minutes of exposure. Every **10th** poll additionally re-resolves the **dependency egress hosts** (a larger, more
expensive list that carries no such public guarantee) — drift there dispatches `ingress-reconcile` /
`dns-reconcile`.

### 9.4 Events, Activity, notifications

`packages/agent/src/events/app-runtime.events.ts` _(new)_ — `AppDeployEvent` family with `EVENT_NAME`s equal to
the Activity actions (**C** §6): `app.deploy.started|succeeded|failed|rolled_back|paused|resumed|removed`,
`app.job.succeeded|failed`, `app.smoke.passed|failed`, `app.health.degraded|recovered|unreachable`. Payload:
`{ workId, userId, deploymentId?, buildId?, target, phase?, code?, names? }` — never values or log text.
**Emission order per Deployment** (asserted by ACCEPTANCE E2E-05): `app.deploy.started` → `app.job.*` in execution
order → the terminal `app.deploy.succeeded` \| `failed` \| `rolled_back` → `app.smoke.passed` \| `failed`
summarising the smoke results recorded on that Deployment (emitted after the terminal event even though smoke
ran before it, so one Deployment reads as one block).
`activity-log.listener.ts` maps them (Resolution R-2) with `action` = the dotted event name and `actionType` = the
family: `app.deploy.*` → `ActivityActionType.APP_DEPLOY = 'app_deploy'`, `app.job.*` → `APP_JOB = 'app_job'`,
`app.smoke.*` → `APP_SMOKE = 'app_smoke'`, `app.health.*` → `APP_HEALTH = 'app_health'` (four additive enum values in
`packages/agent/src/entities/activity-log.types.ts`; the existing `DEPLOYMENT` value is not used for App Works).
Deleting an App Work records `app.deploy.removed` with `details.reason: 'app_work_deleted'`, `kept[]` and, when the
cluster was unreachable, `mayRemain[]` (object kinds and names only). Notification catalogue rows (snake case,
in-app default; urgent rows add email): `app_deploy_failed` (not urgent), `app_unhealthy` (urgent,
`quietHoursBypassNeedsOptIn: true`), `app_recovered` (routine), `app_cluster_unreachable` (urgent,
`quietHoursBypassNeedsOptIn: true`). Producers in `NotificationService`: `notifyAppDeployFailed`,
`notifyAppUnhealthy`, `notifyAppRecovered`, `notifyAppClusterUnreachable`.

### 9.5 Quota — `ever-works-apps-quota.service.ts` _(new)_

Counter DI token `EVER_WORKS_APPS_QUOTA_COUNTER`; counts runtime states with `target = 'ever-works-apps' AND
removedAt IS NULL` for Works owned by the user. `assertWithinQuota` at `PUT app-target` and inside the
`deployLockId` claim transaction (`SELECT … FOR UPDATE` on the owner's runtime-state rows on Postgres; SQLite
tests use the serialized connection). Fails closed when `AppsTierPolicy.isOpen()` and the counter is
missing.

### 9.6 Ports — `packages/agent/src/app-runtime/ports.ts` _(new)_ **C**

```ts
export interface AppsTierPolicy {
	// semantics owned and implemented by APW-10; default: closed. The only way App Works code learns whether the tier
	// is open (R-5): nobody reads EVER_WORKS_APPS_MANAGED_ENABLED directly. The older name isManagedEnabled survives only
	// as an alias of isOpen on APW-10's implementation; no consumer calls it.
	isOpen(): boolean;
	managedScope(): 'verified-blueprints' | 'any';
	/** Control-namespace-only credential, handed only to the `apps-tier` deployment plugin — never to `k8s`. */
	resolveClusterCredential(workId: string): Promise<string>;
	/** runtimeClassName null ⇒ precondition `managed_sandbox_unavailable` from Wave 2 (R-24). */
	podPolicy(): { runtimeClassName: string | null; quota: AppQuotaInput; limitRange: AppLimitRangeInput };
	ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' };
	/** Added (requested by APW-10 plan §5.5): owner eligibility for the tier; reasons are APW-10's codes. */
	eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }>;
}
export interface AppImagePullCredentialSource {
	// implemented by APW-05
	resolve(workId: string, buildId: string): Promise<{ server: string; username: string; password: string } | null>;
}
export interface AppRuntimeEnvSource {
	// implemented by APW-07
	resolve(
		workId: string,
		specCommitSha: string,
		ctx: {
			primaryUrl: string | null;
			primaryHost: string | null;
			buildCommitSha: string;
			internalUrls: Record<string, string>; // CONTRACTS §1 references
			preview?: { prNumber: number };
		}
	): Promise<{
		values: Record<string, string>;
		secretNames: string[];
		unsetRequired: string[];
		notReadyDependencies: string[];
		egress: Array<{ host: string; ports: number[] }>;
	}>;
	/** Ephemeral mode (R-10, CONTRACTS §3): nothing read from or written to stored generated values; prompted values
	 * only when already set. `target: 'cluster'` → in-memory `values` for a verification namespace (§4.12);
	 * `target: 'runner'` → a value-free `recipe` for APW-05's runner verification. */
	resolveEphemeral(
		workId: string,
		specCommitSha: string,
		ctx: {
			target: 'cluster' | 'runner';
			primaryUrl: string | null;
			primaryHost: string | null;
			buildCommitSha: string;
			internalUrls: Record<string, string>;
		}
	): Promise<{
		values?: Record<string, string>;
		recipe?: Array<{
			name: string;
			secret: boolean;
			source: 'generate' | 'literal' | 'template' | 'prompted';
			spec: unknown;
		}>;
		secretNames: string[];
		unsetRequired: string[];
	}>;
}
export const APPS_TIER_POLICY = Symbol('APPS_TIER_POLICY');
export const APP_IMAGE_PULL_CREDENTIAL_SOURCE = Symbol('APP_IMAGE_PULL_CREDENTIAL_SOURCE');
export const APP_RUNTIME_ENV_SOURCE = Symbol('APP_RUNTIME_ENV_SOURCE');
```

### 9.7 Deleting an App Work — `app-runtime-deletion.service.ts` _(new)_ (Resolution R-15)

The API never dials a cluster (§6.2) and the Work-scoped kubeconfig is deleted with the Work, so removal must run
**before** the Work row goes. `AppRuntimeDeletionService` (exported from `@ever-works/agent/app-runtime`) binds APW-01's
`APP_WORK_DELETION_PORT` (`packages/agent/src/app-works/app-work-deletion.port.ts`); APW-01's
`WorkLifecycleService.deleteWork` calls it for kind `app`, and this service calls back APW-01's
`WorkLifecycleService.completeAppWorkDeletion(workId)` when a pending removal ends. APW-07 and APW-10 are reached only
through this service.

**`preview(workId)`** returns `{ deferred, keeps, destroysWithData }`, where `keeps` lists volumes (`name`, `sizeGiB`)
and dependencies (`kind`, `label`) from the runtime state, the last `statusSnapshot` and APW-07's
`AppDependenciesService.list`. Names and sizes only. Served by `GET /api/works/:id/app-deletion-preview`.

**`requestDeletion({ workId, userId, deleteStoredData })`** → `{ status: 'pending' | 'done', target, reason? }` (the port
signature). The typed slug is confirmed in the delete dialog (`AppDeleteStoredDataSection`, T59) before APW-01 sends
`delete_stored_data: true`; the port carries only the boolean, and the fork or private copy decision never reaches this
epic.

| Case                                                                                | Result                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target `none`, no runtime-state row, or no `currentDeploymentId` and no `namespace` | APW-07's `onAppWorkDeleting(workId, { deleteStoredData })` runs in-process (rows marked kept); `{ status: 'done', target }`; APW-01 deletes the Work now.                                                                                                                                                                                                  |
| `deletionRequestedAt` already set                                                   | `{ status: 'pending', target }`; nothing new is claimed or dispatched (idempotent).                                                                                                                                                                                                                                                                        |
| otherwise                                                                           | Atomic claim of `deletionRequestedAt`, `deletionDeleteData` and `deletionRequestedByUserId` (only when unset and no `deployLockId`; a running Deployment is cancelled first through `cancel-deploy`), one `app-cluster-op` dispatch with op `delete-app-work`, `{ status: 'pending', target }`; APW-01 answers `200 { deleting: true }` and keeps the row. |

**The `delete-app-work` op** on the isolated worker runs, in order:

1. APW-07 `AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` — kept rows and
   `app.dependency.released`, or deprovision and `app.dependency.data_deleted`; kept in-cluster dependency workloads
   are scaled to 0.
2. `destroyApp` with `deleteVolumes` equal to `deleteStoredData` (§3) — workloads, Jobs, CronJobs, Services, Ingress,
   env Secrets, platform ConfigMaps and the app's NetworkPolicies, keeping `ew-default-deny` while kept data remains. On
   `ever-works-apps` the `apps-tier` plugin's `destroyApp` calls APW-10's `removeWork(workId, { deleteData })` (R-5).
3. The managed DNS record is removed with `AppsDomainDnsService.removeRecord`.
4. Activity `app.deploy.removed` with `reason: 'app_work_deleted'` and `kept[]`; then APW-01's
   `WorkLifecycleService.completeAppWorkDeletion(workId)` deletes the Work (APW-01 already carried out the fork or
   private copy decision when the deletion was requested).

Transient failures (cluster unreachable) re-dispatch after 5 minutes, up to 3 attempts; after the third,
`app.deploy.removed` carries `mayRemain[]` and step 4 runs anyway.

While `deletionRequestedAt` is set, every action route answers `409 APP_WORK_DELETING`, preconditions report
`app_work_deleting`, and `GET app-status` returns `state: 'deleting'`.

---

## 10. Web

### 10.1 Where it hangs

- `apps/web/src/app/[locale]/(dashboard)/works/[id]/deploy/page.tsx` — for `work.kind === 'app'`, return
  `<AppDeployPage>` **before** the website-repo redirect and before provider logic. Other kinds unchanged.
- `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` — render `<AppHealthCard>` for kind `app` above
  `WorkStats`.
- APW-01's `apps/web/src/components/works/detail/settings/DeleteComponent.tsx` mounts this epic's
  `AppDeleteStoredDataSection` for kind `app` (R-15); APW-01 owns the dialog, this epic owns the section.

### 10.2 Components — `apps/web/src/components/works/detail/deploy/app/` _(new)_

`AppDeployPage` (server), `AppTargetCard` (target labels, **None — don't deploy yet** per R-12), `ConnectClusterDialog`,
`ClusterCheckResult`, `AppLiveCard` (state, URL, Source, pending-changes banner), `AppDeployButton` (Build picker: last
20 green Builds), `AppDeployProgress` (phases, polls `/api/works/[id]/app-status` BFF every 3 s while a Deployment runs,
else 30 s), `AppComponentsTable`, `AppSmokeResults` (in-cluster, public, hairpin rows), `AppJobsList` (Logs / Run now),
`AppCronList`, `AppHistoryTable` (existing deployments endpoint; Build link, Rollback, Logs), `AppLogsDrawer`,
`AppDangerZone` (pause, resume, remove with typed confirmation), `AppSourceOffer`, `AppLicenseAttestationDialog` (calls
APW-03's attest route; non-owner copy), `AppDeleteStoredDataSection` (kept list from `GET app-deletion-preview`, typed
slug). Existing `SubdomainManagement` and `DomainManagement` are reused; they call the same actions, and the API branch
does the rest (the managed subdomain on Your cluster shows the apps-domain suffix in P1).
`apps/web/src/components/works/detail/overview/AppHealthCard.tsx` _(new)_.

Server actions: `apps/web/src/app/actions/dashboard/app-runtime.ts` _(new)_. Client: `apps/web/src/lib/api/app-runtime.ts`
_(new, `server-only`)_. BFF: `apps/web/src/app/api/works/[id]/app-status/route.ts` _(new, cookie-authenticated like the
existing status route)_.

### 10.3 i18n

All keys in [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) under
`dashboard.workDetail.deploy.app` and `dashboard.workDetail.overview.appHealth`, mirrored in the 20 other locale
files. Leaf names camelCase, no `.`. Sub-trees: `targets` (`none` = "None — don't deploy yet", `yourCluster`,
`everWorksApps`, `unavailableReason`, `changeWarning`), `connect` (`title`, `kubeconfigHint`, `check`,
`refused.{command,file,proxy,insecure,noCa,notHttps,notPublic}`, `permissions.*`, `ingressClass`,
`tls.{issuer,external,none}`, `namespace`, `isolation.{on,off,offWarning}`, `save`), `states.*` (9 Deployment + 7 app
states incl. `deleting`), `phases.*` (11), `preconditions.*` (one per §5.1 code), `failures.*` (`crashLoop`, `oomKilled`,
`imagePull`, `imageRunsAsRoot`, `imageUserUnverifiable`, `rolloutTimeout`, `jobFailed`, `smokeFailed`, `publishFailed`,
`rollbackFailed`), `smoke.{inCluster,public,hairpin,hairpinWarning}`, `jobs.*`, `cron.*`, `history.*`,
`rollback.{confirm,disclaimer}`, `logs.*`, `lifecycle.{pause,resume,remove,deleteData,typeToConfirm,refusedDuringDeploy}`,
`deletion.{kept,alsoDeleteStoredData,typeToConfirm,generatedValuesWarning,deleting,mayRemain}`,
`source.{link,disclaimer,privateWarning}`, `license.{attest,attested,ownerOnly}`, `domains.{managedSubdomain,httpWarning}`,
`health.*`.

---

## 11. Failure modes

| Failure                                        | Chosen behaviour                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Worker dies mid-Deployment                     | `onFailure` → `ERROR (worker_failed)`, lock released; runtime-state lock stale after 7 260 s.         |
| Cluster API unreachable during rollout         | Retries polls for 60 s, then `failed` with `cluster_unreachable`; no rollback attempt (cannot reach). |
| Pre-deploy job hangs                           | `activeDeadlineSeconds` kills it → failed; running app untouched.                                     |
| SSA conflict with a hand-edited field          | `force: true` as today; the Activity entry notes fields overwritten are not tracked.                  |
| Namespace owned by another Work                | Precondition failure `namespace_foreign`; never adopted.                                              |
| Env source returns a value for an unknown name | Ignored with a warning; only spec-declared names are rendered.                                        |
| Build image deleted by retention               | `build_image_missing`; rollback button hidden for that row.                                           |
| DNS provider down                              | Deployment continues; `dns-reconcile` retried by the health poll; warning `dns_record_pending`.       |
| Tier reports isolation not enforced            | The tier refuses the desired state (APW-10); the Deployment ends `failed (isolation_not_enforced)`.   |
| Cluster unreachable while deleting an App Work | 3 attempts over 15 min, then the Work is deleted and `app.deploy.removed` lists `mayRemain[]`.        |
| Verification namespace outlives its attempt    | Expiry annotation; APW-04's sweep calls `verification-destroy`; destroy is idempotent.                |

---

## 12. Test plan

### 12.1 k8s plugin (Vitest)

- `src/app/__tests__/app-names.spec.ts` — namespace rule (slug truncation, 63 limit, preview and verification suffixes),
  labels exclude `ever-works.io/managed` / `app.kubernetes.io/name`.
- `app-manifest.renderer.spec.ts` — golden fixtures for the three sample App specs in APW-03 `schema.md` §24
  (web+worker+volume+jobs+cron; single web; two components); strategy by volume; envFrom not optional; digest image;
  TLS block only for `cert-manager`; verification variant (no Ingress, no CronJob, `emptyDir` volumes).
- `app-security.spec.ts` — the §4.4 table cell by cell; restricted namespace labels; port < 1024 rules.
- `app-network-policy.spec.ts` — every CIDR in §4.10; opt-out renders none; hairpin + deps egress.
- `app-jobs.renderer.spec.ts` — backoff/deadline/TTL; runner ConfigMap contains data not commands (fuzz paths with
  `$(`, backticks, quotes); cron auth via `secretKeyRef`; managed 5-minute rule; hairpin runner job targets the public URL.
- `app-rollout.spec.ts` — generation in metadata, updated/available replicas, old ReplicaSet with ready pods,
  crash loop at 3, stuck 180 s, OOM, worker stability 30 s.
- `app-deployer.spec.ts` — phase order; first-deploy jobs before publish; rollback restores captured templates;
  cancel before/after change; first Deployment failure keeps/scales; public failure no rollback; hairpin only when
  declared; verification purpose skips publish.
- `app-lifecycle.spec.ts` — `destroyApp` keeps PVCs, dependency objects and `ew-default-deny` without `deleteVolumes`;
  verification namespaces deleted whole.
- `app-kubeconfig.guard.spec.ts` — every refusal; every deny CIDR incl. mapped IPv6; allow-list; IP pinning with
  `tls-server-name`.
- `src/__tests__/e2e/app-runtime.e2e.spec.ts` _(new, kind)_ — non-root nginx image as web + busybox worker + migrate
  job + first-deploy http job + cron + PVC + smoke; rollback by deploying a crashing command; isolation reported
  **not enforced** on kindnet; delete-App-Work removal keeps the PVC; a verification namespace is created and destroyed;
  existing `cluster.e2e.spec.ts` unchanged.

### 12.2 Agent (Jest)

`app-deploy-preconditions.service.spec.ts` (every code), `app-license-gate.spec.ts` (eligibility mapping, no stored
attestation), `app-render-input.builder.spec.ts` (same-commit rule, never `GH_TOKEN`/platform tokens, pull credential only
from the port), `app-deploy.orchestrator.spec.ts` (state mapping, lock release, queue latest-wins, never `k8s-works*`
credentials, tier credential only to the `apps-tier` plugin), `app-health.service.spec.ts` (streaks, dedupe 6 h,
unreachable 10), `app-hosts.service.spec.ts` (verified-only, primary order, URL scheme per TLS mode, onChange),
`apps-domain-dns.service.spec.ts` (domain relation validation), `ever-works-apps-quota.service.spec.ts`,
`app-runtime-deletion.service.spec.ts` (immediate vs deferred, typed slug, retries, completion hand-back),
`app-runtime.facade.spec.ts` (plugin selection per target by capability), `app-runtime.events.spec.ts` (payload has no
value fields), notification `event-registry-coverage.spec.ts` stays green.

### 12.3 API (Jest)

`app-runtime.controller.spec.ts` (every route: 202/409/422/404, throttles, typed slug, `app-deletion-preview`,
`409 APP_WORK_DELETING`), `deploy.service.spec.ts` + `deploy.controller.spec.ts` additions (kind app delegates; non-app
assertions untouched), migration specs under `apps/api/src/migrations/__tests__/`. No `apps/api/test/` suite (R-22).

### 12.4 Web

Vitest unit specs next to each new component; Playwright `apps/web/e2e/flow-app-deploy-target.spec.ts`,
`flow-app-deploy-lifecycle.spec.ts`, `flow-app-deploy-domains.spec.ts`, `flow-app-deploy-a11y.spec.ts` (axe on the Deploy
tab and its dialogs) (API mocked at the BFF boundary); locale parity via `apps/web/scripts/sync-locale-parity.mjs`
adding zero keys; existing `flow-work-deploy-*.spec.ts` pass unchanged.

### 12.5 Acceptance wiring

ACC-06-06, -10, -11, -12, -15, -18, -25, -35, -36, -45, -47, -48 are wired into [`../ACCEPTANCE.md`](../ACCEPTANCE.md) via
APW-13's fixture app on a kind cluster.

---

## 13. Phasing

### P1 — Wave 1: Your cluster (spec FR-1…FR-6, FR-9…FR-21, FR-23…FR-51 for Your cluster, FR-54…FR-62)

Contracts, renderer, guard, connection check, both migrations, preconditions with APW-03 eligibility, `app-deploy`,
`app-smoke`, `app-cluster-op` (incl. verification and delete ops), health poll, custom domains (verified-only), the
managed subdomain on Your cluster when the apps domain is configured (R-16), TLS modes, hairpin check, source offer,
pause/resume/remove, deleting an App Work (R-15), verification targets (R-10), web + i18n, kind e2e. **Ships value
alone:** the owner's example runs on their cluster, with a public URL when the operator configured the apps domain.

### P2 — Wave 2: Ever Works Apps for verified Blueprints (FR-7, FR-8, FR-22, FR-40 on the managed target)

`AppsTierPolicy` binding (APW-10 implementation) and selection of the `apps-tier` deployment plugin for target Ever
Works Apps (R-5), eligibility and sandboxed-runtime preconditions (R-24 — the tier must report a runtime class), quota,
managed-tier refusals (root image pre-check, cron frequency, privileged port) in the render input, edge-owned
managed hostnames. **Depends on** APW-10 P2 gate.

### P3 — Wave 3: any App Work on the managed tier + previews (FR-7 scope `any`, FR-52, FR-53)

`managedScope() === 'any'`, preview Deployments (`environment = preview`, `prNumber`, namespace
suffix, `app-preview-gc`), flag `works-app-previews` **C**.

---

## 14. Constitution compliance checklist

- [x] **I — Plugin-first.** All Kubernetes rendering and I/O for Your cluster is in `packages/plugins/k8s/src/app/`;
      Ever Works Apps is reached only through APW-10's `apps-tier` deployment plugin; DNS for the apps domain follows the
      existing concrete-provider precedent and is flagged for EW-738.
- [x] **II — No hard-coded plugin ids.** `AppRuntimeFacadeService` selects by `supportsApps` and the `apps-tier`
      capability; no `'k8s'` literal added outside the plugin (existing literals untouched).
- [x] **III — Source of truth.** The App spec and image both come from the Work Repository commit; the database holds
      runtime state and history only; the license attestation stays APW-03's single record.
- [x] **IV — Job runtime.** Every cluster action — including App Work deletion and verification targets — is a
      dispatched job; every action endpoint returns 202; overlap guarded by an atomic `UPDATE … WHERE "deployLockId" IS
NULL`, the deletion claim and `DistributedTaskLockService` for the poller.
- [x] **V — Forward-only migrations.** Two additive migrations in slots 00 and 01.
- [x] **VI — Tests.** §12; kind e2e for real-cluster behaviour.
- [x] **VII — Secrets.** Kubeconfig stays `x-secret`; env values only in cluster Secrets (verification values in memory
      only); logs redacted, cached 300 s, never persisted; Activity carries names only; the owner's Git token never
      reaches a cluster; the tier credential never reaches the `k8s` plugin.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first spec.** No file or class names in `spec.md`.
- [x] **X — Compatibility.** New `IDeploymentPlugin` members are optional; existing routes keep their contracts for
      every non-app kind; new `WorkDeployment` columns are nullable; new states only appear on app rows.
- [x] **Program rules** 1 (additive), 2 (one internal `*State` entity), 5 (202 + jobs), 8 (secrets), 9 (repository
      content is data: runner never interpolates), 10 (no infrastructure specifics; isolation design is private; existing
      deploy code is described generically — R-14), 11 (i18n), 12 (managed receipts linked from Activity).
- [x] **Program audit resolutions.** R-1, R-2, R-3, R-5, R-10, R-12, R-15, R-16, R-22, R-24 applied as listed at the top.

### Known gaps carried forward

- The concrete apps-domain DNS provider mirrors `EverWorksDnsService` instead of resolving a `dns` capability.
- CONTRACTS §4 calls `POST /api/works/:id/deploy` "existing"; the existing route is `POST /api/deploy/works/:id`.
  This plan adds the contract route for kind `app` and makes the existing route delegate.
- Volume + replicas: resolved by CONTRACTS C2 (an APW-03 error and an APW-06 deploy-time refusal).
- Private-address clusters need the operator allow-list (spec §9).
- Kept data after an App Work is deleted has no card left to manage it (spec §9).
- **CONTRACTS changes requested by this fix pass**: §3 ports row gains `AppsTierPolicy.eligibility(userId)` and
  `AppRuntimeEnvSource.resolveEphemeral`; §4 gains `GET /api/works/:id/app-deletion-preview`; §2's
  `WorkAppRuntimeState` row drops "license hosting attestation" and gains the deletion columns; APW-01's
  `APP_WORK_DELETION_PORT.requestDeletion` is bound by `AppRuntimeDeletionService`, and APW-01 exposes
  `completeAppWorkDeletion(workId)` (R-15) — applied in CONTRACTS §3.
